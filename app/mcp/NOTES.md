# NOTES — app/mcp (V2: MCP server so any agent can join the buffer)

## What was built

A local stdio MCP server (`src/index.ts` → `src/server.ts` → `src/service.ts`)
exposing six tools — `arb_register`, `arb_status`, `arb_sync`, `arb_push`,
`arb_ready`, `arb_state` — on top of the ARB HTTP API (`app/CONTRACTS.md`). Any
MCP-capable agent registers as a buffer entry, gets a local git workspace under
`ARB_WORKDIR/<entryId>`, and never touches tokens, remotes or the API itself.

- `src/types.ts`: local copy of the contract types with the V2 fields
  (`consumesInferred`, `forkedExports`, `bodies`, `judging`,
  `Diagnosis.reason "behavior-changed"`, `judgment`). The demo's `types.ts` is
  v1 and lacks them, so it was not imported.
- `src/instructions.ts`: `renderSquashInstructions` — LLM-facing text per
  squash reason, with old/new signature diffs, Jev probability + model for
  `behavior-changed`, and the sync → redo → push → ready next steps.
- `src/git.ts`: `ArbGit` — local `execFile` wrapper (V2b): credentials via
  `GIT_CONFIG_*`/`http.extraHeader`, hooks disabled (`core.hooksPath` to an
  empty dir, `core.fsmonitor=false`), child env scrubbed, transient retries.
- `src/api.ts`: `ApiClient` subclass percent-encoding entry ids into URL paths.
- `src/service.ts`: `ArbService` — API + workspace logic, reusing from
  `app/demo/src/lib/` only `isTransientGitError`, `redactCredentials` and
  `resolveAdminKey` (the demo's git helpers put the token in argv, so they are
  not used). No demo files were edited.
- `src/server.ts`: `createArbServer` — `McpServer` + `registerTool` with zod
  v4 `inputSchema`s; every handler's output and error string passes through
  `redactCredentials`.
- `src/index.ts`: stdio entry; logs only to stderr, prints `adminKey=set|none`
  (never the value).

## How to run / test / deploy

- `npm install` once (deps: `@modelcontextprotocol/sdk@1.32.1`,
  `zod@4.6.7`, both exact-pinned).
- `npm test` — 25 tests: 24 unit + 1 integration (~20 s; the integration test
  spawns the real server over stdio).
- `npm run check:live` — one-shot live verification against the real control
  plane (`scripts/live-check.ts`): register → clone → push → ready, asserts
  `.git/config` stays credential-free and vetoes the entry only if it is the
  buffer head. Uses the real admin key; creates one real entry.
- `npm start` or register it in a client (see README for verified
  `claude mcp add` / `codex mcp add` + `config.toml` / `devin mcp add`
  commands — all three `--help`s were checked on this machine).
- No deployment: it is a local stdio process. No Cloudflare resources created.

## V2b audit fixes

Audit of `04f4d66` (Sonnet) → fixes, all under `app/mcp/` (`app/demo` untouched;
unsuitable helpers replaced by local wrappers in `src/`).

