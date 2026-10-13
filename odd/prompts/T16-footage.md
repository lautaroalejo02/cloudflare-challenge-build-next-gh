First read `odd/prompts/_builder_head.md` completely and follow every rule in it. Then do the task below. Do not redeploy anything. You are the only agent running live scenarios now.

# Task T16: Record live dashboard footage for the submission video

## Allowed edit surfaces
app/dashboard/scripts/**
app/dashboard/recordings/**
app/dashboard/NOTES.md
app/dashboard/package.json
app/dashboard/package-lock.json

## Requirements
- Write `app/dashboard/scripts/record-live.mjs`. It uses Playwright (`--channel msedge` / `channel: "msedge"`, already proven in `scripts/capture-live.mjs`) to open `https://arb-control-plane.lautitomasalejo.workers.dev/` at 1920x1080 with `recordVideo`. While recording, it starts the scenario as a child process: `npm run demo -- --base <url> [--scenario X]` in `app/demo`. It keeps recording until the scenario exits, plus 4 s, then saves the video.
- Record three takes:
  - `recordings/main.webm` (main scenario);
  - `recordings/multi.webm` (`--scenario multi`);
  - `recordings/failing-check.webm`.
- Also save each scenario's stdout timeline next to its video (`recordings/<name>.timeline.txt`). Confirm that no tokens appear in it; grep for `art_v2_`.
- Keep the files reasonably small: a webm at 1080p for about 60-80 s should be fine. Report the sizes. If any file exceeds 25 MB, also produce a 1280x720 take.
- Verify each video is non-empty and playable: check its duration with ffprobe if available, otherwise report the file size and the frame-count method you used.
- In `app/dashboard/NOTES.md`, document how to re-record the footage, and timestamps of the key moments in each take (prediction hit/miss, early cutoff, SQUASH, retirement), read from the timelines.
