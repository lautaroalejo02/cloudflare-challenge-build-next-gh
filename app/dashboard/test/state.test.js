'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const A = require('../state.js');
const ArbMock = require('../mock.js');

function entry(over) {
  return Object.assign({
    id: 'e1', seq: 1, agent: 'a', lane: 'api', status: 'speculating',
    repo: 'arb-e1-api-0', remote: '', producerId: null, baseCommit: 'c0',
    headCommit: null, exports: { createOrder: 'a91f3b2c10d4' }, consumes: {},
    generation: 0, diagnosis: null, checks: null
  }, over);
}

test('snapshot loads state and sorts entries by seq', () => {
  const s = A.createState();
  A.applyEvent(s, { type: 'snapshot', ts: 1, data: {
    trunk: { repo: 'arb-trunk', commit: 'abc1234', retiredCount: 0 },
    robSize: 4,
    entries: [entry({ id: 'e2', seq: 2, lane: 'ui' }), entry({ id: 'e1', seq: 1 })],
    stats: { squashes: 1, earlyCutoffs: 0, retired: 0, checksRun: 0, pushesSeen: 0 }
  }});
  assert.equal(s.robSize, 4);
  assert.deepEqual(s.entries.map(e => e.id), ['e1', 'e2']);
  assert.equal(s.trunk.commit, 'abc1234');
  assert.equal(s.stats.squashes, 1);
});

test('data.entry folds on any event type', () => {
  const s = A.createState();
  A.applyEvent(s, { type: 'push', entryId: 'e1', ts: 1, data: {
    entry: entry({ headCommit: 'feedface' }), commit: 'feedface' } });
  const e = A.findEntry(s, 'e1');
  assert.equal(e.headCommit, 'feedface');
  assert.equal(s.stats.pushesSeen, 1);
});

test('push clears diagnosis and resumes speculating', () => {
  const s = A.createState();
  A.applyEvent(s, { type: 'entry.created', entryId: 'e1', ts: 1, data: { entry: entry() } });
  A.applyEvent(s, { type: 'squash', entryId: 'e1', ts: 2, data: {
    diagnosis: { reason: 'interface-changed', changed: [], producerCommit: 'c1' } } });
  assert.equal(A.findEntry(s, 'e1').status, 'squashed');
  assert.equal(A.findEntry(s, 'e1').generation, 1);
  A.applyEvent(s, { type: 'push', entryId: 'e1', ts: 3, data: { commit: 'c2' } });
  const e = A.findEntry(s, 'e1');
  assert.equal(e.status, 'speculating');
  assert.equal(e.diagnosis, null);
  assert.equal(e.headCommit, 'c2');
});

test('entry.created folds the real flat payload (no data.entry)', () => {
  const s = A.createState();
  A.applyEvent(s, { type: 'entry.created', entryId: 'e1', ts: 1, data: {
    agent: 'api-agent', lane: 'api', seq: 1, producerId: null, repo: 'arb-e1-api-0' } });
  const e = A.findEntry(s, 'e1');
  assert.ok(e);
  assert.equal(e.agent, 'api-agent');
  assert.equal(e.status, 'speculating');
  assert.equal(e.repo, 'arb-e1-api-0');
});

test('trunk push updates the trunk commit without an entryId', () => {
  const s = A.createState();
  A.applyEvent(s, { type: 'push', ts: 1, data: { repo: 'arb-trunk', commit: 'deadc0de', trunk: true } });
  assert.equal(s.trunk.commit, 'deadc0de');
  assert.equal(s.stats.pushesSeen, 0); // trunk pushes are not entry pushes
});

test('hash.unchanged counts a cutoff tick without a squash', () => {
  const s = A.createState();
  A.applyEvent(s, { type: 'entry.created', entryId: 'e1', ts: 1, data: { entry: entry() } });
  A.applyEvent(s, { type: 'hash.unchanged', entryId: 'e1', ts: 2, data: { symbol: 'createOrder' } });
  A.applyEvent(s, { type: 'hash.unchanged', entryId: 'e1', ts: 3, data: {} });
  const e = A.findEntry(s, 'e1');
  assert.equal(e.cutoffs, 2);
  assert.equal(s.stats.earlyCutoffs, 2);
  assert.equal(e.status, 'speculating');
});

test('hash.unchanged real payload lands on the consumer', () => {
  const s = A.createState();
  [entry({ id: 'e1', seq: 1 }), entry({ id: 'e2', seq: 2, lane: 'ui', producerId: 'e1' })]
    .forEach(e => A.upsertEntry(s, e));
  A.applyEvent(s, { type: 'hash.unchanged', entryId: 'e2', ts: 2, data: { producerId: 'e1', commit: 'c1' } });
  assert.equal(A.findEntry(s, 'e2').cutoffs, 1);
  assert.equal(A.findEntry(s, 'e1').cutoffs, 0);
});

