First read `odd/prompts/_builder_head.md` completely and follow every rule in it. Then do the task below. Other agents work in parallel: one on `app/control-plane` (integration), one on `app/dashboard`. Do not touch their files. You write documentation only.

# Task T9b: README, architecture doc and demo video script

## Allowed edit surfaces
README.md
docs/**

## Sources (read them; never invent facts or numbers)
- `research/top10.md` Idea 3 (the pitch, the wow scene, prior art, objections)
- `app/CONTRACTS.md`
- every `app/*/NOTES.md`
- `spikes/SPIKES.md`
- `odd/tasks/agent-reorder-buffer.md`, including the retirement Decision section

## Deliverables
1. `README.md` at the repo root. It replaces GitHub's placeholder; keep the existing LICENSE reference if any. Sections:
   - one-paragraph pitch;
   - the problem;
   - the mechanism (CPU reorder-buffer analogy: forwarding, squash on interface-hash change, early cutoff, in-order retirement, fast-forward or path-disjoint splice, never a textual merge);
   - what the human decides (buffer size, veto);
   - why it scales (cost proportional to edges of the in-flight dependency DAG; one DO per connected component; early cutoff);
   - architecture diagram (Mermaid) mapping each Cloudflare primitive (Artifacts forks/fork-of-fork/tokens/events, Durable Object, Queues, Dynamic Workers, Workers static assets, isomorphic-git in a Worker);
   - repository layout;
   - run instructions:
     - prerequisites (Node 22, Wrangler >= 4.149, a Cloudflare account with Artifacts);
     - deploy steps per package;
     - the namespace-wide push subscription command from `app/control-plane/NOTES.md`;
     - `npm run demo -- --base <url>`;
   - what is real vs mocked (agent intelligence is scripted);
   - measured numbers, each with its source file;
   - limitations and next steps.
   Required statement for the hackathon: "This project was built using Cloudflare Workers and Artifacts."
2. `docs/architecture.md`: deeper design. Cover the state machine, the event list, retirement modes, the failure modes and how each is handled, and the scale argument.
3. `docs/demo-script.md`: a 5-8 minute video script with timestamps. Open with the 20-second wow scene (organizers' API/UI/tests scenario as a CPU pipeline, SQUASH, retirement). Include exact commands, what to point at on the dashboard, and a fallback using `app/dashboard/mock.html` if live infra misbehaves.
4. Where integration results are not in yet (`app/control-plane/NOTES.md` "Live E2E results" missing), write `TBD (pending integration run)` instead of a number.

Verification: check that every command in the README exists in package.json scripts or NOTES. Check that every number is traceable to a file. List the checks in your final message.
