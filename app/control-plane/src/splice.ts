// Path-disjoint splice decision, per odd/tasks/agent-reorder-buffer.md
// ("Decision: retirement when fast-forward is impossible"). Pure logic, no
// git or Cloudflare imports: the retirer (src/retire.ts) computes the path
// sets and feeds them here.

export type SpliceDecision = { kind: "splice" } | { kind: "squash"; overlap: string[] };

/**
 * P = paths the entry changed vs its `baseCommit`; Q = paths trunk changed
 * since that base. Disjoint changes commute, so only P ∩ Q = ∅ can be
 * spliced; any overlap squashes the entry (`trunk-overlap`) so its agent
 * re-applies the change on a fresh fork.
 */
export function decideSplice(p: Iterable<string>, q: Iterable<string>): SpliceDecision {
	const qs = new Set(q);
	const overlap = [...new Set(p)].filter((x) => qs.has(x)).sort();
	return overlap.length > 0 ? { kind: "squash", overlap } : { kind: "splice" };
}

/** A blob entry in a flattened git tree (path -> blob). */
export interface FlatBlob {
	/** git file mode, e.g. "100644" | "100755" | "120000". */
	mode: string;
	oid: string;
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
