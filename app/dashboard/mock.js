/* Mock replay of the Idea-3 demo scene: API pushes a signature change mid-run,
 * UI + Tests are squashed and re-forked, entries retire onto trunk by
 * fast-forward and splice, and a docs entry is squashed on trunk overlap.
 * Payloads mirror what the deployed control plane emits on /api/ws
 * (app/control-plane/src/rob.ts): flat per-event fields, no data.entry.
 * Exposed as window.ArbMock / module.exports. */
(function (root, factory) {
  var api = factory();
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.ArbMock = api;
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  function clone(o) { return JSON.parse(JSON.stringify(o)); }

  /* Build the scripted timeline: [{at, ev}] with `at` in ms from replay start. */
  function build() {
    var CHANGED = [{
      symbol: 'createOrder', oldHash: 'a91f3b2c10d4', newHash: 'c07e55aa11bb',
      oldSignature: 'createOrder(input: OrderInput): Promise<Order>',
      newSignature: 'createOrder(input: OrderInput, opts: OrderOpts): Promise<Order>'
    }];
    var TRUNK_C = { e1: 'ff1122334455', e2: '66aabbccddee', e3: '77ffee001122', e4: '88cc99887766' };

    function ev(type, entryId, data) { return { type: type, entryId: entryId, data: data }; }
    var steps = [];
    function at(ms, e) { steps.push({ at: ms, ev: e }); }

    at(0, ev('snapshot', null, {
      trunk: { repo: 'arb-trunk', commit: 'aa00bb11cc22', retiredCount: 0 },
      robSize: 8, entries: [],
      stats: { squashes: 0, earlyCutoffs: 0, retired: 0, checksRun: 0, pushesSeen: 0 }
    }));

    // t≈0: four entries. UI + Tests fork the API agent's unfinished fork
    // (speculative forwarding); docs forks straight from trunk.
    at(400, ev('entry.created', 'e1', { agent: 'api-agent', lane: 'api', seq: 1, producerId: null, repo: 'arb-e1-api-0' }));
    at(1000, ev('entry.created', 'e2', { agent: 'ui-agent', lane: 'ui', seq: 2, producerId: 'e1', repo: 'arb-e2-ui-0' }));
    at(1600, ev('entry.created', 'e3', { agent: 'test-agent', lane: 'tests', seq: 3, producerId: 'e1', repo: 'arb-e3-tests-0' }));
    at(2200, ev('entry.created', 'e4', { agent: 'docs-agent', lane: 'docs', seq: 4, producerId: null, repo: 'arb-e4-docs-0' }));

    // Forks land: the dashboard picks up exports/consumes on its next state
    // pull — simulated here with a second snapshot, as in live mode.
    at(3000, ev('snapshot', null, {
      trunk: { repo: 'arb-trunk', commit: 'aa00bb11cc22', retiredCount: 0 },
      robSize: 8,
      entries: [
        { id: 'e1', seq: 1, agent: 'api-agent', lane: 'api', status: 'speculating',
          repo: 'arb-e1-api-0', remote: 'https://artifacts.example/arb/arb-e1-api-0',
          producerId: null, baseCommit: 'aa00bb11cc22', headCommit: 'aa00bb11cc22',
          exports: { createOrder: 'a91f3b2c10d4', Order: '77aa02be9910' }, consumes: {},
          generation: 0, diagnosis: null, checks: null },
        { id: 'e2', seq: 2, agent: 'ui-agent', lane: 'ui', status: 'speculating',
          repo: 'arb-e2-ui-0', remote: 'https://artifacts.example/arb/arb-e2-ui-0',
          producerId: 'e1', baseCommit: 'aa00bb11cc22', headCommit: 'aa00bb11cc22',
          exports: { CheckoutForm: 'b21c8f440e55' }, consumes: { createOrder: 'a91f3b2c10d4' },
          generation: 0, diagnosis: null, checks: null },
        { id: 'e3', seq: 3, agent: 'test-agent', lane: 'tests', status: 'speculating',
          repo: 'arb-e3-tests-0', remote: 'https://artifacts.example/arb/arb-e3-tests-0',
          producerId: 'e1', baseCommit: 'aa00bb11cc22', headCommit: 'aa00bb11cc22',
          exports: {}, consumes: { createOrder: 'a91f3b2c10d4', Order: '77aa02be9910' },
          generation: 0, diagnosis: null, checks: null },
        { id: 'e4', seq: 4, agent: 'docs-agent', lane: 'docs', status: 'speculating',
          repo: 'arb-e4-docs-0', remote: 'https://artifacts.example/arb/arb-e4-docs-0',
          producerId: null, baseCommit: 'aa00bb11cc22', headCommit: 'aa00bb11cc22',
          exports: {}, consumes: {},
          generation: 0, diagnosis: null, checks: null }
      ],
      stats: { squashes: 0, earlyCutoffs: 0, retired: 0, checksRun: 0, pushesSeen: 0 }
    }));

    // docs agent pushes its work early; body-only producer push → early cutoff
    // on BOTH consumers (the control plane emits one per live consumer).
    at(3200, ev('push', 'e4', { repo: 'arb-e4-docs-0', commit: 'b0bacafe0004' }));
    at(3600, ev('push', 'e1', { repo: 'arb-e1-api-0', commit: 'c1a2b3c9d4e5' }));
    at(4300, ev('hash.unchanged', 'e2', { producerId: 'e1', commit: 'c1a2b3c9d4e5' }));
    at(4500, ev('hash.unchanged', 'e3', { producerId: 'e1', commit: 'c1a2b3c9d4e5' }));

    // signature change: createOrder's hash flips, consumers squash + refork
    at(5800, ev('push', 'e1', { repo: 'arb-e1-api-0', commit: 'd4e5f6071829' }));
    at(6900, ev('hash.changed', 'e2', { producerId: 'e1', commit: 'd4e5f6071829', changed: clone(CHANGED) }));
    at(7000, ev('squash', 'e2', { reason: 'interface-changed', changed: clone(CHANGED), generation: 1, repo: 'arb-e2-ui-1' }));
    at(7050, ev('hash.changed', 'e3', { producerId: 'e1', commit: 'd4e5f6071829', changed: clone(CHANGED) }));
    at(7150, ev('squash', 'e3', { reason: 'interface-changed', changed: clone(CHANGED), generation: 1, repo: 'arb-e3-tests-1' }));
    at(8200, ev('refork', 'e2', { repo: 'arb-e2-ui-1', baseCommit: 'd4e5f6071829', generation: 1 }));
    at(8400, ev('refork', 'e3', { repo: 'arb-e3-tests-1', baseCommit: 'd4e5f6071829', generation: 1 }));

    // agents redo work, mark ready; in-order retirement begins with e1
    at(9000, ev('ready', 'e1', { commit: 'd4e5f6071829' }));
    at(9800, ev('ready', 'e4', { commit: 'b0bacafe0004' }));
    at(10200, ev('check.started', 'e1', { commit: 'd4e5f6071829' }));
    at(11000, ev('check.passed', 'e1', { commit: 'd4e5f6071829', durationMs: 241 }));
    // e1 fast-forwards: trunk head is an ancestor of its head.
    at(11000, ev('push', 'e2', { repo: 'arb-e2-ui-1', commit: 'e5f6a7b8c9d0' }));
    at(11600, ev('retired', 'e1', { commit: TRUNK_C.e1, seq: 1, mode: 'fast-forward' }));

    at(12200, ev('ready', 'e2', { commit: 'e5f6a7b8c9d0' }));
    at(12500, ev('push', 'e3', { repo: 'arb-e3-tests-1', commit: 'aabbccddeeff' }));
    at(12800, ev('check.started', 'e2', { commit: 'e5f6a7b8c9d0' }));
    at(13600, ev('check.passed', 'e2', { commit: 'e5f6a7b8c9d0', durationMs: 189 }));
    // e2 splices: trunk moved since its base, but paths are disjoint.
    at(14200, ev('retired', 'e2', { commit: TRUNK_C.e2, seq: 2, mode: 'splice' }));

    // e3 fails its check, the agent pushes a fix, then it passes and retires.
    at(14600, ev('ready', 'e3', { commit: 'aabbccddeeff' }));
    at(15000, ev('check.started', 'e3', { commit: 'aabbccddeeff' }));
    at(15800, ev('check.failed', 'e3', { commit: 'aabbccddeeff', durationMs: 203, failed: 1 }));
    at(16800, ev('push', 'e3', { repo: 'arb-e3-tests-1', commit: '112233445566' }));
    at(17400, ev('ready', 'e3', { commit: '112233445566' }));
    at(18000, ev('check.started', 'e3', { commit: '112233445566' }));
    at(18700, ev('check.passed', 'e3', { commit: '112233445566', durationMs: 196 }));
    at(19300, ev('retired', 'e3', { commit: TRUNK_C.e3, seq: 3, mode: 'splice' }));

    // e4's turn: the retirer finds its changed paths overlap the trunk churn —
    // it is squashed onto a fresh trunk fork, re-applies, then lands.
    at(19900, ev('check.started', 'e4', { commit: 'b0bacafe0004' }));
    at(20500, ev('check.passed', 'e4', { commit: 'b0bacafe0004', durationMs: 178 }));
    at(21200, ev('squash', 'e4', { reason: 'trunk-overlap', changed: [], generation: 1, repo: 'arb-e4-docs-1', producerCommit: TRUNK_C.e3 }));
    at(22100, ev('refork', 'e4', { repo: 'arb-e4-docs-1', baseCommit: TRUNK_C.e3, generation: 1 }));
    at(22900, ev('push', 'e4', { repo: 'arb-e4-docs-1', commit: 'd0c5f00d1234' }));
    at(23500, ev('ready', 'e4', { commit: 'd0c5f00d1234' }));
    at(24100, ev('check.started', 'e4', { commit: 'd0c5f00d1234' }));
    at(24700, ev('check.passed', 'e4', { commit: 'd0c5f00d1234', durationMs: 154 }));
    at(25300, ev('retired', 'e4', { commit: TRUNK_C.e4, seq: 4, mode: 'splice' }));

    return steps;
  }

  /* Replay the script, calling emit(ev) on schedule. Returns total duration. */
  function run(emit) {
    var steps = build();
    steps.forEach(function (s) {
      setTimeout(function () {
        var ev = clone(s.ev);
        ev.ts = Date.now();
        emit(ev);
      }, s.at);
    });
    return steps.length ? steps[steps.length - 1].at : 0;
  }

  return { build: build, run: run };
});
