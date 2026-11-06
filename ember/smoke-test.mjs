// Headless smoke test: plays through the idle loop with scripted key presses,
// saves a few screenshots, and fails on any page error.
//
//   node smoke-test.mjs
//
// It walks to the first creature and spares it, buys an upgrade at the
// campfire, strikes down the second, loses to the third (the dragon) and wakes
// back at the campfire, then checks that warmth builds while the page is closed.
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
const context = await browser.newContext({ viewport: { width: 960, height: 840 } });
const page = await context.newPage();
const errors = [];
page.on("pageerror", (e) => errors.push(e.message));
page.on("console", (m) => {
  if (m.type() === "error") errors.push(m.text());
});

const shot = (name) => page.screenshot({ path: join(here, `smoke-${name}.png`) });
const state = () => page.evaluate(() => ({
  scene: ember.scene, phase: ember.phase, hubPhase: ember.hubPhase, menu: ember.menu, hubSel: ember.hubSel,
  calm: ember.foe?.calm, foe: ember.foe?.key, hp: ember.hp, overReady: ember.overReady,
  warmth: ember.save.warmth, met: ember.save.met, friends: ember.save.friends.length,
  dist: ember.save.dist, nextAt: ember.save.nextAt, up: ember.save.up,
}));
const wait = (ms) => page.waitForTimeout(ms);
async function press(key, times = 1) {
  for (let i = 0; i < times; i++) {
    await page.keyboard.press(key);
    await wait(40);
  }
}
function check(ok, msg) {
  if (!ok) throw new Error(msg);
}

// Press Z through dialog (and keep hp topped up while dodging) until `done`.
async function playUntil(done, label, { protect = true, timeout = 30000 } = {}) {
  const start = Date.now();
  for (;;) {
    const s = await state();
    if (done(s)) return s;
    if (Date.now() - start > timeout) throw new Error(`timed out waiting for: ${label} (at ${JSON.stringify(s)})`);
    if (s.phase === "dodge" && s.scene === "battle") {
      if (protect) await page.evaluate(() => { ember.hp = ember.maxHp; });
    } else {
      await press("z");
    }
    await wait(120);
  }
}

async function pick(current, i, n) {
  await press("ArrowRight", (i - current + n) % n);
  await press("z");
}

// Skip the walk: put the next creature right in front of you.
async function walkToNext() {
  await page.evaluate(() => { ember.save.dist = ember.save.nextAt - 0.5; });
  await page.waitForFunction(() => ember.save.dist >= ember.save.nextAt && ember.hubSel === 0);
  await wait(400);
}

async function approach() {
  const s = await state();
  await pick(s.hubSel, 0, 3);
  await playUntil((st) => st.scene === "battle" && st.phase === "menu", "battle to start");
}

async function act(i) {
  const s = await state();
  await pick(s.menu, 1, 4); // talk
  if (i % 2) await press("ArrowRight");
  if (i >> 1) await press("ArrowDown");
  await press("z");
  await playUntil((st) => st.phase === "menu" || st.scene !== "battle", `act ${i} to finish`);
}

try {
  await page.goto(`http://localhost:${PORT}/index.html`);
  await page.evaluate(() => localStorage.clear());
  await page.reload();
  await wait(1200);
  await shot("title");

  // title → intro → the path
  await press("z");
  await playUntil((s) => s.scene === "hub", "the path");
  await wait(1500);
  let s = await state();
  check(s.warmth > 0 && s.dist > 0, `expected walking and warmth on the path, got ${JSON.stringify(s)}`);
  await shot("path");

  // the view toggle: ASCII by default, V switches to pixels and back, and it's remembered
  check((await page.evaluate(() => ember.view)) === "ascii", "expected the ASCII view by default");
  await press("v");
  await wait(300);
  check((await page.evaluate(() => [ember.view, localStorage.getItem("ember:view")].join())) === "pixel,pixel", "expected V to switch to pixels");
  await shot("path-pixel");
  await press("v");
  await wait(200);

  // 1. the moth: dim, hum, dim, hold still, then part ways
  await walkToNext();
  await shot("path-arrived");
  await approach();
  await wait(800);
  await shot("battle-moth");
  await pick((await state()).menu, 1, 4);
  await press("ArrowRight"); // dim
  await press("z");
  await playUntil((st) => st.phase === "dodge", "first dodge");
  await wait(2500);
  await page.evaluate(() => { ember.hp = ember.maxHp; });
  await shot("dodge");
  await playUntil((st) => st.phase === "menu", "first dodge to end");
  for (const i of [2, 1, 3]) await act(i);
  s = await state();
  check(s.calm >= 100, `expected the moth to be calm, got ${s.calm}`);
  await pick(s.menu, 3, 4); // part
  s = await playUntil((st) => st.scene === "hub", "back on the path after sparing");
  check(s.friends === 1 && s.met === 1, `expected one friend after sparing, got ${JSON.stringify(s)}`);

  // 2. the campfire: buy the first upgrade
  await page.evaluate(() => { ember.save.warmth = 1000; });
  await pick(s.hubSel, 1, 3);
  await wait(600);
  await press("z");
  await wait(300);
  await shot("campfire");
  s = await state();
  check(s.up.hearth === 1, `expected hearth level 1, got ${JSON.stringify(s.up)}`);
  await press("x");
  await wait(300);

  // 3. the firefly: strike it down for a burst of warmth
  await walkToNext();
  await approach();
  await wait(600);
  await shot("battle-firefly");
  const before = (await state()).warmth;
  await page.evaluate(() => { ember.foe.hp = 1; });
  await pick((await state()).menu, 0, 4); // strike
  await wait(500);
  await press("z");
  s = await playUntil((st) => st.scene === "hub", "back on the path after striking");
  check(s.met === 2 && s.warmth > before + 60, `expected a warmth burst, got ${JSON.stringify(s)}`);

  // 4. the dragon: get hit until the light goes out, then wake up at the campfire
  await walkToNext();
  await approach();
  await wait(600);
  await shot("battle-dragon");
  await pick((await state()).menu, 1, 4); // talk
  await press("z"); // check
  await playUntil((st) => st.scene === "battle" && st.phase === "dodge", "the dragon's turn", { protect: false });
  await wait(300);
  await page.evaluate(() => {
    ember.hp = 1;
    ember.debug.hurt();
  });
  s = await playUntil((st) => st.scene === "over" && st.overReady, "the light to go out", { protect: false });
  await shot("over");
  await press("z");
  s = await playUntil((st) => st.scene === "hub", "waking at the campfire");
  check(s.met === 2 && s.friends === 1, `losing shouldn't cost progress, got ${JSON.stringify(s)}`);

  // 5. warmth builds while the page is closed: pretend it was closed an hour
  const saved = await page.evaluate(() => { ember.save.t = 0; return ember.save.warmth; });
  await context.addInitScript(() => {
    if (sessionStorage.getItem("aged")) return;
    const save = JSON.parse(localStorage.getItem("ember:save"));
    save.t = Date.now() - 3600 * 1000;
    localStorage.setItem("ember:save", JSON.stringify(save));
    sessionStorage.setItem("aged", "1");
  });
  await page.reload();
  await wait(1200);
  s = await state();
  check(s.warmth > saved + 3600, `expected an hour of warmth, got ${s.warmth} from ${saved}`);
  await shot("title-continue");
  await press("z");
  await wait(1500);
  await shot("path-friends");
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
console.log("Played the whole loop with no page errors. Screenshots in", here);
