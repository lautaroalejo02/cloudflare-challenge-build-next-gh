# spike-2a — Kan en Worker modtage `cf.artifacts.repo.pushed` via event subscriptions, og hvor lang tid efter `git push`?

## Verdict: WORKS

## Målte tal (10 pushes, Windows local clock vs consumer `Date.now()`)
- E2E-latency (push_done → consumer receive, skew-korrigeret): 5.88, 4.77, 3.52, 2.51, 1.33, 5.07, 4.02, 2.93, 1.78, 5.03 s — **median 3.77 s, max 5.88 s**
- Pipeline-latency (`metadata.eventTimestamp` → receive, kun CF-clock): median 3.87 s, max 5.89 s
- Push-varighed: 0.90–1.49 s pr. push. Skew: worker-clock ≈ local −240 ms (3× GET /time, ±~120 ms); konsistent med at eventTimestamp ≈ push_done efter korrektion.
- Måde: consumer worker skrev `received_at` + hele eventet til KV (nøgle = `payload.after`-sha); pushes logget lokalt i `pushes.jsonl`; sammenholdt via commit-sha. Alle 10 events ankom (11 inkl. init-warm-up).

## Repro
`wrangler artifacts repos create spike-2a-repo --namespace spike-2a-ns` → `wrangler queues create spike-2a-queue` → `wrangler queues subscription create spike-2a-queue --source artifacts.repo --events pushed --source-namespace spike-2a-ns --source-repo-name spike-2a-repo` → deploy consumer (`worker.js`, `wrangler.toml`) → `git -c http.extraHeader="Authorization: Bearer $TOKEN" push origin HEAD:main` ×10 → GET `/dump`.

## Caveats / fejl / udokumenteret
- **wrangler 4.145.0 kan IKKE oprette repo-scoped subscription** — mangler `--source-namespace`/`--source-repo-name`; API svarer `Required at "source.namespace"; Required at "source.repo_name"`. Virker i 4.149.0.
- Events leveres i bølger/batches (~2–3 s intervaller); consumer `max_batch_timeout=5` kan bidrage til max-tiden.
- `wrangler artifacts namespaces create` findes ikke — namespacet oprettes implicit ved `repos create`.

## Cloudflare-ressourcer oprettet
- Namespace `spike-2a-ns`; repo `spike-2a-repo` (id `cce7n7dsoakaswpa`); repo-token i `.secret` (udløber 2026-10-19)
- Queue `spike-2a-queue`; subscription `spike-2a-push-sub` (id `d65036c0d0cb4cd6af6605c8f87be432`)
- KV `spike-2a-kv` (id `acf51f086194441faee47ce59e62112f`); Worker `spike-2a-consumer` (queue consumer, `/time`, `/dump`)

## Anbefaling
Brug push-events direkte — median ~3.8 s er fint til commit-drevet automation; ingen polling-fallback nødvendig for latency.
