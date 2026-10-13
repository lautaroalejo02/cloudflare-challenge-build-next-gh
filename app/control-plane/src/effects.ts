// Effect runtime for the ReorderBuffer DO (T19): executes the effects the
// pure machine (src/rob.ts) returns, through injected ports. Extracted from
// src/do.ts so the failure handling is unit-testable without a Workers
// runtime (test/effects.test.ts).
//
// Invariants (review F3): every effect runs in its own try/catch, so one
// throw never aborts the rest of the queue; failures become machine commands
// (`fork.failed`, `retire.failed`, `effect.failed`, infra `check.done`) that
// emit visible `recover`/`retire.failed`/`check.failed` events, and the alarm
// sweep re-issues whatever is still pending.

import type { InterfaceHash } from "../../hasher/src/index.ts";
import { errorText, withRetry } from "../../checker/src/retry.ts";
import type { ArbEvent, CheckResult, Cmd, Effect, JudgeVerdict, RobState, SigField, SymbolHashes } from "./rob.ts";
import type { ArtifactsPort, CreatedRepo, Ports, SourceInput, SourceRecord } from "./ports.ts";
import type { JudgeInput, JudgeSymbolInput } from "./jev.ts";

/** Write-token lifetime minted for agents. */
export const TOKEN_TTL_S = 3600;
/** A minted token is handed out again for this long (it stays valid for at
 * least TOKEN_TTL_S - TOKEN_REUSE_MS afterwards). */
export const TOKEN_REUSE_MS = 30 * 60_000;
/** (V2) Usage files sent to Jev are truncated to this many chars (contract). */
const JEV_USAGE_LIMIT = 6000;

/** (V2) The hasher's additive SymbolSignature fields (file/bodyHash/source)
 * arrive with its V1; read them defensively so a v1 hasher still works. */
interface V2Symbol {
	file?: string;
	bodyHash?: string;
	source?: string;
}

export function interfaceToMaps(ih: InterfaceHash): {
	exports: SymbolHashes;
	sigs: SigField;
	bodies: SymbolHashes;
	sources: Record<string, SourceInput>;
} {
	const exports: SymbolHashes = Object.create(null);
	const sigs: SigField = Object.create(null);
	const bodies: SymbolHashes = Object.create(null);
	const sources: Record<string, SourceInput> = Object.create(null);
	for (const s of ih.symbols) {
		const v2 = s as typeof s & V2Symbol;
		const previous = Object.hasOwn(sigs, s.name) ? sigs[s.name] : undefined;
		const previousFiles = typeof previous === "object" ? previous.files ?? (previous.file ? [previous.file] : []) : [];
		const files = [...new Set([...previousFiles, ...(v2.file ? [v2.file] : [])])];
		exports[s.name] = s.hash;
		sigs[s.name] = v2.file ? { signature: s.signature, file: v2.file, ...(files.length > 1 ? { files } : {}) } : s.signature;
		if (v2.bodyHash) bodies[s.name] = v2.bodyHash;
		if (v2.source) sources[s.name] = { file: v2.file ?? "", ...(files.length > 1 ? { files } : {}), bodyHash: v2.bodyHash ?? "", source: v2.source };
	}
	return { exports: { ...exports }, sigs: { ...sigs }, bodies: { ...bodies }, sources: { ...sources } };
}

export interface TokenCache {
	get(repo: string): Promise<string>;
}

/** Per-repo write-token cache (review F8): every caller gets a token — the
 * old one-shot hand-out gave the re-fork token to whoever asked first. Tokens
 * are reused for `reuseMs` so a 1 s agent poll does not mint one per call. */
export function tokenCache(
	mint: (repo: string) => Promise<string>,
	now: () => number = Date.now,
	reuseMs: number = TOKEN_REUSE_MS,
): TokenCache {
	const cache = new Map<string, { token: string; at: number }>();
	return {
		async get(repo) {
			const hit = cache.get(repo);
			if (hit && now() - hit.at < reuseMs) return hit.token;
			const token = await mint(repo);
			cache.set(repo, { token, at: now() });
			return token;
		},
	};
}

