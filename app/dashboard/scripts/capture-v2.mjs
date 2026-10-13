import { chromium } from 'playwright';
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import assert from 'node:assert/strict';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const server = createServer(async (req, res) => {
  const file = path.resolve(root, '.' + new URL(req.url, 'http://localhost').pathname);
  if (!file.startsWith(root + path.sep)) { res.writeHead(403).end(); return; }
  try {
    const content = await readFile(file);
    res.setHeader('Content-Type', ({ '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css' })[path.extname(file)] || 'application/octet-stream');
    res.end(content);
  } catch { res.writeHead(404).end(); }
});
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
let browser;
try {
  browser = await chromium.launch({ channel: 'msedge', headless: true });
  for (const [width, height] of [[1280, 720], [1920, 1080]]) {
    const page = await browser.newPage({ viewport: { width, height } });
    const errors = [];
    page.on('pageerror', error => errors.push(error.message));
    // Virtual time runs the unmodified scheduled replay deterministically.
    const epoch = new Date('2026-10-13T12:00:00Z');
    await page.clock.install({ time: epoch });
    await page.clock.pauseAt(epoch);
    await page.goto(`http://127.0.0.1:${server.address().port}/mock.html`);
    let elapsed = 0;
    for (const [beat, at, selector] of [
      ['inferred', 3400, '#row-e2 .inferred-new .inferred-mark'],
      ['judging', 10000, '#row-e2 .judging-mark'],
      ['behavior-changed', 13500, '#row-e2.status-squashed .diag']
    ]) {
      await page.clock.runFor(at - elapsed);
      elapsed = at;
      await page.locator(selector).first().waitFor();
      await page.locator('#row-e2').evaluate(el => el.scrollIntoView({ block: 'nearest' }));
      if (beat === 'behavior-changed') {
        assert.match(await page.locator('#row-e2 .diag').innerText(), /signature unchanged.*behavior changed/);
        assert.match(await page.locator('#row-e2 .diag').innerText(), /Jev p=0\.86/);
      }
      await page.screenshot({ path: path.join(root, 'screenshots', `v2-${beat}-${width}x${height}.png`) });
      assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false, 'horizontal page overflow');
      console.log(`${width}x${height}: ${beat} captured`);
    }
    await page.clock.runFor(23000);
    assert.equal(await page.locator('.chip.retired').count(), 4);
    assert.deepEqual(errors, []);
    console.log(`${width}x${height}: replay retired 4 entries, no browser errors`);
    await page.close();
  }
} finally {
  await browser?.close();
  server.closeAllConnections();
  await new Promise(resolve => server.close(resolve));
}

