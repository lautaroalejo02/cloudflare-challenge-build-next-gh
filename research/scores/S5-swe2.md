I'll read the brief and the pool first.Reading the rest of the pool.I've read all 25 cards (I01–I25). Now let me verify a few of the most suspicious prior-art / citation claims before scoring.Mostly verified. One more check on the least-familiar cited mechanism (error-locating arrays for I23).All 25 cards judged. Verification notes: the 41.7% cross-agent conflict stat (I10, I23) is real — arXiv 2607.04697, though cross-agent pairs were only 0.5% of that dataset's co-active pairs; the Artifacts "10,000 forks / tens of millions of repos" claims (I05) check out on Cloudflare's own blog; Token Coherence (I24) exists; error-locating arrays (I23) are real combinatorial literature (Martínez/Moura/Panario/Stevens, Colbourn/McClary). One citation error found: I14's "71% self-merge / 84–90% unreviewed" stats trace to codepulsehq.com research, not tformance.com as cited.

## Scores

| id | wow | mechanism | useful | scale | feasibility | not_median | total | one-line verdict |
|----|-----|-----------|--------|-------|-------------|------------|-------|------------------|
| I01 | 4 | 4 | 3 | 4 | 3 | 4 | 22 | rerere grown up — an abort-diagnosis cache that presumes a substrate it doesn't build |
| I02 | 3 | 4 | 3 | 4 | 4 | 4 | 22 | honest monotone lane covering the additive slice, and admits it |
| I03 | 4 | 4 | 4 | 4 | 3 | 3 | 22 | build caching with a custody chain; great 90ms demo, but it's an accelerator |
| I04 | 4 | 5 | 3 | 4 | 4 | 5 | 25 | UCP 600 for code: cleanest "no code on screen" submission; overlap is the gap |
| I05 | 5 | 4 | 3 | 4 | 3 | 5 | 24 | platform-enforced least privilege; answers access control, not composition |
| I06 | 3 | 4 | 4 | 4 | 4 | 4 | 23 | atomic recording of coupled work; demo peak is "nothing happens" — easy to undersell |
| I07 | 3 | 4 | 3 | 4 | 4 | 5 | 23 | evidence retraction as a repo op; real mechanism, heavy adoption story |
| I08 | 4 | 4 | 3 | 4 | 3 | 4 | 22 | refactorings as transportable ops; beautiful for renames, narrow elsewhere |
| I09 | 4 | 5 | 5 | 4 | 4 | 4 | 26 | kills dead-on-arrival work at BEGIN — the pain I actually pay daily |
| I10 | 4 | 4 | 4 | 4 | 3 | 3 | 22 | STM retry closes the abort loop; a feature of the OCC core, not a product |
| I11 | 4 | 4 | 3 | 4 | 4 | 5 | 24 | usage-voted deletion; principled, but a wrong import edge kills live code |
| I12 | 3 | 4 | 3 | 3 | 4 | 4 | 21 | solver picks the bundle; real mechanism for a rare problem, honest scale limits |
| I13 | 3 | 5 | 4 | 4 | 4 | 5 | 25 | RCU for breaking changes; scoped and honest — a primitive, not the product |
| I14 | 4 | 4 | 3 | 4 | 4 | 4 | 23 | land-then-review matches reality; its review stats are misattributed (codepulsehq, not tformance) |
| I15 | 3 | 5 | 5 | 4 | 5 | 4 | 26 | singleflight for agent tasks; removes my weekly pain, demos the least |
| I16 | 4 | 5 | 3 | 4 | 4 | 5 | 25 | COLREGS on set geometry; purest mechanism here, loses head-on work by design |
| I17 | 3 | 4 | 3 | 4 | 3 | 4 | 21 | receipts keyed to input closure; correct CI done hard, heavy for 48h |
| I18 | 4 | 4 | 3 | 4 | 4 | 4 | 23 | Diffy in isolates; best "decide without code" answer, scoped to Workers apps |
| I19 | 4 | 4 | 3 | 4 | 4 | 4 | 23 | wake-separation scheduling; fun metaphor for a problem we don't have yet |
| I20 | 4 | 4 | 3 | 3 | 3 | 4 | 21 | surgical quarantine; killer demo, registry-prerequisite caps adoption |
| I21 | 4 | 4 | 4 | 5 | 4 | 3 | 24 | TAP ported honestly; pooled decoding does the same job sharper |
| I22 | 3 | 5 | 4 | 4 | 4 | 4 | 24 | contention-triggered leases; right instinct, reads as a feature of the tx core |
| I23 | 5 | 5 | 4 | 4 | 3 | 5 | 26 | one round names the interacting pair, not the unlucky second commit |
| I24 | 4 | 5 | 4 | 3 | 4 | 4 | 24 | speculative fork-chaining on interface hashes; literally the organizers' scenario |
| I25 | 3 | 4 | 3 | 4 | 4 | 5 | 23 | declared non-coexistence via cassette competition; deletes rather than integrates |

## Duplicates and merges

