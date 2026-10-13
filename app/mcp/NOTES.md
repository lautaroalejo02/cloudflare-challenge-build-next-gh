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
- `src/service.ts`: `ArbService` — API + workspace logic, reused by import from
  `app/demo/src/lib/` (`git.ts`: `cloneRepo`, `commitAll`, `git`, `head`,
  `authUrl`, `redactCredentials`; `admin-key.ts`: `resolveAdminKey`;
  `http.ts`: `ApiClient`). No demo files were edited.
- `src/server.ts`: `createArbServer` — `McpServer` + `registerTool` with zod
  v4 `inputSchema`s; every handler's output and error string passes through
  `redactCredentials`.
- `src/index.ts`: stdio entry; logs only to stderr, prints `adminKey=set|none`
  (never the value).

## How to run / test / deploy

- `npm install` once (deps: `@modelcontextprotocol/sdk@1.32.1`,
  `zod@4.6.7`, both exact-pinned).
- `npm test` — 10 tests: 9 unit + 1 integration (~17-20 s; the integration test
  spawns the real server over stdio).
- `npm start` or register it in a client (see README for verified
  `claude mcp add` / `codex mcp add` + `config.toml` / `devin mcp add`
  commands — all three `--help`s were checked on this machine).
- No deployment: it is a local stdio process. No Cloudflare resources created.

## Decisions

- **Push auth**: `git push <authUrl(remote, token)> HEAD:main` with a token
  fetched per call, instead of demo `push()` (which pushes `origin`). `origin`
  is rewritten to the credential-free remote right after clone, so tokens are
  never in `.git/config`. `authUrl` strips the `?expires=` suffix per contract.
- **Squash protection**: `arb_push` refuses when the stored
  `{repo, generation}` no longer matches the entry (squash/refork moved it) —
  i.e. "squashed and not yet synced". After `arb_sync` they match again, so
  pushing is allowed even while status still reads `squashed`. If the state
  file is missing, the workspace's clean `origin` URL is compared to
  `entry.remote` to decide adoption vs refusal.
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

- When local state is absent and the entry is `squashed`, `arb_push` cannot
  distinguish "synced" from "stale" and refuses — safe direction; `arb_sync`
  recovers.
- `arb_sync` with no prior state trusts `headCommit === baseCommit || null`
  plus token presence to decide the re-fork landed; on the mock this is exact,
  on the real plane the contract's "token omitted while a (re-)fork is in
  flight" is what makes it safe.
- No `arb_reset`/`arb_veto` tools — vetoing stays a human/dashboard action.
- Unit tests stub `service.api`/`cloneInto` via `as any` casts (no DI seam);
  the integration test covers the real path end to end.
