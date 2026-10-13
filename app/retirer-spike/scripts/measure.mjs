#!/usr/bin/env node
/**
 * End-to-end measurement for the retirer spike.
 *
 * Usage: node scripts/measure.mjs <worker-base-url>
 *
 * 1. POST /setup           -> create trunk + fork repos, get remotes + write tokens
 * 2. local git             -> base commit pushed to trunk; 5 commits pushed to fork
 * 3. POST /ff x5           -> fast-forward trunk to each commit; collect phase ms
 * 4. POST /ff (old commit) -> expect 409 NOT_FAST_FORWARD
 * 5. GET /head + ls-remote -> confirm trunk head
 * Writes results.json.
 */
import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

const BASE = process.argv[2]?.replace(/\/$/, "");
if (!BASE) {
	console.error("usage: node scripts/measure.mjs <worker-base-url>");
	process.exit(2);
}

const TRUNK = "arb-test-retirer-trunk";
const FORK = "arb-test-retirer-fork";
const N = 5;

const api = async (path, body) => {
	const res = await fetch(`${BASE}${path}`, {
		method: body === undefined ? "GET" : "POST",
		headers: { "content-type": "application/json" },
		body: body === undefined ? undefined : JSON.stringify(body),
	});
	const json = await res.json().catch(() => ({}));
	return { status: res.status, json };
};

const cred = (remote, token) => remote.replace("https://", `https://x:${token}@`);

const git = (args, cwd) =>
	execFileSync("git", args, {
		cwd,
		encoding: "utf8",
		env: { ...process.env, GIT_TERMINAL_PROMPT: "0" },
	}).trim();

const out = { worker: BASE, trunk: TRUNK, fork: FORK, runs: [], checks: {} };

// ---- 1. setup -------------------------------------------------------------
console.log("setup: creating trunk + fork ...");
let setup = await api("/setup", { trunk: TRUNK, fork: FORK });
if (setup.status !== 200) {
	// repos may already exist from a previous run
	console.log("setup failed (repos may exist):", setup.status, JSON.stringify(setup.json).slice(0, 300));
	const [t, f, ti, fi] = await Promise.all([
		api("/token", { name: TRUNK, scope: "write" }),
		api("/token", { name: FORK, scope: "write" }),
		api("/info?repo=" + TRUNK),
		api("/info?repo=" + FORK),
	]);
	setup = {
		status: 200,
		json: {
			trunk: { name: TRUNK, remote: ti.json.remote, token: t.json.token },
			fork: { name: FORK, remote: fi.json.remote, token: f.json.token },
		},
	};
	if (!setup.json.trunk.remote || !setup.json.fork.remote || !setup.json.trunk.token || !setup.json.fork.token) {
		throw new Error("could not recover remotes/tokens");
	}
}
const { trunk, fork } = setup.json;
out.trunkRemote = trunk.remote;
out.forkRemote = fork.remote;
console.log(`  trunk: ${trunk.remote}`);
console.log(`  fork : ${fork.remote}`);

// ---- 2. local git ---------------------------------------------------------
// Idempotent across re-runs: trunk may already have history (fork may too).
// We always take trunk's current head T, build N new commits on top of T in a
// clone of the fork, and (force-)push them to fork main.
const work = mkdtempSync(join(tmpdir(), "arb-retire-"));
const tdir = join(work, "trunk");
const fdir = join(work, "fork");
mkdirSync(tdir); mkdirSync(fdir);

git(["clone", "-q", cred(trunk.remote, trunk.token), tdir], work);
let base;
try {
	base = git(["rev-parse", "HEAD"], tdir);
} catch {
	// empty trunk: create and push the base commit
	git(["checkout", "-q", "-b", "main"], tdir);
	mkdirSync(join(tdir, "src"));
	writeFileSync(join(tdir, "src/order.ts"), 'export function createOrder(id: string) {\n\treturn { id, total: 0 };\n}\n');
	writeFileSync(join(tdir, "README.md"), "# arb retirer spike trunk\n");
	git(["add", "-A"], tdir);
	git(["-c", "user.name=arb", "-c", "user.email=arb@test", "commit", "-qm", "base"], tdir);
	base = git(["rev-parse", "HEAD"], tdir);
	git(["push", "-q", "origin", "main"], tdir);
	console.log(`  base commit ${base.slice(0, 8)} pushed to trunk`);
}
console.log(`  trunk head T = ${base.slice(0, 8)}`);

git(["clone", "-q", cred(fork.remote, fork.token), fdir], work);
// Seed fork main at trunk head T: fetch trunk objects into the fork clone so
// the new commits descend from T even if the fork predates them.
git(["fetch", "-q", cred(trunk.remote, trunk.token), "main"], fdir);
git(["checkout", "-q", "-B", "main", "FETCH_HEAD"], fdir);
const commits = [];
mkdirSync(join(fdir, "src"), { recursive: true });
const runId = Date.now().toString(36);
for (let i = 1; i <= N; i++) {
	writeFileSync(join(fdir, `src/step-${runId}-${i}.ts`), `export const step${i} = ${i};\n`);
	git(["add", "-A"], fdir);
	git(["-c", "user.name=arb", "-c", "user.email=arb@test", "commit", "-qm", `step ${runId}-${i}`], fdir);
	commits.push(git(["rev-parse", "HEAD"], fdir));
}
git(["push", "-qf", "origin", "main"], fdir);
console.log(`  ${commits.length} commits pushed to fork (head ${commits.at(-1).slice(0, 8)})`);
out.base = base;
out.commits = commits;

// ---- 3. fast-forward runs ---------------------------------------------------
for (let i = 0; i < commits.length; i++) {
	const t0 = performance.now();
	const r = await api("/ff", { fromRepo: FORK, commit: commits[i], toRepo: TRUNK, branch: "main" });
	const wall = Math.round(performance.now() - t0);
	const run = { i: i + 1, commit: commits[i], status: r.status, wallMs: wall, ...r.json };
	out.runs.push(run);
	console.log(
		`ff ${i + 1}: status=${r.status} total=${r.json.ms?.total}ms (setup ${r.json.ms?.setup}, fetch ${r.json.ms?.fetch}, verify ${r.json.ms?.verify}, push ${r.json.ms?.push}) wall=${wall}ms fsBytes=${r.json.fsBytes}`,
	);
	if (r.status !== 200) throw new Error(`ff ${i + 1} failed: ${JSON.stringify(r.json)}`);
}

// ---- 4. non-fast-forward rejection ------------------------------------------
const reject = await api("/ff", { fromRepo: FORK, commit: commits[0], toRepo: TRUNK, branch: "main" });
out.checks.nonFastForward = { status: reject.status, code: reject.json.code };
console.log(`reject old commit: status=${reject.status} code=${reject.json.code}`);

// ---- 5. verify trunk head ----------------------------------------------------
const head = await api(`/head?repo=${TRUNK}&branch=main`);
out.checks.headViaWorker = head.json;
const lsRemote = git(["ls-remote", cred(trunk.remote, trunk.token), "refs/heads/main"], work);
out.checks.lsRemote = lsRemote;
const ok = head.json.head === commits.at(-1) && lsRemote.startsWith(commits.at(-1));
out.checks.trunkHeadOk = ok;
console.log(`trunk head: ${head.json.head} (expected ${commits.at(-1)}) -> ${ok ? "OK" : "MISMATCH"}`);

writeFileSync(new URL("../results.json", import.meta.url), JSON.stringify(out, null, 2) + "\n");
console.log("results.json written");
if (!ok) process.exit(1);
