# app/dashboard — ARB live pipeline UI

Static files, no build step, no external assets (offline-safe). The
control-plane Worker serves this directory at `/` later.

## Files

- `index.html` — shell; the whole DOM is built by `app.js`.
- `app.js` — renderer, WebSocket/polling client, controls, orthogonal SVG
  forwarding connectors (recomputed on render, scroll, resize and layout
  changes), FLIP retirement animation. Classic script (file://-safe).
- `state.js` — pure event-folding core (`ArbState`): consumes `ArbEvent`s per
  `app/CONTRACTS.md` and maintains a `BufferState`-shaped model + capped event
  log + squash timing. No DOM access; the same file is `require`d by the Node
  tests.
- `mock.js` — scripted replay of the Idea-3 scene (~25 s) with the REAL event
  payload shapes from `app/control-plane/src/rob.ts` (flat fields, no
  `data.entry`): 4 entries across api/ui/tests/docs lanes, body-only push →
  early cutoff ×2, signature change → `hash.changed` → squash ×2 → refork,
  `fast-forward` and `splice` retirements, a `check.failed` → fix push →
  `check.passed`, and a `trunk-overlap` squash → refork → retired.
- `mock.html` — same shell with `window.__ARB_MOCK__`; `?mock=1` on
  `index.html` works too (app.js injects `mock.js`).
- `style.css` — dark projector theme; green=retired, amber=speculating,
  red=squash/veto/failed, violet=checking/splice, blue=ready. Media queries
  keep the stats bar and rows compact at 1280x720.
- `test/state.test.js` — 24 node:test cases over the state core and the full
  mock script.
- `screenshots/` — playwright captures of the mock (squash scene + final,
  1920x1080), a 1280x720 check, the deployed page (`live-check.png`), and the
  live T9c demo run (`live-squash.png` at the squash moment,
  `live-final.png` after all three retirements).
- `recordings/` — T16 live video takes for the submission video
  (`*.webm`, VP9, plus `<name>.timeline.txt` = the scenario's stdout from the
  same run). No tokens in the timelines — `grep art_v2_` is clean.
- `scripts/capture-live.mjs` — headless-Edge capture used for the live shots:
  `waitForSelector('.log-line.t-squash')` for the squash moment and
  `[data-chip="e3"]` for the final state. `npm run capture:live` — start it
  before `npm run demo` so the run streams over `/api/ws`.
- `scripts/record-live.mjs` — headless-Edge `recordVideo` capture that spawns
  the scenario itself (`npm run demo -- --base <url> [--scenario X]` in
  `app/demo`), keeps rolling until it exits +4 s, then saves
  `recordings/<name>.webm` + `.timeline.txt`. Optional `--delay-ready
  <entryId>:<ms>` fronts the demo with a loopback proxy that holds only that
  entry's `ready` POST (kept for debugging; no scenario needs it since the
  T17 trunk-race fix — see "Live footage" below).

## Run

- Live: served by `arb-control-plane` at `/`. Talks to `GET /api/state`,
  `WS /api/ws` (snapshot first, then incremental), `POST /api/config`,
  `POST /api/entries/:id/veto`. Falls back to polling `/api/state` every 1 s
  while the socket is down; reconnects with 1→8 s backoff.
- Mock: open `mock.html` (works over `file://` — classic scripts, no fetches)
  or `/?mock=1`. A `↺ replay` button re-runs the script.

## Live footage (T16)

Recorded 2026-10-13 against `arb-control-plane` (deployed, not redeployed by
this task). One take per scenario; each webm is VP9, `recordVideo` at the
viewport size, plus the scenario stdout timeline saved alongside.

| File | Scenario | Res | Duration | Size | ffprobe packets |
|---|---|---|---|---|---|
| `recordings/main.webm` | main | 1920x1080 | 86.9 s | 16.5 MB | 2172 |
| `recordings/multi.webm` | multi | 1920x1080 | 100.5 s | 28.7 MB | 2513 |
| `recordings/multi-720.webm` | multi | 1280x720 | 98.0 s | 19.6 MB | 2451 |
| `recordings/failing-check.webm` | failing-check | 1920x1080 | 66.9 s | 15.8 MB | 1672 |

`multi.webm` exceeds 25 MB, so `multi-720.webm` is the small fallback take.
All four passed `ffprobe` (duration + packet count; every packet decodes) and
the scenarios all exited 0 with all entries retired in order.

### Re-recording

