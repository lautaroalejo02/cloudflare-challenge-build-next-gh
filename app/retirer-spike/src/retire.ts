/**
 * Fast-forward retirement for the Agent Reorder Buffer.
 *
 * Moves `toRepo`'s `branch` ref forward to `commit` — a commit that lives on
 * `fromRepo` (an Artifacts fork of the trunk) — by transferring only the
 * missing objects over git smart HTTP. Runs entirely inside a Cloudflare
 * Worker: isomorphic-git over `fetch`, with an in-memory fs as the object
 * store. Requires the `nodejs_compat` compatibility flag (isomorphic-git
 * uses `Buffer`).
 *
 * No server-side merge is involved: `commit` must be a descendant of the
 * trunk head (verified locally after the fetch, and enforced again by the
 * git server on push).
 */
import * as git from "isomorphic-git";
import http from "isomorphic-git/http/web";

// ---------------------------------------------------------------------------
// In-memory fs implementing the isomorphic-git `fs.promises` contract.
// Everything is stored under posix-style absolute paths in two maps.
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

function basename(p: string): string {
	const n = norm(p);
	const i = n.lastIndexOf("/");
	return n.slice(i + 1);
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
	/** isomorphic-git binds `fs.promises` when present; methods are async. */
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
		return {
			isFile: () => e.type === "file",
			isDirectory: () => e.type === "dir",
			isSymbolicLink: () => e.type === "symlink",
			size: e.type === "file" ? e.data.byteLength : 0,
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

	/** Total bytes stored (approximate object-store footprint). */
	byteSize(): number {
		let total = 0;
		for (const e of this.ents.values()) if (e.type === "file") total += e.data.byteLength;
		return total;
	}

	fileCount(): number {
		let n = 0;
		for (const e of this.ents.values()) if (e.type === "file") n++;
		return n;
	}
}

// ---------------------------------------------------------------------------
// Port types (duck-typed so the module drops into control-plane unchanged)
// ---------------------------------------------------------------------------

export interface ArtifactsRepoHandle {
	info(): Promise<{ remote: string }>;
	createToken(scope: "read" | "write" | string, ttlSeconds: number): Promise<{ plaintext: string }>;
	[Symbol.dispose]?: () => void;
}

export interface ArtifactsBinding {
	get(name: string): Promise<ArtifactsRepoHandle>;
}

export interface RetireEnv {
	ARTIFACTS: ArtifactsBinding;
}

export interface FastForwardArgs {
	/** Artifacts repo that holds `commit` (the entry's fork). */
	fromRepo: string;
	/** Commit oid to retire onto the trunk. */
	commit: string;
	/** Artifacts repo to update (e.g. "arb-trunk"). */
	toRepo: string;
	/** Branch to fast-forward. Default "main". */
	branch?: string;
	/** Token TTL in seconds for the read/write tokens minted internally. */
	tokenTtlSeconds?: number;
}

export interface FastForwardResult {
	/** New head of `toRepo`'s `branch` — equal to `commit`. */
	head: string;
	/** Head of `toRepo`'s `branch` before the update; null if the branch was unborn. */
	previousHead: string | null;
	/** Bytes held by the in-memory object store at return time (memory proxy). */
	fsBytes: number;
	/** Phase timings in ms (Date.now around awaited I/O). */
	ms: { setup: number; fetch: number; verify: number; push: number; total: number };
}

export class NotFastForwardError extends Error {
	readonly code = "NOT_FAST_FORWARD" as const;
	readonly commit: string;
	readonly ancestor: string;
	constructor(commit: string, ancestor: string) {
		super(`commit ${commit} is not a descendant of ${ancestor}; refusing non-fast-forward update`);
		this.name = "NotFastForwardError";
		this.commit = commit;
		this.ancestor = ancestor;
	}
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

/**
 * Fast-forward `toRepo`'s `branch` to `commit` (present on `fromRepo`).
 * Throws NotFastForwardError when `commit` is not a descendant of the current
 * trunk head. On success the trunk's `branch` ref equals `commit`.
 */
export async function fastForward(env: RetireEnv, args: FastForwardArgs): Promise<FastForwardResult> {
	const branch = args.branch ?? "main";
	const ttl = args.tokenTtlSeconds ?? 600;
	const t0 = Date.now();

	const from = await env.ARTIFACTS.get(args.fromRepo);
	const to = await env.ARTIFACTS.get(args.toRepo);
	try {
		const [fromInfo, fromTok, toInfo, toTok] = await Promise.all([
			from.info(),
			from.createToken("read", ttl),
			to.info(),
			to.createToken("write", ttl),
		]);
		const tSetup = Date.now();
		const fromUrl = withCreds(fromInfo.remote, fromTok.plaintext);
		const toUrl = withCreds(toInfo.remote, toTok.plaintext);

		const fs = new MemFs();
		const dir = "/";
		const gitdir = "/.git";

		// isomorphic-git resolves remote refs through a configured fetch refspec,
		// even when `url` is given directly — provide the standard origin mapping.
		await git.setConfig({ fs, dir, gitdir, path: "remote.origin.url", value: fromUrl });
		await git.setConfig({ fs, dir, gitdir, path: "remote.origin.fetch", value: "+refs/heads/*:refs/remotes/origin/*" });

		// 1. Pull the fork's branch history into the in-memory object store.
		await git.fetch({
			fs,
			http,
			dir,
			gitdir,
			remote: "origin",
			ref: branch,
			remoteRef: branch,
			singleBranch: true,
			tags: false,
			onAuth: authFor(fromTok.plaintext),
		});
		const tFetch = Date.now();

		// 2. Resolve the trunk's current head for `branch`.
		const serverRefs = await git.listServerRefs({
			http,
			url: toUrl,
			prefix: `refs/heads/${branch}`,
			protocolVersion: 1,
			onAuth: authFor(toTok.plaintext),
		});
		const trunkHead = serverRefs.find((r) => r.ref === `refs/heads/${branch}`)?.oid ?? null;

		// 3. Fast-forward-only check: commit must descend from trunkHead.
		if (trunkHead !== null) {
			const ok = await git.isDescendent({ fs, dir, gitdir, oid: args.commit, ancestor: trunkHead, depth: -1 });
			if (!ok) throw new NotFastForwardError(args.commit, trunkHead);
		}
		const tVerify = Date.now();

		// 4. Point our local branch at C and push objects + ref update.
		await git.writeRef({ fs, dir, gitdir, ref: `refs/heads/${branch}`, value: args.commit, force: true });
		const res = await git.push({
			fs,
			http,
			dir,
			gitdir,
			url: toUrl,
			ref: branch,
			remoteRef: branch,
			force: false,
			onAuth: authFor(toTok.plaintext),
		});
		const tPush = Date.now();
		if (!res.ok) throw new Error(`push to ${args.toRepo} failed: ${res.error ?? JSON.stringify(res)}`);
		const refRes = res.refs?.[`refs/heads/${branch}`];
		if (refRes && refRes.ok === false) throw new Error(`ref update rejected: ${refRes.error}`);

		return {
			head: args.commit,
			previousHead: trunkHead,
			fsBytes: fs.byteSize(),
			ms: {
				setup: tSetup - t0,
				fetch: tFetch - tSetup,
				verify: tVerify - tFetch,
				push: tPush - tVerify,
				total: tPush - t0,
			},
		};
	} finally {
		from[Symbol.dispose]?.();
		to[Symbol.dispose]?.();
	}
}
