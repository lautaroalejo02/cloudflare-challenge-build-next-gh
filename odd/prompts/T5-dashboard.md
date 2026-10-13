First read `odd/prompts/_builder_head.md` completely and follow every rule in it. Then do the task below.

# Task T5: `app/dashboard`, live pipeline UI (static files, no build step)

## Allowed edit surfaces
app/dashboard/**

## Requirements
- `index.html`, `app.js` and `style.css`. The control-plane Worker serves them later as static assets at `/`. Use relative URLs `/api/state` and `/api/ws`.
- The 20-second scene of `research/top10.md` Idea 3 must read instantly on a projector. Build a CPU-pipeline view:
  - One row per entry, grouped by lane (api/ui/tests). Stages: forked → speculating → ready → checking → retired.
  - Each row shows: repo/fork name, generation, `forwarded: createOrder#<hash>` tags for its consumes, and its exports' hashes.
  - An arrow from producer to consumer.
  - On `squash`: the row flashes red "SQUASH" and shows the 3-line diagnosis (symbol, old signature → new signature).
  - On `hash.unchanged` (early cutoff): a subtle "cutoff" tick.
  - On `retired`: the entry slides into a trunk lane with the trunk commit.
- Stats bar: squashes, early cutoffs, retired, checks run, pushes seen.
- Event log on the side.
- Controls: a robSize slider (POST /api/config) and a Veto button on the head entry (POST /api/entries/:id/veto).
- Data flow: use WebSocket events (CONTRACTS "Events": `snapshot` first, then incremental) applied to local state. Reconnect on drop. Fall back to polling `/api/state` every 1s.
- `mock.html` (or `?mock=1`) replays a scripted sequence of ArbEvents locally, with no server. Cover: create, push, early cutoff, hash.changed, squash, refork, check.passed, check.failed, retired. It is for development and is the backup for the demo video.
- Visual quality matters: dark theme, monospace hashes, clear color semantics (green retired, amber speculating, red squash). No external CDNs (offline-safe).
- Verify: open the mock with a headless browser if available (e.g. a `npx playwright` screenshot saved to app/dashboard/screenshots/). Otherwise do a structural check, and say which one you did.