```
cd app/dashboard
npx playwright install ffmpeg          # once — recordVideo needs the bundled ffmpeg
npm run record:live -- --name main
npm run record:live -- --name multi --scenario multi
npm run record:live -- --name failing-check --scenario failing-check
```

Options: `--base <url>` (default the production worker), `--size WxH`
(default 1920x1080; `1280x720` for the small take), `--tail <ms>` (extra
footage after the scenario exits, default 4000), `--delay-ready
<entryId>:<ms>`.

`--delay-ready` (historical, now unnecessary): the T16 takes used
`--delay-ready e5:30000` to work around a cross-component splice-candidate
race — the candidate was built on the trunk head at `retire()` time but
`moveBranch` pushed to `main` only after the candidate check, so a sibling
landing in between produced a non-fast-forward rejection and wedged the
component (`_internal.retiring` never cleared; `ready rejected: Push
rejected because it was not a simple fast-forward.`). T17 made the whole
retire cycle atomic inside `ArbTrunk` with bounded rebuilds, so multi runs
cleanly without any delay. The flag still works if a staggered take is ever
wanted; every event, squash, check and splice in the T16 takes was real —
the delay was client-side timing only.

### Key moments (video timestamps ≈ demo-spawn offset + timeline `+Ns`)

main.webm (spawn offset 7.0 s):
- ~27-32 s — three entries appear, consumers forwarded onto the api fork with
  `≈ stub` predicted-hash tags
- ~42 s — prediction verdicts land (2 hits / 1 miss) and e2 takes the
  prediction-miss SQUASH on the `Order` interface (`hash.changed` → red flash)
- ~51 s — early cutoff: api's body-only push, `stats.earlyCutoffs 0 -> 2`,
  nobody squashed
- ~60-61 s — breaking push: `createOrder` signature change → e2 + e3 SQUASH
- ~63 s — e1 retires; ~76 s — e2 retires; ~78 s — e3 retires, all three green
  chips on the trunk bar by ~79 s

multi.webm (spawn offset 2.3 s) — the 720p take is ~2 s earlier throughout:
- ~11-18 s — five entries, two api lanes: `comp-e1` orders + `comp-e2`
  payments forwarding trees visible
- ~29 s — orders prediction verdicts (2 hits / 1 miss), e3 prediction-miss
  SQUASH
- ~25 s / ~39 s — early cutoffs on both producers' body-only pushes
- ~47 s — payments breaking change SQUASHes e5 (stays inside comp-e2)
- ~55 s — orders breaking change SQUASHes e3 + e4 (stays inside comp-e1)
- Retirements: e2 ~48 s, e1 ~59 s, e3 ~67 s, e4 ~71 s, e5 ~94 s (the e5 gap is
  the deliberate `--delay-ready` stagger); 5/5 green by ~96 s

failing-check.webm (spawn offset 2.3 s):
- ~22 s — prediction verdicts + e2 prediction-miss SQUASH
- ~32 s — early cutoff on the body-only push
- ~45 s — breaking change SQUASHes e2 + e3
- ~46 s — e1 retires; ~55 s — e2 retires while e3 goes `ready -> failed`
  (red `check.failed` — the scripted bad test runs in a Dynamic Worker)
- ~59-62 s — the tests agent pushes the scripted fix, e3 re-checks and
  retires; all three green by ~63 s

## Verify

- `npm test` (or `node --test`): 24/24 pass.
- `npx playwright screenshot --channel msedge --viewport-size=1920,1080 --wait-for-timeout 7600 <file:///…/mock.html> screenshots/mock-squash.png` — squash scene; `--wait-for-timeout 26500` for the final scene.
- Live read-only check (2026-10-13): `GET /api/state` returned trunk `14f75efd`, 0 entries; playwright capture of `/` showed "LIVE · ws" and the snapshot in the log (`screenshots/live-check.png`).

## Decisions

- The deployed control plane emits FLAT event payloads (no `data.entry`) —
  verified in `app/control-plane/src/rob.ts`: `entry.created` →
  `{agent,lane,seq,producerId,repo}`; `push` → `{repo,commit}` (trunk pushes
  add `trunk:true` and no `entryId`); `hash.unchanged`/`hash.changed` carry the
  CONSUMER's `entryId` and `{producerId,commit[,changed]}`; `squash` →
  `{reason,changed,generation,repo}`; `refork` → `{repo,baseCommit,generation}`;
  `check.*` → `{commit,durationMs[,failed]}`; `retired` → `{commit,seq[,mode]}`;
  `veto` → `{seq}`; `config` → `{robSize}`. `state.js` folds exactly these,
  and still accepts a full `data.entry` / `data.stats` for tolerance.
