# Demo video script — Agent Reorder Buffer

Target length: ~6:30 (range 5–8 min). Screen record at 1080p+, terminal font
large. Two panes side by side: terminal (left), dashboard (right).
Narration lines are in quotes; [STAGE] directions are not read aloud.

Pre-flight (before recording):

```sh
cd app/control-plane && npm install && scripts/setup.sh   # queue + subscription + deploy
cd ../demo && npm install
```

Dashboard URL: `https://arb-control-plane.<your-subdomain>.workers.dev/`

---

## 0:00–0:20 — Cold open: the wow scene

[STAGE] Open the dashboard mid-run — play the mock replay
(`app/dashboard/mock.html`, click `↺ replay`) or cut to recorded live footage.
Narrate over it; do not explain yet.

> "Three coding agents: API, UI, and Tests. The UI and Tests agents did not
> wait for the API pull request — they forked the API agent's *unfinished*
> work, against this forwarded interface hash. Twelve seconds in, the API
> agent changes the signature. Watch: SQUASH. Both dependents re-fork
> automatically, each with a diff of exactly what changed. And the buffer
> retires API, UI, Tests — in order — onto main. That's a CPU reorder
> buffer, running on a repository."

[POINT AT] the three lane rows, the `forwarded:` arrows from the API row to
the UI/Tests rows, the red SQUASH flash, then the rows turning green into
the trunk chip in order.

## 0:20–1:05 — The problem

> "'UI waits for the API PR' is the main serialization point between
> parallel agents. Merge queues and stacked PRs work at merge time — they
> serialize *finished* work, and a clean textual merge can still hide a
> breaking interface change. The Agent Reorder Buffer moves integration to
> dispatch time. Consumers start immediately on the producer's in-progress
> fork — operand forwarding. If a forwarded interface hash changes, only the
> dependents that consumed it are squashed and re-forked. Body-only pushes
> wake nobody. And retirement is a fast-forward or a path-disjoint splice —
> never a textual merge."

## 1:05–1:50 — Architecture on Cloudflare

[STAGE] Show `README.md` rendered (the Mermaid diagram), or
`docs/architecture.md`. One sentence per primitive, pointing at the diagram:

> "Everything you just saw runs on Cloudflare primitives. Artifacts gives
> each buffer entry its own repo — fork-of-fork is the forwarding path.
> `repo.pushed` events stream through a Queue into the control-plane Worker.
> A single Durable Object is the reorder buffer: it rehashes exported
> interfaces with tree-sitter WASM, decides squashes, and retires in order.
> Retirement checks run inside a Dynamic Worker, and the git fast-forward is
> isomorphic-git inside a Worker. This dashboard is the same Worker's static
> assets, fed by one WebSocket."

## 1:50–2:20 — Setup (speed-run)

[STAGE] Terminal, `app/control-plane`. Show `wrangler.toml` briefly, then
the already-deployed worker. Do not narrate installs.

> "Setup is one script: it creates the push-events queue, one namespace-wide
> subscription, and deploys:"

```sh
cd app/control-plane
scripts/setup.sh
# inside it:
npx wrangler queues subscription create arb-push-events \
  --source artifacts --events repo.pushed \
  --source-namespace arb --name arb-ns-push-sub
```

## 2:20–5:00 — The live run

[STAGE] Terminal left, dashboard right. Run:

```sh
cd app/demo
npm run demo -- --base https://arb-control-plane.<your-subdomain>.workers.dev
```

Expected duration: TBD (pending integration run) — the same scenario takes
~23 s against the local mock. Narrate through the beats; each maps to a
visible dashboard change:

1. **t≈+2 s — entries created.** "Three entries appear amber —
   speculating. Note the arrows: UI and Tests forked the API entry's fork,
   carrying `createOrder`'s interface hash. That hash is their speculative
   operand."
   [POINT AT] lane rows, forwarded-hash arrows, entry cards showing
   `arb-e<seq>-<lane>-0` repos.

2. **t≈+10 s — the early cutoff.** "The API agent just pushed a refactor —
   extracted a helper, identical interface. Watch the stats bar:
   `hash.unchanged`, early-cutoff counter ticks. No squash, no wakeups. A
   push that doesn't change an interface costs almost nothing."
   [POINT AT] stats counters, event log entry.

