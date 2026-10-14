# Demo video script — Agent Reorder Buffer

Target length: ~7:00 (range 5–8 min; the optional MCP scene is the flex).
Screen record at 1080p+, terminal font large. Two panes side by side:
terminal (left), dashboard (right).
Narration lines are in quotes; [STAGE] directions are not read aloud.

Pre-flight (before recording):

```sh
cd app/control-plane && npm install && scripts/setup.sh   # queue + subscription + deploy
# once per deploy: create the admin key (gitignored) and set it as a Worker secret
node -e "require('fs').writeFileSync('.secret-admin-key', require('crypto').randomBytes(32).toString('base64url'))"
npx wrangler secret put ARB_ADMIN_KEY < .secret-admin-key
# needed for the Jev beats: pipe the TypeSafe key from the gitignored file — never argv
npx wrangler secret put TYPESAFE_API_KEY < .secret-typesafe-key
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
> Tests agents forked the unfinished work anyway — UI without even
> declaring what it consumes; the buffer infers that from its imports. Now
> the first real push lands — `createOrder` arrived exactly as declared:
> prediction hit. A body-only refactor later wakes nobody — Jev, a
> semantic judge, scores it 0.02 and clears it. But the next push keeps the
> same signature and changes the behavior — VAT inside the totals — and
> Jev scores it ~0.95: both dependents squashed for a change no interface
> diff could catch. Then the breaking change squashes them again — and
> the buffer retires API, UI, Tests, in order, onto main. That's a CPU
> reorder buffer — with value prediction — running on a repository."

[POINT AT] the `deps.inferred` line on the UI entry, the stats-bar `stub
predictions` counter and `≈`/`✓` markers, the `jev.judged` lines in the
event log, the `behavior-changed` SQUASH with its judged probability, then
the rows turning green into the trunk chip in order.

[SHOT REFERENCES] `app/dashboard/screenshots/live-predicted.png` (predicted
exports marked `≈`), `v2-inferred-1920x1080.png` (inferred consumes),
`v2-judging-1920x1080.png` (`jev.judged` beat),
`v2-behavior-changed-1920x1080.png` (semantic squash with diagnosis),
`live-squash.png` (interface-changed squash), `live-final.png` (all
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
> retires in order — serialized onto the trunk by a dedicated DO. In v2 the
> same pass also infers each entry's dependencies from its imports, and a
> third-party judge — TypeSafe Jev — scores body-only changes for the
> consumers that rely on them. Retirement checks run inside a Dynamic
> Worker, and the git fast-forward or splice is isomorphic-git inside a
> Worker. This dashboard is the same Worker's static assets, fed by one
> WebSocket — and any MCP-capable agent can join through the bundled stdio
> server, no git plumbing required."

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

## 2:20–5:20 — The live run

[STAGE] Terminal left, dashboard right. Run:

```sh
cd app/demo
npm run demo -- --base https://arb-control-plane.<your-subdomain>.workers.dev
```

Expected duration: **~90–100 s wall** for the main scenario under v2 —
five live runs on 2026-10-13 measured 88.6–102 s; the Jev round trips and
the semantic re-fork added ~40 s vs the pre-v2 run. `--scenario
failing-check` measured 92.7–97 s, `--scenario multi` 77.5–79 s
(`app/control-plane/NOTES.md`, "V2 integration (V4)" and "V8 inference
scope"). The mock takes ~70–80 s (re-run 2026-10-13) but runs neither
inference nor Jev — the semantic beats degrade to v1 behavior there. Beat
timings below are estimates anchored on the recorded walls and the
scripted gaps (VAT push 14 s after the refactor, breaking push 16 s after
the VAT change — V4) —
**re-pull exact times from `GET /api/events` when recording**. For the
fuller story on camera (a check that fails and blocks retirement, then a
splice instead of a fast-forward), run
`npm run demo -- --base <url> --scenario failing-check`. `--scenario multi`
runs two independent chains (orders `api→ui+tests`, payments `api→ui`) in
separate component DOs retiring onto the shared trunk — useful B-roll for
the sharding story; its consumers are declared (no inference beat) and it
still shows `predictionHits 2 / misses 1`.

[STAGE] Do not lean on the dashboard's "squash after push" stat: live, the
squash is emitted in the same poll tick as the push detection, so it reads
~0 ms (`app/control-plane/NOTES.md`, `app/dashboard/NOTES.md`). Use the
event log timestamps instead. Jev verdicts land asynchronously ~1–2 s
after the push (a `jev.judged` line per consumer-symbol), not in the push
tick.

[STAGE] In v2 the early-cutoff beat is confirmed live: every main run
recorded `earlyCutoffs: 5` (`app/control-plane/NOTES.md`, "V8 inference
scope"). Verify `stats.earlyCutoffs` ticks before recording beat 3, and if
it doesn't, skip the beat and keep narrating.

Narrate through the beats; each maps to a visible dashboard change:

1. **t≈+4–16 s — fixture, stub declaration, entries created.** "The fixture
   lands on `arb-trunk`. The API agent registers — and commits to a declared
   stub before writing anything: see the dashed `≈` markers on its exports.
   UI and Tests register seconds later — and the UI registers with *no*
   `consumes` at all. It forked the producer's unfinished fork anyway; the
   buffer will work out what it depends on from its own imports."
   (In v2 the UI entry registers with `consumes` omitted —
   `consumesInferred: true`; only the tests entry declares and pins
   `createOrder`. Live: `deps.inferred` reported the UI consuming
   `createOrder` + `Cart` — `app/control-plane/NOTES.md`, "V8 inference
   scope".)
   [POINT AT] lane rows, `≈` dashed markers on e1's exports, the UI entry's
   inferred-consumes tags, entry cards showing `arb-e<seq>-<lane>-0` repos.
   [SHOT] `app/dashboard/screenshots/live-predicted.png`,
   `v2-inferred-1920x1080.png`.

2. **t≈+20–30 s — the hit/miss verdict, now mostly a hit.** "The
   producer's first real push lands — and the counter settles the declared
   intent. The tests agent pinned `createOrder` against the stub:
   `prediction.hit`, it keeps running. The UI agent never declared
   anything — its `deps.inferred` map came from its own imports — so there
   is nothing to miss. (The miss beat lives in `--scenario multi` now: a
   declared consumer that pinned `Order` gets `prediction.miss` and a
   squash when the real push diverges from the stub.)"
   (V2 main runs: `predictionHits 1 / misses 0` — the inferred UI entry
   has no stub pins. Multi: 2 / 1. Live v2 walls ~90–100 s —
   `app/control-plane/NOTES.md`, "V2 integration (V4)".)
   [POINT AT] the `deps.inferred` event line naming the UI's inferred
   symbols (`createOrder`, `Cart`), the `stub predictions` counter,
   `✓ hit` tick on the tests entry.
   [SHOT] `app/dashboard/screenshots/v2-inferred-1920x1080.png`.

3. **t≈+35–40 s — the refactor: early cutoff AND a Jev clear.** "A
   body-only push — the API refactor extracts a helper, identical exported
   interface. Two things fire: `hash.unchanged`, `earlyCutoffs` ticks —
   and because a *consumed* symbol's body hash moved, the buffer asks Jev
   anyway. `jev.judged`: p = 0.02 — clear. No squash, no wakeups. A push
   that changes neither the interface nor observable behavior costs almost
   nothing."
   (Live: refactor judged `0.02 clear` for both consumers in every run —
   `app/control-plane/NOTES.md`, "V8 inference scope".)
   [POINT AT] stats counters (`earlyCutoffs`, `judgments`), the
   `jev.judged` line with `clear`.
   [SHOT] `app/dashboard/screenshots/v2-judging-1920x1080.png`.

4. **t≈+49–56 s — the Jev beat: same signature, behavior changed.** "Now
   the push v1 could never catch: still the same `createOrder` signature,
   but the body now returns VAT-inclusive totals. The interface hash does
   not move — another early cutoff — but the body hash did, and this time
   Jev answers p ≈ 0.95: `behavior-changed`. Both consumers are squashed
   for a *semantic* change no signature diff could see — each diagnosis
   carries the judge's probability and model. They re-fork, sniff the new
   VAT math, and redo their work."
   (Live: VAT judged `0.93–0.97 squash` for both consumers in every run
   with the beat; Jev round trip ~1–2 s — `app/control-plane/NOTES.md`,
   "V2 integration (V4)" and "V8 inference scope".)
   [POINT AT] `jev.judged` lines showing `squash` + the probability, the
   red SQUASH with reason `behavior-changed`, the diagnosis block showing
   `judgment {model, probability}` and *equal* old/new signatures, the
   `semanticSquashes` counter, refork arrows.
   [SHOT] `app/dashboard/screenshots/v2-behavior-changed-1920x1080.png`.

5. **t≈+65–70 s — the breaking-change squash.** "Now the classic breaking
   change: `createOrder` takes an options object. Within one poll tick the
   interface hash flips: SQUASH on both dependents — ordinary
   `interface-changed` this time. Each diagnosis shows old and new
   signatures per symbol; generation bumps; new `…-1` forks are minted;
   each agent re-clones and adapts."
   (Estimated from the scripted 16 s gap after the VAT push — re-pull from
   `/api/events`. Total squashes per main run: 4 — 2 `behavior-changed` +
   2 `interface-changed`.)
   [POINT AT] red flash, diagnosis block (`−` old signature / `+` new
   signature), generation counter, refork arrows to the new repo names.
   [SHOT] `app/dashboard/screenshots/live-squash.png`.

6. **t≈+70–98 s — checks and in-order retirement.** "Agents mark ready;
   each head entry's tests run inside a Dynamic Worker — violet checking,
   ~90–190 ms each. Then in-order retirement: the entries slide into the
   trunk chip e1, e2, e3 — fast-forward when trunk hasn't diverged, splice
   when it has."
   (Live: all three retired in order; main walls 88.6–102 s. In the
   recorded T8 run e1/e2 retired `mode=fast-forward` at 507 / 518 ms.)
   [POINT AT] status color transitions (amber → violet → blue → green),
   the FLIP animation into the trunk chip, mode badges inside the retired
   chips, the final `stats` line — `judgments 5`, `semanticSquashes 2`,
   `inferredDeps 2`, `predictionHits 1 / misses 0` — trunk `commit`.
   [SHOT] `app/dashboard/screenshots/live-check.png` (check running),
   `live-final.png` (all retired).

7. **[failing-check only] — failed check, then splice.**
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
   `a65620fe` = `arb: splice 7c42bc81 onto f4a406a3`. In v2 the same beats
   land inside a 92.7–97 s run with `checksRun: 5` — re-pull exact times
   from `/api/events`.)
   [POINT AT] red `failed` state, then the violet splice-candidate check,
   e3's trunk chip showing the `splice` mode badge, final stats.

## 5:20–6:00 — [OPTIONAL] MCP scene: a real agent joins

[STAGE] 30–45 s, only if recorded — skip cleanly if it is not (the
architecture beat already names the MCP server). Record a real MCP-capable
agent (Claude Code) with the arb server registered:
`claude mcp add arb -e ARB_BASE_URL=<base> -- node --experimental-strip-types --disable-warning=ExperimentalWarning <REPO>/app/mcp/src/index.ts`
(`app/mcp/README.md`). Capture the agent calling `arb_register`, getting an
`entryId` + workspace, then its lane appearing on the live dashboard.

> "That was scripted agents. This is not — a real coding agent, talking to
> the buffer over MCP. `arb_register` created its entry and cloned its
> fork into a managed workspace — watch the new lane appear on the
> dashboard. `arb_push` commits and pushes with a per-push token the agent
> never sees. Six tools, zero git plumbing — and when the producer's push
> squashes it, `arb_status` hands it the diagnosis and `arb_sync` re-clones
> the new base."

[POINT AT] the new lane row appearing in the dashboard, the agent's
`arb_register`/`arb_push` tool calls, the entry's `push` line in the event
log.

## 6:00–6:35 — The human's two decisions

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

## 6:35–7:15 — What's real, what's scripted, measured numbers

> "Honesty slide. Real: every Cloudflare primitive — the forks, the events,
> the Durable Object, the declared-stub value prediction, the dependency
> inference, the Dynamic-Worker checks, the fast-forward and splice
> retirement — and the Jev calls: a real third-party API, TypeSafe.
> Scripted: the demo agents. A squash adaptation is a regex picking between
> two pre-written variants.
>
> Numbers, all measured on the real platform. A push reaches the squash
> decision in ~1.7 s — queue event or the ~3 s Durable-Object poll,
> whichever lands first. A re-fork costs 2–4.5 s. Interface hashing is
> ~30 ms of CPU inside the Worker. A Dynamic-Worker check is 90–190 ms.
> Retirement is a ~0.5 s fast-forward, or ~1.1 s when it has to splice
> disjoint paths. Jev answers in about 1–2 s per judgment, and the
> dependency inference costs ~134 ms median on the push path. The judge
> was consistent: 0.02 on the refactor, ~0.95 on the behavior change,
> every run. The whole three-agent scenario runs in about 90–100 seconds
> — the prediction counter read 1 hit, 0 misses on main, since the UI's
> dependencies are inferred now; multi's declared consumers still show
> 2 hits, 1 miss.
>
> Honest limits: no `TYPESAFE_API_KEY`, no Jev — the buffer falls back to
> v1 behavior. The hasher is TypeScript-only. Undeclared cross-entry
> dependencies are reported, not re-forked. And on scale: the state-machine
> benchmark measured the single buffer's per-event cost rising to ~16 ms
> at 100,000 entries before index maps; the current v2 machine measures
> ~19 µs median at the same size on the same machine. What's still
> unmeasured is real multi-DO latency, cross-component dependencies and
> Durable Object storage limits."

[STAGE] All figures above are from the 2026-10-13 live runs recorded in
`app/control-plane/NOTES.md` ("Live E2E results", "Value prediction (T11)"
→ "Live", "V2 integration (V4)", "V8 inference scope" — from `GET
/api/events`), the scale figures from `app/control-plane/bench/RESULTS.md`,
and the `spikes/`/`app/*/NOTES.md` files. If you re-record against a fresh
deployment, re-run the demo and pull fresh timings from `/api/events` —
never improvise one.

## 7:15–7:30 — Close

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
   beat the main scenario doesn't show — the v2 events (`deps.inferred`,
   `jev.judged`) replay from canned data. `index.html?mock=1` works too.
   Say on camera: "this is the dashboard's event replay — the UI is real,
   the events are canned."

2. **Fully local run** — real agents, real scenario, no Cloudflare:

   ```sh
   cd app/demo
   npm run mock -- --port 8899 --root tmp-mock/live   # terminal 1
   npm run demo -- --base http://127.0.0.1:8899        # terminal 2
   npm run demo -- --base http://127.0.0.1:8899 --scenario failing-check
   ```

   Verified totals (re-run 2026-10-13): main `{squashes:1, earlyCutoffs:5,
   retired:3}` in ~80 s; failing-check `{squashes:1, earlyCutoffs:6,
   retired:3, checksRun:5}` in ~68 s — `judgments: 0`, `inferredDeps: 0`
   in both. Disclosure: the mock is a local stand-in — bare git repos,
   poll-based push detection, regex hashing, and a `-X theirs` merge
   instead of real retirement (`app/demo/NOTES.md`). It demonstrates the
   protocol, not the platform — and it runs neither inference nor Jev, so
   the semantic beats degrade to plain v1 behavior. `--scenario multi` is
   live-only: the runner verifies component isolation via `GET
   /api/events`, which the mock does not implement.

3. **Degraded live** — if the queue subscription lags, the DO alarm poll
   (~3 s cadence) still detects pushes; point at the event arriving via the
   poll instead. If the dashboard WebSocket drops, it falls back to polling
   `/api/state` every 1 s automatically (`app/dashboard/NOTES.md`).

## Shot checklist

- [ ] Cold open lands the inference + Jev beats inside the first 20 s
- [ ] UI entry registers with no `consumes`; `deps.inferred` line names its
  inferred symbols (shot ref: `v2-inferred-1920x1080.png`)
- [ ] `≈` dashed markers on predicted exports visible before the first push
  (shot ref: `live-predicted.png`)
- [ ] `jev.judged` lines readable — refactor `clear` (p = 0.02) vs VAT
  `squash` (p ≈ 0.95) (shot ref: `v2-judging-1920x1080.png`)
- [ ] `behavior-changed` diagnosis shows `judgment` + equal old/new
  signatures (shot ref: `v2-behavior-changed-1920x1080.png`)
- [ ] Early-cutoff counter visibly ticks on the refactor push (live v2 runs
  recorded `earlyCutoffs: 5`)
- [ ] Ordinary `interface-changed` SQUASH on both dependents (shot ref:
  `live-squash.png`)
- [ ] e1 → e2 → e3 retire into the trunk chip in order, mode badges visible
  (`fast-forward`; `splice` on e3 in the failing-check run; shot refs:
  `live-check.png`, `live-final.png`)
- [ ] [optional] real agent registering via `arb_register` appears as a new
  lane on the dashboard (MCP scene)
- [ ] `robSize` config + veto shown as the two human controls, dashboard
  opened with `?key=<ADMIN_KEY>` (placeholder only; real key never on screen)
- [ ] Real-vs-scripted slide and measured-numbers table on screen
- [ ] "Built using Cloudflare Workers and Artifacts" line said out loud
