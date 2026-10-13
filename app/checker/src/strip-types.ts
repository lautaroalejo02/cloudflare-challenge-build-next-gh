import { transform } from "sucrase";

/**
 * Strip TypeScript types so the code runs as plain ESM inside a Dynamic Worker.
 * Sucrase is pure JS (no WASM, no Node APIs), so it works inside Workers.
 * Unlike a blank-space stripper it also removes `import type` / type-only
 * specifiers and compiles enums/namespaces correctly.
 */
export function stripTypes(code: string, path: string): string {
	// keepUnusedImports: keep value imports even when they look unused — eliding them
	// would silently drop module side effects (same semantics as Node's own type stripping).
	return transform(code, { transforms: ["typescript"], filePath: path, keepUnusedImports: true }).code;
}
