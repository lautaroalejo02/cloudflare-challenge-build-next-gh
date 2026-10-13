# Shared brief: Cloudflare "Build the next GitHub" challenge

All agents read this file. It is the source of truth for the challenge, the bar, and the output format.

## The challenge (verified facts, do not re-research)
- Organizer: Cloudflare. "Build the next GitHub" Challenge. https://www.cloudflare.com/git-competition/
- Brief, verbatim: "Build a new way for hundreds of thousands of agents to work on changes concurrently. Feel free to rethink repositories, branches, pull requests, worktrees, code review, and merge conflicts."
- Illustrative scenario from the organizers: three agents work simultaneously; one changes an API, one builds the UI that consumes it, one writes the tests. Their changes may be incompatible. How do you coordinate the work, preserve context, and review what to integrate?
- Hard requirement: "I confirm this project was built using Cloudflare Workers and Artifacts."
- Submission: 5-10 minute demo video, open-source repo, run instructions. Deadline October 14, 2026. Three finalists demo at Cloudflare Connect in San Francisco; first place gets $25K in credits.
- Any language/stack is acceptable.

## Cloudflare Artifacts (verified from https://developers.cloudflare.com/artifacts/)
"Versioned storage that speaks Git." From a Worker you can create repos, import from an external remote, fork, mint read/write git tokens, and inspect objects. Binding methods: create, get, list, import, delete; per repo: info, createToken, listTokens, revokeToken, fork, log, readCommit, readTree, readBlob, readFile. There is NO server-side merge. Event subscriptions emit repo created/deleted/forked/imported and per-repo pushed/cloned/fetched/token events, consumable from a Worker. Official examples: git clients, isomorphic-git, Sandbox SDK. Other Cloudflare primitives: Durable Objects (SQLite), Workflows, Queues, Workers AI, AI Gateway, Web Search API, Sandbox SDK, Agents SDK, Browser Rendering.

## Builder's thesis
Humans no longer read or write code by hand. Coordination between agents should not rest on line-level diffs and human code review, which cannot scale to 100K agents. The human's job becomes deciding, not reading.

## The bar: an idea qualifies only if ALL hold
1. WOW: a Cloudflare engineer watching the demo would want to tweet about it. There is a specific 20-second scene where the judge gets it.
2. MECHANISM: the core is a mechanism explainable in one sentence, not "an LLM decides". LLMs may be used, but the clever part must be structural.
3. USEFUL: a real team running coding agents would adopt it tomorrow. Not a toy, not a metaphor.
4. FAST: one builder, ~48 hours, building with AI coding agents. Demo must be real (no faked core); edges may be mocked.
5. SCALE STORY: credible one-paragraph argument for "hundreds of thousands of agents working concurrently".
6. NOT THE MEDIAN: must argue why most teams will NOT submit this.

## Predictable ideas: do NOT propose these as-is
1. "GitHub for agents" dashboard: fork per agent, auto-PR, LLM reviewer agent.
2. LLM semantic merge / LLM merge-conflict resolver.
3. Spec-driven PRs: spec is source of truth, code regenerated.
4. Contract-first coordination (OpenAPI/types as shared truth, consumer-driven contracts, integrator running tests).
5. Generic agent orchestrator that assigns tasks and merges branches in sequence.
6. Blockchain / tokens / on-chain anything.
A variant is acceptable ONLY if it adds a clearly distinct, named mechanism.

## Baseline candidate (builder's current favorite) - to be critiqued, not assumed
"Transactional repository": each agent change is a transaction under optimistic concurrency control (Kung & Robinson 1981). BEGIN = fork of baseline. Read-set = symbols the agent actually read (captured from the coding agent's file reads, so the read-set IS its context). Write-set = symbols whose definitions changed (AST-level diff). COMMIT = a Durable Object per repo validates no read-set symbol changed since the snapshot; on failure it aborts with an exact diagnosis (which symbol, who changed it, why, new signature) and the agent regenerates. No textual merge ever. Review surface = dependency-graph diff + evidence, not code.

## Idea card format (strict)
### Idea: <name>
- Pitch (one sentence, <=25 words, describes a mechanism):
- The "wow" scene (20 seconds, concrete, what is on screen):
- Source paradigm:
- What replaces the merge conflict / the PR / the branch:
- How a human decides without reading code:
- Why it scales to 100K agents (what is the coordination cost proportional to):
- Why a real team would use it next week:
- Cloudflare mapping: which primitive does what; flag anything decorative:
- Prior art found (URLs, one line each on what it is and how this differs):
- Why most teams will NOT submit this:
- Hardest judge objection and the answer:
- 48h solo feasibility (1-5) and the single riskiest implementation step:
- What to mock in the demo and what must be real:
- Scores (1-5): wow / mechanism-not-prompt / useful / scale story / feasibility / not-the-median

## Integrity rules (all agents)
- Never invent papers, products, people, or URLs. Only cite URLs you actually opened or saw in search results.
- If a search returned nothing, say so explicitly.
- Mark anything you could not verify as UNVERIFIED.
- Write in English.
