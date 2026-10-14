# Narration script: Agent Reorder Buffer demo (6:00)

Read at a calm pace, about 130-140 words per minute. Each block starts at the timestamp shown and fits its window, with room for a breath. Text in [brackets] is a direction, not to be read aloud.

---

**[00:00] Title**

Hi, I'm Lautaro, and this is Agent Reorder Buffer: out-of-order execution for coding agents, built on Cloudflare.

**[00:08] The problem**

When several coding agents work on one codebase, they integrate at the very end. A 2026 study of pull requests from different coding agents found that 48 out of 115 pairs conflicted. Merge queues help, but they only speculate over finished work. I wanted coordination to happen while the work is still in flight.

**[00:33] The idea**

So I borrowed the trick a CPU uses to run instructions out of order. Every agent change is an entry in a reorder buffer, backed by its own Cloudflare Artifacts fork. A consumer doesn't wait for its producer: it forks the producer's unfinished work and starts right away. If the producer changes an interface the consumer depends on, the consumer is squashed, re-forked and told exactly what changed. If the signature stays the same but the behavior changes, an AI judge called Jev decides. And entries retire onto trunk strictly in order, with their tests run in Dynamic Workers. There is never a textual merge.

**[01:18] Live run**

This is the live dashboard, at normal speed. The agents in this run follow a script, and at the end you'll see real Codex and OpenCode agents join the same buffer. The forks, hashing, Jev calls, tests and retirement are all real.

**[01:36] Stub prediction**

Watch the UI lane. It starts before the API even exists, against a declared stub of the API's interface. That's value prediction: speculate now, verify when the real code lands.

**[01:57] Refactor, early cutoff**

Now the API agent refactors a function body. The interface hash doesn't move, and Jev scores the change zero point zero two. Nobody downstream loses any work.

**[02:13] Behavior change, semantic squash**

This one is different. Same signature, but the totals now include VAT. Jev scores it zero point nine four and zero point nine seven, one for each consumer, and both are squashed.

**[02:28] Signature change**

Now the signature itself changes. The consumers are squashed again and re-forked from the new head, with the old and new signatures in the diagnosis.

**[02:43] Retired**

And all three entries retire, in order.

**[02:48] Failing check, 1.5x**

Second scenario, at one and a half speed. Checks are not a formality here. Each entry's tests run in a fresh Dynamic Worker, on the exact commit that would become trunk. When a test fails, that entry cannot retire, and nothing behind it in its chain can jump the line. The control plane never edits code itself. It reports the failure, and the agent has to fix it.

**[03:39] The check fails**

There's the failure. The agent fixes its assertion, and the checks run again.

**[03:46] Two chains, 1.5x**

Third scenario: two independent features, orders and payments, share one trunk. Each connected group of entries gets its own Durable Object, so one chain never blocks the other. Only the final landing onto trunk is serialized.

**[04:24] No head-of-line blocking**

Payments retire while orders are still working. No waiting for someone else's head of line.

**[04:42] MCP: any agent can join**

This is the piece that makes it usable beyond a demo. The buffer ships with an MCP server. Here a scripted client drives the real server: register creates a real fork and a local workspace, push sends a real commit, and ready runs real checks before the entry retires. And it's not just scripts: Codex and OpenCode each joined this live buffer through it, wrote a feature with tests, and retired onto trunk. Git credentials never leave the server.

**[05:22] Numbers**

Jev consistently separates a refactor, at zero point zero two, from a real behavior change, at around zero point nine five. And a squash only touches the entries that depend on the change. Across almost four thousand simulated pushes it never reached outside them, so its cost follows the dependents, not the size of the fleet. Landing on trunk is the one serialized step, and batching disjoint entries is what I'd build next.

**[05:52] Closing**

Everything's open source: code, evidence and rebuild steps. Thanks for watching.

---

About 720 words over 6:00 (the hackathon allows 5-10 minutes), which leaves room for pauses. The tightest windows are [01:18] and [05:22]. If you run long there, drop "The forks, hashing... are all real." from [01:18] (the on-screen caption already says it), and drop the last sentence of [00:33] and [04:42].

Sources for spoken numbers:
- 48 of 115: arXiv 2607.04697, https://arxiv.org/html/2607.04697v2
- Jev 0.02 vs 0.93-0.97: `app/control-plane/NOTES.md`
- squash containment over 3,803 pushes: `app/control-plane/bench/RESULTS.md`
- real Codex/OpenCode agents: `app/mcp/NOTES.md`
