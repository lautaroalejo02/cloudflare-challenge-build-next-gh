# Builder task: Agent Reorder Buffer (Cloudflare "Build the next GitHub" hackathon)

You are one of several agents building packages IN PARALLEL in one repository. Each agent owns exactly one directory. Repo root = your current working directory.

## Read first (mandatory)
1. `app/CONTRACTS.md`: the shared contracts. Code strictly against it.
2. `odd/tasks/agent-reorder-buffer.md`: the feature document (objective, acceptance criteria).
3. `spikes/SPIKES.md`: measured platform facts and caveats. The per-spike folders (`spikes/<id>/`) contain WORKING code you should reuse instead of rediscovering APIs:
   - spike 1: Artifacts binding round trip;
   - 2a: push events via Queue;
   - 3: fork / fork-of-fork;
   - 4: ts-morph hashing rules;
   - 5a: Sandbox;
   - 5b: Dynamic Workers;
   - 6: web-tree-sitter in a Worker, including the patched grammar wasm.

## Environment (verified)
- Windows 11, Git Bash, Node v22.15.1, npm 10.9.2, git 2.45.1, Docker 28.3 running.
- Cloudflare account `f3adabb2e83104cf7b9c244077547991` (Workers Paid). Wrangler OAuth is already logged in; never run `wrangler login`/`logout`.
- Install Wrangler locally in your package: `npm i -D wrangler@^4.149.0`.
- Docs: https://developers.cloudflare.com/artifacts/, https://developers.cloudflare.com/dynamic-workers/, https://developers.cloudflare.com/queues/. Fetch the exact page you need; check installed typings; never guess an API.

## Hard rules
- Edit ONLY inside your allowed edit surfaces (below). You may READ anything in the repo.
- Cloudflare resources:
  - Name them per `app/CONTRACTS.md` "Naming".
  - Never delete or modify Cloudflare resources you did not create.
  - Never touch resources prefixed `spike-`.
- Never change global git/npm config. Never print secrets into files that are committed. Secrets go in `.dev.vars`/`.secret*` (gitignored at repo root).
- Do NOT run `git commit`, `git push`, `git checkout`, `git stash` or any command that changes git state. The orchestrator commits.
- Language: all code, comments, docs and your final message in English.
- Tests: add focused automated tests for your package's core logic, and run them. When a deterministic test is possible, write it first and watch it fail (RED), then implement (GREEN). Never claim a test passed unless you ran it and saw it pass.
- Planning heuristic (advisory, not a gate): about 400 authored changed lines per coherent unit. Do not minify, drop tests or split artificially to fit it.
- Do not ask questions; no human is available. Make reasonable decisions and record them in your package's `NOTES.md`.
- Time box: 2 hours. If blocked more than 25 minutes on one thing, stop and document the blocker precisely (command, error, what you tried) in NOTES.md.

## Deliverable
- Working package in your directory, plus `NOTES.md` covering:
  - what was built;
  - how to run, test and deploy it;
  - decisions taken;
  - "Contract issues" (problems found in CONTRACTS.md, if any);
  - Cloudflare resources created;
  - known gaps.
- Final message:
  - a `## Result` section with status `complete | partial | blocked`;
  - each verification command you ran, with its observed result (`<command>: <observed result>`);
  - the list of files changed.
- Close your final message with a `## Key Learnings` block of 1-5 numbered, standalone factual sentences. Omit the block if there is nothing reusable.

## YOUR TASK
