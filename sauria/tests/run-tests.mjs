#!/usr/bin/env node
// Sauria test runner — `node tests/run-tests.mjs` from sauria/.
//
// 1. Serves sauria/ from a tiny static server on a free port.
// 2. Launches headless Chromium (Playwright) with SwiftShader WebGL.
// 3. Runs tests/unit.html (browser-side unit tests, results on window.__unit).
// 4. Runs smoke tests against the real game: survival in both render styles,
//    movement, death → death screen, a phone-sized touch run, an upright phone
//    (the game turned sideways), and a hunter expedition (planner → drop-off →
//    hunting → shot).
// Screenshots land in tests/out/ (gitignored). Exits non-zero on any failure.
//
// Headless WebGL is software-rendered and very slow (a frame can take a
// second), and main.js clamps dt to 0.05 s, so game time crawls. The smoke
// tests therefore fast-forward the simulation with `__sauria.advance()` /
// `hunterMode.update()` (no drawing) and only wait on real frames for
// screenshots.
//
// Flags: --unit (unit only) · --smoke (smoke only) · --only <text> (tests whose
// name contains text) · --headed (show the browser) · --keep-going is implied.

import http from "node:http";
import { readFile, stat, mkdir } from "node:fs/promises";
import { execSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const OUT = path.join(ROOT, "tests", "out");

const args = process.argv.slice(2);
const flag = (name) => args.includes(name);
const onlyIdx = args.indexOf("--only");
const ONLY = onlyIdx >= 0 ? (args[onlyIdx + 1] || "").toLowerCase() : "";
const RUN_UNIT = !flag("--smoke");
const RUN_SMOKE = !flag("--unit");

/* --- Static server ------------------------------------------------------- */

const TYPES = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".json": "application/json",
  ".webmanifest": "application/manifest+json",
  ".ico": "image/x-icon",
};

function startServer() {
  const server = http.createServer(async (req, res) => {
    try {
      const rel = decodeURIComponent(new URL(req.url, "http://localhost").pathname);
      let file = path.normalize(path.join(ROOT, rel));
      if (!file.startsWith(ROOT)) throw new Error("outside root");
      if ((await stat(file)).isDirectory()) file = path.join(file, "index.html");
      const body = await readFile(file);
      res.writeHead(200, { "Content-Type": TYPES[path.extname(file)] || "application/octet-stream", "Cache-Control": "no-store" });
      res.end(body);
    } catch {
      res.writeHead(404, { "Content-Type": "text/plain" });
      res.end("not found");
    }
  });
  return new Promise((resolve) => server.listen(0, "127.0.0.1", () => resolve(server)));
}

/* --- Playwright ---------------------------------------------------------- */

