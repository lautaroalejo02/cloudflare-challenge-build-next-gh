# Agent Reorder Buffer (ARB): shared contracts

Source of truth for every package under `app/`. Packages are built in parallel by different agents, so code strictly against this file. If a contract is wrong, do NOT silently change it: implement what is written, and describe the problem under "Contract issues" in your package's NOTES.md.

## The mechanism, in one paragraph
Out-of-order CPU execution applied to coding agents. Every agent change is a **buffer entry** backed by its own Artifacts fork.

- **Forwarding:** a consumer entry (e.g. UI) does not wait for its producer (e.g. API) to land. It forks the producer's *unfinished* fork and starts immediately against the producer's current interface.
- **Squash:** when the producer pushes, the control plane recomputes the producer's exported-interface hash per symbol. If a symbol a consumer depends on changed, the consumer is **squashed**: it is re-forked from the producer's new head and its agent gets a diagnosis (old vs new signature) to redo its work. If no consumed symbol changed (body-only edit), nothing happens (early cutoff).
- **Retirement:** entries retire onto the trunk in order (lowest `seq` first). An entry retires when its producer has retired, its agent has marked it ready, and its checks pass on its head commit. Retirement is a **fast-forward** when the trunk head is an ancestor of the entry head. Otherwise it is a **path-disjoint splice**: with P = paths the entry changed vs its `baseCommit` and Q = paths trunk changed since that base, a disjoint P ∩ Q produces a new commit on the trunk head (trunk tree + P overlaid from the entry head) which is pushed to a candidate ref, checked, and only then landed on `main`. An overlapping P ∩ Q squashes the entry with reason `trunk-overlap`. There is never a textual merge.
- **The human** sets the buffer size (speculation depth) and can veto the head entry. A veto squashes exactly its transitive dependents.

## Packages and ownership
| Dir | Owner | Purpose |
|---|---|---|
| `app/control-plane/` | control-plane agent | Worker + ReorderBuffer Durable Object + queue consumer + HTTP/WS API + static dashboard hosting |
| `app/hasher/` | hasher agent | Exported-interface hashing for TypeScript, runs inside a Worker (web-tree-sitter) |
| `app/checker/` | checker agent | Runs a commit's tests inside a Dynamic Worker (Worker Loader), with TS type stripping |
| `app/demo/` | demo agent | Fixture app (`fixture/`), scripted agents and the scenario runner (Node, local) |
| `app/dashboard/` | dashboard agent | Static pipeline UI (no build step) |
| `app/retirer-spike/` | spike agent | Proves fast-forward retirement onto a trunk repo from a Worker (isomorphic-git) |

Agents never edit another package's directory.

## Naming and environment
- Cloudflare account `f3adabb2e83104cf7b9c244077547991`. Use Wrangler >= 4.149.0, installed locally per package.
- The production Worker name is `arb-control-plane`. Throwaway test Workers must be prefixed `arb-test-<package>-`.
- Artifacts namespace `arb`. The trunk repo is `arb-trunk` (branch `main`). Entry forks are named `arb-e<seq>-<lane>-<n>`, where `<n>` increments on each re-fork.
- Queue `arb-push-events`, with a repo-scoped subscription per fork for event `pushed`. If subscriptions cannot be created per fork fast enough, fall back to the namespace-scoped subscription and filter by repo name. Use `max_batch_timeout` of 1 second.
- Git auth for local clients: `https://x:<token>@<remote-host>/<path>` (token with the `?expires=` suffix stripped) and `GIT_TERMINAL_PROMPT=0`.

