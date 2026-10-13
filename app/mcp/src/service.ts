import fs from "node:fs";
import path from "node:path";
import { ApiClient } from "../../demo/src/lib/http.ts";
import { authUrl, cloneRepo, commitAll, git, head } from "../../demo/src/lib/git.ts";
import { resolveAdminKey } from "../../demo/src/lib/admin-key.ts";
import { renderSquashInstructions } from "./instructions.ts";
import type { BufferState, CheckResult, Entry } from "./types.ts";

export const DEFAULT_BASE_URL = "https://arb-control-plane.lautitomasalejo.workers.dev";

export interface ArbServiceConfig {
  baseUrl?: string;
  adminKey?: string;
  workdir?: string;
  /** Poll cadence for fork/refork waits. */
  pollMs?: number;
  /** Default deadline for arb_register's first-fork wait and arb_sync. */
  syncTimeoutMs?: number;
}

export interface ResolvedArbServiceConfig {
  baseUrl: string;
  adminKey?: string;
  workdir: string;
  pollMs: number;
  syncTimeoutMs: number;
}

export function resolveConfig(env: Record<string, string | undefined> = process.env): ResolvedArbServiceConfig {
  return {
    baseUrl: env.ARB_BASE_URL || DEFAULT_BASE_URL,
    adminKey: resolveAdminKey(env),
    workdir: path.resolve(env.ARB_WORKDIR || path.join(process.cwd(), ".arb-workspaces")),
    pollMs: env.ARB_POLL_MS ? Number(env.ARB_POLL_MS) : 1000,
    syncTimeoutMs: env.ARB_SYNC_TIMEOUT_MS ? Number(env.ARB_SYNC_TIMEOUT_MS) : 120_000,
  };
}

/** Per-entry local bookkeeping, persisted under <workdir>/.mcp-state/ (outside
 * the cloned repos so `git add -A` never commits it). `repo`/`generation` are
 * the fork the workspace was cloned from; a squash moves them. */
interface EntryState {
  entryId: string;
  workspace: string;
  repo: string;
  generation: number;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** file:// remotes (the local mock) take no auth; https remotes need a token. */
export function remoteNeedsAuth(remote: string): boolean {
  return remote.includes("://") && !remote.startsWith("file:");
}

function summarizeChecks(c: CheckResult | null): unknown {
  if (!c) return null;
  return {
    commit: c.commit,
    passed: c.passed,
    failed: c.failed,
    durationMs: c.durationMs,
    ...(c.infra ? { infra: true } : {}),
    failing: c.results.filter((r) => !r.ok).map((r) => r.name),
  };
}

export class ArbService {
  readonly api: ApiClient;
  readonly workdir: string;
  private readonly pollMs: number;
  private readonly syncTimeoutMs: number;
  private readonly stateDir: string;

  constructor(cfg: ResolvedArbServiceConfig | ArbServiceConfig = {}) {
    const base = cfg.baseUrl || DEFAULT_BASE_URL;
    this.api = new ApiClient(base, cfg.adminKey);
    this.workdir = path.resolve(cfg.workdir || path.join(process.cwd(), ".arb-workspaces"));
    this.pollMs = cfg.pollMs ?? 1000;
    this.syncTimeoutMs = cfg.syncTimeoutMs ?? 120_000;
    this.stateDir = path.join(this.workdir, ".mcp-state");
    fs.mkdirSync(this.stateDir, { recursive: true });
  }

  private workspaceFor(entryId: string): string {
    return path.join(this.workdir, entryId);
  }

  private loadState(entryId: string): EntryState | undefined {
    try {
      return JSON.parse(fs.readFileSync(path.join(this.stateDir, `${entryId}.json`), "utf8"));
    } catch {
      return undefined;
    }
  }

  private saveState(st: EntryState): void {
    fs.mkdirSync(this.stateDir, { recursive: true });
    fs.writeFileSync(path.join(this.stateDir, `${st.entryId}.json`), JSON.stringify(st, null, 2));
  }