async function loadPlaywright() {
  try {
    return await import("playwright");
  } catch {
    /* not installed locally — try the global install */
  }
  try {
    const root = execSync("npm root -g", { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();
    return await import(pathToFileURL(path.join(root, "playwright", "index.mjs")).href);
  } catch {
    console.error("Playwright not found. Install it with:\n  npm i -g playwright && npx playwright install chromium");
    process.exit(2);
  }
}

/* --- Reporting ------------------------------------------------------------ */

const results = []; // { name, status: "pass" | "fail" | "known" | "unexpected-pass", ms, error }
const t0 = Date.now();
const secs = (ms) => `${(ms / 1000).toFixed(1)}s`;
const C = process.stdout.isTTY ? { g: "\x1b[32m", r: "\x1b[31m", y: "\x1b[33m", d: "\x1b[2m", x: "\x1b[0m" } : { g: "", r: "", y: "", d: "", x: "" };

function report(r) {
  results.push(r);
  const tag =
    r.status === "pass" ? `${C.g}PASS${C.x}` : r.status === "known" ? `${C.y}KNOWN${C.x}` : r.status === "unexpected-pass" ? `${C.y}XPASS${C.x}` : `${C.r}FAIL${C.x}`;
  console.log(`  ${tag}  ${r.name} ${C.d}(${secs(r.ms)})${C.x}`);
  if (r.info) console.log(`        ${C.d}${r.info}${C.x}`);
  if (r.error) console.log(`        ${String(r.error).split("\n").join("\n        ")}`);
  if (r.known) console.log(`        ${C.y}known issue:${C.x} ${r.known}`);
}

/* --- Smoke helpers -------------------------------------------------------- */

const BOOT_TIMEOUT = 240_000; // world build + first shader compile under SwiftShader
const SHOT_TIMEOUT = 120_000;

/** Errors that come from the sandbox, not the game. */
const IGNORED = [/fonts\.(googleapis|gstatic)\.com/];

async function openPage(browser, url, { mobile = false, upright = false } = {}) {
  const ctx = await browser.newContext(
    upright
      ? { viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true, deviceScaleFactor: 3 }
      : mobile
        ? { viewport: { width: 844, height: 390 }, hasTouch: true, isMobile: true, deviceScaleFactor: 2 }
        : { viewport: { width: 960, height: 540 } },
  );
  // Web fonts are cosmetic; stub them so runs are offline-safe and deterministic.
  await ctx.route(/fonts\.(googleapis|gstatic)\.com/, (route) => route.fulfill({ status: 200, contentType: "text/css", body: "" }));
  const page = await ctx.newPage();
  if (upright) {
    // An iPhone's portrait insets: the notch on top, the home indicator below.
    const cdp = await ctx.newCDPSession(page);
    await cdp.send("Emulation.setSafeAreaInsetsOverride", { insets: { top: 47, bottom: 34, left: 0, right: 0 } }).catch(() => {});
  }
  const errors = [];
  page.on("pageerror", (e) => errors.push(`pageerror: ${e.message}`));
  page.on("console", (m) => {
    if (m.type() !== "error") return;
    const text = m.text();
    if (!IGNORED.some((re) => re.test(text))) errors.push(`console.error: ${text}`);
  });
  page.on("response", (r) => {
    if (r.status() >= 400 && !IGNORED.some((re) => re.test(r.url()))) errors.push(`HTTP ${r.status()}: ${r.url()}`);
  });
  await page.goto(url);
  return { ctx, page, errors };
}

const waitState = (page, states, timeout = BOOT_TIMEOUT) =>
  page.waitForFunction((s) => window.__sauria && s.includes(window.__sauria.state), [].concat(states), { timeout, polling: 250 });

/** Wait for `n` real frames to be drawn (each can take ~1 s under SwiftShader). */
const frames = (page, n = 2) =>
  page.evaluate(
    (n) =>
      new Promise((resolve) => {
        let left = n;
        const tick = () => (--left <= 0 ? resolve() : requestAnimationFrame(tick));
        requestAnimationFrame(tick);
      }),
    n,
  );

async function shot(page, name) {
  await mkdir(OUT, { recursive: true });
  await page.screenshot({ path: path.join(OUT, `${name}.png`), timeout: SHOT_TIMEOUT });
}

function expect(cond, msg) {
  if (!cond) throw new Error(msg);
}

/**
 * Fail on page errors, console errors, 404s and errors main.js recorded since
 * the last check (each error fails only the step it happened in).
 */
async function expectClean(page, errors) {
  const recorded = await page.evaluate(() => (window.__sauria ? window.__sauria.errors.slice() : []));
  const fresh = recorded.slice(errors.gameSeen || 0);
  errors.gameSeen = recorded.length;
  const all = [...errors.splice(0), ...fresh.map((e) => `game error: ${e}`)];
  expect(all.length === 0, `errors on the page:\n${[...new Set(all)].slice(0, 8).join("\n")}`);
}

/** Hold keys while fast-forwarding `seconds` of game time; returns metres travelled. */
async function driveWithKeys(page, keys, seconds) {
  const start = await page.evaluate(() => __sauria.player.position.toArray());
  for (const k of keys) await page.keyboard.down(k);
  let info;
  try {
    // Read the result in the same task as the fast-forward: a real frame could
    // otherwise slip in after the keys are released.
    info = await page.evaluate((s) => {
      __sauria.advance(s);
      const p = __sauria.player;
      return { pos: p.position.toArray(), gait: p.gait, state: __sauria.state };
    }, seconds);
  } finally {
    for (const k of keys.slice().reverse()) await page.keyboard.up(k);
  }
  return { dist: Math.hypot(info.pos[0] - start[0], info.pos[2] - start[2]), ...info };
}

/* --- Smoke tests ----------------------------------------------------------- */
// Each suite opens one page; its steps share it and report individually.

const SUITES = [
  {
    name: "survival · pixel",
    query: "?species=dryosaurus&growth=0.3&t=0.42&style=pixel&pixel=0.5&quality=low&mute=1&debug=1",
    steps: [
      {
        name: "survival (dryosaurus, pixel): autostarts into play",
        async run({ page, errors }) {
          await waitState(page, "playing");
          const info = await page.evaluate(() => ({
            state: __sauria.state,
            style: __sauria.style,
            canvasStyle: document.getElementById("game").dataset.style,
            species: __sauria.player?.species.id,
            alive: __sauria.player?.alive,
            hud: !!document.querySelector("#ui *"),
          }));
          expect(info.species === "dryosaurus" && info.alive, `expected a living dryosaurus, got ${JSON.stringify(info)}`);
          expect(info.style === "pixel" && info.canvasStyle === "pixel", `expected the pixel style, got ${info.style}/${info.canvasStyle}`);
          const buf = await page.evaluate(() => [__sauria.renderer.domElement.width, __sauria.renderer.domElement.height, innerHeight]);
          expect(buf[1] < buf[2], `pixel style should draw fewer rows than the window (${buf[1]} vs ${buf[2]})`);
          // The camera swoops down from the title flight (≤ 3.2 s); let it land behind the player.
          await page.evaluate(() => __sauria.advance(3.5));
          await frames(page, 2);
          await shot(page, "survival-pixel");
          await expectClean(page, errors);
          return `${buf[0]}×${buf[1]} game pixels in a ${await page.evaluate(() => innerWidth)}×${buf[2]} window`;
        },
      },
      {
        name: "survival (dryosaurus, pixel): W moves the player",
        async run({ page, errors }) {
          // Spawns are random: if a trunk or bank happens to block W, try turning away.
          let r = null;
          let used = "";
          for (const key of ["KeyW", "KeyD", "KeyS"]) {
            used = key;
            r = await driveWithKeys(page, [key], 2);
            if (r.dist > 1 || r.state !== "playing") break;
          }
          expect(r.state === "playing", `state ${r.state}`);
          expect(r.dist > 1, `player moved only ${r.dist.toFixed(2)} m in 2 s holding ${used}`);
          await expectClean(page, errors);
          return `${r.dist.toFixed(1)} m in 2 s holding ${used.slice(3)} (${r.gait})`;
        },
      },
      {
        name: "survival: death → death screen → hatch again",
        async run({ page, errors }) {
          await page.evaluate(() => __sauria.player.takeDamage(1e9, null, "fall"));
          await page.evaluate(() => __sauria.advance(0.2));
          expect((await page.evaluate(() => __sauria.state)) === "dead", "state should be 'dead' after a fatal fall");
          await page.evaluate(() => __sauria.advance(3.5));
          await page.waitForFunction(() => document.querySelector(".ovl--death")?.classList.contains("is-open"), null, { timeout: 30_000 });
          const cause = await page.locator(".ovl--death .death__cause").innerText();
          expect(/fall/i.test(cause), `death screen cause should mention the fall, got "${cause}"`);
          await frames(page, 2);
          await shot(page, "survival-death");
          await page.click(".ovl--death [data-act='respawn']");
          await waitState(page, "playing", 30_000);
          const p = await page.evaluate(() => ({ alive: __sauria.player?.alive, growth: __sauria.player?.growth, open: document.querySelector(".ovl--death").classList.contains("is-open") }));
          expect(p.alive && p.growth === 0 && !p.open, `respawn should hatch a fresh juvenile, got ${JSON.stringify(p)}`);
          await expectClean(page, errors);
        },
      },
    ],
  },
  {
    name: "survival · detailed",
    query: "?species=allosaurus&growth=0.6&t=0.6&style=detailed&quality=low&mute=1&debug=1",
    steps: [
      {
        name: "survival (allosaurus, detailed): autostarts, sprints with W+Shift",
        async run({ page, errors }) {
          await waitState(page, "playing");
          const style = await page.evaluate(() => [__sauria.style, document.getElementById("game").dataset.style]);
          expect(style[0] === "detailed" && style[1] === "detailed", `expected the detailed style, got ${style}`);
          const r = await driveWithKeys(page, ["ShiftLeft", "KeyW"], 2.5);
          expect(r.dist > 3, `allosaurus moved only ${r.dist.toFixed(2)} m sprinting for 2.5 s`);
          expect(r.gait === "sprint", `holding Shift+W should sprint, gait was "${r.gait}"`);
          await frames(page, 2);
          await shot(page, "survival-detailed");
          await expectClean(page, errors);
          return `${r.dist.toFixed(1)} m in 2.5 s (${r.gait})`;
        },
      },
      {
        name: "survival: pause and resume",
        async run({ page, errors }) {
          await page.keyboard.press("Escape");
          await page.evaluate(() => __sauria.advance(0.1));
          expect((await page.evaluate(() => __sauria.state)) === "paused", "Esc should pause");
          await page.evaluate(() => __sauria.resume());
          expect((await page.evaluate(() => __sauria.state)) === "playing", "resume should return to play");
          await expectClean(page, errors);
        },
      },
    ],
  },
  {
    name: "touch · phone",
    query: "?species=stegosaurus&growth=0.4&t=0.45&quality=low&mute=1",
    mobile: true,
    steps: [
      {
        name: "touch (iPhone-sized, pixel default): joystick moves the player",
        async run({ page, ctx, errors }) {
          await waitState(page, "playing");
          const setup = await page.evaluate(() => ({
            isTouch: __sauria.input.isTouch,
            style: __sauria.style,
            zone: (() => {
              const r = document.querySelector(".touch-zone--move")?.getBoundingClientRect();
              return r ? { x: r.x, y: r.y, w: r.width, h: r.height } : null;
            })(),
            buttons: document.querySelectorAll(".touch-btn").length,
          }));
          expect(setup.isTouch, "input should detect touch on a mobile context");
          expect(setup.style === "pixel", `the default style should be pixel, got ${setup.style}`);
          expect(setup.zone && setup.zone.w > 50, "no joystick zone (.touch-zone--move)");
          expect(setup.buttons >= 5, `expected touch buttons, found ${setup.buttons}`);
          const client = await ctx.newCDPSession(page);
          const touch = (type, pts) => client.send("Input.dispatchTouchEvent", { type, touchPoints: pts });
          const x = setup.zone.x + setup.zone.w * 0.45;
          const y = setup.zone.y + setup.zone.h * 0.65;
          const start = await page.evaluate(() => __sauria.player.position.toArray());
          await touch("touchStart", [{ x, y, id: 1 }]);
          for (let i = 1; i <= 6; i++) await touch("touchMove", [{ x, y: y - i * 14, id: 1 }]);
          const axis = await page.evaluate(() => __sauria.input.moveAxis());
          expect(Math.hypot(axis.x, axis.y) > 0.5 && axis.y > 0.4, `joystick axis should point forward, got ${JSON.stringify(axis)}`);
          await page.evaluate(() => __sauria.advance(2.5));
          await frames(page, 1);
          await shot(page, "touch-joystick");
          await touch("touchEnd", []);
          const after = await page.evaluate(() => ({ pos: __sauria.player.position.toArray(), axis: __sauria.input.moveAxis() }));
          const dist = Math.hypot(after.pos[0] - start[0], after.pos[2] - start[2]);
          expect(dist > 1, `stegosaurus moved only ${dist.toFixed(2)} m with the stick held for 2.5 s`);
          expect(Math.hypot(after.axis.x, after.axis.y) === 0, `releasing the stick should zero the axis, got ${JSON.stringify(after.axis)}`);
          await expectClean(page, errors);
          return `${dist.toFixed(1)} m in 2.5 s; stick axis ${axis.x.toFixed(2)}, ${axis.y.toFixed(2)}`;
        },
      },
      {
        name: "touch: pause button pauses",
        async run({ page, ctx, errors }) {
          const c = await page.evaluate(() => {
            const r = document.querySelector('.touch-btn[data-action="pause"]')?.getBoundingClientRect();
            return r ? [r.x + r.width / 2, r.y + r.height / 2] : null;
          });
          expect(c, "no pause touch button");
          const client = await ctx.newCDPSession(page);
          await client.send("Input.dispatchTouchEvent", { type: "touchStart", touchPoints: [{ x: c[0], y: c[1], id: 2 }] });
          await page.evaluate(() => __sauria.advance(0.1));
          await client.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });
          await page.evaluate(() => __sauria.advance(0.1));
          expect((await page.evaluate(() => __sauria.state)) === "paused", "the pause button should pause the game");
          await expectClean(page, errors);
        },
      },
      {
        name: "settings: Pixel size slider (pause → Settings) changes the render resolution",
        async run({ page, errors }) {
          await page.locator(".pause__item[data-act='settings']").click({ timeout: 60_000 });
          const slider = page.locator("input[type=range][id$='-pix']").first();
          await slider.waitFor({ state: "visible", timeout: 60_000 });
          const rowsAt = (v) =>
            slider.evaluate((el, v) => {
              el.value = String(v);
              el.dispatchEvent(new Event("input", { bubbles: true }));
              el.dispatchEvent(new Event("change", { bubbles: true }));
              return window.__sauria.renderer.domElement.height;
            }, v);
          const mid = await rowsAt(0.5);
          const chunky = await rowsAt(1);
          const fine = await rowsAt(0);
          expect(chunky < mid && mid < fine, `rows should shrink as pixels grow: fine ${fine}, in between ${mid}, chunky ${chunky}`);
          await rowsAt(0.75);
          const saved = await page.evaluate(() => JSON.parse(localStorage.getItem("sauria.settings.v1") || "{}").pixelSize);
          expect(saved === 0.75, `the pixel size should persist (saved ${saved})`);
          await frames(page, 1);
          await shot(page, "touch-settings");
          await expectClean(page, errors);
          return `rows: fine ${fine} · in between ${mid} · chunky ${chunky}`;
        },
      },
    ],
  },
  {
    name: "touch · upright phone",
    query: "?species=stegosaurus&growth=0.4&t=0.45&quality=low&mute=1",
    upright: true,
    steps: [
      {
        name: "upright phone: the game turns sideways, drawing buffer stays landscape",
        async run({ page, errors }) {
          await waitState(page, "playing");
          const f = await page.evaluate(() => {
            const app = document.getElementById("app");
            const r = app.getBoundingClientRect();
            const c = __sauria.renderer.domElement;
            const cs = getComputedStyle(app);
            return {
              rotated: document.documentElement.classList.contains("is-rotated"),
              app: [app.clientWidth, app.clientHeight],
              rect: [Math.round(r.width), Math.round(r.height)],
              buf: [c.width, c.height],
              aspect: __sauria.camera.aspect,
              view: [innerWidth, innerHeight],
              insets: ["--sa-t", "--sa-r", "--sa-b", "--sa-l"].map((k) => cs.getPropertyValue(k).trim()),
            };
          });
          expect(f.rotated, "html.is-rotated should be set on a phone held upright");
          expect(f.app[0] === f.view[1] && f.app[1] === f.view[0], `the app should be laid out landscape (${f.app} in a ${f.view} viewport)`);
          expect(f.rect[0] === f.view[0] && f.rect[1] === f.view[1], `the turned app should cover the viewport exactly (${f.rect})`);
          expect(f.buf[0] > f.buf[1] && f.aspect > 1.5, `the drawing buffer should be landscape-shaped (${f.buf}, aspect ${f.aspect.toFixed(2)})`);
          await page.evaluate(() => __sauria.advance(3.5));
          await frames(page, 2);
          await shot(page, "upright-hud");
          await expectClean(page, errors);
          return `app ${f.app.join("×")} turned into ${f.view.join("×")}; buffer ${f.buf.join("×")}; insets t/r/b/l ${f.insets.join(" ")}`;
        },
      },
      {
        name: "upright phone: stick pushed toward the phone's right edge walks forward",
        async run({ page, ctx, errors }) {
          // App-frame point → client point: the inverse of #app's rotate(90deg).
          const toClient = (x, y) =>
            page.evaluate(([x, y]) => {
              const r = document.getElementById("app").getBoundingClientRect();
              return [r.right - y, r.top + x];
            }, [x, y]);
          const zone = await page.evaluate(() => {
            const t = document.querySelector(".touch");
            return { w: t.clientWidth, h: t.clientHeight };
          });
          const client = await ctx.newCDPSession(page);
          const touch = (type, pts) => client.send("Input.dispatchTouchEvent", { type, touchPoints: pts });
          const ax = zone.w * 0.22;
          const ay = zone.h * 0.65;
          const start = await page.evaluate(() => ({ pos: __sauria.player.position.toArray(), yaw: __sauria.controller.camera.yaw }));
          const [x0, y0] = await toClient(ax, ay);
          await touch("touchStart", [{ x: x0, y: y0, id: 1 }]);
          let last = [x0, y0];
          for (let i = 1; i <= 6; i++) {
            last = await toClient(ax, ay - i * 14); // toward the app's top
            await touch("touchMove", [{ x: last[0], y: last[1], id: 1 }]);
          }
          expect(last[0] > x0 + 60 && Math.abs(last[1] - y0) < 1, `the thumb should travel toward the phone's right edge (${x0},${y0} → ${last})`);
          const axis = await page.evaluate(() => ({ ...__sauria.input.moveAxis() }));
          expect(axis.y > 0.6 && Math.abs(axis.x) < 0.25, `the stick should read forward, got ${JSON.stringify(axis)}`);
          await page.evaluate(() => __sauria.advance(2.5));
          await touch("touchEnd", []);
          const end = await page.evaluate(() => __sauria.player.position.toArray());
          const dx = end[0] - start.pos[0];
          const dz = end[2] - start.pos[2];
          const dist = Math.hypot(dx, dz);
          // Camera forward on the ground is (sin yaw, cos yaw).
          const along = (dx * Math.sin(start.yaw) + dz * Math.cos(start.yaw)) / (dist || 1);
          expect(dist > 1, `stegosaurus moved only ${dist.toFixed(2)} m with the stick held forward`);
          expect(along > 0.5, `the player should walk away from the camera (alignment ${along.toFixed(2)})`);
          await expectClean(page, errors);
          return `${dist.toFixed(1)} m, alignment with the camera ${along.toFixed(2)}; axis ${axis.x.toFixed(2)}, ${axis.y.toFixed(2)}`;
        },
      },
      {
        name: "upright phone: the pause button hits through the rotation",
        async run({ page, ctx, errors }) {
          const c = await page.evaluate(() => {
            const r = document.querySelector('.touch-btn[data-action="pause"]')?.getBoundingClientRect();
            return r ? [r.x + r.width / 2, r.y + r.height / 2] : null;
          });
          expect(c, "no pause touch button");
          // Turned sideways, the top-right utility row sits along the phone's right edge, near its top.
          expect(c[0] > 300 && c[1] > 600, `the pause button should be near the phone's bottom-right corner (app top-right), at ${c.map(Math.round)}`);
          const client = await ctx.newCDPSession(page);
          await client.send("Input.dispatchTouchEvent", { type: "touchStart", touchPoints: [{ x: c[0], y: c[1], id: 2 }] });
          await page.evaluate(() => __sauria.advance(0.1));
          await client.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });
          await page.evaluate(() => __sauria.advance(0.1));
          expect((await page.evaluate(() => __sauria.state)) === "paused", "the pause button should pause the game");
          await expectClean(page, errors);
        },
      },
    ],
  },
  {
    name: "hunter",
    query: "?hunter=1&quality=low&mute=1&debug=1",
    steps: [
      {
        name: "hunter: ?hunter=1 opens the expedition planner",
        async run({ page, errors }) {
          await waitState(page, "hunter-menu");
          await page.waitForFunction(() => !!window.__sauria.hunterMode, null, { timeout: 60_000 });
          await frames(page, 2);
          await shot(page, "hunter-planner");
          await expectClean(page, errors);
        },
      },
      {
        name: "hunter: begin → drop-off flight (fast-forwarded) → hunting",
        async run({ page, errors }) {
          await page.evaluate(() =>
            __sauria.hunterMode.begin({ weapons: ["rifle", "revolver"], equipment: { radar: true, lure: true }, targets: ["camptosaurus"], phase: 0.45 }),
          );
          await waitState(page, "hunter", 60_000);
          const ff = await page.evaluate(() => {
            const hm = __sauria.hunterMode;
            const first = hm.session.state;
            let i = 0;
            while (hm.session.state !== "hunting" && i < 2400) {
              hm.update(0.05);
              __sauria.input.endFrame();
              i++;
            }
            const h = hm.hunter;
            return { first, steps: i, state: hm.session.state, alive: h.alive, onGround: h.position.y - __sauria.world.terrain.heightAt(h.position.x, h.position.z), player: __sauria.world.player === h };
          });
          expect(ff.first === "dropoff", `a hunt should open with the drop-off flight, got "${ff.first}"`);
          expect(ff.state === "hunting", `drop-off didn't finish within 120 s of game time (state ${ff.state}, ${ff.steps} steps)`);
          expect(ff.alive && ff.player, `hunter should be alive and the ecosystem's player: ${JSON.stringify(ff)}`);
          expect(Math.abs(ff.onGround) < 2.5, `hunter should stand on the ground after the drop-off (Δy ${ff.onGround.toFixed(2)})`);
          await frames(page, 2);
          await shot(page, "hunter-ground");
          await expectClean(page, errors);
        },
      },
      {
        name: "hunter: fire → shot event, ammo spent",
        async run({ page, errors }) {
          // Let the weapon finish raising before pulling the trigger.
          await page.evaluate(() => {
            for (let i = 0; i < 30; i++) {
              __sauria.hunterMode.update(0.05);
              __sauria.input.endFrame();
            }
          });
          const before = await page.evaluate(() => {
            const w = __sauria.hunterMode.weapons;
            window.__shots = [];
            window.__offShot = __sauria.world.events.on("shot", (e) => window.__shots.push({ weapon: e.weapon, loudness: e.loudness }));
            return { weapon: w.current, mag: w.ammo[w.current].mag };
          });
          await page.keyboard.down("KeyF");
          await page.evaluate(() => {
            for (let i = 0; i < 6; i++) {
              __sauria.hunterMode.update(0.05);
              __sauria.input.endFrame();
            }
          });
          await page.keyboard.up("KeyF");
          const after = await page.evaluate(() => {
            for (let i = 0; i < 4; i++) {
              __sauria.hunterMode.update(0.05);
              __sauria.input.endFrame();
            }
            window.__offShot();
            const w = __sauria.hunterMode.weapons;
            return { shots: window.__shots, mag: w.ammo[w.current].mag };
          });
          expect(after.shots.length >= 1, `holding F should fire (${JSON.stringify(before)})`);
          expect(after.shots[0].weapon === before.weapon, `shot event names the weapon (${after.shots[0].weapon})`);
          expect(after.mag === before.mag - after.shots.length, `magazine ${before.mag} → ${after.mag} after ${after.shots.length} shot(s)`);
          await frames(page, 2);
          await shot(page, "hunter-shot");
          await expectClean(page, errors);
        },
      },
      {
        name: "hunter: quit returns to the title menu",
        async run({ page, errors }) {
          await page.evaluate(() => __sauria.hunterMode.quit());
          await waitState(page, "menu", 30_000);
          const p = await page.evaluate(() => ({ player: __sauria.world.player, mode: __sauria.world.mode }));
          expect(p.player === null && p.mode === "survival", `quitting should clear the hunter (${JSON.stringify(p)})`);
          await frames(page, 2);
          await shot(page, "menu-after-hunt");
          await expectClean(page, errors);
        },
      },
    ],
  },
];

