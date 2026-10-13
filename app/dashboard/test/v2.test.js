'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const A = require('../state.js');
function setup(extra = {}) {
  const s = A.createState();
  A.upsertEntry(s, { id: 'e2', seq: 2, lane: 'ui', producerId: 'e1', consumes: { createOrder: 'sig' }, ...extra });
  return s;
}
function event(s, type, data) { A.applyEvent(s, { type, entryId: 'e2', ts: 100, data }); }
test('V2 fields survive flat creation, snapshots and normalization', () => {
  const fields = { consumesInferred: true, forkedExports: { createOrder: 'sig' }, bodies: { Checkout: 'body' }, judging: ['createOrder'] };
  const s = A.createState();
  event(s, 'entry.created', { seq: 2, lane: 'ui', ...fields });
  for (const [k, v] of Object.entries(fields)) assert.deepEqual(s.entries[0][k], v);
  A.loadSnapshot(s, { entries: [{ id: 'e2', seq: 2, lane: 'ui', ...fields }] });
  for (const [k, v] of Object.entries(fields)) assert.deepEqual(s.entries[0][k], v);
  assert.deepEqual(A.upsertEntry(s, { id: 'e3', seq: 3, lane: 'tests' }).judging, []);
});
test('deps.inferred records new symbols and highlight timestamps', () => {
  const s = setup({ consumes: {} });
  event(s, 'deps.inferred', { producerId: 'e1', symbols: { createOrder: 'sig' } });
  assert.deepEqual(s.entries[0].consumes, { createOrder: 'sig' });
  assert.equal(s.entries[0].consumesInferred, true);
  assert.equal(s.entries[0]._inferredAt.createOrder, 100);
  assert.equal(s.stats.inferredDeps, 1);
  A.loadSnapshot(s, { entries: [{ id: 'e2', seq: 2, lane: 'ui', consumesInferred: true, consumes: { createOrder: 'sig' } }] });
  assert.equal(s.entries[0]._inferredAt.createOrder, 100);
});
test('deps.undeclared is a non-blocking consumer warning', () => {
  const s = setup();
  event(s, 'deps.undeclared', { fromEntryId: 'e4', paths: ['src/shared.ts'], symbols: ['Order'] });
  assert.equal(s.entries[0]._undeclared[0].fromEntryId, 'e4');
  assert.deepEqual(s.entries[0]._undeclared[0].symbols, ['Order']);
  assert.equal(s.entries[0].status, 'speculating');
});
for (const verdict of ['clear', 'warn', 'squash']) test('jev.judged ' + verdict + ' resolves only the affected symbol', () => {
  const s = setup({ judging: ['createOrder', 'Order'] });
  event(s, 'jev.judged', { producerId: 'e1', symbol: 'createOrder', probability: 0.86, verdict, commit: 'c1', model: 'jev-latest' });
  assert.deepEqual(s.entries[0].judging, ['Order']);
  assert.equal(s.entries[0]._judgments.createOrder.verdict, verdict);
  assert.equal(s.stats.judgments, 1);
  assert.equal(s.entries[0].status, 'speculating'); // squash arrives separately
});
test('jev.unavailable resolves judging quietly without counting a judgment', () => {
  const s = setup({ judging: ['createOrder'] });
  event(s, 'jev.unavailable', { producerId: 'e1', symbol: 'createOrder', reason: 'timeout' });
  assert.deepEqual(s.entries[0].judging, []);
  assert.equal(s.entries[0]._judgments.createOrder.verdict, 'unavailable');
  assert.equal(s.stats.judgments, undefined);
  assert.equal(s.entries[0].status, 'speculating');
});
test('behavior squash preserves judgment and refork never writes body hashes into consumes', () => {
  const s = setup();
  event(s, 'squash', { reason: 'behavior-changed', changed: [{ symbol: 'createOrder', oldHash: 'body0', newHash: 'body1' }], judgment: { probability: 0.86, model: 'jev-latest' } });
  assert.equal(s.entries[0].diagnosis.judgment.probability, 0.86);
  assert.equal(s.stats.semanticSquashes, 1);
  event(s, 'refork', { repo: 'arb-e2-ui-1' });
  assert.equal(s.entries[0].consumes.createOrder, 'sig');
  assert.deepEqual(s.entries[0]._judgments, {});
});
test('old Worker V2 statistics remain absent; V2 statistics survive snapshots', () => {
  const s = setup();
  A.loadSnapshot(s, { stats: { squashes: 2 } });
  for (const k of ['judgments', 'semanticSquashes', 'inferredDeps']) assert.equal(s.stats[k], undefined);
  A.loadSnapshot(s, { stats: { judgments: 3, semanticSquashes: 1, inferredDeps: 4 } });
  assert.equal(s.stats.judgments, 3);
});
function render(s) {
  const elements = new Map();
  const element = () => ({ classList: { add() {} }, addEventListener() {}, querySelectorAll() { return []; }, setAttribute() {}, style: {}, innerHTML: '', textContent: '', parentElement: { hidden: false } });
  const document = { body: element(), getElementById(id) { if (!elements.has(id)) elements.set(id, element()); return elements.get(id); }, activeElement: null };
  const window = { ArbState: A, __ARB_MOCK__: true, ArbMock: { run(emit) { emit({ type: 'snapshot', data: s }); } }, addEventListener() {} };
  vm.runInNewContext(fs.readFileSync(require.resolve('../app.js'), 'utf8'), { window, document, location: { search: '', pathname: '/mock.html' }, requestAnimationFrame() {}, setTimeout() {}, clearTimeout() {}, Date });
  return elements;
}
test('renderer shows semantic three-line diagnosis and hides absent V2 stats', () => {
  const s = setup();
  event(s, 'squash', { reason: 'behavior-changed', changed: [{ symbol: 'createOrder', oldHash: 'body0', newHash: 'body1', oldSignature: 'same', newSignature: 'same' }], judgment: { probability: 0.86 } });
  const dom = render(s);
  const html = dom.get('lanes').innerHTML;
  assert.match(html, /signature unchanged · behavior changed/);
  assert.match(html, /Jev p=0\.86/);
  assert.doesNotMatch(html, /Previous|Current/);
  assert.equal(dom.get('s-judgments').parentElement.hidden, true);
});
test('renderer marks inferred/judging symbols, warnings, clear ticks and unavailable notes', () => {
  const s = setup({ consumesInferred: true, judging: ['createOrder'] });
  let html = render(s).get('lanes').innerHTML;
  assert.match(html, /inferred/); assert.match(html, /judging/);
  event(s, 'jev.judged', { symbol: 'createOrder', verdict: 'warn', probability: 0.51 });
  event(s, 'deps.undeclared', { fromEntryId: 'e4', symbols: ['Order'], paths: [] });
  html = render(s).get('lanes').innerHTML;
  assert.match(html, /p=0\.51/); assert.match(html, /e4.*Order/);
  event(s, 'jev.judged', { symbol: 'createOrder', verdict: 'clear', probability: 0.1 });
  assert.match(render(s).get('lanes').innerHTML, /semantic-clear/);
  event(s, 'jev.unavailable', { symbol: 'createOrder', reason: 'timeout' });
  assert.match(render(s).get('lanes').innerHTML, /semantic check unavailable/);
});

