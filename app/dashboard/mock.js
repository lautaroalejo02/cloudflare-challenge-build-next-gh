/* Mock replay of the Idea-3 demo scene: the API agent declares a stub at
 * registration and consumers forward against it before it writes anything.
 * Its first real push scores the predictions — createOrder hits, Order misses
 * and squashes the UI agent. A later breaking change squashes consumers as an
 * ordinary interface change, a body-only push early-cuts-off, entries retire
 * onto trunk by fast-forward and splice, and a docs entry is squashed on
 * trunk overlap. Payloads mirror what the deployed control plane emits on
 * /api/ws (app/control-plane/src/rob.ts): flat per-event fields, no data.entry.
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
    // Declared-stub hashes (what e1 promised) vs what each push delivered.
    var P1 = 'a91f3b2c10d4'; // createOrder, declared == delivered on push 1
    var P2 = '77aa02be9910'; // Order, declared WITHOUT currency
    var O2 = 'c4d5e6f7a8b9'; // Order, delivered on push 1 WITH currency
    var C2 = 'c07e55aa11bb'; // createOrder, v2 options-object signature
    var SIG_V1_FN = 'fn createOrder(cart: Cart, region: string): Order';
    var SIG_V2_FN = 'fn createOrder(cart: Cart, opts: { region: string; currency: string }): Order';
    var SIG_ORD_V1 = 'interface Order{id:string;region:string;itemCount:number;totalCents:number}';
    var SIG_ORD_V11 = 'interface Order{id:string;region:string;currency:string;itemCount:number;totalCents:number}';

    var ORDER_MISS = [{
      symbol: 'Order', oldHash: P2, newHash: O2,
      oldSignature: SIG_ORD_V1, newSignature: SIG_ORD_V11
    }];
    var CHANGED_FN = [{
      symbol: 'createOrder', oldHash: P1, newHash: C2,
      oldSignature: SIG_V1_FN, newSignature: SIG_V2_FN
    }];
    var TRUNK_C = { e1: 'ff1122334455', e2: '66aabbccddee', e3: '77ffee001122', e4: '88cc99887766' };

    function ev(type, entryId, data) { return { type: type, entryId: entryId, data: data }; }
    var steps = [];
    function at(ms, e) { steps.push({ at: ms, ev: e }); }

    at(0, ev('snapshot', null, {
      trunk: { repo: 'arb-trunk', commit: 'aa00bb11cc22', retiredCount: 0 },
      robSize: 8, entries: [],
      stats: { squashes: 0, earlyCutoffs: 0, retired: 0, checksRun: 0, pushesSeen: 0, predictionHits: 0, predictionMisses: 0 }
    }));

    // t≈0: the API agent registers WITH a declared stub — its exports are
    // predicted hashes, not repo content. UI + Tests register immediately and
    // forward against the declared hashes; docs forks straight from trunk.
    at(400, ev('entry.created', 'e1', { agent: 'api-agent', lane: 'api', seq: 1, producerId: null, repo: 'arb-e1-api-0',
      exports: { createOrder: P1, Order: P2 }, consumes: {}, predicted: ['createOrder', 'Order'] }));
    at(1000, ev('entry.created', 'e2', { agent: 'ui-agent', lane: 'ui', seq: 2, producerId: 'e1', repo: 'arb-e2-ui-0',
      exports: { CheckoutForm: 'b21c8f440e55' }, consumes: { createOrder: P1, Order: P2 } }));
    at(1600, ev('entry.created', 'e3', { agent: 'test-agent', lane: 'tests', seq: 3, producerId: 'e1', repo: 'arb-e3-tests-0',
      exports: {}, consumes: { createOrder: P1 } }));
    at(2200, ev('entry.created', 'e4', { agent: 'docs-agent', lane: 'docs', seq: 4, producerId: null, repo: 'arb-e4-docs-0' }));

    // Forks land: the dashboard picks up exports/consumes/predicted on its
    // next state pull — simulated here with a second snapshot, as in live mode.
    at(3000, ev('snapshot', null, {
      trunk: { repo: 'arb-trunk', commit: 'aa00bb11cc22', retiredCount: 0 },
      robSize: 8,
      entries: [
        { id: 'e1', seq: 1, agent: 'api-agent', lane: 'api', status: 'speculating',
          repo: 'arb-e1-api-0', remote: 'https://artifacts.example/arb/arb-e1-api-0',
          producerId: null, baseCommit: 'aa00bb11cc22', headCommit: 'aa00bb11cc22',
          exports: { createOrder: P1, Order: P2 }, consumes: {}, predicted: ['createOrder', 'Order'],
          generation: 0, diagnosis: null, checks: null },
        { id: 'e2', seq: 2, agent: 'ui-agent', lane: 'ui', status: 'speculating',
          repo: 'arb-e2-ui-0', remote: 'https://artifacts.example/arb/arb-e2-ui-0',
          producerId: 'e1', baseCommit: 'aa00bb11cc22', headCommit: 'aa00bb11cc22',
          exports: { CheckoutForm: 'b21c8f440e55' }, consumes: { createOrder: P1, Order: P2 }, predicted: [],
          generation: 0, diagnosis: null, checks: null },
        { id: 'e3', seq: 3, agent: 'test-agent', lane: 'tests', status: 'speculating',
          repo: 'arb-e3-tests-0', remote: 'https://artifacts.example/arb/arb-e3-tests-0',
          producerId: 'e1', baseCommit: 'aa00bb11cc22', headCommit: 'aa00bb11cc22',
          exports: {}, consumes: { createOrder: P1 }, predicted: [],
          generation: 0, diagnosis: null, checks: null },
        { id: 'e4', seq: 4, agent: 'docs-agent', lane: 'docs', status: 'speculating',
          repo: 'arb-e4-docs-0', remote: 'https://artifacts.example/arb/arb-e4-docs-0',
          producerId: null, baseCommit: 'aa00bb11cc22', headCommit: 'aa00bb11cc22',
          exports: {}, consumes: {}, predicted: [],
          generation: 0, diagnosis: null, checks: null }
      ],
      stats: { squashes: 0, earlyCutoffs: 0, retired: 0, checksRun: 0, pushesSeen: 0, predictionHits: 0, predictionMisses: 0 }
    }));

    // docs agent pushes its work early.
    at(3200, ev('push', 'e4', { repo: 'arb-e4-docs-0', commit: 'b0bacafe0004' }));

    // e1's FIRST REAL PUSH resolves the declared-stub predictions per consumed
    // symbol, per consumer: createOrder lands exactly as declared (hit for
    // both consumers); Order gained an undeclared field (miss for e2, the only
    // Order consumer — squashed with reason prediction-miss).
    at(3600, ev('push', 'e1', { repo: 'arb-e1-api-0', commit: 'c1a2b3c9d4e5' }));
    at(4300, ev('prediction.hit', 'e2', { producerId: 'e1', symbol: 'createOrder', hash: P1, commit: 'c1a2b3c9d4e5' }));
    at(4350, ev('prediction.miss', 'e2', { producerId: 'e1', symbol: 'Order',
      predictedHash: P2, actualHash: O2,
      predictedSignature: SIG_ORD_V1, actualSignature: SIG_ORD_V11,
      commit: 'c1a2b3c9d4e5' }));
    at(4400, ev('prediction.hit', 'e3', { producerId: 'e1', symbol: 'createOrder', hash: P1, commit: 'c1a2b3c9d4e5' }));
    at(4500, ev('hash.changed', 'e2', { producerId: 'e1', commit: 'c1a2b3c9d4e5', changed: clone(ORDER_MISS) }));
    at(4600, ev('squash', 'e2', { reason: 'prediction-miss', changed: clone(ORDER_MISS), generation: 1, repo: 'arb-e2-ui-1' }));
    at(5700, ev('refork', 'e2', { repo: 'arb-e2-ui-1', baseCommit: 'c1a2b3c9d4e5', generation: 1 }));

    // Later breaking change: createOrder flips to the options-object form —
    // an ordinary interface-changed squash for both consumers.
    at(6400, ev('push', 'e1', { repo: 'arb-e1-api-0', commit: 'd4e5f6071829' }));
    at(7200, ev('hash.changed', 'e2', { producerId: 'e1', commit: 'd4e5f6071829', changed: clone(CHANGED_FN) }));
    at(7300, ev('squash', 'e2', { reason: 'interface-changed', changed: clone(CHANGED_FN), generation: 2, repo: 'arb-e2-ui-2' }));
    at(7350, ev('hash.changed', 'e3', { producerId: 'e1', commit: 'd4e5f6071829', changed: clone(CHANGED_FN) }));
    at(7450, ev('squash', 'e3', { reason: 'interface-changed', changed: clone(CHANGED_FN), generation: 1, repo: 'arb-e3-tests-1' }));
    at(8200, ev('refork', 'e2', { repo: 'arb-e2-ui-2', baseCommit: 'd4e5f6071829', generation: 2 }));
    at(8400, ev('refork', 'e3', { repo: 'arb-e3-tests-1', baseCommit: 'd4e5f6071829', generation: 1 }));

    // Body-only push: consumed hashes unchanged → early cutoff per consumer.
    at(9000, ev('push', 'e1', { repo: 'arb-e1-api-0', commit: 'f00dba5e0003' }));
    at(9700, ev('hash.unchanged', 'e2', { producerId: 'e1', commit: 'f00dba5e0003' }));
    at(9800, ev('hash.unchanged', 'e3', { producerId: 'e1', commit: 'f00dba5e0003' }));

    // agents redo work, mark ready; in-order retirement begins with e1
    at(10400, ev('ready', 'e1', { commit: 'f00dba5e0003' }));
    at(10800, ev('ready', 'e4', { commit: 'b0bacafe0004' }));
    at(11200, ev('check.started', 'e1', { commit: 'f00dba5e0003' }));
    at(12000, ev('check.passed', 'e1', { commit: 'f00dba5e0003', durationMs: 241 }));
    // e1 fast-forwards: trunk head is an ancestor of its head.
    at(12000, ev('push', 'e2', { repo: 'arb-e2-ui-2', commit: 'e5f6a7b8c9d0' }));
    at(12600, ev('retired', 'e1', { commit: TRUNK_C.e1, seq: 1, mode: 'fast-forward' }));

    at(13200, ev('ready', 'e2', { commit: 'e5f6a7b8c9d0' }));
    at(13500, ev('push', 'e3', { repo: 'arb-e3-tests-1', commit: 'aabbccddeeff' }));
    at(13800, ev('check.started', 'e2', { commit: 'e5f6a7b8c9d0' }));
    at(14600, ev('check.passed', 'e2', { commit: 'e5f6a7b8c9d0', durationMs: 189 }));
    // e2 splices: trunk moved since its base, but paths are disjoint.
    at(15200, ev('retired', 'e2', { commit: TRUNK_C.e2, seq: 2, mode: 'splice' }));

    // e3 fails its check, the agent pushes a fix, then it passes and retires.
    at(15600, ev('ready', 'e3', { commit: 'aabbccddeeff' }));
    at(16000, ev('check.started', 'e3', { commit: 'aabbccddeeff' }));
    at(16800, ev('check.failed', 'e3', { commit: 'aabbccddeeff', durationMs: 203, failed: 1 }));
    at(17800, ev('push', 'e3', { repo: 'arb-e3-tests-1', commit: '112233445566' }));
    at(18400, ev('ready', 'e3', { commit: '112233445566' }));
    at(19000, ev('check.started', 'e3', { commit: '112233445566' }));
    at(19700, ev('check.passed', 'e3', { commit: '112233445566', durationMs: 196 }));
    at(20300, ev('retired', 'e3', { commit: TRUNK_C.e3, seq: 3, mode: 'splice' }));

    // e4's turn: the retirer finds its changed paths overlap the trunk churn —
    // it is squashed onto a fresh trunk fork, re-applies, then lands.
    at(20900, ev('check.started', 'e4', { commit: 'b0bacafe0004' }));
    at(21500, ev('check.passed', 'e4', { commit: 'b0bacafe0004', durationMs: 178 }));
    at(22200, ev('squash', 'e4', { reason: 'trunk-overlap', changed: [], generation: 1, repo: 'arb-e4-docs-1', producerCommit: TRUNK_C.e3 }));
    at(23100, ev('refork', 'e4', { repo: 'arb-e4-docs-1', baseCommit: TRUNK_C.e3, generation: 1 }));
    at(23900, ev('push', 'e4', { repo: 'arb-e4-docs-1', commit: 'd0c5f00d1234' }));
    at(24500, ev('ready', 'e4', { commit: 'd0c5f00d1234' }));
    at(25100, ev('check.started', 'e4', { commit: 'd0c5f00d1234' }));
    at(25700, ev('check.passed', 'e4', { commit: 'd0c5f00d1234', durationMs: 154 }));
    at(26300, ev('retired', 'e4', { commit: TRUNK_C.e4, seq: 4, mode: 'splice' }));

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