## Data model (TypeScript)
```ts
type Lane = string;               // display lane, e.g. "api", "ui", "tests"
type SymbolHashes = Record<string, string>; // symbol name -> 12-hex-char hash of its normalized signature

interface Entry {
  id: string;                     // "e<seq>"
  seq: number;                    // retirement order, assigned at creation, monotonically increasing
  agent: string;                  // agent display name
  lane: Lane;
  status: "speculating" | "squashed" | "ready" | "checking" | "retired" | "failed" | "vetoed";
  repo: string;                   // current Artifacts fork name
  remote: string;                 // git remote URL of `repo` (without credentials)
  producerId: string | null;      // entry this one forked from (null = forked from trunk)
  baseCommit: string;             // commit of producer (or trunk) at fork time
  headCommit: string | null;      // latest pushed commit on this entry's fork
  exports: SymbolHashes;          // this entry's exported-interface hashes at headCommit
  consumes: SymbolHashes;         // producer symbols this entry depends on, with the hashes it forked against
  predicted: string[];            // exported symbols whose `exports` values are unconfirmed stub predictions;
                                  // cleared when the entry's first real push resolves them against reality
  generation: number;             // 0 at creation, +1 per squash/re-fork
  diagnosis: Diagnosis | null;    // set when squashed, cleared when the agent pushes again
  checks: CheckResult | null;     // last check run
}

interface Diagnosis {
  reason: "interface-changed" | "producer-vetoed" | "producer-squashed" | "trunk-overlap" | "prediction-miss";
  changed: Array<{ symbol: string; oldHash: string; newHash: string; oldSignature: string; newSignature: string }>;
  producerCommit: string;
}

interface CheckResult { commit: string; passed: number; failed: number; durationMs: number; results: Array<{ name: string; ok: boolean; error?: string }>; }

interface BufferState {
  trunk: { repo: string; commit: string | null; retiredCount: number };
  robSize: number;                // max non-retired entries (speculation depth), default 8
  entries: Entry[];               // all entries, sorted by seq
  stats: { squashes: number; earlyCutoffs: number; retired: number; checksRun: number; pushesSeen: number;
           predictionHits: number; predictionMisses: number }; // per (consumer, symbol) stub-prediction verdicts
}
```

## HTTP API (control-plane Worker, base `/api`)
All JSON. Errors: `{ "error": string }` with a 4xx/5xx status.
- `POST /api/trunk/init` `{ fromDir?: never }` → `{ repo, remote, token }`. Creates `arb-trunk` if missing. The demo then pushes the fixture to it.
- `POST /api/entries` `{ agent, lane, producerId?: string, consumes?: string[], stub?: Record<path, string> }` → `{ entry: Entry, token: string }`.
  - Forks from the producer's fork at its current head (forwarding), or from trunk if there is no producer.
  - `consumes` lists the producer symbol names this entry depends on. Their current hashes are recorded in `entry.consumes`.
  - `stub` (value prediction) is TypeScript source declaring the entry's *intended* exported signatures. The control plane hashes it with the real hasher; `entry.exports` starts as these predicted hashes and `entry.predicted` lists the predicted symbols until the entry's first real push resolves them. Consumers registering while `producer.predicted` is non-empty forward against the predicted hashes, and get a `prediction.hit` (no squash) or `prediction.miss` (squash with reason `prediction-miss`) verdict per consumed symbol on that first push.
  - `token` is a write token for `entry.repo`, valid 1 hour.
  - Rejected with 409 when non-retired entries are already `>= robSize`.
- `GET /api/entries/:id` → `{ entry: Entry, token?: string }`. Includes a fresh write `token` when the entry was re-forked since the agent last fetched it, so the agent can clone the new fork.
- `POST /api/entries/:id/ready` `{ commit: string }` → `{ entry }`. The agent declares its work done at `commit`. Rejected with 409 while squashed, except once the re-fork has landed (`headCommit === baseCommit`) — readying the fork base is then accepted and retires as a no-op when the base already contains the entry's intent.
- `POST /api/entries/:id/veto` → `{ entry, squashed: string[] }`. Head entry only (409 otherwise).
- `POST /api/config` `{ robSize: number }` → `{ robSize }`.
- `GET /api/state` → `BufferState`.
- `POST /api/reset` → clears buffer state. Does not delete repos.
- `GET /api/events` → `{ events: ArbEvent[] }`, the internal event log (debug/measurement aid; not part of the public contract surface).
- `GET /api/ws` → WebSocket upgrade. The server sends `ArbEvent` JSON messages; the client sends nothing.

## Events (WebSocket messages and the internal log)
```ts
interface ArbEvent {
  type: "entry.created" | "push" | "hash.unchanged" | "hash.changed" | "squash" | "refork" | "ready"
      | "check.started" | "check.passed" | "check.failed" | "prediction.hit" | "prediction.miss"
      | "retired" | "veto" | "config" | "reset";
  ts: number;          // Date.now() on the server
  entryId?: string;
  data?: unknown;      // type-specific; include enough for the UI (e.g. symbol, oldHash, newHash, commit, durationMs)
}
```
On connect, the server first sends `{ type: "snapshot", ts, data: BufferState }`.
The `retired` event's `data` includes `mode: "fast-forward" | "splice"` and `durationMs`; `squash` events for `trunk-overlap` carry `data.overlap: string[]` (the intersecting paths). `check.started`/`check.passed`/`check.failed` on a splice candidate carry `data.splice: true` and the candidate `commit` (which lives on the trunk repo, not the fork).

## Library interfaces (in-process, imported by control-plane via relative paths)

