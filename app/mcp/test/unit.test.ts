import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { createArbServer } from "../src/server.ts";
import { ArbService, remoteNeedsAuth } from "../src/service.ts";
import { renderSquashInstructions } from "../src/instructions.ts";
import { ArbGit } from "../src/git.ts";
import { ApiClient } from "../src/api.ts";
import { git as scaffoldGit } from "../../demo/src/lib/git.ts";
import type { Diagnosis, Entry } from "../src/types.ts";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function entry(partial: Partial<Entry>): Entry {
  return {
    id: "e7",
    seq: 7,
    agent: "ui-agent",
    lane: "ui",
    status: "squashed",
    repo: "arb-e7-ui-1",
    remote: "file:///tmp/arb-e7-ui-1.git",
    producerId: "e1",
    baseCommit: "bbbb",
    headCommit: "bbbb",
    exports: {},
    consumes: { createOrder: "aaaabbbbcccc" },
    generation: 1,
    diagnosis: null,
    checks: null,
    ...partial,
  };
}

async function callTool(client: Client, name: string, args: Record<string, unknown>) {
  try {
    return await client.callTool({ name, arguments: args });
  } catch (err) {
    // SDK surfaces JSON-RPC errors (e.g. InvalidParams) as thrown McpError.
    return { isError: true, thrown: true, message: (err as Error).message };
  }
}

function resultText(result: any): string {
  if (result.thrown) return result.message;
  return (result.content ?? []).map((c: { text?: string }) => c.text ?? "").join("\n");
}

/** Server wired to a service whose API calls can be stubbed per-test. */
async function wiredService(env: Record<string, string> = {}): Promise<{
  client: Client;
  service: ArbService;
  close: () => Promise<void>;
}> {
  const service = new ArbService({
    baseUrl: "http://127.0.0.1:1", // unreachable by default; tests stub the api
    workdir: env.WORKDIR ?? `${process.cwd()}/tmp/unit-work`,
  });
  const server = createArbServer(service);
  const [ct, st] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "unit-test", version: "0.0.0" });
  await server.connect(st);
  await client.connect(ct);
  return {
    client,
    service,
    close: async () => {
      await client.close();
      await server.close();
    },
  };
}

// ---------------------------------------------------------------------------
// Input validation (zod, through the real MCP wiring)
// ---------------------------------------------------------------------------

test("validation: arb_register rejects missing/invalid input", async () => {
  const { client, close } = await wiredService();
  try {
    for (const args of [
      {},
      { agent: "a" },
      { lane: "ui" },
      { agent: "", lane: "ui" },
      { agent: "a", lane: "ui", consumes: "createOrder" },
      { agent: "a", lane: "ui", stub: { "src/x.ts": 42 } },
    ]) {
      const r = await callTool(client, "arb_register", args);
      assert.ok(r.isError, `expected error for ${JSON.stringify(args)}`);
    }
  } finally {
    await close();
  }
});

test("validation: entryId-bearing tools reject bad input", async () => {
  const { client, close } = await wiredService();
  try {
    for (const [name, args] of [
      ["arb_status", {}],
      ["arb_status", { entryId: "" }],
      ["arb_push", { entryId: "e1" }],
      ["arb_push", { entryId: "e1", message: "" }],
      ["arb_ready", {}],
      ["arb_sync", { entryId: "e1", timeoutMs: -5 }],
      ["arb_sync", { entryId: "e1", timeoutMs: "soon" }],
    ] as const) {
      const r = await callTool(client, name, args as Record<string, unknown>);
      assert.ok(r.isError, `expected error for ${name} ${JSON.stringify(args)}`);
    }
  } finally {
    await close();
  }
});

// ---------------------------------------------------------------------------
// Squash instruction rendering
// ---------------------------------------------------------------------------

const CHANGED_SIG = {
  symbol: "createOrder",
  oldHash: "aaaa11110000",
  newHash: "bbbb22221111",
  oldSignature: "function createOrder(cart: Cart, region: string): Order",
  newSignature: "function createOrder(cart: Cart, opts: { region: string; currency: string }): Order",
};