test('hash.changed rewrites the exported hash', () => {
  const s = A.createState();
  A.applyEvent(s, { type: 'entry.created', entryId: 'e1', ts: 1, data: { entry: entry() } });
  A.applyEvent(s, { type: 'hash.changed', entryId: 'e1', ts: 2, data: {
    changed: [{ symbol: 'createOrder', oldHash: 'a91f3b2c10d4', newHash: 'c07e55aa11bb' }] } });
  assert.equal(A.findEntry(s, 'e1').exports.createOrder, 'c07e55aa11bb');
});

test('hash.changed real payload updates the producer exports', () => {
  const s = A.createState();
  [entry({ id: 'e1', seq: 1 }), entry({ id: 'e2', seq: 2, lane: 'ui', producerId: 'e1' })]
    .forEach(e => A.upsertEntry(s, e));
  A.applyEvent(s, { type: 'hash.changed', entryId: 'e2', ts: 2, data: {
    producerId: 'e1', commit: 'd4e5',
    changed: [{ symbol: 'createOrder', oldHash: 'a91f3b2c10d4', newHash: 'c07e55aa11bb' }] } });
  assert.equal(A.findEntry(s, 'e1').exports.createOrder, 'c07e55aa11bb');
  assert.equal(A.findEntry(s, 'e2')._hcCommit, 'd4e5');
});

test('squash builds the diagnosis from flat fields', () => {
  const s = A.createState();
  A.applyEvent(s, { type: 'entry.created', entryId: 'e2', ts: 1, data: {
    agent: 'u', lane: 'ui', seq: 2, producerId: 'e1', repo: 'arb-e2-ui-0' } });
  A.applyEvent(s, { type: 'hash.changed', entryId: 'e2', ts: 2, data: {
    producerId: 'e1', commit: 'd4e5',
    changed: [{ symbol: 'createOrder', oldHash: 'a91f3b2c10d4', newHash: 'c07e55aa11bb' }] } });
  A.applyEvent(s, { type: 'squash', entryId: 'e2', ts: 3, data: {
    reason: 'interface-changed',
    changed: [{ symbol: 'createOrder', oldHash: 'a91f3b2c10d4', newHash: 'c07e55aa11bb' }],
    generation: 1, repo: 'arb-e2-ui-1' } });
  const e = A.findEntry(s, 'e2');
  assert.equal(e.status, 'squashed');
  assert.equal(e.generation, 1);
  assert.equal(e.repo, 'arb-e2-ui-1');
  assert.equal(e.diagnosis.reason, 'interface-changed');
  assert.equal(e.diagnosis.producerCommit, 'd4e5'); // stashed from hash.changed
  assert.equal(e.diagnosis.changed[0].newHash, 'c07e55aa11bb');
});

test('trunk-overlap squash folds reason and empty changed list', () => {
  const s = A.createState();
  A.applyEvent(s, { type: 'entry.created', entryId: 'e4', ts: 1, data: {
    agent: 'd', lane: 'docs', seq: 4, producerId: null, repo: 'arb-e4-docs-0' } });
  A.applyEvent(s, { type: 'squash', entryId: 'e4', ts: 2, data: {
    reason: 'trunk-overlap', changed: [], generation: 1, repo: 'arb-e4-docs-1', producerCommit: '77ff' } });
  const e = A.findEntry(s, 'e4');
  assert.equal(e.diagnosis.reason, 'trunk-overlap');
  assert.equal(e.diagnosis.producerCommit, '77ff');
  assert.equal(s.stats.squashes, 1);
});

test('refork updates consumes to the new producer hashes', () => {
  const s = A.createState();
  const e2 = entry({ id: 'e2', seq: 2, lane: 'ui', producerId: 'e1', consumes: { createOrder: 'a91f3b2c10d4' } });
  A.upsertEntry(s, e2);
  A.applyEvent(s, { type: 'squash', entryId: 'e2', ts: 1, data: {
    reason: 'interface-changed',
    changed: [{ symbol: 'createOrder', oldHash: 'a91f3b2c10d4', newHash: 'c07e55aa11bb' }] } });
  A.applyEvent(s, { type: 'refork', entryId: 'e2', ts: 2, data: {
    repo: 'arb-e2-ui-1', baseCommit: 'd4e5', generation: 1 } });
  const e = A.findEntry(s, 'e2');
  assert.equal(e.consumes.createOrder, 'c07e55aa11bb');
  assert.equal(e.status, 'speculating');
});

