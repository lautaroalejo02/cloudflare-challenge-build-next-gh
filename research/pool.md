# Anonymous idea pool

Ideas from five advisors, author removed, order shuffled. Some cards are labeled "improved baseline"; judge them like any other.


---

## I01
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


---

## I02
### Idea: Monotone Extension Forge

- Pitch (one sentence, <=25 words, describes a mechanism): Admit isolated, namespaced extensions by set union; reserve coordination for operations that overwrite, delete, or impose cross-extension invariants.
- The "wow" scene (20 seconds, concrete, what is on screen): Eight agents add data-import adapters to the same application registry. Their independently admitted extensions appear together and process eight sample payloads. A ninth agent attempts to replace an existing adapter: its operation switches from the coordination-free lane to an explicit replacement decision.
- Source paradigm: **Database invariant confluence**: determine which operations preserve specified invariants under merging, rather than demanding serializability for everything.
- What replaces the merge conflict / the PR / the branch: The extensible surface is a grow-only set of immutable `(extensionID, programHash, pinnedImports)` records. Agents receive disjoint identifier namespaces. The supported extension language has no ambient authority or shared mutable state. Invariants—well-formed programs, resolvable immutable imports, non-overlapping identities—survive union. Replication is eventually convergent; an immutable release snapshot selects the visible set. Replacement, deletion, default selection, and shared resource limits require coordination.
- How a human decides without reading code: Review extension capabilities, input/output examples, resource limits, and executable acceptance results. Decide whether a new capability should be exposed, or whether an existing capability should be replaced.
- Why it scales to 100K agents (what is the coordination cost proportional to): After namespace allocation, independent additions require local validation and dissemination, with no fleet-wide ordering round. Cost is proportional to the extension and its pinned dependency closure, plus replication traffic. Global completeness is not free: claiming “these are all submitted extensions” needs a snapshot boundary. A shared default name or total resource budget also reintroduces coordination. The scale story applies to a useful operation class, not arbitrary edits.
- Why a real team would use it next week: Fleet-generated importers, webhook normalizers, tool adapters, and declarative transformations are genuine additive workloads. Teams can parallelize these immediately without rewriting their entire application.
- Cloudflare mapping: Workers implement admission and registry queries; Durable Objects allocate namespaces and arbitrate destructive operations; Artifacts stores immutable extension programs and release manifests; Sandbox executes validation examples and builds the application snapshot. An LLM classifier is unnecessary. No decorative primitive.
- Prior art found (URLs, one line each on what it is and how this differs):
  - https://ar5iv.labs.arxiv.org/html/1402.2237 — Establishes invariant confluence for coordination avoidance; this designs a restricted repository surface whose merge preserves explicit invariants.
  - https://github.com/mwhittaker/enforced_invariant_confluence — Explores automated and segmented invariant-confluence analysis; this starts with a small, manually justified operation algebra, not a general analyzer.
  - https://irmin.org/ — Supports custom merge functions for versioned data; this makes admissible code-extension operations and their invariant boundary the product.
- Why most teams will NOT submit this: It deliberately removes expressiveness from the fast lane. Most entrants will promise that arbitrary code changes can merge, rather than expose precisely which changes need no coordination.
- Hardest judge objection and the answer: **“Adding code is not automatically safe.”** Exactly. Independent names do not prevent initialization-order bugs, shared effects, or resource exhaustion. The MVP accepts a small declarative JSON-transformation language with isolated execution—not unrestricted JavaScript. Broader extensions need enforceable capability boundaries.
- 48h solo feasibility (1-5) and the single riskiest implementation step: **4/5** for declarative adapters. The riskiest step is ensuring that the extension evaluator cannot express hidden cross-extension effects.
- What to mock in the demo and what must be real: Mock broad language support and fleet size. Namespace isolation, union under reordered/duplicate submissions, evaluator restrictions, destructive-operation escalation, and the working application must be real.
- Scores (1-5): wow / mechanism-not-prompt / useful / scale story / feasibility / not-the-median — **4 / 5 / 4 / 4 / 4 / 4**


---