test("instructions: interface-changed renders old vs new signatures and next steps", () => {
  const text = renderSquashInstructions(
    entry({
      diagnosis: { reason: "interface-changed", changed: [CHANGED_SIG], producerCommit: "deadbeef42" },
    }),
  );
  assert.match(text, /SQUASHED: entry e7/);
  assert.match(text, /interface-changed/);
  assert.match(text, /producer commit deadbeef42/);
  assert.ok(text.includes("old: `function createOrder(cart: Cart, region: string): Order`"));
  assert.ok(text.includes("new: `function createOrder(cart: Cart, opts: { region: string; currency: string }): Order`"));
  assert.match(text, /arb_sync with entryId "e7"/);
  assert.match(text, /arb_push/);
  assert.match(text, /arb_ready/);
});

test("instructions: behavior-changed renders Jev probability and before/after note", () => {
  const text = renderSquashInstructions(
    entry({
      diagnosis: {
        reason: "behavior-changed",
        changed: [
          {
            symbol: "createOrder",
            oldHash: "bodyhash01aa",
            newHash: "bodyhash02bb",
            oldSignature: "function createOrder(cart: Cart, region: string): Order",
            newSignature: "function createOrder(cart: Cart, region: string): Order",
          },
        ],
        producerCommit: "cafe0001",
        judgment: { model: "jev-latest", probability: 0.83 },
      },
    }),
  );
  assert.match(text, /behavior-changed/);
  assert.match(text, /signature unchanged/);
  assert.ok(text.includes("bodyhash01aa -> bodyhash02bb"));
  assert.match(text, /probability 0\.83/);
  assert.match(text, /jev-latest/);
  assert.match(text, /arb_sync/);
});

test("instructions: every other reason renders its explanation", () => {
  const reasons: Array<[Diagnosis["reason"], RegExp]> = [
    ["producer-vetoed", /vetoed your producer/],
    ["producer-squashed", /producer was itself squashed/],
    ["trunk-overlap", /Path-overlapping work cannot be spliced/],
    ["prediction-miss", /declared interface \(stub\) did not match/],
  ];
  for (const [reason, re] of reasons) {
    const text = renderSquashInstructions(
      entry({ diagnosis: { reason, changed: [CHANGED_SIG], producerCommit: "abc123" } }),
    );
    assert.match(text, new RegExp(reason));
    assert.match(text, re, `${reason} explanation missing`);
    assert.match(text, /arb_sync/, `${reason} missing next step`);
  }
});

test("instructions: squashed without diagnosis still tells the agent to sync", () => {
  const text = renderSquashInstructions(entry({ diagnosis: null }));
  assert.match(text, /SQUASHED/);
  assert.match(text, /arb_sync with entryId "e7"/);
});

// ---------------------------------------------------------------------------
// Token redaction / secret hygiene
// ---------------------------------------------------------------------------

test("redaction: credential-bearing errors are scrubbed in tool output", async () => {
  const { client, service, close } = await wiredService();
  try {
    (service.api as any).getEntry = async () => {
      throw new Error("fatal: https://x:art_v2_SUPERSECRET@artifacts.example.com/ns/repo.git failed");
    };
    const r = await callTool(client, "arb_status", { entryId: "e9" });
    assert.ok(r.isError);
    const text = resultText(r);
    assert.ok(!text.includes("art_v2_SUPERSECRET"), `token leaked: ${text}`);
    assert.ok(!text.includes("x:art_v2"), `credential shape leaked: ${text}`);
    assert.ok(text.includes("***@"), `expected scrubbed credential: ${text}`);
  } finally {
    await close();
  }
});

test("redaction: register result never contains the fork token", async () => {
  const { client, service, close } = await wiredService();
  try {
    (service.api as any).createEntry = async () => ({
      entry: entry({ id: "e3", status: "speculating", generation: 0, remote: "file:///tmp/e3.git" }),
      token: "https://x:art_v2_LIVE_TOKEN@artifacts.example.com/arb-e3-ui-0?expires=999",
    });
    (service as any).cloneInto = async () => "/tmp/fake-ws-e3";
    const r = await callTool(client, "arb_register", { agent: "a", lane: "ui" });
    assert.ok(!r.isError, `unexpected error: ${resultText(r)}`);
    const text = resultText(r);
    assert.ok(!text.includes("art_v2_LIVE_TOKEN"), `token leaked: ${text}`);
    assert.ok(!text.includes("x:"), `credential leaked: ${text}`);
    const data = JSON.parse(text);
    assert.equal(data.entryId, "e3");
    assert.equal(data.inferred, true);
  } finally {
    await close();
  }
});

