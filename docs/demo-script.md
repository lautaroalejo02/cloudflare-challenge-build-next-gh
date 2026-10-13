# Demo video script — Agent Reorder Buffer

Target length: ~6:30 (range 5–8 min). Screen record at 1080p+, terminal font
large. Two panes side by side: terminal (left), dashboard (right).
Narration lines are in quotes; [STAGE] directions are not read aloud.

Pre-flight (before recording):

```sh
cd app/control-plane && npm install && scripts/setup.sh   # queue + subscription + deploy
# once per deploy: create the admin key (gitignored) and set it as a Worker secret
node -e "require('fs').writeFileSync('.secret-admin-key', require('crypto').randomBytes(32).toString('base64url'))"
npx wrangler secret put ARB_ADMIN_KEY < .secret-admin-key
cd ../demo && npm install
```

Dashboard URL (public, read-only for viewers):
`https://arb-control-plane.<your-subdomain>.workers.dev/`

Presenter-only URL with the admin controls:
`https://arb-control-plane.<your-subdomain>.workers.dev/?key=<ADMIN_KEY>`.
Never put the real key in a slide, a recording or this repo; the demo CLI
reads it from `ARB_ADMIN_KEY` or `app/control-plane/.secret-admin-key` on its
own (`app/demo/src/lib/admin-key.ts`). Before recording, check that the
key does not show in the browser address bar or history on camera.

---

## 0:00–0:20 — Cold open: the wow scene

[STAGE] Open the dashboard mid-run — play the mock replay
(`app/dashboard/mock.html`, click `↺ replay`) or cut to recorded live footage.
Narrate over it; do not explain yet.

> "Three coding agents: API, UI, and Tests. Before the API agent wrote a
> single line, it declared this stub — its promised interface. The UI and
> Tests agents forked the unfinished work anyway, against those predicted
> hashes. Now the first real push lands — watch the counter: `stub
> predictions`, two hits, one miss. `createOrder` arrived exactly as
> declared — hit. `Order` grew a field nobody declared — miss: instant
> squash, re-fork, predicted-versus-actual diff. A body-only refactor later
> wakes nobody. Then the breaking change squashes both dependents — and the
> buffer retires API, UI, Tests, in order, onto main. That's a CPU reorder
> buffer — with value prediction — running on a repository."

[POINT AT] the stats-bar `stub predictions` counter, the dashed `≈` markers
on the producer's predicted exports, `≈ stub` on the consumers' forwarded
tags, the `✓ hit` / `✗ miss` ticks, then the red SQUASH flash, then the rows
turning green into the trunk chip in order.

[SHOT REFERENCES] `app/dashboard/screenshots/live-predicted.png` (predicted
exports marked `≈`, consumers `≈ stub`), `live-prediction.png` (verdict
moment: counter at "1 hit / 1 miss", `✓`/`✗` ticks, PREDICTION HIT/MISS log
lines), `live-squash.png` (squash with diagnosis), `live-final.png` (all
three retired).

## 0:20–1:05 — The problem

> "'UI waits for the API PR' is the main serialization point between
> parallel agents. Merge queues and stacked PRs work at merge time — they
> serialize *finished* work, and a clean textual merge can still hide a
> breaking interface change. The Agent Reorder Buffer moves integration to
> dispatch time. Consumers start immediately on the producer's in-progress
> fork — operand forwarding — or even earlier, on a declared stub: value
> prediction, scored by that hit/miss counter you just saw. If a forwarded
> interface hash changes, only the dependents that consumed it are squashed
> and re-forked. Body-only pushes wake nobody. And retirement is a
> fast-forward or a path-disjoint splice — never a textual merge."

## 1:05–1:50 — Architecture on Cloudflare

[STAGE] Show `README.md` rendered (the Mermaid diagram), or
`docs/architecture.md`. One sentence per primitive, pointing at the diagram:

> "Everything you just saw runs on Cloudflare primitives. Artifacts gives
> each buffer entry its own repo — fork-of-fork is the forwarding path.
> `repo.pushed` events stream through a Queue into the control-plane Worker.
> One Durable Object per connected component is the reorder buffer: it
> rehashes exported interfaces with tree-sitter WASM, decides squashes, and
> retires in order — serialized onto the trunk by a dedicated DO.
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

