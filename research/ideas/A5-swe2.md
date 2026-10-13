Two more searches to check remaining prior art, then I'll write the deliverable.## Baseline critique

Running the fleet, the baseline is the first proposal that attacks my actual bill. OCC at symbol granularity replaces my two daily taxes — merge triage between agent PRs and agents silently building on dead assumptions — and abort-with-exact-diagnosis is precisely the retry signal I paste into agent prompts by hand today. Three honest holes. First, aborts still burn a generation cycle: the agent learns at COMMIT what the system knew at BEGIN. Second, read-set capture needs instrumented agents; without it granularity degrades to files and abort rates spike. Third, one validating Durable Object per repo serializes the hot path. There is also emerging prior art — `rullama-agent`'s optimistic tokens, GenericVC's Git+MVCC unification (vldb.org/cidrdb/papers/2025/p24-yilmaz.pdf) — so "OCC for agents" alone won't impress judges.

Verdict: **improve**. Keep the transaction spine; add **intent publication at BEGIN** — declared write-scope plus pinned read-versions, the non-blocking analogue of Gray 1976 intention locks — so collisions surface before tokens burn; and shard the validator Orleans-style by region so throughput scales with regions, not agents.

### Idea: Intent-Registered Transactions (improved baseline)
- Pitch (one sentence, <=25 words, describes a mechanism): Agents register declared write-scopes and pinned read-versions at BEGIN; a registry intersects in-flight intents, pushes mid-flight invalidations, and still validates optimistically at COMMIT.
- The "wow" scene (20 seconds, concrete, what is on screen): Split screen, two agents working. Agent A commits a rename; agent B's terminal flashes "your pinned `computeTotal@sha:7f2` changed 40s ago — new signature attached" *while B is still writing*. B adapts, commits, validates. An ops counter reads "aborts prevented today: 23 / aborts taken: 2." A conflict resolved before a PR existed.
- Source paradigm: Multi-granularity intention locking — Gray, Lorie, Putzolu, Traiger 1976 (IS/IX locks advertise intent before the write exists); used non-blockingly, as registration not acquisition.
- What replaces the merge conflict / the PR / the branch: Textual merge is never produced. Conflicts surface as intent collisions (at BEGIN, resolvable by re-scoping) or validation aborts (at COMMIT, with symbol-level diagnosis). Branch = fork-snapshot plus an intent record.
- How a human decides without reading code: An air-traffic intent board: live scope-overlap edges, the invalidation feed, abort log with diagnoses. The human intervenes only on collisions flagged as judgment calls — priority inversions, deliberate API breaks.
- Why it scales to 100K agents (what is the coordination cost proportional to): Proportional to in-flight intents — small symbol sets intersected in memory — not to agents or repo size. Invalidation push is point-to-point, driven by commit write-sets.
- Why a real team would use it next week: Pain removed: agents generating work that was dead-on-arrival, and broken assumptions discovered at merge. I stop re-running invalidated agents and stop triaging PRs that were doomed at second zero.
- Cloudflare mapping: which primitive does what; flag anything decorative: Intent registry + validator = Durable Object per repo (SQLite), later sharded by symbol-region. `repo.fork()` = snapshot. Repo push events (Artifacts subscriptions) drive the invalidation feed. Agents SDK WebSockets push notices. Nothing decorative.
- Prior art found (URLs, one line each on what it is and how this differs):
  - https://www.sigmod.org/publications/dblp/db/conf/ds/GrayLPT76.html — the named mechanism; intention locks block, intents here only advertise.
  - https://staging.musehub.ai/muse/coordination — Muse: advisory symbol reservations + TTL + a conflict forecast "before a single line of code changes." Closest prior art; it has no pinned read-versions, no invalidation push on third-party commits, and no commit-time validator — coordination stays advisory.
  - https://thereisnospoon.org/docs/guides/coordinate-agents/ — Seamless: lease-based atomic task claiming; task-level, no semantic intersection.
  - https://docs.rs/rullama-agent/latest/rullama_agent/optimistic/index.html — OCC version tokens for agent ops; file granularity, no intent registry.
  - https://vldb.org/cidrdb/papers/2025/p24-yilmaz.pdf — GenericVC unifies Git and MVCC with configurable conflict detection at commit validation; same thesis at DB level, no in-flight intent layer.
