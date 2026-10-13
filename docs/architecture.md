# ARB architecture

Deep design notes for the Agent Reorder Buffer. Contracts and data-model
types live in `app/CONTRACTS.md`; this document explains how the pieces move.

## Components and where the logic lives

| Piece | Location | Role |
|---|---|---|
| `rob.ts` | `app/control-plane/src/rob.ts` | Pure reorder-buffer state machine. `apply(state, cmd, now)` returns `{state, effects}`; no Cloudflare imports, unit-tested with `node:test` (11 cases). |
| Ports | `app/control-plane/src/ports.ts` | `ArtifactsPort` (real, wraps the `ARTIFACTS` binding), `HasherPort`, `CheckerPort`, `RetirerPort` — the state machine's only I/O surface, so integration swaps interfaces not logic. |
| DO | `app/control-plane/src/do.ts` | `ReorderBuffer` Durable Object, one instance `idFromName("default")`. Executes effects, persists state, broadcasts events over hibernating WebSockets, runs the alarm poll. |
| Worker | `app/control-plane/src/index.ts` | `/api/*` → DO; queue consumer → `onPush`; everything else → static assets. |
| Hasher | `app/hasher/` | `hashInterface(files)` — web-tree-sitter + TypeScript grammar WASM, normalizes signatures so formatting/comments/bodies/reordering never move a hash. |
| Checker | `app/checker/` | `runChecks(env, repo, commit)` — walks the commit tree, strips TS (sucrase), loads a Dynamic Worker via the Worker Loader, calls each `tests/**/*.test.ts` module's `run()`. |
| Retirer | `app/retirer-spike/src/retire.ts` | `fastForward()` — isomorphic-git + in-memory fs inside a Worker; fetches the fork branch, verifies ancestry, pushes non-forced to trunk. |
| Dashboard | `app/dashboard/` | Static UI; folds `ArbEvent`s into a `BufferState`-shaped model (`state.js`, DOM-free, Node-testable). |
| Demo | `app/demo/` | Fixture repo, three scripted agents, `scenario.ts` runner, and `mock-server.ts` (local control-plane stand-in for offline tests). |

The push path, end to end:

```
agent git push → Artifacts repo.pushed → Queue arb-push-events
  → Worker consumer → ReorderBuffer DO
  → readTree(new commit) → hashInterface(files)
  → apply(state, push cmd) → effects {squash+refork | nothing (early cutoff)}
  → broadcast ArbEvent to dashboards
```

Interface hashing happens in the DO *between* `apply` calls (queue/alarm →
`readTree` → `hashInterface` → `push` command), which keeps `rob.ts` pure.

## The state machine

`Entry.status` has seven values (`app/CONTRACTS.md`). Transitions, as
implemented in `rob.ts` and documented in `app/control-plane/NOTES.md`:

```
                 ┌─────────────── entry.created ───────────────┐
                 ▼                                             │
           speculating ──push──▶ speculating (headCommit updated)
                 │                                             │
                 │ POST /ready, commit == headCommit           │
                 ▼                                             │
               ready ──at head──▶ checking ──pass──▶ retired   │
                 ▲                  │                          │
                 │                  └──fail──▶ failed          │
                 │                                             │
   squashed ◀──hash.changed / veto / producer squashed          │
      │                                                        │
      └── refork effect → speculating, generation+1, diagnosis │
                                                               │
   vetoed ◀── POST /veto on head only                          │
```

Key invariants:

- **Ready requires `commit == headCommit`.** A push to a `ready` / `checking`
  / `failed` / `squashed` entry returns it to `speculating` — "retry" is
  push + ready again.
- **Checks run only at the head.** A ready non-head entry waits; this is
  what makes retirement strictly in-order.
- **Squash sets `diagnosis`** (`reason` + per-symbol old/new hashes and
  signatures + producer commit) and bumps `generation`; the diagnosis is
  cleared when the agent pushes again.
- **Veto reparents dependents.** A veto squashes exactly the transitive
  dependents; each re-forks from the vetoed entry's *own base* and its
  `producerId` is repointed to the vetoed entry's producer, so dependents
  can still satisfy "producer retired" later.
- **`robSize` counts non-retired entries** — vetoed entries occupy a slot
  until `POST /api/reset`.

## Events

`ArbEvent` (`app/CONTRACTS.md`) is the single stream consumed by the
dashboard over `GET /api/ws` (WebSocket, hibernation API) and recorded in
the DO's internal log. On connect the server first sends
`{type:"snapshot", data: BufferState}` — `snapshot` is intentionally outside
the contract's union (contract issue noted in `app/control-plane/NOTES.md`).

| Event | Fires when | Carries |
|---|---|---|
| `entry.created` | `POST /api/entries` forks trunk or a producer fork | entry |
| `push` | `repo.pushed` (queue or alarm poll) deduped and hashed | repo, commit |
| `hash.unchanged` | push changed no exported-symbol hash | — (early cutoff) |
| `hash.changed` | ≥1 exported-symbol hash moved | symbol, oldHash, newHash |
| `squash` | a consumed symbol changed / producer vetoed / producer squashed | entryId, diagnosis |
| `refork` | new fork minted for a squashed entry | repo, generation |
| `ready` | agent POSTs ready | commit |
| `check.started` / `check.passed` / `check.failed` | head entry's `runChecks` | commit, durationMs, results |
| `retired` | head entry landed on trunk | commit |
| `veto` | head-entry veto | entryId, squashed[] |
| `config` | `POST /api/config` | robSize |
| `reset` | `POST /api/reset` | — |

