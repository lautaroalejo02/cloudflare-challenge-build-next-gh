## Scores

Scores apply to the submitted mechanism and a real 48-hour demo—not the metaphor, self-scores, or unspecified future sharding. Passing tests establishes scoped evidence, not arbitrary program correctness.

| id | wow | mechanism | useful | scale | feasibility | not_median | total | one-line verdict |
|---|---:|---:|---:|---:|---:|---:|---:|---|
| I01 | 4 | 3 | 4 | 3 | 3 | 4 | 21 | Useful reuse layer; conflict-shape equality does not establish equivalent preconditions, and distinct shapes need not decrease with concurrency. |
| I02 | 3 | 5 | 3 | 5 | 4 | 4 | 24 | Genuinely coordination-free under explicit invariants; useful but restricted to isolated declarative extensions, not general coding. |
| I03 | 3 | 2 | 4 | 3 | 3 | 2 | 17 | Evidence reuse is valuable, but interface-only and depth-two dependency hashes cannot justify transferring behavioral receipts between contexts. |
| I04 | 3 | 2 | 3 | 2 | 4 | 2 | 16 | Document matching cannot establish compositional validity; disjoint writes can violate shared read dependencies. Mostly stricter CI in costume. |
| I05 | 5 | 3 | 3 | 2 | 2 | 5 | 20 | Real capability enforcement; atomization and manifest serialization make claimed scale and 48-hour round-trip fidelity doubtful. |
| I06 | 3 | 4 | 4 | 2 | 4 | 2 | 19 | Atomic bundles are useful, but independent escrow identifiers do not make overlapping trunk writes independent; novelty is thin. |
| I07 | 4 | 5 | 4 | 4 | 3 | 5 | 25 | Explicit support retraction is soundly scoped; exact-context alternatives and publication epochs make this more than an animated dependency graph. |
| I08 | 4 | 5 | 4 | 4 | 3 | 4 | 24 | Genuine operation algebra preserves useful work; scope resolution and capture avoidance are the hard, honest implementation boundary. |
| I09 | 4 | 4 | 4 | 2 | 4 | 3 | 21 | Early invalidation is useful; captured context is incomplete, and one repository validator remains a serialization bottleneck. |
| I10 | 3 | 2 | 3 | 2 | 4 | 3 | 17 | Confuses STM predicate waiting with stale-snapshot aborts; waiting for another write can sleep forever, and subscription registration can lose wakeups. |
| I11 | 3 | 2 | 2 | 2 | 4 | 3 | 16 | Consumer counting is not a correctness election; cycles and unobserved external consumers undermine automatic deletion and distributed liveness. |
| I12 | 4 | 5 | 4 | 3 | 4 | 4 | 24 | Correctly models higher-order conflicts and repair candidates; exponential coupled-component search is acknowledged rather than hand-waved. |
| I13 | 3 | 2 | 4 | 3 | 3 | 4 | 19 | Token expiry is not reader quiescence; live consumers can outlast agent tasks, making automatic shim reclamation unsafe. |
| I14 | 4 | 2 | 2 | 2 | 2 | 3 | 15 | Canned probes and unsupported ref-rewind assumptions conceal dependency-safe recovery; challenge budgets ration attention, not correctness. |
| I15 | 3 | 4 | 4 | 4 | 5 | 2 | 22 | Sound exact-key coalescing and easy adoption; a useful scheduler optimization, not a distinctive replacement for integration. |
| I16 | 3 | 2 | 2 | 2 | 4 | 3 | 16 | Rejecting both competing writers avoids a winner but provides no progress; contended symbols can livelock indefinitely. |
| I17 | 4 | 5 | 5 | 4 | 4 | 3 | 25 | Best evidence model: exact composition, complete action inputs, trusted receipts, and explicit ordered publication; novelty is incremental. |
| I18 | 4 | 3 | 4 | 2 | 3 | 3 | 19 | Behavioral replay is useful evidence; delta-overlap pruning misses latent and higher-order interactions, so independence claims are unsound. |
| I19 | 3 | 2 | 3 | 2 | 3 | 2 | 15 | Blast radius does not decay with elapsed time; arbitrary spacing adds queueing without resolving code dependencies or improving correctness. |
| I20 | 5 | 2 | 3 | 2 | 3 | 4 | 19 | Spectacular rollback scene, but executed symbols are not causes; mixed-version recovery can break invariants and cannot undo external effects. |
| I21 | 4 | 3 | 4 | 3 | 4 | 2 | 20 | Practical batching, largely bors with epochs; logarithmic attribution fails for masking repairs, interacting defects, and flaky outcomes. |
| I22 | 3 | 3 | 4 | 3 | 4 | 3 | 20 | Adaptive exclusion can help hotspots; expiry needs fencing, mode transitions need atomicity, and cross-region transactions remain unresolved. |
| I23 | 5 | 3 | 3 | 2 | 2 | 5 | 20 | Excellent experimental framing; locating guarantees require an unproved constrained fault model, and one round does not imply low work. |
| I24 | 4 | 3 | 4 | 3 | 3 | 4 | 21 | Compelling speculative pipeline; unchanged signatures do not validate behavioral assumptions, and retirement requires real restacking and composition checks. |
| I25 | 3 | 2 | 2 | 3 | 4 | 2 | 16 | Plugin confinement is enforceable; self-authored test counts cannot choose correctness, and incompatibility labels do not prove isolation. |

