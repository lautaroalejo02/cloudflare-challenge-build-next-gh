import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { startMockServer, type MockServer } from "../../demo/src/mock-server.ts";
import { ApiClient } from "../../demo/src/lib/http.ts";
import { authUrl, commitAll, git, push } from "../../demo/src/lib/git.ts";
import { ORDER_V1_REFACTORED, ORDER_V2 } from "../../demo/src/agents/api.ts";

// Drives the real MCP server (spawned over stdio) against the demo's local mock
// control plane: register -> push -> consumer register -> breaking push ->
// squashed status with instructions -> sync -> push -> ready -> retired.

const MCP_DIR = path.resolve(import.meta.dirname, "..");
const DEMO_DIR = path.resolve(MCP_DIR, "..", "demo");
const FIXTURE_DIR = path.join(DEMO_DIR, "fixture");
const TMP = path.join(MCP_DIR, "tmp");

function copyDir(src: string, dst: string): void {
  fs.mkdirSync(dst, { recursive: true });
  for (const e of fs.readdirSync(src, { withFileTypes: true })) {
    const s = path.join(src, e.name);
    const d = path.join(dst, e.name);
    if (e.isDirectory()) copyDir(s, d);
    else fs.copyFileSync(s, d);
  }
}

async function until(cond: () => Promise<boolean>, timeoutMs: number, what: string): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (await cond()) return;
    if (Date.now() > deadline) throw new Error(`timed out waiting for: ${what}`);
    await new Promise((r) => setTimeout(r, 120));
  }
}

async function seedTrunk(api: ApiClient, dir: string): Promise<void> {
  const trunk = await api.trunkInit();
  fs.mkdirSync(dir, { recursive: true });
  await git(["init", "-b", "main"], dir);
  await git(["-C", dir, "remote", "add", "origin", authUrl(trunk.remote, trunk.token)]);
  copyDir(FIXTURE_DIR, dir);
  await commitAll(dir, "chore: seed fixture", "arb-mcp-test");
  await push(dir);
}

interface ToolResult {
  isError?: boolean;
  content?: Array<{ type: string; text?: string }>;
}

function textOf(r: ToolResult): string {
  return (r.content ?? []).map((c) => c.text ?? "").join("\n");
}

function jsonOf(r: ToolResult): any {
  assert.ok(!r.isError, `tool call failed: ${textOf(r)}`);
  return JSON.parse(textOf(r));
}

