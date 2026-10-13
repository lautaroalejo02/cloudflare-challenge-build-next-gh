import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import { pathToFileURL } from "node:url";
import { git } from "./lib/git.ts";
import type {
  BufferState,
  CheckResult,
  Diagnosis,
  Entry,
  SymbolHashes,
} from "./lib/types.ts";

// ---------------------------------------------------------------------------
// Local mock of the arb control plane (app/CONTRACTS.md HTTP API). It exists so
// the scripted agents' state machines can be exercised without Cloudflare:
// repos are local bare git repos, push detection is a 100ms rev-parse poll,
// exported-interface hashing is a small regex extractor (NOT the real
// tree-sitter hasher), checks run the fixture's self-exported run() in-process
// under --experimental-strip-types, and retirement is a `-X theirs` merge into
// the trunk clone (the real retirer fast-forwards). Good enough to test squash
// handling, generation changes and the re-clone path.
// ---------------------------------------------------------------------------

interface InternalEntry extends Entry {
  tokenPending: boolean;
  forkN: number;
  /** Consumed symbols pinned to the producer's declared stub (value
   * prediction); released on the producer's first push. */
  predConsumed?: Set<string>;
}

export interface MockInternals {
  checks: CheckResult[];
  squashes: Array<{ entryId: string; generation: number; reason: string }>;
}

export interface MockServer {
  port: number;
  url: string;
  rootDir: string;
  internals: MockInternals;
  close: () => Promise<void>;
}

const normalize = (s: string) => s.replace(/\s+/g, " ").trim();
const hashSig = (s: string) => createHash("sha256").update(s).digest("hex").slice(0, 12);

// Naive exported-declaration extractor. Handles the fixture's declaration
// shapes only; normalization collapses whitespace and drops function bodies so
// body-only refactors keep their hash (early cutoff).
export function extractSignatures(src: string): Map<string, string> {
  const out = new Map<string, string>();
  for (const m of src.matchAll(/export\s+(?:async\s+)?function\s+(\w+)\s*\(([^)]*)\)\s*(?::\s*([^\n{]+?))?\s*\{/g)) {
    out.set(m[1], normalize(`function ${m[1]}(${m[2]})${m[3] ? `: ${m[3].trim()}` : ""}`));
  }
  for (const m of src.matchAll(/export\s+interface\s+(\w+)\s*\{([^}]*)\}/g)) {
    out.set(m[1], normalize(`interface ${m[1]} {${m[2]}}`));
  }
  for (const m of src.matchAll(/export\s+type\s+(\w+)\s*=\s*([^;]+);?/g)) {
    out.set(m[1], normalize(`type ${m[1]} = ${m[2]}`));
  }
  for (const m of src.matchAll(/export\s+const\s+(\w+)\s*:\s*([^=]+)=/g)) {
    out.set(m[1], normalize(`const ${m[1]}: ${m[2]}`));
  }
  return out;
}

