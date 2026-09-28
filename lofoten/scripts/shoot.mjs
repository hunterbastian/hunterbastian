// Screenshot helper: node scripts/shoot.mjs [url] — captures a set of
// viewpoints along the route into ./screenshots.
import { chromium } from 'playwright-core';
import { mkdirSync } from 'node:fs';

const url = process.argv[2] ?? 'http://localhost:5173/';
const only = process.argv[3];
const exe = process.env.CHROME_PATH ?? '/opt/pw-browsers/chromium-1194/chrome-linux/chrome';
mkdirSync('screenshots', { recursive: true });

const views = [
  { name: '01-porch', x: -112, z: -18.2, yaw: -0.55, pitch: 0.08 },
  { name: '02-waterfront', x: -80, z: -21, yaw: -1.35, pitch: 0.02 },
  { name: '03-village-from-sea', x: -60, z: -21.5, yaw: 2.6, pitch: 0.05 },
  { name: '04-bridge-approach', x: -22, z: -16, yaw: -1.3, pitch: 0.02 },
  { name: '05-on-bridge', x: 8, z: -12, yaw: 0.3, pitch: 0.12 },
  { name: '06-trail', x: 50, z: 1, yaw: -1.7, pitch: -0.02 },
  { name: '07-overlook-west', x: 71, z: -26.5, yaw: 1.35, pitch: -0.08 },
  { name: '08-overlook-north', x: 71, z: -27, yaw: 0.1, pitch: 0.18 },
];

const browser = await chromium.launch({
  executablePath: exe,
  args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'],
});
const page = await browser.newPage({ viewport: { width: 1280, height: 720 } });
const errors = [];
page.on('console', (m) => { if (m.type() === 'error' || m.type() === 'warning') errors.push(`${m.type()}: ${m.text()}`); });
page.on('pageerror', (e) => errors.push(`pageerror: ${e.message}`));
await page.goto(url, { waitUntil: 'load' });
await page.waitForFunction(() => window.__nordlys, null, { timeout: 60000 });
await page.evaluate(() => { document.getElementById('hud').classList.add('is-playing'); });
for (const v of views) {
  if (only && !v.name.includes(only)) continue;
  await page.evaluate((v) => window.__nordlys.teleport(v.x, v.z, v.yaw, v.pitch), v);
  await page.waitForTimeout(1500);
  await page.screenshot({ path: `screenshots/${v.name}.png` });
  console.log('shot', v.name, JSON.stringify(await page.evaluate(() => window.__nordlys.state())));
}
if (errors.length) console.log('console:', errors.slice(0, 20).join('\n'));
await browser.close();
