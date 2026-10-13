# spike-2b — DO alarm (2s) polling `repo.log({limit:1})` to detect pushes: latency + cost

Verdict: WORKS

## Measured (1 run; 10 pushes ~8s apart; 100.0s window)
- Detection latency = DO `detectedAt` − local `git push` completion (matched via `push i ts=<ms>` in commit message):
  503, 452, 701, 1110, 1298, 697, 390, 412, 1515, 907 ms → **median 699 ms, max 1515 ms**.
- 10/10 pushes detected as distinct HEADs; 0 errors, no rate limit hit.
- Cost: 48 alarm invocations = 48 `repo.log` calls over 100.0s → **1728 alarms + 1728 log calls/hr/repo** measured (theoretical 1800; period drifts ~2.08s because next alarm is scheduled after poll work).
- Poll wall time (`get`+`log`+dispose): min 13 / med 18 / avg 17.4 / max 25 ms. CPU-ms not separately exposed; DOs bill wall-clock → ~18ms × ~1730 ≈ **~31s DO active time/hr/repo**.

## Reproduce
- `npx wrangler artifacts repos create spike-2b-repo --namespace spike-2b --default-branch main` (namespace auto-created)
- Worker `spike-2b-poller` (`src/index.js`): DO `Spike2bPoller.alarm()` → `env.ARTIFACTS.get(REPO)` → `repo.log({limit:1})`, compare hash, store `{commit, detectedAt: Date.now()}`, `storage.setAlarm(now+2000)`. Routes: POST /start, GET /state, POST /stop.
- `git commit --allow-empty -m "push $i ts=$(date +%s%3N)" && git push` in a loop; parse `message` from detections.

## Caveats
- Detects HEAD-at-poll-time, not push events: bursts inside one 2s window collapse to newest commit (not triggered here).
- `ArtifactsCommitMetadata` = `{hash, treeHash, message, author, committer, parents, authoredAt, committedAt}`.
- Manual `Symbol.dispose` on repo handle worked inside `alarm()`; no leaks/errors observed over 48 polls.

## Cloudflare resources created
- Worker `spike-2b-poller` (DO class `Spike2bPoller`, spike-2b-poller.lautitomasalejo.workers.dev); Artifacts namespace `spike-2b`; repo `spike-2b-repo`.

## Recommendation
Solid fallback: ~0.4–1.5s detection at 2s polling for ~1.8k log calls and ~31s DO time per repo-hour; prefer event subscriptions when available.
