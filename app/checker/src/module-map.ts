import { stripTypes } from "./strip-types.ts";

/** Minimal slice of the Artifacts `ArtifactsRepo` RPC handle the checker needs. */
export interface RepoHandle {
	log(opts?: { ref?: string; limit?: number; offset?: number }): Promise<Array<{ hash: string; treeHash: string }>>;
	readTree(hash: string): Promise<Array<{ name: string; mode: string; hash: string; type: string }> | null>;
	readBlob(hash: string): Promise<{ text(): Promise<string>; arrayBuffer(): Promise<ArrayBuffer> } | null>;
}

/** Modules map entry for WorkerLoader (`{ js }`, `{ cjs }`, `{ json }`, `{ text }`, `{ data }`). */
export type ModuleEntry = string | { js?: string; cjs?: string; json?: unknown; text?: string; data?: ArrayBuffer };

export interface ModuleMap {
	/** Loader `modules` record, keyed by original repo-relative path (`.ts` suffixes kept). */
	modules: Record<string, ModuleEntry>;
	/** Sorted repo-relative paths matching `tests/**\/*.test.{ts,js,mjs}`. */
	testModules: string[];
	/** Resolved full commit hash. */
	commit: string;
}

const TEXT_EXT = /\.(txt|md|css|html?|svg|csv|xml|ya?ml|toml|map|gitignore|env)$/i;

/** `tests/**\/*.test.{ts,js,mjs}` — `.ts` is the contract convention; js/mjs are accepted too. */
export function isTestModule(path: string): boolean {
	return path.startsWith("tests/") && /\.test\.(ts|js|mjs)$/.test(path);
}

async function toModuleEntry(path: string, blob: { text(): Promise<string>; arrayBuffer(): Promise<ArrayBuffer> }): Promise<ModuleEntry> {
	if (/\.(ts|mts)$/.test(path)) return { js: stripTypes(await blob.text(), path) };
	if (/\.(js|mjs)$/.test(path)) return { js: await blob.text() };
	if (/\.cjs$/.test(path)) return { cjs: await blob.text() };
	if (/\.json$/.test(path)) {
		const text = await blob.text();
		try {
			return { json: JSON.parse(text) };
		} catch {
			return { text };
		}
	}
	if (TEXT_EXT.test(path)) return { text: await blob.text() };
	return { data: await blob.arrayBuffer() };
}

/**
 * Read every file at `commit` into a WorkerLoader modules map. Import specifiers keep their
 * `.ts` extension per the fixture convention, so modules are keyed by their original `.ts`
 * path and wrapped in `{ js: code }` to force the JS module type.
 */
export async function buildModuleMap(repo: RepoHandle, commit: string): Promise<ModuleMap> {
	const [meta] = await repo.log({ ref: commit, limit: 1 });
	if (!meta) throw new Error(`commit not found: ${commit}`);

	const blobs: Array<{ path: string; hash: string }> = [];
	const walk = async (treeHash: string, prefix: string): Promise<void> => {
		const entries = await repo.readTree(treeHash);
		for (const e of entries ?? []) {
			const path = prefix + e.name;
			if (e.type === "tree") await walk(e.hash, path + "/");
			else if (e.type === "blob" || e.type === "exec") blobs.push({ path, hash: e.hash });
		}
	};
	await walk(meta.treeHash, "");

	const modules: Record<string, ModuleEntry> = {};
	for (const { path, hash } of blobs) {
		const blob = await repo.readBlob(hash);
		if (blob) modules[path] = await toModuleEntry(path, blob);
	}
	const testModules = Object.keys(modules).filter(isTestModule).sort();
	return { modules, testModules, commit: meta.hash };
}