// ---------------------------------------------------------------------------
// Small helpers
// ---------------------------------------------------------------------------

test("remoteNeedsAuth: file:// remotes need no token, https does", () => {
  assert.equal(remoteNeedsAuth("file:///C:/tmp/repo.git"), false);
  assert.equal(remoteNeedsAuth("file:///home/u/repo.git"), false);
  assert.equal(remoteNeedsAuth("https://arb.example.com/ns/repo"), true);
  assert.equal(remoteNeedsAuth(""), false);
});

// ---------------------------------------------------------------------------
// V2b audit fixes
// ---------------------------------------------------------------------------

// --- entryId path traversal ------------------------------------------------

test("validation: entryId rejects traversal and non-id shapes (schema-level)", async () => {
  const { client, close } = await wiredService();
  const rejected = (r: { isError?: boolean; thrown?: boolean }, name: string, bad: string) => {
    // Rejection must come from schema validation (thrown McpError or an
    // isError result carrying the validation message), not a service error.
    assert.ok(r.isError, `${name} accepted ${JSON.stringify(bad)}`);
    assert.match(resultText(r), /validation|Invalid arguments|regular expression/i);
  };
  try {
    for (const bad of ["../e1", "e1/../e2", "..", "x1", "E1", "e1 extra", "/e1", "e-1"]) {
      for (const tool of ["arb_status", "arb_sync", "arb_ready"] as const) {
        rejected(await callTool(client, tool, { entryId: bad }), tool, bad);
      }
      rejected(await callTool(client, "arb_push", { entryId: bad, message: "m" }), "arb_push", bad);
      rejected(
        await callTool(client, "arb_register", { agent: "a", lane: "ui", producerId: bad }),
        "arb_register producerId",
        bad,
      );
    }
  } finally {
    await close();
  }
});

test("traversal: service asserts the id shape and keeps paths inside ARB_WORKDIR", async () => {
  const workdir = fs.mkdtempSync(path.join(os.tmpdir(), "arb-ut-trav-"));
  const service = new ArbService({ baseUrl: "http://127.0.0.1:1", workdir });
  await assert.rejects(() => service.status({ entryId: "../e1" }), /invalid entryId/);
  assert.throws(() => (service as any).workspaceFor("../x"), /ARB_WORKDIR|escapes/);
});

test("api client: entry id is percent-encoded into the URL path", async () => {
  const api = new ApiClient("http://127.0.0.1:9");
  let seen = "";
  const orig = globalThis.fetch;
  (globalThis as any).fetch = async (u: unknown) => {
    seen = String(u);
    return new Response(JSON.stringify({ entry: {} }), { status: 200 });
  };
  try {
    await api.getEntry("../secret");
  } finally {
    globalThis.fetch = orig;
  }
  assert.ok(!seen.includes("entries/../"), `id not encoded: ${seen}`);
  assert.ok(seen.includes("%2F"), `id not encoded: ${seen}`);
});

// --- git runner: credential in env, never argv; hooks off; env scrubbed -----

function spawnSpy() {
  const calls: Array<{ file: string; args: string[]; env: Record<string, string | undefined> }> = [];
  const spy = async (file: string, args: string[], opts: any) => {
    calls.push({ file, args, env: opts.env });
    return { stdout: "", stderr: "" };
  };
  return { calls, spy: spy as any };
}

