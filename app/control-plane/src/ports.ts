// Ports: the boundary between the pure state machine (src/rob.ts) and the
// platform. The Durable Object executes machine effects through these
// interfaces so integration (T8) can swap real implementations in without
// touching the machine. Hasher, checker and retirer are stubs for now;
// app/hasher and app/checker get wired in T8.

import type { CheckResult, SymbolHashes, SymbolSignatures } from "./rob.ts";

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

export interface SymbolSignature {
	name: string;
	kind: "function" | "type" | "interface" | "class" | "const";
	signature: string;
	hash: string;
}

export interface InterfaceHash {
	hash: string;
	symbols: SymbolSignature[];
}

export interface HasherPort {
	hashInterface(files: Record<string, string>): Promise<InterfaceHash>;
}

// --- Checker / Retirer -------------------------------------------------------

export interface CheckerPort {
	runChecks(repo: string, commit: string): Promise<CheckResult>;
}

export interface RetirerPort {
	/** Fast-forward `toRepo`:`branch` to incorporate `fromRepo`@`commit`.
	 * Returns the new trunk commit hash. */
	fastForward(args: { fromRepo: string; commit: string; toRepo: string; branch: string }): Promise<{ commit: string }>;
}

export interface Ports {
	artifacts: ArtifactsPort;
	hasher: HasherPort;
	checker: CheckerPort;
	retirer: RetirerPort;
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

// --- Stub hasher (naive regex over `export ...` declaration lines) -------------
// Real exported-interface hashing arrives with app/hasher in T8. This stub
// keeps the same InterfaceHash shape so the swap is interface-only.

const EXPORT_RE =
	/^export\s+(?:default\s+)?(?:async\s+)?(function|class|const|let|var|interface|type|enum)\s+([A-Za-z_$][\w$]*)?([^{;=]*)/gm;

async function sha12(text: string): Promise<string> {
	const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
	return Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, "0"))
		.join("")
		.slice(0, 12);
}

function stubKind(k: string): SymbolSignature["kind"] {
	if (k === "interface" || k === "type" || k === "enum") return k === "enum" ? "type" : k;
	if (k === "class") return "class";
	if (k === "function") return "function";
	return "const";
}

export function stubHasher(): HasherPort {
	return {
		async hashInterface(files) {
			const symbols: SymbolSignature[] = [];
			for (const [path, source] of Object.entries(files).sort(([a], [b]) => a.localeCompare(b))) {
				EXPORT_RE.lastIndex = 0;
				for (const m of source.matchAll(EXPORT_RE)) {
					const name = m[2];
					if (!name) continue; // `export default function ()` etc.
					const signature = `${m[0].trim().replace(/\s+/g, " ")} (from ${path})`;
					symbols.push({ name, kind: stubKind(m[1]), signature, hash: await sha12(signature) });
				}
			}
			symbols.sort((a, b) => a.name.localeCompare(b.name));
			const hash = await sha12(symbols.map((s) => s.hash).join(""));
			return { hash, symbols };
		},
	};
}

export function interfaceToMaps(ih: InterfaceHash): { exports: SymbolHashes; sigs: SymbolSignatures } {
	return {
		exports: Object.fromEntries(ih.symbols.map((s) => [s.name, s.hash])),
		sigs: Object.fromEntries(ih.symbols.map((s) => [s.name, s.signature])),
	};
}

// --- Stubs for T8 -------------------------------------------------------------

export function stubChecker(): CheckerPort {
	return {
		async runChecks(_repo, commit) {
			return {
				commit,
				passed: 1,
				failed: 0,
				durationMs: 0,
				results: [{ name: "stub-check", ok: true }],
			};
		},
	};
}

export function stubRetirer(): RetirerPort {
	// Pretends the trunk fast-forwarded to the entry's head commit. The real
	// isomorphic-git retirer lands in T7/T8; the DO records the returned
	// pointer in trunk.commit via retire.done.
	return {
		async fastForward({ commit }) {
			return { commit };
		},
	};
}
