import { execFile } from "node:child_process";
import { rmSync } from "node:fs";
import { promisify } from "node:util";

const execFileP = promisify(execFile);
const GIT_ENV = { ...process.env, GIT_TERMINAL_PROMPT: "0" };

const RETRY_DELAYS_MS = [500, 1500, 4000];

/** Replace `user:token@` in any URL so tokens never reach logs or the screen. */
export function redactCredentials(text: string): string {
  return text.replace(/(https?:\/\/)[^\s/@]+@/g, "$1***@");
}

/** Server-side (5xx, 429) and network failures are worth retrying; auth,
 * not-found and non-fast-forward rejections are not. Artifacts occasionally
 * answers a clone of a just-created fork with HTTP 500 (spikes/SPIKES.md). */
export function isTransientGitError(message: string): boolean {
  return (
    /HTTP (5\d\d|429)\b/.test(message) ||
    /returned error: (5\d\d|429)\b/.test(message) ||
    /expected 'packfile'|early EOF|Could not resolve host|Connection (reset|timed out)|Operation timed out/i.test(message)
  );
}

export async function git(args: string[], cwd?: string): Promise<string> {
  try {
    const { stdout } = await execFileP("git", args, {
      cwd,
      env: GIT_ENV,
      maxBuffer: 32 * 1024 * 1024,
    });
    return String(stdout).trim();
  } catch (err) {
    const e = err as Error & { stderr?: unknown };
    e.message = redactCredentials(`${e.message}${e.stderr ? `\n${String(e.stderr)}` : ""}`);
    if (e.stack) e.stack = redactCredentials(e.stack);
    throw e;
  }
}

async function withRetry<T>(op: () => Promise<T>, beforeRetry?: () => void): Promise<T> {
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

// CONTRACTS "Git auth": https://x:<token>@<remote-host>/<path>, token with the
// "?expires=" suffix stripped. file:// remotes (the local mock) take no auth.
export function authUrl(remote: string, token: string): string {
  if (!remote.includes("://") || remote.startsWith("file:")) return remote;
  const u = new URL(remote);
  u.username = "x";
  u.password = token.split("?")[0];
  return u.toString();
}

export async function cloneRepo(remote: string, token: string, dir: string): Promise<void> {
  // A failed clone can leave a partial dir behind, which makes the retry fail.
  await withRetry(
    () => git(["clone", "--quiet", authUrl(remote, token), dir]),
    () => rmSync(dir, { recursive: true, force: true }),
  );
}

export async function hasChanges(dir: string): Promise<boolean> {
  return (await git(["-C", dir, "status", "--porcelain"])) !== "";
}

/** Stage everything and commit if the staged tree differs from HEAD.
 * Returns the new head sha, or null when there was nothing to commit
 * (idempotent re-apply on a base that already contains the change — the
 * staged diff is authoritative, unlike porcelain status which can report
 * EOL-normalized worktree noise under core.autocrlf). */
export async function commitAll(dir: string, message: string, author: string): Promise<string | null> {
  await git(["-C", dir, "add", "-A"]);
  let stagedEmpty = true;
  try {
    await git(["-C", dir, "diff", "--cached", "--quiet"]);
  } catch {
    stagedEmpty = false; // exit 1 = staged changes exist
  }
  if (stagedEmpty) return null;
  await git([
    "-C", dir,
    "-c", `user.email=${author}@arb.local`,
    "-c", `user.name=${author}`,
    "commit", "-q", "-m", message,
  ]);
  return head(dir);
}

export async function push(dir: string): Promise<void> {
  await withRetry(() => git(["-C", dir, "push", "-q", "origin", "HEAD:main"]));
}

export function head(dir: string): Promise<string> {
  return git(["-C", dir, "rev-parse", "HEAD"]);
}
