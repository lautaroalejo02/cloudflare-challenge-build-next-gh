import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { performance } from "node:perf_hooks";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const dir = path.dirname(fileURLToPath(import.meta.url));
const WORKER_URL = fs.readFileSync(path.join(dir, ".worker-url"), "utf8").trim();
const SECRET = fs.readFileSync(path.join(dir, ".spike-secret"), "utf8").trim();
const REPO = `spike1-repo-${fs.readFileSync(path.join(dir, ".spike-suffix"), "utf8").trim()}`;
const CLONE = path.join(dir, "tmp-clone");
const OUT = path.join(dir, "results.json");

const headers = { authorization: `Bearer ${SECRET}`, "content-type": "application/json" };
const git = (args) => execFileSync("git", args, { stdio: ["ignore", "pipe", "pipe"] });
const post = async (p, body) => {
	const r = await fetch(`${WORKER_URL}${p}`, { method: "POST", headers, body: JSON.stringify(body) });
	if (!r.ok) throw new Error(`POST ${p} -> ${r.status}: ${await r.text()}`);
	return r.json();
};
const getFile = async (repo, path_) => {
	const r = await fetch(`${WORKER_URL}/file?repo=${encodeURIComponent(repo)}&ref=main&path=${encodeURIComponent(path_)}`, { headers });
	if (!r.ok) throw new Error(`GET /file -> ${r.status}: ${await r.text()}`);
	return r.text();
};
const ms = (a, b) => Math.round((b - a) * 100) / 100;
const authGit = (tok, args) => git(["-c", `http.extraHeader=Authorization: Bearer ${tok}`, ...args]);

const results = { repo: REPO, worker: WORKER_URL, cycles: [] };

// Cycle 1 (full): create repo -> mint write token -> clone -> commit+push -> readFile
const t0 = performance.now();
const created = await post("/repos", { name: REPO });
const t1 = performance.now();
const tok = await post("/tokens", { name: REPO });
const t2 = performance.now();
authGit(tok.plaintext, ["clone", created.remote, CLONE]);
const t3 = performance.now();
const payload1 = `spike-1 roundtrip ${new Date().toISOString()} ${randomUUID()}\n`;
fs.writeFileSync(path.join(CLONE, "spike-1.txt"), payload1);
git(["-C", CLONE, "add", "spike-1.txt"]);
git(["-C", CLONE, "-c", "user.email=spike@local", "-c", "user.name=spike", "commit", "-m", "spike1 cycle1"]);
authGit(tok.plaintext, ["-C", CLONE, "push", "-u", "origin", "main"]);
const t4 = performance.now();
const commit1 = git(["-C", CLONE, "rev-parse", "HEAD"]).toString().trim();
const read1 = await getFile(REPO, "spike-1.txt");
const t5 = performance.now();
results.cycles.push({
	cycle: 1, kind: "full", commit: commit1, match: read1 === payload1,
	create_ms: ms(t0, t1), token_ms: ms(t1, t2), clone_ms: ms(t2, t3),
	push_ms: ms(t3, t4), read_ms: ms(t4, t5), total_ms: ms(t0, t5),
});

// Cycles 2-3 (repeat): mint write token -> new file -> commit+push -> readFile (same repo)
for (let i = 2; i <= 3; i++) {
	const c0 = performance.now();
	const tk = await post("/tokens", { name: REPO });
	const c1 = performance.now();
	const file = `spike-${i}.txt`;
	const payload = `spike-1 roundtrip cycle${i} ${new Date().toISOString()} ${randomUUID()}\n`;
	fs.writeFileSync(path.join(CLONE, file), payload);
	git(["-C", CLONE, "add", file]);
	git(["-C", CLONE, "-c", "user.email=spike@local", "-c", "user.name=spike", "commit", "-m", `spike1 cycle${i}`]);
	authGit(tk.plaintext, ["-C", CLONE, "push", "origin", "main"]);
	const c2 = performance.now();
	const commit = git(["-C", CLONE, "rev-parse", "HEAD"]).toString().trim();
	const read = await getFile(REPO, file);
	const c3 = performance.now();
	results.cycles.push({
		cycle: i, kind: "repeat", commit, match: read === payload,
		token_ms: ms(c0, c1), push_ms: ms(c1, c2), read_ms: ms(c2, c3), total_ms: ms(c0, c3),
	});
}

fs.writeFileSync(OUT, JSON.stringify(results, null, 2));
const { worker, ...rest } = results;
console.log(JSON.stringify(rest));
