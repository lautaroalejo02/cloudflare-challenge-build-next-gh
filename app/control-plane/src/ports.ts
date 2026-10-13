// Ports: the boundary between the pure state machine (src/rob.ts) and the
// platform. The Durable Object executes machine effects through these
// interfaces. Hasher, checker and retirer are the real implementations
// (T8): app/hasher, app/checker and src/retire.ts.

import type { CheckResult, SymbolHashes, SymbolSignatures } from "./rob.ts";
import { hashInterface, type InterfaceHash } from "../../hasher/src/index.ts";
import { runChecks, type CheckerEnv } from "../../checker/src/index.ts";

// --- Artifacts --------------------------------------------------------------

export interface CreatedRepo {
	name: string;
	remote: string;
	defaultBranch?: string;
	token?: unknown;
}

export interface CommitMeta {
	hash: string;
	treeHash?: string;
	message?: string;
	parents?: string[];
}

export interface ArtifactsPort {
	create(name: string, opts?: { setDefaultBranch?: string; description?: string }): Promise<CreatedRepo>;
	getRemote(name: string): Promise<string>;
	fork(fromRepo: string, toRepo: string): Promise<CreatedRepo>;
	token(repo: string, ttlSeconds: number): Promise<string>;
	/** Newest-first commit metadata; empty array if the ref cannot be resolved. */
	log(repo: string, limit: number, ref?: string): Promise<CommitMeta[]>;
	/** All `.ts` files at `commit`: path -> source text. */
	readTree(repo: string, commit: string): Promise<Record<string, string>>;
}

// --- Hasher -----------------------------------------------------------------

export type { InterfaceHash };

export interface HasherPort {
	hashInterface(files: Record<string, string>): Promise<InterfaceHash>;
}

// --- Checker / Retirer -------------------------------------------------------

export interface CheckerPort {
	runChecks(repo: string, commit: string): Promise<CheckResult>;
}

/** Args for one retirement attempt of the head entry. */
export interface RetireArgs {
	/** Artifacts repo holding `commit` (the entry's fork). */
	fromRepo: string;
	/** The entry's head commit — the change to retire. */
	commit: string;
	/** The entry's baseCommit (fork point) — P and Q are diffed against it. */
	baseCommit: string;
	/** Trunk repo (e.g. "arb-trunk"). */
	toRepo: string;
	branch: string;
	/** Scratch ref on `toRepo` for splice candidates (default "arb-candidate"). */
	candidateBranch?: string;
}

export type RetireOutcome =
	/** Trunk head was an ancestor of `commit`; trunk now points at `commit`. */
	| { outcome: "fast-forward"; commit: string; ms: Record<string, number> }
	/** Sibling histories, disjoint paths: candidate commit was built on the
	 * trunk head and pushed to `refs/heads/<candidateBranch>` on `toRepo`.
	 * Run checks on it, then land via `moveBranch`. */
	| { outcome: "splice"; candidate: string; ms: Record<string, number> }
	/** Sibling histories with overlapping paths: squash the entry
	 * (trunk-overlap). `p`/`q` are the sorted changed-path sets. */
	| { outcome: "overlap"; overlap: string[]; p: string[]; q: string[]; ms: Record<string, number> };

export interface RetirerPort {
	retire(args: RetireArgs): Promise<RetireOutcome>;
	/** Fast-forward `toRepo`:`branch` to `commit` (a candidate already on
	 * `toRepo` whose parent is the current branch head). */
	moveBranch(args: { toRepo: string; branch: string; commit: string }): Promise<void>;
}

// --- Atomic retirement (T17) --------------------------------------------------

/** One attempt inside an atomic retire cycle (see src/atomic.ts). */
export interface AtomicAttempt {
	attempt: number;
	/** Splice candidate built this attempt (if it got that far). */
	candidate?: string;
	/** Check the candidate ran (checks always execute on the commit that is
	 * about to become trunk). */
	check?: CheckResult;
	/** Why the attempt did not land (absent on the winning attempt). */
	reason?: string;
}

/** Result of a fully serialized retire cycle inside ArbTrunk: read head ->
 * decide ff/splice -> build candidate -> check it -> move main, rebuilt from
 * the new head on rejection (bounded). `attempts` narrates every try so the
 * component DO can replay check/retry events. */
export type AtomicRetireResult =
	| { outcome: "fast-forward"; commit: string; attempts: AtomicAttempt[]; ms: Record<string, number> }
	| { outcome: "splice"; commit: string; candidate: string; attempts: AtomicAttempt[]; ms: Record<string, number> }
	| { outcome: "overlap"; overlap: string[]; p: string[]; q: string[]; attempts: AtomicAttempt[]; ms: Record<string, number> }
	| { outcome: "check-failed"; candidate: string; attempts: AtomicAttempt[]; ms: Record<string, number> }
	| { outcome: "retry-exhausted"; reason: string; attempts: AtomicAttempt[]; ms: Record<string, number> };

