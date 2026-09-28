// Checks the real input path: click to lock the pointer, walk with W/D,
// look with the mouse, release with Escape.
import { chromium } from 'playwright-core';

const url = process.argv[2] ?? 'http://localhost:5173/';
const browser = await chromium.launch({
  executablePath: process.env.CHROME_PATH ?? '/opt/pw-browsers/chromium-1194/chrome-linux/chrome',
  args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'],
});
const page = await browser.newPage({ viewport: { width: 1280, height: 720 } });
await page.goto(url);
await page.waitForFunction(() => window.__nordlys && !document.getElementById('hud').classList.contains('is-loading'));
const state = () => page.evaluate(() => ({ ...window.__nordlys.state(), yaw: window.__nordlys.player.yaw, locked: !!document.pointerLockElement, playing: document.getElementById('hud').classList.contains('is-playing') }));

const results = [];
const check = (name, cond, detail) => { results.push(cond); console.log(`${cond ? 'ok  ' : 'FAIL'} ${name}${detail ? '  ' + detail : ''}`); };

const s0 = await state();
await page.keyboard.down('KeyW');
await page.waitForTimeout(800);
await page.keyboard.up('KeyW');
const sIdle = await state();
check('no movement before entering', Math.hypot(sIdle.x - s0.x, sIdle.z - s0.z) < 0.01);

await page.mouse.click(640, 360);
await page.waitForTimeout(500);
const s1 = await state();
check('click enters (pointer lock + HUD)', s1.locked && s1.playing);

await page.keyboard.down('KeyW');
await page.waitForTimeout(2500);
await page.keyboard.up('KeyW');
const s2 = await state();
const moved = Math.hypot(s2.x - s1.x, s2.z - s1.z);
// Headless software GL renders slowly, so judge by simulated time, not wall time.
const simDt = s2.elapsed - s1.elapsed;
check('W walks forward', moved > 0.5 * simDt && moved > 0.1, `moved ${moved.toFixed(2)}m in ${simDt.toFixed(2)}s sim, now on ${s2.surface}`);

await page.mouse.move(640, 360);
await page.mouse.move(900, 360, { steps: 10 });
await page.waitForTimeout(300);
const s3 = await state();
check('mouse turns the view', Math.abs(s3.yaw - s2.yaw) > 0.05, `yaw ${s2.yaw.toFixed(2)} → ${s3.yaw.toFixed(2)}`);

await page.keyboard.press('Escape');
await page.waitForTimeout(500);
let s4 = await state();
if (s4.locked) {
  // Headless Chromium has no browser UI to handle Esc; exit the lock the way
  // the browser does so we still exercise the app's release handling.
  console.log('     (headless browser ignores Esc for pointer lock; releasing via exitPointerLock)');
  await page.evaluate(() => document.exitPointerLock());
  await page.waitForTimeout(300);
  s4 = await state();
}
check('release shows the pause card', !s4.locked && !s4.playing);
const title = await page.textContent('#intro [data-title]');
check('pause card reads "Paused"', title === 'Paused');
const s5 = await state();
await page.keyboard.down('KeyW');
await page.waitForTimeout(600);
await page.keyboard.up('KeyW');
const s6 = await state();
check('no movement while released', Math.hypot(s6.x - s5.x, s6.z - s5.z) < 0.01);

await browser.close();
process.exit(results.every(Boolean) ? 0 : 1);
