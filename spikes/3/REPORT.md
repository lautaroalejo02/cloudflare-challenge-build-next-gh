# spike-3: Artifacts fork semantics + fork burst limits

Question: from a Worker, fork a baseline repo (main + feature-x), push to fork, fork the fork; does fork-of-fork work, what does a fork carry, and do 10 rapid forks (seq + parallel) hit limits.

Verdict: WORKS

Measured (timings via Date.now() inside deployed Worker `spike-3-artifacts`, binding `ARTIFACTS`, namespace `spike-3`):
- create(spike-3-base): 1754ms cold (first call on fresh deploy errored `error code: 1042`; retry ok).
- fork #1 (base→fork-1): get 264ms + fork 2352ms.
- fork #2 (fork-1→fork-2, fork-of-fork): get 19ms + fork 1860ms — WORKS.
- Sequential burst, 10 forks: each fork() 1364–1883ms (get 10–62ms), wall 15783ms, 10/10 ok.
- Parallel burst (Promise.all), 10 forks: each fork() 1029–1658ms, wall 1920ms, 10/10 ok. No rate limit / error codes hit at n=10.

Semantics (verified via `git ls-remote` with the returned token):
- Default `fork()` copies ALL branches: fork-1 had main f7d1190c + feature-x 19c3fc0e. `defaultBranchOnly: true` opt exists to restrict.
- Fork-of-fork contains the fork's new commit: pushed dd6d662c to fork-1 main; fork-2 main/HEAD = dd6d662c, feature-x = 19c3fc0e.
- fork() returns {name, remote, defaultBranch, token}; repo is git-cloneable immediately after the call.

Repro: `npx wrangler deploy` (src/index.js, binding `artifacts:[{binding:"ARTIFACTS",namespace:"spike-3"}]`), then POST /create, git push, POST /fork, POST /burst {mode:"seq"|"par"}.

Caveats: transient `error code: 1042` on first cold request to the fresh Worker (not an Artifacts error; retry fixed). Bearer in `http.extraHeader` worked but git still hung prompting on ls-remote without creds — embed `x:<token-secret>@` in the URL (strip `?expires=` suffix) or set GIT_TERMINAL_PROMPT=0.

Resources created: Worker spike-3-artifacts; namespace spike-3; repos spike-3-base, spike-3-fork-1, spike-3-fork-2, spike-3-seq-0..9, spike-3-par-0..9 (23 repos).

Recommendation: forks are cheap (~1–2s, parallel-safe at n=10) and complete — use fork-per-session freely; pass defaultBranchOnly only if you want to hide side branches.
