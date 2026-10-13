First read `odd/prompts/_builder_head.md` completely and follow every rule in it. Then do the task below. Another agent works in parallel ONLY in `app/control-plane/bench/**` (read-only use of `src/rob.ts`); do not touch that folder.

# Task T11: Value prediction (declared stubs) with a hit/miss counter

## Allowed edit surfaces
app/control-plane/src/**
app/control-plane/test/**
app/control-plane/NOTES.md
app/control-plane/package.json
app/control-plane/wrangler.toml
app/demo/**
app/dashboard/**
app/CONTRACTS.md

## Why
From `research/top10.md` Idea 3: "Hardest judge objection: this is just stacked PRs. Answer: the buffer also does value prediction. A consumer can start against the producer's declared stub before the producer writes anything, and is squashed only if reality differs. The hit/miss counter makes that visible." The wow scene includes a counter reading "stub predictions: 2 hit / 1 miss".

## Mechanism to implement
- A producer may declare a stub at registration: `POST /api/entries` gets an optional `stub: Record<path, string>`, which is TypeScript source declaring its intended exported signatures.
  - The control plane hashes the stub with the real hasher.
  - `entry.exports` starts as these *predicted* hashes, marked as predicted.
  - Consumers can register immediately, before the producer's first push, and forward against the predicted hashes.
- On the producer's first real push that touches the predicted symbols, compare actual vs predicted per consumed symbol, per consumer:
  - Match → **prediction hit**: no squash. Emit `prediction.hit`.
  - Mismatch → **prediction miss**: squash with reason `prediction-miss` and a diagnosis (predicted vs actual signature). Emit `prediction.miss`.
  - After that, normal forwarding rules apply (later interface changes are ordinary squashes).
- Stats: add `predictionHits`, `predictionMisses`. Write the pure logic in `rob.ts` test-first, with unit tests.
- Update `app/CONTRACTS.md` (data model, API, events) with Changelog lines.
- Dashboard:
  - a stats counter "stub predictions: X hit / Y miss";
  - a visual "predicted" marker on forwarded hashes until confirmed;
  - a hit/miss tick on rows.
  - Update `mock.js` too.
- Demo scenario (`app/demo`): the API agent declares a stub at registration, and the UI and Tests agents register immediately against it. Design the scripted edits so a normal run shows hits AND at least one miss in a believable way. Example: the stub declares `createOrder` v1 and `Order`, but the first real push adds a field to `Order`, so the consumer of `Order` misses while the consumer of `createOrder` alone hits. The later breaking change still squashes as before.
  - Keep `--scenario failing-check` working.

## Verification
- Unit tests in all touched packages are green.
- Redeploy `arb-control-plane`.
- Run the LIVE main scenario and `--scenario failing-check` against `https://arb-control-plane.lautitomasalejo.workers.dev`. Both must exit 0, the process must exit promptly, and stats must show predictionHits ≥ 1 and predictionMisses ≥ 1.
- Capture `app/dashboard/screenshots/live-prediction.png` at the moment of a hit or miss. `app/dashboard/scripts/capture-live.mjs` exists; extend it.
- Record timelines and stats in `app/control-plane/NOTES.md` under "Value prediction (T11)".

## RESUME NOTE (read before acting)
A previous agent started this exact task and was interrupted by a rate limit. Its partial work is UNCOMMITTED in the working tree: run `git diff app/control-plane` to see it. It added prediction tests to `test/rob.test.ts` and started the prediction logic in `src/rob.ts`, inside the consumer-centric `push` handler (`consumedDiff` / `squashTree`).
- Review that partial work critically. Keep what is correct; finish or fix the rest. Do not start over unless it is broken beyond repair.
- Then complete every remaining requirement above: CONTRACTS changelog, dashboard, demo scenario, redeploy, live runs, screenshot, NOTES.
- Another agent may be writing under `app/control-plane/bench/**`. Never touch that folder.
