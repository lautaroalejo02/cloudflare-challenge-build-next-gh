First read `odd/prompts/_builder_head.md` completely and follow every rule in it. Then do the task below. Other agents work in parallel: one owns `app/control-plane` (integration) and one owns `README.md` + `docs/**`. Do not touch their files.

# Task T9a: Dashboard polish and alignment with the real control-plane events

## Allowed edit surfaces
app/dashboard/**

## Requirements
1. Fix the producer→consumer arrows. In `app/dashboard/screenshots/mock-squash.png` they render as stray diagonal orange lines between cards. Make them clean connectors (e.g. an orthogonal SVG path from the producer row's left rail to the consumer row), recomputed on layout changes and resize.
2. Align with the REAL event payloads. Read (read-only) `app/control-plane/src/do.ts`, `src/rob.ts` and `src/index.ts` to see exactly what `ArbEvent.data` the deployed control plane emits for each event type. Make `state.js` fold them correctly; keep tolerant fallbacks.
   - The integration agent will add `retired` events with `data.mode = "fast-forward" | "splice"`, plus a `Diagnosis.reason` value `trunk-overlap`. Show the retirement mode as a small badge in the trunk lane, and the trunk-overlap reason in the squash diagnosis.
3. Make the stats bar and header projector-friendly at 1920x1080 and at 1280x720. Show the timing of the latest squash ("squash 1.2 s after push"), computed from event timestamps.
4. Update the mock replay to include a splice retirement and a trunk-overlap squash.
5. Live read-only check: GET `https://arb-control-plane.lautitomasalejo.workers.dev/api/state` and open `https://arb-control-plane.lautitomasalejo.workers.dev/` in a headless browser to confirm the deployed dashboard loads and connects over WebSocket. Do NOT call reset, config, veto or entries endpoints on the live control plane: another agent is running scenarios on it. Note: your changes are not deployed until the integration agent redeploys; that is expected.
6. Tests: keep `node --test` green and extend it for the new folding. Take new screenshots (`npx playwright screenshot --channel msedge`) of the mock at the squash moment and at the end, at 1920x1080.
