// T19 review F1: admin-key policy for destructive and token-minting endpoints.

import { test } from "node:test";
import assert from "node:assert/strict";
import { ADMIN_HEADER, authorize, keysEqual, requiresAdminKey } from "../src/auth.ts";

const KEY = "k-test-123";
const req = (method: string, path: string, key?: string) =>
	new Request(`https://arb.example${path}`, {
		method,
		headers: key === undefined ? {} : { [ADMIN_HEADER]: key },
	});

test("protected: every non-GET /api/* and GET /api/entries/:id", () => {
	for (const [m, p] of [
		["POST", "/api/trunk/init"],
		["POST", "/api/entries"],
		["POST", "/api/entries/e1/ready"],
		["POST", "/api/entries/e1/veto"],
		["POST", "/api/config"],
		["POST", "/api/reset"],
		["GET", "/api/entries/e1"],
		["DELETE", "/api/state"],
	]) {
		assert.equal(requiresAdminKey(m, p), true, `${m} ${p}`);
	}
});

test("public: GET state/events/ws and static assets", () => {
	for (const [m, p] of [
		["GET", "/api/state"],
		["GET", "/api/events"],
		["GET", "/api/ws"],
		["GET", "/"],
		["GET", "/app.js"],
		["POST", "/not-api"],
	]) {
		assert.equal(requiresAdminKey(m, p), false, `${m} ${p}`);
	}
});

test("authorize: 403 without the key, with a wrong key, or when the secret is unset", async () => {
	for (const r of [
		authorize(req("POST", "/api/reset"), KEY),
		authorize(req("POST", "/api/reset", "wrong"), KEY),
		authorize(req("GET", "/api/entries/e1", ""), KEY),
		authorize(req("POST", "/api/reset", KEY), undefined),
		authorize(req("POST", "/api/reset", ""), ""),
	]) {
		assert.ok(r);
		assert.equal(r!.status, 403);
		assert.match(((await r!.json()) as { error: string }).error, /forbidden/);
	}
});

test("authorize: null (pass through) with the right key, and for public routes without one", () => {
	assert.equal(authorize(req("POST", "/api/reset", KEY), KEY), null);
	assert.equal(authorize(req("GET", "/api/entries/e3", KEY), KEY), null);
	assert.equal(authorize(req("GET", "/api/state"), KEY), null);
	assert.equal(authorize(req("GET", "/api/state"), undefined), null);
});

test("keysEqual compares exactly", () => {
	assert.equal(keysEqual("abc", "abc"), true);
	assert.equal(keysEqual("abc", "abd"), false);
	assert.equal(keysEqual("abc", "abcd"), false);
	assert.equal(keysEqual("", ""), true);
});
