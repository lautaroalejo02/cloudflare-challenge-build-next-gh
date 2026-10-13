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
> work, against this forwarded interface hash. Then — about eleven seconds
> after its refactor push — the API agent changes the signature. Watch:
> SQUASH. Both dependents re-fork
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
> Retirement checks run inside a Dynamic Worker, and the git fast-forward
> or splice is isomorphic-git inside a Worker. This dashboard is the same
> Worker's static assets, fed by one WebSocket."

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

Expected duration: **~38 s wall** for the main scenario; **43.8 s (46.4 s
incl. agent startup)** for `--scenario failing-check` — both measured live
2026-10-13 (`app/control-plane/NOTES.md`, "Live E2E results"). The mock
takes ~23 s (`app/demo/NOTES.md`). Beat timings below follow the live
failing-check timeline in `app/control-plane/NOTES.md` — the only per-beat
recorded run; the main scenario is the same sequence minus the
failed-check/fix beats. For the fuller story on camera (a check that fails
and blocks retirement, then a splice instead of a fast-forward), run
`npm run demo -- --base <url> --scenario failing-check`.

[STAGE] Do not lean on the dashboard's "squash after push" stat: live, the
squash is emitted in the same poll tick as the push detection, so it reads
~0 ms (`app/control-plane/NOTES.md`, `app/dashboard/NOTES.md`). Use the
event log timestamps instead.

Narrate through the beats; each maps to a visible dashboard change:

1. **t≈+4–13 s — fixture, then entries created.** "The fixture lands on
   `arb-trunk`, then three entries appear amber — speculating, registered a
   few seconds apart. Note the arrows: UI and Tests forked the API entry's
   fork, carrying `createOrder`'s interface hash. That hash is their
   speculative operand."
   (Live timeline: fixture push +4.1 s; e1 `api` +6.5 s, e2 `ui` +11.0 s,
   e3 `tests` +12.9 s.)
   [POINT AT] lane rows, orthogonal forwarded-hash connectors from the api
   row to the ui/tests rows, entry cards showing `arb-e<seq>-<lane>-0`
   repos.

2. **t≈+14–17 s — the early cutoff.** "The agents push their first work —
   the API push is a refactor: extracted a helper, identical interface.
   Watch the stats bar: `hash.unchanged`, early-cutoff counter ticks to 2.
   No squash, no wakeups. A push that doesn't change an interface costs
   almost nothing."
   (Live timeline: pushes at +13.8/+14.9/+16.2 s; `earlyCutoffs 0 → 2` at
   +17.1 s.)
   [POINT AT] stats counters (`earlyCutoffs`), event log entry.

3. **t≈+26–31 s — the mispredict.** "Now the breaking change: `createOrder`
   takes an options object. About 1.7 s after the push lands — one poll
   tick — the interface hash flips: SQUASH on both dependents. Each
   diagnosis shows the old and new signature, per symbol. Generation bumps,
   new `…-1` forks are minted — ~2–4.5 s — and each agent re-clones and
   adapts against the new signature."
   (Live timeline: breaking push +26.1 s; e2/e3 `ready → squashed` +29.1 s;
   e2 re-clone +31.8 s, v2 push +34.4 s; e3 v2 push +37.1 s.)
   [POINT AT] red flash, diagnosis block (`−` old signature / `+` new
   signature), generation counter, refork arrows to the new repo names.

4. **t≈+30–46 s — checks and in-order retirement.** "Agents mark ready;
   each head entry's tests run inside a Dynamic Worker — violet checking,
   ~90–190 ms each. Then in-order retirement: e1 slides into the trunk chip
   as a fast-forward — 507 ms — then e2, 518 ms."
   (Live timeline: e1 check +30.0 s → retired `mode=fast-forward` +30.8 s;
   e2 retired +38.8 s.)
   [POINT AT] status color transitions (amber → violet → blue → green),
   the FLIP animation into the trunk chip, the `fast-forward` mode badge
   inside the retired chip, `stats` line, trunk `commit`.

5. **[failing-check only] t≈+41–46 s — failed check, then splice.**
   "The Tests agent's re-push carried a failing feature test — the check
   ran, failed in 187 ms, and blocked retirement. The scripted fix pushed,
   re-check passed in 179 ms. But trunk has moved on disjoint paths since
   e3 forked — so no fast-forward. The retirer overlays e3's changed test
   paths onto the trunk tree, pushes the candidate, re-checks it (90 ms),
   and moves `main`: a 1085 ms splice. The new trunk head's commit message
   reads `arb: splice <entry head> onto <trunk head>` — in the recorded run,
   `a65620fe` = `arb: splice 7c42bc81 onto f4a406a3`."
   (Live timeline: `checking → failed` +41.3 s; fix detected +43.7 s;
   re-check pass +44.6 s; splice candidate checked; retired `mode=splice`
   +45.3 s; all retired in order +46.4 s.)
   [POINT AT] red `failed` state, then the violet splice-candidate check,
   e3's trunk chip showing the `splice` mode badge, final stats
   (`squashes:2, earlyCutoffs:2, retired:3, checksRun:5, pushesSeen:7`).

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
> the Durable Object, the Dynamic-Worker checks, the fast-forward and splice
> retirement.
> Scripted: the agents. There's no LLM — a squash adaptation is a regex
> picking between two pre-written variants.
>
> Numbers, all measured on the real platform. A push reaches the squash
> decision in ~1.7 s — queue event or the ~3 s Durable-Object poll,
> whichever lands first. A re-fork costs 2–4.5 s. Interface hashing is
> ~30 ms of CPU inside the Worker. A Dynamic-Worker check is 90–190 ms.
> Retirement is a ~0.5 s fast-forward, or ~1.1 s when it has to splice
> disjoint paths. The whole three-agent scenario runs in about 38 seconds —
> 46 with the failed-check beat. And one more honest caveat: 'scales to a
> fleet of agents' is a design argument — one reorder-buffer DO per
> connected component — not a measurement; the largest real run had three
> entries."

[STAGE] All figures above are from the 2026-10-13 live runs recorded in
`app/control-plane/NOTES.md` ("Live E2E results", from `GET /api/events`)
and the `spikes/`/`app/*/NOTES.md` files. If you re-record against a fresh
deployment, re-run the demo and pull fresh timings from `/api/events` —
never improvise one.

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
   ~25 s (`app/dashboard/NOTES.md`), including a `check.failed` → fix-push →
   `check.passed` → retired
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
- [ ] e1 → e2 → e3 retire into the trunk chip in order, mode badges visible
  (`fast-forward`; `splice` on e3 in the failing-check run)
- [ ] `robSize` config + veto shown as the two human controls
- [ ] Real-vs-scripted slide and measured-numbers table on screen
- [ ] "Built using Cloudflare Workers and Artifacts" line said out loud
