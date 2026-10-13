import fs from "node:fs";
import path from "node:path";
import { ApiClient } from "./lib/http.ts";
import { resolveAdminKey } from "./lib/admin-key.ts";
import { authUrl, cloneRepo, commitAll, git, hasChanges, head, push } from "./lib/git.ts";
import { syncFixture } from "./lib/fixture.ts";
import { createTimeline, scoped } from "./lib/timeline.ts";
import { ORDER_STUB, startApiAgent } from "./agents/api.ts";
import { startUiAgent } from "./agents/ui.ts";
import { startTestsAgent } from "./agents/tests.ts";
import { startPayApiAgent } from "./agents/payapi.ts";
import { startPayUiAgent } from "./agents/payui.ts";

const DEMO_DIR = path.resolve(import.meta.dirname, "..");
const FIXTURE_DIR = path.join(DEMO_DIR, "fixture");
const TMP_ROOT = path.join(DEMO_DIR, "tmp");
// Run-unique work root: entry ids restart at e1 after /api/reset, so a fixed
// tmp/<entry>-g<gen> layout could reuse stale clones from earlier runs.
const WORK_ROOT = path.join(TMP_ROOT, `run-${Date.now().toString(36)}-${process.pid.toString(36)}`);
const TIMEOUT_MS = 5 * 60_000;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// Queued writes to piped stdout/stderr must complete before process.exit, or
// the last timeline lines can be truncated. An empty write's callback fires
// after all prior writes on that stream — it acts as a flush barrier.
const flushOut = () =>
  Promise.all([
    new Promise<void>((r) => process.stdout.write("", () => r())),
    new Promise<void>((r) => process.stderr.write("", () => r())),
  ]);

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  if (i >= 0 && process.argv[i + 1] && !process.argv[i + 1].startsWith("--")) return process.argv[i + 1];
  const eq = process.argv.find((a) => a.startsWith(`--${name}=`));
  return eq?.split("=").slice(1).join("=");
}

async function pushFixture(remote: string, token: string, log: (m: string) => void): Promise<string> {
  const dir = path.join(WORK_ROOT, "trunk-src");
  fs.rmSync(dir, { recursive: true, force: true });
  try {
    await cloneRepo(remote, token, dir);
  } catch {
    fs.mkdirSync(dir, { recursive: true });
    await git(["init", "-b", "main"], dir);
    await git(["-C", dir, "remote", "add", "origin", authUrl(remote, token)]);
  }
  // Seed exactly the fixture tree: trunk accumulates retired files across runs
  // (reset does not delete repos), so stale files must be deleted, not copied
  // over — otherwise every fork inherits them (live-run T9 defect).
  syncFixture(dir, FIXTURE_DIR);
  if (await hasChanges(dir)) {
    const sha = await commitAll(dir, "chore: seed fixture (order api, checkout ui, tests)", "arb-scenario");
    await push(dir);
    log(`fixture pushed to trunk at ${(sha ?? "unchanged").slice(0, 8)}`);
    return head(dir);
  }
  log("trunk already contains the fixture");
  return head(dir);
}

// Timeline watcher: logs entry status transitions and stats deltas while a
// scenario runs. Returns a stop() that clears the interval.
function startWatcher(api: ApiClient, tl: ReturnType<typeof createTimeline>): () => void {
  const lastStatus = new Map<string, string>();
  const lastStats = { squashes: 0, earlyCutoffs: 0, retired: 0, checksRun: 0, pushesSeen: 0, predictionHits: 0, predictionMisses: 0 };
  const watcher = setInterval(() => {
    api
      .state()
      .then((s) => {
        for (const e of s.entries) {
          const prev = lastStatus.get(e.id);
          if (prev !== e.status) {
            tl("buffer", `${e.id} (${e.lane}) ${prev ?? "created"} -> ${e.status}`);
            lastStatus.set(e.id, e.status);
          }
        }
        for (const k of Object.keys(lastStats) as Array<keyof typeof lastStats>) {
          if (s.stats[k] !== lastStats[k]) {
            tl("buffer", `stats.${k} ${lastStats[k]} -> ${s.stats[k]}`);
            lastStats[k] = s.stats[k];
          }
        }
      })
      .catch(() => {});
  }, 800);
  watcher.unref();
  return () => clearInterval(watcher);
}

