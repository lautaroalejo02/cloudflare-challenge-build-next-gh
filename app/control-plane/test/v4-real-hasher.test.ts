// V4 integration: the REAL hasher (app/hasher: hashInterface + extractImports,
// SymbolSignature.file/bodyHash/source) on the demo fixture, fed through the
// control plane's push path (pushCommand -> rob.apply). Guards the wiring the
// fake-hasher tests cannot see: import path resolution and per-symbol files.

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { extractImports, hashInterface, initHasher } from "../../hasher/src/index.ts";
import { interfaceToMaps, pushCommand, tokenCache, type EffectHost } from "../src/effects.ts";
import { apply, initialState, type ArbEvent, type RobState } from "../src/rob.ts";
import type { ArtifactsPort } from "../src/ports.ts";

const here = dirname(fileURLToPath(import.meta.url));
const hasherSrc = join(here, "..", "..", "hasher", "src");
const fixtureDir = join(here, "..", "..", "demo", "fixture");
const FIXTURE_FILES = ["src/api/order.ts", "src/api/payment.ts", "src/ui/checkout.ts", "src/ui/paywall.ts", "tests/order.test.ts", "tests/payment.test.ts"];

function fixture(): Record<string, string> {
	return Object.fromEntries(FIXTURE_FILES.map((p) => [p, readFileSync(join(fixtureDir, p), "utf8")]));
}

function run(state: RobState, cmd: Parameters<typeof apply>[1]): { state: RobState; events: ArbEvent[] } {
	const r = apply(state, cmd, Date.now());
	assert.equal(r.ok, true, r.ok ? "" : `apply failed: ${r.error}`);
	const ok = r as Extract<typeof r, { ok: true }>;
	const events = ok.effects.flatMap((e) => (e.type === "broadcast" ? [e.event] : []));
	return { state: ok.state, events };
}

test("V4 real hasher: src/ui/checkout.ts infers createOrder from src/api/order.ts through the push path", async () => {
	// Node compiles from bytes; the Workers typings declare Module abstract.
	const NodeModule = WebAssembly.Module as unknown as new (bytes: Uint8Array) => WebAssembly.Module;
	const wasm = (file: string) => new NodeModule(readFileSync(join(hasherSrc, file)));
	await initHasher(wasm("web-tree-sitter.wasm"), wasm("tree-sitter-typescript.wasm"));
	const base = fixture();
	const forked = interfaceToMaps(await hashInterface(base));
	// The real hasher carries the V2 per-symbol fields the control plane relies on.
	assert.deepEqual(forked.sigs.createOrder && typeof forked.sigs.createOrder === "object" ? forked.sigs.createOrder.file : null, "src/api/order.ts");
	assert.match(forked.bodies.createOrder ?? "", /^[0-9a-f]{12}$/);
	assert.match(forked.sources.createOrder?.source ?? "", /export function createOrder/);

	let state = run(initialState(), { type: "trunk.init", repo: "arb-trunk", remote: "https://x/arb-trunk", commit: "t0" }).state;
	state = run(state, { type: "entry.create", agent: "api", lane: "api" }).state;
	state = run(state, { type: "fork.done", entryId: "e1", repo: "arb-e1-api-0", remote: "https://x/e1", baseCommit: "t0", exports: forked.exports, sigs: forked.sigs, bodies: forked.bodies }).state;
	state = run(state, { type: "entry.create", agent: "ui", lane: "ui", producerId: "e1" }).state;
	state = run(state, { type: "fork.done", entryId: "e2", repo: "arb-e2-ui-0", remote: "https://x/e2", baseCommit: "t0", exports: forked.exports, sigs: forked.sigs, bodies: forked.bodies }).state;
	assert.equal(state.entries.find((e) => e.id === "e2")!.consumesInferred, true);

	const pushed = {
		...base,
		"src/ui/checkout.ts": base["src/ui/checkout.ts"] + "\nexport function renderExpressCheckout(cart: Cart, region: string): string {\n  return `express ${createOrder(cart, region).id}`;\n}\n",
	};
	const artifacts: ArtifactsPort = {
		create: async (name) => ({ name, remote: `https://x/${name}` }),
		getRemote: async (name) => `https://x/${name}`,
		fork: async (_f, to) => ({ name: to, remote: `https://x/${to}` }),
		token: async (repo) => `tok-${repo}`,
		log: async () => [{ hash: "u1" }],
		readTree: async () => pushed,
	};
	const host: EffectHost = {
		ports: { artifacts, hasher: { hashInterface, extractImports }, checker: {} as never, retirer: {} as never },
		state: () => state,
		apply: () => ({ ok: true, effects: [] }),
		broadcast: () => {},
		registerRepo: () => {},
		tokens: tokenCache((repo) => artifacts.token(repo, 3600)),
		sleep: async () => {},
	};
	const cmd = await pushCommand(host, "arb-e2-ui-0", "u1");
	assert.ok(cmd && cmd.type === "push");
	const edge = cmd.imports?.find((i) => i.file === "src/ui/checkout.ts" && i.names.includes("createOrder"));
	assert.equal(edge?.from, "src/api/order.ts", `imports: ${JSON.stringify(cmd.imports)}`);

	const r = run(state, cmd);
	const e2 = r.state.entries.find((e) => e.id === "e2")!;
	assert.equal(e2.consumes.createOrder, forked.exports.createOrder, "createOrder pinned at the forked hash");
	const inferred = r.events.find((ev) => ev.type === "deps.inferred" && ev.entryId === "e2");
	assert.ok(inferred, "deps.inferred emitted");
	const data = inferred!.data as { producerId: string; symbols: Record<string, string> };
	assert.equal(data.producerId, "e1");
	assert.equal(data.symbols.createOrder, forked.exports.createOrder);
	assert.equal(r.state.stats.inferredDeps >= 1, true);
	assert.ok(!r.events.some((ev) => ev.type === "squash"), "no drift, no squash");
});
