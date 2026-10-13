First read `odd/prompts/_builder_head.md` completely and follow every rule in it. Then do the task below. Another agent edits `app/**` in parallel; do not touch anything outside your surfaces.

# Task T9d: Replace TBDs in the docs with live end-to-end evidence

## Allowed edit surfaces
README.md
docs/**

## Requirements
- Integration is done. `app/control-plane/NOTES.md` now has a "Live E2E results" section: real timings for push→squash, refork, checks, fast-forward retirement and splice retirement, plus scenario timelines.
- `app/CONTRACTS.md` has a Changelog: `trunk-overlap`, retirement `mode`, `/api/events`, and more.
- Update `README.md`, `docs/architecture.md` and `docs/demo-script.md`:
  - Replace every `TBD (pending integration run)` with the measured value and its source file.
  - Describe the retirement modes (fast-forward vs path-disjoint splice) as now implemented, with the splice commit message format from the evidence.
  - Make the demo script's narration match the real scenario output: steps, order, approximate timings from the live timeline. Point at the real dashboard elements.
  - Note the honest caveats: agent intelligence is scripted; the 100K-agent claim is a design argument (one DO per connected component), not a measurement.
- Every number must be traceable to a file. If a value is not in any file, write "not measured" and do not invent one.
- Verification: list every number you added with its source. Grep that no `TBD` remains (or justify any that remains).