3. **t≈+20 s — the mispredict.** "Now the breaking change: `createOrder`
   takes an options object. Interface hash flips — SQUASH on both
   dependents. Each diagnosis shows the old and new signature, per symbol.
   Their generation bumps, new forks `…-1` are minted, and each agent
   re-clones and adapts against the new signature."
   [POINT AT] red flash, diagnosis block (`−` old signature / `+` new
   signature), generation counter, refork arrows.

4. **t≈+30 s — retirement.** "Agents mark ready; each head entry's tests
   run inside a Dynamic Worker — violet checking, blue ready. Then in-order
   retirement: e1, e2, e3 slide into the trunk chip as fast-forwards. Final
   stats: squashes, early cutoffs, checks run, pushes seen."
   [POINT AT] status color transitions (amber → violet → blue → green),
   the FLIP animation into the trunk chip, `stats` line, trunk `commit`.

## 5:00–5:50 — The human's two decisions

> "The human decides exactly two things. One: speculation depth — the
> buffer size."

```sh
curl -X POST <base>/api/config -H 'content-type: application/json' -d '{"robSize":4}'
```

> "Two: veto — on the head entry only."

[STAGE] Click the VETO button on the head entry, or:

```sh
curl -X POST <base>/api/entries/<head-id>/veto
```

> "A veto squashes exactly that entry's transitive dependents — highlighted
> before it lands — and they re-fork from the vetoed entry's own base, so
> they can still retire."

## 5:50–6:30 — What's real, what's scripted, measured numbers

> "Honesty slide. Real: every Cloudflare primitive — the forks, the events,
> the Durable Object, the Dynamic-Worker checks, the git fast-forward.
> Scripted: the agents. There's no LLM — a squash adaptation is a regex
> picking between two pre-written variants.
>
> Numbers, all measured on the real platform: push events arrive in ~3.8 s
> median, with a 0.7 s Durable-Object poll as fallback. A fork costs ~2 s.
> Interface hashing is ~30 ms of CPU inside the Worker. A Dynamic-Worker
> check is ~260 ms warm. A fast-forward retirement is ~0.9 s. Live
> end-to-end timing: on screen if today's run held up."

[STAGE] If live numbers are not in, say "pending integration run" instead of
a figure — never improvise one.

## 6:30–6:45 — Close

> "Cost scales with the edges of the in-flight dependency graph, not the
> number of agents — one reorder buffer per connected component, each a
> Durable Object. Next: speculating on declared stubs before the producer
> writes anything, and handing breaking changes a grace period.
> This project was built using Cloudflare Workers and Artifacts."

[STAGE] End card: repo URL, `README.md`, LICENSE (MIT).

---

## Fallbacks (if live infra misbehaves)

In order of preference:

1. **Dashboard mock replay** — no backend at all. Open
   `app/dashboard/mock.html` over `file://` (classic scripts, works
   offline) and click `↺ replay`. It replays the full scripted scene in
   ~20 s, including a `check.failed` → fix-push → `check.passed` → retired
   beat the main scenario doesn't show. `index.html?mock=1` works too.
   Say on camera: "this is the dashboard's event replay — the UI is real,
   the events are canned."

2. **Fully local run** — real agents, real scenario, no Cloudflare:

   ```sh
   cd app/demo
   npm run mock -- --port 8899 --root tmp-mock/live   # terminal 1
   npm run demo -- --base http://127.0.0.1:8899        # terminal 2
   npm run demo -- --base http://127.0.0.1:8899 --scenario failing-check
   ```

   Verified totals: `{squashes:2, earlyCutoffs:4, retired:3}` in ~23 s.
   Disclosure: the mock is a local stand-in — bare git repos, poll-based
   push detection, regex hashing, and a `-X theirs` merge instead of real
   retirement (`app/demo/NOTES.md`). It demonstrates the protocol, not the
   platform.

3. **Degraded live** — if the queue subscription lags, the DO alarm poll
   (~3 s cadence) still detects pushes; point at the event arriving via the
   poll instead. If the dashboard WebSocket drops, it falls back to polling
   `/api/state` every 1 s automatically (`app/dashboard/NOTES.md`).

## Shot checklist

- [ ] Cold open lands SQUASH inside the first 20 s
- [ ] `forwarded:` arrows and interface hash visible before the squash
- [ ] Early-cutoff counter visibly ticks on the refactor push
- [ ] Diagnosis block readable (old vs new signature)
- [ ] e1 → e2 → e3 retire into the trunk chip in order
- [ ] `robSize` config + veto shown as the two human controls
- [ ] Real-vs-scripted slide and measured-numbers table on screen
- [ ] "Built using Cloudflare Workers and Artifacts" line said out loud