export interface EffectHost {
	ports: Ports;
	/** Current machine state (read-only use: aliases, dedupe, entries). */
	state(): RobState;
	apply(cmd: Cmd): { ok: true; effects: Effect[] } | { ok: false; status: number; error: string };
	broadcast(ev: ArbEvent): void;
	registerRepo(repo: string): void;
	tokens: TokenCache;
	/** Backoff sleep for transient-failure retries (tests inject a no-op). */
	sleep?: (ms: number) => Promise<void>;
}

export interface EffectResults {
	tokens: Record<string, string>;
}

/** Sources are retained only while a live direct consumer owns the symbol. */
export function consumedSymbols(state: RobState, producerId: string): string[] {
	const symbols = new Set<string>();
	for (const e of state.entries) {
		if (e.producerId !== producerId || e.status === "retired" || e.status === "vetoed" || e.status === "squashed") continue;
		for (const s of Object.keys(e.consumes)) symbols.add(s);
	}
	return [...symbols];
}

async function storeSources(host: EffectHost, entryId: string, sources: Record<string, SourceInput>, commit: string): Promise<void> {
	if (!host.ports.sources) return;
	const needed = consumedSymbols(host.state(), entryId);
	const map = Object.fromEntries(needed.filter(s => Object.hasOwn(sources, s)).map(s => [s, { ...sources[s], source: sources[s].source.slice(0, 4000) }]));
	const baselines: SymbolHashes = Object.create(null);
	for (const marks of Object.values(host.state()._internal.judgeMarks)) {
		for (const [s, mark] of Object.entries(marks)) if (mark.producerId === entryId) baselines[s] = mark.oldBody;
	}
	try {
		await host.ports.sources.merge(entryId, map, commit, baselines);
	} catch {
		await reportSourceFailure(host, entryId);
	}
}

async function reportSourceFailure(host: EffectHost, entryId: string): Promise<void> {
	const result = host.apply({ type: "effect.failed", entryId, effect: "source-storage", reason: "source-storage-failed" });
	if (result.ok) await execEffects(host, result.effects);
}

export function isAlreadyExists(e: unknown): boolean {
	const code = (e as { code?: string })?.code;
	const msg = String((e as Error)?.message ?? e);
	return code === "ALREADY_EXISTS" || /ALREADY_EXISTS|already exists/i.test(msg);
}

const randomSuffix = () => Math.random().toString(36).slice(2, 8).padEnd(6, "0");

/** Fork `fromRepo` as `toRepo`. Repos survive /api/reset, so planned names
 * collide with leftovers from earlier runs: on the FIRST collision jump to a
 * random suffix (review F10 — the old deterministic `-x1..-x19` walk burned up
 * to 19 failing forks per entry once those names were taken too). */
export async function forkWithSuffix(
	artifacts: ArtifactsPort,
	fromRepo: string,
	toRepo: string,
	rand: () => string = randomSuffix,
	sleep?: (ms: number) => Promise<void>,
): Promise<CreatedRepo> {
	let name = toRepo;
	for (let attempt = 0; attempt < 8; attempt++) {
		try {
			return await withRetry(() => artifacts.fork(fromRepo, name), { sleep });
		} catch (e) {
			if (!isAlreadyExists(e)) throw e;
			name = `${toRepo}-${rand()}`;
		}
	}
	throw new Error(`fork ${toRepo}: name collisions exhausted`);
}

