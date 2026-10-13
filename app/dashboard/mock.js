/* Mock replay of the Idea-3 demo scene: API pushes a signature change mid-run,
 * UI + Tests are squashed and re-forked, then all three retire onto trunk.
 * Emits the same ArbEvent stream the control plane sends on /api/ws.
 * No server needed. Exposed as window.ArbMock / module.exports. */
(function (root, factory) {
  var api = factory();
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.ArbMock = api;
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  function clone(o) { return JSON.parse(JSON.stringify(o)); }

  /* Build the scripted timeline: [{at, ev}] with `at` in ms from replay start.
   * Payloads mirror what a reasonable control plane emits: most entry events
   * carry the full updated `data.entry`. */
  function build() {
    var E1 = {
      id: 'e1', seq: 1, agent: 'api-agent', lane: 'api', status: 'speculating',
      repo: 'arb-e1-api-0', remote: 'https://artifacts.example/arb/arb-e1-api-0',
      producerId: null, baseCommit: 'aa00bb11cc22', headCommit: null,
      exports: { createOrder: 'a91f3b2c10d4', Order: '77aa02be9910' },
      consumes: {}, generation: 0, diagnosis: null, checks: null
    };
    var E2 = {
      id: 'e2', seq: 2, agent: 'ui-agent', lane: 'ui', status: 'speculating',
      repo: 'arb-e2-ui-0', remote: 'https://artifacts.example/arb/arb-e2-ui-0',
      producerId: 'e1', baseCommit: 'aa00bb11cc22', headCommit: null,
      exports: { CheckoutForm: 'b21c8f440e55' },
      consumes: { createOrder: 'a91f3b2c10d4' }, generation: 0, diagnosis: null, checks: null
    };
    var E3 = {
      id: 'e3', seq: 3, agent: 'test-agent', lane: 'tests', status: 'speculating',
      repo: 'arb-e3-tests-0', remote: 'https://artifacts.example/arb/arb-e3-tests-0',
      producerId: 'e1', baseCommit: 'aa00bb11cc22', headCommit: null,
      exports: {},
      consumes: { createOrder: 'a91f3b2c10d4', Order: '77aa02be9910' },
      generation: 0, diagnosis: null, checks: null
    };

    var DIAG = {
      reason: 'interface-changed',
      changed: [{
        symbol: 'createOrder', oldHash: 'a91f3b2c10d4', newHash: 'c07e55aa11bb',
        oldSignature: 'createOrder(input: OrderInput): Promise<Order>',
        newSignature: 'createOrder(input: OrderInput, opts: OrderOpts): Promise<Order>'
      }],
      producerCommit: 'd4e5f6071829'
    };
    function checks(c, p, f, ms, results) {
      return { commit: c, passed: p, failed: f, durationMs: ms, results: results };
    }
    var CHECKS_OK = {
      e1: checks('c1a2b3c9d4e5', 3, 0, 241, [
        { name: 'tests/order.test.ts: creates order', ok: true },
        { name: 'tests/order.test.ts: totals line items', ok: true },
        { name: 'tests/order.test.ts: rejects empty order', ok: true }]),
      e2: checks('e5f6a7b8c9d0', 2, 0, 189, [
        { name: 'tests/ui.test.ts: renders checkout', ok: true },
        { name: 'tests/ui.test.ts: binds createOrder', ok: true }]),
      e3fail: checks('aabbccddeeff', 1, 1, 203, [
        { name: 'tests/order.test.ts: creates order', ok: true },
        { name: 'tests/order.test.ts: applies discount', ok: false, error: 'expected 42, got 40' }]),
      e3ok: checks('112233445566', 2, 0, 196, [
        { name: 'tests/order.test.ts: creates order', ok: true },
        { name: 'tests/order.test.ts: applies discount', ok: true }])
    };
    var TRUNK = { repo: 'arb-trunk', commit: null, retiredCount: 0 };

    function ev(type, entryId, data) { return { type: type, entryId: entryId, data: data }; }
    var steps = [];
    function at(ms, e) { steps.push({ at: ms, ev: e }); }

    at(0, ev('snapshot', null, {
      trunk: clone(TRUNK), robSize: 8, entries: [],
      stats: { squashes: 0, earlyCutoffs: 0, retired: 0, checksRun: 0, pushesSeen: 0 }
    }));

    // t≈0: three entries, UI and Tests fork the API agent's unfinished fork
    at(400, ev('entry.created', 'e1', { entry: clone(E1) }));
    at(1000, ev('entry.created', 'e2', { entry: clone(E2) }));
    at(1600, ev('entry.created', 'e3', { entry: clone(E3) }));

    // body-only producer push: early cutoff, nothing squashes
    E1.headCommit = 'c1a2b3c9d4e5';
    at(2600, ev('push', 'e1', { commit: 'c1a2b3c9d4e5' }));
    at(3100, ev('hash.unchanged', 'e1', { symbol: 'createOrder', commit: 'c1a2b3c9d4e5' }));

    // signature change: hash flips a91f → c07e, consumers squash + refork
    E1.headCommit = 'd4e5f6071829';
    at(4400, ev('push', 'e1', { commit: 'd4e5f6071829' }));
    E1.exports.createOrder = 'c07e55aa11bb';
    at(4900, ev('hash.changed', 'e1', {
      entry: clone(E1),
      changed: [{ symbol: 'createOrder', oldHash: 'a91f3b2c10d4', newHash: 'c07e55aa11bb' }]
    }));
    E2.status = 'squashed'; E2.generation = 1; E2.diagnosis = clone(DIAG);
    E3.status = 'squashed'; E3.generation = 1; E3.diagnosis = clone(DIAG);
    at(5400, ev('squash', 'e2', { entry: clone(E2), diagnosis: clone(DIAG) }));
    at(5900, ev('squash', 'e3', { entry: clone(E3), diagnosis: clone(DIAG) }));
    E2.status = 'speculating'; E2.repo = 'arb-e2-ui-1'; E2.baseCommit = 'd4e5f6071829';
    E3.status = 'speculating'; E3.repo = 'arb-e3-tests-1'; E3.baseCommit = 'd4e5f6071829';
    at(6600, ev('refork', 'e2', { entry: clone(E2) }));
    at(7100, ev('refork', 'e3', { entry: clone(E3) }));

    // agents redo work, mark ready
    E1.status = 'ready';
    at(8000, ev('ready', 'e1', { commit: 'd4e5f6071829' }));
    E2.status = 'ready'; E2.headCommit = 'e5f6a7b8c9d0'; E2.diagnosis = null;
    at(8600, ev('ready', 'e2', { commit: 'e5f6a7b8c9d0' }));
    E3.status = 'ready'; E3.headCommit = 'aabbccddeeff'; E3.diagnosis = null;
    at(9200, ev('ready', 'e3', { commit: 'aabbccddeeff' }));

    // in-order retirement: e1 checks then lands on trunk
    E1.status = 'checking';
    at(10200, ev('check.started', 'e1', {}));
    E1.status = 'ready'; E1.checks = clone(CHECKS_OK.e1);
    at(11000, ev('check.passed', 'e1', { entry: clone(E1), checks: clone(CHECKS_OK.e1) }));
    E1.status = 'retired';
    TRUNK.commit = 'ff1122334455'; TRUNK.retiredCount = 1;
    at(11600, ev('retired', 'e1', { entry: clone(E1), trunk: clone(TRUNK) }));

    E2.status = 'checking';
    at(12800, ev('check.started', 'e2', {}));
    E2.status = 'ready'; E2.checks = clone(CHECKS_OK.e2);
    at(13600, ev('check.passed', 'e2', { entry: clone(E2), checks: clone(CHECKS_OK.e2) }));
    E2.status = 'retired';
    TRUNK.commit = '66aabbccddee'; TRUNK.retiredCount = 2;
    at(14200, ev('retired', 'e2', { entry: clone(E2), trunk: clone(TRUNK) }));

    // e3 fails its check, the agent pushes a fix, then it passes and retires
    E3.status = 'checking';
    at(15400, ev('check.started', 'e3', {}));
    E3.status = 'failed'; E3.checks = clone(CHECKS_OK.e3fail);
    at(16200, ev('check.failed', 'e3', { entry: clone(E3), checks: clone(CHECKS_OK.e3fail) }));
    E3.status = 'speculating'; E3.headCommit = '112233445566';
    at(17200, ev('push', 'e3', { commit: '112233445566' }));
    E3.status = 'ready';
    at(17800, ev('ready', 'e3', { commit: '112233445566' }));
    E3.status = 'checking';
    at(18400, ev('check.started', 'e3', {}));
    E3.status = 'ready'; E3.checks = clone(CHECKS_OK.e3ok);
    at(19100, ev('check.passed', 'e3', { entry: clone(E3), checks: clone(CHECKS_OK.e3ok) }));
    E3.status = 'retired';
    TRUNK.commit = '77ffee001122'; TRUNK.retiredCount = 3;
    at(19700, ev('retired', 'e3', { entry: clone(E3), trunk: clone(TRUNK) }));

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