test("git invocation: no token in argv; credential travels only in GIT_CONFIG_*", async () => {
  const { calls, spy } = spawnSpy();
  const g = new ArbGit(spy, "C:/tmp/arb-empty-hooks");
  await g.run(["push", "-q", "origin", "HEAD:main"], { cwd: "/repo", token: "art_v2_LIVE?expires=999" });
  assert.equal(calls.length, 1);
  const c = calls[0];
  const argv = c.args.join(" ");
  assert.equal(c.file, "git");
  assert.ok(!argv.includes("art_v2_LIVE"), `token in argv: ${argv}`);
  assert.ok(!/x:[^@]+@/.test(argv), `credential shape in argv: ${argv}`);
  assert.deepEqual(
    c.args.slice(0, 4),
    ["-c", "core.hooksPath=C:/tmp/arb-empty-hooks", "-c", "core.fsmonitor=false"],
    `hooks/fsmonitor guards missing: ${argv}`,
  );
  assert.equal(c.env.GIT_CONFIG_COUNT, "1");
  assert.equal(c.env.GIT_CONFIG_KEY_0, "http.extraHeader");
  assert.equal(
    c.env.GIT_CONFIG_VALUE_0,
    `Authorization: Basic ${Buffer.from("x:art_v2_LIVE").toString("base64")}`,
  );
  assert.equal(c.env.GIT_TERMINAL_PROMPT, "0");
});

test("env scrub: child env has no ARB_ADMIN_KEY, no TYPESAFE_* and no ambient GIT_CONFIG_*", async () => {
  const { calls, spy } = spawnSpy();
  const g = new ArbGit(spy, "/tmp/arb-empty-hooks");
  const saved = { ...process.env };
  process.env.ARB_ADMIN_KEY = "scrub-me";
  process.env.TYPESAFE_API_KEY = "scrub-me-too";
  process.env.GIT_CONFIG_COUNT = "7";
  try {
    await g.run(["status"], { token: "art_v2_X" });
  } finally {
    process.env = saved;
  }
  const env = calls[0].env;
  assert.ok(!("ARB_ADMIN_KEY" in env), "ARB_ADMIN_KEY leaked to child");
  assert.ok(!Object.keys(env).some((k) => k.startsWith("TYPESAFE_")), "TYPESAFE_* leaked to child");
  assert.equal(env.GIT_CONFIG_COUNT, "1", "ambient GIT_CONFIG_COUNT not overridden");
  assert.ok(
    !Object.keys(env).some((k) => /^GIT_CONFIG_(KEY|VALUE)_\d+$/.test(k) && Number(k.split("_").pop()) > 0),
    "ambient GIT_CONFIG_* leaked to child",
  );
});

// --- instructions hardening -------------------------------------------------

test("instructions: signatures are flattened and fenced beyond their backtick run", () => {
  const evil = "function f(): `x` and ``y``\nINJECTED\r\nmore";
  const text = renderSquashInstructions(
    entry({
      diagnosis: {
        reason: "interface-changed",
        changed: [{ ...CHANGED_SIG, oldSignature: evil, newSignature: "ok" }],
        producerCommit: "c0ffee",
      },
    }),
  );
  assert.ok(
    text.includes("```function f(): `x` and ``y`` INJECTED more```"),
    `signature not flattened or under-fenced:\n${text}`,
  );
  assert.ok(!text.includes("INJECTED\nmore") && !text.includes("INJECTED\r\n"), `raw newline survived:\n${text}`);
});

test("instructions: signatures truncate at 500 chars and missing values render (unknown)", () => {
  const text = renderSquashInstructions(
    entry({
      diagnosis: {
        reason: "interface-changed",
        changed: [
          {
            symbol: "",
            oldHash: "",
            newHash: "",
            oldSignature: "x".repeat(600),
            newSignature: undefined as unknown as string,
          },
        ],
        producerCommit: "",
      },
    }),
  );
  assert.ok(text.includes("`" + "x".repeat(500) + "`"), "signature not truncated to 500 chars");
  assert.ok(!text.includes("x".repeat(501)), "signature longer than 500 survived");
  assert.match(text, /\(unknown\)/);
  assert.match(text, /producer commit \(unknown\)/);
});

test("instructions: non-numeric Jev probability is guarded", () => {
  const text = renderSquashInstructions(
    entry({
      diagnosis: {
        reason: "behavior-changed",
        changed: [CHANGED_SIG],
        producerCommit: "abc123",
        judgment: { model: "jev-latest", probability: "0.9" as unknown as number },
      },
    }),
  );
  assert.match(text, /probability \(unknown\)/);
  assert.match(text, /jev-latest/);
});