async function main(): Promise<void> {
  const base = arg("base");
  const scenario = arg("scenario") ?? "main";
  if (!base || !["main", "failing-check", "multi"].includes(scenario)) {
    console.error("usage: npm run demo -- --base <control-plane URL> [--scenario main|failing-check|multi]");
    process.exit(2);
  }
  const tl = createTimeline();
  const log = scoped(tl, "scenario");
  // Protected endpoints need the admin key (T19): ARB_ADMIN_KEY env var, else
  // app/control-plane/.secret-admin-key. The local mock ignores it.
  const adminKey = resolveAdminKey();
  const api = new ApiClient(base, adminKey);
  log(adminKey ? "admin key loaded (x-arb-key)" : "no admin key found - protected endpoints will 403 on the real plane");

  // Clean stale clone dirs from earlier runs, then work under the
  // run-unique root.
  fs.rmSync(TMP_ROOT, { recursive: true, force: true });
  fs.mkdirSync(WORK_ROOT, { recursive: true });

  await api.reset();
  log("POST /api/reset ok");
  const trunk = await api.trunkInit();
  log(`trunk init: ${trunk.repo} ${trunk.remote}`);
  await pushFixture(trunk.remote, trunk.token, log);

  if (scenario === "multi") return runMulti(api, tl, trunk.remote, trunk.token);

  // Value prediction (T11): the API agent declares its stub at registration;
  // the consumers register immediately and forward against the declared
  // hashes. The producer's first push is delayed until both consumers exist —
  // verdicts (hit/miss) are resolved per live consumer at push-detection time.
  const apiH = startApiAgent({
    api,
    workRoot: WORK_ROOT,
    log: scoped(tl, "api"),
    firstPushDelayMs: 9000,
    bodyOnlyDelayMs: 7000,
    breakingChangeDelayMs: 10_000,
    stub: { "src/api/order.ts": ORDER_STUB },
  });
  const apiId = await apiH.entryId;
  tl("scenario", `api entry is ${apiId}; consumers register against the declared stub`);
  await sleep(1500);
  const uiH = startUiAgent({ api, workRoot: WORK_ROOT, log: scoped(tl, "ui"), producerId: apiId });
  await sleep(1500);
  const testsH = startTestsAgent({
    api,
    workRoot: WORK_ROOT,
    log: scoped(tl, "tests"),
    producerId: apiId,
    failFirst: scenario === "failing-check",
  });

  const stopWatcher = startWatcher(api, tl);

  // The timeout timer is unref'd and cancelled on completion: a pending
  // 5-minute setTimeout kept the event loop alive for ~270s after the demo
  // had already finished (live-run T9 defect — process exited at ~311s).
  let timeoutTimer: NodeJS.Timeout;
  const timeout = new Promise<never>((_, reject) => {
    timeoutTimer = setTimeout(() => reject(new Error("demo timed out after 5 minutes")), TIMEOUT_MS);
  });
  timeoutTimer!.unref();
  try {
    await Promise.race([Promise.all([apiH.done, uiH.done, testsH.done]), timeout]);
  } finally {
    stopWatcher();
    clearTimeout(timeoutTimer!);
  }

  const s = await api.state();
  for (const e of s.entries) {
    tl("final", `${e.id} ${e.lane.padEnd(6)} status=${e.status} gen=${e.generation} head=${(e.headCommit ?? "none").slice(0, 8)}`);
  }
  tl("final", `stats=${JSON.stringify(s.stats)} trunk=${(s.trunk.commit ?? "none").slice(0, 8)} retired=${s.trunk.retiredCount}`);
  const notRetired = s.entries.filter((e) => e.status !== "retired");
  if (notRetired.length > 0) {
    console.error(`FAIL: entries not retired: ${notRetired.map((e) => e.id).join(", ")}`);
    await flushOut();
    process.exit(1);
  }
  log("all three entries retired onto trunk in order - demo complete");
}

