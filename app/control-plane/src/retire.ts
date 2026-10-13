/**
 * Retirement for the Agent Reorder Buffer (T8), adapted from
 * app/retirer-spike/src/retire.ts:
 *
 * - "fast-forward": the trunk head is an ancestor of the entry head -> push
 *   the entry head onto `toRepo`:`branch`.
 * - "splice": trunk advanced onto a sibling history. If P (paths the entry
 *   changed vs `baseCommit`) is disjoint from Q (paths trunk changed since
 *   `baseCommit`), build a commit on the trunk head — trunk tree with P
 *   overlaid from the entry head — and push it to a candidate ref. The
 *   caller runs checks on the candidate, then lands it via moveBranch().
 * - "overlap": P ∩ Q ≠ ∅ -> the caller squashes the entry (trunk-overlap).
 *
 * isomorphic-git over `fetch` with an in-memory fs. Requires nodejs_compat
 * (isomorphic-git uses Buffer). No server-side merge is ever used.
 */
import * as git from "isomorphic-git";
import http from "isomorphic-git/http/web";
import { buildTree, decideSplice, overlayPaths, type FlatBlob, type TreeNode } from "./splice.ts";
import type { RetirerPort, RetireArgs, RetireOutcome } from "./ports.ts";

// ---------------------------------------------------------------------------
// In-memory fs implementing the isomorphic-git `fs.promises` contract.
// Copied verbatim from app/retirer-spike/src/retire.ts.
// ---------------------------------------------------------------------------

type FsEnt =
	| { type: "file"; data: Uint8Array; mtime: number }
	| { type: "dir"; mtime: number }
	| { type: "symlink"; target: string; mtime: number };

function norm(p: string): string {
	const parts = String(p).split("/").filter((s) => s.length > 0 && s !== ".");
	const out: string[] = [];
	for (const part of parts) {
		if (part === "..") out.pop();
		else out.push(part);
	}
	return "/" + out.join("/");
}

function dirname(p: string): string {
	const n = norm(p);
	if (n === "/") return "/";
	const i = n.lastIndexOf("/");
	return i === 0 ? "/" : n.slice(0, i);
}

function fsError(code: string, op: string, path: string): Error & { code: string } {
	const e = new Error(`${code}: ${op} ${path}`) as Error & { code: string };
	e.code = code;
	return e;
}

interface StatLike {
	isFile(): boolean;
	isDirectory(): boolean;
	isSymbolicLink(): boolean;
	size: number;
	mode: number;
	mtimeMs: number;
	ctimeMs: number;
	mtime: Date;
	ctime: Date;
	ino: number;
	dev: number;
	uid: number;
	gid: number;
}

export class MemFs {
	private ents = new Map<string, FsEnt>();
	public promises = this as unknown as Pick<
		MemFs,
		"readFile" | "writeFile" | "mkdir" | "rmdir" | "unlink" | "stat" | "lstat" | "readdir" | "readlink" | "symlink" | "rm"
	>;

	constructor() {
		this.ents.set("/", { type: "dir", mtime: Date.now() });
	}

	private ent(p: string): FsEnt {
		const e = this.ents.get(norm(p));
		if (!e) throw fsError("ENOENT", "access", p);
		return e;
	}

	private statOf(e: FsEnt): StatLike {
		const size = e.type === "file" ? e.data.byteLength : 0;
		return {
			isFile: () => e.type === "file",
			isDirectory: () => e.type === "dir",
			isSymbolicLink: () => e.type === "symlink",
			size,
			mode: e.type === "file" ? 0o100644 : e.type === "dir" ? 0o40755 : 0o120000,
			mtimeMs: e.mtime,
			ctimeMs: e.mtime,
			mtime: new Date(e.mtime),
			ctime: new Date(e.mtime),
			ino: 1,
			dev: 1,
			uid: 1,
			gid: 1,
		};
	}

