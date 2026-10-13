import { test } from "node:test";
import assert from "node:assert/strict";
import * as git from "isomorphic-git";
import { MemFs, diffPaths, flattenTree, writeTreeNode } from "../src/retire.ts";
import { buildTree, decideSplice, overlayPaths } from "../src/splice.ts";

const AUTHOR = { name: "t", email: "t@example.com" };
const GITDIR = "/.git";
const enc = (s: string) => new TextEncoder().encode(s);

/** Commit all files currently in the MemFs workdir on top of HEAD's parent. */
async function commitAll(fs: MemFs, files: Record<string, string>, message: string): Promise<string> {
	for (const [p, content] of Object.entries(files)) {
		await fs.writeFile(`/${p}`, content);
		await git.add({ fs, dir: "/", gitdir: GITDIR, filepath: p });
	}
	return git.commit({ fs, dir: "/", gitdir: GITDIR, message, author: AUTHOR });
}

/** Build a commit object directly (no index/workdir) with an explicit parent. */
async function commitTree(
	fs: MemFs,
	flat: Map<string, { mode: string; oid: string }>,
	parent: string,
	message: string,
): Promise<string> {
	const tree = await writeTreeNode(fs, buildTree(flat));
	const now = Math.floor(Date.now() / 1000);
	return git.writeCommit({
		fs, dir: "/", gitdir: GITDIR,
		commit: {
			message, tree, parent: [parent],
			author: { ...AUTHOR, timestamp: now, timezoneOffset: 0 },
			committer: { ...AUTHOR, timestamp: now, timezoneOffset: 0 },
		},
	});
}

/**
 * Repo state per the demo scenario: T0 fixture; trunk = T0 + api change;
 * entry head = T0 + ui change + new test (a sibling of trunk, not a
 * descendant — the case that forced the splice decision).
 */
async function siblingRepo(): Promise<{ fs: MemFs; t0: string; trunk: string; entry: string }> {
	const fs = new MemFs();
	await git.init({ fs, dir: "/", gitdir: GITDIR, defaultBranch: "main" });
	const t0 = await commitAll(fs, {
		"src/api/order.ts": "export function createOrder() {}\n",
		"src/ui/checkout.ts": "export function render() {}\n",
		"tests/order.test.ts": "export async function run() { return []; }\n",
	}, "t0");
	// Trunk child: api work (like the retired producer).
	const trunk = await commitAll(fs, {
		"src/api/order.ts": "export function createOrder(cart: number) {}\n",
	}, "api v2");
	// Entry sibling of trunk: built directly on T0 with disjoint work.
	const flat = await flattenTree(fs, t0);
	const checkout = await git.writeBlob({ fs, dir: "/", gitdir: GITDIR, blob: enc("export function render() { return 2; }\n") });
	const feature = await git.writeBlob({ fs, dir: "/", gitdir: GITDIR, blob: enc("export async function run() { return [{name:'f',ok:true}]; }\n") });
	flat.set("src/ui/checkout.ts", { mode: "100644", oid: checkout });
	flat.set("tests/create-order.feature.test.ts", { mode: "100644", oid: feature });
	const entry = await commitTree(fs, flat, t0, "ui work on stale base");
	return { fs, t0, trunk, entry };
}

test("diffPaths: leaf paths changed between two commits", async () => {
	const { fs, t0, trunk, entry } = await siblingRepo();
	assert.deepEqual([...(await diffPaths(fs, t0, trunk))].sort(), ["src/api/order.ts"]);
	assert.deepEqual(
		[...(await diffPaths(fs, t0, entry))].sort(),
		["src/ui/checkout.ts", "tests/create-order.feature.test.ts"],
	);
	// symmetric: the reverse direction reports the same set
	assert.deepEqual([...(await diffPaths(fs, trunk, t0))].sort(), ["src/api/order.ts"]);
});