/** Execute an effect list (and any follow-up effects) through the ports. */
export async function execEffects(
	host: EffectHost,
	initial: Effect[],
	out: EffectResults = { tokens: {} },
): Promise<Effect[]> {
	const all: Effect[] = [];
	const queue = [...initial];
	const follow = (cmd: Cmd) => {
		const r = host.apply(cmd);
		if (r.ok) queue.push(...r.effects);
	};
	while (queue.length) {
		const eff = queue.shift()!;
		all.push(eff);
		try {
			await runEffect(host, eff, out, follow);
		} catch (e) {
			const reason = eff.type === "source.delete" || eff.type === "source.prune" ? "source-storage-failed" : errorText(e);
			if (eff.type === "judge") {
				// (V2) A judge failure is an unavailable judgment, never a wedge:
				// the machine clears the marks and treats them as `clear`.
				follow({
					type: "judge.done",
					consumerId: eff.consumerId,
					producerId: eff.producerId,
					commit: eff.commit,
					generation: eff.generation,
					verdicts: eff.symbols.map((symbol) => ({ symbol, probability: null, reason })),
				});
			} else if (eff.type === "fork") {
				follow({ type: "fork.failed", entryId: eff.entryId, planned: eff.toRepo, reason });
			} else if (eff.type === "retire") {
				follow({ type: "retire.failed", entryId: eff.entryId, reason });
			} else if (eff.type === "broadcast") {
				console.error("broadcast failed", reason); // cannot narrate a failed narration
			} else {
				follow({ type: "effect.failed", entryId: eff.entryId, effect: eff.type, reason });
			}
		}
	}
	return all;
}

async function runEffect(host: EffectHost, eff: Effect, out: EffectResults, follow: (cmd: Cmd) => void): Promise<void> {
	const { ports } = host;
	switch (eff.type) {
		case "broadcast":
			host.broadcast(eff.event);
			return;
		case "source.delete":
			await ports.sources?.delete?.(eff.entryId);
			return;
		case "source.prune":
			await ports.sources?.retain?.(eff.entryId, consumedSymbols(host.state(), eff.entryId));
			return;
		case "token":
			out.tokens[eff.entryId] = await host.tokens.get(eff.repo);
			return;
		case "fork": {
			// A transitive refork may target a planned name that later got a
			// suffix; resolve to the actual repo.
			const fromRepo = host.state()._internal.repoAlias?.[eff.fromRepo] ?? eff.fromRepo;
			const created = await forkWithSuffix(ports.artifacts, fromRepo, eff.toRepo, undefined, host.sleep);
			const retry = { sleep: host.sleep };
			const head = (await withRetry(() => ports.artifacts.log(created.name, 1), retry))[0]?.hash ?? "";
			const files = head ? await withRetry(() => ports.artifacts.readTree(created.name, head), retry) : {};
			const { exports, sigs, bodies, sources } = interfaceToMaps(await ports.hasher.hashInterface(files));
			host.registerRepo(created.name);
			// (V2) Store the forked declarations as Jev `before`/`after` inputs;
			// storage failures degrade to unavailable judgments, never a wedge.
			await storeSources(host, eff.entryId, sources, head);
			follow({
				type: "fork.done",
				entryId: eff.entryId,
				repo: created.name,
				remote: created.remote,
				baseCommit: head,
				exports,
				sigs,
				bodies,
				planned: eff.toRepo,
			});
			// A producer had no retained sources before its first consumer existed.
			// Seed from the adopted fork only when it captured the current head;
			// never replace a newer producer declaration with stale fork content.
			const entry = host.state().entries.find(e => e.id === eff.entryId);
			const producer = entry?.producerId ? host.state().entries.find(e => e.id === entry.producerId) : undefined;
			if (entry?.repo === created.name && producer?.headCommit === head && producer.status !== "retired" && producer.status !== "vetoed") {
				await storeSources(host, producer.id, sources, head);
			}
			return;
		}
		case "judge": {
			const verdicts = await runJudge(host, eff);
			follow({
				type: "judge.done",
				consumerId: eff.consumerId,
				producerId: eff.producerId,
				commit: eff.commit,
				generation: eff.generation,
				verdicts,
			});
			return;
		}
		case "check": {
			// The checker reports platform failures as `infra` results; a throw
			// here is the platform too — never a verdict on the code (F2).
			let result: CheckResult;
			try {
				result = await ports.checker.runChecks(eff.repo, eff.commit);
			} catch (e) {
				result = {
					commit: eff.commit,
					passed: 0,
					failed: 1,
					durationMs: 0,
					results: [{ name: "checker", ok: false, error: errorText(e) }],
					infra: true,
				};
			}
			follow({ type: "check.done", entryId: eff.entryId, result });
			return;
		}
		case "retire": {
			// T17: ArbTrunk runs the whole cycle (head -> splice -> check ->
			// move) inside one serialized slot with bounded rebuilds. The
			// returned `attempts` replay as check/retry events, then the final
			// outcome applies. A throw reaches `retire.failed` via execEffects.
			const res = await ports.retirer.retireAtomic({
				fromRepo: eff.fromRepo,
				commit: eff.commit,
				baseCommit: eff.baseCommit,
				toRepo: eff.toRepo,
				branch: eff.branch,
			});
			for (const a of res.attempts) {
				if (a.candidate && a.check) {
					follow({ type: "retire.checked", entryId: eff.entryId, candidate: a.candidate, result: a.check });
				}
				if (a.reason) follow({ type: "retire.retry", entryId: eff.entryId, attempt: a.attempt, reason: a.reason });
			}
			if (res.outcome === "fast-forward" || res.outcome === "splice") {
				follow({ type: "retire.done", entryId: eff.entryId, commit: res.commit, entryCommit: eff.commit, mode: res.outcome });
			} else if (res.outcome === "overlap") {
				follow({ type: "retire.overlap", entryId: eff.entryId, overlap: res.overlap });
			} else if (res.outcome === "retry-exhausted") {
				follow({ type: "retire.failed", entryId: eff.entryId, reason: errorText(res.reason) });
			}
			// "check-failed": the replayed retire.checked already moved the
			// entry to `failed` and cleared `retiring`.
			return;
		}
	}
}