test('renderer exposes supplied V2 stats and escapes undeclared symbols', () => {
  const s = setup();
  s.stats = { ...s.stats, judgments: 3, semanticSquashes: 1, inferredDeps: 2 };
  event(s, 'deps.undeclared', { fromEntryId: '<e4>', symbols: ['<script>'], paths: [] });
  const dom = render(s);
  for (const key of ['judgments', 'semanticSquashes', 'inferredDeps']) {
    assert.equal(dom.get('s-' + key).parentElement.hidden, false);
    assert.equal(dom.get('s-' + key).textContent, s.stats[key]);
  }
  assert.match(dom.get('lanes').innerHTML, /&lt;e4&gt;.*&lt;script&gt;/);
});

test('mock V2 judging follows the early cutoff and precedes breaking change and retirement', () => {
  const mock = require('../mock.js').build();
  const s = A.createState();
  const inferred = mock.find(step => step.ev.type === 'deps.inferred');
  const judging = mock.find(step => step.ev.type === 'snapshot' && step.ev.data.entries.some(e => e.judging && e.judging.length));
  const semantic = mock.find(step => step.ev.type === 'squash' && step.ev.data.reason === 'behavior-changed');
  const breaking = mock.find(step => step.ev.type === 'squash' && step.ev.data.reason === 'interface-changed');
  assert.ok(inferred.at < judging.at);
  assert.ok(judging.at < semantic.at && semantic.at < breaking.at);
  for (const step of mock.filter(step => step.at <= judging.at)) A.applyEvent(s, step.ev);
  assert.equal(s.stats.earlyCutoffs, 4);
  assert.deepEqual(A.findEntry(s, 'e2').judging, ['createOrder']);
  assert.equal(A.findEntry(s, 'e2').consumesInferred, true);
});