test("instructions: behavior-changed points at the synced workspace, not the text above", () => {
  const text = renderSquashInstructions(
    entry({
      diagnosis: {
        reason: "behavior-changed",
        changed: [CHANGED_SIG],
        producerCommit: "abc123",
        judgment: { model: "m", probability: 0.9 },
      },
    }),
  );
  assert.match(text, /read the new code in the synced workspace/);
  assert.ok(!text.includes("shown above"), `still says "shown above":\n${text}`);
});

// --- sync semantics -----------------------------------------------------------

async function makeDirtyWorkspace(dir: string): Promise<void> {
  fs.mkdirSync(dir, { recursive: true });
  await scaffoldGit(["init", "-b", "main", dir]);
  fs.writeFileSync(path.join(dir, "file.txt"), "v1\n");
  await scaffoldGit(["-C", dir, "add", "-A"]);
  await scaffoldGit([
    "-C", dir, "-c", "user.email=t@t", "-c", "user.name=t", "commit", "-q", "-m", "init",
  ]);
  fs.writeFileSync(path.join(dir, "file.txt"), "v2 dirty\n");
}

async function makeBareRemote(dir: string): Promise<string> {
  fs.mkdirSync(dir, { recursive: true });
  await scaffoldGit(["init", "--bare", "-b", "main", dir]);
  return pathToFileURL(dir).href;
}

function stubEntry(service: ArbService, e: Entry): void {
  (service.api as any).getEntry = async () => ({ entry: e });
}

test("sync: a second sync on the same fork+generation returns already-synced without waiting", async () => {
  const workdir = fs.mkdtempSync(path.join(os.tmpdir(), "arb-ut-sync2-"));
  const service = new ArbService({
    baseUrl: "http://127.0.0.1:1",
    workdir,
    pollMs: 20,
    syncTimeoutMs: 300, // would expire if it waited for a fork change
  });
  const ws = path.join(workdir, "e7");
  fs.mkdirSync(path.join(ws, ".git"), { recursive: true });
  fs.mkdirSync(path.join(workdir, ".mcp-state"), { recursive: true });
  fs.writeFileSync(
    path.join(workdir, ".mcp-state", "e7.json"),
    JSON.stringify({ entryId: "e7", workspace: ws, repo: "arb-e7-ui-1", generation: 1 }),
  );
  let getCalls = 0;
  (service.api as any).getEntry = async () => {
    getCalls++;
    return { entry: entry({ id: "e7", status: "squashed", repo: "arb-e7-ui-1", generation: 1 }) };
  };
  const r = await service.sync({ entryId: "e7" });
  assert.equal(r.synced, false);
  assert.equal(r.reason, "already synced");
  assert.equal(getCalls, 1, "sync must not poll when local state already matches");
});

test("sync: refuses to discard uncommitted/unpushed work unless force", async () => {
  const workdir = fs.mkdtempSync(path.join(os.tmpdir(), "arb-ut-syncf-"));
  const remoteDir = fs.mkdtempSync(path.join(os.tmpdir(), "arb-ut-remote-"));
  const remote = await makeBareRemote(remoteDir);
  const ws = path.join(workdir, "e5");
  await makeDirtyWorkspace(ws);
  const service = new ArbService({
    baseUrl: "http://127.0.0.1:1",
    workdir,
    pollMs: 20,
    syncTimeoutMs: 2_000,
  });
  stubEntry(
    service,
    entry({ id: "e5", status: "speculating", repo: "arb-e5-ui-1", generation: 1, remote }),
  );
  await assert.rejects(() => service.sync({ entryId: "e5" }), /force/);
  assert.notEqual(
    await scaffoldGit(["-C", ws, "status", "--porcelain"]),
    "",
    "refused sync must not touch the workspace",
  );
  const r = await service.sync({ entryId: "e5", force: true });
  assert.equal(r.synced, true);
  assert.equal(r.discarded, true);
});