test("mcp lifecycle: register, push, squash, sync, ready, retire", { timeout: 120_000 }, async () => {
  const rootDir = path.join(TMP, "it-mock");
  const workdir = path.join(TMP, "it-workspaces");
  const seedDir = path.join(TMP, "it-seed");
  fs.rmSync(rootDir, { recursive: true, force: true });
  fs.rmSync(workdir, { recursive: true, force: true });
  fs.rmSync(seedDir, { recursive: true, force: true });

  const mock: MockServer = await startMockServer({ rootDir, pollMs: 60 });
  const api = new ApiClient(mock.url);
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [
      "--experimental-strip-types",
      "--disable-warning=ExperimentalWarning",
      path.join(MCP_DIR, "src", "index.ts"),
    ],
    cwd: MCP_DIR,
    env: {
      ...process.env,
      ARB_BASE_URL: mock.url,
      ARB_WORKDIR: workdir,
      ARB_POLL_MS: "80",
      ARB_ADMIN_KEY: "",
    } as Record<string, string>,
    stderr: "pipe",
  });
  let stderr = "";
  transport.stderr?.on("data", (c) => (stderr += c.toString()));
  const client = new Client({ name: "mcp-it", version: "0.0.0" });
  const call = (name: string, args: Record<string, unknown> = {}) =>
    client.callTool({ name, arguments: args }) as Promise<ToolResult>;

  try {
    await seedTrunk(api, seedDir);
    await client.connect(transport);

    const tools = await client.listTools();
    assert.deepEqual(
      tools.tools.map((t) => t.name).sort(),
      ["arb_push", "arb_ready", "arb_register", "arb_state", "arb_status", "arb_sync"],
    );

    // 1. producer register
    const p = jsonOf(await call("arb_register", { agent: "api-agent", lane: "api" }));
    assert.equal(p.status, "speculating");
    assert.equal(p.inferred, true); // consumes omitted (moot without a producerId)
    const prodWs = p.workspace;
    assert.ok(fs.existsSync(path.join(prodWs, ".git")), "producer workspace not a git repo");
    // The cloned workspace must not carry credentials on its origin remote.
    const originUrl = await git(["-C", prodWs, "remote", "get-url", "origin"]);
    assert.ok(!originUrl.includes("@") && !originUrl.includes("x:"), `credentials left on remote: ${originUrl}`);

    // 2. producer push (body-only-ish refactor, keeps the v1 interface)
    fs.writeFileSync(path.join(prodWs, "src/api/order.ts"), ORDER_V1_REFACTORED);
    const push1 = jsonOf(await call("arb_push", { entryId: p.entryId, message: "refactor(api): extract sumCart" }));
    assert.ok(push1.commit);
    await until(
      async () => (await api.getEntry(p.entryId)).entry.headCommit === push1.commit,
      15_000,
      "producer first push detected",
    );

    // 3. consumer register (explicit consumes — the mock has no inference)
    const c = jsonOf(
      await call("arb_register", {
        agent: "ui-agent",
        lane: "ui",
        producerId: p.entryId,
        consumes: ["createOrder", "Order"],
      }),
    );
    assert.equal(c.producerId, p.entryId);
    assert.equal(c.inferred, false);
    assert.equal(typeof c.consumes.createOrder, "string");
    const consWs = c.workspace;
    assert.match(
      fs.readFileSync(path.join(consWs, "src/api/order.ts"), "utf8"),
      /createOrder\(cart: Cart, region: string\)/,
      "consumer fork did not carry the producer v1 interface",
    );
    // Consumer does its gen-0 work and pushes it.
    fs.appendFileSync(path.join(consWs, "src/ui/checkout.ts"), "\n// ui work, generation 0\n");
    const cp0 = jsonOf(await call("arb_push", { entryId: c.entryId, message: "feat(ui): checkout work" }));
    await until(
      async () => (await api.getEntry(c.entryId)).entry.headCommit === cp0.commit,
      15_000,
      "consumer gen-0 push detected",
    );

    // 4. producer breaking push -> consumer squashed
    fs.writeFileSync(path.join(prodWs, "src/api/order.ts"), ORDER_V2);
    const push2 = jsonOf(
      await call("arb_push", { entryId: p.entryId, message: "feat(api)!: createOrder options object" }),
    );
    await until(
      async () => (await api.getEntry(p.entryId)).entry.headCommit === push2.commit,
      15_000,
      "producer breaking push detected",
    );

    // 5. consumer arb_status shows squashed with instructions
    await until(
      async () => (await call("arb_status", { entryId: c.entryId })).content?.[0]?.text?.includes('"squashed"') === true,
      15_000,
      "consumer squashed",
    );
    const st = jsonOf(await call("arb_status", { entryId: c.entryId }));
    assert.equal(st.status, "squashed");
    assert.equal(st.generation, 1);
    assert.equal(st.diagnosis.reason, "interface-changed");
    assert.match(st.instructions, /arb_sync/);
    assert.match(st.instructions, /createOrder/);
    assert.match(st.instructions, /opts: \{ region: string; currency: string \}/);
    // Tokens never leave the server: no tool output carries one.
    for (const r of [st]) {
      assert.ok(!textOf({ content: [{ type: "text", text: JSON.stringify(r) }] }).includes("mock-token"));
    }

    // push while squashed-but-not-synced must be refused
    const refused = await call("arb_push", { entryId: c.entryId, message: "stale work" });
    assert.equal(refused.isError, true);
    assert.match(textOf(refused), /arb_sync/);

    // 6. arb_sync: re-fork already landed (mock is synchronous); workspace is replaced
    const sync = jsonOf(await call("arb_sync", { entryId: c.entryId }));
    assert.equal(sync.synced, true);
    assert.equal(sync.generation, 1);
    assert.equal(sync.baseCommit, push2.commit);
    assert.match(sync.instructions, /interface-changed/);
    assert.match(
      fs.readFileSync(path.join(consWs, "src/api/order.ts"), "utf8"),
      /opts: \{ region: string; currency: string \}/,
      "synced workspace does not carry producer v2 head",
    );

    // 7. consumer redoes its work against v2 and pushes
    fs.appendFileSync(
      path.join(consWs, "src/ui/checkout.ts"),
      "\n// ui work redone for createOrder v2\n",
    );
    const cp1 = jsonOf(await call("arb_push", { entryId: c.entryId, message: "feat(ui): adapt to createOrder v2" }));
    await until(
      async () => (await api.getEntry(c.entryId)).entry.headCommit === cp1.commit,
      15_000,
      "consumer gen-1 push detected",
    );

    // 8. ready both
    const rp = jsonOf(await call("arb_ready", { entryId: p.entryId }));
    assert.equal(rp.commit, push2.commit);
    const rc = jsonOf(await call("arb_ready", { entryId: c.entryId }));
    assert.equal(rc.commit, cp1.commit);

    // 9. both retired, in order
    await until(
      async () => {
        const s = await api.state();
        const byId = new Map(s.entries.map((e) => [e.id, e.status]));
        return byId.get(p.entryId) === "retired" && byId.get(c.entryId) === "retired";
      },
      30_000,
      "both entries retired",
    );
    const final = jsonOf(await call("arb_state"));
    assert.equal(final.stats.squashes, 1);
    assert.ok(final.trunk.retiredCount >= 2);
    const statuses = final.entries.map((e: any) => `${e.entryId}:${e.status}`).sort();
    assert.deepEqual(statuses, [`${p.entryId}:retired`, `${c.entryId}:retired`].sort());
  } catch (err) {
    throw new Error(`${(err as Error).message}\n--- server stderr ---\n${stderr}`);
  } finally {
    await client.close().catch(() => {});
    await transport.close().catch(() => {});
    await mock.close();
  }
});
