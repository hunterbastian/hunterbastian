// Headless UI checks for meadow against the production build. Usage: npm run test:ui [-- name-filter]
// Needs Playwright. Resolved from MEADOW_PLAYWRIGHT (path to a package.json that depends on it), else a
// normal/global install. MEADOW_CHROME overrides the browser binary. Screenshots land in /tmp/meadow-ui/.
import { createRequire } from 'module';
import { execSync } from 'child_process';
import http from 'http'; import fs from 'fs'; import path from 'path'; import { fileURLToPath } from 'url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../dist');
function loadPlaywright() {
  const tries = [process.env.MEADOW_PLAYWRIGHT, import.meta.url];
  try { tries.push(path.join(execSync('npm root -g').toString().trim(), 'noop.js')); } catch { /* no global npm */ }
  for (const from of tries.filter(Boolean)) {
    try { return createRequire(from)('playwright'); } catch { /* try the next one */ }
  }
  throw new Error('Playwright not found: npm i -g playwright, or set MEADOW_PLAYWRIGHT');
}
const { chromium } = loadPlaywright();
const OUT = '/tmp/meadow-ui'; fs.mkdirSync(OUT, { recursive: true });
const TYPES = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.map': 'application/json', '.json': 'application/json', '.png': 'image/png', '.svg': 'image/svg+xml', '.webmanifest': 'application/manifest+json' };
const server = http.createServer((req, res) => {
  const rel = decodeURIComponent(req.url.split('?')[0]), file = path.join(ROOT, rel === '/' ? 'index.html' : rel);
  if (!file.startsWith(ROOT)) { res.writeHead(403); res.end(); return; }
  fs.readFile(file, (err, data) => { if (err) { res.writeHead(404); res.end(); return; } res.writeHead(200, { 'content-type': TYPES[path.extname(file)] || 'application/octet-stream' }); res.end(data); });
});
await new Promise((r) => server.listen(0, r));
const BASE = `http://localhost:${server.address().port}/`;
// Real GPU on a Mac; SwiftShader everywhere else (CI, cloud containers).
const gpu = process.platform === 'darwin' ? ['--use-angle=metal', '--enable-gpu'] : ['--use-angle=swiftshader', '--enable-unsafe-swiftshader'];
const browser = await chromium.launch({ executablePath: process.env.MEADOW_CHROME || undefined, args: [...gpu, '--ignore-gpu-blocklist'] });

