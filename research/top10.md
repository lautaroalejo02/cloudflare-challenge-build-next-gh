# Top 10: final idea shortlist for the Cloudflare "Build the next GitHub" challenge

This is the idea council's final shortlist of 10 mechanisms, ordered by recommendation, for the challenge described in `research/brief.md`.
Step 1: three SWE-2 researchers wrote evidence dossiers with URLs (`research/dossiers/D1.md`, `D2.md`, `D3.md`).
Step 2: five advisors from different model families (A1 Opus, A2 GPT-6.1 Sol, A3 Grok, A4 Kimi K3, A5 SWE-2) wrote 25 anonymous idea cards (`research/pool.md`).
Step 3: five blind judges cross-scored all 25 cards. Self-votes were removed, so each idea has n=4 judges. Step 4 was this synthesis, which merged duplicates, applied the judges' scope cuts and dropped killed ideas.
Aggregate means, top-5 counts and kill counts are in `research/logs/aggregate.txt`. The Scores line on each card repeats the aggregate means of its main source card. Nothing was re-scored.

---

### Idea 1: One-Round Pools (error-locating-array integration)
- Pitch (one sentence, <=25 words, describes a mechanism): Test N pending agent changes in one parallel round of pooled compositions arranged as an error-locating array; decoding names broken changes and interacting pairs.
- The "wow" scene (20 seconds, concrete, what is on screen): 24 pending agent changes (48 as a stretch goal). The judge clicks **Integrate**. A grid of pool cells appears, each cell one composed subset running its tests in its own isolate, and the whole grid turns green or red in one wave. The decoder prints: "#7 broken alone. **#19 × #33 interaction**: each passes alone, together they fail `checkout.test`. #12: inconsistent pattern, flagged as a flake." 21 changes land on the green-only deployable ref and 3 bounce back with diagnoses. Beside the grid, a live adaptive-bisection race is still on round 3 and has blamed #33 alone.
- Source paradigm: Group testing (Dorfman's 1943 pooled blood screening), specifically non-adaptive combinatorial group testing and error-locating arrays (ELAs).
- What replaces the merge conflict / the PR / the branch: Integration becomes one pre-designed experiment instead of a queue. A "conflict" becomes a decoded interaction: a pair that fails only together. The array names both members of the pair, whereas bisection blames whichever landed second. Branch = one fork per change. PR = one row of the incidence matrix. Two donor rules: landed sets publish only to a green-only deployable ref (from I21), and a failing pair excludes only that exact assignment, never every superset that might include a later repair (from I12).
- How a human decides without reading code: The human sees an incidence matrix with a verdict per change: clean, culprit, interaction pair or flake, each with its failing test. The defect bound d is shown on screen. Two buttons: "bounce both to their agents" and "accept, quarantine the test". If the pattern exceeds the bound, the screen says "degenerate: falling back to bisection" instead of guessing.
- Why it scales to 100K agents (what is the coordination cost proportional to): The number of test runs grows roughly with d² log N for a small defect count d, not with N, and latency is one round whatever N is. This holds only while d stays within the array's bound. At fleet scale, changes are batched by connected component. Each batch is an independent DO with its own matrix, and batches that exceed the bound overflow to graph-guided epoch bisection (I21's path). Forks are near-free, so the binding cost is test CPU.
- Why a real team would use it next week: Merge queues are the throughput ceiling for agent fleets. Bisection also mis-blames interaction bugs on the later change, which sends the wrong agent back to work. In one study, cross-agent PR pairs conflicted textually in 41.7% of replays (https://arxiv.org/html/2607.04697v2), and textual conflicts are a lower bound on real incompatibility.
- Cloudflare mapping: which primitive does what; flag anything decorative: Artifacts `fork` gives one inspectable repo per pool. Pool trees are composed from path-disjoint blobs via `readTree`/`readBlob` plus isomorphic-git, with no worktree (essential). Dynamic Workers run each pool's tests in a fresh isolate (essential: with containers a round takes minutes). A DO holds the design matrix, the decoder and exclusion records. Queues fan out pool jobs. Sandbox SDK is only the non-JS fallback and is decorative in the demo.
- Prior art found (URLs, one line each on what it is and how this differs):
  - https://en.wikipedia.org/wiki/Group_testing and https://webpages.tuni.fi/uta_statistics/liski-arkisto/mtt-perusteet10/mttp-kurssi10/Materiaalia/Dorfman-Ann1943.pdf: the paradigm.
  - https://ruor.uottawa.ca/handle/10393/23083: ELAs locate faulty configuration interactions. No application to concurrent code changes was found.
  - https://dl.acm.org/doi/10.5555/1958171.1958178: logarithmic test-count results for ELAs under bounded parameters (cited by judge S2).
  - https://arxiv.org/abs/1801.06041v2: constraints can destroy distinguishability. This is why the fixture is path-disjoint by construction rather than constrained.
  - https://arxiv.org/abs/2308.13129: parallel batch testing in CI with no interaction localization.
  - https://ece.uwaterloo.ca/~wshang/pubs/Armin_FSE_2019.pdf and https://research.google/pubs/flake-aware-culprit-finding/: adaptive culprit finding for a single culprit.
  - https://github.com/bors-ng/bors-ng and https://research.google/pubs/pub45861/: batch-then-bisect (bors, Google TAP). These are the overflow path, not the mechanism.
- Why most teams will NOT submit this: It needs combinatorial-design literature that almost no hackathon builder knows. The median entry builds a merge queue, which is a predictable idea (#5).
- Hardest judge objection and the answer: "The locating guarantee needs a constrained fault model, and one round is not low work" (S2). Agreed, so the demo states the fault model on screen: at most d defects, path-disjoint changes, deterministic tests. It shows the degenerate case honestly and routes the overflow to bisection. Flakes appear as inconsistent cell patterns, and redundant rows can tolerate a bounded number of wrong cells.
- 48h solo feasibility (1-5) and the single riskiest implementation step: 3 after the scope cuts (aggregate 2.5). Use a fixed published d=2 matrix checked into the repo with no matrix generator, a plain-JS fixture of pure-function changes, tests of 3 seconds or less, and file-disjoint changes. Riskiest step: composing k changes into a tree, then bundling and running the suite inside a Dynamic Worker. If that is flaky by hour 36, fall back to Sandbox pools and keep isolates as the scale story.
- What to mock in the demo and what must be real: Mock the agents: pre-generated changes with 2 planted interactions, 1 change broken alone and 1 planted flake. Real: one fork per pool, the composed trees, isolate test execution, decoding, the bisection race counter and publication to the green-only ref.
- Scores (1-5): wow / mechanism-not-prompt / useful / scale story / feasibility / not-the-median: 5.00 / 4.50 / 3.50 / 3.25 / 2.50 / 5.00
- Provenance: I23 (A1 Opus, aggregate 23.75, rank 1). Donors: I21 (A5 SWE-2, 21.00) for the green-only ref and bisection overflow, and I12 (A2 GPT-6.1 Sol, 20.50) for exact-assignment exclusion scoping.

---

### Idea 2: Intent-Registered Transactions (the transactional repository, improved)
- Pitch (one sentence, <=25 words, describes a mechanism): Agents register write-scopes and pinned read-versions at BEGIN; a sharded registry pushes mid-flight invalidations, escalates hot symbols to leases, and validates optimistically at COMMIT.
- The "wow" scene (20 seconds, concrete, what is on screen): A side-by-side race between two lanes running the same scripted task and the same model.
  - Left lane is plain OCC (the original baseline). Agent B keeps writing against a stale `computeTotal`, then aborts at COMMIT, and the counter reads "dead work: 1,900 tokens".
  - Right lane has the intent layer. B's terminal flashes "pinned `computeTotal@7f2` changed 40s ago, new signature attached" while B is still writing. B adapts and lands.
  - Then `schema.ts` heats up. A gauge crosses the abort-rate threshold, the region flips to lease mode with a TTL countdown, a scripted agent crashes mid-lease, and the lease reclaims by expiry. A late push from the dead holder is rejected as "stale fencing epoch". A sibling region stays lock-free throughout.
- Source paradigm: Database concurrency control. It combines multi-granularity intention locks (Gray, Lorie, Putzolu, Traiger 1976) used as registration rather than acquisition, optimistic validation (Kung & Robinson 1981), STM-`retry`-style wakeups and Chubby-style leases with contention-triggered escalation.
- What replaces the merge conflict / the PR / the branch: No textual merge is ever produced. Conflicts surface in three places:
  - At BEGIN, as intent collisions, resolved by re-scoping.
  - Mid-flight, as invalidation notices.
  - At COMMIT, as validation aborts with an exact diagnosis: which symbol, who changed it, the new signature.

  The validator checks the write-set, the read-set and relevant negative reads, such as "symbol X does not exist". Crossings follow a single rule taken from I16: when one writer's write-set sits in the other's read-set, the upstream writer holds and the downstream re-forks against the new signature. There is no coin flip and no "refuse both". Branch = fork snapshot plus an intent record.
- How a human decides without reading code: An intent board shows live scope-overlap edges, the invalidation feed, a lease board (holder, region, TTL, queue depth, escalation history) and an abort log with diagnoses. The human intervenes only on judgment calls: approving a deliberate API break, force-reclaiming a lease or de-escalating a region.
- Why it scales to 100K agents (what is the coordination cost proportional to): Cost is proportional to the in-flight intents that intersect a commit's write-set, which are small symbol sets intersected in SQLite. Pushes are point-to-point. Leases cost only in contended regions, and cold code never pays. A single repo-wide validator would be the bottleneck (S2). Cloudflare's own Workflows V1 used one coordinator DO per account and had to go horizontal (https://blog.cloudflare.com/workflows-v2/), and a single DO handles about 500-1,000 req/s per its docs. So the validator is sharded into one DO per symbol region, and cross-region commits validate in a fixed shard order. The MVP shows a single region.
- Why a real team would use it next week: Cognition's account of parallel writers making incompatible implicit decisions (https://cognition.com/blog/multi-agents-working, D3) is exactly the pain this solves: dead-on-arrival work and assumptions that break only at merge. Practitioners already hand-write per-task "input commit, owned files, interfaces consumed" notes (D3), and this formalizes those notes. It also replaces the lockfiles-and-Slack dance around hot files.
- Cloudflare mapping: which primitive does what; flag anything decorative: One DO per symbol region, backed by SQLite, holds the intent registry, validator and lease table. DO alarms enforce TTLs. Artifacts `fork()` provides the snapshot. Repo `pushed` events trigger invalidation. Their payload is only repo, branch and commit, so a Worker diffs symbols via `readTree`/`readBlob`. Agents SDK or hibernating DO WebSockets push notices to agents. isomorphic-git in the validator Worker writes the trunk commit, and only the validator holds a trunk write token. Workers AI for regeneration is optional and decorative.
- Prior art found (URLs, one line each on what it is and how this differs):
  - https://www.sigmod.org/publications/dblp/db/conf/ds/GrayLPT76.html: intention locks. Theirs block, while intents here only advertise.
  - https://eecs.harvard.edu/~htk/publication/1981-tods-kung-robinson.pdf: OCC, the validation core.
  - https://staging.musehub.ai/muse/coordination: MuseHub has advisory symbol reservations with TTL and is the closest prior art. It has no pinned read-versions, no invalidation push and no commit-time validator (confirmed by judge S4).
  - https://hackage.haskell.org/package/stm/docs/Control-Monad-STM.html: STM `retry` waits on read-set inputs. It is used here only for parking on in-flight intents (see the objection below).
  - https://research.google.com/archive/chubby-osdi06.pdf: leases for liveness. https://github.com/git-lfs/git-lfs/blob/main/docs/api/locking.md: Git LFS path locks, with no TTL and no escalation.
  - https://vldb.org/cidrdb/papers/2025/p24-yilmaz.pdf: GenericVC adds commit-time conflict detection to Git and MVCC. It has no in-flight intent layer.
  - https://www.intel.com/content/www/us/en/developer/articles/technical/tsx-anti-patterns-in-lock-elision-code.html: the oscillation risk that the hysteresis damps.
- Why most teams will NOT submit this: Median teams treat coordination as a PR-time problem. Declaring machine-checkable intent before generation requires instrumenting the agent's tool calls and building a symbol registry. That is plumbing rather than a demoable LLM trick. Honest risk: S3 calls the bare OCC baseline "the serious median", so the differentiator must be visibly the intent push and the adaptive leases, not OCC.
- Hardest judge objection and the answer:
  - "Captured context is incomplete, and agents won't declare honest scopes." Reads are captured structurally through the file and search tool shim, not self-reported. Undeclared reads degrade to file granularity, and COMMIT-time validation stays the gate.
  - "Your wake-up is not STM `retry`, and it can lose wakeups" (S2). The abort path atomically subscribes and checks versions. If a version already moved, the agent re-forks immediately. Agents park only on another agent's in-flight intent, and that park is bounded by the intent's lease TTL.
- 48h solo feasibility (1-5) and the single riskiest implementation step: 4. Riskiest step: symbol-granularity read-set capture through the tool-call shim, using stable symbol IDs from tree-sitter. Running tree-sitter inside a Worker is UNVERIFIED (see Summary), so spike it in hour 1. File granularity still demonstrates the mechanism.
- What to mock in the demo and what must be real: Mock the agents (scripted scope declarations, plus one genuinely live LLM call for credibility) and the crash. Real: the registry, intersection, invalidation pushed from real Artifacts push events, OCC validation against real Artifacts objects, and the lease state machine with fencing epochs, TTL reclaim and hysteresis.
- Scores (1-5): wow / mechanism-not-prompt / useful / scale story / feasibility / not-the-median: 3.75 / 4.50 / 4.00 / 3.50 / 4.00 / 3.00
- Provenance: I09 (A5 SWE-2, aggregate 22.75) as the substrate. Absorbed I10 (A4 Kimi K3, 20.00) wake-on-invalidation, I22 (A5 SWE-2, 22.25) adaptive leases and I16 (A3 Grok, 21.25), whose head-on/crossing taxonomy was kept only as the downstream-gives-way rule.

---

### Idea 3: Agent Reorder Buffer (speculative forwarding)
- Pitch (one sentence, <=25 words, describes a mechanism): Consumers fork the producer's unfinished fork; a reorder-buffer DO retires changes in dependency order and squashes consumers only when a forwarded interface hash changes.
- The "wow" scene (20 seconds, concrete, what is on screen): The organizers' own scenario drawn as a CPU pipeline with three lanes: API, UI and Tests.
  - At t=0, UI and Tests fork *the API agent's unfinished fork*. Arrows read `forwarded: createOrder#a91f`.
  - At t=12s, the API agent pushes a new `createOrder` signature. The interface hash flips to `#c07e`, both dependent rows flash **SQUASH**, they re-fork from the new API commit and resume with a 3-line diagnosis.
  - A counter reads "stub predictions: 2 hit / 1 miss".
  - The head of the buffer retires API → UI → Tests onto main as fast-forwards, each after its composed checks pass.
- Source paradigm: Out-of-order CPU execution: Tomasulo forwarding, a reorder buffer, in-order commit and squash on mispredict.
- What replaces the merge conflict / the PR / the branch: Branch → a buffer entry {fork, exported interface tags, consumed tags, producer entry}. Merge conflict → mispredict, which squashes and re-forks the consumer. PR → retirement. An entry retires when it is at the head, its producers have retired and its checks pass on the composed tree. Retirement is fast-forward-only (S1). Interface hashes only decide *when to squash early*. Behavior is still checked at retirement, because an unchanged signature does not prove unchanged behavior (S2). Breaking changes that also have readers outside the buffer hand off to Grace Period (Idea 4).
- How a human decides without reading code: The human watches the pipeline and decides only two things: the speculation-depth cap (buffer size) and vetoing an entry at the head. A veto squashes exactly that entry's transitive dependents, which are highlighted on screen first.
- Why it scales to 100K agents (what is the coordination cost proportional to): Cost is proportional to the edges of the in-flight change DAG, not to the number of agents. Disconnected components get separate buffer DOs. A squash costs the fan-out of one changed interface. Pushes that leave the interface hash unchanged trigger nothing. Long chains amplify mispredicts (S4), and the buffer-size cap bounds that, exactly as in hardware.
- Why a real team would use it next week: "UI waits for the API PR" is today's main serialization point between agents. Teams already hand-roll stacked PRs to work around it, and this automates the stack as a DAG with automatic re-forking.
- Cloudflare mapping: which primitive does what; flag anything decorative: Artifacts fork-of-fork is the speculative register (essential). Forking a fork is UNVERIFIED; the fallback is to fork main and replay the producer's commits. The `pushed` event acts as the common data bus broadcast (essential). The DO is the reorder buffer and gives single-threaded in-order retirement (essential). A Worker hashes exported signatures. Sandbox or Dynamic Workers run the composed checks at retirement. Workflows is optional.
- Prior art found (URLs, one line each on what it is and how this differs):
  - https://csg.csail.mit.edu/6.823F22/Lectures/L09.pdf and https://web.stanford.edu/class/cs349g/cs349g-speculation.pdf: reorder-buffer and speculation lecture notes. No application to software agents was found.
  - https://codex.danielvaughan.com/2026/04/16/stacked-prs-coding-agents-gh-stack-sapling-codex-skill/: stacked PRs for agents, which are linear chains with manual restacking.
  - https://graphite.com/docs/graphite-merge-queue: speculates CI on *finished* PRs, not on in-progress work.
  - https://arxiv.org/html/2501.03440: Uber SubmitQueue speculation trees over finished conflicting changes.
  - https://arxiv.org/pdf/2603.15183: Token Coherence applies MESI-style invalidation to agent *context*. It has no forwarding and no ordered retirement of code.
- Why most teams will NOT submit this: Teams think at merge time, and this works at dispatch time. It needs interface hashing plus a retirement protocol, and the CPU analogy is not obvious unless you have done microarchitecture.
- Hardest judge objection and the answer: "This is just stacked PRs" (S3, who killed it). Stacks are linear, restacked by humans and start only after the producer pushes. The buffer is a DAG with automatic interface-hash squash. It also does value prediction: a consumer can start against the producer's declared stub before the producer writes anything, and is squashed only if reality differs. The hit/miss counter makes that visible.
- 48h solo feasibility (1-5) and the single riskiest implementation step: 4 (aggregate 3.5). Riskiest step: stable exported-interface hashing for TypeScript inside a Worker. It must normalize formatting and comments so that pushes that don't touch the interface really do nothing.
- What to mock in the demo and what must be real: Mock agent intelligence (scripted or live LLM runs both work) and the UI chrome. Real: forks of in-flight forks, squash driven by push events, re-forking, composed checks at retirement and fast-forward retirement onto main. The wall-time comparison must be labeled a target unless it is measured live.
- Scores (1-5): wow / mechanism-not-prompt / useful / scale story / feasibility / not-the-median: 4.00 / 4.50 / 4.00 / 3.00 / 3.50 / 3.75
- Provenance: I24 (A1 Opus, aggregate 22.75). Adds S1's suggested hand-off to I13 (Idea 4) and S2's requirement for composed checks at retirement.

---

### Idea 4: Three-Isolate Review (Diffy on Dynamic Workers)
- Pitch (one sentence, <=25 words, describes a mechanism): Load each agent change as a Dynamic Worker beside two baseline isolates; review replayed-traffic differences minus baseline-vs-baseline noise, including outbound side effects.
- The "wow" scene (20 seconds, concrete, what is on screen): No code anywhere, just a table of agent changes.
  - "#12 refactor-pricing: **0 behavioral deltas** / 30 replayed requests (timestamp and request-id noise auto-filtered)."
  - "#31 add-discounts: `GET /cart.total` changed (expected); `POST /checkout` **500 when coupon=null** (unexpected)."
  - The money shot is the composition row: "#31 ∘ #40: each clean alone; together they add a **new outbound call** to `email.send`." The judge clicks one row, sees one request/response pair and clicks Reject.
- Source paradigm: Production shadow-traffic testing, using Twitter Diffy's primary/secondary/candidate triple, plus the telecom *feature interaction problem* for compositions.
- What replaces the merge conflict / the PR / the branch: PR → a behavioral delta set: the request classes and fields whose disagreement rate exceeds the noise floor measured between two baselines. Semantic conflict := Δ(A∘B) ≠ Δ(A) ∪ Δ(B). Branch → a candidate tree hash, and identical trees are deduplicated.
- How a human decides without reading code: Accept or reject per behavioral delta and per new side effect, each backed by concrete sample requests. Uncovered routes are listed explicitly as "uncovered behavior".
- Why it scales to 100K agents (what is the coordination cost proportional to): Each change is evaluated independently, so the work is embarrassingly parallel. Cost = distinct trees × corpus size, and tree hashes collapse identical agent outputs. Interaction checks run only where the touched routes intersect. That pruning is a cost heuristic, not an independence proof (S2). Higher-order interactions need pooled checks, which is where Idea 1 composes with this one.
- Why a real team would use it next week: "Did behavior change?" is the question reviewers actually want answered. Deltas with the noise filtered out are reviewable at agent volume, and diffs are not.
- Cloudflare mapping: which primitive does what; flag anything decorative: Dynamic Workers (Worker Loader) build the baseline, baseline-twin and candidate isolates straight from Artifacts objects in milliseconds, with no deploy (essential). Judge S1 verified that they exist, along with their outbound interception: https://developers.cloudflare.com/workers/runtime-apis/bindings/worker-loader, https://developers.cloudflare.com/dynamic-workers/api-reference. Outbound interception turns side effects into diffable records (essential). Artifacts `readTree`/`readBlob` supplies the code. A DO stores per-endpoint and per-field noise statistics. Limitation, not decoration: it only works for apps that run in the Workers runtime.
- Prior art found (URLs, one line each on what it is and how this differs):
  - https://github.com/Vaultman/diffy: a Diffy mirror using the primary/secondary/candidate noise method. It needs deployed, long-running instances and has no agents or compositions.
  - https://www.signadot.com/docs/tutorials/quickstart/smart-tests and https://signadot.com/docs/reference/smart-tests/traffic-capture-diffs: Signadot SmartTests do baseline-vs-sandbox diffs on Kubernetes and offer an MCP server for agents. This is the **closest competitor**. Differences: millisecond isolates, a measured noise twin and composition checks.
  - https://en.wikipedia.org/wiki/Feature_interaction_problem: the feature interaction problem.
- Why most teams will NOT submit this: Teams reach for "an LLM reviews the diff", which is predictable idea #1. Behavioral review needs a runnable app plus a traffic corpus, which feels like ops, not git.
- Hardest judge objection and the answer: "New endpoints have no recorded traffic." Coverage gaps are surfaced explicitly. The agent must contribute example requests, which are replayed against the baseline too and become corpus for future changes. "Signadot already does this": not on millisecond isolates, not with a measured noise twin and not with composition checks.
- 48h solo feasibility (1-5) and the single riskiest implementation step: 4 after S3's cut (aggregate 3.25). Do module-swap replay: one pre-bundled Worker where each change replaces a single export, a checked-in HAR-style corpus of about 30 requests and a noise twin that is the same bundle booted twice. Riskiest step: turning an Artifacts tree into a loadable Dynamic Worker module map.
- What to mock in the demo and what must be real: Mock the traffic corpus (a recorded file) and the agents. Real: three-isolate replay, noise subtraction, outbound interception and the composition row.
- Scores (1-5): wow / mechanism-not-prompt / useful / scale story / feasibility / not-the-median: 4.00 / 3.75 / 3.50 / 3.25 / 3.25 / 3.50
- Provenance: I18 (A1 Opus, aggregate 21.25). Applies S1's composition-row money shot and S3's module-swap scope cut.

---

### Idea 5: Grace Period (RCU for breaking changes)
- Pitch (one sentence, <=25 words, describes a mechanism): Breaking symbol changes publish beside the old version via a shim; a DO counts in-flight agent readers and reclaims the old version at quiescence.
- The "wow" scene (20 seconds, concrete, what is on screen): A storefront app consumes the repo live.
  - The API agent changes `getUser(id)` to `getUser({id, tenant})`. Main stays green and no agent aborts.
  - A symbol card reads "`getUser@v1` readers: ui-agent, tests-agent, billing-agent (3)". As each agent rebases or commits on the new base, the count ticks 3 → 2 → 1.
  - billing-agent stalls and misses its heartbeat. Its write token is revoked, and its late push is rejected as "reads `getUser@v1`, reclaimed".
  - At 0 readers the DO commits "reclaim `getUser@v1`: grace period ended", and the shim disappears.
  - A side counter reads "aborts this change would have cost under plain OCC: 3".
- Source paradigm: Linux kernel RCU (read-copy-update: copy, publish, wait for a grace period, reclaim), plus Erlang's two-version code loading as the cap.
- What replaces the merge conflict / the PR / the branch: A breaking change is never an abort for in-flight readers. It becomes a versioned publication with a bounded lifetime.
  - "Breaking" means the exported-signature hash changed (S1).
  - A breaking change to a symbol with live readers is rejected unless it carries a shim. The shim must pass the old version's existing tests, and a deterministic template covers simple parameter changes. The LLM may write the adapter, but the structure decides how long it lives.
  - Erlang cap: at most 2 live versions. A third publication force-quiesces readers of the oldest.
- How a human decides without reading code: Per-symbol reader lists and grace timers. The human picks "extend grace", "force purge" or "reject the breaking change". These are decisions about other agents' live work, not about code text.
- Why it scales to 100K agents (what is the coordination cost proportional to): Cost is proportional to the readers of *changed* symbols only, tracked in DOs sharded by symbol. No agent work is wasted on breaking changes, unlike OCC where every reader aborts. Shim accumulation is bounded by the lease TTL × the 2-version cap.
- Why a real team would use it next week: Expand/contract is the accepted safe practice for API changes, but nobody does the contract step on time. This automates it, with agent liveness as the trigger.
- Cloudflare mapping: which primitive does what; flag anything decorative: Each agent's Artifacts fork is its read-side critical section, and its base commit plus import scan give its reads. `pushed`/`fetched` events signal activity. Their payloads carry repo, branch and commit only, so the fork must identify the agent (D3 agrees with the card). `token.created` events carry `expiresAt`, and `revokeToken` enforces forced quiescence. One DO per symbol shard does grace-period accounting (essential). A Worker scans imports and call sites. Sandbox runs the shim against the old tests.
- Prior art found (URLs, one line each on what it is and how this differs):
  - https://archives.kernel-recipes.org/wp-content/uploads/2025/01/rcuin2019kernelrecipes2.pdf: RCU and quiescent states.
  - https://www.thoughtworks.com/radar/techniques/api-expand-contract: API expand/contract, where grace is manual and calendar-based.
  - https://erlang.org/pipermail/erlang-questions/2008-December/040558.html: Erlang hot-code purge semantics.
  - The advisor searched for a system that counts *agent* readers of code symbols to end a grace period and found none.
- Why most teams will NOT submit this: It is a kernel-synchronization idea. Teams pick either "abort" or "merge" and never consider "keep both, reclaim later."
- Hardest judge objection and the answer: "Token expiry is not reader quiescence" (S2, who killed the original card for this). Correct, so quiescence is redefined. A reader fork quiesces when it rebases or commits onto a base that contains the new version, is explicitly abandoned, or misses its lease heartbeat. In the heartbeat case its token is revoked and the validator rejects any later push that reads the reclaimed version, so a stalled reader can never land against v1. Readers outside the repo (wire names, published packages) are out of scope and stay on human-signed expand/contract. Behavioral breaks under an unchanged signature fall through to OCC (Idea 2) or Three-Isolate Review (Idea 4).
- 48h solo feasibility (1-5) and the single riskiest implementation step: 4 (aggregate 3.5). Riskiest step: reliably classifying "breaking" and computing per-fork readers from imports and call sites in TypeScript.
- What to mock in the demo and what must be real: Mock the content of agent work. Real: shim publication, counting readers per fork, heartbeat with revocation-based quiescence, rejection of the stale push and the automatic reclaim commit.
- Scores (1-5): wow / mechanism-not-prompt / useful / scale story / feasibility / not-the-median: 3.00 / 4.00 / 4.00 / 3.75 / 3.50 / 4.25
- Provenance: I13 (A1 Opus, aggregate 22.50). Quiescence was redefined to answer S2's kill. Applies S1's breaking-change definition and S4's live-storefront scene.

---

### Idea 6: Retraction-Aware Repository
- Pitch (one sentence, <=25 words, describes a mechanism): Change eligibility lives in a justification graph; revoking a receipt withdraws support from dependents while candidates with independent checked support stay eligible.
- The "wow" scene (20 seconds, concrete, what is on screen): A release graph of eight nodes across two components.
  - A new security test lands and disproves API receipt R3. R3 turns red. Its dependent UI candidate U1 and deployment candidate D1 turn grey and are labeled **unsupported** (not "buggy").
  - Feature F, in the other component behind an assumption firewall, stays green.
  - UI candidate U2, which has a separately checked support path through API v1, stays eligible. The system assembles the fallback release, runs its checks in Sandbox and it turns green.
  - A delayed worker tries to publish the old release at epoch 41 and is rejected: "stale epoch".
- Source paradigm: Justification-based truth maintenance (Doyle's reason-maintenance system), not exhaustive ATMS enumeration.
- What replaces the merge conflict / the PR / the branch: Immutable changes and receipts form an acyclic AND/OR support graph. A justification needs all of its antecedents, and a candidate may have several independently checked justifications. Revocation changes eligibility, not stored code. A release is a consistent manifest backed by valid evidence at an ordered publication epoch. Public API receipts are boundary nodes, each owned by one component DO (S3's assumption firewall). A retraction invalidates the boundary only, and other components stay eligible until their own boundary is re-checked. The conflict unit is a support obligation or a revoked assumption.
- How a human decides without reading code: Inspect "why eligible", "why revoked", the executable counterexample, the available fallback manifests and which requested outcomes disappear.
- Why it scales to 100K agents (what is the coordination cost proportional to): Changes add local nodes and edges. Retraction work follows the affected justification edges only, and an alternative valid support stops the cascade. Firewalls stop it at component boundaries. A release-domain authority orders revocation and publication, so delayed workers cannot resurrect an obsolete decision. Honest limit: a widely shared assumption invalidates most of the graph, which is unavoidable fan-out.
- Why a real team would use it next week: Agent changes are often invalidated late by security findings, faulty tests or an upstream reversal. Ordinary reverts neither explain the dependent evidence nor identify which work can safely stay.
- Cloudflare mapping: which primitive does what; flag anything decorative: Workers expose justification queries and admission. DOs, one per component, maintain support status, revocation epochs and release decisions. Queues propagate recomputation. Sandbox verifies fallback compositions. Artifacts keeps candidate history, evidence and source snapshots. Git export is materialization, not a second admission authority. Nothing is decorative.
- Prior art found (URLs, one line each on what it is and how this differs):
  - https://dspace.mit.edu/handle/1721.1/5733: Doyle's TMS records reasons and revises beliefs. The advisor verified it through search text only, because direct retrieval failed.
  - https://github.com/benthomasson/ftl-reasons: multiple justifications, retraction cascades and restoration over reasoning assertions. This idea binds justifications to code and evidence hashes and to release manifests.
  - https://buck2.build/docs/insights_and_knowledge/modern_dice/: dependency-based validity. This idea adds explicit revocation, alternative justifications and human-visible fallbacks.
- Why most teams will NOT submit this: Most designs assume accepted work stays trustworthy forever. This treats "we no longer believe that evidence" as a first-class repository operation.
- Hardest judge objection and the answer: "You cannot undo downstream semantics automatically." Agreed. The mechanism retracts admission support. It does not invent inverse code or undo deployed side effects. Replacement releases get real checks. Missing provenance means insufficient support, and cyclic support is rejected in the MVP. "Too much to explain in 20 seconds" (S1): the scene is one red node, two grey nodes, one survivor and one rejected stale publish.
- 48h solo feasibility (1-5) and the single riskiest implementation step: 4 after S2's cut (aggregate 3.25). Use one release authority, an eight-node acyclic graph and two explicitly checked fallback manifests, with no general synthesis of alternative contexts. Riskiest step: making sure the alternative support describes a genuinely checked, mutually compatible context.
- What to mock in the demo and what must be real: Mock deployment compensation and enterprise-scale propagation. Real: the disproving test, the revocation cascade, the firewall stop, the surviving alternative, fallback evaluation, stale-epoch rejection and the Artifacts snapshot.
- Scores (1-5): wow / mechanism-not-prompt / useful / scale story / feasibility / not-the-median: 3.50 / 4.25 / 3.25 / 3.50 / 3.25 / 4.75
- Provenance: I07 (A2 GPT-6.1 Sol, aggregate 22.50, zero kills). Applies S2's MVP scope and S3's assumption firewalls. Not merged with I20, per S2.

---

### Idea 7: Verification-Cut Repository (with custody cards)
- Pitch (one sentence, <=25 words, describes a mechanism): A composition publishes only when a content-addressed verification graph covers its exact input closure, reusing unchanged receipts and re-running only invalidated ones.
- The "wow" scene (20 seconds, concrete, what is on screen):
  - Beat 1: two agents converge on the same `applyDiscount()` with an identical input closure. Agent 1's commit runs the suite in Sandbox in 8 seconds. Agent 2's lands in milliseconds with the flash "evidence inherited from receipt #1042". The judge opens a custody card (author agent, exact suite, sandbox log, input-closure hash), re-runs it live and the hashes match.
  - Beat 2: an API refactor keeps its signature. Interface receipts stay reusable while behavioral receipts go stale, and the composed snapshot fails a freshly run test.
  - Beat 3: a policy revocation lands between "all green" and publication. Every cached check is still green, but the stale publication permit cannot advance the release.
- Source paradigm: Self-adjusting build systems (verifying traces, content-addressed actions, early cutoff), with forensic chain of custody as the review surface.
- What replaces the merge conflict / the PR / the branch: Agents submit immutable module candidates. A release manifest chooses exact versions. Its review object is a **verification cut**: reusable receipts plus the newly required actions covering every target the policy requires. A receipt binds the command, toolchain, environment, policy and exact input closure. Formatting-normalized hashing only collapses identical content. It never shortens the key, so I03's interface-only and depth-2 keys are dropped (S2). Publication consumes an epoch-fenced permit bound to the manifest, the cut and the policy epoch (S2). Collisions between candidates for the same module slot remain choices, never synthesized merges.
- How a human decides without reading code: Custody cards per symbol show either a green chain (hash → suite → sandbox log → signer) or a red gap, alongside the behavioral delta, freshly evaluated obligations, reused evidence and unverified obligations. Choices: "publish this composition", "retain the prior module" or "require this additional check". Test logs written by agents are never authoritative receipts.
- Why it scales to 100K agents (what is the coordination cost proportional to): Verification work scales with distinct action keys and invalidated graph nodes, not with agents × whole-repository CI. Identical in-flight requests share one action. Caches and scheduling shard by action hash. Publication is ordered per release stream but batched. A change that touches every target still costs every target, and the cut makes that cost visible.
- Why a real team would use it next week: Teams already burn CI on equivalent agent outputs and wrongly assume that independently green changes compose. Exact-context receipts address both while keeping executable evidence.
- Cloudflare mapping: which primitive does what; flag anything decorative: Workers compute manifests and action keys. DOs deduplicate in-flight evaluations, index hash → receipt and serialize permit consumption against revocation. Queues distribute the work. Sandbox runs trusted checks. Artifacts stores source, receipts (as git objects on an evidence ref) and released snapshots, since git objects are already content-addressed. HMAC keys live in Worker secrets. Workflows may handle retries but is not the correctness mechanism.
- Prior art found (URLs, one line each on what it is and how this differs):
  - https://bazel.build/remote/caching: action-hash remote cache. This idea makes cross-composition evidence validity the admission and review unit.
  - https://buck2.build/docs/insights_and_knowledge/modern_dice/: early cutoff when values are unchanged. This idea applies it separately to interface evidence and behavioral evidence.
  - https://www.cambridge.org/core/journals/journal-of-functional-programming/article/build-systems-a-la-carte-theory-and-practice/097CE52C750E69BD16B78C318754C7A4: a taxonomy of build schedulers and rebuilders.
  - https://slsa.dev/provenance/v1: attests how an artifact was built, not that a composition passed behavioral checks.
  - https://www.unison-lang.org/docs/the-big-idea/: content-addressed code, the source of the closure-hash rule.
- Why most teams will NOT submit this: Most teams will attach CI badges to agent PRs. This visibly refuses stale green badges and makes evidence a reusable graph over exact compositions.
- Hardest judge objection and the answer: "This is just CI caching" (S1, S3, S4). The cache is prior art. The differentiators are admitting a composition through its verification cut, explaining invalidations and the fenced permit. That is why Beat 3 is in the demo. No one claims that passing tests prove correctness. Undeclared filesystem, network, clock or randomness inputs make a receipt non-reusable.
- 48h solo feasibility (1-5) and the single riskiest implementation step: 4 with explicitly declared action inputs (aggregate 3.25). Riskiest step: making every reused receipt bind the complete input closure rather than just signatures or changed filenames.
- What to mock in the demo and what must be real: Mock automatic dependency discovery, fleet load and the full key infrastructure (HMAC signer). Real: hashing, trusted evaluation, deduplication, inheritance, rejection of stale evidence, the composed failure and permit fencing.
- Scores (1-5): wow / mechanism-not-prompt / useful / scale story / feasibility / not-the-median: 3.00 / 4.25 / 3.75 / 4.00 / 3.25 / 3.00
- Provenance: I17 (A2 GPT-6.1 Sol, aggregate 21.25, zero kills) plus I03 (A4 Kimi K3, 20.25), which contributed the custody card and convergence flash but not its depth-limited key. Applies S2's epoch-fenced permits.

---

### Idea 8: Reference-Preserving Patch Transport
- Pitch (one sentence, <=25 words, describes a mechanism): Encode refactorings as reversible operations and transport concurrent edits through stable symbol identities, preserving references without regenerating code.
- The "wow" scene (20 seconds, concrete, what is on screen): Three agents work at once. One renames an internal function, one extends its body and one adds a caller that uses the *old* name. On the left, plain git reports overlapping edits. On the right, the operation view shows `Rename(sym#41)`, `ReplaceBody(sym#41)` and `AddCall(sym#41)` all surviving. The rendered repository uses the new name everywhere and the new test passes. A fourth agent's competing body edit is rejected as a true conflict.
- Source paradigm: Patch theory: Darcs-style commutation of operations with representations that depend on context.
- What replaces the merge conflict / the PR / the branch: A change is an operation bundle over an immutable snapshot: `Rename(symbolID, name)` and `ReplaceBody(symbolID, expectedHash, resolvedAST)`. Names and reference identities are separate, so a rename transports a body edit instead of invalidating it. Two incompatible body replacements still conflict. The conflict unit is a symbol body, a name binding or an unresolved reference, never a line.
- How a human decides without reading code: Approve an operation summary, for example "internal rename; one behavior change; three new callers; these tests passed". Unsupported transformations appear as explicit unresolved obligations, not confident prose.
- Why it scales to 100K agents (what is the coordination cost proportional to): Operations are indexed by symbol identity and namespace. Admission examines touched symbols and the operations that interfere with them, not every pair of agents. Rendering costs in proportion to affected references, though a widely used rename still fans out. Materialization at package level batches operations into git snapshots. Contention on a single body stays serialized locally.
- Why a real team would use it next week: Agent renames and moves constantly overlap ongoing feature work. This keeps already-generated work instead of paying to regenerate it after mechanical churn.
- Cloudflare mapping: which primitive does what; flag anything decorative: Workers validate operation envelopes. DOs maintain symbol versions and name bindings. Sandbox runs binding resolution, rendering, type-checking and git export. Artifacts stores operation history and source snapshots. Workers AI is optional generation, not the merger.
- Prior art found (URLs, one line each on what it is and how this differs):
  - https://darcs.net/Theory/MergersDocumentation: token-replace patches commute with hunks. This idea uses resolved program references instead of lexical tokens.
  - https://github.com/ualberta-smr/RefMerge: detects, inverts and replays refactorings around a text merge, and fully resolved only 7% of scenarios (D1). This idea records operations at creation instead of detecting them afterward.
  - https://www.semanticmerge.com/features: SemanticMerge merged at declaration granularity and was discontinued as a standalone product in 2022 (D1). It still merged text inside bodies and had no operation identity.
- Why most teams will NOT submit this: It requires changing the agent's write path and separating symbol identity from spelling, rather than adding a smarter merge prompt (predictable idea #2).
- Hardest judge objection and the answer:
  - "Agents won't emit operation envelopes" (S5, who killed it). They don't have to. Renames go through a rename tool exposed via the same tool shim as Idea 2. Body edits are derived as `ReplaceBody` by diffing against persisted symbol IDs. A rename done by hand degrades to delete+add and surfaces as an explicit obligation.
  - "Renaming can change behavior." Wire names, reflection and dynamic lookup are outside the automatic lane, and renames that would capture a binding are rejected.
- 48h solo feasibility (1-5) and the single riskiest implementation step: 3 (aggregate 2.5). Scope cut (S2): top-level functions and static calls in one TypeScript module, with persisted symbol IDs and compiler-checked reference maps. Riskiest step: resolving every reference in newly submitted code to its originating symbol without scope capture. S1 calls this "a trap" in 48 hours.
- What to mock in the demo and what must be real: Replay agent submissions and mock the population view. Real: symbol resolution, operation transport, rejection of same-body conflicts, rendered source, tests and Artifacts publication.
- Scores (1-5): wow / mechanism-not-prompt / useful / scale story / feasibility / not-the-median: 4.00 / 4.25 / 3.50 / 3.50 / 2.50 / 3.75
- Provenance: I08 (A2 GPT-6.1 Sol, aggregate 21.50). Applies S2's scope cut and answers S5's adoption kill with a tool-shim rename path.

---

### Idea 9: Monotone Extension Forge (with an enforced core jail)
- Pitch (one sentence, <=25 words, describes a mechanism): Isolated, namespaced extensions are admitted by set union without coordination; only overwrites, deletions, and cross-extension invariants enter a coordinated lane.
- The "wow" scene (20 seconds, concrete, what is on screen):
  - The judge clicks "freeze coordinator" and the replacement lane goes dark.
  - Eight agents still admit data-import adapters. Their submissions are delivered duplicated and in shuffled order, yet the executable snapshot hash is identical across three replays, and eight sample payloads process correctly.
  - A ninth agent's adapter tries to write another extension's state and is rejected by construction, because the evaluator cannot express that.
  - A tenth agent tries to touch `core/` and gets a 403 from the path jail.
  - A legitimate *replacement* of an existing adapter stalls, waiting for the frozen coordinator.
- Source paradigm: Database invariant confluence (coordination avoidance): decide which operations preserve stated invariants under merge, instead of demanding serializability for everything.
- What replaces the merge conflict / the PR / the branch: The extensible surface is a grow-only set of immutable `(extensionID, programHash, pinnedImports)` records in disjoint namespaces. Union preserves the invariants: well-formed programs, resolvable immutable imports and non-overlapping identities. Replacement, deletion, default selection and shared resource budgets go to the coordinated lane, where replaced versions stay content-addressed and pinnable for rollback (from I11). Agents get no token that can write core paths, and a Worker refuses any submission outside the extension tree (I25's jail). Popularity- or test-count-based deletion is deliberately *not* adopted (S1, S2, S3).
- How a human decides without reading code: Review extension capabilities, input/output examples, resource limits and acceptance results. Humans decide only replacements and exposure: "should this capability exist?" and "should it replace that one?"
- Why it scales to 100K agents (what is the coordination cost proportional to): After namespace allocation, additions need only local validation plus dissemination, with no fleet-wide ordering round. Cost is proportional to the extension and its pinned dependency closure. Honest limits: claiming "this is every submission" needs a snapshot boundary, and shared defaults or budgets bring coordination back. The scale story applies to a useful class of operations, not to arbitrary edits.
- Why a real team would use it next week: Fleet-generated importers, webhook normalizers, tool adapters and declarative transformations are genuinely additive workloads. Teams can parallelize them immediately without restructuring their core.
- Cloudflare mapping: which primitive does what; flag anything decorative: Workers handle admission, the path jail and registry queries. DOs allocate namespaces and arbitrate destructive operations. Artifacts stores immutable extension programs and release manifests, and repo-scoped tokens (with `expires_at`, per the Artifacts REST API: https://developers.cloudflare.com/artifacts/api/rest-api/) keep agents off core. Sandbox executes validation examples. No LLM classifier is needed, and nothing is decorative.
- Prior art found (URLs, one line each on what it is and how this differs):
  - https://ar5iv.labs.arxiv.org/html/1402.2237: invariant confluence for coordination avoidance. This idea designs a restricted repository surface whose union provably preserves explicit invariants.
  - https://github.com/mwhittaker/enforced_invariant_confluence: automated invariant-confluence analysis. This idea uses a small, manually justified operation algebra.
  - https://irmin.org/: custom merge functions for versioned data.
  - https://osgi.org/specification/osgi.core/7.0.0/service.resolver.html and http://www.fifi.org/doc/debian-policy/policy.html/ch-relationships.html (via I25): plugin resolvers that halt on conflicts. Here additions never meet a resolver.
- Why most teams will NOT submit this: It deliberately removes expressiveness from the fast lane. Most entrants will promise that arbitrary code merges, rather than show exactly which changes need no coordination.
- Hardest judge objection and the answer: "It's a plugin registry with a toy DSL" (S1, who killed it). The DSL is the honest MVP boundary: a declarative JSON-transformation language with isolated execution, because unrestricted JavaScript would allow hidden cross-extension effects. The claim is that the repository *proves* which lane each change belongs in, and the frozen-coordinator scene demonstrates that coordination-freedom live.
- 48h solo feasibility (1-5) and the single riskiest implementation step: 4. Riskiest step: guaranteeing the extension evaluator cannot express hidden cross-extension effects.
- What to mock in the demo and what must be real: Mock broad language support and fleet size. Real: namespace isolation, an identical union under reordered and duplicated delivery, evaluator restrictions, the path jail, escalation of destructive operations and the working app.
- Scores (1-5): wow / mechanism-not-prompt / useful / scale story / feasibility / not-the-median: 3.00 / 4.50 / 3.00 / 4.00 / 4.00 / 3.50
- Provenance: I02 (A2 GPT-6.1 Sol, aggregate 22.00). Absorbed I25 (A3 Grok, 20.00) path jail and I11 (A3 Grok, 21.25) content-addressed rescue pins only. Applies S2's frozen-coordinator scene and S4's rejection-by-construction beat.

---

### Idea 10: Precedent Registry
- Pitch (one sentence, <=25 words, describes a mechanism): Abort diagnoses are hashed into conflict-shape signatures; the first ruling on a shape is stored, and matching collisions apply it with a citation.
- The "wow" scene (20 seconds, concrete, what is on screen): The dreaded API signature change lands, and thirty in-flight transactions abort with the same shape: `{sym: pricing.quote, arity 2→3, params [Cart, Region]→[Cart, Region, Currency]}`. The first one gets a ruling: an adapter template plus an evidence requirement ("caller tests pass"). The other twenty-nine re-apply the template, run their required tests and land, and a cascade of green "citing precedent #1" ticks rolls down the screen. Then the human narrows the precedent to exclude `billing/`, and the three citations there are flagged for re-review.
- Source paradigm: Stare decisis: common-law precedent with scoped binding, distinguishing and overruling. It is realized mechanically as a shared, typed `git rerere` keyed on conflict shape rather than text.
- What replaces the merge conflict / the PR / the branch: Repeated adjudication goes away. Review happens once per shape, and later collisions are a lookup, with the citation carried on the commit. The registry hangs off the abort-diagnosis stream of Idea 2, as S5 suggested: the substrate produces diagnoses and the registry amortizes them.
- How a human decides without reading code: A precedent ledger shows shape → ruling → application count → scope/expiry. Overruling or narrowing is a first-class act that flags the affected applications for re-review.
- Why it scales to 100K agents (what is the coordination cost proportional to): Adjudication cost is proportional to the distinct conflict shapes in a wave of changes, not to the number of agents. Each citation still pays for its own evidence run. S2 notes that distinct shapes need not *decrease* with concurrency, so the claim is amortization during migration waves, not a cost that falls with fleet size.
- Why a real team would use it next week: Every API migration today means pasting the same answer N times. D1 notes that teams already smuggle rerere caches around out-of-band, and this makes that sharing first-class and typed.
- Cloudflare mapping: which primitive does what; flag anything decorative: The precedent table lives in a DO's SQLite, keyed by shape hash. A Worker computes shapes from abort diagnoses. Rulings carry a transform template plus evidence requirements, executed in Sandbox. Citations are recorded on the commit object in Artifacts. The ruling author is a human or one agent, and no LLM performs the match.
- Prior art found (URLs, one line each on what it is and how this differs):
  - https://git-scm.com/docs/rerere: normalized conflict ID → recorded resolution. It is local-only, text-level and brittle to near-variants.
  - https://github.com/cisagov/rerere-cache: a shared rr-cache kept as a git repo, which shows teams share resolutions out-of-band.
  - https://github.com/git/git/blob/master/contrib/rerere-train.sh: trains the cache from history, which supports pre-seeding precedents.
  - https://link.springer.com/article/10.1007/s10506-025-09461-x: AI-and-Law models of precedent constraint, a formal basis for distinguishing.
  - https://www.cambridge.org/core/journals/legal-theory/article/distinguishing-and-reinterpreting-in-the-reason-model-of-precedent/3E3B7FEB057867DF09250987ABE7728D (D3): the reason model of precedent.
- Why most teams will NOT submit this: It demands a conflict-shape algebra, which is hard intellectual work that median teams skip in favor of "the LLM resolves it". Rulings are *recorded decisions* applied deterministically, not generated merges, so this is not predictable idea #2.
- Hardest judge objection and the answer: "Equal shapes don't mean equivalent preconditions, and precedents go stale" (S2). The ruling supplies only the transform, and the evidence requirement decides each application, so a misfiring precedent fails its tests and escalates instead of landing. Rulings are scoped and expire, and overruling is itself an auditable event.
- 48h solo feasibility (1-5) and the single riskiest implementation step: 3 after S3's cut (aggregate 2.5). Support one shape class only, an exported signature change: key = symbol id + arity + ordered parameter type names, ruling = one stored adapter template, match = exact hash. Fuzzy matching of near-variants is out of scope. Riskiest step: producing the abort diagnosis in a structured enough form to hash. This is cheap only if Idea 2's substrate exists.
- What to mock in the demo and what must be real: Mock the ruling author (human-in-demo) and the thirty agents (scripted). Real: shape hashing, the store, the match-apply-verify pipeline, citations on commits and the narrowing/overruling flow.
- Scores (1-5): wow / mechanism-not-prompt / useful / scale story / feasibility / not-the-median: 4.00 / 3.50 / 3.50 / 3.75 / 2.50 / 4.00
- Provenance: I01 (A5 SWE-2, aggregate 21.25, zero kills, one non-self top-5). Applies S3's single-shape scope cut and S5's placement on the abort stream.

---

### Summary

**Paradigms covered (10 distinct):** group testing / combinatorial design (1); database concurrency control (2); out-of-order CPU speculation (3); shadow-traffic differential testing plus feature interaction (4); kernel RCU (5); truth maintenance (6); self-adjusting build systems plus chain of custody (7); patch theory (8); invariant confluence (9); stare decisis (10).

**Why the idea order differs from the product ranking below.** Ideas 1-10 are ordered by recommendation, which weights wow and not-the-median above feasibility. Wow is the scarcest gate, because only three finalists demo, while feasibility can be bought back with the scope cuts written into each card.

**Rank by wow × feasibility (aggregate means of the main source card):**
1. Intent-Registered Transactions: 3.75 × 4.00 = 15.0. It wins because it is the most buildable credible mechanism in the set, and every other symbol-level idea (3, 5, 10) reuses its registry, shim and hashing.
2. Agent Reorder Buffer: 4.00 × 3.50 = 14.0. It wins because it is literally the organizers' API/UI/tests scenario, solved at dispatch time, with a squash that a CPU-literate judge reads instantly.
3. Three-Isolate Review: 4.00 × 3.25 = 13.0. It wins because it is the cleanest "decide without reading code" scene, and it depends on Dynamic Workers, a Cloudflare-specific primitive.
4. One-Round Pools: 5.00 × 2.50 = 12.5. It has the highest wow in the pool, and feasibility rises to about 3 with the fixed-matrix cut.
5. Monotone Extension Forge: 3.00 × 4.00 = 12.0
6. Retraction-Aware Repository: 3.50 × 3.25 = 11.4
7. Grace Period: 3.00 × 3.50 = 10.5
8. (tie) Reference-Preserving Patch Transport: 4.00 × 2.50 = 10.0
8. (tie) Precedent Registry: 4.00 × 2.50 = 10.0
10. Verification-Cut Repository: 3.00 × 3.25 = 9.75

**Synthesis note (judgment, not judge data):** Ideas 2, 3, 5 and 10 share one substrate: symbol IDs, the tool-call shim, interface hashing and the per-region DO. A single 48h build could ship Idea 2 as the substrate plus one of Ideas 3 or 5 as the headline scene.

**Predictable ideas expected most often among submissions.** D3 found no public competitor repos or architecture posts (one entrant, wongstack.com, announced publicly), so this is inference from how commoditized the landscape is:
1. **"GitHub for agents": a worktree or fork per agent, a board, auto-PRs and an LLM reviewer.** It is the uniform recipe of Vibe Kanban, Conductor, Claude Squad, Crystal/Nimbalyst, Kungfu Kanban and Sculptor, and per D3 "all tools stop at 'open a PR'" (https://vibekanban.com/, https://imbue.com/product/sculptor/, https://superterminal.dev/blog/multi-agent-coding-tools-compared.html). Cursor, Codex, Copilot and Jules all emit PRs too. It is the shortest path from the brief.
2. **An LLM merge-conflict resolver.** Copilot's cloud agent already resolves merge conflicts when asked via `@copilot` comments (https://docs.github.com/en/copilot/concepts/agents/coding-agent/about-coding-agent). Per D3, humans resolve 96.1% of agent conflicts today, and agent self-resolution varies about 60× by vendor. That gap is obvious, so the pitch is obvious.
3. **An orchestrator, merge queue or contract-first pipeline.** Factory Missions, jules-dispatch's LLM planner, Devin dynamic workflows and Tembo's "explicit contracts" advice all exist (https://factory.ai/product/missions, https://yuuqq.github.io/jules-dispatch/, https://docs.devin.ai/work-with-devin/dynamic-workflows, https://www.tembo.io/blog/coding-agent-orchestration). Speculative merge queues ship in Graphite (https://graphite.com/docs/merge-queue-optimizations). The HN thread on the competition was skeptical of fan-out without visible resolution (https://news.ycombinator.com/item?id=49947483). Judges are therefore likely to discount entries that only parallelize.

**Verdict on the baseline candidate ("Transactional repository"): improve, and keep it as Idea 2.** It should not be dropped. It has the highest feasibility and usefulness among the leaders, and Cognition's "decision collision" argument (D3) is its strongest public justification. As stated it is "the serious median" (S3), and its terminal toast is "not a wow" (S1). Required changes:
- (a) Add BEGIN-time intent registration and mid-flight invalidation push, so abort happens before work is wasted.
- (b) Make the abort path atomically subscribe-and-check with an immediate re-fork. Park only on in-flight intents, bounded by TTL (S2's lost-wakeup fix).
- (c) Escalate hot symbols to TTL leases when contention is measured, with fencing epochs and hysteresis (I22, S2).
- (d) Downstream writers re-fork on crossings. Never use "refuse both" (I16 minus its livelock).
- (e) Shard the validator per symbol region, because one repo DO is a bottleneck (S2; Cloudflare's own Workflows V1 lesson, D3).
- (f) Validate negative reads too.
- (g) Demo it as the side-by-side race, not a toast.

If the builder wants maximum wow, ship it as the substrate under Idea 3 or 5 rather than alone.

**Ideas dropped despite strong signals, and why:**
- **I05 Atomized Repo:** the highest wow (5.00) and not-the-median score (5.00) in the pool. It was killed by 3 of its 4 non-self judges (S2, S3, S5) for explode/materialize fidelity, manifest serialization and "access control, not composition". Its only top-5 vote was a self-vote. Its token-as-lease insight lives on in Ideas 2 and 5.
- **I15 Singleflight:** killed by 3 judges as conventional dispatch plumbing.
- **I06 Escrow, I04 Complying Presentation:** close to Gerrit topic submission or "CI in costume", and lower aggregates.
- **I20, I14, I19, I21, I11, I25, I12, I10, I16, I22, I03:** killed, or merged into finalists as noted under each Provenance line.

**Method caveat:** the top-5 and kill counts in `aggregate.txt` are mention-based. For example, I23's "kill 2" includes S1 and S5 naming I23 inside their kill entries for I21. This synthesis recounted kills and top-5s from the judge texts and excluded self-votes.

**What could NOT be verified (bearing on the final 10):**
- **tree-sitter (`web-tree-sitter` WASM) inside a Worker.** The dossiers contradict each other: D2 calls it a "confirmed path" and D3 says "plausible but not verified". One synthesis web search found the package README but no confirmation that it runs on Workers. UNVERIFIED. This affects Ideas 2, 3, 5, 8 and 10, so spike it in hour 1, with Sandbox-side parsing as the fallback.
- **Artifacts fork-of-a-fork (Idea 3).** The brief lists `fork` per repo. No input confirms that forking a fork works or what it costs. UNVERIFIED.
- **Artifacts repo/fork creation rate limits and latency** at hundreds of forks per round (Idea 1). No input states them, and the I05 author also flagged them as unknown. UNVERIFIED.
- **Push-event delivery latency** (Ideas 2, 3, 5). "Within a second" (I24) and "before the push finishes" (I10) are unmeasured, and the second claim was dropped as not credible. Events carry only repo, branch and commit (D3). UNVERIFIED.
- **Bundling a multi-file TypeScript tree into a Dynamic Worker module map inside a Worker** (Ideas 1 and 4). UNVERIFIED feasibility. Dynamic Workers and outbound interception themselves were verified by S1.
- **Error-locating array guarantees** (Idea 1). The logarithmic results hold under bounded parameters, and constraints can destroy distinguishability (S2's sources). The exact "d² log N" form and the availability of a ready-made published d=2 matrix for N=24/48 were not located. S4 and S5 name Martínez et al. and Colbourn/McClary without URLs. UNVERIFIED.
- **The 41.7% statistic** is verified: 48/115 pairs, 95% CI 33-51% (S1, S2, S4, S5). However, cross-agent pairs were only about 0.5% of that dataset's co-active pairs (S5), so it is not a fleet-wide conflict rate.
- **The I13 card's claims about event payloads and `token.created` `expiresAt`** were marked verified by its author. S1 independently confirmed token `expires_at` via the REST API docs. The payload contents were not re-checked.
- **Citations made by advisors and not re-checked by any judge or the synthesis:**
  - https://github.com/benthomasson/ftl-reasons (Idea 6).
  - https://codex.danielvaughan.com/2026/04/16/stacked-prs-coding-agents-gh-stack-sapling-codex-skill/ (Idea 3).
  - https://link.springer.com/article/10.1007/s10506-025-09461-x and https://github.com/cisagov/rerere-cache (Idea 10).
  - The Signadot pages (Idea 4); S4 only judged it "very close".
- **The Doyle TMS page** (https://dspace.mit.edu/handle/1721.1/5733) was verified only through search text, because direct retrieval failed.
- **I24's "41s vs 2m10s"** wall-time comparison is a target, not a measurement. Stub value prediction is untested.
- **The DO throughput figure** (about 500-1,000 req/s) is documented guidance from D3 and was not measured. The cross-shard commit protocol for Idea 2 is a design that has not been validated.
- **Artifacts scale wording differs between inputs.** D3 says "millions of repositories". The I05 card quotes "tens of millions of repos", and S5 says that phrase is on Cloudflare's blog. Unresolved, but immaterial to the final 10.
- **Searches that returned nothing:**
  - No system that counts agent readers to end a grace period (Idea 5).
  - No ELAs applied to concurrent code changes (Idea 1).
  - No out-of-order speculation applied to software agents (Idea 3).
  - No public competitor approaches or entry repos (D3).
  - No escrow applied to code artifacts (D2, relevant to the dropped I06).

---

### Council dissent
- **One-Round Pools (Idea 1):** S3, S4 and S5 all put it in their top 5 (23-26 points, mechanism 5). S2 killed it ("keep as research": constrained distinguishability, masking faults and decoder correctness are unestablished) and scored mechanism 3 and scale 2. The human should weigh whether the declared-fault-model demo is honest enough for a technical judge.
- **Intent-Registered Transactions (Idea 2):** S4 ranked it #1 (26). S3 killed it as "the sophisticated median; mid-flight intents are a slide on the baseline". S2 scored scale 2 because of the single-validator bottleneck. Highest feasibility, but the most at risk of looking like other entries.
- **Grace Period (Idea 5):** S4 put it in the top 5 (25), and S4 and S5 gave mechanism 5. S2 killed it with mechanism 2, saying "token expiry is not reader quiescence". The card now redefines quiescence via heartbeat plus revocation and fencing. Whether that fully answers S2 was not re-judged.
- **Agent Reorder Buffer (Idea 3):** S4 and S5 scored it 24 ("literally the organizers' scenario"). S3 killed it as "stacked PRs plus speculative CI", and it has no non-self top-5 vote. Its second-place aggregate rests on consistent mid-high scores rather than champions.
- **Reference-Preserving Patch Transport (Idea 8):** S2 rated it 24, but that judge shares a model with the author (top-5 removed as a self-vote). S5 killed it ("demands agents change their write protocol"), and S1 and S3 gave feasibility 2. It is the most feasibility-fragile finalist.
- **Monotone Extension Forge (Idea 9):** S4 put it in the top 5 (25, "deliberately narrow, and that's a virtue"). S1 killed it as a "toy DSL" (19). The disagreement is over whether an honest narrow lane counts as useful for the challenge.
