// Path-disjoint splice decision, per odd/tasks/agent-reorder-buffer.md
// ("Decision: retirement when fast-forward is impossible"). Pure logic, no
// git or Cloudflare imports: the retirer (src/retire.ts) computes the path
// sets and feeds them here.

export type SpliceDecision = { kind: "splice" } | { kind: "squash"; overlap: string[] };

/** Every proper ancestor directory of `path` ("a/b/c.ts" -> ["a", "a/b"]). */
function ancestors(path: string): string[] {
	const parts = path.split("/");
	const out: string[] = [];
	for (let i = 1; i < parts.length; i++) out.push(parts.slice(0, i).join("/"));
	return out;
}

/**
 * P = paths the entry changed vs its `baseCommit`; Q = paths trunk changed
 * since that base. Disjoint changes commute, so only P ∩ Q = ∅ can be
 * spliced; any overlap squashes the entry (`trunk-overlap`) so its agent
 * re-applies the change on a fresh fork.
 *
 * Two paths overlap when they are equal OR one is a directory prefix of the
 * other (T19, review F7): `src/a` (a file) vs `src/a/b.ts` (a file under a
 * directory of the same name) cannot both exist in one tree. Both sides of
 * such a pair are reported.
 */
export function decideSplice(p: Iterable<string>, q: Iterable<string>): SpliceDecision {
	const ps = new Set(p);
	const qs = new Set(q);
	const overlap = new Set<string>();
	for (const x of ps) {
		if (qs.has(x)) overlap.add(x);
		for (const a of ancestors(x)) {
			if (qs.has(a)) {
				overlap.add(x);
				overlap.add(a);
			}
		}
	}
	for (const y of qs) {
		for (const a of ancestors(y)) {
			if (ps.has(a)) {
				overlap.add(y);
				overlap.add(a);
			}
		}
	}
	const sorted = [...overlap].sort();
	return sorted.length > 0 ? { kind: "squash", overlap: sorted } : { kind: "splice" };
}

/** A leaf entry in a flattened git tree (path -> blob or gitlink). */
export interface FlatBlob {
	/** git file mode, e.g. "100644" | "100755" | "120000" | "160000". */
	mode: string;
	oid: string;
	/** "commit" for a gitlink (submodule pointer, mode 160000); absent = blob. */
	type?: "blob" | "commit";
}

/**
 * Start from the trunk tree (`base`) and overlay `paths` taken from the
 * entry head (`overlay`). A path listed in `paths` but absent from `overlay`
 * is deleted — the entry removed it.
 */
export function overlayPaths(
	base: ReadonlyMap<string, FlatBlob>,
	overlay: ReadonlyMap<string, FlatBlob>,
	paths: Iterable<string>,
): Map<string, FlatBlob> {
	const out = new Map(base);
	for (const path of new Set(paths)) {
		const e = overlay.get(path);
		if (e) out.set(path, e);
		else out.delete(path);
	}
	return out;
}

/** Nested tree shape; src/retire.ts renders it via git.writeTree per level. */
export interface TreeNode {
	blobs: Map<string, FlatBlob>;
	subtrees: Map<string, TreeNode>;
}

export function buildTree(flat: ReadonlyMap<string, FlatBlob>): TreeNode {
	const root: TreeNode = { blobs: new Map(), subtrees: new Map() };
	for (const [path, blob] of flat) {
		const parts = path.split("/");
		const file = parts.pop()!;
		let node = root;
		for (const part of parts) {
			let sub = node.subtrees.get(part);
			if (!sub) {
				sub = { blobs: new Map(), subtrees: new Map() };
				node.subtrees.set(part, sub);
			}
			node = sub;
		}
		node.blobs.set(file, blob);
	}
	return root;
}
