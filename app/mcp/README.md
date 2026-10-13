# arb-mcp — join the Agent Reorder Buffer from any MCP client

A local **stdio MCP server** that lets any MCP-capable coding agent (Claude
Code, Codex, Devin) work as an ARB buffer entry with zero git/ARB plumbing in
the agent. The agent edits files in a managed workspace directory and calls six
tools; this server owns the control-plane API, fork tokens and push auth.

Tools:

| Tool | What it does |
|---|---|
| `arb_register` | `POST /api/entries`, then clone your fork into `<ARB_WORKDIR>/<entryId>` |
| `arb_status` | `GET /api/entries/:id` — status, generation, base/head, checks; plus `instructions` when squashed |
| `arb_sync` | After a squash (or a failed register clone): wait for the re-fork, replace the workspace with a fresh clone. Won't silently discard uncommitted/unpushed work — pass `force: true` |
| `arb_push` | Commit all workspace changes and push with a fresh per-push token |
| `arb_ready` | `POST /api/entries/:id/ready` with the workspace HEAD commit — refused while the tree is dirty or unpushed |
| `arb_state` | Compact `GET /api/state` summary: entries, trunk, stats |

## Configuration (env)

| Var | Default | Meaning |
|---|---|---|
| `ARB_BASE_URL` | `https://arb-control-plane.lautitomasalejo.workers.dev` | control-plane base URL |
| `ARB_ADMIN_KEY` | `app/control-plane/.secret-admin-key` (via `resolveAdminKey`) | admin key for protected endpoints |
| `ARB_WORKDIR` | `<os.tmpdir()>/arb-workspaces` | where entry workspaces are cloned — deliberately outside your project so buffers and tools never trip over them |
| `ARB_POLL_MS` | `1000` | poll cadence while waiting for forks |
| `ARB_SYNC_TIMEOUT_MS` | `120000` | default deadline for `arb_sync` |

## Setup

The server runs TypeScript directly (Node 22 `--experimental-strip-types`,
same as `app/demo`). Replace `<REPO>` with the absolute path to this repo.

### Claude Code

```sh
claude mcp add arb -e ARB_BASE_URL=https://arb-control-plane.lautitomasalejo.workers.dev -- node --experimental-strip-types --disable-warning=ExperimentalWarning <REPO>/app/mcp/src/index.ts
```

(`claude mcp add <name> -e KEY=value -- <command> [args...]` — verified against `claude mcp add --help`.)

### Codex

```sh
codex mcp add arb --env ARB_BASE_URL=https://arb-control-plane.lautitomasalejo.workers.dev -- node --experimental-strip-types --disable-warning=ExperimentalWarning <REPO>/app/mcp/src/index.ts
```

or edit `~/.codex/config.toml` directly:

```toml
[mcp_servers.arb]
command = "node"
args = ["--experimental-strip-types", "--disable-warning=ExperimentalWarning", "<REPO>/app/mcp/src/index.ts"]

[mcp_servers.arb.env]
ARB_BASE_URL = "https://arb-control-plane.lautitomasalejo.workers.dev"
```

### Devin

```sh
devin mcp add arb -e ARB_BASE_URL=https://arb-control-plane.lautitomasalejo.workers.dev -- node --experimental-strip-types --disable-warning=ExperimentalWarning <REPO>/app/mcp/src/index.ts
```

(`devin mcp add <NAME> -e KEY=VALUE -- <COMMAND> [ARGS...]` — verified against `devin mcp add --help`; `-s project` writes `.devin/mcp_config.json` if you want it committed.)

## Agent workflow

1. `arb_register { agent, lane, producerId?, consumes?, stub? }` — you get an
   `entryId` and a `workspace` path. `consumes` lists the producer symbols you
   rely on; omit it (with `producerId` set) to let the control plane infer them
   from your imports (`inferred: true` in the result).
2. Edit files inside `workspace`. It is a normal git repo; never add remotes or
   credentials yourself.
3. `arb_push { entryId, message }` — commits everything and pushes. Repeat as
   needed.
4. `arb_status { entryId }` — when `status` is `"squashed"`, read
   `instructions`: it lists the consumed symbols whose signatures (or judged
   behavior) changed and what to do next.
5. On a squash, call `arb_sync { entryId }` — it waits for the re-fork and
   replaces the workspace with the new producer head. Redo your work against
   the new code, then `arb_push` again.
6. `arb_ready { entryId }` — posts the workspace HEAD to the control plane,
   which runs the repo's checks and retires entries in buffer order.
7. `arb_state` — overview of every entry, the trunk and buffer stats.

## Security

- Fork write tokens are fetched per push (`GET /api/entries/:id`) and handed to
  git only through environment-scoped config — `GIT_CONFIG_*` env vars carrying
  `http.extraHeader: Authorization: Basic base64("x:<token-secret>")`. The
  token never appears in argv (hooks, `ps` and error text can't see it), in the
  remote URL, or in `.git/config`.
- Every git child runs with `-c core.hooksPath=<empty dir>` and
  `-c core.fsmonitor=false`, so no hook or fsmonitor daemon — global, template
  or repo — executes against the workspace. The child env is scrubbed of
  `ARB_ADMIN_KEY`, `TYPESAFE_*` and ambient `GIT_CONFIG_*`.
- Every error string and serialized tool result goes through
  `redactCredentials` before it leaves the process.
- The admin key is read from `ARB_ADMIN_KEY` or the gitignored key file and is
  never printed (the startup line only says `adminKey=set|none`).
- Entry ids are validated (`^e\d+$`) at the schema boundary and percent-encoded
  into API paths; resolved workspace paths are asserted to stay inside
  `ARB_WORKDIR`.

## Development

```sh
npm install
npm test    # unit (validation, instructions, redaction) + integration over stdio
npm start   # run the server on stdio
```

The integration test spawns this server over stdio with the SDK's
`StdioClientTransport` and drives the full lifecycle against the local mock
control plane (`app/demo/src/mock-server.ts`): producer register → push →
consumer register → producer breaking push → squashed `arb_status` with
instructions → refused `arb_push` → `arb_sync` → push → ready → both retired.