- Why most teams will NOT submit this: Median teams treat coordination as a PR-time problem. Declaring machine-checkable intent *before generation* requires instrumenting the agent and building a symbol registry — plumbing, not a demoable LLM trick.
- Hardest judge objection and the answer: "Agents won't declare honest scopes." Declaration is the advisory fast-path, like IX locks being conservative; COMMIT-time OCC validation remains the gate — undeclared writes merely miss the fast path.
- 48h solo feasibility (1-5) and the single riskiest implementation step: 4. Riskiest: capturing a real coding agent's read-set at symbol granularity via a tool-call shim; file-granularity fallback still demos the mechanism.
- What to mock in the demo and what must be real: Mock the agent itself (scripted scope declarations). Real: intent registry, intersection engine, invalidation push on push-events, OCC validation against real Artifacts objects.
- Scores (1-5): wow 4 / mechanism-not-prompt 5 / useful 5 / scale story 4 / feasibility 4 / not-the-median 4

### Idea: Singleflight Dispatch
- Pitch (one sentence, <=25 words, describes a mechanism): Tasks carry a goal-and-scope key; dispatch matching an in-flight key subscribes to that attempt's result rather than spawning a second agent.
- The "wow" scene (20 seconds, concrete, what is on screen): An ops board queues 50 tasks; 11 collapse into 4 in-flight attempts, each shown "riding" its attempt with live evidence streaming. The attempt commits and all riders flip green simultaneously. A ticker reads "agent-hours not spent: 9.5." The judge watches waste not happen.
- Source paradigm: Request coalescing / singleflight — `golang.org/x/sync/singleflight` and CDN dogpile protection: duplicate concurrent calls share one execution and one result.
- What replaces the merge conflict / the PR / the branch: Duplicates never materialize as branches to merge. The unit is an "attempt" with subscribers; demand count (9 requests coalesced) becomes review priority ranking.
- How a human decides without reading code: Review *attempts*, not tasks — each with its coalesced demand count and evidence manifest. Priority = demand, decided at a glance.
- Why it scales to 100K agents (what is the coordination cost proportional to): Dedup cost is proportional to in-flight keys (hash lookup plus intersection). More importantly it removes superlinear waste: duplicated generation and duplicated review.
- Why a real team would use it next week: Pain removed: agents duplicating work and the triple-review that follows. I stop arbitrating three PRs that solved the same ticket three ways.
- Cloudflare mapping: which primitive does what; flag anything decorative: Dispatch Durable Object per repo; key = hash(task spec + baseline + declared scope); subscriber fan-out via Queues/WebSockets; result lands via the Artifacts binding. All load-bearing.
- Prior art found (URLs, one line each on what it is and how this differs):
  - https://pkg.go.dev/golang.org/x/sync/singleflight — the named mechanism.
  - https://rednafi.com/go/request-coalescing/ — canonical dogpile-prevention write-up; same collapse-and-share shape.
  - https://staging.musehub.ai/muse/coordination — content-addressed task IDs dedupe *enqueued* tasks; does not coalesce in-flight agent attempts or share generated artifacts.
  - https://orcy.dev/ — atomic mission claiming with auto-release; exclusion model — losers get nothing, not a shared result.
  - https://github.com/mariogiancini/conductor-protocol — file claiming for parallel Claude instances; prevents duplicate *files*, not duplicate *goals*.
- Why most teams will NOT submit this: Unglamorous infrastructure; "show me work you didn't do" is hard to film. Median submissions add agents, not dedup.
- Hardest judge objection and the answer: "Different tasks aren't identical — coalescing misses nuance." Partial matches link as dependency edges rather than coalescing; only identical or subsumed keys fold, so nuance survives.
- 48h solo feasibility (1-5) and the single riskiest implementation step: 5. Riskiest: the goal-normalization function — conservative normalization coalesces less but is still correct.
- What to mock in the demo and what must be real: Mock fuzzy goal-similarity (start exact-match). Real: coalescing registry, subscriber fan-out, demand-count ordering.
- Scores (1-5): wow 3 / mechanism-not-prompt 5 / useful 5 / scale story 4 / feasibility 5 / not-the-median 4

