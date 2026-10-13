import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { startMockServer, type MockServer } from "../src/mock-server.ts";
import { ApiClient } from "../src/lib/http.ts";
import { authUrl, cloneRepo, commitAll, git, hasChanges, head, push } from "../src/lib/git.ts";
import { detectCreateOrderVersion, detectVat } from "../src/lib/signatures.ts";
import { startApiAgent, ORDER_STUB, ORDER_V2, ORDER_V1_1_REFACTORED, ORDER_V1_1_VAT, ORDER_V2_VAT } from "../src/agents/api.ts";
import { startUiAgent } from "../src/agents/ui.ts";
import { startTestsAgent } from "../src/agents/tests.ts";
import { startPayApiAgent } from "../src/agents/payapi.ts";
import { startPayUiAgent, detectChargeVersion } from "../src/agents/payui.ts";

const DEMO_DIR = path.resolve(import.meta.dirname, "..");
const FIXTURE_DIR = path.join(DEMO_DIR, "fixture");
const TMP = path.join(DEMO_DIR, "tmp");
const noop = () => {};

function copyDir(src: string, dst: string): void {
  fs.mkdirSync(dst, { recursive: true });
  for (const e of fs.readdirSync(src, { withFileTypes: true })) {
    const s = path.join(src, e.name);
    const d = path.join(dst, e.name);
    if (e.isDirectory()) copyDir(s, d);
    else fs.copyFileSync(s, d);
  }
}

async function boot(name: string): Promise<{ api: ApiClient; mock: MockServer; workRoot: string }> {
  const rootDir = path.join(TMP, `mock-${name}`);
  fs.rmSync(rootDir, { recursive: true, force: true });
  const workRoot = path.join(TMP, `work-${name}`);
  fs.rmSync(workRoot, { recursive: true, force: true });
  fs.mkdirSync(workRoot, { recursive: true });
  const mock = await startMockServer({ rootDir, pollMs: 60 });
  const api = new ApiClient(mock.url);
  return { api, mock, workRoot };
}

async function pushFixture(api: ApiClient, workRoot: string): Promise<void> {
  const trunk = await api.trunkInit();
  const dir = path.join(workRoot, "trunk-src");
  fs.mkdirSync(dir, { recursive: true });
  await git(["init", "-b", "main"], dir);
  await git(["-C", dir, "remote", "add", "origin", authUrl(trunk.remote, trunk.token)]);
  copyDir(FIXTURE_DIR, dir);
  await commitAll(dir, "chore: seed fixture", "arb-test");
  await push(dir);
}

test("fixture test module passes and signature detector reads v1", async () => {
  const mod = await import(pathToFileURL(path.join(FIXTURE_DIR, "tests/order.test.ts")).href);
  const results = await mod.run();
  assert.ok(results.length >= 2);
  assert.ok(results.every((r: { ok: boolean }) => r.ok), JSON.stringify(results));
  const orderSrc = fs.readFileSync(path.join(FIXTURE_DIR, "src/api/order.ts"), "utf8");
  assert.equal(detectCreateOrderVersion(orderSrc), "v1");
  assert.equal(detectCreateOrderVersion(ORDER_V2), "v2");
});

