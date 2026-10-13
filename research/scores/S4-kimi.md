All 25 cards read. Now a few quick prior-art checks on the most suspicious claims.## Scores

| id | wow | mechanism | useful | scale | feasibility | not_median | total | one-line verdict |
|----|-----|-----------|--------|-------|-------------|------------|-------|------------------|
| I01 | 4 | 4 | 3 | 4 | 3 | 4 | 22 | Shared semantic rerere is real, but shape-hash normalization can silently misfire on stage. |
| I02 | 4 | 5 | 4 | 4 | 4 | 4 | 25 | Honest coordination-free additive lane; deliberately narrow, and that's a virtue. |
| I03 | 3 | 4 | 3 | 4 | 3 | 3 | 20 | Symbol-level build cache; canonical hashing across agent formatting drift is a demo-killer. |
| I04 | 4 | 5 | 3 | 3 | 4 | 5 | 24 | Documents-not-goods is gloriously principled, but "taste compliance lands unconditionally" scares real teams. |
| I05 | 5 | 4 | 3 | 4 | 3 | 5 | 24 | 3,100 repos is the best stunt here; lossless round-trip and repo rate-limits decide if it survives 48h. |
| I06 | 3 | 4 | 4 | 4 | 4 | 4 | 23 | Atomic multi-party landing fixes a real failure mode; the wow is an absence, hard to film. |
| I07 | 4 | 5 | 4 | 4 | 3 | 4 | 24 | Retraction as a repo op is fresh; too many moving parts must all work live. |
| I08 | 4 | 4 | 4 | 4 | 3 | 4 | 23 | Rename commutation is genuinely useful, but the operation-envelope protocol is a hard adoption pill. |
| I09 | 4 | 5 | 4 | 4 | 4 | 4 | 25 | Best-balanced card: named mechanism, live invalidation scene, honest OCC fallback, verifiable prior art. |
| I10 | 3 | 4 | 4 | 4 | 4 | 3 | 22 | Baseline-plus-subscription; solid but strictly dominated by I09's richer intent layer. |
| I11 | 3 | 5 | 3 | 4 | 4 | 5 | 24 | Consumer-vote GC is elegant biology; on camera it's one bar draining. |
| I12 | 3 | 5 | 3 | 3 | 4 | 4 | 22 | Real hyperedge-conflict insight buried under solver abstraction; admits exponential blowup. |
| I13 | 3 | 5 | 4 | 4 | 4 | 5 | 25 | RCU grace periods: small, provable, demo-able with countdown timers; quiet wow. |
| I14 | 4 | 4 | 3 | 4 | 5 | 4 | 24 | Cheapest real build in the pool; land-everything posture is philosophically risky for adopters. |
| I15 | 3 | 5 | 4 | 4 | 5 | 3 | 24 | Singleflight dedupe is true and useful, but "work you didn't do" demos poorly. |
| I16 | 4 | 5 | 3 | 3 | 4 | 5 | 24 | Rule-14 refusal is courageous; at scale the doubt clause mass-refuses and burns agent work. |
| I17 | 3 | 5 | 4 | 4 | 4 | 3 | 23 | Verifying-traces admission is sober and correct; reads as dressed-up CI caching. |
| I18 | 4 | 4 | 4 | 4 | 3 | 3 | 22 | Behavioral-delta table is a great scene, but Signadot is very close and in-Worker bundling is risky. |
| I19 | 3 | 4 | 3 | 4 | 4 | 4 | 22 | RECAT costume on a merge queue; spacing-by-static-count never earns its keep. |
| I20 | 4 | 4 | 4 | 3 | 3 | 4 | 22 | Symbol-quarantine scene is strong; requires a specially-instrumented app, capping adoption and 48h odds. |
| I21 | 4 | 4 | 4 | 4 | 4 | 3 | 23 | Google's TAP playbook is proven but that makes it the least surprising serious entry. |
| I22 | 4 | 5 | 4 | 4 | 5 | 4 | 26 | Adaptive OCC→lease escalation: named mechanism, dead-agent reclaim beat, lowest stage risk. |
| I23 | 5 | 5 | 4 | 4 | 3 | 5 | 26 | One-round pooled decode is the most tweetable scene; composition+bundling failure kills the whole act. |
| I24 | 4 | 5 | 4 | 3 | 4 | 4 | 24 | Fork-of-fork speculation is clever; long chains amplify squash storms. |
| I25 | 3 | 4 | 3 | 4 | 4 | 5 | 23 | Plasmid costume over plugin-exclusivity plus test-count comparison; narrow, metaphor-heavy. |

