First read `odd/prompts/_builder_head.md` completely and follow every rule in it. Also read `odd/tasks/arb-v2.md` and `odd/prompts/V2-mcp.md`, the original spec. Another agent edits `app/hasher/` in parallel; do not touch it.

# Task V2b: Fix the audit findings in the MCP server (commit 04f4d66)

## Allowed edit surfaces
app/mcp/**

Do not edit `app/demo/**`. If a demo helper is unsuitable, write a local wrapper inside `app/mcp/src/`.

## Findings to fix (RED test first for each where deterministic, then GREEN)
1. **Token in git argv and exposed to hooks** (`src/service.ts` ~134 clone, ~287 push).
   - Stop putting `x:<token>@` in the URL. Use a local `execFile` git wrapper that passes the credential through environment-scoped config: `GIT_CONFIG_COUNT`, `GIT_CONFIG_KEY_n`, `GIT_CONFIG_VALUE_n`, with `http.extraHeader=Authorization: Basic base64("x:<token>")`. Verify that Artifacts accepts it: check the Artifacts git auth docs (https://developers.cloudflare.com/artifacts/), or test it against a real fork through the live API with the admin key. If Basic via extraHeader does not work, fall back to a git credential helper fed over stdin, and document which one works.
   - Also pass `-c core.hooksPath=<an empty dir under the workdir>` and `-c core.fsmonitor=false`.
   - Strip `ARB_ADMIN_KEY` and any `TYPESAFE_*` from the child env.
2. **`entryId` path traversal** (`src/server.ts` ~26). Validate with `z.string().regex(/^e\d+$/)` on every tool, and use `encodeURIComponent` in the API client path building. As defense in depth, assert that every resolved workspace path stays inside `ARB_WORKDIR`.
3. **`arb_push` re-adopts a changed fork** (~266-271). Adopt a new repo/generation only if the workspace origin URL equals `entry.remote`. Otherwise refuse with a clear message to call `arb_sync`.
4. **Orphaned entry on a failed clone** (~162). The error message must include the created `entryId` and say to call `arb_sync` to retry the clone. `arb_sync` must clone when there is no local state.
5. **Double `arb_sync` blocks** (~208). If local `repo`/`generation` already match the server's, return immediately with `synced: false, reason: "already synced"`.
6. **`arb_sync` deletes unpushed work silently** (~133). If the workspace has uncommitted changes or unpushed commits and the entry is not squashed, refuse unless `force: true` is passed. When squashed, proceed, but report `discarded: true` in the result.
7. **Unsafe instruction text** (`src/instructions.ts`).
   - Render each signature in a fence longer than its longest backtick run.
   - Collapse CR/LF in single-line fields and truncate each signature to 500 chars.
   - Print `(unknown)` for missing values.
   - Guard `judgment.probability` with `typeof === "number"`.
   - For `behavior-changed`, say "read the new code in the synced workspace", not "shown above".
8. **Push retry and dirty-tree warning.** Wrap the push in the existing `withRetry`, transient errors only. `arb_ready` must refuse while the working tree is dirty and tell the agent to `arb_push` first.
9. **Default workdir.** Default `ARB_WORKDIR` to `<os.tmpdir()>/arb-workspaces`, not inside the user's project. Document the change in the README.

## Tests
Fix the vacuous `trunk-overlap` assertion (`test/unit.test.ts` ~176). Add tests for:
- traversal rejection;
- the double sync;
- refusing a dirty or unpushed sync without `force`;
- backticks and newlines in signatures;
- a non-numeric probability;
- the env scrub: the child env has no `ARB_ADMIN_KEY`;
- the git invocation: argv contains no token, and the credential travels only in `GIT_CONFIG_*`. Assert with an injected spawn spy.

Run one real check against the live API (`https://arb-control-plane.lautitomasalejo.workers.dev`, admin key via `resolveAdminKey`) that registers an entry, clones it, pushes one commit and marks it ready through your server code. Then verify:
- `.git/config` contains no token;
- the push succeeded.

Afterwards call `POST /api/entries/:id/veto` only if your entry is the head. Otherwise leave it; a later `/api/reset` clears it. Do NOT call `/api/reset` yourself.

## Verification
- `npm test` in `app/mcp`: counts.
- The live check result, with each step's observed outcome and no secrets.
- NOTES.md: a "V2b audit fixes" table with finding → fix → test name.
