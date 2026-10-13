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
  consumesInferred: boolean;      // (V2) true when `consumes` was omitted at registration and is derived from imports
  forkedExports: SymbolHashes;    // (V2) producer's `exports` snapshot at this entry's latest (re-)fork ({} when forked from trunk)
  bodies: SymbolHashes;           // (V2) this entry's exported symbol -> bodyHash at headCommit (see hasher)
  judging: string[];              // (V2) consumed symbols with a pending Jev judgment; blocks retirement while non-empty
  predicted: string[];            // exported symbols whose `exports` values are unconfirmed stub predictions;
                                  // cleared when the entry's first real push resolves them against reality
  generation: number;             // 0 at creation, +1 per squash/re-fork
  diagnosis: Diagnosis | null;    // set when squashed, cleared when the agent pushes again
  checks: CheckResult | null;     // last check run
}

interface Diagnosis {
  reason: "interface-changed" | "producer-vetoed" | "producer-squashed" | "trunk-overlap" | "prediction-miss"
        | "behavior-changed";   // (V2) signature unchanged, body changed, Jev judged the consumer now incorrect
  changed: Array<{ symbol: string; oldHash: string; newHash: string; oldSignature: string; newSignature: string }>;
                                  // for "behavior-changed": oldHash/newHash are bodyHashes, signatures are equal
  producerCommit: string;
  judgment?: { model: string; probability: number }; // (V2) present only for "behavior-changed"
}

interface CheckResult { commit: string; passed: number; failed: number; durationMs: number; results: Array<{ name: string; ok: boolean; error?: string }>;
                        infra?: boolean; } // true = the checker could not run (platform failure), NOT a test verdict

