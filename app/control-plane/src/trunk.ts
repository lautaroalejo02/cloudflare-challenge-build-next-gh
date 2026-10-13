// ArbTrunk Durable Object (T14): single owner of the shared trunk resource.
//
// Why a dedicated DO: with one ReorderBuffer DO per connected component,
// several components can be ready to retire at the same time. Retirement
// mutates `main` on `arb-trunk` — a fast-forward push, or a splice that
// reads the trunk head, overlays disjoint paths and moves the branch. Two
// concurrent retirers could read the same head and produce siblings, turning
// a clean fast-forward into spurious overlap squashes (or worse). DOs run
// single-threaded but async handlers interleave on await, so this object
// additionally serializes retire()/moveBranch() through an in-memory promise
// queue: every git mutation of trunk happens strictly one at a time.
//
// It also owns the authoritative trunk head (`commit`) for /api/state
// aggregation, fed by queue push events routed by repo name and by a
// ~3s alarm poll fallback — the ONLY poller of arb-trunk now (component DOs
// poll their own forks only).

import { DurableObject } from "cloudflare:workers";
import {
	realArtifacts,
	realChecker,
	type ArtifactsPort,
	type AtomicRetireResult,
	type CheckerPort,
	type RetireArgs,
	type RetireOutcome,
	type RetirerPort,
} from "./ports.ts";
import { realRetirer, type ArtifactsBinding } from "./retire.ts";
import { retireAtomic } from "./atomic.ts";
import type { Env } from "./do.ts";

// Name bump at T17: the old "trunk-t14" instance stays warm on its 3s alarm
// and kept serving the pre-T17 class (RPC "retireAtomic not implemented").
// A fresh idFromName boots the new code; trunkInit re-derives head state.
// Bumped again at T19 (review F10); from T19 on the alarm also stops when the
// trunk is idle, so later deploys should not need a bump to escape pinning.
export const TRUNK_NAME = "trunk-v2";

/** Stop polling `arb-trunk` after this long without trunk activity
 * (init, retire, push event, observed head change) — review F10. Any later
 * activity re-arms the alarm. */
export const TRUNK_IDLE_MS = 5 * 60_000;
const TRUNK_REPO = "arb-trunk";
const TRUNK_KEY = "trunk";
const ACTIVITY_KEY = "lastActivity";
const TOKEN_TTL_S = 3600;

export interface TrunkInfo {
	repo: string;
	remote: string;
	commit: string | null;
}

export class ArbTrunk extends DurableObject<Env> {
	private artifacts: ArtifactsPort;
	private retirer: RetirerPort;
	private checker: CheckerPort;
	private trunk: TrunkInfo = { repo: "", remote: "", commit: null };
	/** Serializes trunk mutations (retire + moveBranch + retireAtomic) across
	 * interleaved async handlers. */
	private queue: Promise<unknown> = Promise.resolve();
	/** ts of the last trunk activity; the alarm goes dormant TRUNK_IDLE_MS later. */
	private lastActivity = 0;

	constructor(ctx: DurableObjectState, env: Env) {
		super(ctx, env);
		this.artifacts = realArtifacts(env.ARTIFACTS as Parameters<typeof realArtifacts>[0]);
		this.retirer = realRetirer(env.ARTIFACTS as ArtifactsBinding);
		this.checker = realChecker({ ARTIFACTS: env.ARTIFACTS, LOADER: env.LOADER });
		ctx.blockConcurrencyWhile(async () => {
			this.trunk = (await ctx.storage.get<TrunkInfo>(TRUNK_KEY)) ?? this.trunk;
			this.lastActivity = (await ctx.storage.get<number>(ACTIVITY_KEY)) ?? 0;
		});
	}

	private persist(): Promise<void> {
		return this.ctx.storage.put(TRUNK_KEY, this.trunk);
	}

	/** Record trunk activity and make sure the poll alarm is armed. */
	private async touch(): Promise<void> {
		this.lastActivity = Date.now();
		await this.ctx.storage.put(ACTIVITY_KEY, this.lastActivity);
		await this.ensureAlarm();
	}

	private enqueue<T>(fn: () => Promise<T>): Promise<T> {
		const p = this.queue.then(fn);
		this.queue = p.then(
			() => undefined,
			() => undefined,
		);
		return p;
	}

	// --- RPC entry points ------------------------------------------------------

	/** Create `arb-trunk` if missing; refresh the stored head; return remote
	 * + a write token for the demo's seed push. Idempotent. */
	async trunkInit(): Promise<{ repo: string; remote: string; token: string }> {
		let remote: string;
		let commit: string | null = null;
		try {
			remote = await this.artifacts.getRemote(TRUNK_REPO);
			commit = (await this.artifacts.log(TRUNK_REPO, 1))[0]?.hash ?? null;
		} catch {
			const created = await this.artifacts.create(TRUNK_REPO, {
				setDefaultBranch: "main",
				description: "ARB trunk",
			});
			remote = created.remote;
		}
		this.trunk = { repo: TRUNK_REPO, remote, commit };
		await this.persist();
		await this.touch();
		const token = await this.artifacts.token(TRUNK_REPO, TOKEN_TTL_S);
		return { repo: TRUNK_REPO, remote, token };
	}