| # | Finding | Fix | Test(s) |
|---|---|---|---|
| 1 | Token in git argv, visible to hooks/`ps` | Local `ArbGit` (`src/git.ts`, `execFile`): credential passed as `GIT_CONFIG_*` env → `http.extraHeader=Authorization: Basic base64("x:<token-secret>")`; `-c core.hooksPath=<workdir>/.arb-empty-hooks` and `-c core.fsmonitor=false` on every invocation; child env scrubbed of `ARB_ADMIN_KEY`, `TYPESAFE_*` and ambient `GIT_CONFIG_*`. Verified live: clone+push to a real Artifacts fork via extraHeader Basic both succeeded (see Live check). Artifacts docs also document `http.extraHeader` Bearer as the recommended form — Basic is the same header the URL form produces, and it works. | `git invocation: no token in argv; credential travels only in GIT_CONFIG_*`, `env scrub: child env has no ARB_ADMIN_KEY...` |
| 2 | `entryId` path traversal | `^e\d+$` zod regex on every entryId-bearing tool (incl. `producerId`); `src/api.ts` ApiClient subclass percent-encodes the id into the URL path; service asserts the id shape and that resolved workspace/state paths stay inside `ARB_WORKDIR`. | `validation: entryId rejects traversal and non-id shapes`, `traversal: service asserts the id shape and keeps paths inside ARB_WORKDIR`, `api client: entry id is percent-encoded` |
| 3 | `arb_push` re-adopted a changed fork without re-clone | On repo/generation drift, adopt only when the workspace `origin` URL equals `entry.remote`; otherwise refuse and point at `arb_sync`. | `push: refuses to adopt a drifted fork when origin does not match entry.remote` |
| 4 | Orphaned entry on failed clone | `arb_register` wraps fork-wait + clone in a message that names the created `entryId` and says to call `arb_sync` to retry; `arb_sync` clones when there is no local state. | `register: a failed clone reports the entryId and points at arb_sync` |
| 5 | Double `arb_sync` blocks | When local `repo`+`generation` already match the server (status may still read `squashed` until the next push), return immediately with `synced: false, reason: "already synced"` (single API call, no poll). | `sync: a second sync on the same fork+generation returns already-synced without waiting` |
| 6 | `arb_sync` silently deleted unpushed work | If the workspace has uncommitted changes or unpushed commits and the entry is not squashed → refuse unless `force: true`; when squashed, proceed and report `discarded: true`. | `sync: refuses to discard uncommitted/unpushed work unless force`, `sync: squashed entry proceeds over dirty work and reports discarded` |
| 7 | Unsafe instruction text | Server text is untrusted: signatures flattened to one line, truncated to 500 chars, fenced with one more backtick than their longest run; missing values → `(unknown)`; `judgment.probability` rendered only when `typeof === "number"`; `behavior-changed` next-steps say "read the new code in the synced workspace". | `instructions: signatures are flattened and fenced...`, `...truncate at 500 chars and missing values render (unknown)`, `non-numeric Jev probability is guarded`, `behavior-changed points at the synced workspace` |
| 8 | No push retry; `arb_ready` on dirty tree | Push wrapped in `withRetry` (`isTransientGitError` only). `arb_ready` refuses while the tree is dirty or HEAD is not on `origin/main`, telling the agent to `arb_push` first. | `ready: refuses while the workspace is dirty, pointing at arb_push` (+ integration's push→ready path) |
| 9 | Workdir defaulted inside the user's project | `ARB_WORKDIR` default is `<os.tmpdir()>/arb-workspaces` (`DEFAULT_WORKDIR`); README updated. | covered by default in `resolveConfig`/`ArbService` |

Also fixed the vacuous `trunk-overlap` assertion (`/trunk/` matched the reason
name itself) → now asserts the explanation text (`/Path-overlapping work
cannot be spliced/`).

### Live check (real control plane)

`npm run check:live` (`scripts/live-check.ts`) on 2026-10-13:

| Step | Observed outcome |
|---|---|
| `arb_register` | entry `e28` created; fork `arb-e28-api-0` cloned via `http.extraHeader` Basic auth (token in `GIT_CONFIG_*`, not argv) |
| `arb_push` | commit `744524bd…` pushed (write token via extraHeader) |
| push observed | `GET /api/entries/e28` reported `headCommit === pushed commit` |
| `.git/config` | `url = https://f3ad…artifacts.cloudflare.net/git/arb/arb-e28-api-0.git` — no `x:`/`@`/token anywhere |
| `arb_ready` | accepted → entry retired (`status=retired`) |
| veto | skipped — entry already terminal (retired), not head |

## Decisions

- **Push auth**: `git push origin HEAD:main` with a per-call token injected as
  environment-scoped `http.extraHeader` (see finding 1) — never argv, never the
  stored remote. `origin` is rewritten to the credential-free remote right
  after clone as belt & braces.
- **Squash protection**: `arb_push` refuses when the stored
  `{repo, generation}` no longer matches the entry (squash/refork moved it) —
  i.e. "squashed and not yet synced". After `arb_sync` they match again, so
  pushing is allowed even while status still reads `squashed`. On any drift the
  workspace's credential-free `origin` URL must equal `entry.remote` for the
  current fork to be adopted (missing state file or a re-created server);
  otherwise the push is refused with a pointer to `arb_sync`.
- **`arb_sync` work-safety**: re-cloning discards the workspace, so on a
  non-squashed entry a dirty tree or unpushed commits refuse unless
  `force: true`; on a squashed entry the work is invalidated anyway, so sync
  proceeds and reports `discarded: true`. A second sync on the same
  repo+generation returns `synced: false, reason: "already synced"`.
- **State**: `<workdir>/.mcp-state/<entryId>.json` (outside the clones — a
  state file inside the workspace would be committed by `git add -A`).
- **`inferred`** in `arb_register` is the literal flag "consumes omitted" per
  the task table; `consumesInferred` additionally reports the entry field
  (server truth — inference only happens when `producerId` is also set).
- **Re-fork wait** (`arb_sync`): poll `GET /api/entries/:id` until the repo
  name changed, `remote` is set, `headCommit === baseCommit || null`, and a
  token is present when the remote needs auth (https). The mock squashes
  synchronously so this returns on the first poll there.
- **Tool results** are JSON text only (no `structuredContent`; SDK 1.x only
  surfaces it with an `outputSchema`, which would duplicate the schemas).
- Exact-pinned deps (policy: no floating ranges onto fresh releases).

## Contract issues

None found. Notes/observations:

- `GET /api/entries/:id` returns a token on every authenticated call on the
  real plane, but the mock hands it out only once per (re-)fork
  (`tokenPending`). The tools cope: file:// remotes need no token, and
  `arb_sync` treats a missing token on an auth-requiring remote as "refork
  still in flight".
- `arb_ready` may legitimately target a `squashed` entry's re-forked base
  (`headCommit === baseCommit` no-op retirement); `arb_ready` passes whatever
  commit the workspace HEAD is and lets the control plane decide.

## Known gaps

- `arb_sync` with no prior state trusts `headCommit === baseCommit || null`
  plus token presence to decide the re-fork landed; on the mock this is exact,
  on the real plane the contract's "token omitted while a (re-)fork is in
  flight" is what makes it safe.
- No `arb_reset`/`arb_veto` tools — vetoing stays a human/dashboard action.
- Unit tests stub `service.api`/`cloneInto` via `as any` casts; `ArbGit` itself
  takes an injected `exec` spy. The integration test covers the real path end
  to end.