interface BufferState {
  trunk: { repo: string; commit: string | null; retiredCount: number };
  robSize: number;                // max non-retired entries (speculation depth), default 8
  entries: Entry[];               // all entries, sorted by seq
  stats: { squashes: number; earlyCutoffs: number; retired: number; checksRun: number; pushesSeen: number;
           predictionHits: number; predictionMisses: number;  // per (consumer, symbol) stub-prediction verdicts
           judgments: number; semanticSquashes: number;      // (V2) Jev judgments completed / squashes they caused
           inferredDeps: number };                           // (V2) consumed symbols derived from imports
}
```

## HTTP API (control-plane Worker, base `/api`)
All JSON. Errors: `{ "error": string }` with a 4xx/5xx status.

**Auth (T19).** Every non-GET `/api/*` request and `GET /api/entries/:id` require header `x-arb-key` equal to the `ARB_ADMIN_KEY` Worker secret; otherwise `403 { "error": "forbidden: ..." }`. `GET /api/state`, `GET /api/events` and `GET /api/ws` are public.
- `POST /api/trunk/init` `{ fromDir?: never }` → `{ repo, remote, token }`. Creates `arb-trunk` if missing. The demo then pushes the fixture to it.
- `POST /api/entries` `{ agent, lane, producerId?: string, consumes?: string[], stub?: Record<path, string> }` → `{ entry: Entry, token: string }`.
  - Forks from the producer's fork at its current head (forwarding), or from trunk if there is no producer.
  - `consumes` lists the producer symbol names this entry depends on. Their current hashes are recorded in `entry.consumes`.
  - (V2) `consumes` is optional. When it is omitted and `producerId` is set, `entry.consumesInferred = true` and `entry.consumes` starts as `{}`. On every push of the entry, the control plane extracts its imports (`extractImports`) and sets `consumes[name] = forkedExports[name]` for every imported name that the producer exports from the imported file. Newly added names emit `deps.inferred`. If a newly inferred name already differs between `forkedExports` and the producer's current `exports`, the entry is squashed immediately with reason `interface-changed`.
  - (V2, best effort) Imports of files that another non-retired entry (not the producer, not an ancestor) has changed emit `deps.undeclared`. They are reported only; there is no automatic re-fork. Emitted only when the control plane knows that entry's changed paths cheaply; if computing them costs more than about 300 ms per push, it is skipped and documented in NOTES.
  - `stub` (value prediction) is TypeScript source declaring the entry's *intended* exported signatures. The control plane hashes it with the real hasher; `entry.exports` starts as these predicted hashes and `entry.predicted` lists the predicted symbols until the entry's first real push resolves them. Consumers registering while `producer.predicted` is non-empty forward against the predicted hashes, and get a `prediction.hit` (no squash) or `prediction.miss` (squash with reason `prediction-miss`) verdict per consumed symbol on that first push.
  - `token` is a write token for `entry.repo`, valid 1 hour.
  - Rejected with 409 when non-retired entries are already `>= robSize`.
- `GET /api/entries/:id` → `{ entry: Entry, token?: string }`. Includes a write `token` for `entry.repo` on every (authenticated) call, omitted only while a (re-)fork is in flight. Tokens are reused for up to 30 min, so each is valid for at least 30 more minutes.
- `POST /api/entries/:id/ready` `{ commit: string }` → `{ entry }`. The agent declares its work done at `commit`. Rejected with 409 while squashed, except once the re-fork has landed (`headCommit === baseCommit`) — readying the fork base is then accepted and retires as a no-op when the base already contains the entry's intent.
- `POST /api/entries/:id/veto` → `{ entry, squashed: string[] }`. Head entry only (409 otherwise).
- `POST /api/config` `{ robSize: number }` → `{ robSize }`.
- `GET /api/state` → `BufferState`.
- `POST /api/reset` → clears buffer state and restores `robSize` to its default (8). Does not delete repos. Entry ids/seqs keep increasing across resets.
- `GET /api/events` → `{ events: ArbEvent[] }`, the internal event log (debug/measurement aid; not part of the public contract surface).
- `GET /api/ws` → WebSocket upgrade. The server sends `ArbEvent` JSON messages; the client sends nothing.

## Events (WebSocket messages and the internal log)
```ts
interface ArbEvent {
  type: "entry.created" | "push" | "hash.unchanged" | "hash.changed" | "squash" | "refork" | "ready"
      | "check.started" | "check.passed" | "check.failed" | "prediction.hit" | "prediction.miss"
      | "retired" | "veto" | "config" | "reset" | "retire.retry" | "retire.failed" | "recover"
      | "deps.inferred" | "deps.undeclared" | "jev.judged" | "jev.unavailable"; // (V2)
  ts: number;          // Date.now() on the server
  entryId?: string;
  data?: unknown;      // type-specific; include enough for the UI (e.g. symbol, oldHash, newHash, commit, durationMs)
}
```
On connect, the server first sends `{ type: "snapshot", ts, data: BufferState }`.
(V2) Event payloads (`entryId` is always the consumer):
- `deps.inferred` `data: { producerId, symbols: Record<name, hash> }` (only the newly inferred names).
- `deps.undeclared` `data: { fromEntryId, paths: string[], symbols: string[] }`.
- `jev.judged` `data: { producerId, symbol, probability, verdict: "squash" | "warn" | "clear", commit, model }`.
- `jev.unavailable` `data: { producerId, symbol, reason }` (no key, timeout, HTTP error); treated as `clear`.

The `retired` event's `data` includes `mode: "fast-forward" | "splice"` and `durationMs`; `squash` events for `trunk-overlap` carry `data.overlap: string[]` (the intersecting paths). `check.started`/`check.passed`/`check.failed` on a splice candidate carry `data.splice: true` and the candidate `commit` (which lives on the trunk repo, not the fork).

## Library interfaces (in-process, imported by control-plane via relative paths)

### `app/hasher` exports, from `app/hasher/src/index.ts`
```ts
export interface SymbolSignature { name: string; kind: "function" | "type" | "interface" | "class" | "const"; signature: string; hash: string; }
export interface InterfaceHash { hash: string; symbols: SymbolSignature[]; }
// files: path -> TypeScript source. Only exported declarations count.
// Normalization: comments, formatting and declaration order do not change the hash; function bodies are ignored.
export function hashInterface(files: Record<string, string>): Promise<InterfaceHash>;

// (V2) additive fields on SymbolSignature:
//   file: string;      // repo-relative path of the declaring file, e.g. "src/api/order.ts"
//   bodyHash: string;  // 12 hex of sha256 over the normalized FULL declaration (signature + body/initializer).
//                      // Same normalization as `hash` (comments/formatting ignored), but bodies count.
//   source: string;    // raw declaration text as written, truncated to 4000 chars (input for Jev)
// `hash` (interface hash) is unchanged by V2.

// (V2) Imports, for dependency inference.
export interface ImportRef {
  file: string;      // importing file, repo-relative
  from: string;      // relative specifiers resolved to a repo-relative path ("../api/order.ts" from
                     // "src/ui/checkout.ts" -> "src/api/order.ts"); bare specifiers kept as written
  names: string[];   // imported binding names as exported by `from`; "default" for default, "*" for namespace;
                     // `import type` names included; re-exports (`export { x } from`) count as imports
}
export function extractImports(files: Record<string, string>): Promise<ImportRef[]>;
```
`hash` and `SymbolSignature.hash` are the first 12 hex characters of sha256 over the normalized signature text.

### (V2) Jev semantic judgment (inside `app/control-plane/src/jev.ts`)
- TypeSafe System One API: `POST https://api.typesafe.ai/v1/systemone`, header `Authorization: Bearer <TYPESAFE_API_KEY>` (Worker secret; local copy only in gitignored `app/control-plane/.secret-typesafe-key`), body `{ state, model: "jev-latest", questions }`. A Noul answer is `answers[id].noul` in [0,1]. Errors: 401, 422, 429, 529; retry 429/529/5xx with backoff (0.5 s, 1 s), timeout 8 s per attempt.
- Trigger: a producer push where a symbol consumed by a non-retired consumer keeps its interface `hash` but its `bodyHash` changed. One request per consumer, one Noul question per affected symbol.
- State sent: `{ producer: { symbol, before, after }, consumer: { agent, lane, usage: [{ file, code }] } }`, where `before`/`after` are the declaration `source` texts and `usage` holds the consumer files at its headCommit that import the symbol (each truncated to 6000 chars).
- Question: "The change from `producer.before` to `producer.after` alters behavior that the code in `consumer.usage` relies on, so that code would now be incorrect or produce different results." Criteria true: "The consumer's observable results or correctness change." False: "Pure refactor or an internal change the consumer cannot observe."
- Policy: probability >= 0.7 → squash with reason `behavior-changed`; 0.4 <= p < 0.7 → `warn` (event only); p < 0.4 → `clear` (nothing happens). The push itself still emits `hash.unchanged` and counts the early cutoff exactly as before V2; a later `squash` verdict overrides it. Unavailable → `clear` plus `jev.unavailable`. Jev never blocks retirement for longer than the judgment itself; the 60 s sweep clears stale `judging` markers as unavailable.
- A verdict is applied only if the producer's headCommit still equals the judged commit and the consumer's generation is unchanged; otherwise it is dropped.

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
- 2026-10-13 (T17): `ArbEvent` gains `"retire.retry"` (`data: {attempt, reason}`) and `"retire.failed"` (`data: {reason, strike, exhausted}`). Retirement is now one atomic cycle inside `ArbTrunk` (`retireAtomic`): the splice candidate is checked and landed inside a single serialized slot with bounded rebuilds on rejection, so candidate check/retry events replay after the fact rather than streaming live.
- 2026-10-13 (T19): Admin-key auth: non-GET `/api/*` and `GET /api/entries/:id` require `x-arb-key` == `ARB_ADMIN_KEY` (Worker secret), else 403. `GET /api/state|events|ws` stay public.
- 2026-10-13 (T19): `CheckResult.infra?: boolean` — the checker could not run (Artifacts/loader/network failure). Infra results are never stored as `entry.checks`; the entry stays `checking` and is re-checked. `check.failed` events for them carry `data.infra: true`.
- 2026-10-13 (T19): `ArbEvent` gains `"recover"` (`data: { kind, ... }`, kinds `refork` | `recheck` | `reretire` | `fork-failed` | `<effect>-failed`): a stale in-flight marker was swept and the work re-issued, or an effect failed and was reported instead of wedging the component.
- 2026-10-13 (T19): `GET /api/entries/:id` returns a write token on every authenticated call (was: once per repo change, to whoever asked first).
- 2026-10-13 (T19): `POST /api/reset` restores the default `robSize`; entry ids/seqs keep increasing across resets (fresh fork names, no `-xN` collisions).
- 2026-10-13 (T19): Splice overlap also counts file/dir prefix conflicts (`src/a` vs `src/a/b.ts`), mode-only changes, and keeps gitlinks.
- 2026-10-13 (V2): Dependency inference: `POST /api/entries` `consumes` is optional; omitted + `producerId` derives `consumes` from imports on each push. `Entry` gains `consumesInferred`, `forkedExports`, `bodies`, `judging`. Events `deps.inferred`, `deps.undeclared`.
- 2026-10-13 (V2): Hasher gains `extractImports` and `SymbolSignature.file`/`bodyHash`/`source`.
- 2026-10-13 (V2): Jev semantic squash: body-only changes to consumed symbols are judged by TypeSafe Jev; `Diagnosis.reason` gains `"behavior-changed"` and `Diagnosis.judgment`. Events `jev.judged`, `jev.unavailable`. `stats` gains `judgments`, `semanticSquashes`, `inferredDeps`.