test('check.passed folds the real flat payload', () => {
  const s = A.createState();
  A.applyEvent(s, { type: 'entry.created', entryId: 'e1', ts: 1, data: { entry: entry({ status: 'checking' }) } });
  A.applyEvent(s, { type: 'check.passed', entryId: 'e1', ts: 2, data: { commit: 'c9', durationMs: 241 } });
  const e = A.findEntry(s, 'e1');
  assert.equal(e.status, 'ready');
  assert.equal(e.checks.failed, 0);
  assert.equal(e.checks.durationMs, 241);
  assert.equal(s.stats.checksRun, 1);
});

test('retired folds the real payload and records the mode', () => {
  const s = A.createState();
  A.applyEvent(s, { type: 'entry.created', entryId: 'e1', ts: 1, data: { entry: entry({ status: 'ready' }) } });
  A.applyEvent(s, { type: 'retired', entryId: 'e1', ts: 2, data: { commit: '66aabb', seq: 1, mode: 'splice' } });
  const e = A.findEntry(s, 'e1');
  assert.equal(e.status, 'retired');
  assert.equal(e._retireMode, 'splice');
  assert.equal(s.trunk.commit, '66aabb');
  assert.equal(s.trunk.retiredCount, 1);
});

test('reforkTiming reports the squash-to-refork latency', () => {
  const s = A.createState();
  A.applyEvent(s, { type: 'entry.created', entryId: 'e2', ts: 1, data: {
    agent: 'u', lane: 'ui', seq: 2, producerId: 'e1', repo: 'r' } });
  assert.equal(A.reforkTiming(s), null);
  A.applyEvent(s, { type: 'squash', entryId: 'e2', ts: 2200, data: { reason: 'interface-changed', changed: [] } });
  assert.equal(A.reforkTiming(s), null); // not re-forked yet
  A.applyEvent(s, { type: 'refork', entryId: 'e2', ts: 5100, data: { repo: 'r1', generation: 1 } });
  const t = A.reforkTiming(s);
  assert.equal(t.at, 5100);
  assert.equal(t.deltaMs, 2900);
});

test('retired moves entry to trunk and updates trunk commit', () => {
  const s = A.createState();
  A.applyEvent(s, { type: 'entry.created', entryId: 'e1', ts: 1, data: { entry: entry() } });
  A.applyEvent(s, { type: 'retired', entryId: 'e1', ts: 2, data: {
    entry: entry({ status: 'retired' }), trunk: { repo: 'arb-trunk', commit: 'deadbeef0', retiredCount: 1 } } });
  assert.equal(A.findEntry(s, 'e1').status, 'retired');
  assert.equal(s.trunk.commit, 'deadbeef0');
  assert.equal(s.trunk.retiredCount, 1);
  assert.equal(s.stats.retired, 1);
});

test('headEntry returns the lowest-seq in-flight entry', () => {
  const s = A.createState();
  [entry({ id: 'e1', seq: 1 }), entry({ id: 'e2', seq: 2, lane: 'ui', producerId: 'e1' }),
   entry({ id: 'e3', seq: 3, lane: 'tests', producerId: 'e1' })]
    .forEach(e => A.upsertEntry(s, e));
  assert.equal(A.headEntry(s).id, 'e1');
  A.findEntry(s, 'e1').status = 'retired';
  assert.equal(A.headEntry(s).id, 'e2');
});

test('dependentsOf walks the producer chain transitively', () => {
  const s = A.createState();
  [entry({ id: 'e1', seq: 1 }), entry({ id: 'e2', seq: 2, lane: 'ui', producerId: 'e1' }),
   entry({ id: 'e3', seq: 3, lane: 'tests', producerId: 'e2' }),
   entry({ id: 'e4', seq: 4, lane: 'docs', producerId: null })]
    .forEach(e => A.upsertEntry(s, e));
  assert.deepEqual(A.dependentsOf(s, 'e1').map(e => e.id), ['e2', 'e3']);
  assert.deepEqual(A.dependentsOf(s, 'e2').map(e => e.id), ['e3']);
});