/* --- Main ------------------------------------------------------------------ */

async function runUnit(browser, base) {
  console.log("\nUnit tests (tests/unit.html)");
  const { ctx, page, errors } = await openPage(browser, `${base}/tests/unit.html`);
  try {
    await page.waitForFunction(() => window.__unit && window.__unit.done, null, { timeout: 180_000, polling: 200 });
    const list = await page.evaluate(() => window.__unit.results);
    for (const r of list) {
      if (ONLY && !r.name.toLowerCase().includes(ONLY)) continue;
      report({ name: `unit · ${r.name}`, status: r.status, ms: r.ms, error: r.error, known: r.known });
    }
    if (errors.length) report({ name: "unit · no console errors", status: "fail", ms: 0, error: [...new Set(errors)].join("\n") });
    else report({ name: "unit · no console errors", status: "pass", ms: 0 });
  } catch (err) {
    report({ name: "unit · harness", status: "fail", ms: 0, error: err.message });
  } finally {
    await ctx.close();
  }
}

async function runSmoke(browser, base) {
  console.log("\nSmoke tests (index.html in headless Chromium — slow, software WebGL)");
  for (const suite of SUITES) {
    const steps = suite.steps.filter((s) => !ONLY || s.name.toLowerCase().includes(ONLY) || suite.name.toLowerCase().includes(ONLY));
    if (!steps.length) continue;
    let session = null;
    let broken = null;
    try {
      session = await openPage(browser, `${base}/index.html${suite.query}`, { mobile: !!suite.mobile, upright: !!suite.upright });
    } catch (err) {
      broken = `couldn't open the page: ${err.message}`;
    }
    for (const step of steps) {
      const start = Date.now();
      if (broken) {
        report({ name: step.name, status: step.known ? "known" : "fail", ms: 0, error: `skipped — ${broken}`, known: step.known });
        continue;
      }
      try {
        const info = await step.run(session);
        report({ name: step.name, status: step.known ? "unexpected-pass" : "pass", ms: Date.now() - start, known: step.known, info: info || "" });
      } catch (err) {
        report({ name: step.name, status: step.known ? "known" : "fail", ms: Date.now() - start, error: err.message.split("\n").slice(0, 10).join("\n"), known: step.known });
        // Later steps in a suite build on earlier ones; keep going but note it.
        if (/Timeout/i.test(err.message)) broken = `an earlier step timed out (${step.name})`;
        await shot(session.page, `FAIL-${step.name.replace(/[^a-z0-9]+/gi, "-").toLowerCase()}`).catch(() => {});
      }
    }
    await session?.ctx.close().catch(() => {});
  }
}