  /** Poll GET /api/entries/:id until the (re-)fork has landed: the repo moved
   * off `prevRepo` (null = wait for the first fork), the remote is set, the
   * fork carries the new base (headCommit === baseCommit or still null), and
   * — for authenticated remotes — a token was handed out. */
  private async waitForFork(
    entryId: string,
    prevRepo: string | null,
    timeoutMs: number,
  ): Promise<{ entry: Entry; token?: string }> {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      const { entry, token } = (await this.api.getEntry(entryId)) as { entry: Entry; token?: string };
      const repoReady = prevRepo === null ? !!entry.remote : entry.repo !== prevRepo;
      const headReady = entry.headCommit === entry.baseCommit || entry.headCommit === null;
      const authReady = !remoteNeedsAuth(entry.remote || "") || !!token;
      if (repoReady && !!entry.remote && headReady && authReady) return { entry, token };
      if (Date.now() > deadline) {
        throw new Error(
          `timed out after ${Math.round(timeoutMs / 1000)}s waiting for the fork of ${entryId} to land ` +
            `(repo=${entry.repo || "pending"}, headCommit=${entry.headCommit ?? "none"}, baseCommit=${entry.baseCommit || "none"})`,
        );
      }
      await sleep(this.pollMs);
    }
  }

  /** Clone `entry.remote` into the workspace and strip credentials from
   * `.git/config`: the token is only ever passed per git invocation, never
   * stored on the remote URL. */
  private async cloneInto(entry: Entry, token: string | undefined): Promise<string> {
    const ws = this.workspaceFor(entry.id);
    fs.rmSync(ws, { recursive: true, force: true });
    await cloneRepo(entry.remote, token ?? "", ws);
    await git(["-C", ws, "remote", "set-url", "origin", entry.remote]);
    this.saveState({ entryId: entry.id, workspace: ws, repo: entry.repo, generation: entry.generation });
    return ws;
  }

  async register(input: {
    agent: string;
    lane: string;
    producerId?: string;
    consumes?: string[];
    stub?: Record<string, string>;
  }) {
    const created = await this.api.createEntry({
      agent: input.agent,
      lane: input.lane,
      ...(input.producerId !== undefined ? { producerId: input.producerId } : {}),
      ...(input.consumes !== undefined ? { consumes: input.consumes } : {}),
      ...(input.stub !== undefined ? { stub: input.stub } : {}),
    });
    let entry = created.entry as Entry;
    let token: string | undefined = created.token;
    if (!entry.remote) {
      // The real control plane forks asynchronously; wait for it to land.
      const got = await this.waitForFork(entry.id, null, this.syncTimeoutMs);
      entry = got.entry;
      token = got.token ?? token;
    }
    const workspace = await this.cloneInto(entry, token);
    return {
      entryId: entry.id,
      seq: entry.seq,
      workspace,
      status: entry.status,
      lane: entry.lane,
      producerId: entry.producerId,
      baseCommit: entry.baseCommit,
      headCommit: entry.headCommit,
      consumes: entry.consumes,
      inferred: input.consumes === undefined,
      consumesInferred: entry.consumesInferred ?? false,
      predicted: entry.predicted ?? [],
      next: "Edit files inside `workspace`, then arb_push with a commit message, then arb_ready when done.",
    };
  }

  async status(input: { entryId: string }) {
    const { entry } = (await this.api.getEntry(input.entryId)) as { entry: Entry; token?: string };
    const out: Record<string, unknown> = {
      entryId: entry.id,
      status: entry.status,
      generation: entry.generation,
      agent: entry.agent,
      lane: entry.lane,
      producerId: entry.producerId,
      repo: entry.repo,
      baseCommit: entry.baseCommit,
      headCommit: entry.headCommit,
      consumes: entry.consumes,
      consumesInferred: entry.consumesInferred ?? false,
      predicted: entry.predicted ?? [],
      judging: entry.judging ?? [],
      checks: summarizeChecks(entry.checks),
    };
    if (entry.status === "squashed") {
      out.diagnosis = entry.diagnosis;
      out.instructions = renderSquashInstructions(entry);
    }
    return out;
  }