test('localVeto vetoes head only and squashes transitive dependents', () => {
  const s = A.createState();
  [entry({ id: 'e1', seq: 1 }), entry({ id: 'e2', seq: 2, lane: 'ui', producerId: 'e1' }),
   entry({ id: 'e3', seq: 3, lane: 'tests', producerId: 'e2' })]
    .forEach(e => A.upsertEntry(s, e));
  assert.equal(A.localVeto(s, 'e2').ok, false);
  const res = A.localVeto(s, 'e1');
  assert.equal(res.ok, true);
  assert.deepEqual(res.squashed, ['e2', 'e3']);
  assert.equal(A.findEntry(s, 'e1').status, 'vetoed');
  assert.equal(A.findEntry(s, 'e2').status, 'squashed');
  assert.equal(A.findEntry(s, 'e2').diagnosis.reason, 'producer-vetoed');
  assert.equal(s.stats.squashes, 2);
});

test('check.failed marks the entry failed and records the result', () => {
  const s = A.createState();
  A.applyEvent(s, { type: 'entry.created', entryId: 'e1', ts: 1, data: { entry: entry({ status: 'checking' }) } });
  A.applyEvent(s, { type: 'check.failed', entryId: 'e1', ts: 2, data: {
    checks: { commit: 'c9', passed: 1, failed: 1, durationMs: 100, results: [{ name: 't', ok: false, error: 'x' }] } } });
  const e = A.findEntry(s, 'e1');
  assert.equal(e.status, 'failed');
  assert.equal(e.checks.failed, 1);
  assert.equal(s.stats.checksRun, 1);
});

test('authoritative data.stats overrides local increments', () => {
  const s = A.createState();
  A.applyEvent(s, { type: 'push', entryId: 'e1', ts: 1, data: {
    commit: 'c1', stats: { squashes: 0, earlyCutoffs: 0, retired: 0, checksRun: 0, pushesSeen: 7 } } });
  assert.equal(s.stats.pushesSeen, 7);
});

test('entry.created with a declared stub exposes predicted exports', () => {
  const s = A.createState();
  A.applyEvent(s, { type: 'entry.created', entryId: 'e1', ts: 1, data: {
    agent: 'api-agent', lane: 'api', seq: 1, producerId: null, repo: 'arb-e1-api-0',
    exports: { createOrder: 'a91f3b2c10d4', Order: '77aa02be9910' },
    predicted: ['createOrder', 'Order'] } });
  const e = A.findEntry(s, 'e1');
  assert.deepEqual(e.predicted, ['createOrder', 'Order']);
  assert.equal(e.exports.Order, '77aa02be9910');
});

test('push clears the predicted marker', () => {
  const s = A.createState();
  A.applyEvent(s, { type: 'entry.created', entryId: 'e1', ts: 1, data: {
    agent: 'a', lane: 'api', seq: 1, producerId: null, repo: 'arb-e1-api-0',
    exports: { createOrder: 'a91f' }, predicted: ['createOrder'] } });
  A.applyEvent(s, { type: 'push', entryId: 'e1', ts: 2, data: { repo: 'arb-e1-api-0', commit: 'c1' } });
  assert.deepEqual(A.findEntry(s, 'e1').predicted, []);
});

test('prediction.hit/miss ticks the consumer and bumps stats', () => {
  const s = A.createState();
  [entry({ id: 'e1', seq: 1, predicted: ['createOrder', 'Order'] }),
   entry({ id: 'e2', seq: 2, lane: 'ui', producerId: 'e1',
           consumes: { createOrder: 'a91f3b2c10d4', Order: '77aa02be9910' } })]
    .forEach(e => A.upsertEntry(s, e));
  A.applyEvent(s, { type: 'prediction.hit', entryId: 'e2', ts: 1, data: {
    producerId: 'e1', symbol: 'createOrder', hash: 'a91f3b2c10d4', commit: 'c1' } });
  A.applyEvent(s, { type: 'prediction.miss', entryId: 'e2', ts: 2, data: {
    producerId: 'e1', symbol: 'Order', predictedHash: '77aa02be9910', actualHash: 'c4d5e6f7a8b9',
    predictedSignature: 'interface Order{old}', actualSignature: 'interface Order{new}', commit: 'c1' } });
  const e2 = A.findEntry(s, 'e2');
  assert.equal(e2._predTicks.createOrder, 'hit');
  assert.equal(e2._predTicks.Order, 'miss');
  assert.equal(s.stats.predictionHits, 1);
  assert.equal(s.stats.predictionMisses, 1);
  assert.ok(s.log.some(l => l.type === 'prediction.miss' && l.text.indexOf('PREDICTION MISS') === 0));
});

test('mock script covers every required event type', () => {
  const types = new Set(ArbMock.build().map(s => s.ev.type));
  ['entry.created', 'push', 'hash.unchanged', 'hash.changed', 'squash', 'refork',
   'prediction.hit', 'prediction.miss',
   'check.passed', 'check.failed', 'retired'].forEach(t => assert.ok(types.has(t), 'missing ' + t));
});

