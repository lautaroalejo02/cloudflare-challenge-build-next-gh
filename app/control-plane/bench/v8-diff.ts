// Local fixture comparison cost; live push events measure Artifacts I/O too.
import { readFileSync, readdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { createHash } from 'node:crypto';
import { changedConsumerFiles, type EffectHost } from '../src/effects.ts';
const root = resolve(import.meta.dirname, '../../demo/fixture');
const base = Object.fromEntries(readdirSync(root, { recursive: true, withFileTypes: true })
  .filter(e => e.isFile() && e.name.endsWith('.ts'))
  .map(e => { const p = resolve(e.parentPath, e.name); return [p.slice(root.length + 1).replaceAll('\\', '/'), readFileSync(p, 'utf8')]; }));
const files = { ...base, 'src/ui/checkout.ts': base['src/ui/checkout.ts'] + '\n// Edited checkout\n' };
const oids = (tree: Record<string, string>) => Object.fromEntries(Object.entries(tree).map(([p, text]) => [p, createHash('sha1').update(`blob ${Buffer.byteLength(text)}\0`).update(text).digest('hex')]));
const before = oids(base), after = oids(files);
const host = { ports: { artifacts: { readTree: async (_repo: string, _commit: string, out: Record<string, string>, metadataOnly: boolean) => {
  if (!metadataOnly) throw new Error('expected metadata-only base read');
  Object.assign(out, before); return {};
} } } } as unknown as EffectHost;
const times: number[] = [];
for (let i = 0; i < 1100; i++) {
  const start = performance.now();
  const changed = await changedConsumerFiles(host, 'fixture', 'base', files, after);
  if (changed.size !== 1 || !changed.has('src/ui/checkout.ts')) throw new Error('incorrect diff');
  if (i >= 100) times.push(performance.now() - start);
}
times.sort((a,b) => a-b);
console.log(JSON.stringify({ files: Object.keys(files).length, samples: times.length, medianMs: times[500], p95Ms: times[950], maxMs: times.at(-1), includesNetwork: false }));
