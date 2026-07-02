// Headless smoke test: load the game in demo/autostart mode, let a few
// frames run, capture a screenshot, and fail on any console error or page
// exception. Chrome's headless screenshot mode doesn't always exit on its
// own once --virtual-time-budget is combined with a custom window size, so
// this force-kills the browser after a short grace period rather than
// waiting on its own exit.
import { spawn } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const PORT = 8124;
const url = `http://localhost:${PORT}/index.html?seed=1&autostart=1&demo=1`;

const server = spawn("python3", ["-m", "http.server", String(PORT)], {
  cwd: new URL(".", import.meta.url).pathname,
  stdio: "ignore",
});

await new Promise((r) => setTimeout(r, 800));

const userDir = mkdtempSync(join(tmpdir(), "chrome-"));
const out = join(process.cwd(), "smoke-shot.png");

const args = [
  "--headless=new",
  "--no-sandbox",
  "--disable-gpu",
  `--user-data-dir=${userDir}`,
  "--virtual-time-budget=4000",
  "--enable-logging=stderr",
  "--v=0",
  `--screenshot=${out}`,
  url,
];

const chrome = spawn("google-chrome", args);
let stderr = "";
chrome.stderr.on("data", (d) => (stderr += d.toString()));

const exitCode = await Promise.race([
  new Promise((res) => chrome.on("exit", (code) => res(code))),
  new Promise((res) =>
    setTimeout(() => {
      chrome.kill("SIGKILL");
      res("timeout");
    }, 10000)
  ),
]);

server.kill();

const errors = stderr
  .split("\n")
  .filter((l) => /ERROR|Uncaught|Unhandled|SEVERE/i.test(l))
  // ignore benign GPU/font/dbus/audio noise common in headless containers
  .filter((l) => !/GPU|gpu|font|dbus|GL |egl|Vulkan|sandbox|DevTools|pulse|singleton/i.test(l));

console.log("chrome exit:", exitCode);
if (errors.length) {
  console.log("CONSOLE ERRORS:\n" + errors.join("\n"));
  process.exit(1);
}
console.log("No page errors detected. Screenshot at", out);
