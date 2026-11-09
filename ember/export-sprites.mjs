// Exports ember's complete sprite sheet into sprites/:
//
//   ember-sprites.png          every sprite and frame, 1 px = 1 game pixel, transparent
//   ember-sprites.json         frame names, positions and pivots (TexturePacker JSON hash)
//   ember-sprites-preview.png  the same sprites labeled, with the palette, at 4x
//   ember-palette.gpl          the 11 colors, for Aseprite or GIMP
//
//   node export-sprites.mjs
//
// The sprites come from the game's own drawing code, so re-run this after
// changing any of them. Needs Playwright with Chromium, like the smoke test.
import { spawn } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { join } from "node:path";

const require = createRequire(import.meta.url);
const { chromium } = require("playwright");

const PORT = 8125;
const here = new URL(".", import.meta.url).pathname;
const out = join(here, "sprites");
const server = spawn("python3", ["-m", "http.server", String(PORT)], { cwd: here, stdio: "ignore" });
await new Promise((r) => setTimeout(r, 800));

const browser = await chromium.launch();
try {
  const page = await browser.newPage();
  const errors = [];
  page.on("pageerror", (e) => errors.push(e.message));
  await page.goto(`http://localhost:${PORT}/index.html`);
  await page.waitForFunction(() => window.ember?.debug?.spriteSheet);
  const data = await page.evaluate(() => {
    const s = window.ember.debug.spriteSheet();
    const upscale = (c, k) => {
      const o = document.createElement("canvas");
      o.width = c.width * k;
      o.height = c.height * k;
      const g = o.getContext("2d");
      g.imageSmoothingEnabled = false;
      g.drawImage(c, 0, 0, o.width, o.height);
      return o.toDataURL("image/png");
    };
    return { atlas: s.atlas.toDataURL("image/png"), preview: upscale(s.preview, 4), json: s.json, palette: s.palette, count: s.count };
  });
  if (errors.length) throw new Error(errors.join("\n"));

  mkdirSync(out, { recursive: true });
  const png = (url) => Buffer.from(url.split(",")[1], "base64");
  writeFileSync(join(out, "ember-sprites.png"), png(data.atlas));
  writeFileSync(join(out, "ember-sprites-preview.png"), png(data.preview));
  writeFileSync(join(out, "ember-sprites.json"), `${JSON.stringify(data.json, null, 2)}\n`);
  const rows = Object.entries(data.palette).map(([name, hex]) => {
    const [r, g, b] = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16));
    return `${String(r).padStart(3)} ${String(g).padStart(3)} ${String(b).padStart(3)}\t${name}`;
  });
  writeFileSync(join(out, "ember-palette.gpl"), `GIMP Palette\nName: ember\nColumns: ${rows.length}\n#\n${rows.join("\n")}\n`);
  const { w, h } = data.json.meta.size;
  console.log(`Exported ${data.count} sprites to ${out} (atlas ${w} × ${h})`);
} finally {
  await browser.close();
  server.kill();
}