// T14 multi-component scenario: two independent producer/consumer chains —
// orders (api -> ui + tests, with declared-stub prediction) and payments
// (api -> ui). Asserts a squash in one connected component never touches the
// other, and that both chains retire onto the shared trunk.
async function runMulti(
  api: ApiClient,
  tl: ReturnType<typeof createTimeline>,
  trunkRemote: string,
  trunkToken: string,
): Promise<void> {
  const log = scoped(tl, "multi");

  // Two independent roots => two components on the sharded control plane.
  // Producer pushes are delayed until both chains' consumers are registered.
  const ordersH = startApiAgent({
    api,
    workRoot: WORK_ROOT,
    log: scoped(tl, "o-api"),
    firstPushDelayMs: 12_000,
    bodyOnlyDelayMs: 8000,
    breakingChangeDelayMs: 14_000,
    stub: { "src/api/order.ts": ORDER_STUB },
  });
  const payH = startPayApiAgent({
    api,
    workRoot: WORK_ROOT,
    log: scoped(tl, "p-api"),
    firstPushDelayMs: 9000,
    breakingChangeDelayMs: 18_000,
  });
  const ordersId = await ordersH.entryId;
  const payId = await payH.entryId;
  tl("scenario", `orders root=${ordersId}; payments root=${payId} - two independent components`);

  await sleep(1500);
  const uiH = startUiAgent({ api, workRoot: WORK_ROOT, log: scoped(tl, "o-ui"), producerId: ordersId });
  await sleep(1200);
  const testsH = startTestsAgent({ api, workRoot: WORK_ROOT, log: scoped(tl, "o-tests"), producerId: ordersId });
  await sleep(1200);
  const payUiH = startPayUiAgent({ api, workRoot: WORK_ROOT, log: scoped(tl, "p-ui"), producerId: payId });

  const stopWatcher = startWatcher(api, tl);

  let timeoutTimer: NodeJS.Timeout;
  const timeout = new Promise<never>((_, reject) => {
    timeoutTimer = setTimeout(() => reject(new Error("demo timed out after 5 minutes")), TIMEOUT_MS);
  });
  timeoutTimer!.unref();
  try {
    await Promise.race([
      Promise.all([ordersH.done, payH.done, uiH.done, testsH.done, payUiH.done]),
      timeout,
    ]);
  } finally {
    stopWatcher();
    clearTimeout(timeoutTimer!);
  }

  const s = await api.state();
  const [uiE, testsE, payUiE] = await Promise.all([uiH.done, testsH.done, payUiH.done]);
  for (const e of s.entries) {
    tl(
      "final",
      `${e.id} ${e.lane.padEnd(6)} status=${e.status} gen=${e.generation} comp=${e.component ?? "?"} head=${(e.headCommit ?? "none").slice(0, 8)}`,
    );
  }
  tl("final", `stats=${JSON.stringify(s.stats)} trunk=${(s.trunk.commit ?? "none").slice(0, 8)} retired=${s.trunk.retiredCount}`);

  const fail = async (msg: string): Promise<never> => {
    console.error(`FAIL: ${msg}`);
    await flushOut();
    process.exit(1);
  };

  const notRetired = s.entries.filter((e) => e.status !== "retired");
  if (notRetired.length > 0) await fail(`entries not retired: ${notRetired.map((e) => e.id).join(", ")}`);
  if (s.trunk.retiredCount !== 5) await fail(`trunk.retiredCount ${s.trunk.retiredCount} != 5`);

  // Squash isolation: every interface squash must pair with a producer push
  // inside the SAME connected component. Component = transitive producer
  // root (on the sharded plane this is also the DO that owns the entries —
  // the aggregated `component` field cross-checks it when present).
  const byId = new Map(s.entries.map((e) => [e.id, e]));
  const rootOf = (id: string): string => {
    let e = byId.get(id);
    const seen = new Set<string>();
    while (e?.producerId && !seen.has(e.id)) {
      seen.add(e.id);
      e = byId.get(e.producerId);
    }
    return e?.id ?? id;
  };
  if (s.entries.every((e) => e.component)) {
    for (const e of s.entries) {
      if (e.component !== `comp-${rootOf(e.id)}`) {
        await fail(`${e.id} component ${e.component} != comp-${rootOf(e.id)}`);
      }
    }
  }
  const { events } = await api.events();
  const violations: string[] = [];
  for (let i = 0; i < events.length; i++) {
    const ev = events[i];
    if (ev.type !== "squash" || !ev.entryId) continue;
    // Pair with the nearest preceding producer-push event for this entry
    // (hash.changed / prediction.miss carry data.producerId). Cascading
    // squashes (producer-squashed etc.) are same-component by construction.
    for (let j = i - 1; j >= 0; j--) {
      const prev = events[j];
      if (prev.entryId !== ev.entryId) continue;
      if (prev.type === "hash.changed" || prev.type === "prediction.miss") {
        const pid = prev.data?.producerId;
        if (typeof pid === "string" && rootOf(pid) !== rootOf(ev.entryId)) {
          violations.push(`${ev.entryId} squashed by ${pid} across components`);
        }
        break;
      }
    }
  }
  if (violations.length > 0) await fail(`cross-component squashes: ${violations.join("; ")}`);

  // The payments consumer must be squashed exactly once — by its own
  // producer's breaking change — never by orders pushes.
  if (payUiE.generation !== 1) await fail(`pay-ui generation ${payUiE.generation} != 1`);
  if (uiE.generation < 1 || testsE.generation < 1) {
    await fail(`orders consumers not squashed: ui gen=${uiE.generation} tests gen=${testsE.generation}`);
  }

  // Both chains' final work must be on the shared trunk.
  const trunkDir = path.join(WORK_ROOT, "trunk-verify");
  fs.rmSync(trunkDir, { recursive: true, force: true });
  await cloneRepo(trunkRemote, trunkToken, trunkDir);
  const readTrunk = (p: string) => fs.readFileSync(path.join(trunkDir, p), "utf8");
  const trunkChecks: Array<[string, string, string]> = [
    ["src/api/order.ts", "opts: { region: string; currency: string }", "orders api v2 signature"],
    ["src/ui/checkout.ts", "renderExpressCheckout", "orders ui work"],
    ["src/api/payment.ts", "currency: string", "payments api v2 signature"],
    ["src/ui/paywall.ts", "renderFastPay", "payments ui work"],
    ["tests/payment.test.ts", "charge converts to EUR", "payments v2 test"],
  ];
  for (const [file, needle, what] of trunkChecks) {
    if (!readTrunk(file).includes(needle)) await fail(`trunk ${file} missing ${what}`);
  }
  tl("final", "trunk contains both chains' final work");
  log("both chains retired onto the shared trunk; squashes stayed inside their component - multi demo complete");
}

// Exit immediately on completion: the unref'd timeout/cleared watcher leave
// only fetch keep-alive sockets, whose idle timeout would otherwise hold the
// process for several seconds past the last timeline line.
main()
  .then(async () => {
    await flushOut();
    process.exit(0);
  })
  .catch(async (e) => {
    console.error(`demo failed: ${(e as Error).stack ?? e}`);
    await flushOut();
    process.exit(1);
  });