test('full mock replay lands all four entries on trunk', () => {
  const s = A.createState();
  ArbMock.build().forEach(step => {
    const ev = JSON.parse(JSON.stringify(step.ev));
    ev.ts = step.at;
    A.applyEvent(s, ev);
  });
  assert.equal(s.entries.length, 4);
  assert.ok(s.entries.every(e => e.status === 'retired'));
  assert.equal(s.trunk.retiredCount, 4);
  assert.equal(s.trunk.commit, '88cc99887766');
  assert.equal(s.stats.squashes, 5);      // prediction miss + semantic + two interface changes + trunk overlap
  assert.equal(s.stats.earlyCutoffs, 4);  // two body-only pushes, two live consumers
  assert.equal(s.stats.judgments, 2);
  assert.equal(s.stats.semanticSquashes, 1);
  assert.equal(s.stats.inferredDeps, 2);
  assert.equal(s.stats.retired, 4);
  assert.equal(s.stats.checksRun, 6);
  assert.equal(s.stats.pushesSeen, 10);
  assert.equal(s.stats.predictionHits, 2);   // createOrder declared==delivered for e2 + e3
  assert.equal(s.stats.predictionMisses, 1); // Order gained an undeclared field (e2)
  const e2 = A.findEntry(s, 'e2');
  assert.equal(e2.generation, 3);
  assert.equal(e2.repo, 'arb-e2-ui-3');
  assert.equal(e2.consumes.createOrder, 'c07e55aa11bb'); // refork recorded the new hash
  assert.equal(e2.consumes.Order, 'c4d5e6f7a8b9');       // miss refork recorded the actual hash
  assert.equal(e2._retireMode, 'splice');
  const e4 = A.findEntry(s, 'e4');
  assert.equal(e4.generation, 1);
  assert.equal(e4.repo, 'arb-e4-docs-1');
  assert.ok(s.log.some(l => l.text.indexOf('trunk overlap') !== -1));
  assert.equal(e4._retireMode, 'splice');
  assert.equal(A.findEntry(s, 'e1')._retireMode, 'fast-forward');
});

test('stageIndex maps statuses onto the pipeline track', () => {
  assert.equal(A.stageIndex({ status: 'squashed' }), 0);
  assert.equal(A.stageIndex({ status: 'speculating' }), 1);
  assert.equal(A.stageIndex({ status: 'ready' }), 2);
  assert.equal(A.stageIndex({ status: 'checking' }), 3);
  assert.equal(A.stageIndex({ status: 'retired' }), 4);
  assert.equal(A.stageIndex({ status: 'vetoed' }), -1);
});

// --- T19: admin key gating + infra checks + recovery events -------------------

test('adminKeyFromSearch reads ?key= and ignores empty values', () => {
  assert.equal(A.adminKeyFromSearch('?key=abc123'), 'abc123');
  assert.equal(A.adminKeyFromSearch('?mock=1&key=a%2Bb'), 'a+b');
  assert.equal(A.adminKeyFromSearch('?key='), null);
  assert.equal(A.adminKeyFromSearch(''), null);
  assert.equal(A.adminKeyFromSearch('?keyboard=1'), null);
});

test('adminHeaders adds x-arb-key only when a key is present', () => {
  assert.deepEqual(A.adminHeaders('k'), { 'content-type': 'application/json', 'x-arb-key': 'k' });
  assert.deepEqual(A.adminHeaders(null), { 'content-type': 'application/json' });
});

test('an infra check.failed is not a verdict: the entry stays checking', () => {
  const s = A.createState();
  A.applyEvent(s, { type: 'entry.created', entryId: 'e1', ts: 1, data: { entry: entry({ status: 'checking' }) } });
  A.applyEvent(s, { type: 'check.failed', entryId: 'e1', ts: 2, data: { commit: 'c9', infra: true, error: 'artifacts 503' } });
  const e = A.findEntry(s, 'e1');
  assert.equal(e.status, 'checking');
  assert.equal(e.checks, null);
  assert.match(s.log[s.log.length - 1].text, /INFRA/);
});

test('recover events are logged with their kind', () => {
  const s = A.createState();
  A.applyEvent(s, { type: 'entry.created', entryId: 'e1', ts: 1, data: { entry: entry({}) } });
  A.applyEvent(s, { type: 'recover', entryId: 'e1', ts: 2, data: { kind: 'refork', repo: 'arb-e1-api-1' } });
  assert.match(s.log[s.log.length - 1].text, /RECOVER refork e1/);
});
