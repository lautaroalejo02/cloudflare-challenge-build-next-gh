import fs from "node:fs";
import path from "node:path";
import type { ApiClient } from "../lib/http.ts";
import { cloneRepo, commitAll, head, push } from "../lib/git.ts";
import type { CheckResult, Diagnosis, Entry, Log } from "../lib/types.ts";

export interface Step {
  delayMs?: number;
  message: string;
  apply: (dir: string) => void;
}

export interface AgentOptions {
  api: ApiClient;
  agent: string;
  lane: string;
  producerId?: string;
  consumes?: string[];
  /** Declared-stub value prediction: sources the producer commits to export. */
  stub?: Record<string, string>;
  workRoot: string;
  log: Log;
  pollMs?: number;
  timeoutMs?: number;
  stepsFor: (generation: number, diagnosis: Diagnosis | null) => Step[];
  fixForFailure?: (dir: string, checks: CheckResult | null) => Step | null;
}

export interface AgentHandle {
  entryId: Promise<string>;
  done: Promise<Entry>;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// Generic scripted-agent state machine:
//   register -> clone fork -> apply scripted steps -> push -> mark ready ->
//   poll entry every pollMs; on generation change (squash/re-fork) re-clone the
//   new fork and re-apply the work adapted via stepsFor(); on "failed" checks
//   optionally apply fixForFailure() and re-push.
export function startAgent(opts: AgentOptions): AgentHandle {
  const pollMs = opts.pollMs ?? 1000;
  const timeoutMs = opts.timeoutMs ?? 5 * 60_000;
  let resolveId!: (id: string) => void;
  let rejectId!: (e: unknown) => void;
  const entryId = new Promise<string>((res, rej) => {
    resolveId = res;
    rejectId = rej;
  });
  entryId.catch(() => {});
  const done = run().catch((e) => {
    rejectId(e);
    throw e;
  });
  return { entryId, done };

  async function run(): Promise<Entry> {
    const { entry, token } = await opts.api.createEntry({
      agent: opts.agent,
      lane: opts.lane,
      producerId: opts.producerId,
      consumes: opts.consumes,
      stub: opts.stub,
    });
    resolveId(entry.id);
    opts.log(`registered ${entry.id} seq=${entry.seq} lane=${entry.lane} repo=${entry.repo}`);
    if (entry.predicted?.length) opts.log(`declared stub: predicted exports [${entry.predicted.join(", ")}]`);

    let lastToken = token;
    let gen = -1;
    let lastRepo = "";
    let dir = "";
    let readySha: string | null = null;
    let fixUsed = false;
    let failedPolls = 0;
    const deadline = Date.now() + timeoutMs;

    while (Date.now() < deadline) {
      const { entry: e, token: fresh } = await opts.api.getEntry(entry.id);
      if (fresh) lastToken = fresh;

      // Re-clone whenever the entry points at a different repo: the initial
      // fork and every squash re-fork. Keying on `e.repo` (not `e.generation`)
      // avoids cloning the stale fork in the window where the generation has
      // bumped but the re-fork has not landed yet (real plane reforks are
      // async — the mock was fast enough to hide this).
      if (e.repo !== lastRepo) {
        lastRepo = e.repo;
        gen = e.generation;
        readySha = null;
        fixUsed = false;
        failedPolls = 0;
        dir = path.join(opts.workRoot, `${entry.id}-g${gen}`);
        fs.rmSync(dir, { recursive: true, force: true });
        opts.log(`cloning ${e.repo} -> ${path.basename(dir)} (generation ${gen})`);
        await cloneRepo(e.remote, lastToken, dir);
        if (e.diagnosis) {
          for (const c of e.diagnosis.changed) {
            opts.log(`squashed: ${c.symbol} ${c.oldSignature} -> ${c.newSignature}`);
          }
        }
        let aborted = false;
        for (const step of opts.stepsFor(gen, e.diagnosis)) {
          if (step.delayMs) await sleep(step.delayMs);
          const cur = await opts.api.getEntry(entry.id);
          if (cur.entry.generation !== gen) {
            aborted = true;
            break;
          }
          step.apply(dir);
          // Trunk may already contain this work (runs accumulate): an
          // idempotent re-apply produces no staged diff — nothing to push.
          const sha = await commitAll(dir, step.message, opts.agent);
          if (sha === null) {
            opts.log(`nothing to commit for "${step.message}" - already on base`);
            continue;
          }
          await push(dir);
          opts.log(`pushed ${sha.slice(0, 8)} "${step.message}" (gen ${gen})`);
        }
        if (!aborted) readySha = await head(dir);
        continue;
      }

      // Ready races the push pipeline: a push takes seconds to be detected,
      // so `entry.ready` for a just-pushed commit is 409ed until headCommit
      // catches up. Retry while the entry head still equals our push.
      // "squashed" is included for the no-op case: when nothing needed
      // re-applying, the entry readies its re-forked base (head === base).
      if (readySha && e.headCommit === readySha && (e.status === "speculating" || e.status === "squashed")) {
        try {
          await opts.api.ready(entry.id, readySha);
          opts.log(`marked ready (gen ${gen})`);
          readySha = null;
        } catch (err) {
          opts.log(`ready rejected: ${(err as Error).message}`);
        }
      }

      if (e.status === "retired") {
        opts.log(`retired seq=${e.seq}`);
        return e;
      }
      if (e.status === "vetoed") throw new Error(`${entry.id} was vetoed`);

      if (e.status === "failed") {
        failedPolls++;
        if (!fixUsed && opts.fixForFailure) {
          const step = opts.fixForFailure(dir, e.checks);
          if (step) {
            fixUsed = true;
            opts.log(`checks failed (${e.checks?.failed ?? "?"} failing) - applying scripted fix`);
            step.apply(dir);
            const sha = await commitAll(dir, step.message, opts.agent);
            if (sha !== null) {
              await push(dir);
              readySha = sha; // posted on the next polls once headCommit catches up
            }
          }
        } else if (failedPolls >= 5) {
          throw new Error(`${entry.id} checks keep failing`);
        }
      }
      await sleep(pollMs);
    }
    throw new Error(`${entry.id} timed out after ${Math.round(timeoutMs / 1000)}s`);
  }
}
