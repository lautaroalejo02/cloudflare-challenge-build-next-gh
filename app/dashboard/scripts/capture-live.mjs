// Live dashboard capture for the ARB demo run: headless Edge (channel msedge)
// at 1920x1080. Opens the deployed control-plane page, waits for the live WS
// (or polling fallback), then screenshots at the SQUASH moment (first squash
// event in the log — rows render 'squashed' synchronously with the log line)
// and at the end (all three retired chips on the trunk bar).
// Usage: node scripts/capture-live.mjs [base-url]
import { chromium } from 'playwright';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const BASE = process.argv[2] || 'https://arb-control-plane.lautitomasalejo.workers.dev/';
const OUT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'screenshots');
const WAIT = { timeout: 300_000 };

const browser = await chromium.launch({ channel: 'msedge', headless: true });
try {
  const page = await browser.newPage({ viewport: { width: 1920, height: 1080 } });
  await page.goto(BASE, { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('.dot.ws, .dot.poll', WAIT);
  console.log('READY');

  await page.waitForSelector('.log-line.t-squash', WAIT);
  await page.waitForTimeout(400); // let the flash-squash frame paint
  await page.screenshot({ path: path.join(OUT, 'live-squash.png') });
  console.log('SQUASH_CAPTURED');

  await page.waitForSelector('.chip.retired[data-chip="e3"]', WAIT);
  await page.waitForTimeout(600); // final render + retire animation settle
  await page.screenshot({ path: path.join(OUT, 'live-final.png') });
  console.log('FINAL_CAPTURED');
} finally {
  await browser.close();
}
