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
  await page.goto(`http://localhost:${port}/${process.argv[2] ?? ""}`);
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

  // Phone pass: emulate an iPhone and drive the touch joystick + look drag.
  const phone = await browser.newContext({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 3, isMobile: true, hasTouch: true });
  const mobile = await phone.newPage();
  mobile.on("console", (m) => m.type() === "error" && !m.text().startsWith("Failed to load resource") && errors.push(m.text()));
  mobile.on("pageerror", (e) => errors.push(String(e)));
  await mobile.goto(`http://localhost:${port}/`);
  await mobile.waitForTimeout(2500);
  await mobile.screenshot({ path: "smoke-phone-start.png" });
  const cdp = await phone.newCDPSession(mobile);
  const touch = (type, points) => cdp.send("Input.dispatchTouchEvent", { type, touchPoints: points });
  // Left thumb pushes the stick up-right (trot); right thumb swings the camera.
  await touch("touchStart", [{ x: 90, y: 740, id: 1 }]);
  for (let i = 1; i <= 8; i++) await touch("touchMove", [{ x: 90 + i * 4, y: 740 - i * 9, id: 1 }]);
  await mobile.waitForTimeout(1500);
  await touch("touchStart", [{ x: 90 + 32, y: 740 - 72, id: 1 }, { x: 300, y: 400, id: 2 }]);
  for (let i = 1; i <= 6; i++) await touch("touchMove", [{ x: 90 + 32, y: 740 - 72, id: 1 }, { x: 300 - i * 12, y: 400, id: 2 }]);
  await touch("touchEnd", [{ x: 90 + 32, y: 740 - 72, id: 1 }]);
  await mobile.waitForTimeout(1200);
  await mobile.screenshot({ path: "smoke-phone-walk.png" });
  await touch("touchEnd", []);
  await mobile.waitForTimeout(300);
  const moved = await mobile.evaluate(() => document.querySelector("#stick")?.classList.contains("active"));
  if (moved) errors.push("joystick stayed active after release");
} finally {
  await browser.close();
  server.kill();
}

if (errors.length) {
  console.error("Errors:\n" + errors.join("\n"));
  process.exit(1);
}
console.log("ok — screenshots written to smoke-*.png");
