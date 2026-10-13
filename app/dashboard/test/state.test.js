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

test('hash.changed rewrites the exported hash', () => {
  const s = A.createState();
  A.applyEvent(s, { type: 'entry.created', entryId: 'e1', ts: 1, data: { entry: entry() } });
  A.applyEvent(s, { type: 'hash.changed', entryId: 'e1', ts: 2, data: {
    changed: [{ symbol: 'createOrder', oldHash: 'a91f3b2c10d4', newHash: 'c07e55aa11bb' }] } });
  assert.equal(A.findEntry(s, 'e1').exports.createOrder, 'c07e55aa11bb');
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

test('mock script covers every required event type', () => {
  const types = new Set(ArbMock.build().map(s => s.ev.type));
  ['entry.created', 'push', 'hash.unchanged', 'hash.changed', 'squash', 'refork',
   'check.passed', 'check.failed', 'retired'].forEach(t => assert.ok(types.has(t), 'missing ' + t));
});

test('full mock replay lands all three entries on trunk', () => {
  const s = A.createState();
  ArbMock.build().forEach(step => {
    const ev = JSON.parse(JSON.stringify(step.ev));
    ev.ts = step.at;
    A.applyEvent(s, ev);
  });
  assert.equal(s.entries.length, 3);
  assert.ok(s.entries.every(e => e.status === 'retired'));
  assert.equal(s.trunk.retiredCount, 3);
  assert.equal(s.trunk.commit, '77ffee001122');
  assert.equal(s.stats.squashes, 2);
  assert.equal(s.stats.earlyCutoffs, 1);
  assert.equal(s.stats.retired, 3);
  assert.equal(s.stats.checksRun, 4);
  assert.equal(s.stats.pushesSeen, 3);
  const e2 = A.findEntry(s, 'e2');
  assert.equal(e2.generation, 1);
  assert.equal(e2.repo, 'arb-e2-ui-1');
  assert.equal(e2.consumes.createOrder, 'a91f3b2c10d4'); // hash it forked against is still shown
});

test('stageIndex maps statuses onto the pipeline track', () => {
  assert.equal(A.stageIndex({ status: 'squashed' }), 0);
  assert.equal(A.stageIndex({ status: 'speculating' }), 1);
  assert.equal(A.stageIndex({ status: 'ready' }), 2);
  assert.equal(A.stageIndex({ status: 'checking' }), 3);
  assert.equal(A.stageIndex({ status: 'retired' }), 4);
  assert.equal(A.stageIndex({ status: 'vetoed' }), -1);
});