## Retirement modes

Retirement never produces a textual merge. Per the Decision in
`odd/tasks/agent-reorder-buffer.md` (which superseded the original
fast-forward-only plan after T4 found consumer forks can stop containing the
producer's final head after an early-cutoff push):

1. **Fast-forward** — trunk head is an ancestor of the entry head.
   `fastForward()` fetches the fork branch into an in-memory object store,
   verifies descent with `git.isDescendent`, and pushes non-forced; the git
   server independently re-enforces fast-forward. Measured ~0.9 s median,
   17–45 ms CPU (`app/retirer-spike/NOTES.md`).
2. **Path-disjoint splice** — trunk moved on disjoint paths. P = paths the
   entry changed vs its `baseCommit`; Q = paths trunk changed since that
   base. If P ∩ Q = ∅, a new trunk commit overlays P onto the trunk tree
   with `parents = [trunk head]`. Disjoint changes commute (patch theory),
   so the splice is order-independent. Checks still run on the spliced tree
   before trunk moves.
3. **`trunk-overlap` squash** — P ∩ Q ≠ ∅. The entry is squashed so its
   agent re-applies on a fresh fork. This extends the contract's
   `Diagnosis.reason` union.

A non-descendant commit currently gets 409 `NOT_FAST_FORWARD` from the
retirer; the splice is wired in during integration (T8). Live E2E timings:
TBD (pending integration run).

## Failure modes and handling

| Failure | Detection | Handling |
|---|---|---|
| Interface mispredict | consumed symbol hash changed | squash dependents transitively; refork + diagnosis; `generation+1` |
| Body-only push | aggregate hash unchanged | early cutoff — no work, `hash.unchanged`, `stats.earlyCutoffs++` |
| Failed check at retirement | `check.failed` | entry → `failed`, blocks retirement; next push → `speculating`; ready retries |
| Trunk moved under an entry | FF ancestry check fails | path-disjoint splice, or `trunk-overlap` squash |
| Queue event lost/delayed | alarm poll every ~3 s over trunk + live repos | dedupe by `repo:commit` (`seenPushes`, cap 500) + `headCommit` equality; measured detection median 0.70 s |
| Duplicate push (queue + alarm both fire) | same dedupe keys | second delivery is a no-op |
| Push during in-flight refork | pushes to the stale repo name are ignored | known gap: work on the stale fork must be redone |
| Effect failure (fork throws) | 500 / queue retry | entry's pending-refork flag persists until a later push reuses it; no automatic unjam |
| Transient platform error (1042/1104) | spike-observed flakiness | retry once (`spikes/SPIKES.md`) |
| DO version pinning after deploy | alarmed DOs serve old `scriptVersion` ~2 min | verify via `wrangler tail`; expected propagation lag |
| Repo name collision after reset | `ALREADY_EXISTS` on fork create | retry as `arb-e<seq>-<lane>-<n>-x<k>`, `repoAlias` resolves dependents' sources |
| LOADER cache cold machine | slow check | retry; worst observed ~7.7 s end-to-end |
| Squash storms on long chains | — | bounded by `robSize` (speculation depth), same as hardware |
| Human veto of wrong entry | veto restricted to head; dependents previewed in UI | transitive dependents squash and reparent (recoverable) |
| Persisted-state shape change on redeploy | constructor forward-fills `_internal` | `{...initialState()._internal, ...stored}` |

## The scale argument

- **Cost ∝ DAG edges, not agents.** All coordination work — hash compare,
  squash fan-out, retirement order — touches only `consumes`/`exports`
  records of in-flight entries. Agents with no dependency edges between them
  never interact.
- **Early cutoff is the common case.** Most pushes are body edits; an
  unchanged interface hash costs one tree read + ~30 ms of hash CPU and
  wakes nobody.
- **One DO per connected component.** A single-threaded DO is the correct
  serialization point *per dependency component*: retirement order only
  needs to be total within a component. The current build runs one
  `default` DO; the BufferState carries no cross-component data, so routing
  `idFromName(componentId)` is the horizontal path. (Cloudflare's own
  experience with single-coordinator DOs motivated this design —
  `research/top10.md` Idea 2 cites the Workflows V1→V2 migration.)
- **Forks are near-free.** Spike 3 measured 10 parallel forks in 1.9 s wall;
  a squash costs the fan-out of one changed interface, paid only on
  mispredict.
- **The expensive parts are constant-size.** Check = one Dynamic Worker per
  head entry (~261 ms warm). Retirement = one git ff (~0.9 s). Neither grows
  with fleet size.
- **`robSize` bounds mispredict amplification** on long chains — the same
  reason hardware reorder buffers are finite.

## Known seams

Tracked per package in each `app/*/NOTES.md` under "Contract issues" and
"Known gaps": `snapshot` event outside the `ArbEvent` union, reset-time repo
naming, `RetirerPort` signature mismatch (`fastForward(env, args)` vs the
contract's no-env form), `ArbEvent.data` loosely typed (dashboard folds
defensively), hasher inference limits without a type checker, and the
stale-fork push window.
