import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileP = promisify(execFile);
const GIT_ENV = { ...process.env, GIT_TERMINAL_PROMPT: "0" };

export async function git(args: string[], cwd?: string): Promise<string> {
  const { stdout } = await execFileP("git", args, {
    cwd,
    env: GIT_ENV,
    maxBuffer: 32 * 1024 * 1024,
  });
  return String(stdout).trim();
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
  await git(["clone", "--quiet", authUrl(remote, token), dir]);
}

export async function hasChanges(dir: string): Promise<boolean> {
  return (await git(["-C", dir, "status", "--porcelain"])) !== "";
}

export async function commitAll(dir: string, message: string, author: string): Promise<string> {
  await git(["-C", dir, "add", "-A"]);
  await git([
    "-C", dir,
    "-c", `user.email=${author}@arb.local`,
    "-c", `user.name=${author}`,
    "commit", "-q", "-m", message,
  ]);
  return head(dir);
}

export async function push(dir: string): Promise<void> {
  await git(["-C", dir, "push", "-q", "origin", "HEAD:main"]);
}

export function head(dir: string): Promise<string> {
  return git(["-C", dir, "rev-parse", "HEAD"]);
}
