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
import { realArtifacts, type ArtifactsPort, type RetireArgs, type RetireOutcome, type RetirerPort } from "./ports.ts";
import { realRetirer, type ArtifactsBinding } from "./retire.ts";
import type { Env } from "./do.ts";

export const TRUNK_NAME = "trunk-t14";
const TRUNK_REPO = "arb-trunk";
const TRUNK_KEY = "trunk";
const TOKEN_TTL_S = 3600;

export interface TrunkInfo {
	repo: string;
	remote: string;
	commit: string | null;
}

export class ArbTrunk extends DurableObject<Env> {
	private artifacts: ArtifactsPort;
	private retirer: RetirerPort;
	private trunk: TrunkInfo = { repo: "", remote: "", commit: null };
	/** Serializes trunk mutations (retire + moveBranch) across interleaved
	 * async handlers. */
	private queue: Promise<unknown> = Promise.resolve();

	constructor(ctx: DurableObjectState, env: Env) {
		super(ctx, env);
		this.artifacts = realArtifacts(env.ARTIFACTS as Parameters<typeof realArtifacts>[0]);
		this.retirer = realRetirer(env.ARTIFACTS as ArtifactsBinding);
		ctx.blockConcurrencyWhile(async () => {
			this.trunk = (await ctx.storage.get<TrunkInfo>(TRUNK_KEY)) ?? this.trunk;
		});
	}

	private persist(): Promise<void> {
		return this.ctx.storage.put(TRUNK_KEY, this.trunk);
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
		await this.ensureAlarm();
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

	/** Queue push event routed here by repo name. Stores the remote head, not
	 * the event commit — events may arrive out of order. */
	async onPush(repo: string, _commit: string): Promise<void> {
		if (repo !== this.trunk.repo) return;
		const head = (await this.artifacts.log(repo, 1))[0]?.hash;
		if (head && head !== this.trunk.commit) {
			this.trunk.commit = head;
			await this.persist();
		}
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
					await this.persist();
				}
			}
		} finally {
			if (this.pollEnabled() && this.trunk.repo) {
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
			return json({ error: String(e instanceof Error ? e.message : e) }, 500);
		}
	}
}