	async readFile(p: string, opts?: string | { encoding?: string }): Promise<Uint8Array | string> {
		let e = this.ent(p);
		if (e.type === "symlink") e = this.ent(e.target);
		if (e.type === "dir") throw fsError("EISDIR", "readFile", p);
		if (e.type !== "file") throw fsError("ENOENT", "readFile", p);
		const encoding = typeof opts === "string" ? opts : opts?.encoding;
		if (encoding === "utf8" || encoding === "utf-8") return new TextDecoder().decode(e.data);
		return e.data.slice();
	}

	async writeFile(p: string, data: Uint8Array | string): Promise<void> {
		const n = norm(p);
		const parent = dirname(n);
		if (!this.ents.has(parent)) await this.mkdir(parent, { recursive: true });
		const bytes = typeof data === "string" ? new TextEncoder().encode(data) : new Uint8Array(data);
		this.ents.set(n, { type: "file", data: bytes, mtime: Date.now() });
	}

	async mkdir(p: string, opts?: { recursive?: boolean }): Promise<void> {
		const n = norm(p);
		if (this.ents.has(n)) {
			if (opts?.recursive && this.ent(n).type === "dir") return;
			throw fsError("EEXIST", "mkdir", p);
		}
		const parent = dirname(n);
		if (!this.ents.has(parent)) {
			if (!opts?.recursive) throw fsError("ENOENT", "mkdir", p);
			await this.mkdir(parent, { recursive: true });
		}
		this.ents.set(n, { type: "dir", mtime: Date.now() });
	}

	async rmdir(p: string): Promise<void> {
		const n = norm(p);
		const e = this.ent(n);
		if (e.type !== "dir") throw fsError("ENOTDIR", "rmdir", p);
		for (const key of this.ents.keys()) {
			if (key !== n && key.startsWith(n === "/" ? "/" : n + "/")) {
				throw fsError("ENOTEMPTY", "rmdir", p);
			}
		}
		this.ents.delete(n);
	}

	async unlink(p: string): Promise<void> {
		const n = norm(p);
		const e = this.ent(n);
		if (e.type === "dir") throw fsError("EISDIR", "unlink", p);
		this.ents.delete(n);
	}

	async stat(p: string): Promise<StatLike> {
		let e = this.ent(p);
		if (e.type === "symlink") e = this.ent(e.target);
		return this.statOf(e);
	}

	async lstat(p: string): Promise<StatLike> {
		return this.statOf(this.ent(p));
	}

	async readdir(p: string): Promise<string[]> {
		const n = norm(p);
		const e = this.ent(n);
		if (e.type !== "dir") throw fsError("ENOTDIR", "readdir", p);
		const prefix = n === "/" ? "/" : n + "/";
		const names: string[] = [];
		for (const key of this.ents.keys()) {
			if (key === n || !key.startsWith(prefix)) continue;
			const rest = key.slice(prefix.length);
			if (!rest.includes("/")) names.push(rest);
		}
		return names;
	}

	async readlink(p: string): Promise<string> {
		const e = this.ent(p);
		if (e.type !== "symlink") throw fsError("EINVAL", "readlink", p);
		return e.target;
	}

	async symlink(target: string, p: string): Promise<void> {
		const n = norm(p);
		const parent = dirname(n);
		if (!this.ents.has(parent)) await this.mkdir(parent, { recursive: true });
		this.ents.set(n, { type: "symlink", target: norm(target), mtime: Date.now() });
	}

	async rm(p: string, opts?: { recursive?: boolean; force?: boolean }): Promise<void> {
		const n = norm(p);
		const e = this.ents.get(n);
		if (!e) {
			if (opts?.force) return;
			throw fsError("ENOENT", "rm", p);
		}
		if (e.type === "dir") {
			if (!opts?.recursive) {
				for (const key of this.ents.keys()) {
					if (key !== n && key.startsWith(n === "/" ? "/" : n + "/")) throw fsError("ENOTEMPTY", "rm", p);
				}
			}
			for (const key of [...this.ents.keys()]) {
				if (key !== n && key.startsWith(n === "/" ? "/" : n + "/")) this.ents.delete(key);
			}
		}
		this.ents.delete(n);
	}
}