/** (V2) Execute a judge effect: pair each symbol's stored `before`/`after`
 * declaration sources, collect the consumer files importing the symbols'
 * declaring files (usage), and ask the Jev port. Missing pieces degrade to
 * `probability: null` verdicts — the machine treats them as `clear`. */
async function runJudge(host: EffectHost, eff: Extract<Effect, { type: "judge" }>): Promise<JudgeVerdict[]> {
	const unavailable = (reason: string) => eff.symbols.map(symbol => ({ symbol, probability: null, reason }));
	if (!host.ports.jev) return unavailable("unavailable");
	if (host.ports.jev.available === false) return unavailable("no-key");
	const st = host.state();
	const consumer = st.entries.find((e) => e.id === eff.consumerId);
	if (!consumer?.headCommit || consumer.headCommit === consumer.baseCommit) return unavailable("no-usage");
	let recs: Record<string, SourceRecord> = {};
	try { recs = (await host.ports.sources?.get(eff.producerId)) ?? {}; }
	catch { await reportSourceFailure(host, eff.producerId); }
	const pairs = eff.symbols.map((symbol) => {
		const rec = Object.hasOwn(recs, symbol) ? recs[symbol] : undefined;
		const mark = st._internal.judgeMarks[eff.consumerId]?.[symbol];
		if (mark && rec?.prev?.bodyHash !== mark.oldBody) return null;
		return rec?.prev ? { symbol, files: rec.files ?? [rec.file], before: rec.prev.source, after: rec.source } : null;
	});
	// Usage: files in the consumer's tree (at its pushed head, or its fork
	// base when it never pushed) whose imports reach a judged symbol's file.
	const usageBySymbol = new Map<string, { file: string; code: string }[]>();
	const selected = new Set<string>();
	if (consumer) {
		const commit = consumer.headCommit;
		const files = commit ? await withRetry(() => host.ports.artifacts.readTree(consumer.repo, commit), { sleep: host.sleep }) : {};
		const base = consumer.baseCommit ? await withRetry(() => host.ports.artifacts.readTree(consumer.repo, consumer.baseCommit), { sleep: host.sleep }) : {};
		const imports = (await host.ports.hasher.extractImports?.(files).catch(() => [])) ?? [];
		for (const p of pairs) {
			if (!p) continue;
			const list: { file: string; code: string }[] = [];
			for (const i of imports) {
				if (!p.files.includes(i.from) || (!i.names.includes(p.symbol) && !i.names.includes("*"))) continue;
				if (!Object.hasOwn(files, i.file) || files[i.file] === base[i.file] || list.some(u => u.file === i.file)) continue;
				if (!selected.has(i.file) && selected.size >= 4) continue;
				selected.add(i.file);
				list.push({ file: i.file, code: files[i.file].slice(0, JEV_USAGE_LIMIT) });
			}
			usageBySymbol.set(p.symbol, list);
		}
	}
	const need = pairs.map((p): JudgeSymbolInput | null =>
		p === null ? null : { symbol: p.symbol, before: p.before, after: p.after, usage: usageBySymbol.get(p.symbol) ?? [] },
	);
	const bySymbol = new Map<string, JudgeVerdict>();
	const judgeable = need.filter((x): x is JudgeSymbolInput => x !== null && x.usage.length > 0);
	if (judgeable.length && host.ports.jev) {
		const input: JudgeInput = {
			producer: judgeable,
			consumer: { agent: consumer?.agent ?? "", lane: consumer?.lane ?? "" },
		};
		for (const v of await host.ports.jev.judge(input)) bySymbol.set(v.symbol, v);
	}
	return eff.symbols.map((symbol, i) =>
		pairs[i] === null
			? { symbol, probability: null, reason: "no-base" }
			: !need[i]?.usage.length ? { symbol, probability: null, reason: "no-usage" }
			: (bySymbol.get(symbol) ?? { symbol, probability: null, reason: host.ports.jev ? "missing-answer" : "unavailable" }),
	);
}

