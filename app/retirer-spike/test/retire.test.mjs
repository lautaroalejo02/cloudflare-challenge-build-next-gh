import { test } from "node:test";
import assert from "node:assert/strict";
import * as git from "isomorphic-git";
import { MemFs, NotFastForwardError } from "../src/retire.ts";

const author = { name: "t", email: "t@example.com" };
const gitdir = "/.git";

test("MemFs: write/read roundtrip (bytes + utf8)", async () => {
	const fs = new MemFs();
	await fs.writeFile("/a/b/c.txt", "hello");
	assert.equal(await fs.readFile("/a/b/c.txt", "utf8"), "hello");
	const bytes = await fs.readFile("/a/b/c.txt");
	assert.equal(new TextDecoder().decode(bytes), "hello");
	assert.ok(fs.byteSize() >= 5);
});

test("MemFs: stat/lstat/readdir semantics", async () => {
	const fs = new MemFs();
	await fs.writeFile("/d/f1", "x");
	await fs.writeFile("/d/sub/f2", "y");
	const s = await fs.stat("/d/f1");
	assert.ok(s.isFile() && !s.isDirectory() && !s.isSymbolicLink());
	assert.equal(s.size, 1);
	const sd = await fs.stat("/d");
	assert.ok(sd.isDirectory());
	assert.deepEqual((await fs.readdir("/d")).sort(), ["f1", "sub"]);
	await assert.rejects(() => fs.readdir("/d/f1"), /ENOTDIR/);
	await assert.rejects(() => fs.readFile("/d"), /EISDIR/);
	await assert.rejects(() => fs.readFile("/nope"), /ENOENT/);
});

test("MemFs: mkdir/rmdir/unlink semantics", async () => {
	const fs = new MemFs();
	await assert.rejects(() => fs.mkdir("/x/y"));
	await fs.mkdir("/x/y", { recursive: true });
	await assert.rejects(() => fs.mkdir("/x"));
	await fs.mkdir("/x", { recursive: true }); // no-op
	await fs.writeFile("/x/f", "z");
	await assert.rejects(() => fs.rmdir("/x"), /ENOTEMPTY/);
	await fs.unlink("/x/f");
	await fs.rmdir("/x/y");
	assert.equal((await fs.readdir("/x")).length, 0);
});

test("isomorphic-git on MemFs: init + add + commit + resolveRef + isDescendent", async () => {
	const fs = new MemFs();
	await git.init({ fs, dir: "/", gitdir, defaultBranch: "main" });
	const oids = [];
	for (let i = 0; i < 3; i++) {
		await fs.writeFile(`/f${i}.txt`, `content ${i}\n`);
		await git.add({ fs, dir: "/", gitdir, filepath: `f${i}.txt` });
		oids.push(await git.commit({ fs, dir: "/", gitdir, message: `c${i}`, author }));
	}
	assert.equal(await git.resolveRef({ fs, dir: "/", gitdir, ref: "main" }), oids[2]);
	assert.equal(await git.currentBranch({ fs, dir: "/", gitdir }), "main");
	assert.equal(await git.isDescendent({ fs, dir: "/", gitdir, oid: oids[2], ancestor: oids[0], depth: -1 }), true);
	// exact predicate used by fastForward: older commit does NOT descend from newer head
	assert.equal(await git.isDescendent({ fs, dir: "/", gitdir, oid: oids[0], ancestor: oids[2], depth: -1 }), false);
	// a commit does not descend from itself
	assert.equal(await git.isDescendent({ fs, dir: "/", gitdir, oid: oids[1], ancestor: oids[1], depth: -1 }), false);
});

test("MemFs satisfies isomorphic-git's fs.promises contract", async () => {
	const fs = new MemFs();
	const desc = Object.getOwnPropertyDescriptor(fs, "promises");
	assert.ok(desc && desc.enumerable, "promises must be an own enumerable property");
	assert.ok(typeof fs.promises.readFile === "function");
	const r = fs.promises.readFile(); // contract probe: must return a promise even on error
	assert.ok(typeof r.then === "function" && typeof r.catch === "function");
	await r.catch((e) => e);
});

test("NotFastForwardError carries commit + ancestor", () => {
	const e = new NotFastForwardError("a".repeat(40), "b".repeat(40));
	assert.equal(e.code, "NOT_FAST_FORWARD");
	assert.equal(e.commit, "a".repeat(40));
	assert.equal(e.ancestor, "b".repeat(40));
	assert.ok(e instanceof Error);
});
