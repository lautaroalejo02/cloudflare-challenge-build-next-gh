import fs from "node:fs";
import path from "node:path";
import { ApiClient } from "./lib/http.ts";
import { authUrl, cloneRepo, commitAll, git, hasChanges, head, push } from "./lib/git.ts";
import { syncFixture } from "./lib/fixture.ts";
import { createTimeline, scoped } from "./lib/timeline.ts";
import { startApiAgent } from "./agents/api.ts";
import { startUiAgent } from "./agents/ui.ts";
import { startTestsAgent } from "./agents/tests.ts";

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

async function main(): Promise<void> {
  const base = arg("base");
  const scenario = arg("scenario") ?? "main";
  if (!base) {
    console.error("usage: npm run demo -- --base <control-plane URL> [--scenario main|failing-check]");
    process.exit(2);
  }
  const tl = createTimeline();
  const log = scoped(tl, "scenario");
  const api = new ApiClient(base);

  // Clean stale clone dirs from earlier runs, then work under the
  // run-unique root.
  fs.rmSync(TMP_ROOT, { recursive: true, force: true });
  fs.mkdirSync(WORK_ROOT, { recursive: true });

  await api.reset();
  log("POST /api/reset ok");
  const trunk = await api.trunkInit();
  log(`trunk init: ${trunk.repo} ${trunk.remote}`);
  await pushFixture(trunk.remote, trunk.token, log);

  // Delay the producer's refactor push until both consumers exist: the early
  // cutoff is counted per live consumer at push-detection time, and the live
  // plane's fork+hash in createEntry takes a few seconds.
  const apiH = startApiAgent({ api, workRoot: WORK_ROOT, log: scoped(tl, "api"), firstPushDelayMs: 6000 });
  const apiId = await apiH.entryId;
  tl("scenario", `api entry is ${apiId}; staggering consumer registrations`);
  await sleep(2000);
  const uiH = startUiAgent({ api, workRoot: WORK_ROOT, log: scoped(tl, "ui"), producerId: apiId });
  await sleep(2000);
  const testsH = startTestsAgent({
    api,
    workRoot: WORK_ROOT,
    log: scoped(tl, "tests"),
    producerId: apiId,
    failFirst: scenario === "failing-check",
  });

  const lastStatus = new Map<string, string>();
  const lastStats = { squashes: 0, earlyCutoffs: 0, retired: 0, checksRun: 0, pushesSeen: 0 };
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
    clearInterval(watcher);
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