test("main scenario: early cutoff then squash, generation bump and re-clone", { timeout: 90_000 }, async () => {
  const { api, mock, workRoot } = await boot("main");
  try {
    await api.reset();
    await pushFixture(api, workRoot);

    const apiH = startApiAgent({
      api, workRoot, log: noop, pollMs: 120, firstPushDelayMs: 150, breakingChangeDelayMs: 1200,
    });
    const apiId = await apiH.entryId;
    const uiH = startUiAgent({ api, workRoot, log: noop, producerId: apiId, pollMs: 120 });
    const testsH = startTestsAgent({ api, workRoot, log: noop, producerId: apiId, pollMs: 120 });

    const [a, u, t] = await Promise.all([apiH.done, uiH.done, testsH.done]);
    assert.equal(a.status, "retired");
    assert.equal(u.status, "retired");
    assert.equal(t.status, "retired");

    const s = await api.state();
    assert.deepEqual(
      s.entries.map((e) => e.status),
      ["retired", "retired", "retired"],
    );
    // The v1 refactor push caused no squash (early cutoff); the v2 push
    // squashed exactly the two consumers. earlyCutoffs counts every push that
    // changed no consumed interface, so interface-unchanged consumer pushes
    // count too.
    assert.ok(s.stats.earlyCutoffs >= 1, `earlyCutoffs=${s.stats.earlyCutoffs}`);
    assert.equal(s.stats.squashes, 2);
    assert.equal(s.stats.pushesSeen >= 5, true);
    assert.equal(s.trunk.retiredCount, 3);

    // Generation bump + re-clone: each consumer has a -g0 and a -g1 workdir.
    for (const id of [u.id, t.id]) {
      assert.ok(fs.existsSync(path.join(workRoot, `${id}-g0`)), `${id}-g0 missing`);
      assert.ok(fs.existsSync(path.join(workRoot, `${id}-g1`)), `${id}-g1 missing`);
    }
    // The re-cloned fork carries the producer's v2 interface.
    const recloned = fs.readFileSync(path.join(workRoot, `${u.id}-g1`, "src/api/order.ts"), "utf8");
    assert.equal(detectCreateOrderVersion(recloned), "v2");
    // The consumer adapted its work to the v2 signature.
    const checkout = fs.readFileSync(path.join(workRoot, `${u.id}-g1`, "src/ui/checkout.ts"), "utf8");
    assert.match(checkout, /createOrder\(cart, \{ region, currency \}\)/);

    // In-order retirement: trunk main contains all three agents' work.
    const trunkRepo = path.join(mock.rootDir, "repos", "arb-trunk.git");
    const orderAtTrunk = await git(["-C", trunkRepo, "show", "main:src/api/order.ts"]);
    assert.match(orderAtTrunk, /opts:\s*\{ region: string; currency: string \}/);
    const checkoutAtTrunk = await git(["-C", trunkRepo, "show", "main:src/ui/checkout.ts"]);
    assert.match(checkoutAtTrunk, /renderExpressCheckout/);
    const testAtTrunk = await git(["-C", trunkRepo, "show", "main:tests/create-order.feature.test.ts"]);
    assert.match(testAtTrunk, /EUR/);
  } finally {
    await mock.close();
  }
});

test("prediction: stub consumers get hit/miss verdicts on the first real push", { timeout: 90_000 }, async () => {
  const { api, mock, workRoot } = await boot("pred");
  try {
    await api.reset();
    await pushFixture(api, workRoot);

    const apiH = startApiAgent({
      api,
      workRoot,
      log: noop,
      pollMs: 120,
      firstPushDelayMs: 400,
      breakingChangeDelayMs: 1200,
      stub: { "src/api/order.ts": ORDER_STUB },
    });
    const apiId = await apiH.entryId;
    const uiH = startUiAgent({ api, workRoot, log: noop, producerId: apiId, pollMs: 120 });
    const testsH = startTestsAgent({ api, workRoot, log: noop, producerId: apiId, pollMs: 120 });

    const [a, u, t] = await Promise.all([apiH.done, uiH.done, testsH.done]);
    assert.equal(a.status, "retired");
    assert.equal(u.status, "retired");
    assert.equal(t.status, "retired");

    const s = await api.state();
    // First push: createOrder lands exactly as declared (e2+e3 hit), Order
    // gains an undeclared currency field (e2 misses and is squashed).
    assert.equal(s.stats.predictionHits, 2);
    assert.equal(s.stats.predictionMisses, 1);
    assert.ok(
      mock.internals.squashes.some((x) => x.reason === "prediction-miss"),
      "expected a prediction-miss squash",
    );
    // The later breaking change still squashes as an ordinary interface change.
    assert.ok(
      mock.internals.squashes.some((x) => x.reason === "interface-changed"),
      "expected an interface-changed squash",
    );
  } finally {
    await mock.close();
  }
});

test("V2 behavior beat: VAT change detected by sniffers; inferred ui registers without consumes", () => {
  assert.equal(detectVat(ORDER_V1_1_VAT), true);
  assert.equal(detectVat(ORDER_V2_VAT), true);
  assert.equal(detectVat(ORDER_V1_1_REFACTORED), false);
  assert.equal(detectVat(ORDER_V2), false);
  // Same signatures as the refactor: only the body (behavior) differs.
  assert.equal(detectCreateOrderVersion(ORDER_V1_1_VAT), "v1");
  assert.equal(detectCreateOrderVersion(ORDER_V2_VAT), "v2");
});