export async function startMockServer(
  opts: { rootDir?: string; port?: number; pollMs?: number; log?: (m: string) => void } = {},
): Promise<MockServer> {
  const rootDir = path.resolve(opts.rootDir ?? path.join(process.cwd(), "tmp", `mock-${Date.now()}`));
  const reposDir = path.join(rootDir, "repos");
  const workDir = path.join(rootDir, "work");
  fs.mkdirSync(reposDir, { recursive: true });
  fs.mkdirSync(workDir, { recursive: true });
  const log = opts.log ?? (() => {});
  const pollMs = opts.pollMs ?? 100;

  const entries: InternalEntry[] = [];
  const heads = new Map<string, string | null>();
  const sigsByEntry = new Map<string, Map<string, string>>();
  const consumeSigs = new Map<string, Map<string, string>>();
  const internals: MockInternals = { checks: [], squashes: [] };
  let seq = 0;
  let robSize = 8;
  const trunk = { repo: "arb-trunk", commit: null as string | null, retiredCount: 0 };
  const stats = { squashes: 0, earlyCutoffs: 0, retired: 0, checksRun: 0, pushesSeen: 0, predictionHits: 0, predictionMisses: 0 };

  // Single-flight mutation queue: all state changes (push detection, squashes,
  // ready/check transitions, retirement) serialize through it so concurrent
  // HTTP handlers and the poll tick cannot double-apply transitions.
  let tail: Promise<unknown> = Promise.resolve();
  const enqueue = <T>(fn: () => Promise<T>): Promise<T> => {
    const p = tail.then(fn);
    tail = p.catch(() => {});
    return p;
  };

  const repoPath = (name: string) => path.join(reposDir, `${name}.git`);
  const remoteFor = (name: string) => pathToFileURL(repoPath(name)).href;
  const trunkPath = () => repoPath("arb-trunk");
  const revHead = async (p: string): Promise<string | null> => {
    try {
      return (await git(["-C", p, "rev-parse", "refs/heads/main"])) || null;
    } catch {
      return null;
    }
  };
  const terminal = (e: Entry) => e.status === "retired" || e.status === "vetoed";
  const pub = (e: InternalEntry): Entry => {
    const { tokenPending, forkN, predConsumed, ...rest } = e;
    return rest;
  };

  async function exportsAtCommit(repo: string, sha: string): Promise<{ hashes: SymbolHashes; sigs: Map<string, string> }> {
    const sigs = new Map<string, string>();
    const hashes: SymbolHashes = {};
    const listing = await git(["-C", repo, "ls-tree", "-r", "--name-only", sha]);
    for (const f of listing.split("\n").filter((f) => f.endsWith(".ts"))) {
      const content = await git(["-C", repo, "show", `${sha}:${f}`]);
      for (const [name, sig] of extractSignatures(content)) {
        sigs.set(name, sig);
        hashes[name] = hashSig(sig);
      }
    }
    return { hashes, sigs };
  }

  async function squashEntry(
    c: InternalEntry,
    srcRepoPath: string,
    srcHead: string | null,
    reason: Diagnosis["reason"],
    changed: Diagnosis["changed"],
  ): Promise<void> {
    c.forkN++;
    const name = `arb-e${c.seq}-${c.lane}-${c.forkN}`;
    await git(["clone", "--bare", "--quiet", srcRepoPath, repoPath(name)]);
    heads.set(name, srcHead);
    const exp = srcHead ? await exportsAtCommit(srcRepoPath, srcHead) : { hashes: {}, sigs: new Map<string, string>() };
    c.repo = name;
    c.remote = remoteFor(name);
    c.generation++;
    c.status = "squashed";
    c.baseCommit = srcHead ?? "";
    c.headCommit = srcHead;
    c.checks = null;
    c.diagnosis = { reason, changed, producerCommit: srcHead ?? "" };
    c.tokenPending = true;
    c.exports = exp.hashes;
    sigsByEntry.set(c.id, exp.sigs);
    const cs = consumeSigs.get(c.id) ?? new Map<string, string>();
    for (const sym of Object.keys(c.consumes)) {
      c.consumes[sym] = exp.hashes[sym] ?? "missing";
      cs.set(sym, exp.sigs.get(sym) ?? "");
    }
    consumeSigs.set(c.id, cs);
    stats.squashes++;
    internals.squashes.push({ entryId: c.id, generation: c.generation, reason });
    log(`squash ${c.id} -> gen ${c.generation} (${reason})`);
  }

  function diffConsumes(c: InternalEntry, hashes: SymbolHashes, sigs: Map<string, string>): Diagnosis["changed"] {
    const cs = consumeSigs.get(c.id) ?? new Map<string, string>();
    const changed: Diagnosis["changed"] = [];
    for (const sym of Object.keys(c.consumes)) {
      const newHash = hashes[sym] ?? "missing";
      if (newHash !== c.consumes[sym]) {
        changed.push({
          symbol: sym,
          oldHash: c.consumes[sym],
          newHash,
          oldSignature: cs.get(sym) ?? "",
          newSignature: sigs.get(sym) ?? "",
        });
      }
    }
    return changed;
  }

  async function onPush(e: InternalEntry, sha: string): Promise<void> {
    heads.set(e.repo, sha);
    e.headCommit = sha;
    e.checks = null;
    e.diagnosis = null;
    if (!terminal(e)) e.status = "speculating";
    stats.pushesSeen++;
    const prevHashes = e.exports;
    // A push with real hashes resolves this entry's declared-stub predictions
    // exactly once: each pinned consumer symbol gets a hit/miss verdict.
    const wasPredicted = new Set(e.predicted ?? []);
    e.predicted = [];
    const { hashes, sigs } = await exportsAtCommit(repoPath(e.repo), sha);
    e.exports = hashes;
    sigsByEntry.set(e.id, sigs);
    let hadConsumers = false;
    let squashedAny = false;
    for (const c of entries) {
      if (c.producerId !== e.id || terminal(c)) continue;
      hadConsumers = true;
      const changed = diffConsumes(c, hashes, sigs);
      const pinned = [...(c.predConsumed ?? [])].filter((s) => wasPredicted.has(s));
      if (pinned.length) {
        const missed: Diagnosis["changed"] = [];
        for (const sym of pinned) {
          const actual = hashes[sym] ?? "missing";
          if (c.consumes[sym] === actual) {
            stats.predictionHits++;
            log(`prediction hit ${c.id} ${sym}`);
          } else {
            stats.predictionMisses++;
            missed.push({
              symbol: sym,
              oldHash: c.consumes[sym],
              newHash: actual,
              oldSignature: (consumeSigs.get(c.id) ?? new Map<string, string>()).get(sym) ?? "",
              newSignature: sigs.get(sym) ?? "",
            });
            log(`prediction miss ${c.id} ${sym}`);
          }
        }
        c.predConsumed = new Set();
        if (missed.length) {
          await squashEntry(c, repoPath(e.repo), sha, "prediction-miss", missed.concat(changed.filter((d) => !pinned.includes(d.symbol))));
          squashedAny = true;
          continue;
        }
        if (changed.length === 0) continue; // pure hit: not a cutoff
      }
      if (changed.length > 0) {
        await squashEntry(c, repoPath(e.repo), sha, "interface-changed", changed);
        squashedAny = true;
      }
    }
    const exportsUnchanged = Object.keys(hashes).length === Object.keys(prevHashes).length
      && Object.keys(hashes).every((k) => prevHashes[k] === hashes[k]);
    if (!squashedAny && (exportsUnchanged || hadConsumers)) {
      stats.earlyCutoffs++;
      log(`early cutoff on ${e.id} push ${sha.slice(0, 8)}`);
    }
  }

  async function refreshHead(e: InternalEntry): Promise<void> {
    const sha = await revHead(repoPath(e.repo));
    if (sha && sha !== heads.get(e.repo)) await onPush(e, sha);
    else if (!sha && !heads.has(e.repo)) heads.set(e.repo, null);
  }

  async function runChecks(repo: string, commit: string): Promise<CheckResult> {
    const t0 = Date.now();
    const dir = fs.mkdtempSync(path.join(workDir, "check-"));
    await git(["clone", "--quiet", repo, dir]);
    await git(["-C", dir, "checkout", "--quiet", commit]);
    const testsDir = path.join(dir, "tests");
    const files: string[] = [];
    const walk = (d: string) => {
      for (const ent of fs.readdirSync(d, { withFileTypes: true })) {
        const p = path.join(d, ent.name);
        if (ent.isDirectory()) walk(p);
        else if (ent.name.endsWith(".test.ts")) files.push(p);
      }
    };
    if (fs.existsSync(testsDir)) walk(testsDir);
    const results: CheckResult["results"] = [];
    for (const f of files.sort()) {
      const rel = path.relative(dir, f).replaceAll("\\", "/");
      try {
        const mod = await import(pathToFileURL(f).href);
        const out = await mod.run();
        for (const r of out) results.push({ name: `${rel}: ${r.name}`, ok: !!r.ok, error: r.error });
      } catch (err) {
        results.push({ name: rel, ok: false, error: String((err as Error).message ?? err) });
      }
    }
    return {
      commit,
      passed: results.filter((r) => r.ok).length,
      failed: results.filter((r) => !r.ok).length,
      durationMs: Date.now() - t0,
      results,
    };
  }

  async function retire(e: InternalEntry): Promise<void> {
    // Mock retirement: merge the entry head into a trunk work clone with
    // `-X theirs` so disjoint changes (ui feature vs tests files) union into
    // the final tree, then push back to the bare trunk.
    const w = fs.mkdtempSync(path.join(workDir, "retire-"));
    await git(["clone", "--quiet", trunkPath(), w]);
    await git(["-C", w, "fetch", "--quiet", repoPath(e.repo), "main"]);
    await git([
      "-C", w,
      "-c", "user.email=arb-mock@local",
      "-c", "user.name=arb-mock",
      "merge", "--no-ff", "-X", "theirs", "-m", `retire ${e.id} (${e.lane})`, "FETCH_HEAD",
    ]);
    await git(["-C", w, "push", "--quiet", "origin", "HEAD:main"]);
    const newCommit = await git(["-C", w, "rev-parse", "HEAD"]);
    trunk.commit = newCommit;
    trunk.retiredCount++;
    stats.retired++;
    e.status = "retired";
    log(`retired ${e.id} seq=${e.seq} -> trunk ${newCommit.slice(0, 8)}`);
  }

  async function tryRetire(): Promise<void> {
    trunk.commit = await revHead(trunkPath());
    for (const e of entries) {
      if (terminal(e)) continue;
      if (e.status !== "ready" || !e.headCommit) break;
      const prod = e.producerId ? entries.find((p) => p.id === e.producerId) : null;
      if (prod && prod.status !== "retired") break;
      await retire(e);
    }
  }

  async function createEntry(body: {
    agent: string;
    lane: string;
    producerId?: string;
    consumes?: string[];
    stub?: Record<string, string>;
  }): Promise<{ entry: Entry; token: string }> {
    const producer = body.producerId ? entries.find((p) => p.id === body.producerId) : null;
    if (body.producerId && !producer) throw httpError(400, `unknown producerId ${body.producerId}`);
    const open = entries.filter((e) => !terminal(e)).length;
    if (open >= robSize) throw httpError(409, `reorder buffer full (robSize=${robSize})`);
    const mySeq = ++seq;
    const srcPath = producer ? repoPath(producer.repo) : trunkPath();
    const srcHead = await revHead(srcPath);
    const name = `arb-e${mySeq}-${body.lane}-0`;
    if (!fs.existsSync(srcPath)) throw httpError(400, "fork source repo does not exist (init trunk first)");
    await git(["clone", "--bare", "--quiet", srcPath, repoPath(name)]);
    heads.set(name, srcHead);
    const exp = srcHead ? await exportsAtCommit(srcPath, srcHead) : { hashes: {} as SymbolHashes, sigs: new Map<string, string>() };
    // Declared stub (value prediction): hash the declared sources with the
    // mock's regex extractor; predicted symbols keep the stub hash over the
    // fork's base content until the entry's first real push resolves them.
    const stubSigs = new Map<string, string>();
    const stubHashes: SymbolHashes = {};
    for (const src of Object.values(body.stub ?? {})) {
      for (const [name, sig] of extractSignatures(src)) {
        stubSigs.set(name, sig);
        stubHashes[name] = hashSig(sig);
      }
    }
    const predicted = Object.keys(stubHashes);
    const consumes: SymbolHashes = {};
    const cs = new Map<string, string>();
    const predConsumed = new Set<string>();
    const prodSigs = producer ? (sigsByEntry.get(producer.id) ?? new Map<string, string>()) : new Map<string, string>();
    for (const sym of body.consumes ?? []) {
      if (producer && producer.predicted.includes(sym)) {
        // Forward against the producer's DECLARED hash, not the fork base.
        consumes[sym] = producer.exports[sym] ?? "missing";
        predConsumed.add(sym);
      } else {
        consumes[sym] = producer ? (producer.exports[sym] ?? "missing") : (exp.hashes[sym] ?? "missing");
      }
      cs.set(sym, producer ? (prodSigs.get(sym) ?? "") : (exp.sigs.get(sym) ?? ""));
    }
    const e: InternalEntry = {
      id: `e${mySeq}`,
      seq: mySeq,
      agent: body.agent,
      lane: body.lane,
      status: "speculating",
      repo: name,
      remote: remoteFor(name),
      producerId: body.producerId ?? null,
      baseCommit: srcHead ?? "",
      headCommit: srcHead,
      exports: { ...exp.hashes, ...stubHashes },
      consumes,
      predicted,
      generation: 0,
      diagnosis: null,
      checks: null,
      tokenPending: false,
      forkN: 0,
      predConsumed,
    };
    entries.push(e);
    sigsByEntry.set(e.id, new Map([...exp.sigs, ...stubSigs]));
    consumeSigs.set(e.id, cs);
    log(`created ${e.id} (${e.lane}) repo=${name} base=${(srcHead ?? "none").slice(0, 8)}`);
    return { entry: pub(e), token: `mock-token-${e.id}-g0` };
  }

  async function veto(id: string): Promise<{ entry: Entry; squashed: string[] }> {
    const e = entries.find((x) => x.id === id);
    if (!e) throw httpError(404, `unknown entry ${id}`);
    const open = entries.filter((x) => !terminal(x));
    const headEntry = open[open.length - 1];
    if (!headEntry || headEntry.id !== id) throw httpError(409, "veto applies to the head entry only");
    e.status = "vetoed";
    const squashed: string[] = [];
    const queue = entries.filter((x) => x.producerId === id && !terminal(x));
    const seen = new Set(queue.map((x) => x.id));
    while (queue.length) {
      const d = queue.shift()!;
      const prod = entries.find((p) => p.id === d.producerId)!;
      // Direct dependents of the vetoed entry re-base onto the vetoed entry's
      // producer (or trunk); deeper dependents re-base onto their producer's
      // fresh fork, which was already rebuilt in this BFS.
      const baseRepo = prod.id === id ? (prod.producerId ? repoPath(entries.find((p) => p.id === prod.producerId)!.repo) : trunkPath()) : repoPath(prod.repo);
      const baseHead = await revHead(baseRepo);
      const exp = baseHead ? await exportsAtCommit(baseRepo, baseHead) : { hashes: {}, sigs: new Map<string, string>() };
      const changed = diffConsumes(d, exp.hashes, exp.sigs);
      await squashEntry(d, baseRepo, baseHead, "producer-vetoed", changed);
      squashed.push(d.id);
      for (const g of entries.filter((x) => x.producerId === d.id && !terminal(x) && !seen.has(x.id))) {
        seen.add(g.id);
        queue.push(g);
      }
    }
    return { entry: pub(e), squashed };
  }

  async function reset(): Promise<void> {
    entries.length = 0;
    seq = 0;
    stats.squashes = 0;
    stats.earlyCutoffs = 0;
    stats.retired = 0;
    stats.checksRun = 0;
    stats.pushesSeen = 0;
    stats.predictionHits = 0;
    stats.predictionMisses = 0;
    sigsByEntry.clear();
    consumeSigs.clear();
    heads.clear();
    // Mock-only deviation: entry fork repos are disposable local dirs, so they
    // are removed to keep names reusable; the real contract keeps remote repos.
    for (const f of fs.readdirSync(reposDir)) {
      if (f !== "arb-trunk.git") fs.rmSync(path.join(reposDir, f), { recursive: true, force: true });
    }
    trunk.commit = await revHead(trunkPath());
    trunk.retiredCount = 0;
  }

  function stateResponse(): BufferState {
    return {
      trunk: { ...trunk },
      robSize,
      entries: entries.map(pub).sort((a, b) => a.seq - b.seq),
      stats: { ...stats },
    };
  }

  class HttpError extends Error {
    status: number;
    constructor(status: number, message: string) {
      super(message);
      this.status = status;
    }
  }
  const httpError = (status: number, message: string) => new HttpError(status, message);

  const server = http.createServer(async (req, res) => {
    const send = (status: number, body: unknown) => {
      res.writeHead(status, { "content-type": "application/json" });
      res.end(JSON.stringify(body));
    };
    try {
      const url = new URL(req.url ?? "/", "http://mock");
      const body =
        req.method === "POST"
          ? JSON.parse((await readBody(req)) || "{}")
          : {};
      const p = url.pathname;

      if (p === "/api/health") return send(200, { ok: true });
      if (p === "/api/reset" && req.method === "POST") {
        await enqueue(reset);
        return send(200, { ok: true });
      }
      if (p === "/api/trunk/init" && req.method === "POST") {
        if (!fs.existsSync(trunkPath())) await git(["init", "--bare", "--quiet", "-b", "main", trunkPath()]);
        trunk.commit = await revHead(trunkPath());
        return send(200, { repo: "arb-trunk", remote: remoteFor("arb-trunk"), token: "mock-token-trunk" });
      }
      if (p === "/api/entries" && req.method === "POST") {
        return send(200, await enqueue(() => createEntry(body)));
      }
      const mEntry = p.match(/^\/api\/entries\/([^/]+)$/);
      if (mEntry && req.method === "GET") {
        const e = entries.find((x) => x.id === mEntry[1]);
        if (!e) return send(404, { error: `unknown entry ${mEntry[1]}` });
        const out: { entry: Entry; token?: string } = { entry: pub(e) };
        if (e.tokenPending) {
          e.tokenPending = false;
          out.token = `mock-token-${e.id}-g${e.generation}`;
        }
        return send(200, out);
      }
      const mReady = p.match(/^\/api\/entries\/([^/]+)\/ready$/);
      if (mReady && req.method === "POST") {
        const e = entries.find((x) => x.id === mReady[1]);
        if (!e) return send(404, { error: `unknown entry ${mReady[1]}` });
        return send(200, {
          entry: await enqueue(async () => {
            await refreshHead(e);
            if (e.headCommit !== body.commit) {
              throw httpError(409, `stale commit: head is ${e.headCommit ?? "none"}`);
            }
            e.status = "checking";
            stats.checksRun++;
            const result = await runChecks(repoPath(e.repo), body.commit);
            e.checks = result;
            internals.checks.push(result);
            e.status = result.failed === 0 ? "ready" : "failed";
            await tryRetire();
            return pub(e);
          }),
        });
      }
      const mVeto = p.match(/^\/api\/entries\/([^/]+)\/veto$/);
      if (mVeto && req.method === "POST") {
        return send(200, await enqueue(() => veto(mVeto[1])));
      }
      if (p === "/api/config" && req.method === "POST") {
        if (typeof body.robSize !== "number" || body.robSize < 1) return send(400, { error: "robSize must be >= 1" });
        await enqueue(async () => {
          robSize = body.robSize;
        });
        return send(200, { robSize });
      }
      if (p === "/api/state" && req.method === "GET") {
        return send(200, stateResponse());
      }
      if (p === "/api/ws") {
        return send(501, { error: "mock: websocket events not implemented" });
      }
      return send(404, { error: `no route ${req.method} ${p}` });
    } catch (err) {
      const status = err instanceof HttpError ? err.status : 500;
      send(status, { error: String((err as Error).message ?? err) });
    }
  });

  let busy = false;
  const timer = setInterval(() => {
    if (busy) return;
    busy = true;
    enqueue(async () => {
      for (const e of entries) {
        if (terminal(e)) continue;
        await refreshHead(e);
      }
      await tryRetire();
    })
      .catch((err) => log(`tick error: ${(err as Error).message}`))
      .finally(() => {
        busy = false;
      });
  }, pollMs);
  timer.unref();

  await new Promise<void>((r) => server.listen(opts.port ?? 0, "127.0.0.1", r));
  const port = (server.address() as { port: number }).port;
  return {
    port,
    url: `http://127.0.0.1:${port}`,
    rootDir,
    internals,
    close: () =>
      new Promise<void>((r) => {
        clearInterval(timer);
        server.close(() => r());
      }),
  };
}

function readBody(req: http.IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    let data = "";
    req.on("data", (c) => (data += c));
    req.on("end", () => resolve(data));
    req.on("error", reject);
  });
}

const isMain = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isMain) {
  const arg = (n: string) => {
    const i = process.argv.indexOf(`--${n}`);
    return i >= 0 ? process.argv[i + 1] : undefined;
  };
  const mock = await startMockServer({
    port: Number(arg("port") ?? 8787),
    rootDir: arg("root"),
    log: (m) => console.log(`[mock] ${m}`),
  });
  console.log(`mock control plane: ${mock.url} (repos under ${mock.rootDir})`);
}
