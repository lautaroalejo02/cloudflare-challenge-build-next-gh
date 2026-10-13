// Live dashboard VIDEO capture for the ARB submission video. Headless Edge
// (channel msedge) at 1920x1080 with recordVideo. While it records it spawns
// `npm run demo -- --base <url> [--scenario X]` in app/demo, keeps rolling
// until the scenario process exits plus a 4 s tail, then saves
// recordings/<name>.webm and the scenario's stdout timeline next to it as
// recordings/<name>.timeline.txt.
//
// Usage:
//   node scripts/record-live.mjs --name main
//   node scripts/record-live.mjs --name multi --scenario multi
//   node scripts/record-live.mjs --name failing-check --scenario failing-check
// Options: --base <control-plane URL>  --size 1920x1080  --tail 4000
//          --delay-ready <entryId>:<ms>
//
// --delay-ready fronts the demo with a loopback HTTP proxy that forwards
// every request to --base unchanged, except POST /api/entries/<id>/ready,
// which is held for <ms> before forwarding. Needed for the multi take: the
// two components' splice retirements are scripted to land in the same ~2 s
// window, and the second moveBranch then gets a non-fast-forward rejection
// that wedges the entry (observed 4/4 live runs). Delaying the payments-ui
// entry (always e5) by ~30 s staggers the tail without touching the demo or
// the control plane. Logged in stdout and recorded in the timeline file.
//
// The [record] lines print offsets in VIDEO time (recording starts just
// before goto), so timeline `+Ns` entries can be mapped to video timestamps:
// video-time ~= demo-spawn offset + N.
import { chromium } from 'playwright';
import { spawn } from 'node:child_process';
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const PKG = path.resolve(HERE, '..');               // app/dashboard
const DEMO_DIR = path.resolve(PKG, '..', 'demo');   // app/demo
const OUT = path.join(PKG, 'recordings');

function arg(name, dflt) {
  const i = process.argv.indexOf(`--${name}`);
  if (i >= 0 && process.argv[i + 1] && !process.argv[i + 1].startsWith('--')) return process.argv[i + 1];
  const eq = process.argv.find((a) => a.startsWith(`--${name}=`));
  return eq ? eq.split('=').slice(1).join('=') : dflt;
}

const NAME = arg('name', 'main');
const SCENARIO = arg('scenario'); // undefined = main
const BASE = arg('base', 'https://arb-control-plane.lautitomasalejo.workers.dev/');
const [W, H] = arg('size', '1920x1080').split('x').map(Number);
const TAIL_MS = Number(arg('tail', '4000'));
const DELAY_READY = arg('delay-ready'); // "<entryId>:<ms>" or unset

const videoTime = () => ((Date.now() - recStart) / 1000).toFixed(1);

fs.mkdirSync(OUT, { recursive: true });
const tmpVideoDir = fs.mkdtempSync(path.join(OUT, '.rec-'));

const browser = await chromium.launch({ channel: 'msedge', headless: true });
const context = await browser.newContext({
  viewport: { width: W, height: H },
  recordVideo: { dir: tmpVideoDir, size: { width: W, height: H } },
});

let exitCode = 1;
let stdout = '';
let proxy;
let demoBase = BASE;
if (DELAY_READY) {
  const m = /^([a-z0-9]+):(\d+)$/i.exec(DELAY_READY);
  if (!m) {
    console.error('--delay-ready expects <entryId>:<ms>');
    process.exit(2);
  }
  const delayPath = `/api/entries/${m[1]}/ready`;
  const delayMs = Number(m[2]);
  proxy = http.createServer(async (req, res) => {
    try {
      const chunks = [];
      for await (const c of req) chunks.push(c);
      const url = new URL(req.url, BASE);
      if (req.method === 'POST' && url.pathname === delayPath) {
        console.log(`[record] proxy delaying POST ${delayPath} by ${delayMs}ms`);
        await new Promise((r) => setTimeout(r, delayMs));
      }
      const upstream = await fetch(url, {
        method: req.method,
        headers: { 'content-type': req.headers['content-type'] ?? 'application/json' },
        body: chunks.length ? Buffer.concat(chunks) : undefined,
      });
      res.writeHead(upstream.status, {
        'content-type': upstream.headers.get('content-type') ?? 'application/json',
      });
      res.end(Buffer.from(await upstream.arrayBuffer()));
    } catch (e) {
      res.writeHead(502).end(String(e));
    }
  });
  await new Promise((r) => proxy.listen(0, '127.0.0.1', r));
  demoBase = `http://127.0.0.1:${proxy.address().port}`;
  console.log(`[record] proxy ${demoBase} -> ${BASE} (delay ${delayMs}ms on POST ${delayPath})`);
}
const recStart = Date.now();
try {
  const page = await context.newPage();
  await page.goto(BASE, { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('.dot.ws, .dot.poll', { timeout: 120_000 });
  console.log(`[record] live at +${videoTime()}s`);

  // Beat of idle live dashboard before the scenario kicks off.
  await page.waitForTimeout(1500);

  const npmCmd = process.platform === 'win32' ? 'npm.cmd' : 'npm';
  const args = ['run', 'demo', '--', '--base', demoBase];
  if (SCENARIO) args.push('--scenario', SCENARIO);
  console.log(`[record] demo spawned at +${videoTime()}s: ${npmCmd} ${args.join(' ')}`);
  // shell:true on win32 — Node refuses to spawn .cmd shims directly (EINVAL).
  const child = spawn(npmCmd, args, { cwd: DEMO_DIR, shell: process.platform === 'win32' });
  child.stdout.on('data', (d) => {
    stdout += d;
    process.stdout.write(d);
  });
  child.stderr.on('data', (d) => process.stderr.write(d));
  exitCode = await new Promise((r) => {
    child.on('close', (c) => r(c ?? 1));
    child.on('error', (e) => {
      console.error(`[record] demo spawn failed: ${e.message}`);
      r(1);
    });
  });
  console.log(`[record] demo exited code=${exitCode} at +${videoTime()}s`);

  await page.waitForTimeout(TAIL_MS); // tail: show the settled end state

  const video = page.video();
  await context.close(); // finalizes the .webm
  const target = path.join(OUT, `${NAME}.webm`);
  await video.saveAs(target);
  const mb = (fs.statSync(target).size / 1024 / 1024).toFixed(1);
  console.log(`[record] saved ${target} (${mb} MB)`);
} finally {
  // browser.close() releases the .webm handle (context close finalizes it);
  // retries absorb Windows file-lock lag.
  if (proxy) {
    proxy.close();
    proxy.closeAllConnections?.();
  }
  await browser.close().catch(() => {});
  fs.rmSync(tmpVideoDir, { recursive: true, force: true, maxRetries: 8, retryDelay: 250 });
}

const tlPath = path.join(OUT, `${NAME}.timeline.txt`);
fs.writeFileSync(tlPath, stdout);
console.log(`[record] saved ${tlPath}`);
process.exit(exitCode === 0 ? 0 : 1);
