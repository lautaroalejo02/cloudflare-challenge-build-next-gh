import test from "node:test";
import assert from "node:assert/strict";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { createArbServer } from "../src/server.ts";
import { ArbService, remoteNeedsAuth } from "../src/service.ts";
import { renderSquashInstructions } from "../src/instructions.ts";
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
    ["trunk-overlap", /trunk/],
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