- **I09 ~ I10 ~ I22 (+ I13, I01 adjacent) — the OCC/transactional-repo cluster.** All run the same substrate: symbol-granularity read/write-sets validated in a repo DO. Strongest card: **I09** (the intent registry attacks the pain earliest and is the most adoptable). Merged version: I09's BEGIN-time intent registration as the surface; absorb I10's read-set-subscription wake-up as the abort path (abort → auto-watch → wake on invalidating commit); absorb I22's contention-measured escalation to TTL'd leases for hot regions; optionally I13's shim publication as a third response mode for signature breaks. I01's precedent rulings hang off the abort-diagnosis stream as a cache, not a sibling.
- **I03 ~ I17 — content-addressed verification reuse.** Both hash content to skip re-verification. Strongest demo: I03 (8s→90ms custody flash); strongest coverage: I17 (composition-level input closures). Merged: I17's verification-cut receipts as the gate, with I03's canonical symbol-body hashing as the key function and its custody card as the review surface.
- **I21 ~ I23 (+ I19 loosely) — batch verification and attribution.** Both replace per-PR CI with composed verification plus culprit attribution. Strongest: **I23** — decoded interactions name the pair; bisection just blames whoever came second. Merged: I23's non-adaptive round as the fast path, I21's epoch refs + graph-guided bisect as the documented overflow when defects exceed the array's bound; I19's disjoint-runway partitioning is a nice trick for choosing pool composition.
- **I14 ~ I20 ~ I07 — land first, surveil after.** All assume fast landing plus post-hoc correction. Strongest card: I20 (surgical quarantine is the visceral demo). Merged: I14's budgeted challenge as the trigger, I20's exposure-traced symbol quarantine as the response, I07's justification graph as the machinery that computes which dependents are actually affected.
- **I02 ~ I11 ~ I12 ~ I25 — candidates coexist, a rule picks the survivor.** I02 (union only admits non-competing), I12 (solver selects a bundle), I25 (copy-number dilutes), I11 (consumer factor starves). Strongest as a product: I02 — honest scope, real fast lane. Merged: I02's monotone admission for additive work, plus one declared selection rule (I12's solver over I25's Inc groups) for contended slots. I11 is the least adoptable variant of the idea.
- **I04 ~ I06 ~ I16 — statutory decision procedures as integration rules** (UCP 600, escrow, COLREGS). Same design move, distinct mechanisms; they don't merge — they compete for the same "transplanted law" slot in the final 10. I04 and I16 are stronger than I06 on mechanism novelty; I06 is stronger on usefulness.
- **I24 — loosely adjacent to the OCC cluster** but mechanically distinct (speculation, not validation); could share I09's interface-hash infrastructure but stands alone as dispatch-time chaining.

## Top 5 with improvements

1. **I09 — Intent-Registered Transactions (26).** Weakest: wow 4. Improvement: absorb I10's wake-up so an aborted transaction auto-subscribes to its read-set and resumes on the invalidating commit — the demo's peak becomes "the loop closed itself," which is the tweetable 20 seconds.
2. **I23 — One-Round Pools (26).** Weakest: feasibility 3. Improvement: cut to ~48 changes in 8 pools, ship a published ELA construction (Martínez et al., d=2) as the fixed matrix, run a trivially fast suite in Dynamic Workers, and declare the defect bound on screen — planted flake flagged as inconsistent, I21-style bisect named as the overflow path.
3. **I15 — Singleflight Dispatch (26).** Weakest: wow 3. Improvement: make the collapse visible — the moment a second dispatch hashes to an in-flight key it snaps onto that attempt's row live, with the "agent-hours not spent" counter ticking; source tasks from a real shared queue (GitHub Issues import) so the duplicates look organic, not planted.
4. **I04 — Complying Presentation (25).** Weakest: useful 3. Improvement: add an automatic re-presentation rule — a presentation refused for overlap is re-examined against the honoured base with regenerated documents (Sandbox re-run), so collision becomes deterministic retry, not deadlock; the no-merge doctrine survives intact.
5. **I16 — Starboard Rule (25).** Weakest: useful 3. Improvement: make the give-way order actionable — attach the stand-on writer's new signature and rebase target so resubmission is one step, and implement Rule 14's agreement clause as a "convene" path where both head-on agents receive the encounter record; refusal that teaches, not just refusal.

## Kill list

- **I05 (24):** demos well, but operationally it's 3,100 repos answering least-privilege — an access-control product, not a coordination answer; explode/materialize fidelity is the demo's hidden cliff.
- **I21 (24):** competent but it's Google's TAP ported; loses the same batch-verification job to I23, which has the sharper mechanism and the better wow.
- **I11 (24):** automatic deletion of freshly generated code is a production liability and a scary demo; solves "which twin wins," a corner case of the coordination problem.
- **I19 (23):** merge-queue scheduling solves a throughput-ordering problem 50-agent teams don't yet feel; the aviation frame oversells a static proxy metric.
- **I22 (24):** correct instinct, wrong altitude — contention-triggered leases are a feature of the transaction core (merge into I09), and standalone it reads as "file locks with TTL."
