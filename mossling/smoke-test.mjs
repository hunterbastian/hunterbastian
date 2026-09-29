// Headless smoke test: serve the build, walk the creature around, capture
// screenshots, and fail on any console error or page exception.
//   npm run build && node smoke-test.mjs
import { createRequire } from "node:module";
import { spawn } from "node:child_process";

const require = createRequire(import.meta.url);
let chromium;
try {
  ({ chromium } = require("playwright"));
} catch {
  ({ chromium } = require(`${process.env.NODE_GLOBAL ?? "/opt/node22/lib/node_modules"}/playwright`));
}

const port = 4173 + Math.floor(Math.random() * 500);
const server = spawn("npx", ["vite", "preview", "--port", String(port), "--strictPort"], { stdio: "ignore" });
await new Promise((r) => setTimeout(r, 1500));

const errors = [];
const browser = await chromium.launch({ args: ["--use-angle=swiftshader", "--enable-unsafe-swiftshader", "--ignore-gpu-blocklist"] });
try {
  const page = await browser.newPage({ viewport: { width: 1280, height: 720 } });
  // External font loads may fail offline/in CI; only care about our own code.
  page.on("console", (m) => m.type() === "error" && !m.text().startsWith("Failed to load resource") && errors.push(m.text()));
  page.on("pageerror", (e) => errors.push(String(e)));
  await page.goto(`http://localhost:${port}/${process.argv[2] ?? "?debug"}`);
  await page.waitForTimeout(2500);
  await page.screenshot({ path: "smoke-start.png" });

  await page.keyboard.down("KeyW");
  await page.waitForTimeout(1600);
  await page.screenshot({ path: "smoke-walk.png" });
  await page.keyboard.down("ShiftLeft");
  await page.keyboard.down("KeyA");
  await page.waitForTimeout(1400);
  await page.keyboard.up("KeyA");
  await page.waitForTimeout(800);
  await page.screenshot({ path: "smoke-trot.png" });
  await page.keyboard.up("ShiftLeft");
  await page.keyboard.up("KeyW");
  await page.waitForTimeout(1500);
  await page.screenshot({ path: "smoke-idle.png" });

  // Swing the camera round for a side view, then walk past it.
  await page.mouse.move(900, 300);
  await page.mouse.down();
  await page.mouse.move(1150, 330, { steps: 10 });
  await page.mouse.up();
  await page.waitForTimeout(600);
  await page.screenshot({ path: "smoke-side.png" });
  await page.keyboard.down("KeyD");
  await page.waitForTimeout(500);
  await page.screenshot({ path: "smoke-side-walk.png" });
  await page.keyboard.up("KeyD");
  await page.waitForTimeout(7500);
  await page.screenshot({ path: "smoke-sit.png" });

  // Control feel: holding a sideways key should walk a straight line (the
  // camera drifting behind must not bend the path into a spiral), and walking
  // toward the camera must not spin it around.
  const probe = () => page.evaluate(() => {
    const m = window.__mossling;
    if (!m) return null;
    const cam = m.follow.camera.position;
    return { x: m.creature.position.x, z: m.creature.position.z, yaw: m.follow.yaw, camX: cam.x, camY: cam.y, camZ: cam.z };
  });
  if (await probe()) {
    await page.keyboard.down("KeyD");
    await page.waitForTimeout(700);
    const a = await probe();
    await page.waitForTimeout(1200);
    const b = await probe();
    await page.waitForTimeout(1200);
    const c = await probe();
    await page.keyboard.up("KeyD");
    for (const p of [a, b, c]) if (!Number.isFinite(p.camX + p.camY + p.camZ)) errors.push("camera position is not finite");
    const bend = Math.abs(Math.atan2(Math.sin(Math.atan2(c.x - b.x, c.z - b.z) - Math.atan2(b.x - a.x, b.z - a.z)), Math.cos(Math.atan2(c.x - b.x, c.z - b.z) - Math.atan2(b.x - a.x, b.z - a.z))));
    const travelled = Math.hypot(c.x - a.x, c.z - a.z);
    if (travelled < 2) errors.push(`holding D only moved the creature ${travelled.toFixed(2)} units`);
    if (bend > 0.35) errors.push(`holding D curved the path by ${bend.toFixed(2)} rad`);
    await page.waitForTimeout(800);
    const s0 = await probe();
    await page.keyboard.down("KeyS");
    await page.waitForTimeout(2500);
    const s1 = await probe();
    await page.keyboard.up("KeyS");
    const spin = Math.abs(Math.atan2(Math.sin(s1.yaw - s0.yaw), Math.cos(s1.yaw - s0.yaw)));
    if (spin > 0.4) errors.push(`walking toward the camera spun it by ${spin.toFixed(2)} rad`);
    console.log(`control checks: moved ${travelled.toFixed(1)}u, path bend ${bend.toFixed(3)} rad, camera spin ${spin.toFixed(3)} rad`);
  }

  // Phone passes. Upright, the stage is rotated 90° so the game plays in
  // landscape; a stage point (sx, sy) sits at viewport (390 - sy, sx).
  const phonePass = async (name, viewport, toScreen) => {
    const phone = await browser.newContext({ viewport, deviceScaleFactor: 3, isMobile: true, hasTouch: true });
    const mobile = await phone.newPage();
    mobile.on("console", (m) => m.type() === "error" && !m.text().startsWith("Failed to load resource") && errors.push(m.text()));
    mobile.on("pageerror", (e) => errors.push(String(e)));
    await mobile.goto(`http://localhost:${port}/`);
    await mobile.waitForTimeout(2500);
    await mobile.screenshot({ path: `smoke-${name}-start.png` });
    const cdp = await phone.newCDPSession(mobile);
    const touch = (type, points) =>
      cdp.send("Input.dispatchTouchEvent", { type, touchPoints: points.map(([x, y, id]) => ({ ...toScreen(x, y), id })) });
    // Left thumb pushes the stick forward-right (trot); right thumb swings the camera.
    await touch("touchStart", [[90, 300, 1]]);
    for (let i = 1; i <= 8; i++) await touch("touchMove", [[90 + i * 4, 300 - i * 9, 1]]);
    await mobile.waitForTimeout(1500);
    const stick = [122, 228, 1];
    await touch("touchStart", [stick, [600, 200, 2]]);
    for (let i = 1; i <= 6; i++) await touch("touchMove", [stick, [600 - i * 12, 200, 2]]);
    await mobile.waitForTimeout(1200);
    const state = await mobile.evaluate(() => ({
      rotated: document.querySelector("#stage")?.classList.contains("rotated"),
      stickActive: document.querySelector("#stick")?.classList.contains("active"),
      trot: document.querySelector("#stick")?.classList.contains("trot"),
    }));
    await mobile.screenshot({ path: `smoke-${name}-walk.png` });
    await touch("touchEnd", []);
    await mobile.waitForTimeout(300);
    if (!(await mobile.evaluate(() => document.querySelector("#stick")?.classList.contains("active")) === false))
      errors.push(`${name}: joystick stayed active after release`);
    if (!state.stickActive) errors.push(`${name}: joystick never activated`);
    if (!state.trot) errors.push(`${name}: full push did not show trot on the stick`);
    await phone.close();
    return state;
  };
  const upright = await phonePass("phone-upright", { width: 390, height: 844 }, (x, y) => ({ x: 390 - y, y: x }));
  if (!upright.rotated) errors.push("upright phone: stage was not rotated to landscape");
  const sideways = await phonePass("phone-landscape", { width: 844, height: 390 }, (x, y) => ({ x, y }));
  if (sideways.rotated) errors.push("landscape phone: stage should not be rotated");
} finally {
  await browser.close();
  server.kill();
}

if (errors.length) {
  console.error("Errors:\n" + errors.join("\n"));
  process.exit(1);
}
console.log("ok — screenshots written to smoke-*.png");
