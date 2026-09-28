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
} finally {
  await browser.close();
  server.kill();
}

if (errors.length) {
  console.error("Errors:\n" + errors.join("\n"));
  process.exit(1);
}
console.log("ok — screenshots written to smoke-*.png");
