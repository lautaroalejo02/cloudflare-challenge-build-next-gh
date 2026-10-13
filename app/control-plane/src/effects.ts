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
import type { ArbEvent, CheckResult, Cmd, Effect, RobState, SymbolHashes, SymbolSignatures } from "./rob.ts";
import type { ArtifactsPort, CreatedRepo, Ports } from "./ports.ts";

/** Write-token lifetime minted for agents. */
export const TOKEN_TTL_S = 3600;
/** A minted token is handed out again for this long (it stays valid for at
 * least TOKEN_TTL_S - TOKEN_REUSE_MS afterwards). */
export const TOKEN_REUSE_MS = 30 * 60_000;

export function interfaceToMaps(ih: InterfaceHash): { exports: SymbolHashes; sigs: SymbolSignatures } {
	return {
		exports: Object.fromEntries(ih.symbols.map((s) => [s.name, s.hash])),
		sigs: Object.fromEntries(ih.symbols.map((s) => [s.name, s.signature])),
	};
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
			const reason = errorText(e);
			if (eff.type === "fork") {
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
			const { exports, sigs } = interfaceToMaps(await ports.hasher.hashInterface(files));
			host.registerRepo(created.name);
			follow({
				type: "fork.done",
				entryId: eff.entryId,
				repo: created.name,
				remote: created.remote,
				baseCommit: head,
				exports,
				sigs,
				planned: eff.toRepo,
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
	if (!entry || entry.headCommit === commit) return null;
	const retry = { sleep: host.sleep };
	const files = await withRetry(() => host.ports.artifacts.readTree(repo, commit), retry);
	const { exports, sigs } = interfaceToMaps(await host.ports.hasher.hashInterface(files));
	const head = (await withRetry(() => host.ports.artifacts.log(repo, 1), retry))[0]?.hash;
	if (head && head !== commit) return null;
	return { type: "push", repo, commit, exports, sigs };
}