export interface TrunkRetirerPort extends RetirerPort {
	/** ArbTrunk RPC: one serialized atomic retire cycle for `args`. */
	retireAtomic(args: RetireArgs): Promise<AtomicRetireResult>;
}

export interface Ports {
	artifacts: ArtifactsPort;
	hasher: HasherPort;
	checker: CheckerPort;
	retirer: TrunkRetirerPort;
}

// --- Real Artifacts port ------------------------------------------------------

interface ArtifactsBinding {
	create(name: string, opts?: Record<string, unknown>): Promise<CreatedRepo>;
	get(name: string): Promise<ArtifactsRepoHandle>;
}

interface ArtifactsRepoHandle {
	info(): Promise<{ name: string; remote: string; defaultBranch?: string }>;
	createToken(scope?: "read" | "write", ttl?: number): Promise<{ plaintext: string; expiresAt?: string }>;
	fork(name: string, opts?: Record<string, unknown>): Promise<CreatedRepo>;
	log(opts?: { ref?: string; limit?: number; offset?: number }): Promise<CommitMeta[]>;
	readCommit(hash: string): Promise<(CommitMeta & { treeHash?: string }) | null>;
	readTree(hash: string): Promise<Array<Record<string, unknown>> | null>;
	readBlob(hash: string): Promise<Blob | null>;
	readFile(args: { ref: string; path: string }): Promise<Blob | null>;
	[Symbol.dispose]?: () => void;
	dispose?: () => void;
}

async function dispose(repo: ArtifactsRepoHandle | null | undefined): Promise<void> {
	if (!repo) return;
	if (typeof repo[Symbol.dispose] === "function") repo[Symbol.dispose]!();
	else if (typeof repo.dispose === "function") repo.dispose();
}

function isTreeEntry(e: Record<string, unknown>): boolean {
	const t = e.type ?? e.kind;
	if (t === "tree" || t === "directory" || t === "dir") return true;
	const mode = e.mode;
	return typeof mode === "string" && (mode === "40000" || mode === "040000" || mode.startsWith("04"));
}

function entryPath(e: Record<string, unknown>): string | null {
	const p = e.path ?? e.name;
	return typeof p === "string" && p.length > 0 ? p : null;
}

function entryHash(e: Record<string, unknown>): string | null {
	const h = e.hash ?? e.oid ?? e.sha ?? e.id;
	return typeof h === "string" ? h : null;
}

export function realArtifacts(artifacts: ArtifactsBinding): ArtifactsPort {
	return {
		async create(name, opts) {
			return artifacts.create(name, { setDefaultBranch: "main", ...opts });
		},
		async getRemote(name) {
			const repo = await artifacts.get(name);
			try {
				const info = await repo.info();
				return info.remote;
			} finally {
				await dispose(repo);
			}
		},
		async fork(fromRepo, toRepo) {
			const repo = await artifacts.get(fromRepo);
			try {
				return await repo.fork(toRepo, { defaultBranchOnly: true });
			} finally {
				await dispose(repo);
			}
		},
		async token(repoName, ttlSeconds) {
			const repo = await artifacts.get(repoName);
			try {
				const t = await repo.createToken("write", ttlSeconds);
				return t.plaintext;
			} finally {
				await dispose(repo);
			}
		},
		async log(repoName, limit, ref) {
			const repo = await artifacts.get(repoName);
			try {
				return await repo.log({ limit, ...(ref ? { ref } : {}) });
			} finally {
				await dispose(repo);
			}
		},
		async readTree(repoName, commit) {
			const repo = await artifacts.get(repoName);
			try {
				const out: Record<string, string> = {};
				const walk = async (treeHash: string, prefix: string): Promise<void> => {
					const children = await repo.readTree(treeHash);
					if (!children) return;
					for (const child of children) {
						const name = entryPath(child);
						const hash = entryHash(child);
						if (!name) continue;
						const path = prefix ? `${prefix}/${name}` : name;
						if (isTreeEntry(child)) {
							if (hash) await walk(hash, path);
						} else if (path.endsWith(".ts") && hash) {
							const blob = await repo.readBlob(hash);
							if (blob) out[path] = await blob.text();
						}
					}
				};
				const commitMeta = await repo.readCommit(commit);
				const treeHash = commitMeta?.treeHash;
				if (treeHash) await walk(treeHash, "");
				return out;
			} finally {
				await dispose(repo);
			}
		},
	};
}

// Moved to src/effects.ts (T19) so the effect runtime is Node-testable.
export { interfaceToMaps } from "./effects.ts";

// --- Real hasher / checker (T8) ------------------------------------------------
// app/hasher: web-tree-sitter, lazy-init (dynamic-imports its .wasm as
// CompiledWasm modules on first call — see app/hasher/NOTES.md).
// app/checker: runChecks in a Dynamic Worker (needs the LOADER binding).

export function realHasher(): HasherPort {
	return { hashInterface };
}

export function realChecker(env: CheckerEnv): CheckerPort {
	return {
		runChecks: (repo, commit) => runChecks(env, repo, commit),
	};
}
