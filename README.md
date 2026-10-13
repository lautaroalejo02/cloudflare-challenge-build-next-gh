# Agent Reorder Buffer (ARB)

Out-of-order CPU execution applied to coding agents. Every agent change is a
**buffer entry** backed by its own fork on Cloudflare Artifacts. A consumer
change (UI, tests) does not wait for its producer (API) to land: it forks the
producer's *unfinished* fork and starts immediately against the producer's
current interface — Tomasulo-style forwarding. When the producer pushes, a
Durable Object recomputes the producer's exported-interface hash per symbol
and **squashes** only the consumers whose forwarded hash changed; they re-fork
the new head and redo their work with an old-vs-new-signature diagnosis.
Entries **retire** onto trunk in dependency order, as fast-forwards or
path-disjoint splices — never as a textual merge.

**This project was built using Cloudflare Workers and Artifacts.**

## The problem

"UI waits for the API PR" is the main serialization point between parallel
agents. Today's fixes — merge queues, stacked PRs, human review — all work at
merge time: they serialize finished work, and a textual merge conflict is a
lower bound on real incompatibility (interface changes can break a consumer
whose text merges cleanly). Neither queueing nor text merging scales to a
fleet of agents. The ARB moves integration to *dispatch* time: dependents
start immediately on speculatively forwarded interfaces and are corrected only
when reality differs from what they were forwarded.

## The mechanism, as a CPU reorder buffer

| CPU | ARB |
|---|---|
| Reorder buffer entry | `Entry` {fork, exported interface hashes, consumed hashes, producer} |
| Operand forwarding | A consumer forks the producer's unfinished fork |
| Broadcast on the common data bus | `cf.artifacts.repo.pushed` events via a Queue |
| Squash on mispredict | Consumed interface hash changed → re-fork + diagnosis |
| Retirement | In-order fast-forward / splice onto `arb-trunk` main |
| ROB size | `robSize` config — the speculation-depth cap the human sets |

Concretely, per `app/CONTRACTS.md`:

- **Forwarding.** `POST /api/entries` with `producerId` forks the producer's
  fork at its current head (`fork-of-fork` — verified working in spike 3) and
  records `entry.consumes`, the producer symbols the new entry depends on,
  with the hashes it forked against.
- **Squash.** Every push recomputes the producer's per-symbol interface hash
  (web-tree-sitter inside the Worker). If a consumed symbol's hash changed,
  each dependent is squashed: re-forked from the producer's new head, its
  agent gets a `Diagnosis` (old vs new signature per changed symbol), and its
  `generation` increments. A squash cascades transitively.
- **Early cutoff.** A push that changes no consumed symbol's hash — e.g. a
  body-only refactor — triggers nothing. Counted in `stats.earlyCutoffs`.
- **In-order retirement.** An entry retires onto trunk only when it is at the
  head of the buffer (lowest `seq`), its producer has retired, its agent has
  marked it ready, and its checks pass on its head commit — run inside a
  Dynamic Worker.
- **Retirement modes.** If the trunk head is an ancestor of the entry head:
  fast-forward via isomorphic-git inside the Worker. Otherwise a
  **path-disjoint splice**: if the paths the entry changed (P) and the paths
  trunk changed since the entry's base (Q) are disjoint, a new commit —
  `arb: splice <entry-head> onto <trunk-head>` — overlays P onto the trunk
  tree with `parents = [trunk head]`, is pushed to the `arb-candidate` ref
  on the trunk repo, re-checked there, and only then `main` is moved to it
  (disjoint changes commute). If P ∩ Q ≠ ∅ the entry is squashed with reason
  `trunk-overlap` and re-forks *from trunk*. There is never a textual merge —
  see the Decision section of `odd/tasks/agent-reorder-buffer.md`; implemented
  in `app/control-plane/src/retire.ts` + `src/splice.ts`.
- **Interface hashes only decide *when to squash early*.** Behavior is still
  verified at retirement: an unchanged signature does not prove unchanged
  behavior.

## What the human decides

Two things, and nothing else:

- **Buffer size** (`robSize`, default 8): the speculation-depth cap.
  `POST /api/config {robSize}`; new entries are rejected with 409 when
  non-retired entries reach the cap.
- **Veto**: `POST /api/entries/:id/veto` on the head entry only. A veto
  squashes exactly that entry's transitive dependents — highlighted on the
  dashboard first — which re-fork from the vetoed entry's own base so they
  can still retire later.

## Why it scales

- Coordination cost is proportional to the **edges of the in-flight
  dependency DAG** (the `consumes` records), not to the number of agents.
- A squash costs the fan-out of one changed interface; pushes that leave the
  interface hash unchanged cost nothing (early cutoff).
- Disconnected dependency components map to **one reorder-buffer DO per
  connected component** (the current deployment uses a single
  `idFromName("default")` DO; the data model carries no cross-component
  state, so sharding by component is the documented scale-out path).
- Long chains amplify mispredicts; `robSize` bounds that exactly as in
  hardware. Forks are near-free: 10 parallel forks measured at 1.9 s wall
  (`spikes/SPIKES.md`).

## Architecture