## I03
### Idea: The Evidence Locker — chain-of-custody verification for agent code
- **Pitch**: Every verification result is a signed, content-addressed attestation keyed by (symbol-body hash × baseline hash × suite); content that already carries a custody chain lands without re-running anything.
- **The "wow" scene**: Two agents independently converge on a near-identical `applyDiscount()` body. Agent 1's commit runs the suite in Sandbox — 8 seconds. Agent 2's commit lands in **90 milliseconds**: the UI flashes "CUSTODY CHAIN FOUND — evidence inherited from tx #1042, hash match 17/17 symbols." Then the judge views any landed commit: no diff, a *custody card* — author agent ID, exact suite, sandbox run log, canonical-body hashes. They ask "did you fake that?" and re-run the suite live: the hashes match.
- **Source paradigm**: Forensic chain of custody / evidence handling — admissibility requires an unbroken, verifiable possession record — implemented via content-addressed build caching (Bazel remote cache: https://bazel.build/remote/caching) and SLSA/in-toto attestation structure (https://slsa.dev/provenance/v1).
- **What replaces the merge conflict / the PR / the branch**: The PR's "checks passed" badge is replaced by a discoverable custody object stored *with the code*, keyed by content, not by pipeline run; branches and conflicts are untouched by this layer — it replaces *re-verification*, the actual cost center at 100K agents.
- **How a human decides without reading code**: Review = custody completeness: every symbol shows a green chain (hash → suite → sandbox log → signer) or a red gap. The human audits provenance like an evidence tech, never reads a diff.
- **Why it scales to 100K agents**: Verification cost becomes O(novel content), not O(agents × suites); convergent agent output (extremely common with same-model fleets) is verified once for the entire population. Lookup is O(1) hash probe per symbol.
- **Why a real team would use it next week**: Agent fleets already duplicate work and burn CI re-proving identical code; evidence inheritance is immediate cost savings with zero behavior change, and the custody card answers the question every agent-PR reviewer silently asks: "who ran what, where?"
- **Cloudflare mapping**: Artifacts blobs are already a CAS — attestations are stored as git objects in a dedicated `evidence` ref, giving signed, immutable, content-keyed storage for free; the Worker canonicalizes symbol bodies (difftastic-style whitespace/comment normalization per D1, via web-tree-sitter) before hashing; Sandbox SDK executes suites; DO SQLite indexes hash → attestation for O(1) probes; HMAC signing keys live in Worker secrets (Turborepo's signed-artifact pattern, D2). All load-bearing.
- **Prior art found**: Bazel remote caching keys build outputs by action hash (https://bazel.build/remote/caching) — build artifacts, not per-symbol code correctness, and tied to declared BUILD graphs. SLSA provenance attests *how an artifact was built* (https://slsa.dev/provenance/v1) — not that a code change passed behavioral tests. Turborepo remote cache (D2) is task-granularity. The novel join: attestation-per-symbol, canonical-body hashing for convergence inheritance, and custody as the *landing gate and review surface*.
- **Why most teams will NOT submit this**: Explaining it in a 5-minute video requires the judge to absorb canonical hashing, attestation structure, and signing in one breath — most builders will reach for a flashier mechanism. Also, canonical hashing across formatting drift is fiddly work that produces no visible UI until it suddenly produces *magic*.
- **Hardest judge objection and the answer**: "Same body hash doesn't imply same behavior — context differs." Answer: correct; the key includes the *dependency-closure hash* (transitive interface hashes of referenced symbols), so evidence transfers only when everything the symbol calls is hash-identical — a conservative soundness rule borrowed from Unison's content-addressing (D1: https://www.unison-lang.org/docs/the-big-idea/).
- **48h solo feasibility (1-5)**: **4**. Riskiest step: canonical-body hashing that's stable across the agents' formatting quirks — if normalization is flaky, the convergence flash never fires and the demo's peak dies. Test with two real agent outputs on hour 6, not hour 36.
- **What to mock in the demo and what must be real**: Real: hashing, attestation storage in Artifacts, inheritance landing, one live Sandbox re-verification. Mock: the signer is HMAC not a full key infrastructure; dependency-closure hashing covers depth-2 only.
- **Scores**: wow 3 / mechanism 4 / useful 4 / scale 4 / feasibility 4 / not-median 3


---

## I04
### Idea: Complying Presentation
- Pitch (one sentence, <=25 words, describes a mechanism): A change lands only when its documents match the credit on their face; inspecting the code is forbidden.
- The "wow" scene (20 seconds, concrete, what is on screen): A credit lists three documents: write-set manifest, typecheck log, test log. Presentation A shows a discrepancy sheet ("test log base ≠ manifest base") and a struck line, "remark 'style' disregarded." Presentation B receives an HONOUR stamp. The trunk hash moves once. No source file is on screen.
- Source paradigm: Documentary credits under UCP 600. The credit is autonomous from the underlying deal. Banks deal with documents, not with goods, services, or performance. A condition that names no document is disregarded.
- What replaces the merge conflict / the PR / the branch: The pull request and the review. A fork is only a presentation. Disjoint write-sets are spliced onto trunk by the examiner. Overlapping write-sets are a documentary discrepancy, so both presentations are refused. There is no merge step and no reviewer.
- How a human decides without reading code: The human writes the credit once. After that they see stamps and discrepancy sheets. A complaint that is not tied to a stipulated document is dropped on its face. They cannot open the diff from this screen.
- Why it scales to 100K agents (what is the coordination cost proportional to): Each examination reads one presentation's documents and the write-sets honoured since its base. Cost is proportional to document size plus the contended symbol set, not to the agent population. Independent presentations never meet.
- Why a real team would use it next week: Point branch protection at a credit of "manifest + typecheck + affected tests," and disable admin override. Green, well-formed work lands while people are asleep. Sloppy work bounces with a list a coding agent can repair.
- Cloudflare mapping: The credit and honoured write-sets live in a Durable Object. Artifacts forks are presentations. A Worker is the examiner and, on honour, splices blobs into the trunk tree with isomorphic-git. A Sandbox run produces the test and typecheck documents. Workers AI would be decorative. Artifacts has no server-side merge, so the splice is the product.
- Prior art found (URLs, one line each on what it is and how this differs): https://iftslearning.com/banks-deal-with-documents-not-performance/ — secondary statement of UCP 600 Article 5, documents not performance; this system uses that ban as the integration rule. https://guides.draftlc.com/ucp-article-5-documents-vs-goods-and-services — same article, honour is binary even when the cargo is wrong; here a complying disjoint presentation must splice. https://nhducdng.wordpress.com/2024/07/08/non-documentary-conditions-in-documentary-credits-subject-to-ucp-600/ — UCP 600 14(h), a condition with no document is ignored; that is how taste review is voided. https://docaccord.com/ and https://www.sciencedirect.com/science/article/pii/S2666954425000250 — software that checks trade documents, often still leaving a human decision; neither splices source, and this examiner may not escalate a complying presentation. https://www.cfo.com/news/how-letters-of-credit-can-stall-mergers/659447/ — letters of credit in corporate mergers, unrelated to code. A search pairing documentary credits with CI or merge did not surface a code-hosting tool.
- Why most teams will NOT submit this: It forbids the shot everyone will film: a human nodding at a diff. It also refuses work that "looks fine" but fails the paperwork.
- Hardest judge objection and the answer: "This is just CI." CI can be overridden, and a green build can still be rejected for taste. Here a complying presentation is honoured, and an objection with no stipulated document is ignored. The only refusal after a face match is a fraud check: re-run the stipulated command in the sandbox and compare the log. That is the fraud exception, not a review.
- 48h solo feasibility (1-5) and the single riskiest implementation step: 4. The risk is the object-level splice of two disjoint write-sets onto a trunk tree without a worktree merge.
- What to mock in the demo and what must be real: Mock the coding agents and any language beyond one small TypeScript fixture. Real: the credit, the face checker, sandbox logs as documents, honour versus refuse, a disjoint splice, and a collision refused as a discrepancy.
- Scores (1-5): wow / mechanism-not-prompt / useful / scale story / feasibility / not-the-median: 4 / 5 / 4 / 4 / 4 / 5


---

## I05
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

## I06
### Idea: Escrow Recording
- Pitch (one sentence, <=25 words, describes a mechanism): Deeds stay with a neutral holder and record only when every condition is met; otherwise nothing transfers.
- The "wow" scene (20 seconds, concrete, what is on screen): Three chips in a holder: API deposited, UI deposited, TEST empty. Trunk hash stays `c0ffee`. TEST deposits, the condition line goes green, one recording, the hash moves once. Cut back: TEST never arrives, the deadline hits, all chips return, the hash is still `c0ffee`. No file view.
- Source paradigm: Statutory escrow. California Civil Code section 1057: a grant deposited with a third person, to be delivered only on performance of a condition, is an escrow. The holder records when every instruction is satisfied and has no discretion to record early. This is not a dry closing. Dry funding is a delay after signing. The mechanism here is that nothing records until satisfaction.
- What replaces the merge conflict / the PR / the branch: Coupled agents do not open pull requests against trunk. Each deposits a commit with the holder under shared written instructions. The composition is rehearsed in a sandbox. Trunk changes in a single recording act, or it does not change. Cancel returns every deposit. There is no partial API commit to revert, so no compensating transaction.
- How a human decides without reading code: They see the closing statement: parties, deposit ids, conditions, which condition failed. They may amend instructions only if every party to the escrow signs the amendment. They cannot tell the holder to record the API because it "looks done."
- Why it scales to 100K agents (what is the coordination cost proportional to): One Durable Object per escrow. Cost is proportional to parties and conditions in that escrow, typically a handful, not to all agents. Escrows that do not share instructions never interact. A one-party escrow is the uncoupled case.
- Why a real team would use it next week: Tag the API agent, the UI agent, and the test agent with one escrow id whose only condition is "sandbox exit 0 on the composed tree." Trunk stops taking the API alone. That is the failure mode parallel coding agents already cause. No spec file is required.
- Cloudflare mapping: The Durable Object is the holder: instructions, deposits, deadline. Artifacts forks are the deeds. A push event deposits. A Sandbox composes the trees and runs the condition. On satisfaction a Worker writes one trunk commit. On cancel it deletes the forks and does not touch trunk. Workers AI is decorative. Artifacts cannot merge, so the only trunk write is this recording.
- Prior art found (URLs, one line each on what it is and how this differs): https://leginfo.legislature.ca.gov/faces/codes_displaySection.xhtml?lawCode=CIV&sectionNum=1057 — Civil Code 1057, delivery only on the condition; the holder is that depositary. https://legalclarity.org/how-the-escrow-process-works-in-california/ — operational account: record only after funds, signatures, and instructions are all in, and the holder does not freelance; the demo is that rule on git trees. https://california.public.law/codes/civil_code_section_1057.3 — if the deal does not close, deposited funds go back; cancel returns deeds rather than landing a subset. No search hit showed a multi-agent code host using this recording rule. It is not a shared OpenAPI document, and it is not a queue that can fast-forward one pull request first.
- Why most teams will NOT submit this: It looks like a waiting room, and the impressive frame is a trunk hash that refuses to move. Teams will film a spec, a contract test, and an orchestrator instead.
- Hardest judge objection and the answer: "Predictable idea: contract-first coordination, or a merge queue." No contract artifact is the source of truth. The instructions can be a single exit code on the composed tree. A merge queue can put the API on trunk before the UI exists. The holder is forbidden to do that, and an amendment needs every party. Sagas compensate after a partial commit. Here the partial commit is not representable.
- 48h solo feasibility (1-5) and the single riskiest implementation step: 4. The risk is the sandbox composition of three real trees and a real test run, which stays easy only if the fixture files do not overlap.
- What to mock in the demo and what must be real: Mock agent reasoning. Real: three deposits, a frozen trunk hash while TEST is missing, one recording when the sandbox passes, and a cancel path that returns deposits with the trunk hash unchanged.
- Scores (1-5): wow / mechanism-not-prompt / useful / scale story / feasibility / not-the-median: 4 / 4 / 5 / 4 / 4 / 4


---

## I07
### Idea: Retraction-Aware Repository

- Pitch (one sentence, <=25 words, describes a mechanism): Maintain change eligibility as a justification graph; revoke unsupported descendants while retaining alternatives with independently valid support.
- The "wow" scene (20 seconds, concrete, what is on screen): A new security test disproves a previously accepted API receipt. Its dependent UI and deployment candidates turn ineligible. An unrelated feature remains eligible. A UI candidate with a separately checked support path through the old API stays available; the system assembles and tests the fallback release.
- Source paradigm: **Justification-based truth maintenance**, following Doyle’s reason-maintenance model—not exhaustive enumeration of all ATMS environments.
- What replaces the merge conflict / the PR / the branch: Immutable changes and receipts form an acyclic AND/OR support graph. A justification requires all its antecedents; a candidate may have multiple independently checked justifications. Revocation changes eligibility, not stored code. Every justification binds an exact context. A release is a consistent manifest supported by valid evidence at an ordered publication epoch. The conflict unit is a support obligation or revoked assumption.
- How a human decides without reading code: Inspect “why eligible,” “why revoked,” the executable counterexample, available fallback contexts, and which requested outcomes disappear. The interface says **unsupported**, not **proven buggy**, for downstream candidates whose evidence depended on a revoked premise.
- Why it scales to 100K agents (what is the coordination cost proportional to): Changes add local nodes and support edges. Retraction work follows affected justification edges; alternative valid support stops the cascade. Shard ingestion and indexing by component. A release-domain authority orders revocation and publication so delayed workers cannot resurrect an obsolete decision. Widely shared assumptions can invalidate most of the graph—unavoidable fan-out. Multi-domain releases still need a coordinated publication boundary.
- Why a real team would use it next week: Agent changes are often invalidated late by security findings, faulty tests, or an upstream reversal. Ordinary reverts neither explain dependent evidence nor identify which work can safely remain.
- Cloudflare mapping: Workers expose justification queries and admission; Durable Objects maintain support status, revocation epochs, and authoritative release decisions; Queues propagate recomputation; Sandbox verifies fallback compositions; Artifacts preserves candidate history, evidence, and resulting source snapshots. Git export is materialization, not a second admission authority. No decorative primitive.
- Prior art found (URLs, one line each on what it is and how this differs):
  - https://dspace.mit.edu/handle/1721.1/5733 — Doyle’s TMS records reasons and revises beliefs; this applies support maintenance to exact-context integration eligibility. Verified through search text; direct retrieval failed.
  - https://github.com/benthomasson/ftl-reasons — Implements multiple justifications, retraction cascades, and restoration; this binds justifications to code/evidence hashes and release manifests rather than reasoning assertions.
  - https://buck2.build/docs/insights_and_knowledge/modern_dice/ — Maintains dependency-based validity; this adds explicit revocation, alternative justifications, and human-visible fallback decisions.
- Why most teams will NOT submit this: Most designs assume accepted work remains trustworthy forever. This treats “we no longer believe that evidence” as a first-class repository operation.
- Hardest judge objection and the answer: **“You cannot undo downstream semantics automatically.”** Agreed. The mechanism retracts admission support; it does not invent inverse code or undo deployed side effects. Replacement releases undergo real checks. Missing provenance means insufficient support, and cyclic support is rejected in the MVP rather than allowed to justify itself.
- 48h solo feasibility (1-5) and the single riskiest implementation step: **4/5** for an acyclic positive-support graph and module-level candidates. The riskiest step is ensuring alternative support describes a genuinely checked, mutually compatible context—not an arbitrary second dependency edge.
- What to mock in the demo and what must be real: Mock deployment compensation and enterprise-scale propagation. The disproving test, revocation cascade, surviving alternative support, stale-epoch rejection, fallback evaluation, and Artifacts snapshot must be real.
- Scores (1-5): wow / mechanism-not-prompt / useful / scale story / feasibility / not-the-median — **4 / 5 / 4 / 4 / 4 / 5**


---

## I08
### Idea: Reference-Preserving Patch Transport

- Pitch (one sentence, <=25 words, describes a mechanism): Encode refactorings as reversible operations and transport concurrent edits through stable symbol identities, preserving references without regenerating code.
- The "wow" scene (20 seconds, concrete, what is on screen): Three agents rename an internal API, extend its implementation, and add a caller using its old name. Ordinary Git reports overlapping edits. The operation view shows all three changes surviving; the rendered repository uses the new name everywhere, and the new test executes successfully.
- Source paradigm: **Patch theory**, specifically Darcs-style commutation of operations with context-dependent representations.
- What replaces the merge conflict / the PR / the branch: A change is an operation bundle over an immutable snapshot: `Rename(symbolID, name)` and `ReplaceBody(symbolID, expectedHash, resolvedAST)`. Names and reference identities are separate. A rename transports a body edit rather than invalidating it. Two incompatible body replacements still conflict. Consistency is deterministic composition of supported operations; the conflict unit is a symbol body, name binding, or unresolved reference—not a line.
- How a human decides without reading code: Approve the operation summary and observable changes: “internal rename; one behavior change; three new callers; these tests passed.” Unsupported transformations appear as explicit unresolved obligations, not confident prose.
- Why it scales to 100K agents (what is the coordination cost proportional to): Index operations by symbol identity and namespace. Admission examines touched symbols and relevant interfering operations, not every agent pair. Reference rendering costs proportional to affected references; a widely used rename can still have enormous fan-out. Package-level materialization batches operations into Git snapshots, avoiding one trunk push per agent. Body contention remains serialized locally.
- Why a real team would use it next week: Agent-driven renames and relocations frequently overlap ongoing feature work. This preserves already-generated work instead of paying to regenerate it after mechanical churn.
- Cloudflare mapping: Workers validate operation envelopes; Durable Objects maintain symbol versions and name bindings; Sandbox runs binding resolution, rendering, typechecking, and Git export; Artifacts stores operation history and actual source snapshots. Workers AI is optional generation, not the merger. No decorative primitive.
- Prior art found (URLs, one line each on what it is and how this differs):
  - https://darcs.net/Theory/MergersDocumentation — Token-replace patches commute with many hunks; this uses resolved program references rather than lexical token replacement.
  - https://github.com/ualberta-smr/RefMerge — Detects, inverts, and replays refactorings around textual merging; this records supported operations at creation and avoids heuristic refactoring detection.
- Why most teams will NOT submit this: It requires changing the agent’s write protocol and distinguishing symbol identity from spelling, rather than adding a smarter merge prompt.
- Hardest judge objection and the answer: **“Renaming can change behavior.”** Correct: exported wire names, reflection, dynamic lookup, and ambiguous bindings are outside the automatic lane. The MVP supports closed-world internal symbols and rejects transformations it cannot transport. Preserving references is not a theorem about arbitrary behavior changes.
- 48h solo feasibility (1-5) and the single riskiest implementation step: **3/5.** Restrict to top-level functions and static imports in one TypeScript project. The riskiest step is resolving every reference in newly submitted code to its originating symbol identity without scope capture.
- What to mock in the demo and what must be real: Replay agent submissions and mock the population visualization. Symbol resolution, operation transport, same-body conflict rejection, rendered source, tests, and Artifacts publication must be real.
- Scores (1-5): wow / mechanism-not-prompt / useful / scale story / feasibility / not-the-median — **4 / 5 / 4 / 4 / 3 / 4**


---

## I09
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


---

## I10
### Idea: The Wake-Up Ledger
- **Pitch**: An aborted agent transaction's read-set is registered as a subscription; when the invalidating symbol lands, the agent is woken with the new definition attached.
- **The "wow" scene**: Screen split: three scripted agents hammer one repo. Agent B aborts on `ChargeFlow`. Instead of a red error, the UI shows B going *dark with a "watching: ChargeFlow, refund()" badge*. Twelve seconds later agent A's commit touches `refund()` — B's tile flashes awake *before* the push finishes, already regenerating against the new signature, and lands cleanly on attempt two. Zero human keystrokes; the loop closed itself.
- **Source paradigm**: Software Transactional Memory — Haskell STM's `retry` primitive (https://hackage.haskell.org/package/stm/docs/Control-Monad-STM.html), where a failed transaction blocks on its read-set and is woken by the write that invalidates it.
- **What replaces the merge conflict / the PR / the branch**: Conflict → validation failure with a structured diagnosis; PR → transaction + diagnosis exchange; branch → snapshot baseline ID.
- **How a human decides without reading code**: A graph-diff board showing which symbols changed owners and which transactions aborted/retried, with retry counts as the health metric (retry storms = design smell, readable at a glance).
- **Why it scales to 100K agents**: Coordination cost is O(|read-set ∪ write-set|) per commit and O(subscribers∩write-set) per wake-up — no polling, no locks; validation shards by package across named DOs (`repo:pkg`), each single-threaded and trivially correct.
- **Why a real team would use it next week**: It wraps existing agents: proxy their file-read tool (10-line MCP shim), point push at Artifacts. No workflow change, immediate elimination of the 41.7% cross-agent textual-conflict rate the AIDev study measured (D3: https://arxiv.org/html/2607.04697v2).
- **Cloudflare mapping**: Artifacts = repo + push-event subscription (the trigger); isomorphic-git + MemoryBackend inside the Worker (official recipe: https://developers.cloudflare.com/artifacts/examples/isomorphic-git/); DO per package = validator + subscription table (SQLite); DO hibernation WebSockets = agent wake-ups; Queues = dead-letter for failed regen. Nothing decorative except optional Workers AI fallback for unparseable languages.
- **Prior art found**: Sourcegraph Code Monitors alert humans on code changes via query polling (https://sourcegraph.com/docs/code-monitoring) — human-facing, poll-based, no transactional coupling; mine is machine-facing, push-based, keyed to a specific aborted transaction's read-set. Kung & Robinson OCC (D2: https://eecs.harvard.edu/~htk/publication/1981-tods-kung-robinson.pdf) is the validation core, extended with STM's wake-up. jj's op-log (D1) proves lock-free repo mutation but has no subscription concept.
- **Why most teams will NOT submit this**: It requires believing the demo can run the *retry loop* live, and instrumenting the agent's tools — two unglamorous plumbing jobs. Median teams put the LLM in the merge button, not in a re-awakened client.
- **Hardest judge objection and the answer**: "Real agents don't disclose their read-sets." Answer: they don't need to — every read passes through the file/search tool shim, so the read-set is captured *structurally*, not self-reported; an agent that bypasses the shim (raw `curl`) is flagged and degrades to file granularity, never to unsafety.
- **48h solo feasibility (1-5)**: **4**. Single riskiest step: the read/write-set extraction from tree-sitter TS queries producing a stable symbol-ID scheme (module + declaration name); day-2 risk is LLM regen latency, mitigated by seeded one-shot prompts.
- **What to mock in the demo and what must be real**: Real: repo, validation, subscriptions, wake-up timing, one regen cycle. Mock: the "agents" are scripted Workers replaying recorded sessions (always show one genuinely live LLM call for credibility); package sharding mentioned, not shown.
- **Scores**: wow 3 / mechanism 4 / useful 4 / scale 4 / feasibility 4 / not-median 3


---

## I11
### Idea: Trophic Commit
- Pitch (one sentence, <=25 words, describes a mechanism): A definition lives only while consumers keep paying a limiting survival factor; unpaid definitions are deleted.
- The "wow" scene (20 seconds, concrete, what is on screen): Two rows, `price()` #ab12 and `price()` #cd34, each with a factor bar. The chip `Cart.test` detaches from #ab12 and attaches to #cd34. The epoch ticks. #ab12 hits zero and disappears from the generated barrel. A PIN control sits unused. No source is open.
- Source paradigm: The neurotrophic hypothesis. Targets secrete a limiting survival factor. Innervating neurons that receive it live. The others die. The signal moves retrograde from the target. There is no central committee of neurons.
- What replaces the merge conflict / the PR / the branch: The review, and the idea that one name has one body. Concurrent definitions of one symbol coexist under content hashes. Neither is merged. Each epoch, factor arrives only from consumers that still import or call a candidate and are themselves alive. Below threshold, the candidate is deleted and the barrel stops exporting it.
- How a human decides without reading code: They usually do not. The ledger shows definition, factor, paying consumers, and time to deletion. Injecting a pin is exogenous factor, a rescue, not a code read. Removing a pin withdraws it.
- Why it scales to 100K agents (what is the coordination cost proportional to): A definition's fate depends only on its inbound edges. Agents that never consume it do not join the decision. Cost is proportional to dependency edges touched that epoch.
- Why a real team would use it next week: Agent output that lost its last caller still sits on the default branch. Turn the ledger on for one package. Two epochs with no factor deletes the export. Two agents who both rewrote `price()` stop needing a human to pick a winner.
- Cloudflare mapping: Durable Object SQLite holds the factor ledger. A Worker on each Artifacts push rebuilds import edges. Surviving hashes are written into a generated barrel commit. A scheduled alarm runs the epoch. A Sandbox test run can count as factor. Workers AI is unnecessary.
- Prior art found (URLs, one line each on what it is and how this differs): https://link.springer.com/article/10.1093/emboj/cdg254 — target-derived factor matches neuron numbers to targets, and withdrawing NGF kills the dependent population; the ledger copies that rule onto definitions. https://pmc.ncbi.nlm.nih.gov/articles/PMC2758233/ — limiting neurotrophins as the survival rule during innervation; same source, not a code tool. https://knip.dev/features/auto-fix — static unused-file and unused-export deletion from entrypoints; it does not keep two same-name candidates, and a live consumer cannot withdraw support from one of them.
- Why most teams will NOT submit this: Automatic deletion of freshly generated code looks hostile on camera. The safe demo is a board of branches.
- Hardest judge objection and the answer: "This is dead-code elimination, and it will delete a library the night before someone needs it." Dead-code tools assume one definition and a static root set. Here two candidates of one name compete, and a consumer's departure is the vote. Deletion waits an epoch. A pin rescues a definition that has no consumer yet. It does not combine unrelated edits; disjoint additions still need a dumb splice beside it.
- 48h solo feasibility (1-5) and the single riskiest implementation step: 4. The risk is a wrong import graph killing a live export, so the fixture graph has to be checked by hand against the barrel.
- What to mock in the demo and what must be real: Mock agent generation and the rest of the repo. Real: two hashed candidates, the ledger, a consumer flip, epoch deletion, the barrel rewrite, and a pin that blocks deletion.
- Scores (1-5): wow / mechanism-not-prompt / useful / scale story / feasibility / not-the-median: 4 / 5 / 4 / 4 / 4 / 5


---

## I12
### Idea: Configuration Forge

- Pitch (one sentence, <=25 words, describes a mechanism): Treat agent changes as selectable configurations; learn context-scoped exclusions from failed compositions and solve for a verified bundle.
- The "wow" scene (20 seconds, concrete, what is on screen): Three agent changes pass individually and in every pair, but together violate an executable resource-budget check. The interface shows a three-way incompatibility—not three misleading pairwise conflicts. A fourth change repairs the budget, and all four become selectable together.
- Source paradigm: **Constraint solving and package resolution**, using Boolean configuration variables, dependency clauses, and counterexample-guided search.
- What replaces the merge conflict / the PR / the branch: A candidate is a selectable immutable module version or non-overlapping operation bundle. Constraints encode required companions, exclusive alternatives, and human priorities. Actual checks evaluate selected compositions. A failed composition creates a context-scoped exclusion; the solver proposes another selection. The conflict unit can be a hyperedge involving three or more changes. Consistency is a sealed, verified assignment—not “every pair merged cleanly.”
- How a human decides without reading code: Select desired outcomes and hard priorities, then inspect compatible bundles, omitted outcomes, and concrete failure witnesses. Solver explanations distinguish explicit constraints from observed test failures. Never label a merely sufficient explanation “the minimal cause” without checking minimality.
- Why it scales to 100K agents (what is the coordination cost proportional to): Ingestion and indexing are proportional to candidate size and constraint edges. Search is partitioned by connected constraint components, with unchanged components reused. There is no honest polynomial guarantee: dense coupled components can require exponential search, and optimization adds difficulty. Conservative dependency boundaries and bounded search prevent one hotspot from consuming the fleet. Unknown interactions require broader evaluation, not optimistic claims of independence.
- Why a real team would use it next week: Parallel migrations, competing fixes, and tightly coupled features often need “which combination should ship?” rather than “which branch wins?” This preserves alternatives and makes tradeoffs executable.
- Cloudflare mapping: Workers ingest candidates and present constraints; Durable Objects maintain component revisions and publication decisions; Sandbox runs composition tests and the solver; Artifacts stores candidates, exact failing manifests, and the selected source snapshot. Queues bound evaluation concurrency. No LLM is needed to choose a bundle.
- Prior art found (URLs, one line each on what it is and how this differs):
  - https://prefix-dev.github.io/rattler-book/deep-dive-resolvo/ — Explains SAT-based package selection and conflict learning; this selects agent-produced changes and adds executable composition evidence.
  - https://www.cs.cmu.edu/~ckaestne/pdf/fse15nier.pdf — Semex explores merge combinations through variability-aware execution; this proposes an incremental forge with ordinary concrete evaluation, persisted exclusions, and human selection.
  - https://www.microsoft.com/en-us/research/publication/verified-three-way-program-merge/ — SafeMerge verifies semantic conflict freedom; this selects among existing alternatives rather than proving a synthesized merge.
- Why most teams will NOT submit this: It attacks higher-order incompatibility and makes selection explicit. Most entrants will resolve pairs or impose a queue.
- Hardest judge objection and the answer: **“Your learned conflict could exclude a later repair.”** Correct. Failure of `{A,B,C}` does **not** justify banning every superset. Store the exact assignment—including relevant absent repair candidates—and the verifier/input hashes. Broader clauses require justification. New candidates expand the selection universe and must invalidate or revise affected exclusions.
- 48h solo feasibility (1-5) and the single riskiest implementation step: **4/5** for eight candidates, exact enumeration, and persisted constraints. Do not build a general symbolic executor. The riskiest step is correct exclusion scoping and invalidation when new repair candidates arrive.
- What to mock in the demo and what must be real: Mock large-component optimization and agent chatter. Candidate assembly, every displayed test result, the three-way failure, repair-aware exclusion handling, selection, and Git export must be real.
- Scores (1-5): wow / mechanism-not-prompt / useful / scale story / feasibility / not-the-median — **4 / 5 / 4 / 3 / 4 / 4**


---

## I13
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


---

## I14
### Idea: The Replay Booth — challenge-budget review for auto-landing trunks
- **Pitch**: All validated commits land immediately; humans hold a small daily budget of "challenge flags," each triggering an automated replay that re-verifies the commit and auto-reverts it if the challenge is upheld.
- **The "wow" scene**: Commits from five agents stream into trunk — no PRs, no queue drama. A suspicious one flashes by: agent-11 replaced the retry policy. The judge clicks CHALLENGE. The booth replays: Sandbox re-executes the suite plus a generated probe against the pre-commit baseline, dependent commits re-check, verdict banner: **UPHELD — trunk rewound, 3 dependent commits re-validated green**. Budget dial ticks 3→2. The referee never watched the game; the coach had flags.
- **Source paradigm**: Sports officiating — instant replay and the coach's challenge: continuous play by default, scarce adversarial review with an automated verdict protocol, posture reversal on upheld challenges.
- **What replaces the merge conflict / the PR / the branch**: The PR is replaced by *default-accept integration* plus an ex-post adversarial channel; the merge conflict is pre-empted by immediate sequential landing with validation (lightweight OCC); the human's review attention becomes a priced, budgeted resource instead of an unbounded queue duty.
- **How a human decides without reading code**: The feed shows per-commit risk cards (blast radius, novelty score vs. evidence locker, author agent's upheld-challenge rate). Challenging is one click; the replay verdict arrives as evidence, not opinion. The budget forces triage — which is the actual design: scarcity makes attention legible.
- **Why it scales to 100K agents**: Integration cost is O(commit) sequential validation; human cost is O(challenges), a hard-capped constant; replay cost is O(challenged commits + dependents) via the existing validation pipeline — attention, not compute, is the bounded quantity and it's bounded *by construction*.
- **Why a real team would use it next week**: The data already says they behave this way — 71% of GitHub PRs self-merge and 84-90% ship without formal review (D3: https://tformance.com/report/) — this legitimizes reality and adds the missing safety valve: a cheap, automated reversal with an audit trail, instead of pretending review happens.
- **Cloudflare mapping**: Artifacts = trunk; commits land via isomorphic-git push from the gating Worker; Workflows runs the replay DAG (re-verify → dependent recheck → revert) durably; Sandbox SDK re-executes suites; DO holds budget counters, challenge records, and trunk-ref custody (revert = ref move to pre-commit tree via Artifacts binding, history preserved); Agents SDK optional for the probe generator. Challenge UX is a Worker page over DO state. Nothing decorative.
- **Prior art found**: Phabricator Audit is post-publish, nonblocking review (https://secure.phabricator.com/book/phabricator/article/audit/) — but human-driven, unbudgeted, no automated replay or auto-revert. Ship/Show/Ask lets the *author* choose pre/post-merge treatment per change (https://www.martinfowler.com/articles/ship-show-ask.html) — discretion sits with the author in a trust model; the booth puts bounded adversarial power with *reviewers* of untrusted agent output, backed by machine verdicts. GitLab trains/GitHub MQ (https://docs.gitlab.com/ci/pipelines/merge_trains/) are pre-merge gates — the opposite posture.
- **Why most teams will NOT submit this**: It's philosophically uncomfortable — it openly says "review almost never happens; instrument the exception." Teams will flinch and build another pre-merge gate. The mechanism is also unglamorous plumbing (ref custody, durable replay), not a clever algorithm.
- **Hardest judge objection and the answer**: "Agents will flood trunk and 3 challenges/day is security theater." Answer: challenges are the *human* layer over three machine layers (landing validation, evidence-locker inheritance, quarantine switchboard); the budget exists precisely because human attention is the scarcest resource at 100K agents, and upheld-challenge rates feed author reputation that re-ranks future risk cards — the system sharpens itself.
- **48h solo feasibility (1-5)**: **5**. Riskiest step: dependable trunk rewind via Artifacts (verify early that moving the ref back + re-validating dependents never wedges; keep a linear trunk to make it trivial).
- **What to mock in the demo and what must be real**: Real: landing pipeline, challenge click, replay verdict, rewind, budget counter. Mock: the "generated probe" is one canned assertion; agents are scripted; risk-card novelty scores are heuristic placeholders.
- **Scores**: wow 4 / mechanism 4 / useful 3 / scale 4 / feasibility 5 / not-median 4


---

## I15
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


---

## I16
### Idea: Starboard Rule
- Pitch (one sentence, <=25 words, describes a mechanism): Head-on writers both turn away; in a crossing only the downstream writer rewrites; no winner is elected.
- The "wow" scene (20 seconds, concrete, what is on screen): Two tracks enter `refund()`. The label is HEAD-ON, RULE 14. Both tracks kink aside. The symbol hash does not change. A third track, `InvoicePage`, is labeled CROSSING, GIVE WAY. It bends onto the API writer's new signature. The API track stays straight and lands. No diff hunks are shown.
- Source paradigm: COLREGS Rules 14 and 15. Head-on, each vessel alters to starboard so they pass port to port. If in doubt, assume head-on. Crossing, the vessel that has the other on her starboard side keeps out of the way and does not cross ahead. The stand-on vessel holds course. No radio.
- What replaces the merge conflict / the PR / the branch: The conflict marker and the choice of a winner. Write-sets and read-sets fix the geometry. Same symbol, neither side downstream of the other: head-on. Both patches are refused, the symbol stays at the ancestor for that encounter, and both agents must resubmit without writing it. One side's write-set sits in the other's read-set only: crossing. The upstream writer is stand-on and may splice. The downstream writer must resubmit against the new signature and must not land on the old base. Mutual dependency: doubt, so head-on. A pull request is never opened.
- How a human decides without reading code: The screen is the encounter: rule, who held, who altered, the one-line order. Rule 14 allows a different outcome only when the parties have agreed. That agreement is an explicit act, not a default review.
- Why it scales to 100K agents (what is the coordination cost proportional to): Only pairs that share a write symbol, or cross on a read/write, are encounters. Everyone else splices with no coordination. Cost is proportional to conflict pairs. A many-writer pile on one symbol does not elect anyone: doubt makes every one of them alter.
- Why a real team would use it next week: Two agents in one repo stop resolving a textual conflict by coin flip. The consumer of a changed signature is always the one who rewrites. Two owners of the same function are told the truth: neither patch will land.
- Cloudflare mapping: A Durable Object stores open encounters and symbol locks. Artifacts push events feed a Worker classifier. Stand-on landing is a disjoint blob splice. Give-way and head-on orders go out as structured abort records. The agent's later regeneration can be an ordinary coding-agent loop. The rule itself does not call a model. Sandbox is optional.
- Prior art found (URLs, one line each on what it is and how this differs): https://www.law.cornell.edu/cfr/text/33/83.14 — 33 CFR § 83.14, each head-on vessel turns starboard, and doubt counts as head-on; the encounter table copies that, and it does not use the Great Lakes exception in 14(d). https://ialacolreg.com/en/colreg/rule-15 — Rule 15, the vessel with the other on her starboard gives way and avoids crossing ahead; downstream-gives-way is that rule on the import graph. http://gamma-web.iacs.umd.edu/ORCA/ — ORCA, communication-free robot avoidance where each agent takes half the responsibility in velocity space; half-adjusting a function would be a semantic merge, which this rule refuses. Crossing here is asymmetric, and head-on has no winner. Searches on these rules and on ORCA did not surface a source-control policy with this classification.
- Why most teams will NOT submit this: It refuses to crown a winner, so the demo sometimes lands nothing. Teams would rather show a successful auto-merge.
- Hardest judge objection and the answer: "Downstream rebases. That is ordinary." That is only the crossing case. Head-on has no downstream side and no loser, so a rebase-the-other policy cannot state it. Three writers on one symbol fall under the doubt clause and all alter. Under-merging is the mechanism.
- 48h solo feasibility (1-5) and the single riskiest implementation step: 4. The risk is extracting stable symbol identities with tree-sitter so "same symbol" is not a filename guess.
- What to mock in the demo and what must be real: Mock regeneration after the order (a prepared second patch is enough). Real: classification of a head-on pair and a crossing pair, the lock on the head-on symbol, stand-on splice, and both original head-on patches refused.
- Scores (1-5): wow / mechanism-not-prompt / useful / scale story / feasibility / not-the-median: 4 / 5 / 4 / 4 / 4 / 5


---

## I17
### Idea: Verification-Cut Repository

- Pitch (one sentence, <=25 words, describes a mechanism): Publish compositions only when a content-addressed verification graph covers their exact inputs, reusing unchanged subgraphs across concurrent changes.
- The "wow" scene (20 seconds, concrete, what is on screen): An API refactor leaves its signature unchanged. Interface checks remain reusable, but behavioral-test receipts turn stale. Concurrent UI work appears individually green; the composed snapshot fails a freshly executed behavioral test. The screen shows precisely which evidence survived and which was invalidated.
- Source paradigm: **Self-adjusting build graphs**, particularly verifying traces, content-addressed actions, and value-based early cutoff.
- What replaces the merge conflict / the PR / the branch: Agents submit immutable module candidates. A release manifest chooses exact versions, including explicit alternatives when a module has competing candidates. Its review object is a **verification cut**: reusable receipts plus newly required actions covering every policy-required target. A receipt binds command, toolchain, environment, policy, and exact input closure. Publication seals that manifest; module-slot collisions remain choices, not synthesized merges.
- How a human decides without reading code: See the behavioral delta, affected release targets, freshly evaluated obligations, reused evidence, and unverified obligations. Choose “publish this composition,” “retain the prior module,” or “require this additional check.” Agent-written test logs are not accepted as authoritative receipts.
- Why it scales to 100K agents (what is the coordination cost proportional to): Verification work scales with distinct action keys and demanded invalidated graph nodes, not agents multiplied by whole-repository CI. Identical requests share an in-flight action. Shard caches and scheduling by action hash. Release publication remains ordered per release stream, but is batched rather than per proposal. A change affecting every target still costs every affected target; the system exposes that cost instead of hiding it.
- Why a real team would use it next week: Teams already waste CI on equivalent agent outputs and incorrectly assume independently green changes compose. Exact-context receipts address both problems while retaining executable evidence.
- Cloudflare mapping: Workers compute manifests and action keys; Durable Objects deduplicate in-flight evaluations and seal release decisions; Queues distribute work; Sandbox runs trusted checks; Artifacts stores source, receipt manifests, and released snapshots. Workflows may manage retries but is not the correctness mechanism. No decorative primitive.
- Prior art found (URLs, one line each on what it is and how this differs):
  - https://bazel.build/remote/caching — Shares action results through action hashes and CAS; this makes cross-composition evidence validity the repository’s admission and review unit.
  - https://buck2.build/docs/insights_and_knowledge/modern_dice/ — Tracks dependencies and cuts off recomputation when values remain equal; this applies that boundary separately to interface evidence and behavioral evidence.
  - https://www.cambridge.org/core/journals/journal-of-functional-programming/article/build-systems-a-la-carte-theory-and-practice/097CE52C750E69BD16B78C318754C7A4 — Systematizes build schedulers and rebuilders; this uses their mechanisms for integration decisions.
- Why most teams will NOT submit this: Most will attach CI badges to agent PRs. This makes evidence a reusable graph over exact compositions, and visibly refuses stale green badges.
- Hardest judge objection and the answer: **“This is just CI caching.”** The cache is established prior art. The differentiator is admitting a repository composition through its verification cut, including invalidation explanations. There is no claim that passing tests prove correctness. Undeclared filesystem, network, clock, randomness, or directory-enumeration inputs make a receipt non-reusable unless sealed.
- 48h solo feasibility (1-5) and the single riskiest implementation step: **4/5** with explicitly declared action inputs. The riskiest step is ensuring every reused receipt binds the complete input closure, rather than only signatures or changed filenames.
- What to mock in the demo and what must be real: Mock automatic dependency discovery and large fleet load. Hashing, trusted evaluation, deduplication, stale-evidence rejection, composed failure, and release gating must be real.
- Scores (1-5): wow / mechanism-not-prompt / useful / scale story / feasibility / not-the-median — **4 / 5 / 4 / 4 / 4 / 4**


---

## I18
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


---

## I19
### Idea: Tower Control — wake-separation merge scheduling
- **Pitch**: Commits land like aircraft: required separation behind each commit is a function of its "wake" (dependent-symbol blast radius), read off a pairwise matrix, with parallel runways for disjoint changes.
- **The "wow" scene**: A runway timeline fills the screen. A "heavy" refactor — 214 dependent symbols, category C — touches down and the timeline behind it shows a physical *gap*: three followers auto-rebase into "go-around" loops. Simultaneously, on parallel runway 2, eleven category-F doc/test commits stream in at full rate because their affected-symbol sets are disjoint. The judge sees *airport throughput thinking* applied to a repo, and the parallel runways make the point viscerally.
- **Source paradigm**: Air traffic control wake-turbulence separation — FAA RECAT, a pairwise (leader × follower) separation matrix over six wake categories (https://www.faasafety.gov/files/notices/2012/Oct/MEM_SAFO_final_signed_version.pdf; JO 7110.123: https://www.faa.gov/documentLibrary/media/Order/JO_7110.123.pdf).
- **What replaces the merge conflict / the PR / the branch**: The FIFO merge queue itself is replaced by a scheduler; conflicts become *spacing violations* resolved by re-sequencing (go-around), not by human surgery; branches become arrival queue entries with a slot time.
- **How a human decides without reading code**: The tower board: category badge per commit (derived from static blast radius), slot assignments, and go-around count. Deciding = adjusting the matrix, a six-cell table, never a diff.
- **Why it scales to 100K agents**: Cost is O(1) matrix lookup per arrival plus O(|affected sets|) intersection checks to assign runways; throughput scales with the number of independent runways = partitions of the import graph, which grows with repo size, not agent count.
- **Why a real team would use it next week**: Merge queues already exist in their stack (GitHub MQ, GitLab trains); this drops in as a smarter sequencer for the same CI gate, and it monetizes a fact they already feel: FIFO punishes small commits stuck behind giant refactors.
- **Cloudflare mapping**: Artifacts = trunk + candidate refs; web-tree-sitter in the Worker builds the import/dependency graph and classifies weight (https://www.npmjs.com/package/web-tree-sitter — explicitly Workers-compatible WASM); a sequencer DO owns slot assignment and followers' rebase instructions; Sandbox SDK runs per-slot validation; the board is a Worker-served page over DO WebSockets. Queues for go-around re-dispatch. Nothing decorative.
- **Prior art found**: GitLab merge trains test each MR against all queued predecessors in FIFO order (https://docs.gitlab.com/ci/pipelines/merge_trains/) — composition validation, but no weight classes, no spacing, no parallel runways. Graphite's speculative parallel CI (D3: https://graphite.com/docs/merge-queue-optimizations) speculates on orderings of the same single lane; Uber SubmitQueue (D1) builds speculation trees over conflicting changes only. None derives a *separation requirement from a static risk matrix*, which is the FAA move.
- **Why most teams will NOT submit this**: The merge-queue space reads as "solved infrastructure," and teams reaching for it copy FIFO. The aviation framing requires trusting that a *static* blast-radius metric (dependent count from tree-sitter imports) is a credible substitute for CI-proven incompatibility — a taste call most builders won't make.
- **Hardest judge objection and the answer**: "Static dependent count ≠ actual incompatibility — your spacing is cargo cult." Answer: correct, and so is the FAA's — wake categories are also a conservative proxy for actual vortex physics, chosen because it's computable *before* arrival. The matrix is tunable; the mechanism under test is scheduling, not the metric. And CI still gates every slot; spacing only decides *when* validation runs.
- **48h solo feasibility (1-5)**: **4**. Riskiest step: making go-around rebases reliable via isomorphic-git (rebase is manual tree work in isomorphic-git — budget a clean-cherry-pick-via-tree-rewrite helper on day 1).
- **What to mock in the demo and what must be real**: Real: weight classification, matrix spacing, parallel-runway assignment, one live go-around+rebase. Mock: CI per slot is a 2-second scripted Sandbox pass for all but one commit; six categories shown, maybe three actually tuned.
- **Scores**: wow 4 / mechanism 4 / useful 3 / scale 4 / feasibility 4 / not-median 4


---

## I20
### Idea: Contact Tracing — symbol-level quarantine for a fast trunk
- **Pitch**: When a landed agent commit misbehaves, trace which symbol versions were exposed by the failing execution and quarantine exactly those symbols to their previous definitions — without reverting history.
- **The "wow" scene**: 50 agent commits land in trunk in four minutes while a live storefront app consumes it. The judge clicks "inject fault" (a seeded bad commit from agent-23). Checkout breaks. One click on "Trace" replays the failing request's exposure log, highlights **two** symbols out of ~300 touched, and the quarantine switchboard flips exactly those to their prior definitions — checkout is green again in under five seconds, with the other 49 commits' work still live. The git history is untouched.
- **Source paradigm**: Epidemiological contact tracing and quarantine — isolate the exposed, not the population; fault-attribution rigor borrows from spectrum-based fault localization (ranking suspicious elements by execution spectrum, e.g. https://psycnet.apa.org/doi/10.1145/1529282.1529374).
- **What replaces the merge conflict / the PR / the branch**: Revert — the crudest tool in git — is replaced by surgical quarantine; the PR gate is replaced by *land-then-surveil*: everything lands, exposure logging provides the safety. Branches are unnecessary; mutations are sequential writes to trunk with versioned symbol definitions.
- **How a human decides without reading code**: The quarantine board shows each incident: failing signature, exposure trace (which symbol versions executed), and a one-click minimal quarantine proposal with blast-radius ("un-quarantining these 2 symbols re-exposes 0 other incidents"). Decisions are numeric, never textual.
- **Why it scales to 100K agents**: Landing cost is O(write-set); surveillance cost is O(exposure log), which is sized by traffic, not agent population; quarantine cost is O(traced symbols). History never rewrites, so coordination cost is decoupled from concurrency entirely.
- **Why a real team would use it next week**: Teams already pay the revert-pipeline tax (bad agent commit → revert PR → CI → redeploy → everyone's pending work rebased). Quarantine is instant, reversible, and doesn't disturb in-flight work; it generalizes the feature-flag discipline they already respect to a granularity flags can't reach.
- **Cloudflare mapping**: Artifacts = trunk history (untouched, full audit); a generated module façade in the demo app resolves every symbol through a registry table in a DO (symbol → ordered definition versions); exposure logs written from the app's Worker runtime per request; quarantine = registry row flip, propagated over DO WebSockets. Sandbox SDK replays the failing request against candidate quarantine sets. Artifacts is the audit spine; the DO is the mechanism.
- **Prior art found**: LaunchDarkly kill switches/guarded rollouts toggle hand-authored flags on metric thresholds (https://launchdarkly.com/docs/home/flags/killswitch; https://launchdarkly.com/docs/guides/cheatsheets/runtime-controls — which now markets agent remediation) — flag granularity is coarse and human-authored; mine auto-derives quarantine units from commits at symbol granularity. Function-level flag libraries exist (e.g. https://github.com/mainshayne233/feature_flag) but are config conveniences with no tracing or versioning story. jj's conflicts-as-data (D1) inspires "divergence as value," but jj still resolves by editing commits.
- **Why most teams will NOT submit this**: It demands a codebase authored (or codemodded) so every exported symbol resolves through a registry — an architectural constraint that feels invasive, and a demo app you must build *and* break convincingly. Most builders won't trade that for a mechanism judges can't unsee.
- **Hardest judge objection and the answer**: "Real production code can't route every call through a registry." Answer: for JS/TS it's a bundler-time transform (equivalent to what instrumentation vendors already do), and for other stacks it's an incremental codemod at import boundaries; quarantine degrades gracefully to file-granularity units where the façade is absent — same mechanism, coarser cell.
- **48h solo feasibility (1-5)**: **3**. Riskiest step: the exposure log — capturing *which symbol versions executed* per request reliably enough that one click proposes the minimal set. Fallback: coarse it to (commit → exported symbols) attribution, still demo-able.
- **What to mock in the demo and what must be real**: Real: registry, exposure log for the checkout path, fault injection, quarantine flip, green-app recovery. Mock: exposure coverage for non-demo paths; the "50 agents" are scripted commit generators; SBFL scoring shown as a number, simplistic formula.
- **Scores**: wow 4 / mechanism 4 / useful 4 / scale 3 / feasibility 3 / not-median 4


---

## I21
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


---

## I22
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


---

## I23
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


---

## I24
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


---

## I25
### Idea: Inc Loss
- Pitch (one sentence, <=25 words, describes a mechanism): Agent changes stay on plasmids; a shared incompatibility group cannot coexist, so one is lost, not merged.
- The "wow" scene (20 seconds, concrete, what is on screen): A cell. The chromosome is grey and marked locked. Two plasmids tagged `inc:auth` sit inside. A division ticks. The lower-copy plasmid shrinks and is gone. A plasmid tagged `inc:billing` never moves. No editor is open.
- Source paradigm: Plasmid incompatibility. Plasmids that share a replicon or a partitioning system cannot be kept stably in one cell. The cell does not fuse them. They compete for the same copy-number control, and one lineage is lost across divisions.
- What replaces the merge conflict / the PR / the branch: Agents do not branch the chromosome. A change is a cassette: a directory plus `{inc, provides}`. Different Inc groups mount together. The same Inc group: both cassettes are stored, the host keeps running, and each epoch the lower copy-number cassette is diluted out. Copy number in the demo is the cassette's own passing tests. There is no merge commit and no resolver error for a human.
- How a human decides without reading code: The cell view shows group, resident cassette, copy number, and which cassette is shrinking. Adding a test raises copy number. Putting both behaviors in the host requires giving them different Inc labels, which is a declaration that they do not share a replicon. Neither act is a code read.
- Why it scales to 100K agents (what is the coordination cost proportional to): One Durable Object per Inc group. Agents in different groups never share a lock. Cost is proportional to cassettes inside a contended group. The chromosome is not a write target for agents, so the hot core is not in the contention set.
- Why a real team would use it next week: New agent tasks may only add a directory under `plugins/` with a manifest. A Worker rejects any submission that touches chromosome paths. Two agents building payments cannot both remain mounted. The team does not rewrite history first.
- Cloudflare mapping: Artifacts holds the chromosome repo and one repo, or tree, of cassettes. Agents do not receive a token that can update trunk directly. They submit cassettes to a Worker, which refuses chromosome paths. A Durable Object per Inc group stores the resident id and copy number. A Sandbox runs that cassette's tests to set copy number. Workers AI is decorative.
- Prior art found (URLs, one line each on what it is and how this differs): https://blog.addgene.org/plasmids-101-plasmid-incompatibility — same replicon or partition system means unstable coexistence and loss, including asymmetric loss when one plasmid outcompetes the other; the epoch rule is that fact, made deterministic by test count. http://www.fifi.org/doc/debian-policy/policy.html/ch-relationships.html — Debian `Conflicts`: dpkg refuses to install both and can halt for a human; Inc Loss does not halt and does not ask. https://osgi.org/specification/osgi.core/7.0.0/service.resolver.html — OSGi resolver wires requirements to capabilities and treats same-identity singletons as conflicts; a failed resolve is an error, whereas the host here keeps running. https://github.com/dart-lang/pub/blob/master/doc/solver.md — PubGrub searches for a version set that satisfies everyone; Inc Loss is not a search. https://doi.org/10.1099/mgen.0.000398 and https://doi.org/10.1099/mgen.0.000206 — Platon and MOB-suite, software that detects plasmid replicons in DNA assemblies; a search on plasmid incompatibility as a module architecture returned this bioinformatics, not a code host.
- Why most teams will NOT submit this: It only works if agents are kept off the chromosome. The popular demo lets every agent edit every file, then shows a clever merge.
- Hardest judge objection and the answer: "Plugins, plus a costume." Plugin systems and Debian stop and ask. Version solvers hunt for a compromise that keeps both parties. Here the host stays up, same-group cassettes are defined to be unmaintainable together, and one is deleted by copy number. A cross-cutting edit of core is a chromosome change. Agents are not allowed to do it. A human does it rarely, on purpose.
- 48h solo feasibility (1-5) and the single riskiest implementation step: 4. The risk is enforcement: the Worker must actually reject a cassette that writes outside `plugins/` and the manifest, not merely document the rule.
- What to mock in the demo and what must be real: Mock agent code generation. Real: manifest check, path rejection, two same-group cassettes, test-count copy number, one diluted out, a different group untouched, chromosome hash unchanged by agents.
- Scores (1-5): wow / mechanism-not-prompt / useful / scale story / feasibility / not-the-median: 4 / 5 / 4 / 4 / 4 / 5