**Checks affecting the judgment:**
- The cited **41.7%** cross-agent textual-conflict statistic is [real](https://arxiv.org/html/2607.04697v2), but does not establish a universal fleet conflict rate or conflict elimination by subscriptions.
- [Error-locating arrays](https://dl.acm.org/doi/10.5555/1958171.1958178) have logarithmic test-count results under bounded parameters. [Constraints can destroy distinguishability](https://arxiv.org/abs/1801.06041v2); simply excluding illegal compositions does not preserve decoding guarantees.
- [STM `retry`](https://hackage.haskell.org/package/stm/docs/Control-Monad-STM.html) waits for an unsatisfied predicate’s inputs to change. That is different from retrying an already-invalidated snapshot.

## Duplicates and merges

These are shared-core families, not claims that every policy is interchangeable.

- **I03 ~ I17: content-addressed verification reuse. Strongest: I17.**  
  Keep I03’s signed custody records and inspectable execution logs. Retain I17’s complete action-input closure, trusted evaluator, and exact-composition publication gate. Drop interface-only and depth-limited behavioral cache keys. Signing an insufficient key does not repair its soundness.

- **I09 ~ I10 ~ I22 ~ I16: symbol-set admission, invalidation, and retry policies around the transactional baseline. Strongest: I09.**  
  Keep I10’s indexed subscriptions, but atomically subscribe-and-check versions; stale transactions should immediately acquire a fresh snapshot. Add I22’s adaptive leases with fencing epochs and hysteresis. Keep I16’s downstream priority only—not “both writers lose.” The merged validator must cover writes, relevant negative reads, and publication atomically.

- **I19 ~ I21: queue-based composition testing with scheduling and recovery policies. Strongest: I21.**  
  Keep I21’s green-only release refs and real batch testing. Borrow I19’s dependency-disjoint lanes and use weight as a scheduling priority, not an arbitrary waiting interval. Replace blanket logarithmic culprit claims with interaction-aware diagnosis and explicit uncertainty.

- **I11 ~ I25: competing immutable variants selected or pruned by local support scores. Strongest: I25, narrowly.**  
  Keep I25’s enforceable core/plugin boundary; borrow I11’s content-addressed versions, consumer provenance, and rescue pins. Replace self-authored test counts and popularity-based deletion with authoritative acceptance criteria and rooted reachability. This is better folded into I02’s coordinated replacement lane than submitted separately.

**Do not merge I07 with I20:** retracting admission evidence and hot-swapping runtime definitions have fundamentally different consistency and state-recovery obligations.

## Top 5 with improvements

1. **I07 — Retraction-Aware Repository**  
   **Weakest: feasibility, 3.** Scope the MVP to one release authority, an eight-node acyclic graph, and two explicitly checked fallback manifests. Do not implement general alternative-context synthesis. Preserve the real revocation cascade and stale-epoch rejection.

2. **I08 — Reference-Preserving Patch Transport**  
   **Weakest: feasibility, 3.** Restrict the demo to top-level functions and static calls in one TypeScript module, using persisted symbol IDs and compiler-checked reference maps. Reject capture-inducing renames. The rename/body-edit/new-caller scene remains compelling without implementing project-wide refactoring.

3. **I17 — Verification-Cut Repository**  
   **Weakest: not_median, 3.** Add **epoch-fenced publication permits**, bound to the exact manifest, verification cut, and policy epoch. The publication authority serializes consumption with revocation. Demo a policy revocation between “green” and publication: every cached check remains green, yet the stale permit cannot advance the release.

4. **I12 — Configuration Forge**  
   **Weakest: scale, 3.** Add **bounded-component admission**: explicitly sealed verifier-input boundaries, at most eight active candidates per connected component, and an overflow queue. Independent components proceed; dense components visibly lose throughput instead of inheriting a fictitious fleet-wide SAT guarantee.

5. **I02 — Monotone Extension Forge**  
   **Weakest: wow/useful, 3.** Sharpen the wow scene: after namespace allocation, freeze the replacement coordinator. Eight real additive admissions still complete; duplicated, reordered deliveries produce the same executable snapshot. An overwrite stalls. This visibly demonstrates coordination avoidance rather than merely displaying eight plugins.

## Kill list

- **I15:** Excellent infrastructure optimization, but exact-key task coalescing is conventional dispatch plumbing—not a distinctive answer to integrating different changes.
- **I05:** The storage-level capability scene is strong; symbol explosion, lossless materialization, and cross-package manifest coordination overreach the credible demo scope.
- **I06:** Atomic staged bundles are useful, but the escrow metaphor adds little beyond established bundle gating and leaves overlapping escrows unresolved.
- **I13:** Reclamation is the headline mechanism, and its safety condition is wrong: expired agent credentials do not establish consumer quiescence.
- **I20:** Exposure is not causality; safe recovery needs dependency-compatible version manifests and state recovery, not isolated registry flips.
- **I21:** Batch-and-bisect is established prior art; epoch naming and graph-guided ranking do not earn a separate finalist slot.
- **I23:** Keep as research, not this submission: constrained pool distinguishability, masking faults, decoder correctness, and final-bundle validation remain unestablished.