// ---------------------------------------------------------------------------
// Artifacts handle + git helpers
// ---------------------------------------------------------------------------

export interface ArtifactsRepoHandle {
	info(): Promise<{ remote: string }>;
	createToken(scope: "read" | "write" | string, ttlSeconds: number): Promise<{ plaintext: string }>;
	[Symbol.dispose]?: () => void;
}

export interface ArtifactsBinding {
	get(name: string): Promise<ArtifactsRepoHandle>;
}

function stripExpiry(plaintext: string): string {
	return plaintext.split("?expires=")[0];
}

function withCreds(remote: string, token: string): string {
	const clean = stripExpiry(token);
	if (remote.startsWith("https://")) return `https://x:${clean}@${remote.slice("https://".length)}`;
	if (remote.startsWith("http://")) return `http://x:${clean}@${remote.slice("http://".length)}`;
	return `https://x:${clean}@${remote}`;
}

function authFor(token: string) {
	const clean = stripExpiry(token);
	return () => ({ username: "x", password: clean });
}

const DIR = "/";
const GITDIR = "/.git";

async function newStore(remoteName: string, remoteUrl: string): Promise<MemFs> {
	const fs = new MemFs();
	// isomorphic-git resolves remote refs through a configured fetch refspec,
	// even when `url` is given directly (spike fix for NoRefspecError).
	await git.setConfig({ fs, dir: DIR, gitdir: GITDIR, path: `remote.${remoteName}.url`, value: remoteUrl });
	await git.setConfig({
		fs,
		dir: DIR,
		gitdir: GITDIR,
		path: `remote.${remoteName}.fetch`,
		value: `+refs/heads/*:refs/remotes/${remoteName}/*`,
	});
	return fs;
}

async function trunkHead(httpAuth: ReturnType<typeof authFor>, toUrl: string, branch: string): Promise<string | null> {
	const refs = await git.listServerRefs({
		http,
		url: toUrl,
		prefix: `refs/heads/${branch}`,
		protocolVersion: 1,
		onAuth: httpAuth,
	});
	return refs.find((r) => r.ref === `refs/heads/${branch}`)?.oid ?? null;
}

/** Leaf paths whose blob oid differs between `a` and `b` (a -> b). */
export async function diffPaths(fs: MemFs, a: string, b: string): Promise<Set<string>> {
	const changed = new Set<string>();
	await git.walk({
		fs,
		dir: DIR,
		gitdir: GITDIR,
		trees: [git.TREE({ ref: a }), git.TREE({ ref: b })],
		map: async (filepath, [ea, eb]) => {
			if (filepath === ".") return;
			const aoid = ea ? await ea.oid() : null;
			const boid = eb ? await eb.oid() : null;
			if (aoid === boid) return null; // equal subtree: prune / equal blob: skip
			const type = await (eb ?? ea)!.type();
			if (type === "tree") return; // differing tree: descend
			changed.add(filepath);
		},
	});
	return changed;
}

/** path -> {mode, oid} for every blob under `ref`. */
export async function flattenTree(fs: MemFs, ref: string): Promise<Map<string, FlatBlob>> {
	const flat = new Map<string, FlatBlob>();
	await git.walk({
		fs,
		dir: DIR,
		gitdir: GITDIR,
		trees: [git.TREE({ ref })],
		map: async (filepath, [entry]) => {
			if (filepath === ".") return;
			const type = await entry!.type();
			if (type !== "blob") return; // trees are descended into
			const mode = await entry!.mode();
			flat.set(filepath, { mode: mode.toString(8).padStart(6, "0"), oid: await entry!.oid() });
		},
	});
	return flat;
}

export async function writeTreeNode(fs: MemFs, node: TreeNode): Promise<string> {
	const entries: git.TreeEntry[] = [];
	for (const [name, sub] of node.subtrees) {
		entries.push({ mode: "040000", path: name, oid: await writeTreeNode(fs, sub), type: "tree" });
	}
	for (const [name, blob] of node.blobs) {
		entries.push({ mode: blob.mode, path: name, oid: blob.oid, type: "blob" });
	}
	return git.writeTree({ fs, dir: DIR, gitdir: GITDIR, tree: entries });
}

