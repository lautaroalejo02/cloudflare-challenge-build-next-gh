# spike-1 — Worker Artifacts binding: create repo -> mint write token -> git push from local clone -> readFile back. Pass bar: full cycle < 10s.

**Verdict: WORKS**

## Measured (6 runs, wall-clock on client via `performance.now()`, each run = fresh repo)
| run | create | token | clone | push | readFile | total ms | exact match |
|-----|--------|-------|-------|------|----------|----------|-------------|
| 1 | 2906 | 155 | 1054 | 1716 | 146 | 5977 | yes |
| 2 | 1350 | 120 | 1246 | 1328 | 233 | 4276 | yes |
| 3 | 1093 | 135 | 878 | 1159 | 169 | 3434 | yes |
| 4 | 1681 | 190 | 971 | 1041 | 283 | 4166 | yes |
| 5 | 1008 | 151 | 809 | 1167 | 218 | 3353 | yes |
| 6 | 1721 | 160 | 1068 | 1399 | 204 | 4551 | yes |

Median total: **4276 ms** (min 3353, max 5977). `readFile` returned byte-exact pushed content every run; no consistency delay needed.

## Repro
1. `wrangler.toml`: `[[artifacts]] binding="ARTIFACTS" namespace="spike-1"`, `workers_dev=true`; `npx wrangler deploy` (wrangler 4.145.0).
2. Worker routes: `POST /repos` -> `env.ARTIFACTS.create(name,{setDefaultBranch:"main"})` returns `{name,remote}`; `POST /tokens` -> `env.ARTIFACTS.get(name)` then `repo.createToken("write",600)` returns `{plaintext}`; `GET /file` -> `repo.readFile({ref:"main",path})` returns `Blob|null`.
3. Local: `git -c http.extraHeader="Authorization: Bearer <plaintext>" clone <remote>`; commit; same `extraHeader` form for `git push -u origin main`; then `GET /file`.

## Caveats
- `ArtifactsRepo` is a disposable RPC capability; use `using` (docs warn handle must be released before request ends). `readFile` returns a `Blob`, not text — call `.text()`.
- `create()` is the slowest phase (1.0-2.9s, first call cold); git push is protocol v1 only (docs); repo must not be `readOnly`.
- First run slowest (cold start); no retry/read-after-write wait was needed on any run.

## Cloudflare resources created
- Worker `spike-1-artifacts-rt` (secret `SPIKE_SECRET`), namespace `spike-1`, repos `spike-1-run1-5c4d05b5`, `-run2-f1d93011`, `-run3-2222a96f`, `-run4-bcf01dc5`, `-run5-e6646472`, `-run6-88aa64f1`.

## Recommendation
Proceed: binding round-trip is reliable and ~4.3s median, ~2x under budget; budget ~3s headroom for `create()` variance.
