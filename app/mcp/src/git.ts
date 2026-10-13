import { execFile } from "node:child_process";
import { rmSync } from "node:fs";
import { promisify } from "node:util";
import { isTransientGitError, redactCredentials } from "../../demo/src/lib/git.ts";

// Local git wrapper for the MCP server. The demo's lib/git.ts puts the token in
// argv (`x:<token>@host`), where it is visible to hooks ($2 of pre-push), `ps`,
// and error text. Here the credential travels only in environment-scoped git
// config (GIT_CONFIG_*), hooks are disabled outright, and secrets are stripped
// from the child environment.

export type GitExec = (
  file: string,
  args: string[],
  options: {
    cwd?: string;
    env: Record<string, string | undefined>;
    maxBuffer?: number;
  },
) => Promise<{ stdout: string | Buffer; stderr: string | Buffer }>;

const defaultExec = promisify(execFile) as unknown as GitExec;

const RETRY_DELAYS_MS = [500, 1500, 4000];

export async function withRetry<T>(op: () => Promise<T>, beforeRetry?: () => void): Promise<T> {
  for (let attempt = 0; ; attempt++) {
    try {
      return await op();
    } catch (err) {
      const delay = RETRY_DELAYS_MS[attempt];
      if (delay === undefined || !isTransientGitError((err as Error).message)) throw err;
      beforeRetry?.();
      await new Promise((r) => setTimeout(r, delay));
    }
  }
}

/** Child env: prompting disabled so a missing credential fails instead of
 * hanging, secrets (ARB admin key, TypeSafe keys) removed, and ambient
 * GIT_CONFIG_* cleared so the ones we set are authoritative. */
function childEnv(): Record<string, string | undefined> {
  const env: Record<string, string | undefined> = { ...process.env, GIT_TERMINAL_PROMPT: "0" };
  for (const k of Object.keys(env)) {
    if (k === "ARB_ADMIN_KEY" || k.startsWith("TYPESAFE_") || /^GIT_CONFIG_(COUNT|KEY_\d+|VALUE_\d+)$/.test(k)) {
      delete env[k];
    }
  }
  return env;
}

/** Artifacts accepts the same Basic credential the `x:<token>@host` URL form
 * produces (username ignored, token secret as password — the `?expires=`
 * suffix is stripped). Sent as `http.extraHeader` so it never touches argv,
 * the remote URL or `.git/config`. */
function injectAuth(env: Record<string, string | undefined>, token: string): void {
  const secret = token.split("?")[0];
  env.GIT_CONFIG_COUNT = "1";
  env.GIT_CONFIG_KEY_0 = "http.extraHeader";
  env.GIT_CONFIG_VALUE_0 = `Authorization: Basic ${Buffer.from(`x:${secret}`).toString("base64")}`;
}

export interface GitRunOptions {
  cwd?: string;
  /** Repo write/read token; carried in env config, never argv. */
  token?: string;
}

export class ArbGit {
  private readonly exec: GitExec;
  /** Existing empty directory used as core.hooksPath so no hook — from a
   * template, a global config or the source repo — can run against our
   * workspaces or see our argv/env. */
  private readonly hooksDir: string;

  constructor(exec: GitExec = defaultExec, hooksDir: string) {
    this.exec = exec;
    this.hooksDir = hooksDir;
  }

  async run(args: string[], opts: GitRunOptions = {}): Promise<string> {
    const env = childEnv();
    if (opts.token) injectAuth(env, opts.token);
    const argv = [
      "-c",
      `core.hooksPath=${this.hooksDir.replaceAll("\\", "/")}`,
      "-c",
      "core.fsmonitor=false",
      ...args,
    ];
    const scrub = (s: string): string =>
      opts.token ? redactCredentials(s).split(opts.token).join("***") : redactCredentials(s);
    try {
      const { stdout } = await this.exec("git", argv, {
        cwd: opts.cwd,
        env,
        maxBuffer: 32 * 1024 * 1024,
      });
      return String(stdout).trim();
    } catch (err) {
      const e = err as Error & { stderr?: unknown };
      e.message = scrub(`${e.message}${e.stderr ? `\n${String(e.stderr)}` : ""}`);
      if (e.stack) e.stack = scrub(e.stack);
      throw e;
    }
  }

  clone(remote: string, token: string | undefined, dir: string): Promise<void> {
    // A failed clone can leave a partial dir behind, which makes a retry fail.
    return withRetry(
      async () => void (await this.run(["clone", "--quiet", remote, dir], { token })),
      () => rmSync(dir, { recursive: true, force: true }),
    );
  }

  /** Push `HEAD` to `origin main`; transient failures (5xx/429/network) retried. */
  push(dir: string, token: string | undefined): Promise<void> {
    return withRetry(() => this.run(["-C", dir, "push", "-q", "origin", "HEAD:main"], { token }).then(() => undefined));
  }

  /** Stage everything and commit if the staged tree differs from HEAD.
   * Returns the new head sha, or null when there was nothing to commit. */
  async commitAll(dir: string, message: string, author: string): Promise<string | null> {
    await this.run(["-C", dir, "add", "-A"]);
    let stagedEmpty = true;
    try {
      await this.run(["-C", dir, "diff", "--cached", "--quiet"]);
    } catch {
      stagedEmpty = false; // exit 1 = staged changes exist
    }
    if (stagedEmpty) return null;
    await this.run([
      "-C", dir,
      "-c", `user.email=${author}@arb.local`,
      "-c", `user.name=${author}`,
      "commit", "-q", "-m", message,
    ]);
    return this.head(dir);
  }

  head(dir: string): Promise<string> {
    return this.run(["-C", dir, "rev-parse", "HEAD"]);
  }

  /** Uncommitted changes (staged, unstaged or untracked). */
  async hasChanges(dir: string): Promise<boolean> {
    return (await this.run(["-C", dir, "status", "--porcelain"])) !== "";
  }

  /** HEAD commits not contained in `origin/main` (or any commit at all when
   * the remote-tracking ref is absent, e.g. a never-pushed repo). */
  async hasUnpushedCommits(dir: string): Promise<boolean> {
    try {
      await this.run(["-C", dir, "rev-parse", "--verify", "HEAD"]);
    } catch {
      return false; // no commits at all
    }
    try {
      await this.run(["-C", dir, "merge-base", "--is-ancestor", "HEAD", "origin/main"]);
      return false;
    } catch {
      return true;
    }
  }

  originUrl(dir: string): Promise<string> {
    return this.run(["-C", dir, "remote", "get-url", "origin"]);
  }

  setOrigin(dir: string, remote: string): Promise<string> {
    return this.run(["-C", dir, "remote", "set-url", "origin", remote]);
  }
}