test("V2 main scenario: behavior beat + inferred ui on the mock, consumers adapt to VAT", { timeout: 90_000 }, async () => {
  const { api, mock, workRoot } = await boot("v2");
  try {
    await api.reset();
    await pushFixture(api, workRoot);

    const apiH = startApiAgent({
      api, workRoot, log: noop, pollMs: 120,
      firstPushDelayMs: 400, bodyOnlyDelayMs: 300, behaviorChangeDelayMs: 300, breakingChangeDelayMs: 1200,
      stub: { "src/api/order.ts": ORDER_STUB },
    });
    const apiId = await apiH.entryId;
    const uiH = startUiAgent({ api, workRoot, log: noop, producerId: apiId, pollMs: 120, infer: true });
    const testsH = startTestsAgent({ api, workRoot, log: noop, producerId: apiId, pollMs: 120 });

    const [a, u, t] = await Promise.all([apiH.done, uiH.done, testsH.done]);
    for (const e of [a, u, t]) assert.equal(e.status, "retired", e.id);
    // Registration without consumes: the mock treats it as none (no inference).
    assert.equal(u.consumesInferred, true);
    assert.deepEqual(u.consumes, {});
    assert.equal(t.consumesInferred, false);

    const s = await api.state();
    assert.equal(s.trunk.retiredCount, 3);
    assert.deepEqual([s.stats.judgments, s.stats.semanticSquashes, s.stats.inferredDeps], [0, 0, 0]);

    // The tests consumer was re-forked by the breaking change and adapted to
    // BOTH the v2 signature and the VAT behavior; its check passed on retire.
    const trunkRepo = path.join(mock.rootDir, "repos", "arb-trunk.git");
    const featureAtTrunk = await git(["-C", trunkRepo, "show", "main:tests/create-order.feature.test.ts"]);
    assert.match(featureAtTrunk, /order\.totalCents === 1104/);
    const orderTestAtTrunk = await git(["-C", trunkRepo, "show", "main:tests/order.test.ts"]);
    assert.match(orderTestAtTrunk, /1560/);
    const orderAtTrunk = await git(["-C", trunkRepo, "show", "main:src/api/order.ts"]);
    assert.ok(detectVat(orderAtTrunk) && detectCreateOrderVersion(orderAtTrunk) === "v2");
    assert.equal(t.checks?.failed, 0);
  } finally {
    await mock.close();
  }
});

test("failing-check scenario: failing test blocks retirement until fixed", { timeout: 90_000 }, async () => {
  const { api, mock, workRoot } = await boot("fail");
  try {
    await api.reset();
    await pushFixture(api, workRoot);

    const apiH = startApiAgent({
      api, workRoot, log: noop, pollMs: 120, firstPushDelayMs: 150, breakingChangeDelayMs: 1200,
    });
    const apiId = await apiH.entryId;
    const testsH = startTestsAgent({ api, workRoot, log: noop, producerId: apiId, pollMs: 120, failFirst: true });

    const [a, t] = await Promise.all([apiH.done, testsH.done]);
    assert.equal(a.status, "retired");
    assert.equal(t.status, "retired");

    const testsChecks = mock.internals.checks.filter(
      (c) => c.results.some((r) => r.name.includes("create-order.feature")),
    );
    assert.ok(
      testsChecks.some((c) => c.failed > 0),
      "expected at least one failing check run for the tests entry",
    );
    const lastCheck = t.checks;
    assert.ok(lastCheck);
    assert.equal(lastCheck.failed, 0);
    // The entry was not retired while the check was failing: two separate
    // check runs happened before retirement.
    assert.ok(testsChecks.length >= 2);
  } finally {
    await mock.close();
  }
});