test("sync: squashed entry proceeds over dirty work and reports discarded", async () => {
  const workdir = fs.mkdtempSync(path.join(os.tmpdir(), "arb-ut-synq-"));
  const remoteDir = fs.mkdtempSync(path.join(os.tmpdir(), "arb-ut-remote-"));
  const remote = await makeBareRemote(remoteDir);
  const ws = path.join(workdir, "e6");
  await makeDirtyWorkspace(ws);
  const service = new ArbService({
    baseUrl: "http://127.0.0.1:1",
    workdir,
    pollMs: 20,
    syncTimeoutMs: 2_000,
  });
  stubEntry(
    service,
    entry({
      id: "e6",
      status: "squashed",
      repo: "arb-e6-ui-1",
      generation: 1,
      remote,
      diagnosis: { reason: "interface-changed", changed: [CHANGED_SIG], producerCommit: "abc" },
    }),
  );
  const r = await service.sync({ entryId: "e6" });
  assert.equal(r.synced, true);
  assert.equal(r.discarded, true);
  assert.match(String(r.instructions), /interface-changed/);
});

// --- push fork-adoption guard ---------------------------------------------------

async function makeCommittedWorkspace(dir: string, remote: string): Promise<void> {
  fs.mkdirSync(dir, { recursive: true });
  await scaffoldGit(["init", "-b", "main", dir]);
  fs.writeFileSync(path.join(dir, "file.txt"), "v1\n");
  await scaffoldGit(["-C", dir, "add", "-A"]);
  await scaffoldGit([
    "-C", dir, "-c", "user.email=t@t", "-c", "user.name=t", "commit", "-q", "-m", "init",
  ]);
  await scaffoldGit(["-C", dir, "remote", "add", "origin", remote]);
}

test("push: refuses to adopt a drifted fork when origin does not match entry.remote", async () => {
  const workdir = fs.mkdtempSync(path.join(os.tmpdir(), "arb-ut-push-"));
  const remoteDir = fs.mkdtempSync(path.join(os.tmpdir(), "arb-ut-remote-"));
  const remote = await makeBareRemote(remoteDir);
  const ws = path.join(workdir, "e8");
  await makeCommittedWorkspace(ws, remote);
  fs.mkdirSync(path.join(workdir, ".mcp-state"), { recursive: true });
  fs.writeFileSync(
    path.join(workdir, ".mcp-state", "e8.json"),
    JSON.stringify({ entryId: "e8", workspace: ws, repo: "arb-e8-ui-0", generation: 0 }),
  );
  const service = new ArbService({ baseUrl: "http://127.0.0.1:1", workdir, pollMs: 20 });
  // The server moved the entry to a different repo, but the workspace origin
  // still points at the OLD fork -> refuse, tell the agent to arb_sync.
  stubEntry(
    service,
    entry({ id: "e8", status: "speculating", repo: "arb-e8-ui-1", generation: 1, remote: "file:///elsewhere.git" }),
  );
  await assert.rejects(() => service.push({ entryId: "e8", message: "stale" }), /arb_sync/);
  // Same drift but origin now equals the entry's remote -> adoption allowed.
  await scaffoldGit(["-C", ws, "remote", "set-url", "origin", remote]);
  stubEntry(
    service,
    entry({ id: "e8", status: "speculating", repo: "arb-e8-ui-1", generation: 1, remote }),
  );
  const r = await service.push({ entryId: "e8", message: "adopted" });
  assert.equal(r.entryId, "e8");
});

// --- register orphan + ready dirty ------------------------------------------------

test("register: a failed clone reports the entryId and points at arb_sync", async () => {
  const { client, service, close } = await wiredService();
  try {
    (service.api as any).createEntry = async () => ({
      entry: entry({ id: "e9", status: "speculating", generation: 0, remote: "https://h/r.git" }),
      token: "tok",
    });
    (service as any).cloneInto = async () => {
      throw new Error("simulated clone failure");
    };
    const r = await callTool(client, "arb_register", { agent: "a", lane: "ui" });
    assert.ok(r.isError);
    const text = resultText(r);
    assert.match(text, /e9/);
    assert.match(text, /arb_sync/);
  } finally {
    await close();
  }
});

test("ready: refuses while the workspace is dirty, pointing at arb_push", async () => {
  const workdir = fs.mkdtempSync(path.join(os.tmpdir(), "arb-ut-ready-"));
  const ws = path.join(workdir, "e4");
  await makeDirtyWorkspace(ws);
  const service = new ArbService({ baseUrl: "http://127.0.0.1:1", workdir });
  await assert.rejects(() => service.ready({ entryId: "e4" }), /arb_push/);
});
