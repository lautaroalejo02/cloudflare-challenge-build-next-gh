import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { ApiClient } from "./api.ts";
import { ArbGit, type GitExec } from "./git.ts";
import { redactCredentials } from "../../demo/src/lib/git.ts";
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
  /** Injectable execFile for tests; production uses child_process.execFile. */
  exec?: GitExec;
}

export interface ResolvedArbServiceConfig {
  baseUrl: string;
  adminKey?: string;
  workdir: string;
  pollMs: number;
  syncTimeoutMs: number;
}

export const DEFAULT_WORKDIR = path.join(os.tmpdir(), "arb-workspaces");

export function resolveConfig(env: Record<string, string | undefined> = process.env): ResolvedArbServiceConfig {
  return {
    baseUrl: env.ARB_BASE_URL || DEFAULT_BASE_URL,
    adminKey: resolveAdminKey(env),
    workdir: path.resolve(env.ARB_WORKDIR || DEFAULT_WORKDIR),
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

const ENTRY_ID_RE = /^e\d+$/;

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
  readonly git: ArbGit;
  private readonly pollMs: number;
  private readonly syncTimeoutMs: number;
  private readonly stateDir: string;

  constructor(cfg: ResolvedArbServiceConfig | ArbServiceConfig = {}) {
    const base = cfg.baseUrl || DEFAULT_BASE_URL;
    this.api = new ApiClient(base, cfg.adminKey);
    this.workdir = path.resolve(cfg.workdir || DEFAULT_WORKDIR);
    this.pollMs = cfg.pollMs ?? 1000;
    this.syncTimeoutMs = cfg.syncTimeoutMs ?? 120_000;
    this.stateDir = path.join(this.workdir, ".mcp-state");
    // Guaranteed-empty hooks dir: every git child runs with
    // `core.hooksPath` pointing here so nothing user- or repo-installed runs.
    const hooksDir = path.join(this.workdir, ".arb-empty-hooks");
    fs.mkdirSync(this.stateDir, { recursive: true });
    fs.mkdirSync(hooksDir, { recursive: true });
    this.git = new ArbGit(cfg.exec, hooksDir);
  }

  private assertEntryId(entryId: string): void {
    if (!ENTRY_ID_RE.test(entryId)) {
      throw new Error(`invalid entryId ${JSON.stringify(entryId)}: expected "e<digits>"`);
    }
  }

  /** Resolve `p` and prove it stays inside `base` (defense in depth on top of
   * the entryId regex — also guards a hostile `entry.id` from the server). */
  private static inside(base: string, p: string): string {
    const r = path.resolve(p);
    if (r !== base && !r.startsWith(base + path.sep)) {
      throw new Error(`resolved path escapes ${base}: ${p}`);
    }
    return r;
  }

  private workspaceFor(entryId: string): string {
    return ArbService.inside(this.workdir, path.join(this.workdir, entryId));
  }

  private statePath(entryId: string): string {
    return ArbService.inside(this.stateDir, path.join(this.stateDir, `${entryId}.json`));
  }

  private loadState(entryId: string): EntryState | undefined {
    try {
      return JSON.parse(fs.readFileSync(this.statePath(entryId), "utf8"));
    } catch {
      return undefined;
    }
  }

  private saveState(st: EntryState): void {
    fs.mkdirSync(this.stateDir, { recursive: true });
    fs.writeFileSync(this.statePath(st.entryId), JSON.stringify(st, null, 2));
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

  /** Clone `entry.remote` into the workspace. The token is passed to git only
   * via environment-scoped config (GIT_CONFIG_* http.extraHeader) — never in
   * argv and never on the stored origin URL, so `.git/config` stays clean. */
  private async cloneInto(entry: Entry, token: string | undefined): Promise<string> {
    const ws = this.workspaceFor(entry.id);
    fs.rmSync(ws, { recursive: true, force: true });
    await this.git.clone(entry.remote, remoteNeedsAuth(entry.remote) ? token : undefined, ws);
    await this.git.setOrigin(ws, entry.remote);
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
    if (input.producerId !== undefined) this.assertEntryId(input.producerId);
    const created = await this.api.createEntry({
      agent: input.agent,
      lane: input.lane,
      ...(input.producerId !== undefined ? { producerId: input.producerId } : {}),
      ...(input.consumes !== undefined ? { consumes: input.consumes } : {}),
      ...(input.stub !== undefined ? { stub: input.stub } : {}),
    });
    let entry = created.entry as Entry;
    let token: string | undefined = created.token;
    let workspace: string;
    try {
      if (!entry.remote) {
        // The real control plane forks asynchronously; wait for it to land.
        const got = await this.waitForFork(entry.id, null, this.syncTimeoutMs);
        entry = got.entry;
        token = got.token ?? token;
      }
      workspace = await this.cloneInto(entry, token);
    } catch (err) {
      // The entry exists server-side even though the workspace was never
      // established — say so and route the agent at arb_sync to retry.
      throw new Error(
        `entry ${entry.id} was created but cloning its fork into the workspace failed: ` +
          `${redactCredentials((err as Error).message)} — call arb_sync with entryId "${entry.id}" to retry the clone`,
      );
    }
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
    this.assertEntryId(input.entryId);
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

  async sync(input: { entryId: string; timeoutMs?: number; force?: boolean }) {
    this.assertEntryId(input.entryId);
    const st = this.loadState(input.entryId);
    const { entry: cur } = (await this.api.getEntry(input.entryId)) as { entry: Entry };
    const ws = this.workspaceFor(input.entryId);
    const hasWs = fs.existsSync(path.join(ws, ".git"));

    // Double sync: the workspace already sits on the server's current fork —
    // matching on repo+generation (status may still read "squashed" until the
    // next push) means there is nothing to do and nothing to wait for.
    if (st && hasWs && st.repo === cur.repo && st.generation === cur.generation) {
      return {
        entryId: cur.id,
        synced: false,
        reason: "already synced",
        workspace: st.workspace,
        status: cur.status,
        generation: cur.generation,
        baseCommit: cur.baseCommit,
        headCommit: cur.headCommit,
        message: `Workspace for ${cur.id} already matches the current fork (${cur.repo}, generation ${cur.generation}); nothing to sync.`,
      };
    }

    // Re-cloning discards whatever is in the workspace. A squash means that
    // work is invalidated anyway — proceed and report it; otherwise refuse
    // unless the agent explicitly passed force.
    let dirty = false;
    let unpushed = false;
    if (hasWs) {
      dirty = await this.git.hasChanges(ws);
      unpushed = await this.git.hasUnpushedCommits(ws);
    }
    const squashed = cur.status === "squashed";
    const discarded = dirty || unpushed;
    if (discarded && !squashed && !input.force) {
      const what = [dirty ? "uncommitted changes" : "", unpushed ? "unpushed commits" : ""]
        .filter(Boolean)
        .join(" and ");
      throw new Error(
        `workspace for ${input.entryId} has ${what} which arb_sync would discard — ` +
          `call arb_push to keep them, or call arb_sync with force: true to discard them`,
      );
    }

    const timeout = input.timeoutMs ?? this.syncTimeoutMs;
    // No usable local state (missing state file or missing workspace) means a
    // plain clone of the current fork — e.g. retry after a failed register.
    const prevRepo = st && hasWs ? st.repo : null;
    const { entry, token } = await this.waitForFork(cur.id, prevRepo, timeout);
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
    if (discarded) out.discarded = true;
    if (entry.status === "squashed" || entry.diagnosis) {
      out.diagnosis = entry.diagnosis;
      out.instructions = renderSquashInstructions(entry);
    }
    return out;
  }

  async push(input: { entryId: string; message: string }) {
    this.assertEntryId(input.entryId);
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
      // The fork moved under us (squash/re-fork) or local state was lost.
      // Adopt the entry's current repo/generation only when the workspace's
      // credential-free origin proves it is already a clone of that fork;
      // pushing a workspace cloned from a different fork is never safe.
      let adopted = false;
      if (entry.status !== "squashed") {
        try {
          if ((await this.git.originUrl(ws)) === entry.remote) {
            this.saveState({
              entryId: entry.id,
              workspace: ws,
              repo: entry.repo,
              generation: entry.generation,
            });
            adopted = true;
          }
        } catch {
          /* unreadable origin -> refusal below */
        }
      }
      if (!adopted) {
        throw new Error(
          `entry ${input.entryId} was squashed (${entry.diagnosis?.reason ?? "no diagnosis"}) or re-forked and ` +
            `the workspace still holds a different fork — call arb_sync first, redo your work, then push again`,
        );
      }
    }
    if (remoteNeedsAuth(entry.remote) && !token) {
      throw new Error(
        `control plane returned no push token for ${input.entryId} — a re-fork may be in flight; retry shortly`,
      );
    }
    const committed = await this.git.commitAll(ws, input.message, entry.agent || "arb-mcp");
    await this.git.push(ws, remoteNeedsAuth(entry.remote) ? token : undefined);
    const commit = await this.git.head(ws);
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
    this.assertEntryId(input.entryId);
    const ws = this.workspaceFor(input.entryId);
    if (!fs.existsSync(path.join(ws, ".git"))) {
      throw new Error(`no workspace for ${input.entryId} at ${ws} — call arb_register first`);
    }
    if (await this.git.hasChanges(ws)) {
      throw new Error(
        `workspace for ${input.entryId} has uncommitted changes — call arb_push first so the ` +
          `commit that gets checked is actually on the entry's fork`,
      );
    }
    const commit = await this.git.head(ws);
    if (await this.git.hasUnpushedCommits(ws)) {
      throw new Error(
        `workspace HEAD ${commit.slice(0, 12)} is not on the entry's fork — call arb_push first`,
      );
    }
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
