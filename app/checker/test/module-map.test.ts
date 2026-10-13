import { test } from "node:test";
import assert from "node:assert/strict";
import { buildModuleMap, isTestModule, type RepoHandle } from "../src/module-map.ts";

/** In-memory fake of the Artifacts repo RPC surface used by buildModuleMap. */
class FakeRepo implements RepoHandle {
	private trees = new Map<string, Array<{ name: string; mode: string; hash: string; type: string }>>();
	private blobs = new Map<string, string>();
	private seq = 0;
	readonly head: { hash: string; treeHash: string };

	constructor(files: Record<string, string>) {
		const root = this.buildTree(files);
		this.head = { hash: "c".repeat(40), treeHash: root };
	}

	private newHash() {
		return (this.seq++).toString(16).padStart(40, "0");
	}

	private buildTree(files: Record<string, string>): string {
		// path segments -> nested plain object, then emit git trees bottom-up
		const root: Record<string, any> = {};
		for (const [path, content] of Object.entries(files)) {
			const parts = path.split("/");
			let node = root;
			for (const part of parts.slice(0, -1)) node = node[part] ??= {};
			node[parts[parts.length - 1]] = content;
		}
		const emit = (node: Record<string, any>): string => {
			const entries = Object.entries(node).map(([name, v]) =>
				typeof v === "string"
					? { name, mode: "100644", hash: this.addBlob(v), type: "blob" }
					: { name, mode: "40000", hash: emit(v), type: "tree" },
			);
			const hash = this.newHash();
			this.trees.set(hash, entries);
			return hash;
		};
		return emit(root);
	}

	private addBlob(content: string): string {
		const hash = this.newHash();
		this.blobs.set(hash, content);
		return hash;
	}

	async log(opts?: { ref?: string; limit?: number }) {
		return opts?.ref === this.head.hash || opts?.ref === "main" ? [this.head] : [];
	}
	async readTree(hash: string) {
		return this.trees.get(hash) ?? null;
	}
	async readBlob(hash: string) {
		const content = this.blobs.get(hash);
		if (content == null) return null;
		return {
			text: async () => content,
			arrayBuffer: async () => new TextEncoder().encode(content).buffer as ArrayBuffer,
		};
	}
}

const FILES = {
	"src/api/order.ts": `export interface Cart { items: { price: number }[] }\nexport function createOrder(c: Cart): number { return 1 }`,
	"tests/order.test.ts": `import { createOrder } from "../src/api/order.ts";\nexport function run() { return [{ name: "x", ok: true }]; }`,
	"tests/deep/util.test.ts": `export function run(): Array<{name:string;ok:boolean}> { return []; }`,
	"tests/helper.ts": `export const notATest = true;`,
	"README.md": "# hi",
};

test("isTestModule matches tests/**/*.test.{ts,js,mjs} only", () => {
	assert.ok(isTestModule("tests/order.test.ts"));
	assert.ok(isTestModule("tests/deep/util.test.ts"));
	assert.ok(isTestModule("tests/x.test.js"));
	assert.ok(!isTestModule("test/order.test.ts"));
	assert.ok(!isTestModule("tests/helper.ts"));
	assert.ok(!isTestModule("src/order.test.ts"));
	assert.ok(!isTestModule("othertests/a.test.ts"));
});

test("buildModuleMap reads the whole tree, keeps .ts keys and strips types", async () => {
	const repo = new FakeRepo(FILES);
	const map = await buildModuleMap(repo, "main");

	assert.equal(map.commit, repo.head.hash);
	assert.deepEqual(Object.keys(map.modules).sort(), Object.keys(FILES).sort());
	assert.deepEqual(map.testModules, ["tests/deep/util.test.ts", "tests/order.test.ts"]);

	const order = map.modules["src/api/order.ts"] as { js: string };
	assert.equal(typeof order.js, "string");
	assert.doesNotMatch(order.js, /interface/);
	assert.match(order.js, /function createOrder\(c\)/);

	const testMod = map.modules["tests/order.test.ts"] as { js: string };
	assert.match(testMod.js, /\.\.\/src\/api\/order\.ts/);

	const readme = map.modules["README.md"] as { text: string };
	assert.equal(readme.text, "# hi");
});

test("buildModuleMap resolves a commit sha via log", async () => {
	const repo = new FakeRepo(FILES);
	const map = await buildModuleMap(repo, repo.head.hash);
	assert.equal(map.commit, repo.head.hash);
});

test("buildModuleMap throws on unknown commit", async () => {
	const repo = new FakeRepo(FILES);
	await assert.rejects(() => buildModuleMap(repo, "d".repeat(40)), /commit not found/);
});
