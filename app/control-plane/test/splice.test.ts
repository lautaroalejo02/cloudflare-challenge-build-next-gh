import { test } from "node:test";
import assert from "node:assert/strict";
import { buildTree, decideSplice, overlayPaths, type FlatBlob } from "../src/splice.ts";

test("decideSplice: disjoint P and Q -> splice", () => {
	const d = decideSplice(["src/ui/checkout.ts", "tests/feature.test.ts"], ["src/api/order.ts"]);
	assert.deepEqual(d, { kind: "splice" });
});

test("decideSplice: overlapping path -> squash with sorted overlap", () => {
	const d = decideSplice(["src/api/order.ts", "src/z.ts"], ["src/api/order.ts", "src/a.ts"]);
	assert.deepEqual(d, { kind: "squash", overlap: ["src/api/order.ts"] });
});

test("decideSplice: empty P or empty Q -> splice", () => {
	assert.deepEqual(decideSplice([], ["a.ts"]), { kind: "splice" });
	assert.deepEqual(decideSplice(["a.ts"], []), { kind: "splice" });
	assert.deepEqual(decideSplice([], []), { kind: "splice" });
});

test("decideSplice: duplicate paths and multi-overlap are normalized", () => {
	const d = decideSplice(["b.ts", "a.ts", "a.ts"], ["c.ts", "a.ts", "b.ts"]);
	assert.deepEqual(d, { kind: "squash", overlap: ["a.ts", "b.ts"] });
});

const B = (oid: string): FlatBlob => ({ mode: "100644", oid });

test("overlayPaths: entry blobs win on P, deletions remove, rest keeps trunk", () => {
	const trunk = new Map<string, FlatBlob>([
		["src/api/order.ts", B("t1")],
		["src/ui/checkout.ts", B("t2")],
		["old.ts", B("t3")],
	]);
	const entry = new Map<string, FlatBlob>([
		["src/api/order.ts", B("e1")],
		["src/ui/checkout.ts", B("t2")],
		["new.ts", B("e4")],
	]);
	const p = new Set(["src/api/order.ts", "new.ts", "old.ts"]); // api changed, new added, old deleted
	const merged = overlayPaths(trunk, entry, p);
	assert.equal(merged.get("src/api/order.ts")!.oid, "e1"); // overlaid
	assert.equal(merged.get("new.ts")!.oid, "e4"); // added
	assert.equal(merged.has("old.ts"), false); // deleted by the entry
	assert.equal(merged.get("src/ui/checkout.ts")!.oid, "t2"); // trunk version kept (not in P)
});

test("buildTree: flat paths -> nested nodes", () => {
	const flat = new Map<string, FlatBlob>([
		["a.ts", B("1")],
		["src/api/order.ts", B("2")],
		["src/ui/checkout.ts", B("3")],
	]);
	const root = buildTree(flat);
	assert.equal(root.blobs.get("a.ts")!.oid, "1");
	assert.equal(root.subtrees.get("src")!.subtrees.get("api")!.blobs.get("order.ts")!.oid, "2");
	assert.equal(root.subtrees.get("src")!.subtrees.get("ui")!.blobs.get("checkout.ts")!.oid, "3");
});

// --- T19 review F7: file/dir conflicts --------------------------------------------

test("decideSplice: a file vs a directory at the same prefix overlaps (F7)", () => {
	// Entry turned `src/a` into a file; trunk added `src/a/b.ts` under a dir.
	assert.deepEqual(decideSplice(["src/a"], ["src/a/b.ts"]), { kind: "squash", overlap: ["src/a", "src/a/b.ts"] });
	assert.deepEqual(decideSplice(["src/a/b.ts"], ["src/a"]), { kind: "squash", overlap: ["src/a", "src/a/b.ts"] });
});

test("decideSplice: a shared string prefix that is not a directory boundary stays disjoint (F7)", () => {
	assert.deepEqual(decideSplice(["src/ab.ts"], ["src/a"]), { kind: "splice" });
	assert.deepEqual(decideSplice(["src/a.ts"], ["src/a/b.ts"]), { kind: "splice" });
});

test("buildTree: gitlink entries survive with their commit type (F7)", () => {
	const flat = new Map<string, FlatBlob>([["vendor/lib", { mode: "160000", oid: "c".repeat(40), type: "commit" }]]);
	const root = buildTree(flat);
	assert.deepEqual(root.subtrees.get("vendor")!.blobs.get("lib"), { mode: "160000", oid: "c".repeat(40), type: "commit" });
});
