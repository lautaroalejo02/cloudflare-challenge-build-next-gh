import { test } from "node:test";
import assert from "node:assert/strict";
import { isTransientGitError, redactCredentials } from "../src/lib/git.ts";

test("redactCredentials hides userinfo in https remotes", () => {
  const msg =
    "Command failed: git clone --quiet https://x:art_v2_secret123@acct.artifacts.cloudflare.net/git/arb/r.git C:\\tmp\\r";
  const out = redactCredentials(msg);
  assert.ok(!out.includes("art_v2_secret123"));
  assert.ok(out.includes("https://***@acct.artifacts.cloudflare.net/git/arb/r.git"));
});

test("redactCredentials leaves credential-free text untouched", () => {
  assert.equal(redactCredentials("fatal: not a git repository"), "fatal: not a git repository");
});

test("isTransientGitError matches server-side and network failures", () => {
  for (const msg of [
    "error: RPC failed; HTTP 500 curl 22 The requested URL returned error: 500\nfatal: expected 'packfile'",
    "The requested URL returned error: 503",
    "error: RPC failed; HTTP 429",
    "fatal: unable to access 'https://h/': Could not resolve host: h",
    "fatal: early EOF",
  ]) {
    assert.equal(isTransientGitError(msg), true, msg);
  }
});

test("isTransientGitError rejects deterministic failures", () => {
  for (const msg of [
    "The requested URL returned error: 403",
    "! [rejected] HEAD -> main (non-fast-forward)",
    "fatal: repository 'https://h/r.git/' not found",
  ]) {
    assert.equal(isTransientGitError(msg), false, msg);
  }
});
