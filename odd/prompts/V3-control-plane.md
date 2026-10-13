First read `odd/prompts/_builder_head.md` completely and follow every rule in it. Also read `odd/tasks/arb-v2.md`. Then do the task below. Other agents work in parallel: the hasher agent is adding `extractImports` and `SymbolSignature.file/bodyHash/source` in `app/hasher/` right now. Code against the contract; do not edit `app/hasher/`.

# Task V3: Control plane — dependency inference and Jev semantic squash

## Allowed edit surfaces
app/control-plane/src/**
app/control-plane/test/**
app/control-plane/NOTES.md
app/control-plane/wrangler.toml

Do NOT deploy and do NOT run live scenarios. Integration happens in a later task (V4).

## Contract
`app/CONTRACTS.md`, every "(V2)" item:
- Entry fields `consumesInferred`, `forkedExports`, `bodies`, `judging`;
- Diagnosis `behavior-changed` + `judgment`;
- stats `judgments`, `semanticSquashes`, `inferredDeps`;
- optional `consumes` with inference;
- events `deps.inferred`, `deps.undeclared` (best effort), `jev.judged`, `jev.unavailable`;
- the "Jev semantic judgment" section: endpoint, payload, question, thresholds, staleness rule.

## Design (follow it; record deviations in NOTES.md with the reason)
`src/rob.ts` stays a pure state machine with zero Cloudflare imports. All I/O goes through effects.

1. **entry.create.** Without `consumes` but with `producerId`: `consumesInferred = true`, `consumes = {}`. New fields get defaults everywhere, including stored-state forward-fill (`{...initial, ...stored}`) and `reset`.
2. **fork.done.** Set `forkedExports` = the producer's `exports` at that moment (`{}` for trunk forks).
3. **push command.** It gains `imports?: ImportRef[]` and `bodies?: SymbolHashes`. Per-symbol `file` arrives via `sigs`. On a push of entry X:
   - store `X.bodies`;
   - **inference:** if `X.consumesInferred`, for each import whose `from` is a file declaring a symbol in the producer's exports, add each imported name the producer exports to `X.consumes` with value `X.forkedExports[name]`. Expand `"*"` to all of the producer's exports from that file. Emit `deps.inferred` (new names only) and count `stats.inferredDeps`. If a newly inferred name already differs from the producer's current `exports`, squash immediately with `interface-changed`, reusing the existing squash path.
   - **judge trigger:** if X is a producer, then for each non-retired, non-squashed consumer C and each `s` in `C.consumes` where X's interface hash for `s` is unchanged by this push but `bodies[s]` changed: keep today's `hash.unchanged` + early-cutoff behavior, add `s` to `C.judging`, and emit one effect `{ type: "judge", consumerId, producerId, symbols, commit, generation }` per consumer.
4. **New command `judge.done`** `{ consumerId, producerId, commit, generation, verdicts: Array<{ symbol, probability: number | null, model?: string, reason?: string }> }`:
   - drop it if the producer head is no longer `commit` or the consumer generation changed; still clear the matching `judging` entries;
   - `null` probability → `jev.unavailable`;
   - otherwise → `jev.judged` with verdict `squash` (>= 0.7), `warn` (>= 0.4) or `clear`;
   - any `squash` → squash C with reason `behavior-changed` and a `judgment` (highest probability). `changed[]` carries old/new bodyHash and the unchanged signature. Cascade to transitive dependents through the existing path (`producer-squashed`);
   - count `stats.judgments` (non-null verdicts) and `stats.semanticSquashes`.
5. **Retirement gate.** A consumer with a non-empty `judging` does not start checks or retirement.
6. **Sweep.** `judging` markers older than 60 s are cleared as unavailable (`jev.unavailable`, reason `stale`). Track timestamps internally.
7. **`src/jev.ts`.** `judgeBehavior(input, { apiKey, fetch, timeoutMs = 8000 })`:
   - one HTTP request per consumer, one Noul question per symbol, with question ids that are safe for any symbol name;
   - exact payload, question and criteria from the contract;
   - retry 429/529/5xx with 0.5 s then 1 s backoff, and an AbortController timeout per attempt;
   - 401/422/no key/exhausted retries → `probability: null` with a short sanitized reason;
   - never log or return the key or request headers.
8. **DO effects (`src/do.ts` / `src/effects.ts`).**
   - On push handling, also call the hasher's `extractImports` on the same file map and pass `imports` + `bodies` (from `SymbolSignature.bodyHash`) to rob.
   - Persist the producer's previous `source` per symbol in DO storage, outside `BufferState`, so the judge effect has `before`/`after`.
   - The `judge` effect:
     - reads the consumer's files at its headCommit, or baseCommit when it has none, through the same Artifacts read helpers the checker/retirer use, with retry;
     - selects the files whose imports reference the symbol's file; truncation is per contract;
     - calls `judgeBehavior` and feeds `judge.done`.
   - Wrap it in the existing per-effect try/catch, so a failure becomes `judge.done` with null probabilities.
9. **Env.** Optional `TYPESAFE_API_KEY` secret. Missing means unavailable, so v1 behavior; never crash. Add it to the Env type and to NOTES (how to set it, without any value).
10. **Router.** `ArbRouter` aggregates stats across components: include the 3 new stats. Make sure the new event types pass through the router and the WS fan-out unchanged.

## Tests (RED first, pure where possible)
Add `test/` coverage for:
- inference: named, `*`, a name not exported by the producer is ignored, immediate squash on drift, `deps.inferred` only for new names;
- judge trigger: body-only change triggers; interface change does not (it squashes as before); non-consumed symbol does not;
- `judge.done`: each threshold band, null → unavailable, stale commit dropped, stale generation dropped, cascade to grandchildren, stats;
- retirement blocked while judging, then proceeds after `clear`;
- sweep of stale `judging`;
- `jev.ts` with a fake fetch: exact request body, retry then success, 401 → null, timeout → null, no key → null, and the key never appears in results or thrown errors;
- reset and forward-fill defaults.

All 92+ existing tests stay green. Fix tests only where V2 changes documented behavior, and say which ones.

## Verification
- `npm test` in `app/control-plane`: counts.
- `npx tsc --noEmit` or the package's typecheck, if one exists: result.
- `npx wrangler deploy --dry-run --outdir tmp/v3-dry` builds: result. This is a dry run only; nothing is deployed.
- NOTES.md section "V2 (inference + Jev)": a finding → design → test table, plus known gaps.
