import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { copyDir, syncFixture } from "../src/lib/fixture.ts";
import { commitAll, git, hasChanges } from "../src/lib/git.ts";

const DEMO_DIR = path.resolve(import.meta.dirname, "..");
const FIXTURE_DIR = path.join(DEMO_DIR, "fixture");
const TMP = path.join(DEMO_DIR, "tmp");

function fixtureFiles(): string[] {
  const out: string[] = [];
  const walk = (d: string, p: string) => {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const rel = p ? `${p}/${e.name}` : e.name;
      if (e.isDirectory()) walk(path.join(d, e.name), rel);
      else out.push(rel);
    }
  };
  walk(FIXTURE_DIR, "");
  return out.sort();
}

// Regression for the live-run defect: arb-trunk accumulates retired files
// (/api/reset does not delete repos). The old seeder copied the fixture over
// the existing clone, so stale files — e.g. a previously retired feature
// test — rode into the seed commit and every fork inherited them, making the
// tests agent's re-apply a byte-identical no-op.
test("syncFixture makes the tree identical to fixture/, deleting stale files", async () => {
  const dir = path.join(TMP, `fixsync-${Date.now()}-${process.pid}`);
  fs.rmSync(dir, { recursive: true, force: true });
  fs.mkdirSync(dir, { recursive: true });
  await git(["init", "-b", "main"], dir);
  copyDir(FIXTURE_DIR, dir);
  // Simulate content retired by a previous run that is not part of the fixture.
  fs.writeFileSync(path.join(dir, "tests", "stale.test.ts"), "export {};\n");
  fs.writeFileSync(path.join(dir, "stale-extra.ts"), "export {};\n");
  fs.mkdirSync(path.join(dir, "stale-dir"));
  fs.writeFileSync(path.join(dir, "stale-dir", "nested.ts"), "export {};\n");
  await commitAll(dir, "stale leftovers", "arb-test");

  syncFixture(dir, FIXTURE_DIR);
  assert.equal(await hasChanges(dir), true); // the deletions are real changes

  const sha = await commitAll(dir, "chore: seed fixture", "arb-test");
  assert.ok(sha);
  const tracked = (await git(["-C", dir, "ls-tree", "-r", "--name-only", "HEAD"]))
    .split("\n")
    .filter(Boolean)
    .sort();
  assert.deepEqual(tracked, fixtureFiles());
  // Content matches the fixture byte-for-byte, worktree clean.
  assert.equal(await hasChanges(dir), false);
});

// Idempotence: syncing onto an already-clean tree produces no changes, so the
// seeder takes the "trunk already contains the fixture" path.
test("syncFixture on a clean fixture tree reports no changes", async () => {
  const dir = path.join(TMP, `fixsync-clean-${Date.now()}-${process.pid}`);
  fs.rmSync(dir, { recursive: true, force: true });
  fs.mkdirSync(dir, { recursive: true });
  await git(["init", "-b", "main"], dir);
  copyDir(FIXTURE_DIR, dir);
  await commitAll(dir, "seed", "arb-test");

  syncFixture(dir, FIXTURE_DIR);
  assert.equal(await hasChanges(dir), false);
});
