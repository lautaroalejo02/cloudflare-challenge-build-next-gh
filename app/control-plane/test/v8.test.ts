import { test } from 'node:test';
import assert from 'node:assert/strict';
import { apply, initialState, type Cmd, type ArbEvent } from '../src/rob.ts';
import { pushCommand, execEffects, tokenCache, type EffectHost } from '../src/effects.ts';
import type { ArtifactsPort } from '../src/ports.ts';

function setup(fail = false) {
  const state = initialState();
  const events: ArbEvent[] = [];
  const run = (cmd: Cmd) => { const r = apply(state, cmd, 1000); assert.ok(r.ok); return r; };
  run({ type: 'trunk.init', repo: 'trunk', remote: 'x', commit: 'base' });
  run({ type: 'entry.create', agent: 'api', lane: 'api' });
  run({ type: 'fork.done', entryId: 'e1', repo: 'p', remote: 'x', baseCommit: 'base', exports: { createOrder: 'h', charge: 'pay' }, sigs: { createOrder: { signature: 'order()', file: 'order.ts' }, charge: { signature: 'charge()', file: 'payment.ts' } } });
  run({ type: 'entry.create', agent: 'ui', lane: 'ui', producerId: 'e1' });
  run({ type: 'fork.done', entryId: 'e2', repo: 'c', remote: 'x', baseCommit: 'base', exports: { createOrder: 'h', charge: 'pay' } });
  const base = { 'checkout.ts': 'old', 'paywall.ts': 'untouched' };
  const files = { ...base, 'checkout.ts': 'edited' };
  const artifacts: ArtifactsPort = {
    create: async name => ({ name, remote: 'x' }), fork: async (_f, name) => ({ name, remote: 'x' }), getRemote: async () => 'x', token: async () => 'fake', log: async () => [{ hash: 'head' }],
    readTree: async (_repo, commit) => { if (commit === 'base' && fail) throw new Error('secret-token private-path'); return commit === 'base' ? base : files; },
  };
  const host: EffectHost = {
    ports: { artifacts, hasher: { hashInterface: async () => ({ hash: 'x', symbols: [] }), extractImports: async () => [{ file: 'checkout.ts', from: 'order.ts', names: ['createOrder'] }, { file: 'paywall.ts', from: 'payment.ts', names: ['charge'] }] }, checker: {} as never, retirer: {} as never },
    state: () => state, apply: run, broadcast: ev => { events.push(ev); }, registerRepo: () => {}, tokens: tokenCache(() => Promise.resolve('fake')), sleep: async () => {},
  };
  return { state, host, events, run };
}

test('V8 untouched trunk imports are excluded while modified file imports are inferred', async () => {
  const { state, host, run } = setup();
  const cmd = await pushCommand(host, 'c', 'head'); assert.ok(cmd);
  run(cmd);
  assert.equal(state.entries[1].consumes.charge, undefined);
  assert.equal(state.entries[1].consumes.createOrder, 'h');
});

test('V8 missing changed paths fail closed in the pure machine', () => {
  const { state, run } = setup();
  run({ type: 'push', repo: 'c', commit: 'head', imports: [{ file: 'checkout.ts', from: 'order.ts', names: ['createOrder'] }] });
  assert.deepEqual(state.entries[1].consumes, {});
});

test('V8 diff failure skips inference and emits a sanitized recover event', async () => {
  const { state, host, events, run } = setup(true);
  const cmd = await pushCommand(host, 'c', 'head'); assert.ok(cmd);
  const r = run(cmd); await execEffects(host, r.effects);
  assert.deepEqual(state.entries[1].consumes, {});
  assert.ok(events.some(ev => ev.type === 'recover'));
  assert.doesNotMatch(JSON.stringify(events), /secret-token|private-path/);
});

test('V8 blob OIDs govern added/modified files and the shared diff reads no base blobs', async () => {
  const { changedConsumerFiles } = await import('../src/effects.ts');
  const { realArtifacts } = await import('../src/ports.ts');
  const { host } = setup();
  let blobs = 0;
  host.ports.artifacts = realArtifacts({ get: async () => ({
    readCommit: async () => ({ treeHash: 'tree' }),
    readTree: async () => [
      { path: 'same.ts', type: 'blob', hash: 'same', mode: '100755' },
      { path: 'modified.ts', type: 'blob', hash: 'before', mode: '100644' },
      { path: 'deleted.ts', type: 'blob', hash: 'deleted', mode: '100644' },
    ],
    readBlob: async () => { blobs++; throw new Error('base blobs must not be read'); },
  }) } as never);
  const changed = await changedConsumerFiles(host, 'c', 'base', { 'same.ts': 'same', 'modified.ts': 'same decoded source', 'added.ts': 'new' }, { 'same.ts': 'same', 'modified.ts': 'after', 'added.ts': 'new' });
  assert.deepEqual([...changed], ['modified.ts', 'added.ts']);
  assert.equal(blobs, 0);
});

test('V8 missing base tree metadata fails closed instead of inventing added paths', async () => {
  const { changedConsumerFiles } = await import('../src/effects.ts');
  const { realArtifacts } = await import('../src/ports.ts');
  const { host } = setup();
  host.ports.artifacts = realArtifacts({ get: async () => ({ readCommit: async () => null }) } as never);
  await assert.rejects(changedConsumerFiles(host, 'c', 'base', { 'checkout.ts': 'new' }), /commit-unavailable/);
});
