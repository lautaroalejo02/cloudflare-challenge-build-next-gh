# app/dashboard — ARB live pipeline UI

Static files, no build step, no external assets (offline-safe). The
control-plane Worker serves this directory at `/` later.

## Files

- `index.html` — shell; the whole DOM is built by `app.js`.
- `app.js` — renderer, WebSocket/polling client, controls, SVG forwarding
  arrows, FLIP retirement animation. Classic script (file://-safe).
- `state.js` — pure event-folding core (`ArbState`): consumes `ArbEvent`s per
  `app/CONTRACTS.md` and maintains a `BufferState`-shaped model + capped event
  log. No DOM access; the same file is `require`d by the Node tests.
- `mock.js` — scripted replay of the Idea-3 scene (~20 s): 3 entries across
  api/ui/tests lanes, body-only push → early cutoff, signature change →
  `hash.changed` → squash ×2 → refork, in-order retirement, one `check.failed`
  → fix push → `check.passed` → retired.
- `mock.html` — same shell with `window.__ARB_MOCK__`; `?mock=1` on
  `index.html` works too (app.js injects `mock.js`).
- `style.css` — dark projector theme; green=retired, amber=speculating,
  red=squash/veto/failed, violet=checking, blue=ready.
- `test/state.test.js` — 14 node:test cases over the state core and the full
  mock script.
- `screenshots/` — playwright captures of the mock (squash scene + final).

## Run

- Live: served by `arb-control-plane` at `/`. Talks to `GET /api/state`,
  `WS /api/ws` (snapshot first, then incremental), `POST /api/config`,
  `POST /api/entries/:id/veto`. Falls back to polling `/api/state` every 1 s
  while the socket is down; reconnects with 1→8 s backoff.
- Mock: open `mock.html` (works over `file://` — classic scripts, no fetches)
  or `/?mock=1`. A `↺ replay` button re-runs the script.

## Verify

- `npm test` (or `node --test`): 14/14 pass.
- `npx playwright screenshot --channel msedge --wait-for-timeout 7800 <file:///…/mock.html> out.png` — verified on Edge, shots in `screenshots/`.

## Decisions

- `ArbEvent.data` is loosely typed in the contract, so the core folds a full
  `data.entry` whenever present (the control-plane agent was told "include
  enough for the UI"), accepts flat fields as a fallback, and accepts
  `data.stats` as authoritative — otherwise it increments the matching counter
  locally. This keeps the UI correct against any reasonable payload.
- Head entry = lowest-seq non-retired, non-vetoed entry; only it gets the VETO
  button. In mock mode VETO is simulated locally (`localVeto`: veto + squash
  transitive dependents via `producerId` chain) since there is no server.
- Diagnosis block renders the contract's `changed[]` as a 3-line unit per
  symbol (symbol + hash diff, `−` old signature, `+` new signature), max 2
  symbols per row to keep the projector view readable.
- DOM is rebuilt per event (rows ≤ ~10, trivial cost); transient UI state
  (`_squashAt`, `cutoffs`, `_retireAt`) lives on the entry objects so it
  survives re-renders. Retirement uses a FLIP transform from the lane row to
  the trunk chip.
- Scripts are classic (non-module) so `mock.html` works from `file://` without
  a server; `state.js`/`mock.js` use a tiny UMD guard for Node tests.

## Contract issues

- `ArbEvent.data` is `unknown` with only "include enough for the UI" as
  guidance. The UI is written defensively (see Decisions), but it would be
  better if the contract pinned `data.entry: Entry` on entry-scoped events and
  `data.stats: BufferState["stats"]` on stat changes. If control-plane emits
  flat fields only, everything still renders — stats may double-count only if
  both `data.entry` and `data.stats` disagree, which no sane emitter does.
- `status: "failed"` vs check semantics: after `check.failed` the UI expects
  either a `data.entry` status or infers `failed`; a later `push` returns it to
  `speculating`. Contract doesn't say whether a failed entry keeps its seq —
  UI keeps whatever arrives.

## Known gaps

- No stub-prediction hit/miss counter (top10.md stretch goal, out of T5 scope;
  would ride on an extra stat in `BufferState.stats` if added).
- SVG arrows are redrawn per render; on very large buffers (>100 entries) the
  full innerHTML rebuild would be the first thing to optimize.
- Veto confirmation is not implemented (single click vetoes in mock; the real
  POST is also single-click — acceptable for a demo, flag if judges fat-finger).

## Cloudflare resources

None. This package creates no resources; it is served by `arb-control-plane`.
