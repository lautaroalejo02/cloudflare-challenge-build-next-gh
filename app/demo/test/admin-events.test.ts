// T19: admin-key plumbing for the demo CLI and GET /api/events on the mock.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import { ApiClient } from "../src/lib/http.ts";
import { resolveAdminKey } from "../src/lib/admin-key.ts";
import { startMockServer } from "../src/mock-server.ts";

const TMP = path.join(path.resolve(import.meta.dirname, ".."), "tmp");

test("resolveAdminKey: env var wins, then the key file, else undefined", () => {
  fs.mkdirSync(TMP, { recursive: true });
  const file = path.join(TMP, "admin-key-test.txt");
  fs.writeFileSync(file, "  from-file\n");
  assert.equal(resolveAdminKey({ ARB_ADMIN_KEY: "from-env" }, file), "from-env");
  assert.equal(resolveAdminKey({}, file), "from-file");
  assert.equal(resolveAdminKey({ ARB_ADMIN_KEY: "" }, file), "from-file");
  assert.equal(resolveAdminKey({}, path.join(TMP, "does-not-exist")), undefined);
  fs.rmSync(file);
});

test("ApiClient sends x-arb-key only when it has a key", async () => {
  const seen: Array<string | undefined> = [];
  const server = http.createServer((req, res) => {
    seen.push(req.headers["x-arb-key"] as string | undefined);
    res.writeHead(200, { "content-type": "application/json" });
    res.end("{}");
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  try {
    await new ApiClient(base, "s3cret").reset();
    await new ApiClient(base).state();
  } finally {
    await new Promise<void>((r) => server.close(() => r()));
  }
  assert.deepEqual(seen, ["s3cret", undefined]);
});

test("mock GET /api/events returns the event log in the control plane's shape", async () => {
  const rootDir = path.join(TMP, "mock-events");
  fs.rmSync(rootDir, { recursive: true, force: true });
  const mock = await startMockServer({ rootDir, pollMs: 60 });
  try {
    const api = new ApiClient(mock.url);
    await api.reset();
    await api.trunkInit();
    const empty = await api.events();
    assert.ok(Array.isArray(empty.events));
    await api.setRobSize(5);
    const { events } = await api.events();
    const cfg = events.find((e) => e.type === "config");
    assert.ok(cfg, JSON.stringify(events));
    assert.equal(typeof cfg!.ts, "number");
    await api.reset();
    const after = await api.events();
    assert.deepEqual(after.events.map((e) => e.type), ["reset"]);
  } finally {
    await mock.close();
  }
});
