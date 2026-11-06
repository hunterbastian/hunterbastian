// Headless smoke test: serve the folder, load Kohan, step through every preset,
// screenshot each, and fail on any console error or page exception.
// Run from this folder: node smoke-test.mjs  (needs Playwright with Chromium)
import { spawn } from "node:child_process";
import { createRequire } from "node:module";

const { chromium } = createRequire(import.meta.url)("playwright");
const port = 8124;
const server = spawn("python3", ["-m", "http.server", String(port)], {
  cwd: new URL(".", import.meta.url).pathname,
  stdio: "ignore",
});
await new Promise((r) => setTimeout(r, 800));

const browser = await chromium.launch({
  args: ["--use-gl=angle", "--use-angle=swiftshader", "--enable-unsafe-swiftshader", "--ignore-gpu-blocklist"],
});
const page = await browser.newPage({ viewport: { width: 960, height: 540 } });
const errors = [];
page.on("console", (m) => m.type() === "error" && errors.push(m.text()));
page.on("pageerror", (e) => errors.push(e.message));

try {
  await page.goto(`http://localhost:${port}/index.html`, { waitUntil: "load" });
  await page.waitForFunction(() => window.kohan, null, { timeout: 20000 });
  for (const preset of ["painting", "ps2", "gamecube", "raw"]) {
    await page.evaluate((p) => window.kohan.preset(p), preset);
    await page.waitForTimeout(1500);
    await page.screenshot({ path: `smoke-${preset}.png`, timeout: 90000 });
  }
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
console.log("No page errors. Screenshots: smoke-painting.png, smoke-ps2.png, smoke-gamecube.png, smoke-raw.png");
