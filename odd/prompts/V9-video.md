Read `odd/prompts/_builder_head.md` and follow its rules (do not commit; the orchestrator commits). Also read:
- `odd/tasks/arb-v2.md`;
- `app/dashboard/scripts/record-live.mjs` and `capture-live.mjs`, which already record the live dashboard with Playwright while a scenario runs;
- `app/dashboard/NOTES.md`, including the recording notes;
- `docs/demo-script.md`;
- the README's measured-numbers section.

Another agent is editing `README.md` and `docs/**` right now. Do not edit those.

# Task V9: Build a ready-to-narrate demo video (≥ 5:00, target ~6:00)

## Allowed edit surfaces
video/**
app/dashboard/scripts/**
.gitignore (only to add `video/out/` and `video/tmp/`)

## Goal
A silent 1920x1080 MP4, 5:00 to 7:00 long, that the user narrates over, plus a cue sheet telling them exactly what to say and when. Everything must be honest: the demo agents are scripted (say so on screen), while every other part is real and live.

## Segments (in order; adjust the durations so the total is 5:30-6:30)
1. **Title card (~8 s):** "Agent Reorder Buffer: out-of-order execution for coding agents", with the line "Built on Cloudflare Artifacts · Durable Objects · Dynamic Workers · Queues".
2. **Problem card (~25 s):** use only claims that already appear, with a source, in `README.md`, `research/top10.md` or `research/scores/*.md`; quote the source URL in small text. Omit any claim you cannot source.
3. **How it works card (~30 s):** 4 short lines:
   - forwarding (consumers start on the producer's unfinished fork);
   - squash on interface change;
   - Jev semantic squash on same-signature behavior change;
   - in-order retirement with tests in Dynamic Workers, fast-forward or path-disjoint splice.
4. **Live main scenario (full speed, ~90-100 s).**
   - Record the LIVE dashboard (`https://arb-control-plane.lautitomasalejo.workers.dev`, WITHOUT `?key=`; the admin controls must not be visible) while running `npm run demo -- --base <that url>` from `app/demo`. The admin key comes from the default key file; never print it.
   - Burn in lower-third captions at the real event times (use the scenario's timeline output):
     - "Agents are scripted · forks, hashing, Jev, tests and retirement are real" (first 6 s);
     - "Stub prediction: UI starts before the API exists";
     - "Body-only refactor → early cutoff (Jev p≈0.02)";
     - "Same signature, behavior changed → Jev p≈0.95 → SQUASH";
     - "Signature changed → SQUASH + re-fork";
     - "Retired in order onto trunk".

     Use the real probabilities from that run's `jev.judged` events.
5. **Live failing-check scenario**, sped up 1.5x, with a corner label "1.5×" and a caption at the failed check and at the fix.
6. **Live multi scenario**, sped up 1.5x, with the label and the caption "Two independent chains · no head-of-line blocking".
7. **MCP scene (~40 s).**
   - Record the dashboard while `app/mcp/scripts/live-check.ts` (or an equivalent short script using the MCP server's tools) registers an entry, pushes and readies it.
   - Caption: "Any MCP agent can join: arb_register → arb_push → arb_ready (scripted MCP client shown)".
   - Show the tool calls as an overlay or a side panel only if that is simple and accurate. Do not fake output.
8. **Numbers card (~25 s):** only figures from the README / `odd/tasks/arb-v2.md`:
   - Jev 0.02 vs 0.93-0.97;
   - all live runs exit 0;
   - re-fork time and retire timing if they are documented;
   - the same-machine bench comparison.
9. **Closing card (~8 s):** the repo URL `https://github.com/lautaroalejo02/cloudflare-challenge-build-next-gh`.

## Rules
- Run live scenarios sequentially, never in parallel. If a scenario fails, rerun it once. If it fails again, stop and report `partial`; never fake footage.
- Render the cards from HTML with Playwright screenshots at 1920x1080, using the dashboard's visual style (dark, mono accents). No external assets that need licenses. Burn in captions with ffmpeg `drawtext` (or HTML overlays), legible at 1080p.
- No secrets anywhere: no `?key=`, no tokens, no key file contents in frames or logs. Grep the cue sheet and logs for `art_v2_`, `Bearer` and the admin-key file name before finishing.
- Make it reproducible: `video/build.mjs` (or `.ts`) runs the whole pipeline. Write intermediate files to `video/tmp/` and the final file to `video/out/`, and gitignore both.

## Deliverables
- `video/out/arb-demo-1080p.mp4`: silent, H.264, 30 fps, 5:00-7:00.
- `video/cues.md`: a table of `mm:ss` start, segment, what is on screen, and a suggested narration line in English, short enough to read at a calm pace in that window. Also include the ffmpeg command to mux the user's voice track: `ffmpeg -i video/out/arb-demo-1080p.mp4 -i voice.m4a -c:v copy -c:a aac -shortest video/out/arb-demo-final.mp4`.
- `video/README.md`: how to rebuild the video.

## Verification (final message)
- `ffprobe` duration and resolution of the MP4.
- Extract one frame per segment to `video/out/frames/` and list them.
- The live run results (exit codes, `jev.judged` probabilities used in the captions).
- The secret grep results.
- `## Result` (complete | partial | blocked) and the files changed.