function assertPushOk(res: git.PushResult, ref: string): void {
	if (!res.ok) throw new Error(`push failed: ${res.error ?? JSON.stringify(res)}`);
	const refRes = res.refs?.[ref];
	if (refRes && refRes.ok === false) throw new Error(`ref update rejected for ${ref}: ${refRes.error}`);
}

const AUTHOR = { name: "arb-control-plane", email: "arb@workers.dev", timestamp: 0, timezoneOffset: 0 };

// ---------------------------------------------------------------------------
// The port implementation
// ---------------------------------------------------------------------------

export function realRetirer(artifacts: ArtifactsBinding): RetirerPort {
	return {
		async retire(args: RetireArgs): Promise<RetireOutcome> {
			const branch = args.branch ?? "main";
			const candidateBranch = args.candidateBranch ?? "arb-candidate";
			const ttl = 600;
			const t0 = Date.now();
			const ms: Record<string, number> = {};
			const stamp = (k: string, t: number) => {
				ms[k] = Date.now() - t;
			};

			const from = await artifacts.get(args.fromRepo);
			const to = await artifacts.get(args.toRepo);
			try {
				const [fromInfo, fromTok, toInfo, toTok] = await Promise.all([
					from.info(),
					from.createToken("read", ttl),
					to.info(),
					to.createToken("write", ttl),
				]);
				stamp("setup", t0);
				const fromUrl = withCreds(fromInfo.remote, fromTok.plaintext);
				const toUrl = withCreds(toInfo.remote, toTok.plaintext);
				const fromAuth = authFor(fromTok.plaintext);
				const toAuth = authFor(toTok.plaintext);

				const fs = await newStore("origin", fromUrl);
				await git.setConfig({ fs, dir: DIR, gitdir: GITDIR, path: "remote.trunk.url", value: toUrl });
				await git.setConfig({
					fs,
					dir: DIR,
					gitdir: GITDIR,
					path: "remote.trunk.fetch",
					value: "+refs/heads/*:refs/remotes/trunk/*",
				});

				// Pull both histories into one object store: the entry head (with
				// baseCommit as an ancestor) and the live trunk head.
				const tFetch = Date.now();
				await git.fetch({
					fs, http, dir: DIR, gitdir: GITDIR,
					remote: "origin", ref: `arb-retire/${args.fromRepo}`, remoteRef: branch,
					singleBranch: true, tags: false, onAuth: fromAuth,
				});
				await git.fetch({
					fs, http, dir: DIR, gitdir: GITDIR,
					remote: "trunk", ref: `arb-retire/${args.toRepo}`, remoteRef: branch,
					singleBranch: true, tags: false, onAuth: toAuth,
				});
				stamp("fetch", tFetch);

				const head = await trunkHead(toAuth, toUrl, branch);
				if (head === null) {
					// Unborn branch: land the entry head directly.
					const tPush = Date.now();
					await git.writeRef({ fs, dir: DIR, gitdir: GITDIR, ref: `refs/heads/${branch}`, value: args.commit, force: true });
					const res = await git.push({ fs, http, dir: DIR, gitdir: GITDIR, url: toUrl, ref: branch, remoteRef: branch, force: false, onAuth: toAuth });
					assertPushOk(res, `refs/heads/${branch}`);
					stamp("push", tPush);
					return { outcome: "fast-forward", commit: args.commit, ms: { ...ms, total: Date.now() - t0 } };
				}

				const tVerify = Date.now();
				const ff = await git.isDescendent({ fs, dir: DIR, gitdir: GITDIR, oid: args.commit, ancestor: head, depth: -1 });
				// Entry head already contained in trunk (ancestor or equal):
				// nothing to land — a no-op fast-forward, not an empty splice.
				const contained =
					head === args.commit ||
					(await git.isDescendent({ fs, dir: DIR, gitdir: GITDIR, oid: head, ancestor: args.commit, depth: -1 }));
				stamp("verify", tVerify);
				if (contained) {
					return { outcome: "fast-forward", commit: head, ms: { ...ms, total: Date.now() - t0 } };
				}
				if (ff) {
					const tPush = Date.now();
					await git.writeRef({ fs, dir: DIR, gitdir: GITDIR, ref: `refs/heads/${branch}`, value: args.commit, force: true });
					const res = await git.push({ fs, http, dir: DIR, gitdir: GITDIR, url: toUrl, ref: branch, remoteRef: branch, force: false, onAuth: toAuth });
					assertPushOk(res, `refs/heads/${branch}`);
					stamp("push", tPush);
					return { outcome: "fast-forward", commit: args.commit, ms: { ...ms, total: Date.now() - t0 } };
				}

				// Trunk is a sibling of the entry head: path-disjoint splice.
				const tDiff = Date.now();
				const [p, q] = await Promise.all([
					diffPaths(fs, args.baseCommit, args.commit),
					diffPaths(fs, args.baseCommit, head),
				]);
				const decision = decideSplice(p, q);
				stamp("diff", tDiff);
				if (decision.kind === "squash") {
					return { outcome: "overlap", overlap: decision.overlap, p: [...p].sort(), q: [...q].sort(), ms: { ...ms, total: Date.now() - t0 } };
				}

				const tSplice = Date.now();
				const [trunkFlat, entryFlat] = await Promise.all([flattenTree(fs, head), flattenTree(fs, args.commit)]);
				const merged = overlayPaths(trunkFlat, entryFlat, p);
				const tree = await writeTreeNode(fs, buildTree(merged));
				const now = Math.floor(Date.now() / 1000);
				const candidate = await git.writeCommit({
					fs, dir: DIR, gitdir: GITDIR,
					commit: {
						message: `arb: splice ${args.commit} onto ${head}\n\npath-disjoint overlay of ${p.size} path(s): ${[...p].sort().join(", ")}`,
						tree,
						parent: [head],
						author: { ...AUTHOR, timestamp: now },
						committer: { ...AUTHOR, timestamp: now },
					},
				});
				await git.writeRef({ fs, dir: DIR, gitdir: GITDIR, ref: `refs/heads/${candidateBranch}`, value: candidate, force: true });
				const res = await git.push({
					fs, http, dir: DIR, gitdir: GITDIR, url: toUrl,
					ref: candidateBranch, remoteRef: candidateBranch, force: true, onAuth: toAuth,
				});
				assertPushOk(res, `refs/heads/${candidateBranch}`);
				stamp("splice", tSplice);
				return { outcome: "splice", candidate, ms: { ...ms, total: Date.now() - t0 } };
			} finally {
				from[Symbol.dispose]?.();
				to[Symbol.dispose]?.();
			}
		},

		/** Fast-forward `toRepo`:`branch` to `commit` (a previously pushed
		 * candidate whose parent is the current branch head). */
		async moveBranch({ toRepo, branch, commit }): Promise<void> {
			const to = await artifacts.get(toRepo);
			try {
				const [info, tok] = await Promise.all([to.info(), to.createToken("write", 600)]);
				const toUrl = withCreds(info.remote, tok.plaintext);
				const toAuth = authFor(tok.plaintext);
				const fs = await newStore("origin", toUrl);
				// Pull the candidate's objects locally so push can negotiate.
				await git.fetch({
					fs, http, dir: DIR, gitdir: GITDIR,
					remote: "origin", ref: "arb-candidate", remoteRef: "arb-candidate",
					singleBranch: true, tags: false, onAuth: toAuth,
				});
				await git.writeRef({ fs, dir: DIR, gitdir: GITDIR, ref: "refs/heads/arb-candidate", value: commit, force: true });
				const res = await git.push({
					fs, http, dir: DIR, gitdir: GITDIR, url: toUrl,
					ref: "arb-candidate", remoteRef: branch, force: false, onAuth: toAuth,
				});
				assertPushOk(res, `refs/heads/${branch}`);
			} finally {
				to[Symbol.dispose]?.();
			}
		},
	};
}