test("multi scenario: two independent chains, squashes stay inside their component", { timeout: 120_000 }, async () => {
  const { api, mock, workRoot } = await boot("multi");
  try {
    await api.reset();
    await pushFixture(api, workRoot);

    const ordersH = startApiAgent({
      api, workRoot, log: noop, pollMs: 120,
      firstPushDelayMs: 400, bodyOnlyDelayMs: 300, breakingChangeDelayMs: 900,
      stub: { "src/api/order.ts": ORDER_STUB },
    });
    const payH = startPayApiAgent({
      api, workRoot, log: noop, pollMs: 120, firstPushDelayMs: 300, breakingChangeDelayMs: 700,
    });
    const ordersId = await ordersH.entryId;
    const payId = await payH.entryId;
    assert.notEqual(ordersId, payId);

    const uiH = startUiAgent({ api, workRoot, log: noop, producerId: ordersId, pollMs: 120 });
    const testsH = startTestsAgent({ api, workRoot, log: noop, producerId: ordersId, pollMs: 120 });
    const payUiH = startPayUiAgent({ api, workRoot, log: noop, producerId: payId, pollMs: 120 });

    const [oa, pa, u, t, pu] = await Promise.all([ordersH.done, payH.done, uiH.done, testsH.done, payUiH.done]);
    for (const e of [oa, pa, u, t, pu]) assert.equal(e.status, "retired", e.id);

    const s = await api.state();
    assert.equal(s.trunk.retiredCount, 5);

    // Component isolation: the payments consumer was squashed exactly once —
    // by its own producer's breaking change — never by orders pushes.
    const paySquashes = mock.internals.squashes.filter((x) => x.entryId === pu.id);
    assert.equal(paySquashes.length, 1, JSON.stringify(paySquashes));
    assert.equal(paySquashes[0].reason, "interface-changed");
    assert.equal(pu.generation, 1);
    // Orders consumers squashed at least once each (prediction-miss or
    // interface change); producers never squashed.
    assert.ok(u.generation >= 1 && t.generation >= 1);
    assert.equal(oa.generation, 0);
    assert.equal(pa.generation, 0);
    // No orders-chain squash touched a payments entry and vice versa: every
    // squashed entry's producer chain root is itself a root entry here.
    const byId = new Map(s.entries.map((e) => [e.id, e]));
    const rootOf = (id: string): string => {
      let e = byId.get(id);
      while (e?.producerId) e = byId.get(e.producerId);
      return e?.id ?? id;
    };
    for (const sq of mock.internals.squashes) {
      const root = rootOf(sq.entryId);
      assert.ok([ordersId, payId].includes(root), `squashed ${sq.entryId} has unexpected root ${root}`);
    }

    // The re-cloned payments fork carries the v2 charge interface, and the
    // consumer adapted to it.
    const reclonedPay = fs.readFileSync(path.join(workRoot, `${pu.id}-g1`, "src/api/payment.ts"), "utf8");
    assert.equal(detectChargeVersion(reclonedPay), "v2");
    const paywall = fs.readFileSync(path.join(workRoot, `${pu.id}-g1`, "src/ui/paywall.ts"), "utf8");
    assert.match(paywall, /renderFastPay/);
    assert.match(paywall, /currency: "EUR"/);

    // Both chains retired onto the shared trunk.
    const trunkRepo = path.join(mock.rootDir, "repos", "arb-trunk.git");
    const payAtTrunk = await git(["-C", trunkRepo, "show", "main:src/api/payment.ts"]);
    assert.match(payAtTrunk, /currency: string/);
    const paywallAtTrunk = await git(["-C", trunkRepo, "show", "main:src/ui/paywall.ts"]);
    assert.match(paywallAtTrunk, /renderFastPay/);
    const orderAtTrunk = await git(["-C", trunkRepo, "show", "main:src/api/order.ts"]);
    assert.match(orderAtTrunk, /opts:\s*\{ region: string; currency: string \}/);
  } finally {
    await mock.close();
  }
});

test("robSize limit rejects entries with 409", async () => {
  const { api, mock, workRoot } = await boot("rob");
  try {
    await api.reset();
    await pushFixture(api, workRoot);
    await api.setRobSize(1);
    await api.createEntry({ agent: "a", lane: "api" });
    await assert.rejects(() => api.createEntry({ agent: "b", lane: "ui" }), /reorder buffer full/);
  } finally {
    await mock.close();
  }
});

test("veto applies to head entry only", async () => {
  const { api, mock, workRoot } = await boot("veto");
  try {
    await api.reset();
    await pushFixture(api, workRoot);
    const e1 = await api.createEntry({ agent: "a", lane: "api" });
    const e2 = await api.createEntry({ agent: "b", lane: "ui", producerId: e1.entry.id, consumes: ["createOrder"] });
    await assert.rejects(() => api.veto(e1.entry.id), /head entry only/);
    const res = await api.veto(e2.entry.id);
    assert.equal(res.entry.status, "vetoed");
    assert.deepEqual(res.squashed, []);
    const again = await api.veto(e1.entry.id);
    assert.equal(again.entry.status, "vetoed");
  } finally {
    await mock.close();
  }
});
