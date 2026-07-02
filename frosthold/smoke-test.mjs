// Headless smoke test: load Frosthold, auto-start the game, run several
// seconds of simulated frames, capture a screenshot, and fail on any
// console error or page exception.
import { spawn } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const url = "http://localhost:8124/index.html?autoplay=1";

const server = spawn("python3", ["-m", "http.server", "8124"], {
  cwd: new URL(".", import.meta.url).pathname,
  stdio: "ignore",
});

await new Promise((r) => setTimeout(r, 800));

const userDir = mkdtempSync(join(tmpdir(), "chrome-"));
const out = join(process.cwd(), "smoke-shot.png");

const args = [
  "--headless=new",
  "--no-sandbox",
  "--hide-scrollbars",
  "--enable-unsafe-swiftshader",
  "--use-gl=angle",
  "--use-angle=swiftshader",
  `--user-data-dir=${userDir}`,
  "--window-size=1280,720",
  "--virtual-time-budget=8000",
  "--enable-logging=stderr",
  "--v=0",
  `--screenshot=${out}`,
  url,
];

const chrome = spawn("google-chrome", args);
let stderr = "";
chrome.stderr.on("data", (d) => (stderr += d.toString()));

const timeout = setTimeout(() => chrome.kill("SIGKILL"), 25000);
const code = await new Promise((res) => chrome.on("exit", res));
clearTimeout(timeout);
server.kill();

const errors = stderr
  .split("\n")
  .filter((l) => /ERROR|Uncaught|Unhandled|SEVERE/i.test(l))
  .filter((l) => !/GPU|gpu|font|dbus|GL |egl|Vulkan|sandbox|DevTools|bind\(\)|socket_posix|gcm\/engine|registration_request/i.test(l));

console.log("chrome exit:", code);
if (errors.length) {
  console.log("CONSOLE ERRORS:\n" + errors.join("\n"));
  process.exit(1);
}
console.log("No page errors detected. Screenshot at", out);
