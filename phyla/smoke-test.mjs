// Headless smoke test: serve the folder, open the workshop, set a creature
// loose in the world, simulate a few seconds, and fail on any page error.
// Needs Playwright (`npm i -D playwright`), nothing else.
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { extname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const root = fileURLToPath(new URL('.', import.meta.url));
const types = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml' };
const server = createServer(async (req, res) => {
  const path = decodeURIComponent(req.url.split('?')[0]);
  try {
    const data = await readFile(join(root, path === '/' ? 'index.html' : path));
    res.writeHead(200, { 'Content-Type': types[extname(path)] || 'application/octet-stream' });
    res.end(data);
  } catch {
    res.writeHead(404);
    res.end();
  }
});
await new Promise((r) => server.listen(0, r));
const url = `http://localhost:${server.address().port}/index.html`;

let chromium;
try {
  ({ chromium } = await import('playwright'));
} catch {
  // fall back to a globally installed copy (NODE_PATH)
  ({ chromium } = createRequire(import.meta.url)('playwright'));
}
const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1280, height: 720 } });
const errors = [];
page.on('pageerror', (e) => errors.push(e.message));
page.on('console', (m) => m.type() === 'error' && errors.push(m.text()));

const ready = (expr) => page.waitForFunction(expr, null, { timeout: 60000, polling: 250 });

await page.goto(`${url}?q=low`);
await ready('window.phyla && phyla.mode');
await page.click('[data-a=workshop]');
await ready('phyla.mode && phyla.mode.creature');
await page.click('[data-roll]');
await page.click('[data-done]');
await ready('phyla.mode && phyla.mode.player');
const report = await page.evaluate(() => {
  const g = window.phyla.mode;
  const r = window.phyla.renderer;
  const render = r.render;
  r.render = () => {};
  for (let i = 0; i < 400; i++) g.update(0.05); // twenty seconds of island life
  r.render = render;
  g.update(0.016);
  const p = g.player.pos;
  return { critters: g.critters.length, species: g.species.length, finite: [p.x, p.y, p.z].every(Number.isFinite), drawCalls: r.info.render.calls };
});
await page.screenshot({ path: join(root, 'smoke-shot.png') });
await browser.close();
server.close();

console.log(report);
if (errors.length || !report.finite || report.critters < 10) {
  console.error('FAILED\n' + errors.join('\n'));
  process.exit(1);
}
console.log('Phyla smoke test passed. Screenshot at smoke-shot.png');
