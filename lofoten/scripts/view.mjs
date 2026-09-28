// One-off viewpoint capture: node scripts/view.mjs name x z yaw pitch [query]
import { chromium } from 'playwright-core';
const [name, x, z, yaw, pitch, query = ''] = process.argv.slice(2);
const browser = await chromium.launch({
  executablePath: process.env.CHROME_PATH ?? '/opt/pw-browsers/chromium-1194/chrome-linux/chrome',
  args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'],
});
const page = await browser.newPage({ viewport: { width: 1280, height: 720 } });
page.on('pageerror', (e) => console.log('pageerror', e.message));
await page.goto(`http://localhost:5173/${query}`);
await page.waitForFunction(() => window.__nordlys);
await page.evaluate(() => document.getElementById('hud').classList.add('is-playing'));
await page.evaluate(([x, z, yaw, pitch]) => window.__nordlys.teleport(+x, +z, +yaw, +pitch), [x, z, yaw, pitch]);
await page.waitForTimeout(1500);
await page.screenshot({ path: `screenshots/${name}.png` });
console.log(JSON.stringify(await page.evaluate(() => window.__nordlys.state())));
await browser.close();