const server = await startServer();
const base = `http://127.0.0.1:${server.address().port}`;
const { chromium } = await loadPlaywright();
const browser = await chromium.launch({
  headless: !flag("--headed"),
  args: ["--use-angle=swiftshader", "--enable-unsafe-swiftshader", "--ignore-gpu-blocklist"],
});

console.log(`Sauria tests · serving ${ROOT} at ${base}`);
try {
  if (RUN_UNIT) await runUnit(browser, base);
  if (RUN_SMOKE) await runSmoke(browser, base);
} finally {
  await browser.close().catch(() => {});
  server.close();
}

const count = (s) => results.filter((r) => r.status === s).length;
const failed = count("fail");
const summary = `${count("pass")} passed · ${failed} failed · ${count("known")} known · ${count("unexpected-pass")} unexpectedly passed`;
console.log(`\n${failed ? `${C.r}FAIL${C.x}` : `${C.g}PASS${C.x}`}  ${summary}  ${C.d}(${secs(Date.now() - t0)}; screenshots in tests/out/)${C.x}`);
if (failed) {
  console.log("\nFailures:");
  for (const r of results.filter((x) => x.status === "fail")) console.log(`  - ${r.name}: ${String(r.error).split("\n")[0]}`);
}
process.exit(failed ? 1 : 0);