### `app/hasher` exports, from `app/hasher/src/index.ts`
```ts
export interface SymbolSignature { name: string; kind: "function" | "type" | "interface" | "class" | "const"; signature: string; hash: string; }
export interface InterfaceHash { hash: string; symbols: SymbolSignature[]; }
// files: path -> TypeScript source. Only exported declarations count.
// Normalization: comments, formatting and declaration order do not change the hash; function bodies are ignored.
export function hashInterface(files: Record<string, string>): Promise<InterfaceHash>;
```
`hash` and `SymbolSignature.hash` are the first 12 hex characters of sha256 over the normalized signature text.

### `app/checker` exports, from `app/checker/src/index.ts`
```ts
export interface CheckerEnv { ARTIFACTS: any; LOADER: any; }
// Reads every file at `commit` of `repo`, strips TypeScript types, loads the result as a Dynamic Worker,
// and runs every module matching tests/**/*.test.ts. Test convention: each test module exports
// `async function run(): Promise<Array<{name: string; ok: boolean; error?: string}>>`.
export function runChecks(env: CheckerEnv, repo: string, commit: string): Promise<CheckResult>;
```
The `CheckResult` shape is defined above.

### Retirer (inside `app/control-plane/src/retire.ts`, port shape in `src/ports.ts`)
```ts
interface RetireArgs { fromRepo: string; commit: string; baseCommit: string; toRepo: string; branch: string; candidateBranch?: string }
type RetireOutcome =
  | { outcome: "fast-forward"; commit: string; ms: Record<string, number> }
  | { outcome: "splice"; candidate: string; ms: Record<string, number> }   // candidate pushed to candidateBranch on toRepo; check then moveBranch
  | { outcome: "overlap"; overlap: string[]; p: string[]; q: string[]; ms: Record<string, number> };
interface RetirerPort {
  retire(args: RetireArgs): Promise<RetireOutcome>;
  moveBranch(args: { toRepo: string; branch: string; commit: string }): Promise<void>;
}
```

## Fixture convention (`app/demo/fixture/`)
- `src/api/order.ts` (producer: exports `createOrder` and its types), `src/ui/checkout.ts` (consumer), and `tests/order.test.ts`.
- Plain TypeScript with no runtime dependencies. Relative imports must include the `.ts` extension (`import { createOrder } from "../api/order.ts"`), so type-stripped modules resolve in a Dynamic Worker without rewriting.
- Tests self-export `run()` per the checker convention.

## Changelog
- 2026-10-13 (T8): `Diagnosis.reason` gains `"trunk-overlap"` — squash reason when an entry's changed paths intersect trunk's changed paths at retire time.
- 2026-10-13 (T8): Retirement semantics documented (fast-forward vs path-disjoint splice vs trunk-overlap squash); `RetirerPort` interface added.
- 2026-10-13 (T8): `retired` event `data.mode`/`durationMs`, `splice` flags on candidate check events and `data.overlap` on trunk-overlap squashes documented.
- 2026-10-13 (T8): `GET /api/events` debug endpoint added.
- 2026-10-13 (T8): `entry.ready` accepts a squashed entry's re-forked base (`headCommit === baseCommit`), enabling a no-op retirement when the base already contains the entry's intent.
- 2026-10-13 (T8): `GET /api/entries/:id` fresh-token trigger changed from "generation bumped" to "repo changed" — Artifacts tokens are per-repo, and generation bumps precede re-fork completion.
- 2026-10-13 (T11): `POST /api/entries` accepts `stub?: Record<path, string>` — declared exported signatures, hashed by the real hasher into predicted `entry.exports`.
- 2026-10-13 (T11): `Entry.predicted: string[]` added — symbols whose `exports` are unconfirmed stub predictions, cleared on the entry's first real push.
- 2026-10-13 (T11): `Diagnosis.reason` gains `"prediction-miss"` — squash reason when a consumed symbol's actual hash diverges from the producer's declared stub on its first push (diagnosis carries predicted vs actual signature).
- 2026-10-13 (T11): `stats.predictionHits` / `stats.predictionMisses` added — per (consumer, symbol) verdicts on the producer's first push.
- 2026-10-13 (T11): `ArbEvent` gains `"prediction.hit"` (`data: { producerId, symbol, hash, commit }`) and `"prediction.miss"` (`data: { producerId, symbol, predictedHash, actualHash, predictedSignature, actualSignature, commit }`); `entryId` is the consumer.
- 2026-10-13 (T14): Sharded control plane — the buffer is served by one `ReorderBuffer` DO per connected component behind an `ArbRouter` DO; retirement is serialized by an `ArbTrunk` DO. Public API unchanged except: `GET /api/state` entries gain an optional `component` field (owning component name, `comp-<rootEntryId>`), and global `robSize` is enforced across all components.
