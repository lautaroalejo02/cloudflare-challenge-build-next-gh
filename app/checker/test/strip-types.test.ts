import { test } from "node:test";
import assert from "node:assert/strict";
import { stripTypes } from "../src/strip-types.ts";

const importStripped = async (code: string) =>
	import(`data:text/javascript;charset=utf-8,${encodeURIComponent(stripTypes(code, "fixture.ts"))}`);

test("strips annotations, interfaces and generics; output is runnable JS", async () => {
	const ts = `
export interface Item { price: number; qty: number }
export function total(items: Item[], tax = 0): number {
	const sum: number = items.reduce((s, i) => s + i.price * i.qty, 0);
	return (sum * (1 + tax)) as number;
}
`;
	const mod = await importStripped(ts);
	assert.equal(mod.total([{ price: 10, qty: 2 }]), 20);
	assert.equal(mod.total([{ price: 1, qty: 1 }], 0.1), 1.1);
});

test("removes type-only imports so the module links at runtime", async () => {
	const ts = `
import type { Item } from "./types.ts";
import { helper, type HelperOpts } from "./helper.ts";
export function go(x: Item, o: HelperOpts) { return helper(x, o); }
`;
	const out = stripTypes(ts, "go.ts");
	assert.doesNotMatch(out, /import\s+type/);
	assert.doesNotMatch(out, /HelperOpts/);
	assert.match(out, /import\s*{\s*helper\s*,?\s*}\s*from\s*["']\.\/helper\.ts["']/);
});

test("supports enum and satisfies/as expressions", async () => {
	const ts = `
export enum Region { US = "us", EU = "eu" }
export const cfg = { retries: 3 } as const;
export function pick(r: Region) { return r; }
`;
	const mod = await importStripped(ts);
	assert.equal(mod.Region.EU, "eu");
	assert.equal(mod.pick("us"), "us");
	assert.equal(mod.cfg.retries, 3);
});

test("keeps .ts import specifiers untouched", () => {
	const out = stripTypes(`import { f } from "../api/x.ts";\nexport const y: number = f();`, "a/b.ts");
	assert.match(out, /["']\.\.\/api\/x\.ts["']/);
});
