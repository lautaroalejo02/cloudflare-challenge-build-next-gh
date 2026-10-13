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
    });
    resolveId(entry.id);
    opts.log(`registered ${entry.id} seq=${entry.seq} lane=${entry.lane} repo=${entry.repo}`);

    let lastToken = token;
    let gen = -1;
    let dir = "";
    let fixUsed = false;
    let failedPolls = 0;
    const deadline = Date.now() + timeoutMs;

    while (Date.now() < deadline) {
      const { entry: e, token: fresh } = await opts.api.getEntry(entry.id);
      if (fresh) lastToken = fresh;

      if (e.generation !== gen) {
        gen = e.generation;
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
          const sha = await commitAll(dir, step.message, opts.agent);
          await push(dir);
          opts.log(`pushed ${sha.slice(0, 8)} "${step.message}" (gen ${gen})`);
        }
        if (!aborted) {
          try {
            await opts.api.ready(entry.id, await head(dir));
            opts.log(`marked ready (gen ${gen})`);
          } catch (err) {
            opts.log(`ready rejected: ${(err as Error).message}`);
          }
        }
        continue;
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
            await push(dir);
            try {
              await opts.api.ready(entry.id, sha);
            } catch {}
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