/**
 * Build the machine `push` command for a queue/alarm push event, or null when
 * it is a no-op. Entry pushes are hashed here (rob.ts stays pure). Events can
 * arrive out of order (review F9): after the slow hash, re-read the repo head
 * and drop the event if `commit` is no longer it — the newer head arrives via
 * its own event or the alarm poll, so an older commit can never regress head.
 */
export async function pushCommand(host: EffectHost, repo: string, commit: string): Promise<Cmd | null> {
	const st = host.state();
	if (st._internal.seenPushes.includes(`${repo}:${commit}`)) return null;
	if (repo === st.trunk.repo) {
		if (st.trunk.commit === commit) return null;
		return { type: "push", repo, commit };
	}
	const entry = st.entries.find((e) => e.repo === repo || st._internal.pending[e.id] === repo);
	if (!entry || entry.headCommit === commit || entry.status === "retired" || entry.status === "vetoed") return null;
	const retry = { sleep: host.sleep };
	const files = await withRetry(() => host.ports.artifacts.readTree(repo, commit), retry);
	const { exports, sigs, bodies, sources } = interfaceToMaps(await host.ports.hasher.hashInterface(files));
	// (V2) Imports drive dependency inference; an absent/throwing extractor
	// leaves the push import-less (v1 behavior).
	const imports = await host.ports.hasher.extractImports?.(files).catch(() => undefined);
	const head = (await withRetry(() => host.ports.artifacts.log(repo, 1), retry))[0]?.hash;
	if (head && head !== commit) return null;
	// Retirement/veto may land while the asynchronous read/hash runs.
	const current = host.state().entries.find(e => e.id === entry.id);
	if (!current || current.status === "retired" || current.status === "vetoed") return null;
	// (V2) Persist the pushed declarations for Jev `before`/`after`; a
	// storage failure degrades to unavailable judgments, never a lost push.
	await storeSources(host, entry.id, sources, commit);
	return { type: "push", repo, commit, exports, sigs, bodies, imports };
}
