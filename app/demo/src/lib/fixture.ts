import fs from "node:fs";
import path from "node:path";

export function copyDir(src: string, dst: string): void {
  fs.mkdirSync(dst, { recursive: true });
  for (const e of fs.readdirSync(src, { withFileTypes: true })) {
    const s = path.join(src, e.name);
    const d = path.join(dst, e.name);
    if (e.isDirectory()) copyDir(s, d);
    else fs.copyFileSync(s, d);
  }
}

// Make `dir` (a git worktree) hold exactly the fixture tree. /api/reset does
// not delete repos, so arb-trunk accumulates files retired by earlier runs;
// copying over the old worktree would keep them (observed live: a stale
// retired feature test riding into the seed commit, then into every fork).
// Deleting everything except .git first makes the seed a true reset.
export function syncFixture(dir: string, fixtureDir: string): void {
  for (const e of fs.readdirSync(dir)) {
    if (e === ".git") continue;
    fs.rmSync(path.join(dir, e), { recursive: true, force: true });
  }
  copyDir(fixtureDir, dir);
}
