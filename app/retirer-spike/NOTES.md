# retirer-spike — fast-forward retirement from a Worker

**Verdict: WORKS.** A Worker can fast-forward `arb-trunk` main to a fork commit over git smart HTTP — no server-side merge and no binding ref-update method needed. isomorphic-git + `fetch` + an in-memory fs run fine inside a Worker (`nodejs_compat` required for `Buffer`). The Sandbox and pointer-retirement fallbacks were not needed.

## What was built

- `src/retire.ts` — reusable module (self-contained, copy into control-plane):
  - `fastForward(env, { fromRepo, commit, toRepo, branch })` → `{ head, previousHead, fsBytes, ms }`:
    1. mints a **read** token for `fromRepo` and a **write** token for `toRepo` via the Artifacts binding;
    2. `git.fetch` of `branch` (singleBranch, protocol v1-compatible auto-negotiation) from the fork into a `MemFs` object store;
    3. resolves the trunk head via `listServerRefs`;
    4. verifies `commit` descends from the trunk head with `git.isDescendent` (depth −1) — throws `NotFastForwardError` (`code: "NOT_FAST_FORWARD"`) otherwise; skipped when the branch is unborn;
    5. `git.push` (non-forced) writes the missing objects and updates `refs/heads/<branch>`; server enforces fast-forward again.
  - `MemFs` — ~200-line in-memory fs satisfying isomorphic-git's `fs.promises` contract (own enumerable `promises` property, promise-returning methods, Node-style `code` errors).
- `src/index.ts` — throwaway Worker `arb-test-retirer` with `/setup`, `/token`, `/head`, `/info`, `/ff` (409 on `NOT_FAST_FORWARD`).
- `test/retire.test.mjs` — node:test suite: MemFs semantics + a real `init`/`add`/`commit`/`resolveRef`/`isDescendent` run on MemFs (proves the exact predicate fastForward uses).
- `scripts/measure.mjs` — idempotent end-to-end runner: setup/fallback, clone trunk, seed fork clone at trunk head `T` (fetch + `checkout -B main FETCH_HEAD`), push 5 descendant commits, run 5 `/ff`s, reject test, head verification; writes `results.json`.

## Measured (5 runs, deployed Worker, small fixtures)

| run | total ms | setup | fetch | verify | push | wall (client) | cpu ms (tail) |
|---|---|---|---|---|---|---|---|
| 1 | 1072 | 529 | 201 | 74 | 268 | 1159 | ~45 |
| 2 | 1244 | 586 | 168 | 66 | 424 | 1437 | ~25 |
| 3 | 841 | 289 | 253 | 86 | 213 | 932 | ~17 |
| 4 | 922 | 174 | 354 | 99 | 295 | 1022 | ~24 |
| 5 | 742 | 222 | 244 | 75 | 201 | 820 | ~19 |

Median total **~0.9 s**; dominant costs are Artifacts `get`/`createToken`/`info` (setup) and git smart-HTTP round trips — pure CPU is trivial (17–45 ms vs the 30 s limit). Rejecting an already-retired commit → HTTP 409 `NOT_FAST_FORWARD`. Final trunk head confirmed by `/head` and `git ls-remote`.

**Memory/CPU (`wrangler tail --format json`, 19 requests, all `outcome: ok`, 0 exceptions):** tail reports cpuTime/wallTime but not memory. The in-memory object store held **4,050 bytes** (`fsBytes`) for the 6-commit fixture — loose objects in MemFs. Memory concern is therefore negligible for ARB-sized repos; on a repo with a large history the entire fetched object graph is held in Worker memory (128 MB limit) — if that ever matters, `depth`/`shallow` fetch options would need evaluating (note: `isDescendent` needs the ancestor's history present, so shallow fetch must reach back to the trunk head).

## How to run

```bash
cd app/retirer-spike
npm test                                   # unit tests (node --experimental-strip-types)
npx wrangler deploy                        # deploys arb-test-retirer
npx wrangler tail --format json > tail.log # in another terminal, for cpu data
node scripts/measure.mjs https://arb-test-retirer.lautitomasalejo.workers.dev
```

The runner is re-runnable: existing repos are detected (`ALREADY_EXISTS` → token/info fallback) and new commits are always seeded on the current trunk head.

## Decisions taken

- **isomorphic-git chosen over Sandbox/pointer fallbacks** — it worked on the first deployable attempt after one fix, so fallbacks were not needed. No Sandbox image reuse required.
- **`nodejs_compat` flag** — isomorphic-git uses `Buffer` (~110 sites); the flag provides it. Alternative would have been vendoring/shimming — rejected.
- **Auth: credentials embedded in the remote URL** (`https://x:<token>@host`, `?expires=` stripped, per CONTRACTS) — isomorphic-git's `extractAuthFromUrl` converts URL creds to Basic auth headers before `fetch` (fetch() rejects credentialed URLs). `onAuth` returning the same pair is passed as the 401-retry fallback.
- **Remote refspec must be configured** — isomorphic-git requires `[remote "origin"] fetch = +refs/heads/*:refs/remotes/origin/*` even when `url` is passed; fixed via `git.setConfig` after `NoRefspecError` on the first attempt.
- **`MemFs` over lightning-fs/memfs** — lightning-fs needs IndexedDB (absent in Workers); `memfs` pulls in `process`/`stream` surface; a 200-line map-based fs is smaller and unit-testable.
- **`fastForward` returns an object, not just the sha** — the port contract ("→ new trunk commit") is satisfied by `result.head`; the extra `ms`/`previousHead`/`fsBytes` fields support measurement and logging. Integration can ignore them.
- **Non-forced push + client-side `isDescendent` check** — defense in depth: the client refuses before pushing, and the git server independently rejects non-ff updates.

## Contract issues

- `RetirerPort.fastForward` in `app/CONTRACTS.md`/`odd/prompts/T6-control-plane.md` is specified as `fastForward({ fromRepo, commit, toRepo, branch })` (no `env` first arg). `src/retire.ts` implements `fastForward(env, args)` per this task's spec — the binding needs `env.ARTIFACTS`, so integration should either pass `env` or wrap the module. Signature otherwise matches; returns `{ head: <new trunk commit>, ... }`.
- CONTRACTS lists no `RetirerPort` shape under "Library interfaces" — only T6's prompt does; consider adding it to CONTRACTS.md during integration.

## Cloudflare resources created

- Worker `arb-test-retirer` (`nodejs_compat`, Artifacts binding `ARTIFACTS` → namespace `arb`).
- Artifacts repos (namespace `arb`): `arb-test-retirer-trunk`, `arb-test-retirer-fork`.

## Known gaps

- Tokens minted per call (600 s TTL) — no caching; each ff costs two `get` + two `createToken` + two `info` calls (~200–600 ms). Acceptable for retirement frequency.
- `MemFs` holds the full fetched history of `branch` — fine for small repos; see memory note above for large histories.
- `wrangler tail` does not report memory; `fsBytes` in the result is the proxy used.
- Rejection of a commit on a *different* branch (C not reachable from fork `branch`) is not explicitly tested — fetch covers `branch` only, and `isDescendent`/`writeRef` would fail on a missing object; covered implicitly.