Under the T19 review fixes the same scenarios were re-run live (2026-10-13):
main 60 s, failing-check 66 s, multi 65–81 s over 3 runs, `recover` 0 and
`retire.failed` 0 (`app/control-plane/NOTES.md`, "Review fixes (T19)" → "Live
verification"). The beat timings below come from the earlier T11 run.

Expected duration: **~52 s wall** for the main scenario and **~50 s** for
`--scenario failing-check` — measured live 2026-10-13 with declared stubs
(`app/control-plane/NOTES.md`, "Value prediction (T11)" → "Live"; a
screenshot re-run took ~47 s). The mock takes ~23 s (`app/demo/NOTES.md`).
Beat timings below follow the T11 main-run timeline in
`app/control-plane/NOTES.md`; the failing-check scenario takes the same path
plus the failed-check/fix beats (its per-beat timeline below is from the
earlier recorded run — re-pull from `GET /api/events` when re-recording).
For the fuller story on camera (a check that fails and blocks retirement,
then a splice instead of a fast-forward), run
`npm run demo -- --base <url> --scenario failing-check`. A third scenario,
`--scenario multi`, runs two independent chains (orders `api→ui+tests`,
payments `api→ui`) in separate component DOs retiring onto the shared trunk —
~63–77 s measured live under atomic retirement (`app/control-plane/NOTES.md`,
"Trunk race fix (T17)") — useful B-roll for the sharding story.

[STAGE] Do not lean on the dashboard's "squash after push" stat: live, the
squash is emitted in the same poll tick as the push detection, so it reads
~0 ms (`app/control-plane/NOTES.md`, `app/dashboard/NOTES.md`). Use the
event log timestamps instead.

[STAGE] The recorded T11 runs show `earlyCutoffs: 0` — the first real push
that resolves predictions also carries the refactor, so no separate
body-only beat fired. T15 restores a distinct body-only push between the
verdicts and the breaking change; verify `stats.earlyCutoffs` ticks before
recording beat 3, and if it doesn't, skip the beat and keep narrating.

Narrate through the beats; each maps to a visible dashboard change:

1. **t≈+4–16 s — fixture, stub declaration, entries created.** "The fixture
   lands on `arb-trunk`. The API agent registers — and commits to a declared
   stub before writing anything: see the dashed `≈` markers on its exports.
   UI and Tests register seconds later while the prediction is still
   unconfirmed — `≈ stub` on their forwarded tags. They are building on a
   promise, not on code."
   (Live timeline: api registers with stub +10.5 s; consumers +14.5 /
   +15.7 s — ui pins `createOrder` + `Order`, tests pins `createOrder`.)
   [POINT AT] lane rows, `≈` dashed markers on e1's exports, `≈ stub` on
   e2/e3's forwarded tags, entry cards showing `arb-e<seq>-<lane>-0` repos.
   [SHOT] `app/dashboard/screenshots/live-predicted.png`.

2. **t≈+22–27 s — the hit/miss verdict.** "The producer's first real push
   lands — and the counter settles it. `createOrder` shipped exactly as
   declared: `prediction.hit`, hit counter ticks, both consumers keep
   running. But `Order` grew a `currency` field the stub never declared:
   `prediction.miss`, the consumer that pinned `Order` is squashed
   `prediction-miss` — re-forked with a predicted-vs-actual diagnosis —
   while the other never noticed."
   (Live timeline: first api push +21.8 s; verdicts + squash detected
   +24.3 s in one poll tick — e2 hit `createOrder` + missed `Order`, e3 hit
   `createOrder`; e2 re-forked gen 1 +26.1 s. Final counter: 2 hit / 1
   miss.)
   [POINT AT] the `stub predictions` counter ticking, `✓ hit` / `✗ miss`
   tags, PREDICTION HIT/MISS lines in the event log, e2's
   `prediction-miss` diagnosis showing declared vs actual `Order`.
   [SHOT] `app/dashboard/screenshots/live-prediction.png`.

3. **the early cutoff.** "A body-only push — the API refactor extracts a
   helper, identical exported interface. Watch the stats bar:
   `hash.unchanged`, `earlyCutoffs` ticks. No squash, no wakeups. A push
   that doesn't change an interface costs almost nothing."
   (Recorded T11 runs show `earlyCutoffs: 0`; T15 restores this beat — see
   the STAGE note above. In the pre-T11 recorded run `earlyCutoffs` ticked
   0 → 2 on the refactor push.)
   [POINT AT] stats counters (`earlyCutoffs`), event log entry.

4. **t≈+35–37 s — the breaking-change squash.** "Now the real breaking
   change: `createOrder` takes an options object. Within one poll tick the
   interface hash flips: SQUASH on both dependents — ordinary
   `interface-changed` this time. Each diagnosis shows old and new
   signatures per symbol; generation bumps; new `…-1` forks are minted;
   each agent re-clones and adapts."
   (Live timeline: breaking push +35.0 s; ordinary squashes +36.9 s. Total
   squashes on the run: 3 — e2 `prediction-miss`, then e2 + e3
   `interface-changed`.)
   [POINT AT] red flash, diagnosis block (`−` old signature / `+` new
   signature), generation counter, refork arrows to the new repo names.
   [SHOT] `app/dashboard/screenshots/live-squash.png`.

5. **t≈+38–52 s — checks and in-order retirement.** "Agents mark ready;
   each head entry's tests run inside a Dynamic Worker — violet checking,
   ~90–190 ms each. Then in-order retirement: the entries slide into the
   trunk chip e1, e2, e3 — fast-forward when trunk hasn't diverged, splice
   when it has."
   (Live timeline: all three retired in order by +51.6 s; ~52 s wall. In
   the recorded T8 run e1/e2 retired `mode=fast-forward` at 507 / 518 ms.)
   [POINT AT] status color transitions (amber → violet → blue → green),
   the FLIP animation into the trunk chip, mode badges inside the retired
   chips, final `stats` line, trunk `commit`.
   [SHOT] `app/dashboard/screenshots/live-check.png` (check running),
   `live-final.png` (all retired — note the `stub predictions: 2 hit / 1
   miss` counter in the final stats bar).

6. **[failing-check only] t≈+40–50 s — failed check, then splice.**
   "The Tests agent's re-push carried a failing feature test — the check
   ran, failed, and blocked retirement. The scripted fix pushed, re-check
   passed. But trunk has moved on disjoint paths since e3 forked — so no
   fast-forward. The retirer overlays e3's changed test paths onto the
   trunk tree, pushes the candidate, re-checks it, and moves `main`: a
   ~1.1 s splice. The new trunk head's commit message reads
   `arb: splice <entry head> onto <trunk head>`."
   (Recorded T8-era beats: `checking → failed` +41.3 s (187 ms check); fix
   detected +43.7 s; re-check pass +44.6 s (179 ms); splice candidate
   checked 90 ms; retired `mode=splice` +45.3 s (1085 ms total),
   `a65620fe` = `arb: splice 7c42bc81 onto f4a406a3`. Under T11 the same
   beats land inside a ~50 s run with `checksRun: 5` — re-pull exact times
   from `/api/events`.)
   [POINT AT] red `failed` state, then the violet splice-candidate check,
   e3's trunk chip showing the `splice` mode badge, final stats.

## 5:00–5:50 — The human's two decisions

> "The human decides exactly two things. One: speculation depth — the
> buffer size."

[STAGE] These controls are admin-only. Reload the dashboard in the
presenter window with `?key=<ADMIN_KEY>` (placeholder — paste the real key
off-camera, e.g. `https://arb-control-plane.<your-subdomain>.workers.dev/?key=<ADMIN_KEY>`).
Only then do the robSize slider and the VETO button render; the public URL
shows neither. Say on camera: "the public dashboard is read-only for
viewers; the controls need the admin key." Or, from the terminal, send the
key as a header (shell variable, never typed literally):

```sh
curl -X POST <base>/api/config -H 'content-type: application/json' \
  -H "x-arb-key: $ARB_ADMIN_KEY" -d '{"robSize":4}'
```

> "Two: veto — on the head entry only."

[STAGE] Click the VETO button on the head entry (visible only with `?key=`),
or:

```sh
curl -X POST <base>/api/entries/<head-id>/veto -H "x-arb-key: $ARB_ADMIN_KEY"
```

Without the header the request returns `403`, a good aside if asked about
the public URL. Veto is also refused with `409` while that entry is
mid-retire (`app/control-plane/NOTES.md`, "Review fixes (T19)").

> "A veto squashes exactly that entry's transitive dependents — highlighted
> before it lands — and they re-fork from the vetoed entry's own base, so
> they can still retire."

## 5:50–6:30 — What's real, what's scripted, measured numbers

> "Honesty slide. Real: every Cloudflare primitive — the forks, the events,
> the Durable Object, the declared-stub value prediction, the Dynamic-Worker
> checks, the fast-forward and splice retirement.
> Scripted: the agents. There's no LLM — a squash adaptation is a regex
> picking between two pre-written variants.
>
> Numbers, all measured on the real platform. A push reaches the squash
> decision in ~1.7 s — queue event or the ~3 s Durable-Object poll,
> whichever lands first. A re-fork costs 2–4.5 s. Interface hashing is
> ~30 ms of CPU inside the Worker. A Dynamic-Worker check is 90–190 ms.
> Retirement is a ~0.5 s fast-forward, or ~1.1 s when it has to splice
> disjoint paths. The whole three-agent scenario runs in about 52 seconds
> with declared stubs — the prediction counter read 2 hits, 1 miss live.
> And two honest caveats on scale: the state-machine benchmark measured the
> single buffer's per-event cost rising to ~16 ms at 100,000 entries —
> whole-list scans — while per-component buffers stayed flat. That fix is
> deployed: one reorder-buffer Durable Object per connected component, with
> trunk retirement serialized atomically on a dedicated DO — verified live
> by the multi scenario. What's still unmeasured is real multi-DO latency,
> cross-component dependencies and Durable Object storage limits."

[STAGE] All figures above are from the 2026-10-13 live runs recorded in
`app/control-plane/NOTES.md` ("Live E2E results" and "Value prediction
(T11)" → "Live", from `GET /api/events`), the scale figures from
`app/control-plane/bench/RESULTS.md`, and the `spikes/`/`app/*/NOTES.md`
files. If you re-record against a fresh
deployment, re-run the demo and pull fresh timings from `/api/events` —
never improvise one.

## 6:30–6:45 — Close

> "Cost scales with the edges of the in-flight dependency graph, not the
> number of agents — the benchmark confirmed a push squashes exactly its
> transitive dependents, zero escapes in 3,803 pushes. That scaling design
> is already live: one reorder-buffer Durable Object per connected
> component. Next: per-entry-key Durable Object persistence and a grace
> period for breaking changes with readers outside the buffer.
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
   platform. `--scenario multi` is live-only: the runner verifies component
   isolation via `GET /api/events`, which the mock does not implement.

3. **Degraded live** — if the queue subscription lags, the DO alarm poll
   (~3 s cadence) still detects pushes; point at the event arriving via the
   poll instead. If the dashboard WebSocket drops, it falls back to polling
   `/api/state` every 1 s automatically (`app/dashboard/NOTES.md`).

## Shot checklist

- [ ] Cold open lands the `stub predictions` hit/miss verdict inside the
  first 20 s
- [ ] `≈` dashed markers on predicted exports and `≈ stub` forwarded tags
  visible before the first push (shot ref: `live-predicted.png`)
- [ ] `stub predictions` counter ticks; `✓ hit` / `✗ miss` tags and
  `prediction-miss` diagnosis readable (shot ref: `live-prediction.png`)
- [ ] Early-cutoff counter visibly ticks on the refactor push (verify it
  fires — see the T15 STAGE note)
- [ ] Diagnosis block readable (old vs new signature; predicted vs actual
  on the miss)
- [ ] Ordinary `interface-changed` SQUASH on both dependents (shot ref:
  `live-squash.png`)
- [ ] e1 → e2 → e3 retire into the trunk chip in order, mode badges visible
  (`fast-forward`; `splice` on e3 in the failing-check run; shot refs:
  `live-check.png`, `live-final.png`)
- [ ] `robSize` config + veto shown as the two human controls, dashboard
  opened with `?key=<ADMIN_KEY>` (placeholder only; real key never on screen)
- [ ] Real-vs-scripted slide and measured-numbers table on screen
- [ ] "Built using Cloudflare Workers and Artifacts" line said out loud