```mermaid
flowchart TD
    subgraph Agents
        AA[API agent]
        UA[UI agent]
        TA[Tests agent]
    end

    subgraph CF[Cloudflare]
        subgraph ART["Artifacts (namespace arb)"]
            TRUNK["arb-trunk · main"]
            E1["arb-e1-api-0<br/>entry fork"]
            E2["arb-e2-ui-N<br/>fork-of-fork"]
            E3["arb-e3-tests-N<br/>fork-of-fork"]
        end
        Q["Queue arb-push-events<br/>subscription arb-ns-push-sub"]
        W["arb-control-plane Worker<br/>/api HTTP · /api/ws · queue consumer"]
        DO["ReorderBuffer Durable Object<br/>single-threaded state machine<br/>+ 3 s alarm poll fallback"]
        HASH["web-tree-sitter hasher (WASM)<br/>exported-interface hash"]
        DW["Dynamic Worker via Worker Loader<br/>runChecks on head commit"]
        ISO["isomorphic-git retirer<br/>fast-forward / splice"]
        DASH["Dashboard<br/>Workers static assets"]
    end

    AA -->|git push, 1h write token| E1
    UA -->|git push| E2
    TA -->|git push| E3
    E2 -.->|forked from unfinished fork| E1
    E3 -.->|forked from unfinished fork| E1
    E1 & E2 & E3 -->|cf.artifacts.repo.pushed| Q
    Q --> W --> DO
    DO -->|readTree → hashInterface| HASH
    HASH -.->|reads commit tree| ART
    DO -->|runChecks| DW
    DW -.->|reads commit files| ART
    DO -->|retire at head| ISO
    ISO -->|git push, fast-forward or splice| TRUNK
    DO -->|ArbEvent over WebSocket| DASH
    W -->|serves /| DASH
```

Primitive → role mapping:

| Cloudflare primitive | Role in the machine |
|---|---|
| Artifacts fork | One buffer entry = one repo; the speculative register |
| Artifacts fork-of-fork | Forwarding: consumers fork the producer's unfinished fork |
| Artifacts write tokens | Per-entry git credentials (1 h TTL), minted on create/refork |
| Artifacts `repo.pushed` events | The common data bus broadcast |
| Queues (`arb-push-events`) | Push-event fan-in to the control plane |
| Durable Object (`ReorderBuffer`) | The reorder buffer: single-threaded, in-order retirement |
| Dynamic Workers (Worker Loader) | Sandboxed checks on each entry's head commit |
| Workers static assets | Dashboard served at `/` by `arb-control-plane` |
| isomorphic-git in a Worker | Fast-forward / splice retirement onto `arb-trunk` |

Deeper design: [`docs/architecture.md`](docs/architecture.md).

## Repository layout

```
app/
  CONTRACTS.md        shared contracts — the single source of truth
  control-plane/      Worker + ReorderBuffer DO + queue consumer + API
  hasher/             exported-interface hashing (web-tree-sitter WASM)
  checker/            runChecks(): tests inside a Dynamic Worker
  demo/               fixture app, scripted agents, scenario runner, local mock
  dashboard/          static pipeline UI (no build step)
  retirer-spike/      fast-forward retirement proof + reusable module
docs/                 architecture.md, demo-script.md
research/             idea council: dossiers, scored idea pool, top10.md
spikes/               8 platform feasibility spikes with measured numbers
odd/                  task tracking (odd/tasks/agent-reorder-buffer.md)
```

## Run it

Prerequisites: **Node 22** (built and tested on v22.15.1), **Wrangler
>= 4.149.0** (installed per package; older versions cannot create
namespace-scoped event subscriptions — spike 2a), and a **Cloudflare account
with Artifacts** that Wrangler is authenticated to.

### 1. Deploy the control plane

```sh
cd app/control-plane
npm install
scripts/setup.sh        # creates queue + push subscription + wrangler deploy
```

`setup.sh` runs the one subscription the system needs — a namespace-wide push
subscription covering `arb-trunk` and every `arb-e*` fork (per-fork
subscriptions would need runtime REST calls; see `app/control-plane/NOTES.md`):

```sh
npx wrangler queues subscription create arb-push-events \
  --source artifacts \
  --events repo.pushed \
  --source-namespace arb \
  --name arb-ns-push-sub
```

The dashboard is served by the same Worker at `/` (Workers static assets);
`/api/ws` is the live event stream. Optional proof deployments exist for the
library packages — `app/hasher` (`npm run deploy:test-worker`),
`app/checker` and `app/retirer-spike` (`npx wrangler deploy`) — but none are
required; hasher and checker are imported in-process by the control plane.

### 2. Run the demo

```sh
cd app/demo
npm install
npm run demo -- --base https://arb-control-plane.<your-subdomain>.workers.dev
```

Three scripted agents (API/UI/Tests) run the organizers' scenario: a body-only
API refactor (early cutoff), then a breaking `createOrder` signature change
(two squashes, re-forks, diagnoses), then in-order retirement e1 → e2 → e3.
Fully offline alternative — a local mock control plane with no Cloudflare at
all:

