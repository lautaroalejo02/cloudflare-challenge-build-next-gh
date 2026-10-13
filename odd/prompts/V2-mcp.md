First read `odd/prompts/_builder_head.md` completely and follow every rule in it. Also read `odd/tasks/arb-v2.md`. Then do the task below. Other agents work in parallel on `app/hasher/`, `app/control-plane/` and `app/dashboard/`; do not touch them.

# Task V2: MCP server so any agent can join the buffer

## Allowed edit surfaces
app/mcp/**

## Goal
A local stdio MCP server, `app/mcp/`, that lets any MCP-capable coding agent (Claude Code, Codex, Devin) work as a buffer entry, with no git or ARB plumbing in the agent. The agent only edits files in a workspace directory and calls the tools.

## Stack
- Node 22, TypeScript run with `node --experimental-strip-types`, the same as `app/demo`.
- The official `@modelcontextprotocol/sdk` (stdio transport). Fetch its current README or docs and check the installed typings; never guess the API.
- Reuse by import, WITHOUT editing them:
  - `../demo/src/lib/git.ts`: `cloneRepo`, `commitAll`, `push`, `head`, `redactCredentials`;
  - `../demo/src/lib/admin-key.ts`: `resolveAdminKey`.

## Configuration (env)
- `ARB_BASE_URL`: default `https://arb-control-plane.lautitomasalejo.workers.dev`.
- `ARB_ADMIN_KEY`: or the default key file via `resolveAdminKey`.
- `ARB_WORKDIR`: default `<cwd>/.arb-workspaces`.

## Tools
Validate every input with zod schemas.

| Tool | Input | Behavior |
|---|---|---|
| `arb_register` | `agent`, `lane`, `producerId?`, `consumes?: string[]`, `stub?: Record<path, string>` | `POST /api/entries`. Clone the fork into `<ARB_WORKDIR>/<entryId>`. Return `{ entryId, workspace, status, producerId, consumes, inferred: consumes omitted }`. |
| `arb_status` | `entryId` | `GET /api/entries/:id`. Return status, generation, base/head commits and checks summary. If squashed, add an `instructions` string written for an LLM agent: why (old vs new signature for each changed symbol; for `behavior-changed` the Jev probability and the before/after note), and what to do next (`arb_sync`, then redo the work against the new producer code). |
| `arb_sync` | `entryId` | After a squash, wait until the re-fork landed (repo changed and `headCommit === baseCommit` or null; poll with timeout). Then re-clone into the workspace, replacing it, and return the new base plus the same `instructions`. |
| `arb_push` | `entryId`, `message` | Commit all changes in the workspace and push using a fresh token from `GET /api/entries/:id`. Return the commit. Refuse with a clear message while squashed and not yet synced. |
| `arb_ready` | `entryId` | `POST /api/entries/:id/ready` with the workspace HEAD commit. |
| `arb_state` | none | Compact summary of `GET /api/state`: entries with status, lane, producer; trunk; stats. |

## Security (hard)
- Tokens never leave the server process. They are never returned in a tool result or written to logs or files, and they are not left in `.git/config`: after clone, set the remote URL without credentials and pass the token per push.
- Run every error string through `redactCredentials`.
- The admin key is never printed.

## Tests (RED first where deterministic)
- Unit tests: input validation, instruction rendering for each diagnosis reason, and token redaction (no `art_v2_` or `x:` credentials in any tool output).
- Integration test: start the local mock server from `app/demo` (`app/demo/src/mock-server.ts`; read it for its port/CLI and its trunk-init flow) in a temp dir. Use the SDK client over stdio against your server and drive:
  1. producer register;
  2. push;
  3. consumer register;
  4. producer breaking push;
  5. consumer `arb_status` shows squashed with instructions;
  6. `arb_sync`;
  7. push;
  8. ready both;
  9. both retired.

  Use explicit `consumes` in this test (the mock does not implement inference).

## Docs
`app/mcp/README.md` with:
- copy-paste setup for Claude Code (`claude mcp add ...`), Codex (`~/.codex/config.toml` `[mcp_servers.arb]`) and Devin (`devin mcp`); verify each command's syntax from current docs or `--help` before writing it;
- a short agent workflow: register → edit workspace → push → status → (sync on squash) → ready.

## Verification
- `npm test` in `app/mcp`: all green, with counts.
- Paste one redacted sample `arb_status` output for a squashed entry.
- NOTES.md per the head rules.
