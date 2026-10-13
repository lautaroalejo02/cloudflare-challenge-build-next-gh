## Baseline critique

**Transactional repository — judged as a Workers/DO engineer hunting the tweetable moment**

- **WOW (3/5):** The money shot is an abort with an exact diagnosis. It's clean, but it reads like a database lecture. A red "ABORTED: `getUser` changed" box doesn't make people pull out their phones.
- **MECHANISM (5/5):** Its genuine strength. Validation is a set intersection, not a prompt.
- **USEFUL (3/5):** Read-set capture is the soft spot. It means instrumenting every coding agent, and file reads ≠ dependencies (agents grep, skim, and rely on model priors). I checked ArtifactFS: it has no per-file access log, and it prefetches blobs in the background, so hydration ≠ reads (https://raw.githubusercontent.com/cloudflare/artifact-fs/HEAD/README.md).
- **SCALE (3/5):** One validator DO per repo is a ~500–1000 req/s ceiling. That is the same single-coordinator wall Cloudflare's own Workflows v1 hit (https://blog.cloudflare.com/workflows-v2/, D3). First-committer-wins also starves slow, careful agents.
- **FAST (4/5).**
- **NOT-MEDIAN (3/5):** OCC-for-code falls out of the dossiers. Expect 2–3 similar entries.
- **Cloudflare-essential?** Barely. `fork()` is used as a snapshot, and it would run identically on Postgres plus GitHub.

**Verdict: improve.** Three named mechanisms:
1. **FS-level read-set capture.** Fork the open-source ArtifactFS FUSE daemon to log `open`/`read` per agent mount. The read-set is then agent-agnostic and owned by the filesystem.
2. **Per-symbol-shard validator DOs** instead of a per-repo one.
3. **No abort for signature-only breaks.** Route those through the Grace Period card below; keep OCC aborts for behavioral conflicts only.

---

### Idea: Agent Reorder Buffer (speculative forwarding)
- **Pitch (one sentence, <=25 words, describes a mechanism):** Consumer agents fork the producer's in-flight fork and run speculatively. A DO reorder buffer retires in order and squashes dependents only when a forwarded interface hash changes.
- **The "wow" scene (20 seconds, concrete, what is on screen):** The organizers' own scenario as a CPU pipeline with three lanes: API, UI, Tests.
  - t=0: UI and Tests fork *the API agent's unfinished fork*, not main; arrows read `forwarded: createOrder#a91f`.
  - t=12s: API pushes a new `createOrder` signature. The push event lands, the ROB DO sees the interface hash flip to `#c07e`, and both dependent rows flash **SQUASH**.
  - Within a second their forks are re-forked from the new API commit and the agents resume with a 3-line diagnosis.
  - The ROB head retires API → UI → Tests onto main. Counter: "wall time 41s vs 2m10s serialized" (a target, not a measurement).
- **Source paradigm:** Out-of-order CPU execution (Tomasulo forwarding + reorder buffer, in-order commit, squash on mispredict).
- **What replaces the merge conflict / the PR / the branch:**
  - Branch → ROB entry {fork, exported interface tags, consumed tags + producer entry}.
  - Merge conflict → mispredict (squash and re-fork the consumer).
  - PR → retirement. An entry retires when it is at the head, its producers have retired, and its checks pass. Its commits are replayed onto the producer's retired tip, a pure fast-forward when the producer didn't move.
- **How a human decides without reading code:** The human watches the pipeline and decides only two things: the speculation-depth cap (ROB size), and vetoing an entry at the head. A veto squashes exactly its transitive dependents, which are shown on screen.
- **Why it scales to 100K agents (what is the coordination cost proportional to):** Edges of the in-flight change dependency DAG, not agent count.
  - Disconnected components get separate ROB DOs.
  - A squash costs the fan-out of one changed interface.
  - Early cutoff: pushes that leave the interface hash unchanged trigger nothing, so most pushes are free.
  - Long speculation chains amplify mispredicts; the ROB-size cap bounds this, exactly as in hardware.
- **Why a real team would use it next week:** "UI waits for the API PR" is today's main serialization point between agents. People already hand-roll stacked PRs to get around it; this automates the stack as a DAG with auto-reforking.
- **Cloudflare mapping: which primitive does what; flag anything decorative:**
  - Artifacts `fork()`-of-fork = speculative register (essential: cheap forks of forks).
  - `pushed` event = common data bus broadcast (essential).
  - DO = ROB, giving single-threaded in-order retirement for free (essential).
  - Worker + web-tree-sitter = exported-signature hashing.
  - Workflows (optional) wraps agent runs.
  - Nothing decorative.
- **Prior art found (URLs, one line each on what it is and how this differs):**
  - https://csg.csail.mit.edu/6.823F22/Lectures/L09.pdf, https://web.stanford.edu/class/cs349g/cs349g-speculation.pdf: speculation/ROB lecture notes, the source paradigm; no application to software agents found.
  - https://codex.danielvaughan.com/2026/04/16/stacked-prs-coding-agents-gh-stack-sapling-codex-skill/: stacked PRs for agents. Linear chains with manual restack, no interface-hash squash.
  - https://graphite.com/docs/graphite-merge-queue (D3): speculates CI on *finished* PRs, not on in-progress work.
  - https://arxiv.org/pdf/2603.15183: Token Coherence, MESI invalidation for multi-agent LLM *context*. Eager invalidation of context; this card adds forwarding and ordered retirement of *code*.
- **Why most teams will NOT submit this:** Teams think at merge time; this works at dispatch time and needs interface hashing plus a retirement protocol. The CPU analogy is non-obvious unless you've done microarchitecture.
- **Hardest judge objection and the answer:** "This is just stacked PRs." Stacks are linear, human-restacked, and start only after the producer pushes. The ROB is a DAG with automatic interface-hash squash. It also does **value prediction**: a consumer can start against the producer's *declared stub* before the producer writes anything, and is squashed only if reality differs.
- **48h solo feasibility (1-5) and the single riskiest implementation step:** 4. Riskiest step: stable TS exported-interface hashing inside a Worker. It must normalize formatting and comments so non-interface pushes really cut off.
- **What to mock in the demo and what must be real:**
  - Mock: agent intelligence (scripted or real LLM runs, either works) and the UI chrome.
  - Real: forks-of-forks, push-event-driven squash, re-fork, retirement onto main.
- **Scores (1-5): wow / mechanism-not-prompt / useful / scale story / feasibility / not-the-median:** 4 / 5 / 4 / 3 / 4 / 4

### Idea: One-Round Pools (error-locating-array integration)
- **Pitch (one sentence, <=25 words, describes a mechanism):** Test N pending agent changes in one parallel round of pooled fork compositions arranged as an error-locating array, naming both bad changes and bad pairs.
- **The "wow" scene (20 seconds, concrete, what is on screen):**
  - 200 agent changes are pending; click **Integrate**.
  - A grid of pool forks appears, each composing a subset and running tests in its own Dynamic Worker. The cells go green/red in one wave.
  - The decoder prints: "#37 broken alone. **#81 × #142 interaction**: each passes alone, together fail `checkout.test`." 197 land, 3 bounce with diagnoses.
  - Side counter: 1 round vs ~8 rounds of sequential bisection.
- **Source paradigm:** Group testing (Dorfman's 1943 pooled syphilis screening) → non-adaptive combinatorial group testing / error-locating arrays.
- **What replaces the merge conflict / the PR / the branch:**
  - Integration becomes one pre-designed experiment.
  - A "conflict" becomes a *decoded interaction*: a pair that fails only together. Bisection blames the *later* member of such a pair; the array names both.
  - Textually conflicting changes are known pairs, excluded from shared pools by construction.
- **How a human decides without reading code:** An incidence matrix with verdicts (clean / culprit / interaction pair, plus the failing test). The human clicks "bounce both to their agents" or "accept, quarantine the test".
- **Why it scales to 100K agents (what is the coordination cost proportional to):** Test runs grow ~d² log N for small defect count d, not N. Latency is one round regardless of N, since pools run in parallel. Forks are ~free, so the only real cost is test CPU.
- **Why a real team would use it next week:** Merge queues are the throughput ceiling for agent fleets, and cross-agent PR pairs conflict textually 41.7% of the time (https://arxiv.org/html/2607.04697v2, D3). This replaces queue bisection with one round and catches interaction bugs that queues blame on the wrong change.
- **Cloudflare mapping: which primitive does what; flag anything decorative:**
  - Artifacts `fork` = repo per pool; pool trees composed via `readTree`/`readBlob` with no worktree (essential: hundreds of forks per round).
  - Dynamic Workers run each pool's tests in a fresh millisecond isolate (essential; with containers one round takes minutes).
  - DO holds the design matrix and the decoder.
  - Queues fan out pool jobs.
  - Sandbox SDK as the non-JS fallback (slower; decorative in the demo).
- **Prior art found (URLs, one line each on what it is and how this differs):**
  - https://en.wikipedia.org/wiki/Group_testing and Dorfman 1943 (https://webpages.tuni.fi/uta_statistics/liski-arkisto/mtt-perusteet10/mttp-kurssi10/Materiaalia/Dorfman-Ann1943.pdf): the paradigm.
  - https://arxiv.org/abs/2308.13129: parallel batch testing in CI with constant/dynamic batch sizes, no interaction localization (checked in its abstract).
  - https://ece.uwaterloo.ca/~wshang/pubs/Armin_FSE_2019.pdf and https://research.google/pubs/flake-aware-culprit-finding/: batch testing and culprit finding; adaptive, single-culprit.
  - https://ruor.uottawa.ca/handle/10393/23083: Error Locating Arrays, which locate faulty *configuration* interactions. Not applied to concurrent code changes, as far as I found.
- **Why most teams will NOT submit this:** It requires combinatorial-design literature almost no hackathon builder knows; the median entry builds a merge queue.
- **Hardest judge objection and the answer:** "Flaky tests will corrupt the decoding." Locating arrays can add redundant rows to tolerate a bounded number of wrong cells. A flake also shows up as an inconsistent pattern, the framing of Google's flake-aware paper. The demo should inject one flake and show it flagged.
- **48h solo feasibility (1-5) and the single riskiest implementation step:** 3. Riskiest step: fast composition of k changes into one tree, then bundling and running a real test suite inside a Dynamic Worker.
- **What to mock in the demo and what must be real:**
  - Mock: the 200 agents (pre-generated changes, with 2 planted interactions and 1 change broken alone) and the traffic.
  - Real: fork-per-pool design, isolate test execution, decoding.
- **Scores (1-5): wow / mechanism-not-prompt / useful / scale story / feasibility / not-the-median:** 5 / 5 / 4 / 5 / 3 / 5

### Idea: Three-Isolate Review (Diffy on Dynamic Workers)
- **Pitch (one sentence, <=25 words, describes a mechanism):** Load each agent change as a Dynamic Worker beside two baseline isolates. Review replayed-traffic differences minus baseline-vs-baseline noise, including outbound side effects.
- **The "wow" scene (20 seconds, concrete, what is on screen):** No code anywhere; a table of agent changes.
  - "#12 refactor-pricing: **0 behavioral deltas** / 3,000 replayed requests (timestamp and request-id noise auto-filtered)."
  - "#31 add-discounts: `GET /cart.total` changed in 7% (expected); `POST /checkout` **500 when coupon=null** (unexpected); **new outbound call** to `email.send`."
  - Clicking a row shows one request/response pair. The judge clicks Reject.
  - A composition row checks #12+#31 together vs their individual deltas: "no interaction."
- **Source paradigm:** Production shadow-traffic testing (Twitter Diffy's primary/secondary/candidate triple) plus the telecom *feature interaction problem* for compositions.
- **What replaces the merge conflict / the PR / the branch:** PR → behavioral delta set: request classes and fields whose disagreement rate exceeds the noise floor measured between the two baselines. Semantic conflict := Δ(A∘B) ≠ Δ(A) ∪ Δ(B).
- **How a human decides without reading code:** Accept or reject per *behavioral delta* (and per new side effect), each with concrete sample requests.
- **Why it scales to 100K agents (what is the coordination cost proportional to):**
  - Each change is evaluated independently with zero coordination, so it is embarrassingly parallel.
  - Cost = distinct trees × corpus size; content hashes of candidate trees dedupe identical outputs.
  - Interaction checks run only on pairs whose deltas touch overlapping request classes.
- **Why a real team would use it next week:** "Did behavior change?" is what reviewers actually want answered. Noise-filtered deltas are reviewable at agent volume; diffs are not.
- **Cloudflare mapping: which primitive does what; flag anything decorative:**
  - Dynamic Workers build baseline, baseline-twin and candidate isolates straight from Artifacts git objects in milliseconds, with no deploy (essential).
  - Their outbound interception/blocking turns side effects into diffable records (essential).
  - Artifacts `readTree`/`readBlob` supplies the code.
  - DO stores per-endpoint/field noise statistics.
  - Limitation (not decorative): only for apps that run in the Workers runtime.
- **Prior art found (URLs, one line each on what it is and how this differs):**
  - https://github.com/Vaultman/diffy: Diffy mirror with the primary/secondary/candidate noise method. Needs deployed long-running instances; no agents, no compositions.
  - https://www.signadot.com/docs/tutorials/quickstart/smart-tests, https://signadot.com/docs/reference/smart-tests/traffic-capture-diffs: Signadot SmartTests, baseline-vs-sandbox diffs on k8s with relevance scoring and an MCP server for agents. **Closest competitor.** Differences: millisecond isolates vs k8s sandboxes, a measured noise twin vs a model, and composition interaction checks.
  - https://en.wikipedia.org/wiki/Feature_interaction_problem: the feature interaction problem.
- **Why most teams will NOT submit this:** Teams reach for "LLM reviews the diff." Behavioral review needs a runnable app plus a traffic corpus, which feels like ops, not git.
- **Hardest judge objection and the answer:** "New endpoints have no recorded traffic." Coverage gaps are surfaced explicitly as "uncovered behavior." The agent must contribute example requests, which are replayed against baseline too and become corpus for future changes.
- **48h solo feasibility (1-5) and the single riskiest implementation step:** 4. Riskiest step: turning a multi-file TS tree from Artifacts into a loadable Dynamic Worker module map (in-Worker transpile/bundle).
- **What to mock in the demo and what must be real:**
  - Mock: the traffic corpus (a recorded HAR-like file) and the agents.
  - Real: three-isolate replay, noise subtraction, outbound interception, the composition check.
- **Scores (1-5): wow / mechanism-not-prompt / useful / scale story / feasibility / not-the-median:** 4 / 4 / 4 / 4 / 4 / 4

### Idea: Grace Period (RCU for breaking changes)
- **Pitch (one sentence, <=25 words, describes a mechanism):** Publish a breaking symbol change alongside the old version via a shim. A DO counts agent forks still reading it and auto-reclaims the old version at zero readers.
- **The "wow" scene (20 seconds, concrete, what is on screen):**
  - The API agent changes `getUser(id)` → `getUser({id, tenant})`. Main stays green and no agent aborts.
  - A symbol card reads "`getUser@v1` readers: ui-agent, tests-agent, billing-agent (3)."
  - As each commits on the new base the count ticks 3 → 2 → 1. billing-agent stalls; its Artifacts token expires and drops it (an implicit lease).
  - At 0, the DO commits "reclaim `getUser@v1`: grace period ended, 0 readers", and the shim disappears.
- **Source paradigm:** Linux kernel RCU (read-copy-update: copy, publish, wait for a grace period, reclaim), plus Erlang's two-version code loading as the cap.
- **What replaces the merge conflict / the PR / the branch:**
  - A breaking change is never an abort for in-flight readers; it becomes a *versioned publication* with a bounded lifetime.
  - Structural rule: a breaking change to a symbol with live readers is rejected unless it carries an adapter shim. The LLM writes the adapter; the structure decides how long it lives.
  - Erlang rule: at most 2 live versions. A third publication force-quiesces readers of the oldest.
- **How a human decides without reading code:** Per-symbol reader lists and grace timers. The human picks "extend grace", "force purge", or "reject the breaking change". These are decisions about other agents' live work, not about code text.
- **Why it scales to 100K agents (what is the coordination cost proportional to):**
  - Readers of *changed* symbols only, tracked in per-symbol-shard DOs.
  - Zero wasted agent work on breaking changes, unlike OCC where every reader aborts.
  - Shim accumulation is bounded by max token TTL × the 2-version cap.
- **Why a real team would use it next week:** Expand/contract is the accepted safe API-change practice, but nobody does the contract step on time. This automates it with agent liveness as the trigger.
- **Cloudflare mapping: which primitive does what; flag anything decorative:**
  - Each agent's Artifacts fork is its read-side critical section; its base commit plus symbol imports give its reads.
  - Per-fork `fetched`/`pushed` events signal activity. Payloads are empty or ref/commits only, so the fork itself must identify the agent (verified).
  - Token `expiresAt` from `token.created` events gives the lease bound (verified).
  - DO per symbol shard = grace-period accounting (essential).
  - Workers run tree-sitter import scanning.
- **Prior art found (URLs, one line each on what it is and how this differs):**
  - https://archives.kernel-recipes.org/wp-content/uploads/2025/01/rcuin2019kernelrecipes2.pdf: RCU and quiescent states.
  - https://www.thoughtworks.com/radar/techniques/api-expand-contract: API expand-contract, manual and calendar-based grace.
  - https://erlang.org/pipermail/erlang-questions/2008-December/040558.html: Erlang hot-code purge semantics.
  - No system found that counts *agent* readers of code symbols to end a grace period.
- **Why most teams will NOT submit this:** It's a kernel-synchronization idea. Teams pick either "abort" or "merge" and never consider "keep both, reclaim later."
- **Hardest judge objection and the answer:** "Behavior can change under an unchanged signature; RCU won't catch it." Correct. Grace Period handles signature breaks; behavioral breaks fall through to OCC or Three-Isolate Review. It is a scoped primitive, not the whole system.
- **48h solo feasibility (1-5) and the single riskiest implementation step:** 4. Riskiest step: reliably classifying "breaking" and computing per-fork readers from imports and call sites in TypeScript.
- **What to mock in the demo and what must be real:**
  - Mock: agent work content.
  - Real: shim publication, fork reader counting, token-expiry quiescence, the auto-reclaim commit.
- **Scores (1-5): wow / mechanism-not-prompt / useful / scale story / feasibility / not-the-median:** 3 / 5 / 4 / 4 / 4 / 5

### Idea: Atomized Repo (one Artifacts repo per symbol, capability tokens)
- **Pitch (one sentence, <=25 words, describes a mechanism):** Explode the codebase into one Artifacts repo per symbol. Agents hold write tokens only for granted symbols, and main is a CAS'd manifest of symbol hashes.
- **The "wow" scene (20 seconds, concrete, what is on screen):**
  - Click **Explode**: a 400-file TS app becomes ~3,100 Artifacts repos, with a counter ticking up.
  - 500 agents launch, and a treemap of symbols lights up from per-repo push events.
  - One agent tries to push to `auth.verifyToken` without a grant, and **Artifacts itself rejects it**, not a policy hook.
  - The manifest DO advances main atomically hundreds of times per minute.
  - "Materialize" renders any manifest version back to a normal git tree for CI and humans.
- **Source paradigm:** Object-capability security (Miller et al.: authority = an unforgeable reference you hold, with attenuation and revocation).
- **What replaces the merge conflict / the PR / the branch:**
  - No branches; the manifest is the only branch.
  - A change = {symbol repo → new sha} + a manifest CAS.
  - Two agents can't write the same symbol: the DO mints at most one live write token per symbol repo (a lease via `expiresAt`), while read tokens are unlimited. That is Rust's "many readers XOR one writer" enforced at the storage layer.
- **How a human decides without reading code:** The human approves *capability grants* before work, e.g. "agent-17 requests write on `payments.charge` for 20 min." Governance = scoping who may write what, not reviewing diffs.
- **Why it scales to 100K agents (what is the coordination cost proportional to):**
  - Symbols touched per change.
  - Event streams and tokens are per symbol, so they shard naturally.
  - The manifest DO is the hot spot (~500–1000 req/s per DO, D3). Shard the manifest per package and order cross-package changes Calvin-style.
- **Why a real team would use it next week:** Least-privilege for agents is an urgent need. An agent that literally *cannot* push outside its scope is easier to approve than any policy prompt. Honest drag: cross-cutting refactors need many grants, and explode/materialize must round-trip losslessly.
- **Cloudflare mapping: which primitive does what; flag anything decorative:** Only possible because repos are ~free.
  - Artifacts repo per symbol (essential).
  - Repo-scoped read/write tokens with expiry plus `revokeToken` = capabilities (essential; tokens are repo-scoped, so per-repo = per-symbol).
  - Per-repo `pushed` events = per-symbol change feed (essential).
  - DO = manifest CAS plus token minting.
  - Worker = materializer.
- **Prior art found (URLs, one line each on what it is and how this differs):**
  - https://en.wikipedia.org/wiki/Object-capability_model (D2): the object-capability model.
  - https://www.unison-lang.org/docs/the-big-idea/ (D1): Unison's names-to-hashes codebase. A single store with no per-definition access control.
  - https://www.cloudflare.com/products/artifacts/ ("tens of millions of repos") and https://lilting.ch/en/articles/cloudflare-artifacts-agent-filesystem ("10,000 forks"): Artifacts scale claims, seen as search snippets.
  - Searching "one repo per function" found nothing relevant.
- **Why most teams will NOT submit this:** It sounds absurd ("3,000 repos?!") until you realize repos on this platform cost about as much as a DO. Teams treat the repo as the unit and never question it.
- **Hardest judge objection and the answer:** "You've reinvented submodules hell." Submodules make humans juggle pointers. Here the manifest CAS is atomic, materialization is automatic, and nobody ever clones atoms manually.
- **48h solo feasibility (1-5) and the single riskiest implementation step:** 3. Riskiest step: lossless TS explode/materialize (imports, comments, module-level statements). Artifacts repo-creation rate limits are also unknown.
- **What to mock in the demo and what must be real:**
  - Mock: agent intelligence, limited to one small app.
  - Real: repo creation at scale, token-scoped push rejection, manifest CAS, materialization.
- **Scores (1-5): wow / mechanism-not-prompt / useful / scale story / feasibility / not-the-median:** 5 / 4 / 3 / 4 / 3 / 5

---

## Unverified
- **Dynamic Workers:**
  - Open beta on the paid plan since 2026-03-24: verified (changelog seen in search).
  - Not checked: exact limits, per-isolate memory, pricing numbers, and in-Worker TS bundling (e.g., esbuild-wasm) for the module map.
- **ArtifactFS:** no per-file access log is verified (README). Ease of adding a read log in the FUSE handler is unverified.
- **Artifacts:**
  - Unverified: create/fork rate limits, real throughput of a 3,100-repo explosion, the exact HTTP status for a wrong-repo-token push.
  - "Tens of millions of repos" and "10,000 forks" come from search snippets of unopened pages.
- **Event payloads:** empty `cloned`/`fetched` and `pushed` = ref/before/after/commits with no token ID are verified (event-subscriptions guide). No ordering or latency guarantee is documented, so ROB squash latency is unverified.
- **Group testing:** "d² log N pools" for non-adaptive designs comes from general knowledge, not stated in the sources I opened. Unverified.
- **Demo numbers:** 41s vs 2m10s, 197/200, 3,000 requests and 3,100 repos are targets, not measurements.
- **Diffy and Signadot:** Diffy was cited via a mirror (https://github.com/Vaultman/diffy); the canonical opendiffy repo was not opened. Signadot noise-filtering details come from search snippets.
- **From the dossiers, not re-verified by me:** web-tree-sitter TS interface hashing reliability in a Worker (D1/D2); the DO throughput figure (~500–1000 req/s) and the Workflows v2 single-coordinator story (D3).
- **No prior art found for:** ROB-style speculation over in-progress agent work, error-locating arrays for code integration, RCU grace periods over agent readers, or repo-per-symbol. These are absences in my searches, not proof of novelty.