```sh
npm run mock -- --port 8899 --root tmp-mock/live   # terminal 1
npm run demo -- --base http://127.0.0.1:8899        # terminal 2
```

Tests per package: `npm test` (control-plane 26 cases — state machine +
splice + git-level retire; demo 5 scenario cases, dashboard 24
event-folding cases, hasher 24 hash checks, checker and retirer-spike unit
suites).

## What is real vs mocked

**Real:** every Cloudflare primitive above — Artifacts repos, fork-of-fork
forwarding, write tokens, `repo.pushed` events through the queue, the DO
state machine, WebSocket events to the dashboard, interface hashing in a
Worker, checks in a Dynamic Worker, and fast-forward/splice retirement.
All ports in the deployed control plane are real (no stubs) — the full
scenario ran end to end against `arb-control-plane`; see "Live E2E results"
in `app/control-plane/NOTES.md`.

**Mocked:** agent intelligence. The three agents are deterministic scripts
(`app/demo/src/agents/`): there is no LLM anywhere. Adapting to a squash is a
regex sniff of the producer's signature choosing between two pre-written file
variants; the "fix" for a failing check is likewise pre-written. `app/demo`'s
`mock-server.ts` is a local stand-in for the whole control plane (bare git
repos, poll-based push detection, regex hashing, `-X theirs` merge) and exists
only to make agent state machines testable offline — it is not used against
the real deployment.

## Measured numbers

Every figure was measured in a real run; source file per row.

| What | Number | Source |
|---|---|---|
| Artifacts create→push→read round trip | median 4.28 s (3.35–5.98, n=6) | `spikes/SPIKES.md` |
| `repo.pushed` event latency | median 3.77 s, max 5.88 s (n=10) | `spikes/SPIKES.md` |
| DO alarm poll detection (fallback path) | median 0.70 s, max 1.52 s (n=10) | `spikes/SPIKES.md` |
| Fork / fork-of-fork | 1.9–2.4 s; 10 parallel forks: 1.9 s wall | `spikes/SPIKES.md` |
| Interface hash inside a Worker | ~30 ms CPU median; 2669 KiB upload / 333 KiB gzip | `app/hasher/NOTES.md` |
| Dynamic-Worker check | 4/4 pass in 261 ms; worst cold-machine miss ~7.7 s | `app/checker/NOTES.md` |
| Fast-forward retirement from a Worker | ~0.9 s median; 17–45 ms CPU | `app/retirer-spike/NOTES.md` |
| Sandbox `npm test` on a fork (rejected path) | warm 18.8–20.7 s | `spikes/SPIKES.md` |
| Push → squash, live | ~1.7 s end-to-end (push detection + hash + squash in one poll tick); earlier manual smoke ~8 s | `app/control-plane/NOTES.md` |
| Squash → re-fork done, live | ~2.3 s / ~4.5 s (two parallel forks) | `app/control-plane/NOTES.md` |
| Check in a Dynamic Worker, live | 90–187 ms per commit (incl. 90 ms splice candidate) | `app/control-plane/NOTES.md` |
| Failed check → fix push detected, live | ~2.8 s | `app/control-plane/NOTES.md` |
| Retirement, live | fast-forward 507 ms / 518 ms; splice 1085 ms | `app/control-plane/NOTES.md` |
| Live end-to-end, main scenario | ~38 s wall — 2 squashes, 2 early cutoffs, 3 retired, 3 checks run, 5 pushes seen | `app/control-plane/NOTES.md` |
| Live end-to-end, failing-check scenario | 43.8 s wall — 2 squashes, 2 early cutoffs, 3 retired (e3 via splice), 5 checks run, 7 pushes seen | `app/control-plane/NOTES.md` |
| Full 3-agent scenario, local mock | 2 squashes, 4 early cutoffs, 3 retired in ~23 s | `app/demo/NOTES.md` |

## Limitations and next steps

- **Interface hashing is heuristic.** No type checker: unannotated code gets
  literal-based inference, so a body-only change can occasionally move a hash
  (`app/hasher/NOTES.md`). Checks at retirement remain the behavioral gate.
- **Squash window.** Work pushed to a stale fork while its re-fork is in
  flight must be redone (`app/control-plane/NOTES.md` known gaps).
- **Vetoed entries hold buffer slots** until `POST /api/reset` (contract
  semantics: `robSize` counts non-retired entries).
- **Scale-out is a design argument, not a measurement:** one DO serves the
  whole buffer today and the largest real run had 3 entries. The "fleet of
  agents" claim rests on one-DO-per-connected-component sharding, which is
  documented but unmeasured.
- **Next steps:** stub value prediction with a hit/miss counter (speculate on
  a declared stub before the producer writes anything), Grace Period hand-off
  for breaking changes with readers outside the buffer, LLM-driven agents,
  per-fork event subscriptions, veto confirmation in the UI.
- Prior art and the "why not just stacked PRs" answer: `research/top10.md`
  Idea 3 — stacks are linear chains restacked by humans after the producer
  pushes; the buffer is a DAG over in-progress work with automatic
  interface-hash squash.

## License

MIT — see [LICENSE](LICENSE).
