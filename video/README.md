# Rebuild the ready-to-narrate ARB demo

Run `node video/build.mjs` from the repository root. It records new live footage and writes a silent 1920×1080 H.264 MP4 at 30 fps to `video/out/arb-demo-1080p.mp4`, plus a run-specific English cue sheet at `video/cues.md`.

## Prerequisites

- Node 22+, installed dependencies in `app/dashboard` and `app/mcp`.
- Microsoft Edge and Playwright's video encoder (`cd app/dashboard; npx playwright install ffmpeg`).
- `ffmpeg` and `ffprobe` on PATH; Windows Consolas font in the standard fonts directory.
- The existing default demo credential file. Do not put its contents in arguments, browser URLs, or a terminal recording.
- Exclusive use of the deployed control plane during recording. The scenario runner resets the demo state and seeds the trunk; do not run another demo concurrently.

## Pipeline

1. Capture the public dashboard with Edge at 1920×1080, asserting no query string or admin slider.
2. Run main, failing-check, multi, and a real stdio MCP client sequentially. A failed scenario receives one retry; a second failure stops the pipeline.
3. Keep each successful full live take, at normal speed for main/MCP and 1.5× for failing-check/multi. Caption times derive from that take's scenario timeline and recorded process-start offset, not old footage.
4. Render title, problem, mechanism, numbers, and closing cards as HTML screenshots. Match the dashboard palette and use local fonts only.
5. Burn captions with FFmpeg, concatenate, probe the final file, and extract nine representative frames.
6. Write `video/cues.md`; check the saved logs and cue sheet for secret markers.

For local editing after a successful capture, `node video/build.mjs --render-only`
re-encodes the existing successful takes in `video/tmp/` without remote operations.
`node video/build.mjs --cues-only` refreshes narration from that render's segment
manifest. The default command always captures new live takes first.
`--help` is local-only; unknown or conflicting options stop before capture.

Raw takes, timelines, event snapshots, HTML cards, caption text, and render logs are in ignored `video/tmp/`. Final verification metadata and representative frames are in ignored `video/out/`. Scenario-created clone directories remain owned by the existing demo runner. No deployment is performed.

## Verify

```sh
node --test video/lib.test.mjs
ffprobe -v error -show_format -show_streams -of json video/out/arb-demo-1080p.mp4
```

Inspect `video/out/frames/` and read the cue sheet before narrating. The cue sheet contains the voice-mux command. Live durations vary; the mechanism card absorbs a shortfall toward six minutes. If the full takes exceed seven minutes, the build stops rather than hiding or inventing events.

The problem card cites a claim already sourced in `research/top10.md`. The numbers card uses the README and V2 task evidence; the benchmark is explicitly synthetic and not Cloudflare network latency. The recorded agents and MCP client are scripted; all platform operations shown are real.
