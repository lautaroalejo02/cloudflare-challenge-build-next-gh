// T19 regression tests for the effect runtime (src/effects.ts): the DO's
// effect queue, push-command preparation and token minting, driven through
// fake ports (no Cloudflare runtime).

import { test } from "node:test";
import assert from "node:assert/strict";
import { execEffects, forkWithSuffix, pushCommand, tokenCache, type EffectHost } from "../src/effects.ts";
import { initialState, type Cmd, type Effect, type RobState } from "../src/rob.ts";
import type { ArtifactsPort, Ports } from "../src/ports.ts";

const noSleep = async () => {};

function fakeArtifacts(over: Partial<ArtifactsPort> = {}): ArtifactsPort {
	return {
		create: async (name) => ({ name, remote: `https://x/${name}` }),
		getRemote: async (name) => `https://x/${name}`,
		fork: async (_from, to) => ({ name: to, remote: `https://x/${to}` }),
		token: async (repo) => `tok-${repo}`,
		log: async () => [{ hash: "c1" }],
		readTree: async () => ({ "src/a.ts": "export function a(): void {}" }),
		...over,
	};
}

function host(opts: { artifacts?: ArtifactsPort; state?: RobState; checker?: Ports["checker"] } = {}) {
	const applied: Cmd[] = [];
	const broadcasts: string[] = [];
	const state = opts.state ?? initialState();
	const artifacts = opts.artifacts ?? fakeArtifacts();
	const h: EffectHost = {
		ports: {
			artifacts,
			hasher: { hashInterface: async () => ({ hash: "h", symbols: [{ name: "a", kind: "function", signature: "a(): void", hash: "ha" }] }) },
			checker: opts.checker ?? { runChecks: async (_r, commit) => ({ commit, passed: 1, failed: 0, durationMs: 1, results: [] }) },
			retirer: {} as Ports["retirer"],
		},
		state: () => state,
		apply: (cmd) => {
			applied.push(cmd);
			return { ok: true, effects: [] };
		},
		broadcast: (ev) => void broadcasts.push(ev.type),
		registerRepo: () => {},
		tokens: tokenCache((repo) => artifacts.token(repo, 3600)),
		sleep: noSleep,
	};
	return { h, applied, broadcasts };
}

const bc = (type: string): Effect => ({ type: "broadcast", event: { type: type as never, ts: 1 } });

test("F3 a throwing effect is reported and the queue continues", async () => {
	const { h, applied, broadcasts } = host({
		artifacts: fakeArtifacts({
			token: async () => {
				throw new Error("token minting failed\n    at secret stack frame");
			},
		}),
	});
	await execEffects(h, [{ type: "token", entryId: "e1", repo: "arb-e1-api-0" }, bc("refork")]);
	assert.deepEqual(broadcasts, ["refork"], "later effects still run");
	const failed = applied.find((c) => c.type === "effect.failed") as Extract<Cmd, { type: "effect.failed" }>;
	assert.ok(failed, "token failure reported");
	assert.equal(failed.effect, "token");
	assert.doesNotMatch(failed.reason, /\n|at secret/, "no stack traces in recovery events");
});

test("F3 a failed fork becomes fork.failed with its planned name (re-issued by the alarm sweep)", async () => {
	const { h, applied } = host({
		artifacts: fakeArtifacts({
			fork: async () => {
				throw Object.assign(new Error("permission denied"), { status: 403 });
			},
		}),
	});
	await execEffects(h, [{ type: "fork", entryId: "e2", fromRepo: "arb-e1-api-0", toRepo: "arb-e2-ui-1" }]);
	assert.deepEqual(
		applied.map((c) => [c.type, (c as { planned?: string }).planned]),
		[["fork.failed", "arb-e2-ui-1"]],
	);
});

test("F3 a throwing checker becomes an infra check result, never a verdict", async () => {
	const { h, applied } = host({
		checker: {
			runChecks: async () => {
				throw new Error("loader exploded");
			},
		},
	});
	await execEffects(h, [{ type: "check", entryId: "e1", repo: "arb-e1-api-0", commit: "c1" }]);
	const done = applied[0] as Extract<Cmd, { type: "check.done" }>;
	assert.equal(done.type, "check.done");
	assert.equal(done.result.infra, true);
});

test("fork.done carries the planned name and the actual (suffixed) repo", async () => {
	let calls = 0;
	const { h, applied } = host({
		artifacts: fakeArtifacts({
			fork: async (_from, to) => {
				if (calls++ === 0) throw new Error("ALREADY_EXISTS: repo exists");
				return { name: to, remote: `https://x/${to}` };
			},
		}),
	});
	await execEffects(h, [{ type: "fork", entryId: "e1", fromRepo: "arb-trunk", toRepo: "arb-e1-api-0" }]);
	const done = applied[0] as Extract<Cmd, { type: "fork.done" }>;
	assert.equal(done.type, "fork.done");
	assert.equal(done.planned, "arb-e1-api-0");
	assert.match(done.repo, /^arb-e1-api-0-[a-z0-9]{6}$/);
});

test("F10 the first name collision jumps straight to a random suffix", async () => {
	const tried: string[] = [];
	const art = fakeArtifacts({
		fork: async (_from, to) => {
			tried.push(to);
			if (tried.length === 1) throw new Error("ALREADY_EXISTS");
			return { name: to, remote: "" };
		},
	});
	const created = await forkWithSuffix(art, "arb-trunk", "arb-e1-api-0", () => "zz9zz9", noSleep);
	assert.deepEqual(tried, ["arb-e1-api-0", "arb-e1-api-0-zz9zz9"]);
	assert.equal(created.name, "arb-e1-api-0-zz9zz9");
});

test("F9 a push event whose commit is no longer the repo head is dropped after hashing", async () => {
	const s = initialState();
	s.trunk.repo = "arb-trunk";
	s.entries.push({
		id: "e1", seq: 1, agent: "a", lane: "api", status: "speculating", repo: "arb-e1-api-0", remote: "",
		producerId: null, baseCommit: "c0", headCommit: "c0", exports: {}, consumes: {}, predicted: [],
		generation: 0, diagnosis: null, checks: null,
	});
	let head = "c3";
	const { h } = host({ state: s, artifacts: fakeArtifacts({ log: async () => [{ hash: head }] }) });
	assert.equal(await pushCommand(h, "arb-e1-api-0", "c2"), null, "out-of-order (older) event dropped");
	head = "c2";
	const cmd = await pushCommand(h, "arb-e1-api-0", "c2");
	assert.equal(cmd?.type, "push");
	assert.deepEqual((cmd as Extract<Cmd, { type: "push" }>).exports, { a: "ha" });
});

test("F8 every token request gets a token; minting is reused inside the window", async () => {
	let minted = 0;
	let t = 0;
	const cache = tokenCache(async (repo) => `tok-${repo}-${++minted}`, () => t, 1_000);
	assert.equal(await cache.get("r"), "tok-r-1");
	assert.equal(await cache.get("r"), "tok-r-1", "a second caller still receives a token");
	t = 1_001;
	assert.equal(await cache.get("r"), "tok-r-2", "re-minted after the reuse window");
	assert.equal(await cache.get("other"), "tok-other-3");
});