### Idea: Epoch Train
- Pitch (one sentence, <=25 words, describes a mechanism): Validated commits land into time-boxed epochs verified once as a composition; failures trigger dependency-graph-guided bisection that quarantines the culprit while the remainder rides on.
- The "wow" scene (20 seconds, concrete, what is on screen): A trunk timeline of green epochs. Epoch 14 goes red, auto-bisects in three runs — not fifty per-PR CIs — quarantines commit #7 with a generated diagnosis, and recomposes green. Dependent agents in a hold queue rebase onto the post-quarantine baseline and land automatically. The trunk visibly heals itself.
- Source paradigm: Google TAP milestone batching + postsubmit culprit-finding (Taming Google-Scale Continuous Testing; "Who broke the build?" ICSE-SEIP'17); FindIt-style try-job bisection for attribution.
- What replaces the merge conflict / the PR / the branch: Per-PR CI gating. Integrate first as an epoch, verify the composition, attribute failures after. A "branch" is a slot on an epoch ref.
- How a human decides without reading code: Per-epoch report: what landed together, who broke it with evidence, what was quarantined. A decision surface of incidents, not diffs.
- Why it scales to 100K agents (what is the coordination cost proportional to): Verification cost is proportional to affected tests per epoch, amortized over N commits; attribution is O(log epoch) via bisect, better with symbol-graph suspect ranking. The only model where per-change verification cost *falls* as agents increase.
- Why a real team would use it next week: Pain removed: flaky integration and red-trunk babysitting. I stop watching 50 agent PRs go red one at a time and stop serializing the trunk behind the slowest CI run.
- Cloudflare mapping: which primitive does what; flag anything decorative: Epoch scheduler = Durable Object + Workflows (durable timers, waitForEvent). Verification = Sandbox SDK fleet running real tests. Symbol graph in DO SQLite ranks suspects before bisect. Epoch compositions are content-addressed objects in the Artifacts repo itself.
- Prior art found (URLs, one line each on what it is and how this differs):
  - https://static.googleusercontent.com/media/research.google.com/en/pubs/archive/45861.pdf — TAP's milestone mechanism (~45-min epochs bundling commits); the paper itself.
  - https://dl.acm.org/doi/abs/10.1109/ICSE-SEIP.2017.13 — Google-scale culprit identification, top-5 in 82% of cases.
  - https://sites.google.com/chromium.org/cat/findit — FindIt: heuristic + try-job bisection with auto-revert; production precedent for auto-quarantine.
  - https://github.com/bors-ng/bors-ng — batch-then-bisect merge queue; my delta: epoch is a first-class repo object, attribution is graph-guided, quarantine emits a diagnosis artifact.
  - https://arxiv.org/html/2501.03440 — Uber SubmitQueue speculation trees order *conflicting* changes; epochs order time and attribute post-hoc.
- Why most teams will NOT submit this: Per-PR gating is sacred; "let unverified code touch the trunk ref" reads as recklessness until the integration-ref and quarantine mechanics are shown.
- Hardest judge objection and the answer: "Unverified code on trunk." Epochs land on `refs/epochs/N`; deployable refs are minted only from green epochs, and quarantine is automatic — FindIt already auto-reverts. Blast radius is one epoch.
- 48h solo feasibility (1-5) and the single riskiest implementation step: 4. Riskiest: real test-runs plus bisect inside demo time; keep epochs small and tests fast — the loop must be real.
- What to mock in the demo and what must be real: Mock learned suspect ranking (graph heuristic suffices). Real: epoch scheduler, sandboxed test execution, bisect-and-quarantine commits.
- Scores (1-5): wow 4 / mechanism-not-prompt 4 / useful 5 / scale story 5 / feasibility 4 / not-the-median 3

### Idea: Adaptive Token-Blocks
- Pitch (one sentence, <=25 words, describes a mechanism): Regions run lock-free until measured contention crosses a threshold, then escalate to TTL'd exclusive write-tokens — pessimism only where conflicts were certain, liveness by expiry.
- The "wow" scene (20 seconds, concrete, what is on screen): A codebase heatmap; `schema.prisma` glows as four agents' intents converge. The region flips to token-block mode live: queued holders, a TTL countdown. An agent dies mid-lease; the token auto-reclaims in twenty seconds and the queue proceeds. A sibling region stays OCC-free the whole time.
- Source paradigm: Time-bounded leases (Gray & Cheriton 1989; Chubby OSDI'06) plus single-line token-block signalling — and inverted hardware lock elision: TSX speculates first and falls back to a lock; here OCC runs first and escalates to a token on measured contention.
- What replaces the merge conflict / the PR / the branch: On hot regions the conflict never forms — exclusion is token custody with an auditable possession trail, not a text collision discovered post-hoc.
- How a human decides without reading code: A lease board: holder, region, TTL, queue depth, escalation history. Intervene by force-reclaim or de-escalation — both first-class ops.
- Why it scales to 100K agents (what is the coordination cost proportional to): Bookkeeping is proportional to contended regions only; cold code never pays for locks. Escalation is a feedback loop (abort-rate → mode) and self-tuning.
- Why a real team would use it next week: Pain removed: hot-file collisions and dead agents holding implicit locks. I stop manually sequencing tasks around shared files — which is literally the lockfiles-and-Slack dance I do now.
- Cloudflare mapping: which primitive does what; flag anything decorative: Lease table in the repo DO's SQLite; TTL via DO alarms; enforcement at push-validation (or scoped `createToken` as the capability object). All structural.
- Prior art found (URLs, one line each on what it is and how this differs):
  - https://research.google.com/archive/chubby-osdi06.pdf — Chubby: coarse-grained locks plus fixed leases for liveness; the mechanism's origin.
  - https://en.wikipedia.org/wiki/Token_(railway_signalling) — token-block working: possession is sole authority, auditable handover.
  - https://github.com/git-lfs/git-lfs/blob/main/docs/api/locking.md — Git LFS file-lock API: path locks, manual release, no TTL, no contention-triggered escalation.
  - https://staging.musehub.ai/muse/coordination — symbol reservations with TTL/heartbeat: advisory, manually declared, not demand-activated.
  - https://www.intel.com/content/www/us/en/developer/articles/technical/tsx-anti-patterns-in-lock-elision-code.html — lock elision and the "lemming effect": the honest oscillation risk this design must damp with hysteresis.
- Why most teams will NOT submit this: Locks are unfashionable — everyone will "just CRDT/merge it" — and adaptive escalation is a second mechanism nobody bolts on. Median teams pick one regime globally.
- Hardest judge objection and the answer: "Locks serialize hot spots." Correct, and that is the point: serialization exactly where conflict was certain, OCC over the cold 95%. The real risk is escalation oscillation — answered with hysteresis on thresholds.
- 48h solo feasibility (1-5) and the single riskiest implementation step: 5. Riskiest: honest contention telemetry to drive escalation; intent-collision count is a viable v1 signal.
- What to mock in the demo and what must be real: Mock the crashing agent (scripted kill). Real: lease state machine, TTL reclaim, token-gated push validation.
- Scores (1-5): wow 3 / mechanism-not-prompt 5 / useful 4 / scale story 4 / feasibility 5 / not-the-median 4

### Idea: Precedent Registry
- Pitch (one sentence, <=25 words, describes a mechanism): Conflict rulings are stored keyed by a normalized conflict-shape signature; matching collisions auto-resolve with citation — adjudication cost scales with distinct shapes, not agents.
- The "wow" scene (20 seconds, concrete, what is on screen): The dreaded API rename lands; thirty in-flight transactions hit the same conflict shape. The first gets a ruling — an adaptor template plus an evidence requirement. The other twenty-nine resolve in milliseconds, a cascade of green "citing precedent #1" ticks rolling down the screen. The judge watches one decision applied thirty times in a second.
- Source paradigm: Stare decisis — common-law precedent with scoped binding, distinguishing, and overruling — mechanically realized via rerere-style normalized hashing, but keyed on semantic conflict shape rather than text.
- What replaces the merge conflict / the PR / the branch: Repeated adjudication. Review happens once per shape; recurring collisions are a lookup, and the recorded citation rides on the commit.
- How a human decides without reading code: A precedent ledger: shape → ruling → application count → scope/expiry. Overruling or narrowing is a first-class act that flags affected applications for re-review.
- Why it scales to 100K agents (what is the coordination cost proportional to): Resolution cost is proportional to distinct conflict *shapes*. At 100K agents, identical collisions dominate and amortize to near-zero marginal cost — the only mechanism here whose cost falls as concurrency rises.
- Why a real team would use it next week: Pain removed: review fatigue from adjudicating the same collision N times — every API migration does this today, and I paste the same answer N times.
- Cloudflare mapping: which primitive does what; flag anything decorative: Precedent table in DO SQLite keyed by shape-hash; shape = normalized (touched-symbols × change-types × dependency-edge context). Rulings carry a transform template plus evidence requirements; applications logged as citations on the commit object.
- Prior art found (URLs, one line each on what it is and how this differs):
  - https://git-scm.com/docs/rerere — rerere: normalized conflict ID → recorded resolution; local-only, text-level, brittle to near-variants — mine is shape-level and scoped.
  - https://github.com/cisagov/rerere-cache — a shared rr-cache kept as a git repo; proves teams already smuggle resolution-reuse out-of-band — this makes it first-class and typed.
  - https://github.com/git/git/blob/master/contrib/rerere-train.sh — trains the cache from merge history; supports pre-seeding precedents.
  - https://www.git-automation.com/conflict-resolution-safe-merge-operations/rerere-conflict-automation/sharing-rerere-resolutions-across-a-team/ — documents exactly this pain (same conflict, N resolvers) and the need for documented reasoning per resolution.
  - https://link.springer.com/article/10.1007/s10506-025-09461-x — AI-and-Law precedent-constraint models (Horty result model line); formal basis for distinguishing and scoping.
- Why most teams will NOT submit this: It demands designing a conflict-shape algebra — the hard intellectual work median teams skip in favor of "the LLM resolves it." Rulings are *recorded decisions*, not generated merges; this is explicitly not LLM-merge.
- Hardest judge objection and the answer: "Precedents can be wrong or stale." Rulings are scoped to material facts with expiry, and overruling is itself a first-class event — auditability is the feature, not the bug.
- 48h solo feasibility (1-5) and the single riskiest implementation step: 3. Riskiest: the shape signature — normalizing enough to catch near-variants without misfiring. Restricting to three conflict classes (rename, signature-change, add/add) keeps it buildable.
- What to mock in the demo and what must be real: Mock the ruling author (human-in-demo or template picker). Real: shape hashing, store, match-and-apply pipeline, citation log, override flow.
- Scores (1-5): wow 4 / mechanism-not-prompt 4 / useful 5 / scale story 5 / feasibility 3 / not-the-median 4

## Unverified

- https://staging.musehub.ai/muse/coordination — fetched successfully, but it is a *staging* docs domain; product maturity, release status, and whether the described reservations/forecast actually ship are unverified. Claims cited are from its own documentation.
- https://docs.rs/rullama-agent/latest/rullama_agent/optimistic/index.html — seen in search results only; crate maturity/adoption unknown.
- https://aiarch.dev/workflows/parallel-agent-writes — appeared in search results with a substantive snippet (argues agent file edits need validation); I did not open the page itself.
- The SXZ.io article (https://sxz.io/cloudflare-artifacts-repo-per-task-git-contest/) quotes Artifacts best-practices text and rate-limit math (~2,000 control-plane requests/10s → ~8 min to mint 100K repos). Seen in search results; not cross-checked against official Cloudflare docs.
- https://github.com/cisagov/rerere-cache and https://www.git-automation.com/...sharing-rerere-resolutions-across-a-team/ — contents seen only in search-result text, not fetched directly.
- Whether Durable Object alarms can fire at the sub-30-second granularity implied by the demo lease TTL — DO alarms are documented; exact minimum granularity unverified.
- web-tree-sitter running inside Workers (needed for symbol-level scopes/shapes in Cards 1, 3, 5) — claimed in the dossiers; I did not independently verify.
- No public evidence found of competitor approaches for this competition (my searches surfaced only official pages and the SXZ analysis) — absence of evidence, not evidence of absence.
