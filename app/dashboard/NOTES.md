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
  1920x1080), a 1280x720 check, and the deployed page (`live-check.png`).

## Run

- Live: served by `arb-control-plane` at `/`. Talks to `GET /api/state`,
  `WS /api/ws` (snapshot first, then incremental), `POST /api/config`,
  `POST /api/entries/:id/veto`. Falls back to polling `/api/state` every 1 s
  while the socket is down; reconnects with 1→8 s backoff.
- Mock: open `mock.html` (works over `file://` — classic scripts, no fetches)
  or `/?mock=1`. A `↺ replay` button re-runs the script.

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
- "Squash after push" stat: `state._lastSquashDelta = squash.ts − lastPush.ts`.
  For `interface-changed` squashes this is the producer push that caused them;
  for `trunk-overlap` squashes it is the latest entry push overall
  (approximation — the triggering event is a trunk push, not an entry push).
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
