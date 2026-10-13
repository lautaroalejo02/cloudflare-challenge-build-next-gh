import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { performance } from "node:perf_hooks";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const dir = path.dirname(fileURLToPath(import.meta.url));
const WORKER_URL = fs.readFileSync(path.join(dir, ".worker-url"), "utf8").trim();
const SECRET = fs.readFileSync(path.join(dir, ".secret-spike"), "utf8").trim();
const RUNS = Number(process.argv[2] ?? 5);
const TMP = path.join(dir, "tmp");
const OUT = path.join(dir, "results.json");
fs.mkdirSync(TMP, { recursive: true });

const headers = { authorization: `Bearer ${SECRET}`, "content-type": "application/json" };
const git = (args) => execFileSync("git", args, { stdio: ["ignore", "pipe", "pipe"] });
const authGit = (tok, args) => git(["-c", `http.extraHeader=Authorization: Bearer ${tok}`, ...args]);
const post = async (p, body) => {
	const r = await fetch(`${WORKER_URL}${p}`, { method: "POST", headers, body: JSON.stringify(body) });
	if (!r.ok) throw new Error(`POST ${p} -> ${r.status}: ${await r.text()}`);
	return r.json();
};
const getFile = async (repo, filePath) => {
	const r = await fetch(`${WORKER_URL}/file?repo=${encodeURIComponent(repo)}&ref=main&path=${encodeURIComponent(filePath)}`, { headers });
	if (!r.ok) throw new Error(`GET /file -> ${r.status}: ${await r.text()}`);
	return r.text();
};
const ms = (a, b) => Math.round((b - a) * 100) / 100;

const results = { worker: WORKER_URL, runs: [] };

for (let i = 1; i <= RUNS; i++) {
	const repo = `spike-1-run${i}-${randomUUID().slice(0, 8)}`;
	const clone = path.join(TMP, repo);
	const t0 = performance.now();
	const created = await post("/repos", { name: repo });
	const t1 = performance.now();
	const tok = await post("/tokens", { name: repo });
	const t2 = performance.now();
	authGit(tok.plaintext, ["clone", created.remote, clone]);
	const t3 = performance.now();
	const payload = `spike-1 roundtrip run${i} ${new Date().toISOString()} ${randomUUID()}\n`;
	fs.writeFileSync(path.join(clone, "spike-1.txt"), payload);
	git(["-C", clone, "add", "spike-1.txt"]);
	git(["-C", clone, "-c", "user.email=spike@local", "-c", "user.name=spike", "commit", "-m", `spike1 run${i}`]);
	authGit(tok.plaintext, ["-C", clone, "push", "-u", "origin", "main"]);
	const t4 = performance.now();
	const commit = git(["-C", clone, "rev-parse", "HEAD"]).toString().trim();
	const read = await getFile(repo, "spike-1.txt");
	const t5 = performance.now();
	results.runs.push({
		run: i, repo, commit, match: read === payload,
		create_ms: ms(t0, t1), token_ms: ms(t1, t2), clone_ms: ms(t2, t3),
		push_ms: ms(t3, t4), read_ms: ms(t4, t5), total_ms: ms(t0, t5),
	});
	console.log(`run ${i}: total=${ms(t0, t5)}ms match=${read === payload}`);
}

const totals = results.runs.map((r) => r.total_ms).sort((a, b) => a - b);
results.median_total_ms = totals[Math.floor(totals.length / 2)];
results.all_match = results.runs.every((r) => r.match);
fs.writeFileSync(OUT, JSON.stringify(results, null, 2));
console.log(`median total: ${results.median_total_ms}ms  all_match: ${results.all_match}`);