- `squash` has no `producerCommit` in its payload, so the producer commit is
  stashed on the consumer from the preceding `hash.changed` (`_hcCommit`) and
  used for the diagnosis header when absent.
- `refork` copies `diagnosis.changed[].newHash` into `consumes`, mirroring the
  server-side `fork.done` that records the new producer hashes.
- Retirement mode (`data.mode`: `fast-forward` | `splice`, added by the
  integration agent) is stored on the entry as `_retireMode` and rendered as a
  small badge inside the retired trunk chip.
- "Re-fork ready" stat: `state._lastReforkDelta = refork.ts − squash.ts` for
  the entry's latest squash. Both events carry the control plane's own
  timestamp, so the value is an honest server-side latency (replaces the
  synthetic "squash after push" delta, which collapsed to ~0 ms live because
  the DO stamps the producer push and the consumer squashes in one `apply`).
- Forwarding connectors are orthogonal elbows: out of the producer row's left
  rail, into a 3-channel gutter between lane labels and cards (one channel per
  producer), then right into the consumer rail. Trunk-sourced rows get a
  dashed connector rising out of the trunk bar. Coordinates are pipeline
  content-space (`scrollTop/scrollLeft`-corrected); redraws are rAF-scheduled
  on render, scroll, window resize and `ResizeObserver` layout changes.
- The control plane never broadcasts `fork.done`, so a fresh entry's `remote`,
  `exports` and recorded `consumes` only exist in `/api/state`. In live mode
  the dashboard schedules a one-shot state pull (~0.9 s and ~2.6 s) after each
  `entry.created`/`refork` event.
- Head entry = lowest-seq non-retired, non-vetoed entry; only it gets the VETO
  button. In mock mode VETO is simulated locally (`localVeto`: veto + squash
  transitive dependents via `producerId` chain) since there is no server.
- Diagnosis block renders `changed[]` as a unit per symbol (symbol + hash diff,
  `−` old signature, `+` new signature; signature lines omitted when empty),
  max 2 symbols per row. `trunk-overlap` gets a trunk-specific reason label
  and empty-`changed` copy.
- DOM is rebuilt per event (rows ≤ ~10, trivial cost); transient UI state
  (`_squashAt`, `cutoffs`, `_retireAt`, `_retireMode`) lives on the entry
  objects so it survives re-renders. Retirement uses a FLIP transform from the
  lane row to the trunk chip.
- Scripts are classic (non-module) so `mock.html` works from `file://` without
  a server; `state.js`/`mock.js` use a tiny UMD guard for Node tests.

## Contract issues

- `ArbEvent.data` is `unknown` with only "include enough for the UI" as
  guidance. The deployed control plane emits flat fields only (see Decisions)
  — the contract's "e.g. data.entry" hint does not hold in practice. The UI
  now folds the real shapes; consider pinning them in CONTRACTS.md.
- `fork.done` is never broadcast: a new entry's `remote`, `baseCommit`,
  `exports` and recorded `consumes` are invisible to WS-only clients until an
  arbitrary event or a `/api/state` pull. The dashboard works around it with a
  short post-`entry.created`/`refork` state fetch; a `fork.done`/`entry.ready`
  broadcast would be cleaner.
- `squash` payloads omit `producerCommit`; the diagnosis header relies on the
  preceding `hash.changed`'s `commit`. Fine in practice, worth pinning.
- `status: "failed"` vs check semantics: after `check.failed` the UI expects
  either a `data.entry` status or infers `failed`; a later `push` returns it to
  `speculating`. Contract doesn't say whether a failed entry keeps its seq —
  UI keeps whatever arrives.
- `reset` does not delete repos: planned fork names can collide, and the DO
  suffixes them (`-x1`, `-x2`, …) — the `refork` event carries the actual
  name, which the UI folds.

## Known gaps

- No stub-prediction hit/miss counter (top10.md stretch goal, out of T5 scope;
  would ride on an extra stat in `BufferState.stats` if added).
- SVG connectors are redrawn per render; on very large buffers (>100 entries)
  the full innerHTML rebuild would be the first thing to optimize.
- Veto confirmation is not implemented (single click vetoes in mock; the real
  POST is also single-click — acceptable for a demo, flag if judges fat-finger).
- The `retired` event carries no `trunk` object, so `stats.retired` and
  `trunk.retiredCount` are incremented locally between snapshots (consistent
  with the server's own counting).

## Cloudflare resources

None. This package creates no resources; it is served by `arb-control-plane`.