const tests = [];
const test = (name, fn) => tests.push({ name, fn });
const assert = (cond, msg) => { if (!cond) throw new Error(msg); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
// Fonts come from Google; offline or proxied runs can't reach them, which isn't a game error.
const ignore = (t) => /fonts\.(googleapis|gstatic)|ERR_CERT|ERR_NAME_NOT_RESOLVED|Failed to load resource/i.test(t);

async function open({ w = 1280, h = 800, touch = false, storage = null } = {}) {
  const ctx = await browser.newContext({ viewport: { width: w, height: h }, hasTouch: touch, isMobile: touch, deviceScaleFactor: 1 });
  if (storage) await ctx.addInitScript((s) => { for (const [k, v] of Object.entries(s)) localStorage.setItem(k, v); }, storage);
  const page = await ctx.newPage(); page.errors = [];
  page.on('pageerror', (e) => page.errors.push(e.message));
  page.on('console', (m) => { if (m.type() === 'error' && !ignore(m.text())) page.errors.push(m.text()); });
  await page.goto(BASE, { waitUntil: 'load' });
  await page.waitForFunction(() => window.__meadow && document.querySelector('#loading.is-done'), null, { timeout: 60000 });
  await sleep(800);
  page.ctx = ctx;
  page.done = () => ctx.close();
  return page;
}
const withPage = (opts, fn) => async () => { const p = await open(opts); try { await fn(p); assert(!p.errors.length, 'console: ' + p.errors.join(' | ')); } finally { await p.done(); } };
const shot = (page, name) => page.screenshot({ path: `${OUT}/${name}.png` });
const world = (page) => page.evaluate(() => { const w = window.__meadow.world(); return { walls: w.walls.length, strokes: w.strokes.length }; });
const ui = (page) => page.evaluate(() => window.__meadow.ui());
const vis = (page, sel) => page.evaluate((s) => {
  const e = document.querySelector(s); if (!e) return false;
  const cs = getComputedStyle(e), r = e.getBoundingClientRect();
  return !e.hidden && cs.display !== 'none' && cs.visibility !== 'hidden' && +cs.opacity > 0.05 && r.width > 0 && r.height > 0;
}, sel);
async function drag(page, from, to, steps = 18) {
  await page.mouse.move(from[0], from[1]);
  await page.mouse.down();
  for (let i = 1; i <= steps; i++) {
    await page.mouse.move(from[0] + ((to[0] - from[0]) * i) / steps, from[1] + ((to[1] - from[1]) * i) / steps);
    await sleep(25);
  }
  await page.mouse.up();
  await sleep(400);
}

// ---- checks
test('loads the demo meadow', withPage({}, async (p) => {
  const w = await world(p);
  assert(w.walls === 1 && w.strokes === 2, `demo world: ${JSON.stringify(w)}`);
  assert(await vis(p, '.toolbar'), 'toolbar hidden');
  assert(!(await vis(p, '#help')), 'help dialog should not open under automation');
  await shot(p, 'loads');
}));

test('tools and wall height', withPage({}, async (p) => {
  for (const t of ['path', 'erase', 'look', 'wall']) {
    await p.click(`.tool[data-tool="${t}"]`);
    assert((await ui(p)).tool === t, `tool ${t}`);
    assert(await p.getAttribute(`.tool[data-tool="${t}"]`, 'aria-checked') === 'true', `aria-checked ${t}`);
    assert((await vis(p, '#heightGroup')) === (t === 'wall'), `height stepper visibility on ${t}`);
  }
  await p.keyboard.press('2');
  assert((await ui(p)).tool === 'path', 'key 2 → path');
  await p.keyboard.press('1');
  const before = (await ui(p)).courses;
  await p.click('#heightUp');
  await p.keyboard.press(']');
  assert((await ui(p)).courses === before + 2, 'height up');
  await p.keyboard.press('[');
  assert((await ui(p)).courses === before + 1, 'height down');
}));

test('draw a wall, undo, redo', withPage({}, async (p) => {
  await drag(p, [880, 620], [440, 560]);
  assert((await world(p)).walls === 2, 'wall added');
  await shot(p, 'wall');
  await p.click('#undoBtn');
  assert((await world(p)).walls === 1, 'undo');
  await p.keyboard.press('Control+Shift+Z');
  assert((await world(p)).walls === 2, 'redo');
}));

test('a tiny drag lays nothing', withPage({}, async (p) => {
  await drag(p, [640, 620], [646, 622], 3);
  assert((await world(p)).walls === 1, 'no wall from a click');
}));

test('paint a path', withPage({}, async (p) => {
  await p.keyboard.press('2');
  await drag(p, [300, 700], [500, 600]);
  assert((await world(p)).strokes === 3, 'stroke added');
  await shot(p, 'path');
}));

test('erase splits the wall', withPage({}, async (p) => {
  await p.keyboard.press('3');
  // Sweep across the whole view so the eraser is sure to cross the demo wall.
  await drag(p, [200, 360], [1100, 360], 30);
  const w = await world(p);
  assert(w.walls !== 1 && w.strokes === 3, `after erase: ${JSON.stringify(w)}`);
  await shot(p, 'erase');
}));

test('pixel toggle', withPage({}, async (p) => {
  assert((await ui(p)).pixel.pixelSize === 4, 'pixels on by default');
  await p.keyboard.press('p');
  assert((await ui(p)).pixel.pixelSize === 1, 'P turns pixels off');
  await shot(p, 'pixels-off');
  await p.keyboard.press('p');
  assert((await ui(p)).pixel.pixelSize === 4, 'P turns them back on');
}));

test('the meadow persists across reloads', withPage({}, async (p) => {
  await drag(p, [880, 620], [440, 560]);
  await p.reload({ waitUntil: 'load' });
  await p.waitForFunction(() => window.__meadow);
  assert((await world(p)).walls === 2, 'wall survived reload');
}));

test('phone layout', withPage({ w: 390, h: 844, touch: true }, async (p) => {
  const overflow = await p.evaluate(() => {
    const bar = document.querySelector('.toolbar');
    const r = bar.getBoundingClientRect();
    const clipped = [...bar.querySelectorAll('button')].some((b) => {
      const br = b.getBoundingClientRect();
      return br.width > 0 && (br.left < r.left || br.right > r.right + 0.5);
    });
    return r.left < 0 || r.right > innerWidth || bar.scrollWidth > bar.clientWidth + 1 || clipped;
  });
  assert(!overflow, 'toolbar overflows or clips a button');
  await shot(p, 'phone');
}));

// ---- run
const filter = process.argv[2];
let failed = 0;
for (const t of tests.filter((t) => !filter || t.name.includes(filter))) {
  const t0 = Date.now();
  try { await t.fn(); console.log(`  ✓ ${t.name} (${Date.now() - t0} ms)`); }
  catch (e) { failed++; console.log(`  ✗ ${t.name}: ${e.message}`); }
}
await browser.close();
server.close();
console.log(failed ? `\n${failed} failed. Screenshots in ${OUT}` : `\nall passed. Screenshots in ${OUT}`);
process.exit(failed ? 1 : 0);
