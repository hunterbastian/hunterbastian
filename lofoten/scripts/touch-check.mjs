// Mobile check with an emulated iPhone (Chromium + touch): tap to enter,
// left-thumb joystick walks, right-thumb drag looks, both at once, pause.
//   npm run dev   then   npm run check:touch
import { chromium } from 'playwright-core';
import { mkdirSync } from 'node:fs';

const url = process.argv[2] ?? 'http://localhost:5173/';
mkdirSync('screenshots', { recursive: true });
const browser = await chromium.launch({
  executablePath: process.env.CHROME_PATH ?? '/opt/pw-browsers/chromium-1194/chrome-linux/chrome',
  args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'],
});
const context = await browser.newContext({
  viewport: { width: 390, height: 844 },
  deviceScaleFactor: 3,
  isMobile: true,
  hasTouch: true,
  userAgent:
    'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1',
});
const page = await context.newPage();
const errors = [];
page.on('pageerror', (e) => errors.push(e.message));
page.on('console', (m) => m.type() === 'error' && errors.push(m.text()));
const cdp = await context.newCDPSession(page);
const touches = (type, points) => cdp.send('Input.dispatchTouchEvent', { type, touchPoints: points.map(([x, y, id]) => ({ x, y, id })) });

await page.goto(url);
await page.waitForFunction(() => window.__nordlys && !document.getElementById('hud').classList.contains('is-loading'));
const state = () =>
  page.evaluate(() => ({
    ...window.__nordlys.state(),
    yaw: window.__nordlys.player.yaw,
    playing: document.getElementById('hud').classList.contains('is-playing'),
    input: document.getElementById('hud').dataset.input,
    action: document.querySelector('#intro [data-action]').textContent,
    title: document.querySelector('#intro [data-title]').textContent,
    mobile: window.__nordlys.mobile,
  }));
const results = [];
const check = (name, cond, detail = '') => {
  results.push(cond);
  console.log(`${cond ? 'ok  ' : 'FAIL'} ${name}${detail ? '  ' + detail : ''}`);
};
// Hold a gesture across enough frames for the (slow, software) renderer.
const holdFrames = async (n) => {
  for (let i = 0; i < n; i++) await page.evaluate(() => new Promise((r) => requestAnimationFrame(() => r())));
};

let s = await state();
check('detected as touch device', s.input === 'touch' && s.mobile, `input=${s.input}`);
check('card says "Tap to enter"', s.action === 'Tap to enter');
await page.screenshot({ path: 'screenshots/mobile-intro.png' });

await page.touchscreen.tap(195, 430);
await holdFrames(3);
s = await state();
check('tap enters the walk', s.playing);

// Left thumb: push the joystick up (forward).
let a = await state();
await touches('touchStart', [[90, 700, 1]]);
for (let i = 1; i <= 6; i++) await touches('touchMove', [[90, 700 - i * 8, 1]]);
await holdFrames(12);
const stickVisible = await page.evaluate(() => document.getElementById('stick').classList.contains('is-visible'));
await page.screenshot({ path: 'screenshots/mobile-walking.png' });
await touches('touchEnd', []);
let b = await state();
const moved = Math.hypot(b.x - a.x, b.z - a.z);
check('joystick shows under the thumb', stickVisible);
check('left thumb walks', moved > 0.3 * (b.elapsed - a.elapsed) && moved > 0.05, `moved ${moved.toFixed(2)}m in ${(b.elapsed - a.elapsed).toFixed(2)}s sim`);

// Right thumb: drag left to turn left.
a = await state();
await touches('touchStart', [[300, 420, 2]]);
for (let i = 1; i <= 8; i++) await touches('touchMove', [[300 - i * 10, 420, 2]]);
await touches('touchEnd', []);
await holdFrames(2);
b = await state();
check('right thumb looks around', b.yaw - a.yaw > 0.2, `yaw ${a.yaw.toFixed(2)} → ${b.yaw.toFixed(2)}`);

// Both thumbs at once.
a = await state();
await touches('touchStart', [[90, 700, 3], [300, 420, 4]]);
for (let i = 1; i <= 6; i++) await touches('touchMove', [[90, 700 - i * 8, 3], [300 + i * 6, 420, 4]]);
await holdFrames(10);
await touches('touchEnd', []);
b = await state();
check('walk and look together', Math.hypot(b.x - a.x, b.z - a.z) > 0.02 && a.yaw - b.yaw > 0.1, `yaw Δ ${(b.yaw - a.yaw).toFixed(2)}`);

// Pause button.
await page.touchscreen.tap(390 - 12 - 22, 10 + 22);
await holdFrames(2);
s = await state();
check('pause button pauses', !s.playing && s.title === 'Paused' && s.action === 'Tap to continue');
a = await state();
await touches('touchStart', [[90, 700, 5]]);
await touches('touchMove', [[90, 640, 5]]);
await holdFrames(6);
await touches('touchEnd', []);
b = await state();
check('no movement while paused', Math.hypot(b.x - a.x, b.z - a.z) < 0.001);
await page.touchscreen.tap(195, 430);
await holdFrames(2);
check('tap resumes', (await state()).playing);

// Landscape.
await page.setViewportSize({ width: 844, height: 390 });
await holdFrames(4);
await page.screenshot({ path: 'screenshots/mobile-landscape.png' });
const canvasSize = await page.evaluate(() => [innerWidth, innerHeight, document.getElementById('scene').clientWidth, document.getElementById('scene').clientHeight]);
check('canvas fills landscape viewport', canvasSize[0] === canvasSize[2] && canvasSize[1] === canvasSize[3], canvasSize.join('x'));

if (errors.length) console.log('page errors:\n' + errors.join('\n'));
check('no page errors', errors.length === 0);
await browser.close();
process.exit(results.every(Boolean) ? 0 : 1);