	/** Serialized fast-forward/splice decision (git fetch + push). The caller
	 * (a component DO) applies the outcome to its own state machine. */
	async retire(args: RetireArgs): Promise<RetireOutcome> {
		return this.enqueue(async () => {
			const res = await this.retirer.retire(args);
			if (res.outcome === "fast-forward") {
				this.trunk.commit = res.commit;
				await this.persist();
			}
			// "splice" only pushes a candidate ref; main moves via moveBranch.
			return res;
		});
	}

	/** Serialized branch move for a checked splice candidate. */
	async moveBranch(args: { toRepo: string; branch: string; commit: string }): Promise<void> {
		return this.enqueue(async () => {
			await this.retirer.moveBranch(args);
			this.trunk.commit = args.commit;
			await this.persist();
		});
	}

	/** T17: one fully atomic retire attempt cycle. The WHOLE sequence —
	 * read head -> ff/splice decision -> candidate build -> candidate check
	 * -> move main — runs inside a single queue slot, so no other component
	 * can land on trunk in between (the T16 stale-candidate wedge). Rejected
	 * moves rebuild from the new head and re-check (bounded, see atomic.ts).
	 * The caller replays `attempts` into check/retry events and applies the
	 * final outcome; a `retry-exhausted` result is a clean failure the
	 * component can retry on its next cascade — never a wedge. */
	async retireAtomic(args: RetireArgs): Promise<AtomicRetireResult> {
		return this.enqueue(async () => {
			const res = await retireAtomic(args, { retirer: this.retirer, checker: this.checker });
			if (res.outcome === "fast-forward" || res.outcome === "splice") {
				this.trunk.commit = res.commit;
				await this.persist();
			}
			await this.touch();
			return res;
		});
	}

	/** Queue push event routed here by repo name. Stores the remote head, not
	 * the event commit — events may arrive out of order. */
	async onPush(repo: string, _commit: string): Promise<void> {
		if (repo !== this.trunk.repo) return;
		const head = (await this.artifacts.log(repo, 1))[0]?.hash;
		if (head && head !== this.trunk.commit) {
			this.trunk.commit = head;
			await this.persist();
		}
		await this.touch();
	}

	async getTrunk(): Promise<TrunkInfo> {
		return this.trunk;
	}

	// --- alarm fallback ---------------------------------------------------------

	private pollEnabled(): boolean {
		return (this.env.POLL_FALLBACK ?? "on").toLowerCase() !== "off";
	}

	private pollIntervalMs(): number {
		const n = Number(this.env.POLL_INTERVAL_MS ?? "3000");
		return Number.isFinite(n) && n >= 500 ? n : 3000;
	}

	private async ensureAlarm(): Promise<void> {
		if (!this.pollEnabled() || !this.trunk.repo) return;
		if ((await this.ctx.storage.getAlarm()) === null) {
			await this.ctx.storage.setAlarm(Date.now() + this.pollIntervalMs());
		}
	}

	async alarm(): Promise<void> {
		try {
			if (this.trunk.repo) {
				const head = (await this.artifacts.log(this.trunk.repo, 1))[0]?.hash;
				if (head && head !== this.trunk.commit) {
					this.trunk.commit = head;
					this.lastActivity = Date.now();
					await this.ctx.storage.put(ACTIVITY_KEY, this.lastActivity);
					await this.persist();
				}
			}
		} finally {
			// Go dormant when idle (review F10): a forever-warm alarm pins the
			// object to an old deployment. Activity re-arms it via touch().
			const idle = Date.now() - this.lastActivity > TRUNK_IDLE_MS;
			if (this.pollEnabled() && this.trunk.repo && !idle) {
				await this.ctx.storage.setAlarm(Date.now() + this.pollIntervalMs());
			}
		}
	}

	// --- HTTP (Worker-facing) ---------------------------------------------------

	async fetch(request: Request): Promise<Response> {
		const url = new URL(request.url);
		const json = (body: unknown, status = 200) =>
			new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
		try {
			if (request.method === "POST" && url.pathname === "/api/trunk/init") {
				return json(await this.trunkInit());
			}
			if (request.method === "GET" && url.pathname === "/internal/state") {
				return json({ trunk: this.trunk });
			}
			if (request.method === "POST" && url.pathname === "/internal/reset") {
				// Reset keeps the trunk repo; re-read the real head (the demo
				// re-seeds right after reset).
				if (this.trunk.repo) {
					this.trunk.commit = (await this.artifacts.log(this.trunk.repo, 1))[0]?.hash ?? this.trunk.commit;
					await this.persist();
				}
				return json({ ok: true });
			}
			return json({ error: "not found" }, 404);
		} catch (e) {
			return json({ error: String(e instanceof Error ? e.message : e).split("\n")[0].slice(0, 300) }, 500);
		}
	}
}
