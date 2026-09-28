// End-to-end check in a real browser: load the scene with ?autowalk, let the
// autopilot drive the same player/physics code the keyboard uses, and verify
// the whole route (porch → waterfront → bridge → overlook) is walkable.
//
//   npm run dev            (in another terminal)
//   npm run walk [-- url]
import { chromium } from 'playwright-core';
import { mkdirSync } from 'node:fs';

const url = process.argv[2] ?? 'http://localhost:5173/';
const exe = process.env.CHROME_PATH ?? '/opt/pw-browsers/chromium-1194/chrome-linux/chrome';
const TIME_SCALE = Number(process.env.TIME_SCALE ?? 4);
mkdirSync('screenshots', { recursive: true });

const browser = await chromium.launch({
  executablePath: exe,
  args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'],
});
const page = await browser.newPage({ viewport: { width: 1280, height: 720 } });
const errors = [];
page.on('pageerror', (e) => errors.push(e.message));
page.on('console', (m) => m.type() === 'error' && errors.push(m.text()));

const target = new URL(url);
target.searchParams.set('autowalk', '');
await page.goto(target.href);
await page.waitForFunction(() => window.__nordlys);
await page.evaluate((s) => {
  document.getElementById('hud').classList.add('is-playing');
  window.__nordlys.setTimeScale(s);
}, TIME_SCALE);

const zones = [];
let last = null;
let maxStuck = 0;
const started = Date.now();
while (true) {
  const s = await page.evaluate(() => window.__nordlys.state());
  maxStuck = Math.max(maxStuck, s.stuck ?? 0);
  if (s.zone && s.zone !== zones[zones.length - 1]) {
    zones.push(s.zone);
    await page.screenshot({ path: `screenshots/walk-${zones.length}-${s.zone}.png` });
    console.log(`→ ${s.zone.padEnd(10)} at (${s.x.toFixed(1)}, ${s.z.toFixed(1)}) y=${s.y.toFixed(2)}  sim t=${s.elapsed.toFixed(1)}s`);
  }
  if (s.done) {
    last = s;
    break;
  }
  if (s.stuck > 3) {
    last = s;
    break;
  }
  if (Date.now() - started > 15 * 60 * 1000) {
    last = s;
    console.log('timeout');
    break;
  }
  await page.waitForTimeout(250);
}
await page.screenshot({ path: 'screenshots/walk-end.png' });
await browser.close();

const expected = ['porch', 'waterfront', 'bridge', 'overlook'];
const ok = last.done && JSON.stringify(zones) === JSON.stringify(expected) && errors.length === 0;
console.log(`\nzones: ${zones.join(' → ')}`);
console.log(`finished: ${last.done}  sim time: ${last.elapsed.toFixed(1)}s  final: (${last.x.toFixed(1)}, ${last.z.toFixed(1)}) y=${last.y.toFixed(2)}  max stuck: ${maxStuck.toFixed(2)}s`);
if (errors.length) console.log('page errors:\n' + errors.join('\n'));
console.log(ok ? 'PASS: full route walkable in the browser' : 'FAIL');
process.exit(ok ? 0 : 1);
