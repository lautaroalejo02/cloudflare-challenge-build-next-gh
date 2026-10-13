# spike-5a — Artifacts fork → Sandbox `npm test` from a Worker

**Question:** Can a Worker mint an Artifacts read token, clone a fork into a Sandbox SDK container, run `npm ci && npm test`, and return the result? Pass = <30s warm.
**Verdict: WORKS**

## Measured (timings inside Worker via `Date.now()`, exit 0, tests 2/2 pass)
- Cold (first request, container start): **total 39.6s** — token 0.4s, clone 37.2s (incl. sandbox boot), `npm ci` 1.6s, `npm test` 0.5s
- Warm ×3 (same sandbox id `spike-5a`, fresh clone each time): **totals 18.8 / 20.2 / 20.7 s** — clone 1.4/2.0/2.3s, `npm ci` 9.3/10.9/9.8s, `npm test` 8.0/6.9/8.3s (npm startup dominates; actual `node:test` run = 240ms)
- Sandbox image `cloudflare/sandbox:0.12.10`: node v22.23.2, npm 10.9.8, git 2.34.1

## Repro
```ts
using repo = await env.ARTIFACTS.get("spike-5a-fork");
const remote = (await repo.info()).remote;
const tok = (await repo.createToken("read", 3600)).plaintext.split("?expires=")[0];
const sb = getSandbox(env.SANDBOX, "spike-5a");
await sb.setEnvVars({ R: `https://x:${tok}@${remote.slice(8)}` });
await sb.exec('git clone "$R" /workspace/repo');
await sb.exec("npm ci", { cwd: "/workspace/repo" });
const t = await sb.exec("npm test", { cwd: "/workspace/repo" }); // t.exitCode, t.stdout
```
Fixture: `npm test` = `node --experimental-strip-types --test test/order.test.ts` (no build step, zero deps).

## Caveats / undocumented behavior
- `docker push` to `registry.cloudflare.com` through Docker Desktop's proxy (`http.docker.internal:3128`) dies mid-upload ("use of closed network connection"); workaround: push blobs via chunked PATCH — **non-final PATCHes must be ≥5MiB** (R2 multipart; smaller → 416 `RANGE_ERROR`), then `crane push` writes only the manifest.
- `containers[].image` accepts a pre-pushed `registry.cloudflare.com/<acct>/<name>:<tag>` URI → wrangler skips build/push entirely.
- DO class can be renamed (`export { Sandbox as Spike5aSandbox }`) — prefix rule satisfied.

## Resources created (left in place)
Worker `spike-5a` (DO class `Spike5aSandbox`, container app `spike-5a-spike5asandbox`, image tag `eb187c4e`); Artifacts namespace `spike-5a` with repos `spike-5a-base`, `spike-5a-fork`.

**Recommendation:** Viable for run-tests-on-fork; warm ~20s is almost all npm startup — invoke `node --test` directly or pool sandboxes to cut it.
