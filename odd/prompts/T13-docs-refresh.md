First read `odd/prompts/_builder_head.md` completely and follow every rule in it. Then do the task below. Another agent edits `app/demo/**` in parallel; you write documentation only.

# Task T13: Docs refresh with value prediction and the scale benchmark

## Allowed edit surfaces
README.md
docs/**

## Sources (never invent facts or numbers)
- `app/control-plane/NOTES.md`, section "Value prediction (T11)": mechanism, live stats of 2 hits / 1 miss.
- `app/CONTRACTS.md` Changelog: `stub` on entry creation, `prediction.hit` / `prediction.miss` events, `prediction-miss` reason, `predictionHits` / `predictionMisses` stats.
- `app/control-plane/bench/RESULTS.md`: scale benchmark tables, the line-level causes and the proposed fix, plus the strictly-true scale-story paragraph.
- `app/dashboard/screenshots/live-*.png`: live screenshots you may embed with relative links.

## Requirements
- README:
  - Add value prediction to the mechanism section and the CPU analogy table (value prediction ↔ declared stubs).
  - Answer the "this is just stacked PRs" objection, citing the hit/miss counter.
  - Replace or strengthen the scale section with the benchmark's strictly-true paragraph and a compact table.
  - State honestly that the deployed control plane still uses ONE Durable Object today, that the benchmark shows single-buffer per-event cost growing with N, and that per-component sharding plus index maps is the next step. If `app/control-plane/NOTES.md` reports it already implemented by the time you finish, say so instead.
  - Embed 2-3 live screenshots.
- `docs/architecture.md`: add prediction state (predicted exports, pinned consumes, the resolution rules) and a "Scale" section with the benchmark method and caveats.
- `docs/demo-script.md`: open the 20-second wow scene with the stub-prediction counter. Narrate the hit/miss moment, then the early cutoff, then the breaking-change squash, then retirement. Use the screenshots as shot references.
- Verification: list every number you added with its source file, and confirm no claim exceeds its evidence.
