// Headless smoke test: plays through both endings with scripted key presses,
// saves a few screenshots, and fails on any page error.
//
//   node smoke-test.mjs
//
// Needs Playwright with Chromium (npm i -g playwright && npx playwright install chromium).
import { spawn } from "node:child_process";
import { createRequire } from "node:module";
import { join } from "node:path";

const require = createRequire(import.meta.url);
const { chromium } = require("playwright");

const PORT = 8124;
const here = new URL(".", import.meta.url).pathname;
const server = spawn("python3", ["-m", "http.server", String(PORT)], { cwd: here, stdio: "ignore" });
await new Promise((r) => setTimeout(r, 800));

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 960, height: 840 } });
const errors = [];
page.on("pageerror", (e) => errors.push(e.message));
page.on("console", (m) => {
  // the web font is optional; ignore it failing to load offline
  if (m.type() === "error" && !/fonts\.g|ERR_|Failed to load resource/.test(m.text())) errors.push(m.text());
});

const shot = (name) => page.screenshot({ path: join(here, `smoke-${name}.png`) });
const state = () => page.evaluate(() => ({
  scene: ember.scene, phase: ember.phase, menu: ember.menu, act: ember.act,
  calm: ember.moth.calm, hp: ember.hp, ending: ember.ending, endReady: ember.endReady,
}));
const wait = (ms) => page.waitForTimeout(ms);
async function press(key, times = 1) {
  for (let i = 0; i < times; i++) {
    await page.keyboard.press(key);
    await wait(40);
  }
}

// Press Z through dialog (and keep hp topped up while dodging) until `done`.
async function playUntil(done, label, timeout = 30000) {
  const start = Date.now();
  for (;;) {
    const s = await state();
    if (done(s)) return s;
    if (Date.now() - start > timeout) throw new Error(`timed out waiting for: ${label} (at ${JSON.stringify(s)})`);
    if (s.phase === "dodge") await page.evaluate(() => { ember.hp = ember.maxHp; });
    else await press("z");
    await wait(120);
  }
}

async function pickMenu(i) {
  const s = await state();
  await press("ArrowRight", (i - s.menu + 4) % 4);
  await press("z");
}

async function act(i) {
  await pickMenu(1); // talk
  if (i % 2) await press("ArrowRight");
  if (i >> 1) await press("ArrowDown");
  await press("z");
  await playUntil((s) => s.phase === "menu" || s.scene !== "battle", `act ${i} to finish`);
}

try {
  await page.goto(`http://localhost:${PORT}/index.html`);
  await wait(1500);
  await shot("title");

  // title → intro → battle
  await press("z");
  await playUntil((s) => s.scene === "battle", "battle to start");
  await wait(1200);
  await shot("menu");

  // The kind route: dim, hum, dim, hold still, then part.
  await pickMenu(1);
  await press("ArrowRight"); // dim
  await press("z");
  await playUntil((s) => s.phase === "dodge", "first dodge");
  await wait(2500);
  await page.evaluate(() => { ember.hp = ember.maxHp; });
  await shot("dodge");
  await playUntil((s) => s.phase === "menu", "first dodge to end");
  for (const i of [2, 1, 3]) await act(i);

  let s = await state();
  if (s.calm < 100) throw new Error(`expected the moth to be calm, got ${s.calm}`);
  await pickMenu(3); // part
  s = await playUntil((st) => st.scene === "end" && st.endReady, "warm ending");
  if (s.ending !== "warm") throw new Error(`expected warm ending, got ${s.ending}`);
  await shot("end-warm");

  // The other route: strike until it falls.
  await press("z");
  await playUntil((st) => st.scene === "title", "back to title");
  await press("z");
  await playUntil((st) => st.scene === "battle", "second battle");
  await page.evaluate(() => { ember.moth.hp = 1; });
  await pickMenu(0); // strike
  await wait(500);
  await shot("strike");
  await press("z");
  s = await playUntil((st) => st.scene === "end" && st.endReady, "cold ending");
  if (s.ending !== "cold") throw new Error(`expected cold ending, got ${s.ending}`);
  await shot("end-cold");
} catch (err) {
  errors.push(String(err));
} finally {
  await browser.close();
  server.kill();
}

if (errors.length) {
  console.log("FAILED:\n" + errors.join("\n"));
  process.exit(1);
}
console.log("Both endings reached with no page errors. Screenshots in", here);
