# V9 implementation notes

## Built

Reproducible live-capture and FFmpeg assembly pipeline, deterministic timeline/redaction tests, an actual stdio MCP client scene, generated run-specific narration cues, five HTML cards, and nine extracted representative frames.

## Decisions

- Keep the browser on the public deployed URL with no query parameters; never show admin controls or a terminal with credentials.
- Execute all scenarios sequentially without the old delay-ready proxy; the documented trunk-race fix makes the workaround obsolete.
- Show actual MCP tool activity by driving the bundled stdio server, rather than labelling direct API calls as MCP.
- Keep live takes uncut, with only the requested 1.5× playback for two scenes. Add any pacing shortfall to the mechanism card, not fake or frozen dashboard footage.
- Use only sourced merge-queue and dispatch-time claims. The numbers card labels the README's earlier re-fork and retirement timings as earlier live measurements, not timings from the newly captured V2 runs. It separately identifies the same-machine benchmark as synthetic.
- Tests first: initial absent-module failure followed by three meaningful assertion failures on placeholder implementations; all three tests then passed on the implementation.
- Fresh capture found an initial clear judgment at 0.23 before the actual reduce-refactor judgments. Captions now bind to the refactor commit and ignore duplicate final-summary lines. Additional RED/GREEN regression tests cover that distinction and unchanged-signature semantic squashes.
- Both main-run semantic probabilities (0.94 and 0.97) appear in the caption. Actual MCP completion log lines appear in an explicitly labelled panel, after the calls complete.
- Failed-check and fix captions occupy separate lower-third rows because their real timeline events are only 0.3 seconds apart; a single narration cue explains the immediate fix.
- Final concatenation is re-encoded with `fps=30`. Stream copy introduced a tiny MP4 timestamp rounding difference in average-frame-rate metadata, despite nominal 30 fps; strict final probing caught it.

## Run and check

See `video/README.md`. Outputs and evidence are ignored. No commits, git state mutations, deployment, or credential changes are made.

## Contract issues

None. Existing scripts provide process-spawn offsets and scenario timeline timestamps rather than frame-perfect instrumentation; captions use those real observed offsets, with normal polling latency.

## Cloudflare resources

Only scenario-generated Artifacts forks and the MCP entry on the existing authorized control plane. No infrastructure resources are created or deleted directly by this package. These observed forks are in namespace `arb`:

- Main: `arb-e32-api-0`; `arb-e33-ui-0/1/2`; `arb-e34-tests-0/1/2`.
- Failing-check: `arb-e35-api-0`; `arb-e36-ui-0/1/2`; `arb-e37-tests-0/1/2`.
- Multi: `arb-e38-api-0`; `arb-e39-api-0`; `arb-e40-ui-0/1/2`; `arb-e41-tests-0/1`; `arb-e42-ui-0/1`.
- MCP: `arb-e43-api-0`. The slash suffix notation above lists each numbered generation as a separate observed repo.

## Known gaps

The artifact is silent by design; the presenter must record and mux narration. Rebuilding requires Windows Edge, the installed Windows fonts, FFmpeg, and the existing package dependencies. Caption timing uses real timeline observations and process offsets, with normal polling latency rather than frame-perfect server instrumentation.

## Final verification

- `node video/build.mjs`: all four fresh live captures exited 0 on their first attempt, in sequence. No live scenario rerun was needed.
- `node video/build.mjs --render-only`: final local render exited 0 after the caption and CFR corrections. It reused only the new successful takes captured by this task.
- `node video/build.mjs --cues-only`: exited 0; final narration includes actual main probabilities and a combined immediate-fix cue.
- `node --test video/lib.test.mjs`: 8/8 pass; RED/GREEN observed for the core mapping/redaction logic, CLI guard, and regressions.
- `node video/build.mjs --help`: exit 0, local-only. A misspelled local mode exits 1 before any capture; conflicting modes and prototype-name arguments are also rejected by tests.
- `ffprobe`: 360.000000 seconds, H.264, 1920×1080, both frame-rate fields 30/1, 10,800 frames, no audio stream; final file 15,190,920 bytes.
- `ffmpeg -v error -i video/out/arb-demo-1080p.mp4 -f null -`: exit 0, no decode errors.
- All nine extracted frames were visually inspected. The multi frame shows payments entry e42 retired while orders head e39 is still speculating. MCP completion-log text matches the actual client output.
- Cue sheet plus 25 saved logs: zero matches for the token prefix, authorization marker, credential filename, or authenticated query marker. No admin controls were visible.
- `git diff --check -- video .gitignore`: exit 0; the repository's ordinary LF/CRLF advisory is not a whitespace error. A separate check found zero trailing-whitespace files among the new sources/docs.
- Main judgments: initial clear 0.23; reduce refactor 0.02/0.02; VAT squash 0.94/0.97. Captions use 0.02 and 0.94/0.97, not the unrelated initial judgment. Failing-check refactor 0.02/0.03 and VAT 0.94/0.94; multi refactor 0.02.
- The only rejected render check was an intermediate stream-copy average-frame-rate rounding issue; explicit final CFR encoding fixed it. No final checks remain failed or pending.

## Self-evaluation

Overall 4.2/5; no critical issues. Accuracy 4: verified media and eight tests, but captions retain normal polling latency. Completeness 4: all requested scenes/deliverables exist, while the two-failure retry boundary was not exercised because every live run passed first time. Clarity 4: the cue sheet is event-specific, but renderer CSS remains embedded in the build script. Actionability 5: the silent file, cues, rebuild command, frames, and exact voice-mux command are available now. Conciseness 4: one reusable pipeline is proportionate, but the capture/render helpers could later be separated for maintenance. Optional improvement: inject failed process results to test the retry boundary without modifying live state. The user can verify the assessment against the recorded evidence above.