*Verification notes: the AIDev 41.7% cross-agent conflict stat (I10, I23) checks out exactly in arXiv 2607.04697. MuseHub's coordination docs are real and do match I09's characterization (advisory reservations, no commit-time validation). I14's "71% self-merge / 84–90% no review" figures are real but misattributed — they come from codepulsehq.com research, not tformance.com/report/.*

## Duplicates and merges

- **I09 ~ I10 ~ I22 ~ I16 ~ I13 — read-set/write-set OCC spine.** All five capture symbol read/write-sets and coordinate on their intersection. Strongest card: **I09** (richest machinery, honest OCC backstop). Merged keep: I22's contention-triggered lease escalation (hot regions need pessimism, cold ones don't), I13's grace-period shim so breaking changes don't abort readers, I10's wake-up subscription as the abort handler, I16's head-on symmetric refusal for genuinely rival writers.
- **I03 ~ I17 ~ I21 ~ I23 — verification/evidence reuse.** Strongest card: **I23** for mechanism novelty; I17 for sobriety. Merged keep: I17's exact-input-closure receipts as the cache key inside I23's pools; I21's graph-guided bisect as the decoder fallback when pool patterns are inconsistent; I03's custody card as the review surface.
- **I02 ~ I25 ~ I11 — additive-only / co-existing-candidates fast lanes.** Strongest card: **I02** (clean invariant story, honest scope). Merged keep: I25's hard path-enforcement Worker (agents literally cannot touch the core) and I11's consumer-vote decay to garbage-collect unused extensions.
- **I14 ~ I20 ~ I07 — post-hoc trust revision.** Strongest card: **I14**. Merged keep: I20's symbol-granular quarantine instead of whole-commit rewind, I07's "why eligible" provenance view as the challenge evidence.

## Top 5 with improvements

1. **I22 Adaptive Token-Blocks (26)** — Weakest: wow (4). Sharpen the scene: run a side-by-side race on one hot file — pure-OCC lane showing a live abort-storm counter climbing, escalated lane with zero aborts and a TTL reclaim after a scripted agent crash. The hysteresis band ("abort rate 3→token mode, drops below 1→OCC again") becomes a visible gauge.
2. **I23 One-Round Pools (26)** — Weakest: feasibility (3). Scope cut: cap the demo at 24 changes with tiny pre-verified per-change test executors (≤3s suites) and compose pool trees by union of non-overlapping module blobs via `readTree`/`readBlob` only — no general bundler. If per-pool Dynamic Worker bundling flakes by hour 36, fall back to Sandbox SDK pools and present isolate execution as the scale story.
3. **I09 Intent-Registered Transactions (25)** — Weakest: wow (4). Sharper scene: run two identical same-model agents on the same task with and without the intent layer; the no-intent run visibly generates dead work that aborts at COMMIT, the intent run gets the mid-flight ping and never wastes the tokens. "Aborts prevented" becomes dollars not spent.
4. **I02 Monotone Extension Forge (25)** — Weakest: wow (4). Give the escalation beat teeth: the ninth agent isn't just a replacement — have it attempt a hidden cross-extension side effect and watch the admission checker reject it by construction, then a legit replacement escalate to the human decision lane. Refusal-by-structure plus one human decision is the 20 seconds.
5. **I13 Grace Period (25)** — Weakest: wow (3). Put a storefront app on screen consuming the repo live while the breaking change publishes; shim keeps it green, reader countdown ticks 3→0 in real time, token expiry force-quiesces the straggler, and the reclaim commit lands — next to a pure-OCC baseline counter showing how many aborts the same change would have cost.

## Kill list

- **I10** — Scores fine but is strictly the OCC-spine merge target's weakest variant; I09+I22+I13 absorb every valuable bit.
- **I16** — Bold refusal beat, but same-symbol head-on refusal plus a doubt clause destroys agent work at scale; survives only as one rule inside the merged OCC spine.
- **I19** — Strip the aviation costume and it's a merge queue with a static-priority lookup; too close to predictable #5 and "solved infrastructure."
- **I20** — Decent score, but the registry-façade instrumentation requirement means no real team adopts it next week and the demo needs a whole app built to be broken.
- **I25** — Metaphor-to-mechanism ratio is too high; "plugins + pick the higher test count" is I02 with a costume and a narrower world.
- **I08** — Real mechanism, but it demands agents change their write protocol to emit operation envelopes; that ingestion assumption quietly kills 48h realism and next-week adoption.
