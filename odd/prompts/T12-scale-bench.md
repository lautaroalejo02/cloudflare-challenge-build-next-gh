First read `odd/prompts/_builder_head.md` completely and follow every rule in it. Then do the task below. Another agent is concurrently modifying `app/control-plane/src/**` (adding value prediction). You may only READ `src/rob.ts`; never edit it. If its API changes under you mid-run, adapt your harness.

# Task T12: Scale benchmark of the reorder-buffer coordination cost

## Allowed edit surfaces
app/control-plane/bench/**

## Question
The pitch claims that coordination cost is proportional to the edges of the in-flight change DAG touched by a push, not to the total number of agents, and that disconnected components can live in separate Durable Objects. Measure what the CURRENT pure state machine (`app/control-plane/src/rob.ts`) actually does. Report honestly.

## Requirements
- `bench/run.ts` (run with `node --experimental-strip-types bench/run.ts`; do not edit package.json). It generates synthetic buffers and drives `rob.ts` purely, in-process, with no Cloudflare.
  - Workloads: N = 1,000 / 10,000 / 100,000 entries, split into C connected components (e.g. C = N/10), with producer→consumer fan-out f (e.g. 3) and depth d (e.g. 3).
  - Event mix: interface-changing pushes, body-only pushes (early cutoff), ready, check results, retirements.
- Measure:
  - per-event wall time (median, p95);
  - effects emitted per event;
  - entries touched per event;
  - state serialization size, if relevant to DO storage.
- Two modes:
  - (a) one buffer holding all N entries, i.e. today's single DO;
  - (b) one buffer per component, which is the proposed sharding. Simulate it as C independent state instances, and route each event to its component.
- Determine empirically whether per-event cost grows with N in mode (a): plot or tabulate it. If it does (e.g. linear scans over all entries), identify the exact code lines responsible and the fix (e.g. index by producerId / repo). Do NOT edit `rob.ts`; write the recommendation in `bench/RESULTS.md`.
- Squash fan-out: show that an interface-changing push squashes exactly its transitive dependents, and give the count distribution.
- `bench/RESULTS.md` (concise, under ~80 lines) must contain:
  - the setup;
  - tables;
  - conclusions;
  - a one-paragraph "scale story" that is strictly true given the measurements, for the README;
  - the hardware/runtime used;
  - caveats (synthetic workload, no network/DO I/O).
