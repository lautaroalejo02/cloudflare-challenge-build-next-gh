#!/usr/bin/env bash
# One-time Cloudflare resource setup for arb-control-plane.
# Requires Wrangler >= 4.149.0 (spike 2a: repo/namespace subscription flags).
set -euo pipefail
cd "$(dirname "$0")/.."

# Queue is also referenced as a consumer in wrangler.toml.
npx wrangler queues create arb-push-events || true

# Namespace-wide pushed-events subscription. Per-fork repo-scoped
# subscriptions would need --source artifacts.repo --source-repo-name <repo>
# per fork at runtime (REST API + API token inside the Worker, not deployed
# here). One namespace subscription covers arb-trunk and every arb-e* fork:
# source type "artifacts" + event "repo.pushed" delivers the same
# cf.artifacts.repo.pushed payload shape as the repo-scoped spike-2a one, and
# the consumer maps repo names to entries itself.
npx wrangler queues subscription create arb-push-events \
	--source artifacts \
	--events repo.pushed \
	--source-namespace arb \
	--name arb-ns-push-sub || true

npx wrangler deploy
