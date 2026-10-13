// Live dashboard capture for the ARB demo run: headless Edge (channel msedge)
// at 1920x1080. Opens the deployed control-plane page, waits for the live WS
// (or polling fallback), then screenshots at the PREDICTED moment (forwarded
// tags still marked '≈ stub' — the consumer started before the producer wrote
// anything), at the PREDICTION VERDICT moment (first prediction.hit/miss log
// line — verdict ticks + the hit/miss counter land synchronously), at the
// SQUASH moment, and at the end (all three retired chips on the trunk bar).
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

  // Consumer forwarded tags marked '≈ stub': the consumer is running against
  // the producer's declared stub before the producer's first push.
  try {
    await page.waitForSelector('.tag.fwd .pred-mark', { timeout: 120_000 });
    await page.waitForTimeout(300);
    await page.screenshot({ path: path.join(OUT, 'live-predicted.png') });
    console.log('PREDICTED_CAPTURED');
  } catch {
    console.log('PREDICTED_SKIPPED (window missed)');
  }

  // Verdict moment: first prediction.hit/miss lands — ticks and the
  // "stub predictions: X hit / Y miss" counter update in the same frame.
  await page.waitForSelector('.log-line[class*="t-prediction"], .pred-tick', WAIT);
  await page.waitForTimeout(600); // let verdict + squash frames paint
  await page.screenshot({ path: path.join(OUT, 'live-prediction.png') });
  console.log('PREDICTION_CAPTURED');

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