test("splice: disjoint siblings produce a commit on the trunk head with both changes", async () => {
	const { fs, t0, trunk, entry } = await siblingRepo();
	// entry head does NOT descend from trunk head -> the ff path is impossible
	assert.equal(await git.isDescendent({ fs, dir: "/", gitdir: GITDIR, oid: entry, ancestor: trunk, depth: -1 }), false);

	const p = await diffPaths(fs, t0, entry);
	const q = await diffPaths(fs, t0, trunk);
	assert.equal(decideSplice(p, q).kind, "splice");

	const merged = overlayPaths(await flattenTree(fs, trunk), await flattenTree(fs, entry), p);
	const candidate = await commitTree(fs, merged, trunk, "splice");

	const meta = await git.readCommit({ fs, dir: "/", gitdir: GITDIR, oid: candidate });
	assert.deepEqual(meta.commit.parent, [trunk]);
	assert.equal(await git.isDescendent({ fs, dir: "/", gitdir: GITDIR, oid: candidate, ancestor: trunk, depth: -1 }), true);

	const tree = await flattenTree(fs, candidate);
	assert.deepEqual(
		Object.fromEntries([...tree].map(([k, v]) => [k, v.oid])),
		Object.fromEntries([
			["src/api/order.ts", (await flattenTree(fs, trunk)).get("src/api/order.ts")!.oid], // trunk wins
			["src/ui/checkout.ts", (await flattenTree(fs, entry)).get("src/ui/checkout.ts")!.oid], // entry overlaid
			["tests/create-order.feature.test.ts", (await flattenTree(fs, entry)).get("tests/create-order.feature.test.ts")!.oid],
			["tests/order.test.ts", (await flattenTree(fs, t0)).get("tests/order.test.ts")!.oid],
		]),
	);
});

test("splice: overlapping paths are reported for trunk-overlap squash", async () => {
	const { fs, t0, trunk } = await siblingRepo();
	// An entry head that also touched src/api/order.ts.
	const flat = await flattenTree(fs, t0);
	const api = await git.writeBlob({ fs, dir: "/", gitdir: GITDIR, blob: enc("export function createOrder(x: string) {}\n") });
	flat.set("src/api/order.ts", { mode: "100644", oid: api });
	const entry = await commitTree(fs, flat, t0, "conflicting api work");

	const p = await diffPaths(fs, t0, entry);
	const q = await diffPaths(fs, t0, trunk);
	assert.deepEqual(decideSplice(p, q), { kind: "squash", overlap: ["src/api/order.ts"] });
});

test("splice: an entry-deleted path disappears from the spliced tree", async () => {
	const fs = new MemFs();
	await git.init({ fs, dir: "/", gitdir: GITDIR, defaultBranch: "main" });
	const t0 = await commitAll(fs, { "keep.ts": "k\n", "drop.ts": "d\n", "dir/nested.ts": "n\n" }, "t0");
	const trunk = await commitAll(fs, { "keep.ts": "k2\n" }, "trunk moved");
	// entry deletes drop.ts (P includes it; entry head lacks the blob)
	const flat = await flattenTree(fs, t0);
	flat.delete("drop.ts");
	const entry = await commitTree(fs, flat, t0, "drop a file");

	const p = await diffPaths(fs, t0, entry);
	assert.ok(p.has("drop.ts"));
	assert.equal(decideSplice(p, await diffPaths(fs, t0, trunk)).kind, "splice");

	const merged = overlayPaths(await flattenTree(fs, trunk), await flattenTree(fs, entry), p);
	const candidate = await commitTree(fs, merged, trunk, "splice");
	const tree = await flattenTree(fs, candidate);
	assert.equal(tree.has("drop.ts"), false);
	assert.equal(tree.get("keep.ts")!.oid, (await flattenTree(fs, trunk)).get("keep.ts")!.oid);
	assert.ok(tree.has("dir/nested.ts"));
});
