import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { ArbService, resolveConfig } from "../src/service.ts";
import type { Entry } from "../src/types.ts";

// One-shot live verification for the V2b audit fixes, against the real
// control plane. Drives the actual server code (ArbService) through
// register -> clone -> edit -> push -> ready, then verifies the token never
// landed in .git/config and the push was observed by the control plane.
// Veto at the end only when this entry is still the buffer head.
//
// Run: npm run check:live

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const step = (n: string, s: string) => console.log(`[live-check] ${n}: ${s}`);

const cfg = resolveConfig();
if (!cfg.adminKey) {
  console.error("[live-check] no admin key resolved (ARB_ADMIN_KEY or key file) — aborting");
  process.exit(1);
}
const workdir = fs.mkdtempSync(path.join(os.tmpdir(), "arb-v2b-live-"));
const service = new ArbService({
  baseUrl: cfg.baseUrl,
  adminKey: cfg.adminKey,
  workdir,
  pollMs: 2000,
  syncTimeoutMs: 180_000,
});
step("config", `base=${cfg.baseUrl} workdir=${workdir} adminKey=set`);

// 1. register: creates the entry, waits for the fork, clones it.
const reg = await service.register({ agent: "arb-v2b-audit-fixes", lane: "api" });
step("register", `entryId=${reg.entryId} repo-cloned-into=${reg.workspace} status=${reg.status}`);

// 2. edit + push one commit through arb_push.
const marker = `\n// v2b live-check ${new Date().toISOString()}\n`;
const target = path.join(reg.workspace, "src", "api", "order.ts");
if (fs.existsSync(target)) fs.appendFileSync(target, marker);
else fs.writeFileSync(path.join(reg.workspace, "v2b-live-check.txt"), marker);
const pushed = await service.push({ entryId: reg.entryId, message: "chore: v2b audit-fixes live check" });
step("push", `commit=${pushed.commit} committed=${pushed.committed}`);

// 3. wait until the control plane reports the pushed commit as headCommit
//    (push detection is async via the queue).
let observed: string | null = null;
const deadline = Date.now() + 90_000;
while (Date.now() < deadline) {
  const st = await service.status({ entryId: reg.entryId });
  observed = st.headCommit;
  if (observed === pushed.commit) break;
  await sleep(3000);
}
step("push-observed", `headCommit=${observed ?? "none"} match=${observed === pushed.commit}`);
if (observed !== pushed.commit) throw new Error("control plane never observed the pushed commit");

// 4. verify .git/config carries no credentials.
const gitconfig = fs.readFileSync(path.join(reg.workspace, ".git", "config"), "utf8");
const originLine = gitconfig.split("\n").find((l) => l.includes("url ="))?.trim() ?? "(no url)";
const clean = !/x:|[^/]@|art_v\d+_/.test(gitconfig);
step("git-config", `origin ${originLine} credentials-free=${clean}`);
if (!clean) throw new Error("credential material found in .git/config");

// 5. ready.
const rdy = await service.ready({ entryId: reg.entryId });
step("ready", `status=${rdy.status} commit=${rdy.commit}`);

// 6. veto only if this entry is still the buffer head.
const state = await service.state();
const terminal = new Set(["retired", "vetoed"]);
const open = state.entries.filter((e) => !terminal.has(e.status));
const head = open[open.length - 1];
const mine = state.entries.find((e) => e.entryId === reg.entryId) as Entry | undefined;
if (head && head.entryId === reg.entryId && mine && !terminal.has(mine.status)) {
  const v = await service.api.veto(reg.entryId);
  step("veto", `entry vetoed (was head); squashed dependents: ${(v as any).squashed?.length ?? 0}`);
} else {
  step("veto", `skipped — head=${head?.entryId ?? "none"}, mine=${mine?.status ?? "gone"}`);
}

console.log("[live-check] OK");