  async sync(input: { entryId: string; timeoutMs?: number }) {
    const st = this.loadState(input.entryId);
    const { entry: cur } = (await this.api.getEntry(input.entryId)) as { entry: Entry };
    if (st && cur.repo === st.repo && cur.status !== "squashed") {
      return {
        entryId: cur.id,
        synced: false,
        workspace: st.workspace,
        status: cur.status,
        generation: cur.generation,
        baseCommit: cur.baseCommit,
        headCommit: cur.headCommit,
        message: `Entry ${cur.id} is "${cur.status}" on the same fork the workspace was cloned from; nothing to sync.`,
      };
    }
    const timeout = input.timeoutMs ?? this.syncTimeoutMs;
    const { entry, token } = await this.waitForFork(cur.id, st?.repo ?? null, timeout);
    const workspace = await this.cloneInto(entry, token);
    const out: Record<string, unknown> = {
      entryId: entry.id,
      synced: true,
      workspace,
      status: entry.status,
      generation: entry.generation,
      baseCommit: entry.baseCommit,
      headCommit: entry.headCommit,
      message:
        "Workspace replaced with a fresh clone of the new fork. Redo your work here, then arb_push and arb_ready.",
    };
    if (entry.status === "squashed" || entry.diagnosis) {
      out.diagnosis = entry.diagnosis;
      out.instructions = renderSquashInstructions(entry);
    }
    return out;
  }

  async push(input: { entryId: string; message: string }) {
    const ws = this.workspaceFor(input.entryId);
    if (!fs.existsSync(path.join(ws, ".git"))) {
      throw new Error(
        `no workspace for ${input.entryId} at ${ws} — call arb_register first (or arb_sync after a squash)`,
      );
    }
    const st = this.loadState(input.entryId);
    const { entry, token } = (await this.api.getEntry(input.entryId)) as { entry: Entry; token?: string };
    const drifted = !st || st.repo !== entry.repo || st.generation !== entry.generation;
    if (drifted) {
      let adopted = false;
      if (entry.status !== "squashed" && !st) {
        // No local state (e.g. server restarted). The workspace's origin is the
        // credential-free remote we cloned from — if it still matches the
        // entry's remote, the workspace corresponds to the current fork.
        try {
          const origin = await git(["-C", ws, "remote", "get-url", "origin"]);
          if (origin === entry.remote) {
            this.saveState({ entryId: entry.id, workspace: ws, repo: entry.repo, generation: entry.generation });
            adopted = true;
          }
        } catch {
          /* fall through to refusal */
        }
      } else if (entry.status !== "squashed") {
        // Non-squash repo/generation drift: adopt it into local state so the
        // workspace identity check stays honest on the next call.
        this.saveState({ ...st!, repo: entry.repo, generation: entry.generation });
        adopted = true;
      }
      if (!adopted) {
        throw new Error(
          `entry ${input.entryId} was squashed (${entry.diagnosis?.reason ?? "no diagnosis"}) or re-forked and ` +
            `the workspace still holds the old fork — call arb_sync first, redo your work, then push again`,
        );
      }
    }
    if (remoteNeedsAuth(entry.remote) && !token) {
      throw new Error(
        `control plane returned no push token for ${input.entryId} — a re-fork may be in flight; retry shortly`,
      );
    }
    const committed = await commitAll(ws, input.message, entry.agent || "arb-mcp");
    // Push with the credential-bearing URL inline; `origin` stays clean and
    // the token never touches .git/config.
    await git(["-C", ws, "push", "-q", authUrl(entry.remote, token ?? ""), "HEAD:main"]);
    const commit = await head(ws);
    return {
      entryId: input.entryId,
      commit,
      committed: committed !== null,
      message:
        committed === null
          ? "Nothing new to commit; pushed the existing workspace HEAD."
          : `Committed and pushed ${commit.slice(0, 12)}.`,
    };
  }

  async ready(input: { entryId: string }) {
    const ws = this.workspaceFor(input.entryId);
    if (!fs.existsSync(path.join(ws, ".git"))) {
      throw new Error(`no workspace for ${input.entryId} at ${ws} — call arb_register first`);
    }
    const commit = await head(ws);
    const { entry } = (await this.api.ready(input.entryId, commit)) as { entry: Entry };
    return {
      entryId: input.entryId,
      commit,
      status: entry.status,
      checks: summarizeChecks(entry.checks),
    };
  }

  async state() {
    const s = (await this.api.state()) as BufferState;
    return {
      robSize: s.robSize,
      trunk: s.trunk,
      stats: s.stats,
      entries: s.entries.map((e) => ({
        entryId: e.id,
        seq: e.seq,
        agent: e.agent,
        lane: e.lane,
        status: e.status,
        producerId: e.producerId,
        generation: e.generation,
        baseCommit: e.baseCommit,
        headCommit: e.headCommit,
      })),
    };
  }
}
