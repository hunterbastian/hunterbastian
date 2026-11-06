// ember — a very small game about a small light on a dark path.
//
// No build step and no dependencies. The game is laid out in 480 × 420
// logical units and drawn straight onto a 240 × 210 pixel grid: creatures are
// rasterized without anti-aliasing and baked into sprites, light falls off in
// stepped bands, and anything left over is snapped to an 11-color palette.
//
// The loop: your ember walks on its own and gathers warmth, even while the
// page is closed. Every so often something is waiting on the path. Strike it
// down for a burst of warmth, or calm it until you can part ways, and it
// follows you and keeps you warm from then on. Spend warmth at the campfire.

/* ----------------------------------------------------------------------- */
/* Constants & helpers                                                     */
/* ----------------------------------------------------------------------- */
const W = 480;
const H = 420;
const PX = 2; // logical units per buffer pixel
const BW = W / PX;
const BH = H / PX;
const TAU = Math.PI * 2;
const STEP = 1000 / 60;
const MAX_AWAY = 8 * 3600; // offline warmth is capped at 8 hours

// The whole game uses these fifteen colors and nothing else: a cold blue night,
// carved runestone greys, glowing teal runes, your warm ember, and a firefly green.
const C = {
  bg: "#0b1018",
  night: "#18212d",
  faint: "#2a333d",
  dim: "#8e9aab",
  ink: "#e6edf4",
  stone: "#3b4352",
  stoneL: "#5c6677",
  stoneD: "#232832",
  rune: "#6fd3c4",
  deep: "#2e1a12",
  warm: "#6b3a1c",
  ember: "#ffae57",
  core: "#fff0d6",
  moss: "#34431f",
  glim: "#dbe89a",
};
const REDUCED = window.matchMedia?.("(prefers-reduced-motion: reduce)").matches ?? false;

const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));
const lerp = (a, b, t) => a + (b - a) * t;
const rand = (lo, hi) => lo + Math.random() * (hi - lo);
const snap = (v) => Math.round(v / PX) * PX;
const hash = (n) => {
  const x = Math.sin(n * 127.1 + 311.7) * 43758.5453;
  return x - Math.floor(x);
};
const fmt = (n) => Math.floor(n).toLocaleString("en-US");
const fmtRate = (r) => {
  const v = Math.round(r * 10) / 10;
  return Number.isInteger(v) ? String(v) : v.toFixed(1);
};

const storage = {
  get(key) {
    try { return localStorage.getItem(key); } catch { return null; }
  },
  set(key, value) {
    try { localStorage.setItem(key, value); } catch { /* private mode etc. */ }
  },
};

/* ----------------------------------------------------------------------- */
/* Canvas: draw small, snap to the palette, scale up sharp                 */
/* ----------------------------------------------------------------------- */
const canvas = document.getElementById("game");
const screen = canvas.getContext("2d");
const stage = document.getElementById("stage");
const live = document.getElementById("live");

// The world is drawn into two layers (background and actors), the interface
// into a third, so the ASCII view can treat each one differently.
function makeLayer() {
  const c = document.createElement("canvas");
  c.width = BW;
  c.height = BH;
  return c.getContext("2d", { willReadFrequently: true });
}
const LAYERS = { bg: makeLayer(), act: makeLayer(), ui: makeLayer() };
const comp = makeLayer(); // the pixel view flattens all three here
let ctx = LAYERS.ui;
function layer(name) {
  ctx = LAYERS[name];
}

function resize() {
  const dpr = Math.min(window.devicePixelRatio || 1, 3);
  const aw = (stage?.clientWidth || window.innerWidth) - 8;
  const ah = (stage?.clientHeight || window.innerHeight) - 8;
  let s = Math.min(aw / BW, ah / BH);
  if (s >= 2) s = Math.floor(s); // whole-number scaling keeps every pixel the same size
  s = Math.max(s, 0.75);
  const cw = Math.round(BW * s);
  const ch = Math.round(BH * s);
  canvas.style.width = `${cw}px`;
  canvas.style.height = `${ch}px`;
  canvas.width = Math.round(cw * dpr);
  canvas.height = Math.round(ch * dpr);
}
window.addEventListener("resize", resize);
resize();

function toLogical(e) {
  const r = canvas.getBoundingClientRect();
  return { x: ((e.clientX - r.left) / r.width) * W, y: ((e.clientY - r.top) / r.height) * H };
}

// Snap every pixel that isn't already a palette color to the nearest one,
// nudged by a 4×4 Bayer matrix so glows and fades turn into dither patterns.
const PAL = Object.values(C).map((h) => [1, 3, 5].map((i) => parseInt(h.slice(i, i + 2), 16)));
const PAL_KEYS = new Set(PAL.map(([r, g, b]) => (r << 16) | (g << 8) | b));
const BAYER = [0, 8, 2, 10, 12, 4, 14, 6, 3, 11, 1, 9, 15, 7, 13, 5].map((v) => (v + 0.5) / 16 - 0.5);
const SPREAD = 36;

function present() {
  screen.setTransform(1, 0, 0, 1, 0, 0);
  screen.imageSmoothingEnabled = false;
  if (G.view === "ascii") {
    drawAscii();
  } else {
    comp.setTransform(1, 0, 0, 1, 0, 0);
    for (const g of [LAYERS.bg, LAYERS.act, LAYERS.ui]) comp.drawImage(g.canvas, 0, 0);
    snapToPalette(comp);
    screen.drawImage(comp.canvas, 0, 0, canvas.width, canvas.height);
  }
  if (G.fade > 0) {
    screen.globalAlpha = G.fade;
    screen.fillStyle = C.bg;
    screen.fillRect(0, 0, canvas.width, canvas.height);
    screen.globalAlpha = 1;
  }
}

// Mirror on-screen text into a live region so screen readers can follow along.
let lastSaid = "";
function say(msg) {
  if (!msg || msg === lastSaid) return;
  lastSaid = msg;
  live.textContent = msg;
}

/* ----------------------------------------------------------------------- */
/* Pixel font & sprites                                                    */
/* ----------------------------------------------------------------------- */
// 5 × 7 lowercase glyphs; g, j, p, q, y and , drop two rows below the line.
const FONT = {
  a: [".....", ".....", ".###.", "....#", ".####", "#...#", ".####"],
  b: ["#....", "#....", "####.", "#...#", "#...#", "#...#", "####."],
  c: [".....", ".....", ".###.", "#....", "#....", "#....", ".###."],
  d: ["....#", "....#", ".####", "#...#", "#...#", "#...#", ".####"],
  e: [".....", ".....", ".###.", "#...#", "#####", "#....", ".###."],
  f: ["..##.", ".#...", "####.", ".#...", ".#...", ".#...", ".#..."],
  g: [".....", ".....", ".####", "#...#", "#...#", "#...#", ".####", "....#", ".###."],
  h: ["#....", "#....", "####.", "#...#", "#...#", "#...#", "#...#"],
  i: ["..#..", ".....", ".##..", "..#..", "..#..", "..#..", ".###."],
  j: ["...#.", ".....", "..##.", "...#.", "...#.", "...#.", "...#.", "#..#.", ".##.."],
  k: ["#....", "#....", "#..#.", "#.#..", "##...", "#.#..", "#..#."],
  l: [".##..", "..#..", "..#..", "..#..", "..#..", "..#..", ".###."],
  m: [".....", ".....", "##.#.", "#.#.#", "#.#.#", "#.#.#", "#.#.#"],
  n: [".....", ".....", "####.", "#...#", "#...#", "#...#", "#...#"],
  o: [".....", ".....", ".###.", "#...#", "#...#", "#...#", ".###."],
  p: [".....", ".....", "####.", "#...#", "#...#", "#...#", "####.", "#....", "#...."],
  q: [".....", ".....", ".####", "#...#", "#...#", "#...#", ".####", "....#", "....#"],
  r: [".....", ".....", "#.##.", "##..#", "#....", "#....", "#...."],
  s: [".....", ".....", ".####", "#....", ".###.", "....#", "####."],
  t: [".#...", ".#...", "####.", ".#...", ".#...", ".#...", "..##."],
  u: [".....", ".....", "#...#", "#...#", "#...#", "#...#", ".####"],
  v: [".....", ".....", "#...#", "#...#", "#...#", ".#.#.", "..#.."],
  w: [".....", ".....", "#...#", "#...#", "#.#.#", "#.#.#", ".#.#."],
  x: [".....", ".....", "#...#", ".#.#.", "..#..", ".#.#.", "#...#"],
  y: [".....", ".....", "#...#", "#...#", "#...#", "#...#", ".####", "....#", ".###."],
  z: [".....", ".....", "#####", "...#.", "..#..", ".#...", "#####"],
  0: [".###.", "#...#", "#..##", "#.#.#", "##..#", "#...#", ".###."],
  1: ["..#..", ".##..", "..#..", "..#..", "..#..", "..#..", ".###."],
  2: [".###.", "#...#", "....#", "...#.", "..#..", ".#...", "#####"],
  3: ["####.", "....#", "....#", ".###.", "....#", "....#", "####."],
  4: ["...#.", "..##.", ".#.#.", "#..#.", "#####", "...#.", "...#."],
  5: ["#####", "#....", "####.", "....#", "....#", "#...#", ".###."],
  6: ["..##.", ".#...", "#....", "####.", "#...#", "#...#", ".###."],
  7: ["#####", "....#", "...#.", "..#..", ".#...", ".#...", ".#..."],
  8: [".###.", "#...#", "#...#", ".###.", "#...#", "#...#", ".###."],
  9: [".###.", "#...#", "#...#", ".####", "....#", "...#.", ".##.."],
  ".": [".....", ".....", ".....", ".....", ".....", ".....", "..#.."],
  ",": [".....", ".....", ".....", ".....", ".....", ".....", "..#..", ".#..."],
  "'": ["..#..", "..#.."],
  "?": [".###.", "#...#", "....#", "...#.", "..#..", ".....", "..#.."],
  "!": ["..#..", "..#..", "..#..", "..#..", "..#..", ".....", "..#.."],
  "-": [".....", ".....", ".....", ".....", ".###."],
  "—": [".....", ".....", ".....", ".....", "#####"],
  "/": ["....#", "....#", "...#.", "..#..", ".#...", "#....", "#...."],
  ":": [".....", ".....", "..#..", ".....", ".....", ".....", "..#.."],
  "+": [".....", ".....", "..#..", "..#..", "#####", "..#..", "..#.."],
  "·": [".....", ".....", ".....", ".....", "..#.."],
  "(": ["...#.", "..#..", ".#...", ".#...", ".#...", "..#..", "...#."],
  ")": [".#...", "..#..", "...#.", "...#.", "...#.", "..#..", ".#..."],
  "@": [".###.", "#...#", "#.###", "#.#.#", "#.###", "#....", ".###."],
};
const ADV = 6; // buffer pixels per character, including the gap

// Hand-placed sprites. '#' is the main color, 'o' the second, '*' the third,
// '+' the fourth; anything else is clear.
const SPR = {
  pick: ["..#..", ".###.", "#####", ".###.", "..#.."],
  next: ["#####", ".###.", "..#.."],
  // you: an ember with a flickering tip
  ember: [
    ["...#...", "...#...", "..###..", ".##o##.", "##ooo##", ".##o##.", "..###..", "...#..."],
    ["....#..", "...#...", "..###..", ".##o##.", "##ooo##", ".##o##.", "..###..", "...#..."],
    ["..#....", "...#...", "..###..", ".#ooo#.", "##ooo##", ".#ooo#.", "..###..", "...#..."],
  ],
  // friends who follow you: two frames each
  mothA: [".....#.#.....", ".##...#...##.", "#**#..#..#**#", "#***#.#.#***#", ".#**#####**#.", "..#*#.#.#*#..", "..#**#.#**#..", "...##...##..."],
  mothB: ["....#...#....", "...#*###*#...", "...#**#**#...", "...#**#**#...", "....#*#*#....", "....#*#*#....", ".....#.#.....", "............."],
  fireflyA: ["#.....#", ".#...#.", "..#.#..", "..###..", "..###..", ".#ooo#.", "..ooo..", "...o..."],
  fireflyB: [".......", "##...##", "..#.#..", "..###..", "..###..", ".#ooo#.", "..ooo..", "...o..."],
  dragonA: ["#..#...#..#", "##..###..##", "###.o#o.###", ".###.#.###.", "..##***##..", "...#***#...", "...##.##...", ".....#.##.."],
  dragonB: ["...#...#...", "....###....", "#...o#o...#", "##..#.#..##", "###.***.###", ".##.***.##.", "...##.##...", ".....#.##.."],
  bugA: ["#.....#", "##.#.##", "#*###*#", ".#*#*#.", "...#..."],
  bugB: ["..#.#..", "..###..", ".#*#*#.", "..###..", "...#..."],
  // what gets thrown at you
  dustS: [".#.", "###", ".#."],
  dustL: [".##.", "####", "####", ".##."],
  spark: ["..#..", "..#..", "##o##", "..#..", "..#.."],
  fly: [".o.", "ooo", ".o."],
  featherL: ["#....", ".##..", "..##.", "...##"],
  featherF: [".#.#.", "#####"],
  featherR: ["...##", "..##.", ".##..", "#...."],
  // scenery
  pine: ["..o..", ".o#o.", "..#..", ".o#o.", "o###o", "..#.."],
  shard: [".#.", "#o#", "#o#", ".#."],
  icicle: ["###", "#o#", "#o#", ".#.", ".#.", ".#."],
  flame: ["..#..", ".###.", ".#o#.", "..#.."],
  checker: ["#.#.#", ".#.#.", "#.#.#", ".#.#.", "#.#.#"],
  soundOn: ["...#.....", "..##..#..", "####...#.", "####.#.#.", "####...#.", "..##..#..", "...#....."],
  soundOff: ["...#.....", "..##.....", "####.#.#.", "####..#..", "####.#.#.", "..##.....", "...#....."],
};

// Tablet icons, 9 × 9.
const ICON = {
  strike: ["..#####..", ".######..", "#######..", "####..#..", ".##...#..", "......#..", "......#..", "......#..", "......#.."],
  talk: ["#........", "##.......", ".##......", "..##.....", "..####...", "...######", "....#####", ".....####", "......##."],
  mend: ["...###...", "....#....", "...###...", "..#...#..", ".#.....#.", ".#.###.#.", ".#.###.#.", "..#####..", "........."],
  part: ["..#####..", ".#.....#.", "#..###..#", "#.#...#.#", "#.#...#.#", "#.#..##.#", "#.#...#.#", "#.#...#.#", "#########"],
  approach: [".........", "#...#....", ".#...#...", "..#...#..", "...#...#.", "..#...#..", ".#...#...", "#...#....", "........."],
  campfire: ["....#....", "...##....", "...###.#.", "..#####..", "..##.##..", ".##...##.", "..#####..", "#.......#", ".#######."],
  friends: [".........", ".##...##.", "####.####", "#########", "#########", ".#######.", "..#####..", "...###...", "....#...."],
};
// The calm meter: five runes, after the old Norse alphabet.
const RUNES = [
  ["#..#.", "#.#..", "##..#", "#..#.", "#.#..", "##...", "#...."],
  ["###..", "#..#.", "#...#", "#...#", "#...#", "#...#", "#...#"],
  ["#....", "##...", "#.#..", "#..#.", "#.#..", "##...", "#...."],
  ["##...", "#.#..", "##.#.", "#.#..", "#..#.", "#....", "#...."],
  ["###..", "#..#.", "#..#.", "###..", "#.#..", "#..#.", "#...#"],
];

// Scale2x (EPX): doubles a sprite and rounds off its diagonals, so big text
// and big sprites keep one-pixel detail instead of turning into blocks.
const epxCache = new Map();
function epx(rows, scale) {
  if (scale <= 1) return rows;
  const key = `${scale}|${rows.join("/")}`;
  let out = epxCache.get(key);
  if (out) return out;
  out = rows;
  for (let s = 1; s < scale; s *= 2) {
    const h = out.length;
    const w = Math.max(...out.map((r) => r.length));
    const src = out;
    const at = (x, y) => (y < 0 || y >= h || x < 0 || x >= w ? "." : src[y][x] ?? ".");
    const next = Array.from({ length: h * 2 }, () => new Array(w * 2));
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        const P = at(x, y);
        const A = at(x, y - 1);
        const B = at(x + 1, y);
        const L = at(x - 1, y);
        const D = at(x, y + 1);
        next[2 * y][2 * x] = L === A && L !== D && A !== B ? A : P;
        next[2 * y][2 * x + 1] = A === B && A !== L && B !== D ? B : P;
        next[2 * y + 1][2 * x] = D === L && D !== B && L !== A ? L : P;
        next[2 * y + 1][2 * x + 1] = B === D && B !== A && D !== L ? D : P;
      }
    }
    out = next.map((r) => r.join(""));
  }
  epxCache.set(key, out);
  return out;
}

const bmpCache = new Map();
function bitmap(rows, colors) {
  const key = `${rows.join("/")}|${colors.join(",")}`;
  let c = bmpCache.get(key);
  if (c) return c;
  const map = { "#": colors[0], o: colors[1], "*": colors[2], "+": colors[3] };
  c = document.createElement("canvas");
  c.width = Math.max(1, ...rows.map((r) => r.length));
  c.height = Math.max(1, rows.length);
  const g = c.getContext("2d");
  rows.forEach((row, y) => {
    for (let x = 0; x < row.length; x++) {
      const col = map[row[x]];
      if (!col) continue;
      g.fillStyle = col;
      g.fillRect(x, y, 1, 1);
    }
  });
  bmpCache.set(key, c);
  return c;
}

function drawBitmap(rows, x, y, { color = C.ink, color2, color3, color4, scale = 1, alpha = 1, center = false } = {}) {
  const c = bitmap(epx(rows, scale), [color, color2 ?? color, color3 ?? color, color4 ?? color]);
  const w = c.width * PX;
  const h = c.height * PX;
  ctx.globalAlpha = alpha;
  ctx.drawImage(c, snap(center ? x - w / 2 : x), snap(center ? y - h / 2 : y), w, h);
  ctx.globalAlpha = 1;
}

const textWidth = (str, scale = 1, spacing = 0) =>
  str.length ? (str.length * (ADV + spacing) - 1 - spacing) * scale * PX : 0;

function text(str, x, y, { scale = 1, color = C.ink, align = "left", alpha = 1, base = "top", spacing = 0, shadow = null } = {}) {
  str = String(str).toLowerCase();
  const w = textWidth(str, scale, spacing);
  const tx = snap(align === "center" ? x - w / 2 : align === "right" ? x - w : x);
  const ty = snap(base === "middle" ? y - 3.5 * scale * PX : y);
  const step = (ADV + spacing) * scale * PX;
  ctx.globalAlpha = alpha;
  for (const [ox, col] of shadow ? [[PX, shadow], [0, color]] : [[0, color]]) {
    for (let i = 0; i < str.length; i++) {
      const rows = FONT[str[i]];
      if (!rows) continue;
      const g = bitmap(epx(rows, scale), [col]);
      ctx.drawImage(g, tx + i * step + ox, ty + ox, g.width * PX, g.height * PX);
    }
  }
  ctx.globalAlpha = 1;
}

const wrapCache = new Map();
function wrap(str, maxW, scale = 1) {
  const max = Math.max(1, Math.floor((maxW / PX / scale + 1) / ADV));
  const key = `${max}|${str}`;
  let lines = wrapCache.get(key);
  if (lines) return lines;
  lines = [];
  for (const para of str.split("\n")) {
    let line = "";
    for (const word of para.split(" ")) {
      const test = line ? `${line} ${word}` : word;
      if (line && test.length > max) {
        lines.push(line);
        line = word;
      } else {
        line = test;
      }
    }
    lines.push(line);
  }
  if (wrapCache.size > 500) wrapCache.clear();
  wrapCache.set(key, lines);
  return lines;
}

// Draw `str` wrapped to `maxW`, revealing only the first `n` characters.
// Returns the number of wrapped lines the full string takes up.
function drawTyped(str, n, x, y, maxW, lh, { align = "left", color = C.ink, scale = 1, alpha = 1, shadow = null } = {}) {
  const lines = wrap(str, maxW, scale);
  let left = n;
  lines.forEach((ln, i) => {
    if (left <= 0) return;
    const lx = align === "center" ? x - textWidth(ln, scale) / 2 : x;
    text(ln.slice(0, left), lx, y + i * lh, { color, scale, alpha, shadow });
    left -= ln.length + 1; // +1 for the space or newline the wrap swallowed
  });
  return lines.length;
}

/* ----------------------------------------------------------------------- */
/* Pixel pen: draws shapes straight onto the pixel grid, with no           */
/* anti-aliasing, then bakes them into sprites                             */
/* ----------------------------------------------------------------------- */
// Shapes are described in design units around the sprite's center; `k` is
// pixels per unit. Outlines are one pixel wide with the corner pixels that
// would make them look doubled ("elbows") removed. Mirrored halves meet on a
// pixel boundary, so left and right sides come out exactly symmetric.
function rasterLine(pts, closed) {
  const P = pts.map(([x, y]) => [Math.floor(x), Math.floor(y)]);
  if (closed) P.push(P[0]);
  let [x0, y0] = P[0];
  const raw = [[x0, y0]];
  for (let i = 1; i < P.length; i++) {
    const [x1, y1] = P[i];
    const dx = Math.abs(x1 - x0);
    const dy = -Math.abs(y1 - y0);
    const sx = x0 < x1 ? 1 : -1;
    const sy = y0 < y1 ? 1 : -1;
    let err = dx + dy;
    while (x0 !== x1 || y0 !== y1) {
      const e2 = 2 * err;
      if (e2 >= dy) {
        err += dy;
        x0 += sx;
      }
      if (e2 <= dx) {
        err += dx;
        y0 += sy;
      }
      raw.push([x0, y0]);
    }
  }
  const out = [];
  for (let i = 0; i < raw.length; i++) {
    const b = raw[i];
    const a = out[out.length - 1];
    const c = raw[i + 1];
    if (a && c) {
      const step1 = a[0] === b[0] || a[1] === b[1];
      const step2 = c[0] === b[0] || c[1] === b[1];
      const diagonal = Math.abs(a[0] - c[0]) === 1 && Math.abs(a[1] - c[1]) === 1;
      if (step1 && step2 && diagonal) continue;
    }
    out.push(b);
  }
  return out;
}

class Pen {
  constructor(w, h, ox, oy, k) {
    Object.assign(this, { w, h, ox, oy, k });
    this.px = new Array(w * h).fill(null);
  }
  T([u, v]) {
    return [this.ox + u * this.k, this.oy + v * this.k];
  }
  set(x, y, c) {
    if (x >= 0 && y >= 0 && x < this.w && y < this.h) this.px[y * this.w + x] = c;
  }
  line(pts, c, closed = false) {
    for (const [x, y] of rasterLine(pts.map((p) => this.T(p)), closed)) this.set(x, y, c);
  }
  fill(pts, c) {
    const P = pts.map((p) => this.T(p));
    const ys = P.map((p) => p[1]);
    for (let y = Math.floor(Math.min(...ys)); y <= Math.ceil(Math.max(...ys)); y++) {
      const sy = y + 0.5;
      const xs = [];
      for (let i = 0, j = P.length - 1; i < P.length; j = i++) {
        const [x1, y1] = P[i];
        const [x2, y2] = P[j];
        if (y1 > sy !== y2 > sy) xs.push(x1 + ((sy - y1) * (x2 - x1)) / (y2 - y1));
      }
      xs.sort((a, b) => a - b);
      for (let n = 0; n + 1 < xs.length; n += 2) {
        for (let x = Math.ceil(xs[n] - 0.5); x <= Math.floor(xs[n + 1] - 0.5); x++) this.set(x, y, c);
      }
    }
  }
  shape(pts, fill, stroke) {
    if (fill) this.fill(pts, fill);
    if (stroke) this.line(pts, stroke, true);
  }
  disc(u, v, r, c) {
    const [cx, cy] = this.T([u, v]);
    const rr = r * this.k;
    for (let y = Math.floor(cy - rr - 1); y <= Math.ceil(cy + rr + 1); y++) {
      for (let x = Math.floor(cx - rr - 1); x <= Math.ceil(cx + rr + 1); x++) {
        if ((x + 0.5 - cx) ** 2 + (y + 0.5 - cy) ** 2 <= rr * rr) this.set(x, y, c);
      }
    }
  }
  dot(u, v, c) {
    const [x, y] = this.T([u, v]);
    this.set(Math.floor(x), Math.floor(y), c);
  }
  canvas() {
    const c = document.createElement("canvas");
    c.width = this.w;
    c.height = this.h;
    const g = c.getContext("2d");
    for (let y = 0; y < this.h; y++) {
      for (let x = 0; x < this.w; x++) {
        const col = this.px[y * this.w + x];
        if (!col) continue;
        g.fillStyle = col;
        g.fillRect(x, y, 1, 1);
      }
    }
    c.ox = this.ox;
    c.oy = this.oy;
    return c;
  }
}

// Curve helpers, all in design units.
function bez(p0, p1, p2, p3, n = 24) {
  return Array.from({ length: n + 1 }, (_, i) => {
    const t = i / n;
    const u = 1 - t;
    return [0, 1].map((a) => u * u * u * p0[a] + 3 * u * u * t * p1[a] + 3 * u * t * t * p2[a] + t * t * t * p3[a]);
  });
}
function qbez(p0, p1, p2, n = 16) {
  return Array.from({ length: n + 1 }, (_, i) => {
    const t = i / n;
    const u = 1 - t;
    return [0, 1].map((a) => u * u * p0[a] + 2 * u * t * p1[a] + t * t * p2[a]);
  });
}
function oval(cx, cy, rx, ry, n = 40) {
  return Array.from({ length: n }, (_, i) => [cx + Math.cos((i / n) * TAU) * rx, cy + Math.sin((i / n) * TAU) * ry]);
}
const path = (...segs) => segs.flat();
const mirror = (pts, side, squash = 1) => pts.map(([u, v]) => [u * side * squash, v]);

const bakeCache = new Map();
function baked(key, make) {
  let c = bakeCache.get(key);
  if (!c) {
    c = make();
    bakeCache.set(key, c);
  }
  return c;
}

function drawSprite(c, x, y, alpha = 1) {
  if (alpha <= 0) return;
  ctx.globalAlpha = alpha;
  ctx.drawImage(c, snap(x) - c.ox * PX, snap(y) - c.oy * PX, c.width * PX, c.height * PX);
  ctx.globalAlpha = 1;
}

// Light in stepped bands, with a little dither only where two bands meet.
// `ramp` runs from the outermost color to the innermost.
function glowCanvas(r, ramp) {
  return baked(`glow|${r}|${ramp.join(",")}`, () => {
    const cv = document.createElement("canvas");
    cv.width = cv.height = r * 2 + 1;
    const g = cv.getContext("2d");
    for (let py = 0; py <= r * 2; py++) {
      for (let px = 0; px <= r * 2; px++) {
        const d = Math.hypot(px - r, py - r) / r;
        if (d > 1) continue;
        const level = Math.ceil((1 - d) * ramp.length + BAYER[((py & 3) << 2) | (px & 3)] * 0.7);
        if (level < 1) continue;
        g.fillStyle = ramp[Math.min(level, ramp.length) - 1];
        g.fillRect(px, py, 1, 1);
      }
    }
    cv.ox = r;
    cv.oy = r;
    return cv;
  });
}

function drawGlow(x, y, r, ramp) {
  drawSprite(glowCanvas(r, ramp), x, y);
}

const MOTH_FLAP = [1, 0.62, 0.28];
const FLY_FLAP = [1, 0.55, 0.15];

function bakeMoth(frame, color, k) {
  const flap = MOTH_FLAP[frame];
  const detail = k >= 0.4;
  const ox = Math.ceil(76 * k) + 2;
  const oy = Math.ceil(52 * k) + 2;
  const pen = new Pen(ox * 2, oy + Math.ceil(50 * k) + 2, ox, oy, k);
  for (const side of [-1, 1]) {
    const m = (pts) => mirror(pts, side, flap);
    const hind = m(path(bez([3, 0], [24, 0], [46, 8], [44, 26]), bez([44, 26], [42, 40], [22, 46], [12, 36]), bez([12, 36], [6, 28], [3, 14], [3, 4])));
    pen.fill(hind, C.night);
    if (detail) pen.line(m(bez([6, 6], [18, 10], [28, 18], [32, 30])), C.faint);
    pen.line(hind, color, true);
    const fore = m(path(bez([3, -9], [18, -40], [52, -48], [66, -32]), bez([66, -32], [74, -22], [64, -4], [50, -2]), bez([50, -2], [32, 0], [14, 2], [3, 1])));
    pen.fill(fore, C.night);
    if (detail) {
      pen.line(m(bez([6, -5], [20, -16], [34, -26], [56, -32])), C.faint);
      pen.line(m(oval(42, -20, 7, 7, 28)), C.dim, true);
    }
    pen.disc(42 * side * flap, -20, detail ? 3 : 4, color);
    pen.line(fore, color, true);
  }
  const body = oval(0, 4, 5, 20);
  pen.fill(body, C.faint);
  if (detail) {
    pen.line([[-3, 9], [3, 9]], C.dim);
    pen.line([[-3, 15], [3, 15]], C.dim);
  }
  pen.line(body, color, true);
  pen.shape(oval(0, -21, 6, 6), C.night, color);
  if (detail) {
    pen.dot(-2.4, -21, C.core);
    pen.dot(2.4, -21, C.core);
  }
  for (const side of [-1, 1]) {
    const ant = mirror(qbez([2, -26], [4, -42], [16, -48]), side);
    pen.line(ant, color);
    if (detail) {
      for (const t of [6, 10, 14]) {
        const [u, v] = ant[t];
        pen.line([[u, v], [u + side * 4, v + 2]], color);
      }
    }
  }
  return pen.canvas();
}

function bakeFirefly(frame, lit, color, k) {
  const flap = FLY_FLAP[frame];
  const ox = Math.ceil(36 * k) + 2;
  const oy = Math.ceil(34 * k) + 2;
  const pen = new Pen(ox * 2, oy + Math.ceil(30 * k) + 2, ox, oy, k);
  for (const side of [-1, 1]) {
    const rot = side * (-0.2 - 0.8 * flap);
    const cs = Math.cos(rot);
    const sn = Math.sin(rot);
    const wing = oval(side * 13, 0, 13, 5, 32).map(([u, v]) => [side * 3 + u * cs - v * sn, -5 + u * sn + v * cs]);
    pen.shape(wing, C.night, C.dim);
  }
  const lantern = oval(0, 14, 9, 13);
  pen.fill(lantern, lit ? C.glim : C.moss);
  if (lit) pen.disc(-3, 9, 2.5, C.core);
  pen.line([[-8, 7], [8, 7]], color);
  pen.line(lantern, color, true);
  pen.shape(oval(0, -3, 6.5, 6), C.faint, color);
  pen.shape(oval(0, -13, 5, 5), C.night, color);
  pen.dot(-2, -14, C.core);
  pen.dot(2, -14, C.core);
  for (const side of [-1, 1]) {
    pen.line(mirror(qbez([2, -17], [3, -26], [10, -30]), side), color);
    pen.line(mirror([[5, 1], [11, 7]], side), color);
    pen.line(mirror([[5, -4], [12, -2]], side), color);
  }
  return pen.canvas();
}

const DRAGON_LIFT = [1, 0.6, 0.25];
const DRAGON_K = 0.6; // drawn a little larger than the others: it's the big one

// A front-facing frost dragon perched on a carved runestone. `frame` raises
// or lowers the wings; `mood` sets the eyes, from a glare at your light down
// to asleep.
function bakeDragon(frame, mood, color, k) {
  const lift = DRAGON_LIFT[frame];
  const detail = k >= 0.4;
  const ox = Math.ceil(72 * k) + 2;
  const oy = Math.ceil(56 * k) + 2;
  const pen = new Pen(ox * 2, oy + Math.ceil(50 * k) + 2, ox, oy, k);
  const drop = 1 - lift;

  // wings, behind everything
  for (const side of [-1, 1]) {
    const m = (pts) => mirror(pts, side);
    const S = [8, -6];
    const E = [30, -30 + drop * 14];
    const tip = [68, -40 + drop * 34];
    const fingers = [[58, -10 + drop * 22], [46, 4 + drop * 8], [32, 2], [18, 12]];
    const edge = [];
    let prev = tip;
    for (const f of fingers) {
      const mid = [(prev[0] + f[0]) / 2, (prev[1] + f[1]) / 2];
      const ctrl = [lerp(mid[0], E[0], 0.3), lerp(mid[1], E[1], 0.3)];
      edge.push(...qbez(prev, ctrl, f, 10));
      prev = f;
    }
    const wing = m([S, ...qbez(S, [16, -26 + drop * 8], E, 10), ...qbez(E, [50, -44 + drop * 20], tip, 12), ...edge, [8, 8]]);
    pen.fill(wing, C.night);
    if (detail) for (const f of fingers) pen.line(m([E, f]), C.faint);
    pen.line(wing, color, true);
  }

  // the runestone it's perched on, with carved runes
  const stone = [[-26, 30], [26, 30], [30, 48], [-30, 48]];
  pen.fill(stone, C.stone);
  pen.line([[-25, 31], [25, 31]], C.stoneL);
  if (detail) {
    for (const u of [-16, -4, 8]) {
      pen.line([[u, 34], [u, 44]], C.rune);
      pen.line([[u, 36], [u + 4, 38]], C.rune);
    }
  }
  pen.line(stone, C.stoneD, true);

  // tail curling around the front of the stone
  const curve = qbez([12, 26], [46, 44], [34, 16], 22);
  const tail = [];
  curve.forEach(([u, v], i) => {
    const w = 4 * (1 - i / curve.length);
    const [nu, nv] = curve[Math.min(i + 1, curve.length - 1)];
    const len = Math.hypot(nu - u, nv - v) || 1;
    tail.push([u - ((nv - v) / len) * w, v + ((nu - u) / len) * w]);
  });
  for (let i = curve.length - 1; i >= 0; i--) {
    const [u, v] = curve[i];
    const w = 4 * (1 - i / curve.length);
    const [nu, nv] = curve[Math.min(i + 1, curve.length - 1)];
    const len = Math.hypot(nu - u, nv - v) || 1;
    tail.push([u + ((nv - v) / len) * w, v - ((nu - u) / len) * w]);
  }
  pen.shape(tail, C.night, color);

  // body, belly plates, legs
  const body = oval(0, 10, 17, 22);
  pen.fill(body, C.night);
  pen.fill(oval(0, 14, 9, 16), C.stone);
  if (detail) for (const v of [4, 10, 16, 22]) pen.line([[-7, v], [7, v]], C.stoneD);
  pen.line(body, color, true);
  for (const side of [-1, 1]) {
    pen.shape(mirror([[10, 18], [17, 22], [16, 31], [8, 31]], side), C.night, color);
    for (const u of [9, 12, 15]) pen.dot(side * u, 31, C.ink);
  }

  // neck, head, horns
  pen.shape([[-7, -4], [-6, -22], [6, -22], [7, -4]], C.night, color);
  for (const side of [-1, 1]) {
    pen.shape(mirror([[6, -36], [20, -53], [12, -34]], side), C.dim, color);
    pen.shape(mirror([[10, -30], [19, -28], [11, -25]], side), C.night, color);
  }
  pen.shape([[-2, -38], [0, -44], [2, -38]], C.night, color);
  pen.shape(oval(0, -30, 11, 9), C.night, color);
  pen.shape(oval(0, -23, 6.5, 5), C.night, color);
  pen.dot(-2, -22, C.bg);
  pen.dot(2, -22, C.bg);

  // eyes
  for (const side of [-1, 1]) {
    const ex = side * 5;
    if (mood === "glare") {
      pen.line([[ex - side * 3, -34], [ex + side * 3, -31]], C.rune);
      pen.line([[ex - side * 3, -33], [ex + side * 3, -30]], C.rune);
    } else if (mood === "watch") {
      pen.disc(ex, -32, 2.6, C.rune);
      pen.dot(ex, -32, C.bg);
    } else if (mood === "drowsy") {
      pen.line([[ex - 3, -33], [ex + 3, -33]], color);
      pen.disc(ex, -31, 1.6, C.rune);
    } else {
      pen.line(qbez([ex - 3, -32], [ex, -29], [ex + 3, -32]), color);
    }
  }
  return pen.canvas();
}

function bakeRing(r, color) {
  const pen = new Pen(r * 2 + 4, r * 2 + 4, r + 2, r + 2, 1);
  pen.line(oval(0, 0, r, r, 32), color, true);
  return pen.canvas();
}

function bakeMoon() {
  const pen = new Pen(18, 18, 9, 9, 1);
  pen.disc(0, 0, 7, C.ink);
  pen.disc(3.5, -2.5, 6.5, null);
  pen.dot(-4, 1, C.dim);
  pen.dot(-2, 4, C.dim);
  return pen.canvas();
}

/* ----------------------------------------------------------------------- */
/* Sound — tiny synthesized blips, created on the first key press or tap.  */
/* ----------------------------------------------------------------------- */
let audio = null;
let muted = storage.get("ember:muted") === "1";

function ensureAudio() {
  if (!audio) {
    const AC = window.AudioContext || window.webkitAudioContext;
    if (!AC) return;
    audio = new AC();
  }
  if (audio.state === "suspended") audio.resume();
}

function tone(freq, dur = 0.06, { type = "square", vol = 0.03, slide = 0, delay = 0 } = {}) {
  if (!audio || muted) return;
  const t0 = audio.currentTime + delay;
  const osc = audio.createOscillator();
  const gain = audio.createGain();
  osc.type = type;
  osc.frequency.setValueAtTime(freq, t0);
  if (slide) osc.frequency.exponentialRampToValueAtTime(Math.max(40, freq + slide), t0 + dur);
  gain.gain.setValueAtTime(0.0001, t0);
  gain.gain.exponentialRampToValueAtTime(vol, t0 + 0.006);
  gain.gain.exponentialRampToValueAtTime(0.0001, t0 + dur);
  osc.connect(gain).connect(audio.destination);
  osc.start(t0);
  osc.stop(t0 + dur + 0.02);
}

function noise(dur = 0.12, vol = 0.05) {
  if (!audio || muted) return;
  const len = Math.floor(audio.sampleRate * dur);
  const b = audio.createBuffer(1, len, audio.sampleRate);
  const data = b.getChannelData(0);
  for (let i = 0; i < len; i++) data[i] = (Math.random() * 2 - 1) * (1 - i / len);
  const src = audio.createBufferSource();
  const gain = audio.createGain();
  gain.gain.value = vol;
  src.buffer = b;
  src.connect(gain).connect(audio.destination);
  src.start();
}

const chord = (notes, gap, opts) => notes.forEach((f, i) => tone(f, 0.12, { ...opts, delay: i * gap }));

const sfx = {
  narrator: () => tone(rand(300, 318), 0.035, { type: "triangle", vol: 0.06 }),
  foe: () => tone(rand(820, 1000), 0.03, { type: "sine", vol: 0.05 }),
  move: () => tone(520, 0.03, { vol: 0.015 }),
  select: () => chord([660, 990], 0.04, { vol: 0.018 }),
  back: () => tone(392, 0.05, { vol: 0.015 }),
  nope: () => tone(150, 0.14, { type: "triangle", vol: 0.06 }),
  hurt: () => { noise(0.1, 0.06); tone(190, 0.15, { vol: 0.03, slide: -110 }); },
  slash: () => tone(1500, 0.14, { type: "sawtooth", vol: 0.012, slide: -1200 }),
  hit: () => { noise(0.18, 0.08); tone(230, 0.2, { vol: 0.025, slide: -150 }); },
  heal: () => chord([523, 659, 784], 0.07, { type: "triangle", vol: 0.04 }),
  calm: () => chord([784, 988, 1175], 0.09, { type: "sine", vol: 0.035 }),
  out: () => tone(320, 0.7, { type: "triangle", vol: 0.06, slide: -250 }),
  warm: () => chord([392, 494, 587, 784], 0.14, { type: "triangle", vol: 0.04 }),
  buy: () => chord([587, 880], 0.06, { type: "triangle", vol: 0.045 }),
};

function toggleMute() {
  muted = !muted;
  storage.set("ember:muted", muted ? "1" : "0");
  ensureAudio();
  if (!muted) sfx.select();
  say(muted ? "sound off" : "sound on");
}

/* ----------------------------------------------------------------------- */
/* Input — keyboard, plus taps and drags for touch screens.                */
/* ----------------------------------------------------------------------- */
const KEYS = {
  ArrowUp: "up", KeyW: "up",
  ArrowDown: "down", KeyS: "down",
  ArrowLeft: "left", KeyA: "left",
  ArrowRight: "right", KeyD: "right",
  KeyZ: "confirm", Enter: "confirm", Space: "confirm",
  KeyX: "cancel", ShiftLeft: "cancel", ShiftRight: "cancel", Escape: "cancel", Backspace: "cancel",
  KeyM: "mute",
  KeyV: "view",
};
const held = new Set();
const pressed = new Set(); // pressed since the last tick
const taps = []; // pointer-downs since the last tick, in logical coords
const drag = { active: false, lastX: 0, lastY: 0, dx: 0, dy: 0 };

window.addEventListener("keydown", (e) => {
  if (e.metaKey || e.ctrlKey || e.altKey) return;
  const action = KEYS[e.code];
  if (!action) return;
  e.preventDefault();
  ensureAudio();
  if (!e.repeat) pressed.add(action);
  held.add(action);
});
window.addEventListener("keyup", (e) => {
  const action = KEYS[e.code];
  if (action) held.delete(action);
});
window.addEventListener("blur", () => held.clear());

canvas.addEventListener("pointerdown", (e) => {
  ensureAudio();
  const p = toLogical(e);
  taps.push(p);
  drag.active = true;
  drag.lastX = p.x;
  drag.lastY = p.y;
  canvas.setPointerCapture?.(e.pointerId);
  e.preventDefault();
});
canvas.addEventListener("pointermove", (e) => {
  if (!drag.active) return;
  const p = toLogical(e);
  drag.dx += p.x - drag.lastX;
  drag.dy += p.y - drag.lastY;
  drag.lastX = p.x;
  drag.lastY = p.y;
});
const endDrag = () => { drag.active = false; };
canvas.addEventListener("pointerup", endDrag);
canvas.addEventListener("pointercancel", endDrag);

const confirmed = () => pressed.has("confirm") || taps.length > 0;
const inRect = (p, r) => p.x >= r.x && p.x < r.x + r.w && p.y >= r.y && p.y < r.y + r.h;

/* ----------------------------------------------------------------------- */
/* Typewriter                                                              */
/* ----------------------------------------------------------------------- */
// One or more lines. Confirm finishes the current line, then moves to the
// next; `onDone` fires after the last one.
class Typer {
  constructor(lines, { voice = "narrator", onDone = null, auto = 0 } = {}) {
    this.lines = Array.isArray(lines) ? lines : [lines];
    this.voice = voice;
    this.onDone = onDone;
    this.auto = auto; // ticks to wait before advancing on its own (0 = never)
    this.i = 0;
    this.n = 0;
    this.acc = 0;
    this.wait = 0;
    this.done = false;
    say(this.text);
  }
  get text() { return this.lines[this.i]; }
  get full() { return this.n >= this.text.length; }
  update() {
    if (this.done) return;
    if (this.full) {
      if (this.auto && ++this.wait >= this.auto) this.advance();
      return;
    }
    this.acc += 0.8;
    while (this.acc >= 1 && !this.full) {
      this.acc -= 1;
      const ch = this.text[this.n++];
      if (".,?!".includes(ch) && !this.full) this.acc -= 5; // let punctuation breathe
      if (ch !== " " && this.n % 2 === 1) sfx[this.voice]?.();
    }
  }
  advance() {
    if (this.done) return;
    if (!this.full) {
      this.n = this.text.length;
      return;
    }
    if (this.i < this.lines.length - 1) {
      this.i++;
      this.n = 0;
      this.acc = 0;
      this.wait = 0;
      say(this.text);
      return;
    }
    this.done = true;
    this.onDone?.();
  }
}

/* ----------------------------------------------------------------------- */
/* Progress: warmth, distance, friends, upgrades                           */
/* ----------------------------------------------------------------------- */
const UPGRADES = [
  { id: "hearth", label: "hearth", desc: "+0.5 warmth / s", base: 15, growth: 1.45, max: 30 },
  { id: "hp", label: "kindling", desc: "+4 max hp", base: 25, growth: 1.6, max: 10 },
  { id: "mend", label: "spare wick", desc: "+1 mend each fight", base: 40, growth: 1.9, max: 4 },
  { id: "glow", label: "soft glow", desc: "talking calms more", base: 60, growth: 1.8, max: 5 },
  { id: "hand", label: "steady hand", desc: "slower strike line", base: 50, growth: 1.7, max: 5 },
  { id: "stride", label: "long stride", desc: "walk faster", base: 30, growth: 1.5, max: 8 },
];
const SAVE_KEY = "ember:save";

function newSave() {
  return {
    v: 1,
    started: false,
    warmth: 0,
    lifetime: 0,
    dist: 0,
    prevAt: 0,
    nextAt: 40,
    met: 0,
    struck: 0,
    up: Object.fromEntries(UPGRADES.map((u) => [u.id, 0])),
    friends: [],
    t: Date.now(),
  };
}

function loadSave() {
  try {
    const raw = storage.get(SAVE_KEY);
    if (!raw) return newSave();
    const s = JSON.parse(raw);
    const base = newSave();
    return { ...base, ...s, up: { ...base.up, ...(s.up || {}) }, friends: Array.isArray(s.friends) ? s.friends.map((f) => (f.key === "owl" ? { ...f, key: "dragon" } : f)) : [] };
  } catch {
    return newSave();
  }
}

let S = loadSave();
function persist() {
  S.t = Date.now();
  storage.set(SAVE_KEY, JSON.stringify(S));
}

const lvl = (id) => S.up[id] || 0;
const ownGlow = () => 1 + 0.5 * lvl("hearth");
const warmthRate = () => ownGlow() + S.friends.reduce((sum, f) => sum + f.rate, 0);
const walkSpeed = () => 2 * (1 + 0.2 * lvl("stride")); // meters per second
const upgradeCost = (u) => Math.round(u.base * Math.pow(u.growth, lvl(u.id)));
const arrived = () => S.dist >= S.nextAt;
const night = () => Math.floor(S.met / 3) + 1;
const rewardMult = (n) => 1 + 0.5 * (n - 1);
const encounterGap = () => 80 + 10 * Math.min(S.met, 12);

function gain(n) {
  S.warmth += n;
  S.lifetime += n;
}

// Time spent away (page closed or hidden) still counts.
function catchUp(secs, walk) {
  if (!S.started || secs <= 0) return 0;
  secs = Math.min(secs, MAX_AWAY);
  const g = warmthRate() * secs;
  gain(g);
  if (walk) S.dist = Math.min(S.nextAt, S.dist + walkSpeed() * secs);
  return g;
}

/* ----------------------------------------------------------------------- */
/* Who's out on the path                                                   */
/* ----------------------------------------------------------------------- */
// Acts: `check` has no gain. `max` caps how often an act works, `need` is the
// calm it takes to land, `say` is what the creature answers.
const SPECIES = {
  moth: {
    names: ["dusk", "umber", "sable", "wick"],
    plural: "moths",
    hp: 60, rate: 1.5, burst: 45, y: 90, bullet: "dust",
    jitter: 1, bob: 1, flap: [0.3, 0.07],
    intro: "a moth flutters out of the dark. it's drawn to your light.",
    acts: [
      { label: "check", lines: [["{name}. a moth, a long way from home.", "it's cold out here. you're the only warm thing for miles."]] },
      {
        label: "dim", dims: true, max: 2, gain: 25,
        lines: [["you dim your glow.", "the moth stops darting around quite so much."], ["you dim yourself even further.", "{name}'s wingbeats slow down."]],
        spent: "you can't get any dimmer without going out.",
        say: ["...where did the light go?", "...softer now."],
      },
      {
        label: "hum", max: 2, gain: 20,
        lines: [["you hum something low and slow.", "the moth tilts its head."], ["you hum again.", "{name} hums back. sort of."]],
        spent: "you've run out of songs.",
        say: ["...hm?", "...hmmm..."],
      },
      {
        label: "hold still", need: 50, gain: 35, failGain: 5,
        lines: [["you hold very still.", "{name} lands beside you, just for a moment."]],
        fail: ["you hold very still.", "{name} is too restless to come close."],
        say: ["...you're warm."], failSay: "no. no. too close.",
      },
    ],
    talk: [["light. light. light.", "so cold out here...", "closer. closer."], ["...are you a lamp?", "...you don't burn.", "i was lost..."], ["...sleepy...", "...it's nice here."]],
    strikeSay: ["!!", "why...?", "it stings..."],
    missSay: "...?", partSay: "wait. don't go.", restSay: "...i could sleep here.",
    flavor: [
      ["{name} circles you, frantic.", "dust shimmers where the moth has been.", "the moth can't look away from your glow."],
      ["{name}'s wingbeats slow a little.", "the moth hovers, unsure of you."],
      ["{name} drifts lower. it looks tired.", "the moth's wings barely move now."],
    ],
    hurt: "{name}'s wings are torn. it keeps flying anyway.",
    calmed: "{name} doesn't want to fight anymore.",
    resting: "{name} is resting. it's ready to part ways.",
    spare: ["you dim your light and step away, slowly.", "{name} follows you anyway, a little way behind."],
    fall: ["the moth falls.", "its dust glitters for a moment, then goes dark."],
    patterns: ["dustfall", "gust", "moths", "spiral", "ring"],
  },
  firefly: {
    names: ["pip", "glim", "spark", "flicker"],
    plural: "fireflies",
    hp: 50, rate: 2.5, burst: 70, y: 92, bullet: "spark",
    jitter: 1.4, bob: 1.5, flap: [0.45, 0.12],
    intro: "a firefly zips out of the grass. it thinks it's the brightest thing out here.",
    acts: [
      { label: "check", lines: [["{name}. a firefly, very proud of its light.", "it doesn't like sharing the dark with you."]] },
      {
        label: "dim", dims: true, max: 1, gain: 30,
        lines: [["you dim your glow.", "{name} shines brighter by comparison. it looks pleased."]],
        spent: "you're already as dim as you can be.",
        say: ["ha! see? brightest."],
      },
      {
        label: "blink", max: 2, gain: 20,
        lines: [["you blink your light, slow and steady.", "{name} blinks back, a little out of time."], ["you blink again.", "this time {name} blinks right along with you."]],
        spent: "{name} is tired of blinking.",
        say: ["blink! blink!", "...in time. huh."],
      },
      {
        label: "cheer", need: 40, gain: 45, failGain: 5,
        lines: [["you tell {name} it's the brightest light on the path.", "it glows so hard it nearly falls over."]],
        fail: ["you tell {name} it's very bright.", "it doesn't believe you yet."],
        say: ["...really? really?"], failSay: "you're just saying that.",
      },
    ],
    talk: [["out of my dark!", "too bright! too bright!", "i was here first."], ["...you're not so bright.", "...hmph.", "look. look at me."], ["...we could glow together.", "...twinkle."]],
    strikeSay: ["ow! cheater!", "hey!!", "...that hurt."],
    missSay: "ha! missed!", partSay: "running away? good.", restSay: "...you can stay. i guess.",
    flavor: [
      ["{name} zips around, blinking furiously.", "the firefly is trying very hard to outshine you."],
      ["{name} flickers, unsure if it's winning.", "the firefly keeps glancing at you."],
      ["{name} glows softly now.", "the firefly blinks slowly, in time with you."],
    ],
    hurt: "{name}'s light is sputtering.",
    calmed: "{name} isn't competing anymore.",
    resting: "{name} is glowing quietly. it's ready to part ways.",
    spare: ["you step back into the dark.", "{name} decides the path is better with two lights. it follows you."],
    fall: ["the firefly's light goes out.", "the grass is very dark without it."],
    patterns: ["zigzag", "burst", "dustfall", "ring"],
  },
  dragon: {
    names: ["rime", "cairn", "sleet", "flint"],
    plural: "dragons",
    hp: 90, rate: 4, burst: 120, y: 84, bullet: "shard",
    jitter: 0, bob: 0, flap: [0.12, 0.04],
    intro: "an old dragon is curled on a runestone, frost on its horns. it turns toward your light.",
    acts: [
      { label: "check", lines: [["{name}. an old dragon whose fire went out long ago.", "it has been cold for a very long time."]] },
      {
        label: "warm", max: 2, gain: 20,
        lines: [["you hold your glow out toward {name}.", "the frost on its snout starts to melt."], ["you burn a little brighter, just for {name}.", "it breathes in your warmth, slowly."]],
        spent: "you don't have any more warmth to spare.",
        say: ["...warm. i'd forgotten.", "...more."],
      },
      {
        label: "bow", max: 1, gain: 25,
        lines: [["you bow low to the old dragon.", "{name} lowers its great head, just slightly."]],
        spent: "you've already bowed. it noticed.",
        say: ["...manners. how rare."],
      },
      {
        label: "tell a saga", need: 45, gain: 40, failGain: 5,
        lines: [["you tell {name} the saga of a small ember that crossed the snow.", "it listens to the very end."]],
        fail: ["you start a saga.", "{name} isn't ready to listen yet."],
        say: ["...tell it again sometime."], failSay: "...not now, spark.",
      },
    ],
    talk: [["...a spark? out here?", "my fire... gone.", "leave my cairn."], ["...you're very warm.", "...i remember fire.", "...stay. no. go."], ["...sleepy...", "...the snow is soft tonight."]],
    strikeSay: ["...!", "you dare.", "...that stung."],
    missSay: "...", partSay: "no one leaves the cairn.", restSay: "...rest by me, little spark.",
    flavor: [
      ["{name} watches you, its breath freezing in the air.", "frost creeps across the runestone."],
      ["{name} shifts its wings, unsure.", "the old dragon leans a little closer to your warmth."],
      ["{name}'s eyes are half closed.", "the dragon is curling up around its stone."],
    ],
    hurt: "{name}'s scales are cracked with frost.",
    calmed: "{name} doesn't want to fight anymore.",
    resting: "{name} is curled up, at peace. it's ready to part ways.",
    spare: ["you leave a little of your warmth on the runestone.", "later, slow wingbeats follow you down the path."],
    fall: ["the dragon slumps against its runestone.", "the frost on its scales goes dark."],
    patterns: ["icicles", "breath", "swoop", "ring"],
  },
};
const ROSTER = ["moth", "firefly", "dragon"];

function newFoe(index) {
  const key = ROSTER[index % ROSTER.length];
  const sp = SPECIES[key];
  const n = Math.floor(index / ROSTER.length) + 1;
  const hp = Math.round(sp.hp * (1 + 0.6 * (n - 1)));
  return {
    key, sp, night: n, name: sp.names[(n - 1) % sp.names.length],
    hp, max: hp, shown: hp, calm: 0, struck: 0, uses: [0, 0, 0, 0],
    x: 240, y: sp.y, phase: 0, shake: 0, flash: 0, barT: 0,
    dead: false, spared: false, alpha: 1,
  };
}

/* ----------------------------------------------------------------------- */
/* Game state                                                              */
/* ----------------------------------------------------------------------- */
const MENU = ["strike", "talk", "mend", "part"];
const HUB_OPTS = ["approach", "campfire", "friends"];
const MENU_BOX = { x: 20, y: 190, w: 440, h: 114 };
const HUB_BOX = { x: 20, y: 252, w: 440, h: 100 };
const PANEL_BOX = { x: 20, y: 92, w: 440, h: 262 };
const ARENA_CY = 240;
const HUD_Y = 338;
const OPT_Y = 386;
const GROUND = 214;
const WALK_X = 196;
const PX_PER_M = 14;

const G = {
  scene: "title",
  t: 0,
  sceneT: 0,
  fade: 0,
  shake: 0,
  save: S,
  // title
  titleSel: 0,
  confirmReset: false,
  awayMsg: null,
  // hub
  hubPhase: "walk",
  hubSel: 1,
  campSel: 0,
  campFlash: null,
  walkT: 0,
  arrivedShown: false,
  // battle
  hp: 20,
  maxHp: 20,
  mends: 3,
  dimmed: 0,
  foe: null,
  phase: "menu",
  menu: 0,
  act: 0,
  turn: 0,
  lastAct: null,
  bulletKind: "dust",
  dialog: null,
  bubble: null,
  box: { ...HUB_BOX },
  boxTarget: { ...HUB_BOX },
  player: { x: 240, y: ARENA_CY, inv: 0 },
  bullets: [],
  pattern: null,
  patT: 0,
  k: 1,
  ps: {}, // per-pattern scratch state
  strike: null,
  slash: null,
  floaters: [],
  particles: [],
  stars: [],
  view: storage.get("ember:view") || "ascii",
  glyphs: [], // free-floating glyphs for the ASCII view, rebuilt every frame
  quiet: [], // rects where the letter field and motes stay out (the arena)
  motes: [],
  shakeX: 0,
  shakeY: 0,
  overReady: false,
  overAt: null,
};
window.ember = G; // handy for poking at from the console (and for the smoke test)

const fill = (str) => str.replaceAll("{name}", G.foe?.name ?? "");

function setScene(name) {
  G.scene = name;
  G.sceneT = 0;
}

// Drifting motes for the ASCII view: o*o clusters and snow.
for (let i = 0; i < 30; i++) {
  const big = Math.random() < 0.3;
  G.motes.push({ x: rand(0, W), y: rand(0, H), vy: rand(0.08, 0.25), ph: rand(0, TAU), ch: big ? "o*o" : Math.random() < 0.5 ? "*" : ".", color: Math.random() < 0.5 ? C.ink : C.dim });
}

// Stars stay above the creature's name and out of the header corners, so
// none of them sit next to a word and read as punctuation.
while (G.stars.length < 40) {
  const x = snap(rand(0, W));
  const y = snap(rand(0, 148));
  if ((x < 180 && y < 90) || (x > 290 && y < 72)) continue;
  G.stars.push({ x, y, tw: rand(0, TAU), bright: Math.random() < 0.25 });
}

function tweenBox() {
  const b = G.box;
  const t = G.boxTarget;
  for (const k of ["x", "y", "w", "h"]) {
    b[k] = lerp(b[k], t[k], 0.2);
    if (Math.abs(b[k] - t[k]) < 0.5) b[k] = t[k];
  }
}
const boxSettled = () => ["x", "y", "w", "h"].every((k) => G.box[k] === G.boxTarget[k]);

const optionRect = (i, n) => ({ x: 20 + (i * 440) / n, y: OPT_Y - 28, w: 440 / n, h: 56 });
function optionAt(p, n) {
  for (let i = 0; i < n; i++) if (inRect(p, optionRect(i, n))) return i;
  return -1;
}

/* ----------------------------------------------------------------------- */
/* Title & intro                                                           */
/* ----------------------------------------------------------------------- */
const TITLE_OPTS = ["continue", "start over"];
const titleRect = (i) => ({ x: 140, y: 262 + i * 30, w: 200, h: 28 });

function startTitle() {
  setScene("title");
  G.dialog = null;
  G.fade = 1;
  G.titleSel = 0;
  G.confirmReset = false;
  say(S.started ? "ember. continue, or start over." : "ember. a very small game. press z or tap to begin.");
}

function updateTitle() {
  if (G.sceneT < 10) return;
  if (!S.started) {
    if (confirmed()) {
      sfx.select();
      startIntro();
    }
    return;
  }
  if (G.confirmReset) {
    const tappedYes = taps.some((p) => inRect(p, titleRect(1)));
    if (pressed.has("confirm") || tappedYes) {
      S = newSave();
      G.save = S;
      persist();
      sfx.select();
      startIntro();
    } else if (pressed.has("cancel") || taps.length) {
      G.confirmReset = false;
      sfx.back();
    }
    return;
  }
  if (pressed.has("up") || pressed.has("down")) {
    G.titleSel = 1 - G.titleSel;
    sfx.move();
    say(TITLE_OPTS[G.titleSel]);
  }
  let pick = pressed.has("confirm") ? G.titleSel : -1;
  for (const p of taps) {
    if (inRect(p, titleRect(0))) pick = 0;
    else if (inRect(p, titleRect(1))) pick = 1;
  }
  if (pick === 0) {
    sfx.select();
    goHub(G.awayMsg || "you keep walking.");
    G.awayMsg = null;
  } else if (pick === 1) {
    G.titleSel = 1;
    G.confirmReset = true;
    sfx.nope();
    say("start over? your warmth and friends will be gone. press z to confirm or x to cancel.");
  }
}

function startIntro() {
  setScene("intro");
  G.dialog = new Typer(["the path ahead is dark.", "you are a small light.", "keep walking. you won't be alone for long."], {
    onDone: () => {
      S.started = true;
      persist();
      goHub("you start walking.");
    },
  });
}

function updateIntro() {
  G.dialog.update();
  if (confirmed()) G.dialog.advance();
}

/* ----------------------------------------------------------------------- */
/* The path (hub): walking, the campfire, friends                          */
/* ----------------------------------------------------------------------- */
function goHub(msg) {
  setScene("hub");
  G.fade = 1;
  G.foe = null;
  G.bubble = null;
  G.bullets = [];
  G.hubPhase = "walk";
  G.box = { ...HUB_BOX };
  G.boxTarget = { ...HUB_BOX };
  G.hubSel = arrived() ? 0 : 1;
  G.arrivedShown = arrived();
  G.dialog = new Typer(arrived() ? `${msg} something is waiting on the path ahead.` : msg);
}

function updateHub() {
  tweenBox();
  G.dialog?.update();
  if (!arrived()) {
    S.dist = Math.min(S.nextAt, S.dist + walkSpeed() / 60);
    G.walkT++;
    if (G.t % 50 === 0 && G.hubPhase === "walk") {
      G.particles.push({ x: WALK_X + rand(-3, 3), y: GROUND - 22, vx: rand(-0.1, 0.1), vy: -0.35, g: 0, life: 60, age: 0, size: 2, color: C.ember });
    }
  }
  if (arrived() && !G.arrivedShown) {
    G.arrivedShown = true;
    sfx.calm();
    if (G.hubPhase === "walk") {
      G.hubSel = 0;
      G.dialog = new Typer("something is waiting on the path ahead.");
    }
  }
  if (G.campFlash && --G.campFlash.t <= 0) G.campFlash = null;
  if (G.hubPhase === "camp") return updateCamp();
  if (G.hubPhase === "friends") return updateFriends();
  return updateWalk();
}

function updateWalk() {
  if (pressed.has("left") || pressed.has("right")) {
    G.hubSel = (G.hubSel + (pressed.has("left") ? 2 : 1)) % 3;
    sfx.move();
    say(HUB_OPTS[G.hubSel]);
  }
  if (pressed.has("confirm")) return hubChoose(G.hubSel);
  for (const p of taps) {
    const i = optionAt(p, 3);
    if (i >= 0) {
      G.hubSel = i;
      return hubChoose(i);
    }
    if (G.dialog && !G.dialog.full) G.dialog.n = G.dialog.text.length;
  }
}

function hubChoose(i) {
  if (i === 0) {
    if (!arrived()) {
      sfx.nope();
      G.dialog = new Typer(`nothing yet. ${Math.ceil(S.nextAt - S.dist)} m to go.`);
      return;
    }
    sfx.select();
    startBattle();
  } else {
    sfx.select();
    G.hubPhase = i === 1 ? "camp" : "friends";
    G.boxTarget = { ...PANEL_BOX };
    say(i === 1 ? "campfire. spend warmth on upgrades." : "friends following you.");
  }
}

function leavePanel() {
  sfx.back();
  G.hubPhase = "walk";
  G.boxTarget = { ...HUB_BOX };
}

const campRow = (i) => ({ x: PANEL_BOX.x, y: PANEL_BOX.y + 8 + i * 40, w: PANEL_BOX.w, h: 40 });

function updateCamp() {
  if (pressed.has("cancel")) return leavePanel();
  if (pressed.has("up") || pressed.has("down")) {
    G.campSel = (G.campSel + (pressed.has("up") ? UPGRADES.length - 1 : 1)) % UPGRADES.length;
    sfx.move();
    const u = UPGRADES[G.campSel];
    say(`${u.label}, ${u.desc}, costs ${fmt(upgradeCost(u))} warmth`);
  }
  if (pressed.has("confirm")) return buy(G.campSel);
  for (const p of taps) {
    for (let i = 0; i < UPGRADES.length; i++) {
      if (inRect(p, campRow(i))) {
        G.campSel = i;
        return buy(i);
      }
    }
    const o = optionAt(p, 3);
    if (o === 1) return leavePanel();
    if (o >= 0) {
      G.hubSel = o;
      return hubChoose(o);
    }
  }
}

function buy(i) {
  const u = UPGRADES[i];
  const cost = upgradeCost(u);
  if (lvl(u.id) >= u.max || S.warmth < cost) {
    sfx.nope();
    G.campFlash = { i, t: 24, ok: false };
    say(lvl(u.id) >= u.max ? `${u.label} is maxed out` : `not enough warmth for ${u.label}`);
    return;
  }
  S.warmth -= cost;
  S.up[u.id] = lvl(u.id) + 1;
  sfx.buy();
  G.campFlash = { i, t: 24, ok: true };
  persist();
  say(`${u.label} is now level ${lvl(u.id)}`);
}

function updateFriends() {
  if (pressed.has("cancel") || pressed.has("confirm")) return leavePanel();
  for (const p of taps) {
    const o = optionAt(p, 3);
    if (o === 2 || o < 0) return leavePanel();
    G.hubSel = o;
    return hubChoose(o);
  }
}

/* ----------------------------------------------------------------------- */
/* Battle                                                                  */
/* ----------------------------------------------------------------------- */
function startBattle() {
  setScene("battle");
  const f = newFoe(S.met);
  Object.assign(G, {
    foe: f,
    maxHp: 20 + 4 * lvl("hp"),
    mends: 3 + lvl("mend"),
    dimmed: 0, turn: 0, menu: 0, act: 0, lastAct: null,
    bulletKind: f.sp.bullet,
    bullets: [], floaters: [],
    bubble: null, strike: null, slash: null, pattern: null,
    box: { ...MENU_BOX }, boxTarget: { ...MENU_BOX }, fade: 1,
  });
  G.hp = G.maxHp;
  toMenu(fill(f.sp.intro));
}

function toMenu(flavorText) {
  G.phase = "menu";
  G.boxTarget = { ...MENU_BOX };
  G.dialog = new Typer(flavorText);
}

function updateBattle() {
  updateFoe(G.foe);
  tweenBox();
  if (G.slash && ++G.slash.t > 26) G.slash = null;
  switch (G.phase) {
    case "menu": G.dialog?.update(); return updateMenu();
    case "talk": return updateTalk();
    case "strike": return updateStrike();
    case "result": G.dialog?.update(); return updateResult();
    case "enemy": return updateEnemy();
    case "dodge": return updateDodge();
  }
}

const menuLabel = (i) => (i === 2 ? `mend, ${G.mends} left` : MENU[i]);

function updateMenu() {
  if (pressed.has("left") || pressed.has("right")) {
    G.menu = (G.menu + (pressed.has("left") ? 3 : 1)) % MENU.length;
    sfx.move();
    say(menuLabel(G.menu));
  }
  if (pressed.has("confirm")) return choose(G.menu);
  for (const p of taps) {
    const i = optionAt(p, 4);
    if (i >= 0) {
      G.menu = i;
      return choose(i);
    }
    if (G.dialog && !G.dialog.full) G.dialog.n = G.dialog.text.length;
  }
}

function choose(i) {
  if (i === 0) {
    sfx.select();
    G.phase = "strike";
    G.strike = { x: 0, stopped: false, hold: 0, acc: 0, dmg: 0 };
    say("strike. press z or tap as the line crosses the center.");
  } else if (i === 1) {
    sfx.select();
    G.phase = "talk";
    G.act = 0;
    say(`talk. ${G.foe.sp.acts.map((a) => a.label).join(", ")}.`);
  } else if (i === 2) {
    mend();
  } else {
    part();
  }
}

function result(lines, after = enemyTurn) {
  G.phase = "result";
  G.dialog = new Typer(lines, { onDone: after });
}

function updateResult() {
  if (confirmed()) G.dialog.advance();
}

/* --- talk ---------------------------------------------------------------- */
function actRect(i) {
  const col = i % 2;
  const row = i >> 1;
  return { x: MENU_BOX.x + 48 + col * 200, y: MENU_BOX.y + 30 + row * 40 };
}
function actAt(p) {
  for (let i = 0; i < 4; i++) {
    const r = actRect(i);
    if (p.x >= r.x - 30 && p.x < r.x + 170 && p.y >= r.y - 10 && p.y < r.y + 30) return i;
  }
  return -1;
}
function actSpent(i) {
  const a = G.foe.sp.acts[i];
  return Boolean(a.max) && G.foe.uses[i] >= a.max;
}

function updateTalk() {
  if (pressed.has("cancel")) {
    sfx.back();
    G.phase = "menu";
    return;
  }
  const col = G.act % 2;
  const row = G.act >> 1;
  let next = G.act;
  if (pressed.has("left") || pressed.has("right")) next = row * 2 + (1 - col);
  if (pressed.has("up") || pressed.has("down")) next = (1 - row) * 2 + col;
  if (next !== G.act) {
    G.act = next;
    sfx.move();
    say(G.foe.sp.acts[G.act].label);
  }
  if (pressed.has("confirm")) return doAct(G.act);
  for (const p of taps) {
    const i = actAt(p);
    if (i >= 0) {
      G.act = i;
      return doAct(i);
    }
    const o = optionAt(p, 4);
    if (o === 1) {
      sfx.back();
      G.phase = "menu";
      return;
    }
    if (o >= 0) {
      G.menu = o;
      G.phase = "menu";
      return choose(o);
    }
  }
}

function doAct(i) {
  sfx.select();
  const f = G.foe;
  const a = f.sp.acts[i];
  const before = f.calm;
  let lines;
  if (!a.gain && !a.need) {
    lines = a.lines[0];
    G.lastAct = { kind: "check" };
  } else if (a.max && f.uses[i] >= a.max) {
    lines = [a.spent];
    G.lastAct = null;
  } else if (a.need && f.calm < a.need) {
    f.calm += a.failGain || 0;
    lines = a.fail;
    G.lastAct = { kind: "fail", i };
  } else {
    const use = f.uses[i]++;
    f.calm += a.gain + 5 * lvl("glow");
    lines = a.lines[Math.min(use, a.lines.length - 1)];
    if (a.dims) G.dimmed = f.uses[i];
    G.lastAct = { kind: "act", i, use };
  }
  f.calm = Math.min(100, f.calm);
  lines = lines.map(fill);
  if (before < 100 && f.calm >= 100) {
    lines.push(fill(f.sp.calmed));
    sfx.calm();
  }
  result(lines);
}

/* --- mend & part --------------------------------------------------------- */
function mend() {
  if (G.mends <= 0) {
    sfx.nope();
    G.dialog = new Typer("you have nothing left to mend with.");
    return;
  }
  if (G.hp >= G.maxHp) {
    sfx.nope();
    G.dialog = new Typer("you're already burning bright.");
    return;
  }
  const amount = Math.min(Math.round(G.maxHp / 2), G.maxHp - G.hp);
  G.hp += amount;
  G.mends--;
  G.lastAct = { kind: "mend" };
  sfx.heal();
  G.floaters.push({ x: 196, y: HUD_Y - 28, text: `+${amount}`, t: 0, color: C.ember });
  const lines = [`you gather yourself and burn a little brighter. +${amount} hp.`];
  if (G.mends === 0) lines.push("that was the last of it.");
  result(lines);
}

function part() {
  sfx.select();
  if (G.foe.calm >= 100) return spareFoe();
  G.lastAct = { kind: "part" };
  result(["you try to slip away.", fill("{name} won't let you go that easily.")]);
}

function spareFoe() {
  const f = G.foe;
  const rate = Math.round(f.sp.rate * rewardMult(f.night) * 10) / 10;
  f.spared = true;
  sfx.warm();
  result([...f.sp.spare.map(fill), `+${fmtRate(rate)} warmth / s, for as long as it follows you.`], () => {
    S.friends.push({ key: f.key, name: f.name, rate });
    finishEncounter(`${f.name} follows your light.`);
  });
}

function finishEncounter(msg) {
  S.met++;
  S.prevAt = S.nextAt;
  S.nextAt = Math.round(S.dist + encounterGap());
  persist();
  goHub(msg);
}

/* --- strike -------------------------------------------------------------- */
const strikeTicks = () => 66 * (1 + 0.15 * lvl("hand"));

function updateStrike() {
  const s = G.strike;
  if (!s.stopped) {
    if (pressed.has("cancel") && s.x < 0.25) {
      sfx.back();
      G.phase = "menu";
      G.strike = null;
      return;
    }
    s.x += 1 / strikeTicks();
    if (confirmed()) {
      s.stopped = true;
      s.acc = 1 - Math.abs(s.x - 0.5) * 2;
    } else if (s.x >= 1) {
      s.x = 1;
      s.stopped = true;
      s.acc = -1;
    }
    if (s.stopped) {
      if (s.acc < 0) sfx.nope();
      else {
        sfx.slash();
        G.slash = { t: 0 };
      }
    }
    return;
  }
  s.hold++;
  if (s.hold === 14 && s.acc >= 0) landStrike(s);
  if (s.hold === 56) strikeResult(s);
}

function landStrike(s) {
  const f = G.foe;
  const crit = s.acc > 0.93;
  s.dmg = crit ? 24 : Math.max(4, Math.round(4 + 16 * Math.pow(s.acc, 1.4)));
  f.hp = Math.max(0, f.hp - s.dmg);
  f.shake = 14;
  f.flash = 10;
  f.barT = 110;
  f.struck++;
  f.calm = Math.max(0, f.calm - 30);
  const { x, y } = foePose(f);
  G.floaters.push({ x, y: y - 66, text: crit ? `${s.dmg}!` : `${s.dmg}`, t: 0, color: C.ink, scale: 2 });
  sfx.hit();
  if (!REDUCED) G.shake = 4;
}

function strikeResult(s) {
  const f = G.foe;
  G.strike = null;
  if (s.acc < 0) {
    G.lastAct = { kind: "miss" };
    return result(["you swing at the dark and miss."]);
  }
  G.lastAct = { kind: "strike" };
  if (f.hp <= 0) {
    f.dead = true;
    dissolveFoe();
    const burst = Math.round(f.sp.burst * rewardMult(f.night));
    return result([...f.sp.fall, `its warmth is yours now. +${burst} warmth.`], () => {
      gain(burst);
      S.struck++;
      finishEncounter("the path is quiet now.");
    });
  }
  if (f.struck === 1) return result([`you strike ${f.name}.`, "it panics."]);
  if (f.hp < f.max * 0.4) return result(["you strike again.", fill(f.sp.hurt)]);
  return result([`you strike ${f.name}.`]);
}

/* --- the creature's turn ------------------------------------------------- */
function foeLine() {
  const f = G.foe;
  const sp = f.sp;
  const a = G.lastAct;
  if (f.calm >= 100) return sp.restSay;
  if (a?.kind === "strike") return sp.strikeSay[Math.min(f.struck, sp.strikeSay.length) - 1];
  if (a?.kind === "miss") return sp.missSay;
  if (a?.kind === "part") return sp.partSay;
  if (a?.kind === "fail") return sp.acts[a.i].failSay;
  if (a?.kind === "act") {
    const says = sp.acts[a.i].say;
    if (says) return says[Math.min(a.use, says.length - 1)];
  }
  const pool = sp.talk[f.calm < 30 ? 0 : f.calm < 70 ? 1 : 2];
  return pool[G.turn % pool.length];
}

function flavor() {
  const f = G.foe;
  if (G.hp <= Math.max(6, G.maxHp * 0.3)) return "your glow flickers.";
  if (f.hp < f.max * 0.4) return fill(f.sp.hurt);
  const pool = f.sp.flavor[f.calm < 30 ? 0 : f.calm < 70 ? 1 : 2];
  return fill(pool[G.turn % pool.length]);
}

function enemyTurn() {
  const f = G.foe;
  G.turn++;
  G.phase = "enemy";
  G.dialog = null;
  const resting = f.calm >= 100;
  if (!resting) {
    G.pattern = f.calm >= 70 ? "drift" : f.sp.patterns[(G.turn - 1) % f.sp.patterns.length];
    const p = PATTERNS[G.pattern];
    const a = { x: 240 - p.w / 2, y: ARENA_CY - p.h / 2, w: p.w, h: p.h };
    G.boxTarget = a;
    G.player = { x: a.x + a.w / 2, y: p.start === "bottom" ? a.y + a.h - 22 : a.y + a.h / 2, inv: 0 };
  }
  G.bubble = new Typer(fill(foeLine()), {
    voice: "foe",
    auto: 80,
    onDone: () => {
      G.bubble = null;
      if (resting) toMenu(fill(f.sp.resting));
      else startDodge();
    },
  });
}

function updateEnemy() {
  G.bubble?.update();
  if (confirmed()) G.bubble?.advance();
}

/* --- dodging ------------------------------------------------------------- */
function intensity() {
  const f = G.foe;
  const calm = clamp(1 - f.calm / 140, 0.35, 1);
  const anger = 1 + Math.min(f.struck, 3) * 0.1;
  const ramp = lerp(0.78, 1, Math.min(G.turn - 1, 4) / 4);
  const later = Math.min(1.5, 1 + 0.12 * (f.night - 1));
  return calm * anger * ramp * later;
}

function startDodge() {
  G.phase = "dodge";
  G.k = intensity();
  G.patT = -1; // wait for the box to finish resizing
  G.bullets = [];
  G.ps = {};
  drag.dx = 0;
  drag.dy = 0;
  say("dodge. arrow keys or drag to move.");
}

function updateDodge() {
  const p = PATTERNS[G.pattern];
  const a = G.box;
  const pl = G.player;

  let mx = 0;
  let my = 0;
  if (held.has("left")) mx -= 1;
  if (held.has("right")) mx += 1;
  if (held.has("up")) my -= 1;
  if (held.has("down")) my += 1;
  if (mx && my) {
    mx *= Math.SQRT1_2;
    my *= Math.SQRT1_2;
  }
  const speed = held.has("cancel") ? 1.2 : 2.4; // hold x / shift to move carefully
  pl.x = clamp(pl.x + mx * speed + drag.dx, a.x + 14, a.x + a.w - 14);
  pl.y = clamp(pl.y + my * speed + drag.dy, a.y + 14, a.y + a.h - 14);
  drag.dx = 0;
  drag.dy = 0;
  if (pl.inv > 0) pl.inv--;

  if (G.patT < 0) {
    if (!boxSettled()) return;
    G.patT = 0;
  }
  const t = G.patT++;
  if (t < p.dur) p.update(t, G.boxTarget, G.k);
  updateBullets(G.boxTarget);

  if (pl.inv === 0) {
    for (const b of G.bullets) {
      if (b.fade || b.harmless || b.age < 6) continue;
      const r = b.r * 0.8 + 3;
      if ((b.x - pl.x) ** 2 + (b.y - pl.y) ** 2 < r * r) {
        hurt();
        break;
      }
    }
  }

  if (G.scene === "battle" && t >= p.dur) {
    for (const b of G.bullets) b.fade ||= 1;
    if (t >= p.dur + 24) {
      G.bullets = [];
      toMenu(flavor());
    }
  }
}

function hurt() {
  const f = G.foe;
  G.hp = Math.max(0, G.hp - (3 + (f.struck >= 2 ? 1 : 0) + (f.night - 1)));
  G.player.inv = 50;
  sfx.hurt();
  if (!REDUCED) G.shake = 5;
  if (G.hp <= 0) gameOver();
}
G.debug = { hurt: () => hurt() };

function spawn(x, y, vx, vy, r = 4, extra = {}) {
  const b = { x, y, vx, vy, r, age: 0, fade: 0, kind: G.bulletKind, ...extra };
  G.bullets.push(b);
  return b;
}

function updateBullets(a) {
  for (const b of G.bullets) {
    b.age++;
    if (b.step) b.step(b);
    else {
      b.x += b.vx;
      b.y += b.vy;
    }
    if (b.sway) b.x += Math.sin(b.age * 0.06 + b.sway) * b.swayAmp;
    if (b.fade) b.fade++;
    else if (b.life && b.age > b.life) b.fade = 1;
  }
  const m = 160;
  G.bullets = G.bullets.filter((b) =>
    !b.dead && b.fade < 20 &&
    b.x > a.x - m && b.x < a.x + a.w + m && b.y > a.y - m && b.y < a.y + a.h + m);
}

// A point just outside one edge of the arena, at least `minDist` from the player.
function edgePoint(a, minDist) {
  let pt;
  for (let tries = 0; tries < 8; tries++) {
    const side = (Math.random() * 4) | 0;
    pt = side === 0 ? { x: rand(a.x, a.x + a.w), y: a.y - 10 }
      : side === 1 ? { x: a.x + a.w + 10, y: rand(a.y, a.y + a.h) }
        : side === 2 ? { x: rand(a.x, a.x + a.w), y: a.y + a.h + 10 }
          : { x: a.x - 10, y: rand(a.y, a.y + a.h) };
    if (Math.hypot(pt.x - G.player.x, pt.y - G.player.y) >= minDist) break;
  }
  return pt;
}

function homing(b) {
  const p = G.player;
  let heading = Math.atan2(b.vy, b.vx);
  let d = Math.atan2(p.y - b.y, p.x - b.x) - heading;
  d = Math.atan2(Math.sin(d), Math.cos(d));
  heading += clamp(d, -0.03, 0.03);
  b.vx = Math.cos(heading) * b.sp;
  b.vy = Math.sin(heading) * b.sp;
  b.x += b.vx;
  b.y += b.vy;
}

function ringStep(b) {
  b.rad -= b.sp;
  b.ang += b.spin;
  b.x = b.cx + Math.cos(b.ang) * b.rad;
  b.y = b.cy + Math.sin(b.ang) * b.rad;
  if (b.rad < 6) b.dead = true;
}

function zigStep(b) {
  b.x += b.vx;
  b.y = b.y0 + Math.sin(b.age * 0.08 + b.ph) * b.amp;
}

// A warning flash that bursts into sparks after 40 ticks.
function flashStep(b) {
  if (b.age < 40) return;
  const n = 10;
  const sp = 1.4 + 0.5 * b.k;
  const off = rand(0, TAU);
  for (let i = 0; i < n; i++) {
    const ang = off + (i * TAU) / n;
    spawn(b.x, b.y, Math.cos(ang) * sp, Math.sin(ang) * sp, 3.5, { kind: "spark" });
  }
  b.dead = true;
}

// Icicles hang and glint for a moment, then drop.
function icicleStep(b) {
  if (b.age < 26) return;
  b.harmless = false;
  b.vy = Math.min(4.5, (b.vy || 0.4) + 0.12 * (0.8 + 0.4 * b.k));
  b.y += b.vy;
}

// Walls of dust crossing the arena from alternating sides, each with one gap.
function wall(t, a, k, every, gapH, speed) {
  if (t % every) return;
  const fromLeft = Math.round(t / every) % 2 === 0;
  const gapY = rand(a.y + 10, a.y + a.h - 10 - gapH);
  const vx = (fromLeft ? 1 : -1) * speed;
  const x = fromLeft ? a.x - 8 : a.x + a.w + 8;
  for (let y = a.y + 6; y < a.y + a.h; y += 12) {
    if (y > gapY && y < gapY + gapH) continue;
    spawn(x, y, vx, 0, 4);
  }
}

// Each attack: arena size, length in ticks, and a spawner run once per tick.
// `a` is the arena rect, `k` the intensity (≈0.35 when calm … ≈1.3 when hurt).
const PATTERNS = {
  dustfall: {
    w: 200, h: 140, dur: 330,
    update(t, a, k) {
      if (t % Math.max(5, Math.round(8 / k))) return;
      spawn(rand(a.x + 6, a.x + a.w - 6), a.y - 6, 0, rand(1.1, 1.8) * (0.7 + 0.3 * k), rand(3, 4.5), {
        sway: rand(0.1, TAU), swayAmp: rand(0.2, 0.7),
      });
    },
  },
  gust: {
    w: 280, h: 120, dur: 360,
    update(t, a, k) { wall(t, a, k, Math.round(64 / Math.sqrt(k)), 46, 1.9 + 0.9 * k); },
  },
  swoop: {
    w: 280, h: 130, dur: 360,
    update(t, a, k) { wall(t, a, k, Math.round(78 / Math.sqrt(k)), 54, 2.4 + 1.0 * k); },
  },
  moths: {
    w: 220, h: 150, dur: 360,
    update(t, a, k) {
      if (t % Math.round(50 / k)) return;
      if (G.bullets.filter((b) => b.kind === "moth" && !b.fade).length >= 4) return;
      const pt = edgePoint(a, 80);
      const sp = 0.9 + 0.6 * k;
      const ang = Math.atan2(G.player.y - pt.y, G.player.x - pt.x);
      spawn(pt.x, pt.y, Math.cos(ang) * sp, Math.sin(ang) * sp, 5, { kind: "moth", life: 230, sp, step: homing });
    },
  },
  spiral: {
    w: 160, h: 160, dur: 340, start: "bottom",
    update(t, a, k) {
      const every = Math.max(4, Math.round(7 / k));
      if (t % every) return;
      G.ps.theta = (G.ps.theta ?? rand(0, TAU)) + 0.022 * every * (t < 170 ? 1 : -1);
      const cx = a.x + a.w / 2;
      const cy = a.y + a.h / 2;
      const sp = 1.1 + 0.5 * k;
      for (let i = 0; i < 3; i++) {
        const ang = G.ps.theta + (i * TAU) / 3;
        spawn(cx + Math.cos(ang) * 8, cy + Math.sin(ang) * 8, Math.cos(ang) * sp, Math.sin(ang) * sp, 3.5);
      }
    },
  },
  ring: {
    w: 160, h: 160, dur: 330,
    update(t, a, k) {
      if (t % Math.round(96 / Math.sqrt(k))) return;
      const cx = a.x + a.w / 2;
      const cy = a.y + a.h / 2;
      const n = 22;
      const gap = 4;
      const start = (Math.random() * n) | 0;
      const off = rand(0, TAU);
      const spin = (Math.random() < 0.5 ? -1 : 1) * 0.004 * k;
      const sp = 0.9 + 0.5 * k;
      for (let i = 0; i < n; i++) {
        if ((i - start + n) % n < gap) continue;
        spawn(cx, cy, 0, 0, 4, { cx, cy, rad: 150, ang: off + (i * TAU) / n, spin, sp, step: ringStep });
      }
    },
  },
  zigzag: {
    w: 240, h: 140, dur: 340,
    update(t, a, k) {
      if (t % Math.max(8, Math.round(24 / k))) return;
      const fromLeft = Math.random() < 0.5;
      const y0 = rand(a.y + 24, a.y + a.h - 24);
      const vx = (1.3 + 0.6 * k) * (fromLeft ? 1 : -1);
      spawn(fromLeft ? a.x - 8 : a.x + a.w + 8, y0, vx, 0, 4, { kind: "fly", y0, ph: rand(0, TAU), amp: rand(14, 24), step: zigStep });
    },
  },
  burst: {
    w: 200, h: 160, dur: 320,
    update(t, a, k) {
      if (t % Math.round(56 / k)) return;
      let x = 0;
      let y = 0;
      for (let i = 0; i < 8; i++) {
        x = rand(a.x + 24, a.x + a.w - 24);
        y = rand(a.y + 24, a.y + a.h - 24);
        if (Math.hypot(x - G.player.x, y - G.player.y) > 56) break;
      }
      spawn(x, y, 0, 0, 10, { kind: "flash", harmless: true, k, step: flashStep });
    },
  },
  feathers: {
    w: 220, h: 140, dur: 330,
    update(t, a, k) {
      if (t % Math.max(6, Math.round(11 / k))) return;
      spawn(rand(a.x + 6, a.x + a.w - 6), a.y - 8, 0, rand(0.8, 1.3) * (0.7 + 0.3 * k), 4, {
        kind: "feather", sway: rand(0.1, TAU), swayAmp: rand(0.6, 1.2),
      });
    },
  },
  // Frost drips from the dragon's horns.
  icicles: {
    w: 220, h: 140, dur: 330,
    update(t, a, k) {
      if (t % Math.max(8, Math.round(18 / k))) return;
      spawn(rand(a.x + 18, a.x + a.w - 18), a.y + 16, 0, 0, 4, { kind: "icicle", harmless: true, step: icicleStep, k });
    },
  },
  // Frost breath sweeps one side of the arena, then the other.
  breath: {
    w: 220, h: 150, dur: 360,
    update(t, a, k) {
      const phase = t % 100;
      if (phase > 60 || t % 3) return;
      G.ps.flip = G.ps.flip ?? (Math.random() < 0.5 ? 0 : 1);
      const side = (Math.floor(t / 100) + G.ps.flip) % 2 ? 1 : -1;
      const ang = Math.PI / 2 + side * 0.55 + Math.sin(phase * 0.08) * 0.35;
      const sp = 2 + 0.6 * k;
      const cx = a.x + a.w / 2;
      spawn(cx + Math.cos(ang) * 10, a.y + 12, Math.cos(ang) * sp, Math.sin(ang) * sp, 3.5, { kind: "shard" });
    },
  },
  // A tired creature barely tries.
  drift: {
    w: 200, h: 130, dur: 270,
    update(t, a) {
      if (t % 16) return;
      const pt = edgePoint(a, 60);
      const ang = Math.atan2(rand(a.y + 20, a.y + a.h - 20) - pt.y, rand(a.x + 20, a.x + a.w - 20) - pt.x);
      const sp = rand(0.55, 0.9);
      spawn(pt.x, pt.y, Math.cos(ang) * sp, Math.sin(ang) * sp, rand(3, 4));
    },
  },
};

/* ----------------------------------------------------------------------- */
/* Losing                                                                  */
/* ----------------------------------------------------------------------- */
function gameOver() {
  const { x, y } = G.player;
  setScene("over");
  G.overAt = { x, y };
  G.overReady = false;
  G.dialog = null;
  G.bubble = null;
  G.bullets = [];
  sfx.out();
  for (let i = 0; i < 46; i++) {
    const a = rand(0, TAU);
    const s = rand(0.4, 2.6);
    G.particles.push({ x, y, vx: Math.cos(a) * s, vy: Math.sin(a) * s - 0.6, g: 0.03, life: rand(50, 100), age: 0, size: 2, color: C.ember });
  }
}

function updateOver() {
  if (G.sceneT === 80) {
    G.dialog = new Typer(["your light goes out.", "a while later, you wake up beside the campfire."], {
      onDone: () => {
        G.overReady = true;
        say("press z or tap to keep going.");
      },
    });
  }
  if (!G.dialog) return;
  G.dialog.update();
  if (G.overReady && confirmed()) {
    sfx.select();
    goHub("the path ahead is still waiting.");
  } else if (confirmed()) {
    G.dialog.advance();
  }
}

/* ----------------------------------------------------------------------- */
/* Effects                                                                 */
/* ----------------------------------------------------------------------- */
function updateFoe(f) {
  const [fast, slow] = f.sp.flap;
  f.phase += lerp(fast, slow, f.calm / 100) * (REDUCED ? 0.6 : 1);
  if (f.shake > 0) f.shake -= 0.5;
  if (f.flash > 0) f.flash--;
  if (f.barT > 0) f.barT--;
  f.shown = lerp(f.shown, f.hp, 0.08);
  if (f.dead) f.alpha = Math.max(0, f.alpha - 0.03);
  if (f.spared) f.alpha = Math.max(0.45, f.alpha - 0.01);
}

// Where the creature is right now: frantic ones jitter, calm ones sink and drift.
function foePose(f) {
  const calm = f.calm / 100;
  const frantic = (1 - calm) * (REDUCED ? 0.3 : 1) * f.sp.jitter;
  let x = f.x + Math.sin(G.t * 0.017) * 8 * frantic + Math.sin(G.t * 0.13) * 2.5 * frantic * frantic;
  const y = f.y + Math.sin(G.t * 0.045) * 4 * f.sp.bob + calm * 8 * Math.min(1, f.sp.bob);
  if (f.shake > 0) x += Math.sin(f.shake * 2.2) * f.shake * 0.5;
  const blinkSpeed = lerp(0.35, 0.07, calm);
  return {
    x, y,
    flap: 0.3 + 0.7 * Math.abs(Math.cos(f.phase)),
    lit: f.calm >= 100 || Math.sin(G.t * blinkSpeed) > -0.3 ? 1 : 0,
    blink: G.t % 190 < 7,
  };
}

function dissolveFoe() {
  const { x, y } = foePose(G.foe);
  for (let i = 0; i < 120; i++) {
    const a = rand(0, TAU);
    const r = Math.sqrt(Math.random());
    G.particles.push({
      x: x + Math.cos(a) * r * 60, y: y + Math.sin(a) * r * 38,
      vx: rand(-0.25, 0.25), vy: rand(-0.7, -0.1), g: -0.002,
      life: rand(70, 160), age: 0, size: 2, color: C.ink,
    });
  }
}

function updateAmbient() {
  if (!REDUCED) {
    for (const m of G.motes) {
      m.y += m.vy;
      m.x += Math.sin(G.t * 0.01 + m.ph) * 0.15;
      if (m.y > H + 6) {
        m.y = -6;
        m.x = rand(0, W);
      }
    }
  }
  for (const p of G.particles) {
    p.age++;
    p.vy += p.g;
    p.x += p.vx;
    p.y += p.vy;
  }
  G.particles = G.particles.filter((p) => p.age < p.life);
  for (const f of G.floaters) {
    f.t++;
    if (f.t < 24) f.y -= 0.6;
  }
  G.floaters = G.floaters.filter((f) => f.t < 80);
  if (G.shake > 0) G.shake = Math.max(0, G.shake - 0.4);
  if (G.fade > 0) G.fade = Math.max(0, G.fade - 1 / 30);
}

/* ----------------------------------------------------------------------- */
/* Drawing: characters                                                     */
/* ----------------------------------------------------------------------- */
const emberFrame = () => {
  if (REDUCED) return 0;
  const h = hash(Math.floor(G.t / 7));
  return h < 0.6 ? 0 : h < 0.8 ? 1 : 2;
};

// Your warm light, drawn under everything near you. It wavers by a pixel.
function emberGlow(x, y, glow = 1, scale = 1) {
  const r0 = Math.round(12 * glow * scale);
  if (r0 < 3) return;
  const r = REDUCED ? r0 : r0 + Math.round(hash(Math.floor(G.t / 6) + 0.3) * 2 - 1);
  drawGlow(x, y, r, [C.deep, C.warm]);
}

function drawEmber(x, y, { scale = 1, alpha = 1 } = {}) {
  drawBitmap(SPR.ember[emberFrame()], x, y, { color: C.ember, color2: C.core, scale, alpha, center: true });
}

const flapFrame = (phase) => [0, 1, 2, 1][Math.floor(phase / (Math.PI / 2)) & 3];
const dragonMood = (calm, blink) => (blink || calm >= 100 ? "asleep" : calm >= 70 ? "drowsy" : calm >= 30 ? "watch" : "glare");

function foeSprite(key, { frame = 0, lit = 1, mood = "watch", color = C.ink, k = 0.5 } = {}) {
  if (key === "moth") return baked(`moth|${frame}|${color}|${k}`, () => bakeMoth(frame, color, k));
  if (key === "firefly") return baked(`firefly|${frame}|${lit}|${color}|${k}`, () => bakeFirefly(frame, lit, color, k));
  return baked(`dragon|${frame}|${mood}|${color}|${k}`, () => bakeDragon(frame, mood, color, k));
}

function drawFoe(f) {
  const pose = foePose(f);
  const flashing = f.flash > 0 && (f.flash >> 1) % 2 === 0;
  const color = flashing ? C.ember : C.ink;
  const k = f.key === "firefly" ? 0.75 : f.key === "dragon" ? DRAGON_K : 0.5;
  if (f.key === "firefly" && pose.lit && f.alpha > 0.5) drawGlow(pose.x, pose.y + 21, 16, [C.moss]);
  const spr = foeSprite(f.key, { frame: flapFrame(f.phase), lit: pose.lit, mood: dragonMood(f.calm, pose.blink), color, k });
  drawSprite(spr, pose.x, pose.y, f.alpha);
  return pose;
}

// The next creature, small, waiting on the path ahead.
function drawAhead(key, x, color) {
  const frame = flapFrame(G.t * 0.25);
  const bob = Math.round(Math.sin(G.t * 0.05)) * PX;
  if (key === "moth") {
    drawSprite(foeSprite("moth", { frame, color, k: 0.25 }), x, GROUND - 46 + bob);
  } else if (key === "firefly") {
    const lit = Math.sin(G.t * 0.2) > 0 ? 1 : 0;
    const y = GROUND - 44 + bob;
    if (lit) drawGlow(x, y + 12, 8, [C.moss]);
    drawSprite(foeSprite("firefly", { frame, lit, color, k: 0.4 }), x, y);
  } else {
    drawSprite(foeSprite("dragon", { frame, mood: G.t % 190 < 7 ? "asleep" : "watch", color, k: 0.25 }), x, GROUND - 24);
  }
}

function drawMini(key, x, y, frame) {
  const rows = SPR[`${key}${frame ? "B" : "A"}`];
  if (key === "moth") drawBitmap(rows, x, y, { color: C.ink, color3: C.dim, center: true });
  else if (key === "firefly") drawBitmap(rows, x, y, { color: C.ink, color2: frame ? C.moss : C.glim, center: true });
  else drawBitmap(rows, x, y, { color: C.ink, color2: C.rune, color3: C.stone, center: true });
}

function bulletGlyph(b) {
  switch (b.kind) {
    case "spark": return ["+", C.core];
    case "fly": return ["*", Math.sin(b.age * 0.3) > -0.4 ? C.glim : C.dim];
    case "feather": {
      const tilt = Math.sin(b.age * 0.06 + b.sway);
      return [tilt < -0.35 ? "\\" : tilt > 0.35 ? "/" : "~", C.ink];
    }
    case "shard": return ["*", C.rune];
    case "icicle": return b.harmless ? ["!", (b.age >> 2) % 2 ? C.rune : C.ink] : ["V", C.ink];
    case "moth": return ["w", C.ink];
    case "flash": return (b.age >> 2) % 2 ? null : ["x", C.dim];
    default: return [b.r >= 4 ? "O" : "o", C.ink];
  }
}

function drawBullets() {
  if (G.view === "ascii") {
    for (const b of G.bullets) {
      const g = bulletGlyph(b);
      if (g) G.glyphs.push({ x: b.x, y: b.y, ch: g[0], color: g[1], size: 1.6, clip: G.arenaClip, alpha: b.fade ? 1 - b.fade / 20 : Math.min(1, b.age / 8) });
    }
    return;
  }
  for (const b of G.bullets) {
    const alpha = b.fade ? 1 - b.fade / 20 : Math.min(1, b.age / 8);
    const o = { center: true, alpha };
    if (b.kind === "moth") {
      drawBitmap(Math.floor(b.age / 6) % 2 ? SPR.bugB : SPR.bugA, b.x, b.y, { ...o, color3: C.dim });
    } else if (b.kind === "shard") {
      drawBitmap(SPR.shard, b.x, b.y, { ...o, color: C.ink, color2: C.rune });
    } else if (b.kind === "icicle") {
      const glint = b.harmless && (b.age >> 2) % 2 === 0;
      drawBitmap(SPR.icicle, b.x, b.y, { ...o, color: glint ? C.rune : C.ink, color2: C.rune });
    } else if (b.kind === "spark") {
      drawBitmap(SPR.spark, b.x, b.y, { ...o, color: C.ink, color2: C.core });
    } else if (b.kind === "fly") {
      const lit = Math.sin(b.age * 0.3) > -0.4;
      drawBitmap(SPR.fly, b.x, b.y, { ...o, color2: lit ? C.glim : C.dim });
      ctx.fillStyle = C.moss;
      ctx.fillRect(snap(b.x - b.vx * 4), snap(b.y), PX, PX);
    } else if (b.kind === "feather") {
      const tilt = Math.sin(b.age * 0.06 + b.sway);
      drawBitmap(tilt < -0.35 ? SPR.featherL : tilt > 0.35 ? SPR.featherR : SPR.featherF, b.x, b.y, o);
    } else if (b.kind === "flash") {
      if ((b.age >> 2) % 2 === 0) drawSprite(baked(`ring|${6 - (b.age >> 4)}`, () => bakeRing(6 - (b.age >> 4), C.dim)), b.x, b.y);
    } else {
      drawBitmap(b.r >= 4 ? SPR.dustL : SPR.dustS, b.x, b.y, o);
    }
  }
  ctx.globalAlpha = 1;
}

// A hard-edged line on the pixel grid, for the strike slash.
function pixelLine(x0, y0, x1, y1, color, thick = 1) {
  let ax = Math.floor(x0 / PX);
  let ay = Math.floor(y0 / PX);
  const bx = Math.floor(x1 / PX);
  const by = Math.floor(y1 / PX);
  const dx = Math.abs(bx - ax);
  const dy = -Math.abs(by - ay);
  const sx = ax < bx ? 1 : -1;
  const sy = ay < by ? 1 : -1;
  let err = dx + dy;
  ctx.fillStyle = color;
  for (;;) {
    ctx.fillRect(ax * PX, ay * PX, PX * thick, PX);
    if (ax === bx && ay === by) break;
    const e2 = 2 * err;
    if (e2 >= dy) {
      err += dy;
      ax += sx;
    }
    if (e2 <= dx) {
      err += dx;
      ay += sy;
    }
  }
}

function drawStars() {
  for (const s of G.stars) {
    let color = s.bright ? C.dim : C.faint;
    if (s.bright && !REDUCED && Math.sin(G.t * 0.03 + s.tw) > 0.94) color = C.ink;
    ctx.fillStyle = color;
    ctx.fillRect(s.x, s.y, PX, PX);
  }
}

/* ----------------------------------------------------------------------- */
/* Drawing: interface                                                      */
/* ----------------------------------------------------------------------- */
const pulse = (speed = 0.06) => (REDUCED ? 1 : 0.55 + 0.45 * Math.sin(G.t * speed));

// --- Runestone UI: carved stone panels, tablets, runes ----------------------
const fillPx = (x, y, w, h, c) => {
  ctx.fillStyle = c;
  ctx.fillRect(x, y, w, h);
};

// A few chips and scratches so no two stones look exactly alike.
function chips(x, y, w, h) {
  const seed = x * 0.37 + y * 0.11 + w * 0.05;
  for (let i = 0; i < Math.max(2, Math.floor(w / 60)); i++) {
    const cx = snap(x + 6 * PX + hash(seed + i) * (w - 14 * PX));
    fillPx(cx, y + 2 * PX, PX, PX, C.stoneD);
    fillPx(cx + PX, y + 3 * PX, PX, PX, C.stoneD);
    const cy = snap(y + 4 * PX + hash(seed + i + 9) * (h - 9 * PX));
    fillPx(x + w - 3 * PX, cy, PX, PX, C.stoneL);
  }
}

// A slab of carved stone: dark outline with the corners knocked off, a lit
// top-left bevel and a shadowed bottom-right. `window` cuts a dark opening
// into it, for the arena you dodge in.
function drawFrame(b, { window = false } = {}) {
  const x = snap(b.x);
  const y = snap(b.y);
  const w = snap(b.w);
  const h = snap(b.h);
  fillPx(x + PX, y, w - 2 * PX, PX, C.bg);
  fillPx(x + PX, y + h - PX, w - 2 * PX, PX, C.bg);
  fillPx(x, y + PX, PX, h - 2 * PX, C.bg);
  fillPx(x + w - PX, y + PX, PX, h - 2 * PX, C.bg);
  fillPx(x + PX, y + PX, w - 2 * PX, h - 2 * PX, C.stone);
  fillPx(x + PX, y + PX, w - 2 * PX, PX, C.stoneL);
  fillPx(x + PX, y + PX, PX, h - 2 * PX, C.stoneL);
  fillPx(x + PX, y + h - 2 * PX, w - 2 * PX, PX, C.stoneD);
  fillPx(x + w - 2 * PX, y + PX, PX, h - 2 * PX, C.stoneD);
  if (w > 20 * PX && h > 12 * PX) chips(x, y, w, h);
  if (window) {
    fillPx(x + 3 * PX, y + 3 * PX, w - 6 * PX, h - 6 * PX, C.stoneD);
    ctx.clearRect(x + 4 * PX, y + 4 * PX, w - 8 * PX, h - 8 * PX);
    G.quiet.push({ x: x + 4 * PX, y: y + 4 * PX, w: w - 8 * PX, h: h - 8 * PX });
    fillPx(x + 3 * PX, y + h - 4 * PX, w - 6 * PX, PX, C.stoneL);
    fillPx(x + w - 4 * PX, y + 3 * PX, PX, h - 6 * PX, C.stoneL);
  }
  return { x, y, w, h, inset: window ? 4 * PX : 2 * PX };
}

function outline(b, color) {
  fillPx(b.x + PX, b.y, b.w - 2 * PX, PX, color);
  fillPx(b.x + PX, b.y + b.h - PX, b.w - 2 * PX, PX, color);
  fillPx(b.x, b.y + PX, PX, b.h - 2 * PX, color);
  fillPx(b.x + b.w - PX, b.y + PX, PX, b.h - 2 * PX, color);
}

// Stone tablets with an icon and a carved label.
function drawOptionRow(labels, sel, active, { ready = [], off = [] } = {}) {
  labels.forEach((label, i) => {
    const r = optionRect(i, labels.length);
    const b = drawFrame({ x: r.x + 6, y: r.y, w: r.w - 12, h: r.h });
    const cx = b.x + b.w / 2;
    const isSel = active && sel === i;
    if (isSel) outline(b, C.rune);
    const dimmed = !active || (off[i] && !isSel);
    const iconColor = ready[i] || isSel ? C.ember : dimmed ? C.stoneL : C.dim;
    const labelColor = ready[i] ? C.ember : isSel ? C.ink : dimmed ? C.stoneL : C.dim;
    drawBitmap(ICON[label], cx, b.y + 19, { color: iconColor, center: true });
    text(label, cx, b.y + 34, { color: labelColor, align: "center", shadow: C.stoneD });
  });
}

// Snowy mountains standing behind whatever is at `ground`.
function drawMountains(ground, { scroll = 0, color = C.night } = {}) {
  const gp = ground / PX;
  for (let xp = 0; xp < BW; xp++) {
    const wx = xp + Math.floor(scroll);
    const tri = Math.abs((((wx + 17) % 64) + 64) % 64 - 32);
    const top = Math.round(gp - 30 + tri * 0.75 + Math.sin(wx * 0.11) * 2);
    fillPx(xp * PX, top * PX, PX, (gp - top) * PX, color);
    if (top < gp - 20) fillPx(xp * PX, top * PX, PX, Math.max(1, Math.round((gp - 20 - top) * 0.35)) * PX, C.ink);
  }
}

function drawSnowLine(y) {
  fillPx(0, y, W, 3 * PX, C.ink);
  for (let xp = 0; xp < BW; xp++) if (hash(xp + 300) > 0.72) fillPx(xp * PX, y - PX, PX, PX, C.ink);
}

// The creature's name and the calm meter: five runes that light up as it
// calms, and turn amber once it's ready to part ways.
function drawNameplate(f) {
  const ready = f.calm >= 100;
  if (f.barT > 0) {
    fillPx(190, 156, 100, 4, C.faint);
    fillPx(190, 156, snap(100 * (f.shown / f.max)), 4, C.ink);
  } else {
    text(f.name, 240, 152, { color: ready ? C.ember : C.ink, align: "center", spacing: 1 });
  }
  const lit = ready ? 5 : Math.floor(f.calm / 20);
  RUNES.forEach((rows, i) => drawBitmap(rows, 203 + i * 16, 170, { color: i < lit ? (ready ? C.ember : C.rune) : C.stone }));
}

/* --- the path ------------------------------------------------------------ */
function drawHub() {
  if (G.box.y > 200) drawPath(); // the campfire and friends panels cover the path
  layer("ui");
  // header: warmth on the left, distance on the right
  text("warmth", 20, 18, { color: C.dim });
  text(fmt(S.warmth), 20, 34, { scale: 2, color: C.ember });
  text(`+${fmtRate(warmthRate())} / s`, 20, 72, { color: C.dim });
  text(`${fmt(S.dist)} m`, 430, 18, { align: "right" });
  text(`night ${night()}`, 430, 36, { color: C.dim, align: "right" });
  text(arrived() ? "something ahead" : `next in ${Math.ceil(S.nextAt - S.dist)} m`, 430, 54, { color: arrived() ? C.ember : C.dim, align: "right" });

  const b = drawFrame(G.box);
  withClip(b, () => {
    if (G.hubPhase === "camp") drawCamp(b);
    else if (G.hubPhase === "friends") drawFriends(b);
    else if (G.dialog) drawTyped(G.dialog.text, G.dialog.n, b.x + 22, b.y + 20, HUB_BOX.w - 44, 24, { shadow: C.stoneD });
  });

  drawOptionRow(HUB_OPTS, G.hubPhase === "camp" ? 1 : G.hubPhase === "friends" ? 2 : G.hubSel, true, {
    ready: [arrived()],
    off: [!arrived()],
  });
}

const ridgeY = (wx) => snap(176 + Math.sin(wx * 0.013) * 7 + Math.sin(wx * 0.041) * 3);

function drawPath() {
  layer("bg");
  const off = S.dist * PX_PER_M;
  const far = off * 0.3;

  drawGlow(338, 100, 12, [C.night]);
  drawSprite(baked("moon", bakeMoon), 338, 100);
  drawMountains(196, { scroll: (off * 0.12) / PX, color: C.faint });

  // near hills with snowy pines, scrolling slower than the ground
  for (let x = 0; x < W; x += PX) {
    const y = ridgeY(x + far);
    fillPx(x, y, PX, GROUND - y, C.night);
    if (hash(Math.floor((x + far) / PX)) > 0.55) fillPx(x, y, PX, PX, C.dim);
  }
  const tcell = 40;
  for (let c = Math.floor(far / tcell) - 1; c <= Math.floor((far + W) / tcell) + 1; c++) {
    if (hash(c + 7.7) > 0.55) continue;
    const x = snap(c * tcell - far + hash(c + 3.1) * 26);
    drawBitmap(SPR.pine, x, ridgeY(x + far) - 10, { color: C.moss, color2: C.ink });
  }

  const walking = !arrived() && !REDUCED;
  const bob = walking ? -Math.round(Math.abs(Math.sin(G.walkT * 0.18)) * 2) * PX : 0;
  const ey = GROUND - 14 + bob;
  emberGlow(WALK_X, ey);

  // the path: packed snow, with stones and drifts placed by distance
  fillPx(0, GROUND, W, 2 * PX, C.ink);
  const cell = 34;
  for (let c = Math.floor(off / cell) - 1; c <= Math.floor((off + W) / cell) + 1; c++) {
    const h = hash(c);
    const x = snap(c * cell - off + hash(c + 0.5) * 20);
    if (h < 0.3) {
      fillPx(x, GROUND + 8, 6, 2, C.stoneL);
      fillPx(x + 2, GROUND + 6, 2, 2, C.stoneL);
    } else if (h < 0.55) {
      fillPx(x, GROUND - 2, 10, 2, C.ink);
      fillPx(x + 2, GROUND - 4, 4, 2, C.ink);
    } else if (h < 0.65) {
      fillPx(x, GROUND + 14, 8, 2, C.faint);
    }
  }

  layer("act");
  const remaining = S.nextAt - S.dist;
  if (remaining < 26) {
    drawAhead(ROSTER[S.met % ROSTER.length], WALK_X + 72 + remaining * PX_PER_M, remaining <= 0 ? C.ink : C.dim);
  }

  // friends trail behind you
  const shown = S.friends.slice(-8).reverse();
  shown.forEach((f, i) => {
    const x = WALK_X - 32 - i * 30;
    const y = GROUND - 24 + Math.round(Math.sin(G.t * 0.06 + i * 1.7) * 2) * PX;
    drawMini(f.key, x, y, Math.floor(G.t / 9 + i) % 2);
  });
  if (S.friends.length > 8) {
    layer("ui");
    text(`+${S.friends.length - 8}`, WALK_X - 32 - 8 * 30, GROUND - 30, { color: C.dim, align: "center" });
    layer("act");
  }

  drawEmber(WALK_X, ey);
}

function drawCamp(b) {
  UPGRADES.forEach((u, i) => {
    const r = campRow(i);
    const y = r.y + 6;
    const level = lvl(u.id);
    const maxed = level >= u.max;
    const cost = upgradeCost(u);
    const sel = G.campSel === i;
    const flash = G.campFlash?.i === i && (G.campFlash.t >> 2) % 2 === 0;
    const sh = { shadow: C.stoneD };
    if (sel) drawBitmap(SPR.pick, b.x + 20, y + 7, { color: C.ember, center: true });
    text(u.label, b.x + 34, y, { color: sel ? C.ink : C.dim, ...sh });
    text(u.desc, b.x + 34, y + 18, { color: C.dim, ...sh });
    let costColor = maxed ? C.dim : S.warmth >= cost ? C.ember : C.dim;
    if (flash) costColor = G.campFlash.ok ? C.core : C.stoneD;
    text(maxed ? "max" : fmt(cost), b.x + b.w - 20, y, { color: costColor, align: "right", ...sh });
    text(`lv ${level}`, b.x + b.w - 20, y + 18, { color: C.dim, align: "right", ...sh });
  });
}

function drawFriends(b) {
  const sh = { shadow: C.stoneD };
  let y = b.y + 18;
  text("following you", b.x + 20, y, { color: C.dim, ...sh });
  y += 26;
  if (!S.friends.length) {
    drawTyped("no one yet. spare someone on the path and they'll follow your light.", 999, b.x + 20, y, b.w - 40, 22, sh);
    return;
  }
  for (const key of ROSTER) {
    const list = S.friends.filter((f) => f.key === key);
    if (!list.length) continue;
    drawMini(key, b.x + 28, y + 6, Math.floor(G.t / 9) % 2);
    text(`${SPECIES[key].plural} ${list.length}`, b.x + 48, y, sh);
    text(`+${fmtRate(list.reduce((s, f) => s + f.rate, 0))} / s`, b.x + b.w - 20, y, { color: C.ember, align: "right", ...sh });
    y += 18;
    const names = list.length > 6 ? `${list.slice(-6).map((f) => f.name).join(", ")} and ${list.length - 6} more` : list.map((f) => f.name).join(", ");
    y += drawTyped(names, 999, b.x + 48, y, b.w - 68, 18, { color: C.dim, ...sh }) * 18 + 12;
  }
  text("your own glow", b.x + 48, y, sh);
  text(`+${fmtRate(ownGlow())} / s`, b.x + b.w - 20, y, { color: C.ember, align: "right", ...sh });
}

/* --- battle -------------------------------------------------------------- */
const BATTLE_GROUND = 142;

function drawBattle() {
  const f = G.foe;
  layer("bg");
  drawMountains(BATTLE_GROUND);
  drawSnowLine(BATTLE_GROUND);
  layer("act");
  const pose = drawFoe(f);

  if (G.slash) {
    const t = G.slash.t;
    const grow = clamp(t / 8, 0, 1);
    ctx.globalAlpha = t < 10 ? 1 : 1 - (t - 10) / 16;
    pixelLine(pose.x + 56, pose.y - 50, pose.x + 56 - 112 * grow, pose.y - 50 + 100 * grow, C.ember, 2);
    ctx.globalAlpha = 1;
  }

  layer("ui");
  const inArena = G.phase === "enemy" || G.phase === "dodge";
  if (!inArena && !f.dead) drawNameplate(f);

  const b = drawFrame(G.box, { window: inArena });
  if (inArena) {
    layer("act");
    withClip(b, () => drawArena(b));
    layer("ui");
  }
  withClip(b, () => {
    if (inArena) return;
    if (G.phase === "menu" || G.phase === "result") {
      const d = G.dialog;
      if (d) {
        drawTyped(d.text, d.n, b.x + 22, b.y + 20, MENU_BOX.w - 44, 24, { shadow: C.stoneD });
        if (G.phase === "result" && d.full) drawNext(b.x + b.w - 22, b.y + b.h - 16);
      }
    } else if (G.phase === "talk") {
      drawActs(b);
    } else if (G.phase === "strike") {
      drawStrike(b);
    }
  });

  drawHud();
  drawOptionRow(MENU, G.menu, G.phase === "menu" || G.phase === "talk", {
    ready: [false, false, false, f.calm >= 100],
  });
  drawBubble();
}

function drawActs(b) {
  G.foe.sp.acts.forEach((a, i) => {
    const r = actRect(i);
    const sel = G.act === i;
    if (sel) drawBitmap(SPR.pick, r.x - 16, r.y + 7, { color: C.ember, center: true });
    text(a.label, r.x, r.y, { color: actSpent(i) ? C.stoneL : sel ? C.ink : C.dim, shadow: C.stoneD });
  });
  text("x back", b.x + b.w - 18, b.y + b.h - 24, { color: C.dim, align: "right", shadow: C.stoneD });
}

function drawStrike(b) {
  const s = G.strike;
  if (!s) return;
  const x0 = b.x + 40;
  const x1 = b.x + b.w - 40;
  const cy = snap(b.y + b.h / 2 + 10);
  text("stop the line at the center", b.x + b.w / 2, b.y + 18, { color: C.dim, align: "center", shadow: C.stoneD });
  // a groove carved into the stone, with notches
  fillPx(x0, cy - PX, x1 - x0, PX, C.stoneD);
  fillPx(x0, cy, x1 - x0, PX, C.stoneL);
  for (let i = 0; i <= 10; i++) {
    const x = snap(lerp(x0, x1, i / 10));
    const h = i === 5 ? 24 : 8;
    fillPx(x, cy - h / 2, PX, h, i === 5 ? C.ember : C.stoneD);
  }
  const cx = snap(lerp(x0, x1, s.x));
  fillPx(cx - 4, cy - 22, 8, 44, C.bg);
  fillPx(cx - 2, cy - 20, 4, 40, s.stopped && (s.hold >> 2) % 2 === 0 ? C.ember : C.ink);
}

function drawArena(b) {
  G.arenaClip = { x: b.x + b.inset, y: b.y + b.inset, w: b.w - b.inset * 2, h: b.h - b.inset * 2 };
  const p = G.player;
  emberGlow(p.x, p.y, 0.8 - G.dimmed * 0.2);
  if (G.phase === "dodge" && G.pattern === "spiral" && G.patT >= 0) {
    const a = G.boxTarget;
    drawSprite(baked("ring|4", () => bakeRing(4, C.dim)), a.x + a.w / 2, a.y + a.h / 2);
  }
  drawBullets();
  const blink = p.inv > 0 && (p.inv >> 2) % 2 === 0;
  if (blink) return;
  if (G.view === "ascii") G.glyphs.push({ x: p.x, y: p.y, ch: "@", color: C.ember, size: 1.7 });
  else drawEmber(p.x, p.y);
}

// hp as ten carved segments; mends as little flames on the right
function drawHud() {
  text("ember", 20, HUD_Y, { base: "middle" });
  const segs = 10;
  const filled = G.hp > 0 ? Math.max(1, Math.round((G.hp / G.maxHp) * segs)) : 0;
  const low = G.hp <= G.maxHp * 0.3 && !REDUCED && (G.t >> 4) % 2 === 0;
  for (let i = 0; i < segs; i++) fillPx(92 + i * 14, HUD_Y - 5, 12, 10, i < filled ? (low ? C.warm : C.ember) : C.stoneD);
  text(`${G.hp}/${G.maxHp}`, 92 + segs * 14 + 8, HUD_Y, { color: C.dim, base: "middle" });
  const total = 3 + lvl("mend");
  for (let i = 0; i < total; i++) {
    const has = i < G.mends;
    drawBitmap(SPR.flame, 452 - (total - 1 - i) * 14, HUD_Y, { color: has ? C.ember : C.stoneD, color2: has ? C.core : C.stoneD, center: true });
  }
}

function drawBubble() {
  const d = G.bubble;
  if (!d) return;
  const lines = wrap(d.text, 120);
  const bx = 330;
  const by = 40;
  const bw = 140;
  const bh = 24 + lines.length * 20;
  // a little stone wedge pointing at the creature
  [1, 2, 3, 2, 1].forEach((len, i) => {
    fillPx(bx - len * PX, by + 14 + i * PX, len * PX + PX, PX, C.stone);
    fillPx(bx - len * PX - PX, by + 14 + i * PX, PX, PX, C.bg);
  });
  drawFrame({ x: bx, y: by, w: bw, h: bh });
  drawTyped(d.text, d.n, bx + 12, by + 13, 120, 20, { shadow: C.stoneD });
}

function withClip(b, fn) {
  ctx.save();
  ctx.beginPath();
  ctx.rect(b.x + b.inset, b.y + b.inset, b.w - b.inset * 2, b.h - b.inset * 2);
  ctx.clip();
  fn();
  ctx.restore();
}

function drawNext(x, y) {
  const bob = REDUCED ? 0 : Math.round(Math.sin(G.t * 0.12)) * PX;
  drawBitmap(SPR.next, x, y + bob, { color: C.dim, center: true });
}

// Centered lines that pile up as they're read: earlier ones fade to grey.
function drawStack(d, y0, { lh = 22, maxW = 420 } = {}) {
  if (!d) return y0;
  let y = y0;
  for (let j = 0; j <= d.i; j++) {
    const str = d.lines[j];
    const rows = drawTyped(str, j < d.i ? str.length : d.n, W / 2, y, maxW, lh, { align: "center", color: j < d.i ? C.dim : C.ink });
    y += rows * lh + 8;
  }
  return y;
}


/* --- title & intro ------------------------------------------------------- */
function drawTitle() {
  layer("bg");
  emberGlow(W / 2, 164, 1.7);
  layer("act");
  drawEmber(W / 2, 164, { scale: 2 });
  layer("ui");
  text("ember", W / 2, 66, { scale: 4, align: "center", spacing: 1 });
  text("a very small game", W / 2, 212, { color: C.dim, align: "center" });

  if (!S.started) {
    text("press z or tap to begin", W / 2, 290, { align: "center", alpha: pulse() });
  } else if (G.confirmReset) {
    text("start over? your warmth and", W / 2, 262, { align: "center" });
    text("friends will be gone.", W / 2, 282, { align: "center" });
    text("z or tap here to confirm · x to cancel", W / 2, 312, { color: C.ember, align: "center", alpha: pulse() });
  } else {
    TITLE_OPTS.forEach((label, i) => {
      const r = titleRect(i);
      const sel = G.titleSel === i;
      text(label, W / 2, r.y + 10, { color: sel ? C.ink : C.dim, align: "center", base: "middle" });
      if (sel) drawBitmap(SPR.pick, W / 2 - textWidth(label) / 2 - 14, r.y + 10, { color: C.ember, center: true });
    });
    text(`${fmt(S.warmth)} warmth · ${S.friends.length} friends · ${fmt(S.dist)} m`, W / 2, 334, { color: C.dim, align: "center" });
  }
  text("arrows move · z ok · x back", W / 2, 378, { color: C.dim, align: "center" });
  text("m sound · v ascii or pixels", W / 2, 396, { color: C.dim, align: "center" });
}

function drawIntro() {
  layer("bg");
  emberGlow(W / 2, 200, 1.2);
  layer("act");
  drawEmber(W / 2, 200);
  layer("ui");
  drawStack(G.dialog, 250);
  if (G.dialog?.full) drawNext(W - 28, H - 28);
}

/* --- losing -------------------------------------------------------------- */
function drawOver() {
  if (G.sceneT < 30 && G.overAt) {
    layer("bg");
    emberGlow(G.overAt.x, G.overAt.y, 1 - G.sceneT / 30);
    layer("act");
    drawEmber(G.overAt.x, G.overAt.y, { alpha: 1 - G.sceneT / 30 });
  }
  layer("ui");
  const y = drawStack(G.dialog, 180);
  if (G.overReady) text("z to keep going", W / 2, y + 34, { color: C.ember, align: "center", alpha: pulse() });
}

function drawParticles() {
  for (const p of G.particles) {
    const alpha = 1 - p.age / p.life;
    if (G.view === "ascii") {
      G.glyphs.push({ x: p.x, y: p.y, ch: p.color === C.ember ? "*" : p.size > 1 && p.age % 40 < 20 ? "'" : ".", color: p.color, alpha });
      continue;
    }
    ctx.globalAlpha = alpha;
    ctx.fillStyle = p.color;
    ctx.fillRect(snap(p.x), snap(p.y), p.size, p.size);
  }
  ctx.globalAlpha = 1;
}

function drawFloaters() {
  for (const f of G.floaters) {
    const a = f.t < 50 ? 1 : 1 - (f.t - 50) / 30;
    text(f.text, f.x, f.y, { scale: f.scale ?? 1, color: f.color, align: "center", alpha: a });
  }
}

function draw() {
  G.glyphs.length = 0;
  G.quiet.length = 0;
  G.shakeX = G.shake > 0 ? snap(rand(-1, 1) * G.shake) : 0;
  G.shakeY = G.shake > 0 ? snap(rand(-1, 1) * G.shake) : 0;
  for (const [name, g] of Object.entries(LAYERS)) {
    g.setTransform(1, 0, 0, 1, 0, 0);
    g.globalAlpha = 1;
    if (name === "bg") {
      g.fillStyle = C.bg;
      g.fillRect(0, 0, BW, BH);
    } else {
      g.clearRect(0, 0, BW, BH);
    }
    g.setTransform(1 / PX, 0, 0, 1 / PX, G.shakeX / PX, G.shakeY / PX);
    g.imageSmoothingEnabled = false;
  }

  layer("bg");
  drawStars();
  switch (G.scene) {
    case "title": drawTitle(); break;
    case "intro": drawIntro(); break;
    case "hub": drawHub(); break;
    case "battle": drawBattle(); break;
    case "over": drawOver(); break;
  }
  layer("act");
  drawParticles();
  layer("ui");
  drawFloaters();
  LAYERS.ui.setTransform(1 / PX, 0, 0, 1 / PX, 0, 0); // the toggles don't shake
  drawToggles();
  present();
}

/* ----------------------------------------------------------------------- */
/* The complete sprite sheet: open the page with #sprites to see it, or    */
/* run export-sprites.mjs to save it as files                              */
/* ----------------------------------------------------------------------- */
const WINGS = ["wings-open", "wings-mid", "wings-up"];
const DRAGON_MOODS = ["glare", "watch", "drowsy", "asleep"];
const DRAGON_WINGS = ["wings-up", "wings-mid", "wings-down"];
const GLYPH_NAMES = {
  ".": "period", ",": "comma", "'": "apostrophe", "?": "question", "!": "exclamation", "-": "hyphen",
  "—": "dash", "/": "slash", ":": "colon", "+": "plus", "·": "dot", "(": "paren-left", ")": "paren-right",
};
const glyphName = (ch) => GLYPH_NAMES[ch] ?? ch;
// every glyph in a 5 × 9 cell, baseline under row 7, so a font atlas lines up
const glyphCell = (ch) => [...FONT[ch], ".....", ".....", "....."].slice(0, 9).map((r) => r.padEnd(5, "."));

// A copy with its anchor (the point the game positions it by) attached.
function anchored(c) {
  const o = document.createElement("canvas");
  o.width = c.width;
  o.height = c.height;
  o.getContext("2d").drawImage(c, 0, 0);
  o.ox = c.ox ?? Math.floor(c.width / 2);
  o.oy = c.oy ?? Math.floor(c.height / 2);
  return o;
}

function wordmark(str, scale) {
  const c = document.createElement("canvas");
  c.width = textWidth(str, scale, 1) / PX;
  c.height = 7 * scale;
  const g = c.getContext("2d");
  [...str].forEach((ch, i) => g.drawImage(bitmap(epx(FONT[ch], scale), [C.ink]), i * (ADV + 1) * scale, 0));
  return c;
}

function spriteGroups() {
  const groups = [];
  const group = (name, caption) => {
    const g = { name, caption, items: [] };
    groups.push(g);
    return (id, canvas) => g.items.push({ name: `${name}/${id}`, canvas: anchored(canvas) });
  };
  const bmp = (rows, colors, scale = 1) => bitmap(epx(rows, scale), colors);
  const hit = (color) => (color === C.ember ? "-hit" : "");

  const moth = group("moth", "wings open, mid, up · then the hit flash");
  for (const color of [C.ink, C.ember]) WINGS.forEach((w, f) => moth(w + hit(color), foeSprite("moth", { frame: f, color })));

  const fly = group("firefly", "wings open, mid, up · lantern lit, then dark · then the hit flash");
  for (const color of [C.ink, C.ember]) {
    for (const lit of [1, 0]) WINGS.forEach((w, f) => fly(`${w}-${lit ? "lit" : "dark"}${hit(color)}`, foeSprite("firefly", { frame: f, lit, color, k: 0.75 })));
  }

  const dragon = group("dragon", "wings up, mid, down · glaring at your light, watching, drowsy, asleep · then the hit flash");
  for (const color of [C.ink, C.ember]) {
    for (const mood of DRAGON_MOODS) DRAGON_WINGS.forEach((w, f) => dragon(`${w}-${mood}${hit(color)}`, foeSprite("dragon", { frame: f, mood, color, k: DRAGON_K })));
  }

  const path = group("path", "waiting up ahead: still far off (grey), then close");
  for (const color of [C.dim, C.ink]) {
    const far = color === C.dim ? "-far" : "";
    WINGS.forEach((w, f) => path(`moth-${w}${far}`, foeSprite("moth", { frame: f, color, k: 0.25 })));
    for (const lit of [1, 0]) WINGS.forEach((w, f) => path(`firefly-${w}-${lit ? "lit" : "dark"}${far}`, foeSprite("firefly", { frame: f, lit, color, k: 0.4 })));
    DRAGON_WINGS.forEach((w, f) => path(`dragon-${w}${far}`, foeSprite("dragon", { frame: f, mood: "watch", color, k: 0.25 })));
    path(`dragon-asleep${far}`, foeSprite("dragon", { frame: 1, mood: "asleep", color, k: 0.25 }));
  }

  const friends = group("friends", "following you, two frames each");
  friends("moth-a", bmp(SPR.mothA, [C.ink, C.ink, C.dim]));
  friends("moth-b", bmp(SPR.mothB, [C.ink, C.ink, C.dim]));
  friends("firefly-a", bmp(SPR.fireflyA, [C.ink, C.glim]));
  friends("firefly-b", bmp(SPR.fireflyB, [C.ink, C.moss]));
  friends("dragon-a", bmp(SPR.dragonA, [C.ink, C.rune, C.stone]));
  friends("dragon-b", bmp(SPR.dragonB, [C.ink, C.rune, C.stone]));

  const you = group("ember", "you: three flicker frames, then twice the size for the title");
  SPR.ember.forEach((rows, i) => you(`flicker-${i + 1}`, bmp(rows, [C.ember, C.core])));
  SPR.ember.forEach((rows, i) => you(`title-${i + 1}`, bmp(rows, [C.ember, C.core], 2)));

  const atk = group("attacks", "dust, spark, firefly, feathers, ice shard, icicle, little moth, warning flash");
  atk("dust-small", bmp(SPR.dustS, [C.ink]));
  atk("dust-large", bmp(SPR.dustL, [C.ink]));
  atk("spark", bmp(SPR.spark, [C.ink, C.core]));
  atk("firefly-lit", bmp(SPR.fly, [C.ink, C.glim]));
  atk("firefly-dark", bmp(SPR.fly, [C.ink, C.dim]));
  atk("feather-left", bmp(SPR.featherL, [C.ink]));
  atk("feather-flat", bmp(SPR.featherF, [C.ink]));
  atk("feather-right", bmp(SPR.featherR, [C.ink]));
  atk("shard", bmp(SPR.shard, [C.ink, C.rune]));
  atk("icicle", bmp(SPR.icicle, [C.ink, C.rune]));
  atk("icicle-glint", bmp(SPR.icicle, [C.rune, C.rune]));
  atk("moth-a", bmp(SPR.bugA, [C.ink, C.ink, C.dim]));
  atk("moth-b", bmp(SPR.bugB, [C.ink, C.ink, C.dim]));
  for (const r of [6, 5, 4]) atk(`warning-${r}`, baked(`ring|${r}`, () => bakeRing(r, C.dim)));

  const light = group("light", "glows: your ember, the title, a firefly up close and far off, the moon");
  light("ember", glowCanvas(12, [C.deep, C.warm]));
  light("title", glowCanvas(20, [C.deep, C.warm]));
  light("firefly", glowCanvas(16, [C.moss]));
  light("firefly-far", glowCanvas(8, [C.moss]));
  light("moon", glowCanvas(12, [C.night]));

  const scenery = group("scenery", "moon, pine");
  scenery("moon", baked("moon", bakeMoon));
  scenery("pine", bmp(SPR.pine, [C.moss, C.ink]));

  const icons = group("icons", "tablet icons: strike, talk, mend, part, approach, campfire, friends");
  for (const [name, rows] of Object.entries(ICON)) icons(name, bmp(rows, [C.dim]));
  icons("strike-selected", bmp(ICON.strike, [C.ember]));
  const runes = group("runes", "the calm meter: unlit, lit, ready to part");
  for (const color of [C.stone, C.rune, C.ember]) RUNES.forEach((rows, i) => runes(`${i + 1}-${color === C.stone ? "unlit" : color === C.rune ? "lit" : "ready"}`, bmp(rows, [color])));
  const ui = group("ui", "menu pick, next, sound on, sound off, mend flame full and spent");
  ui("pick", bmp(SPR.pick, [C.ember]));
  ui("next", bmp(SPR.next, [C.dim]));
  ui("sound-on", bmp(SPR.soundOn, [C.dim]));
  ui("sound-off", bmp(SPR.soundOff, [C.dim]));
  ui("mend-full", bmp(SPR.flame, [C.ember, C.core]));
  ui("mend-spent", bmp(SPR.flame, [C.stoneD, C.stoneD]));

  const font = group("font", "the 5x7 font in 5x9 cells, then the big numbers at 2x");
  for (const ch of Object.keys(FONT)) font(glyphName(ch), bmp(glyphCell(ch), [C.ink]));
  for (const ch of "0123456789,+!") font(`${glyphName(ch)}-2x`, bmp(glyphCell(ch), [C.ink], 2));

  const title = group("title", "the wordmark, 4x");
  title("ember", wordmark("ember", 4));
  return groups;
}

function buildSpriteSheet() {
  const groups = spriteGroups();

  // 1. the atlas: every frame packed in rows, 2px apart, on transparency
  const PAD = 2;
  const MAXW = 512;
  const frames = [];
  let x = PAD;
  let y = PAD;
  let rowH = 0;
  let usedW = 0;
  for (const g of groups) {
    if (x > PAD) {
      x = PAD;
      y += rowH + PAD;
      rowH = 0;
    }
    for (const it of g.items) {
      const c = it.canvas;
      if (x + c.width + PAD > MAXW) {
        x = PAD;
        y += rowH + PAD;
        rowH = 0;
      }
      frames.push({ ...it, x, y });
      x += c.width + PAD;
      usedW = Math.max(usedW, x);
      rowH = Math.max(rowH, c.height);
    }
  }
  const atlas = document.createElement("canvas");
  atlas.width = usedW;
  atlas.height = y + rowH + PAD;
  const ag = atlas.getContext("2d");
  for (const f of frames) ag.drawImage(f.canvas, f.x, f.y);

  const json = {
    frames: Object.fromEntries(frames.map((f) => {
      const { width: w, height: h, ox, oy } = f.canvas;
      return [f.name, {
        frame: { x: f.x, y: f.y, w, h },
        rotated: false,
        trimmed: false,
        spriteSourceSize: { x: 0, y: 0, w, h },
        sourceSize: { w, h },
        pivot: { x: +(ox / w).toFixed(4), y: +(oy / h).toFixed(4) },
      }];
    })),
    meta: {
      app: "ember",
      image: "ember-sprites.png",
      format: "RGBA8888",
      size: { w: atlas.width, h: atlas.height },
      scale: "1",
      note: "1 px = 1 game pixel. The game draws at 240 × 210 and scales up with nearest-neighbor. pivot is the point the game positions each sprite by.",
      palette: C,
    },
  };

  // 2. the preview: the same sprites, labeled, on the night background
  const PW = 432;
  const M = 12;
  const plan = [];
  let py = M + 60;
  for (const g of groups) {
    const caption = wrap(g.caption, (PW - M * 2 - textWidth(g.name) / PX - 8) * PX);
    plan.push({ kind: "label", g, y: py, caption });
    py += caption.length * 11 + 6;
    let px = M;
    let rh = 0;
    for (const it of g.items) {
      const c = it.canvas;
      if (px + c.width > PW - M) {
        px = M;
        py += rh + 6;
        rh = 0;
      }
      plan.push({ kind: "sprite", c, x: px, y: py });
      px += c.width + 6;
      rh = Math.max(rh, c.height);
    }
    py += rh + 14;
  }
  const preview = document.createElement("canvas");
  preview.width = PW;
  preview.height = py;
  const pg = preview.getContext("2d");
  pg.imageSmoothingEnabled = false;
  pg.fillStyle = C.bg;
  pg.fillRect(0, 0, PW, py);
  const say2 = (str, x0, y0, color, scale = 1) => {
    [...str.toLowerCase()].forEach((ch, i) => {
      if (FONT[ch]) pg.drawImage(bitmap(epx(FONT[ch], scale), [color]), x0 + i * ADV * scale, y0);
    });
  };
  say2("ember sprite sheet", M, M, C.ink, 2);
  const names = Object.keys(C);
  names.forEach((name, i) => {
    const sx = M + i * 37;
    pg.fillStyle = C.faint;
    pg.fillRect(sx, M + 22, 16, 12);
    pg.fillStyle = C[name];
    pg.fillRect(sx + 1, M + 23, 14, 10);
    say2(name, sx, M + 37, C.dim);
  });
  for (const p of plan) {
    if (p.kind === "sprite") {
      pg.drawImage(p.c, p.x, p.y);
    } else {
      say2(p.g.name, M, p.y, C.ember);
      const cx = M + textWidth(p.g.name) / PX + 8;
      p.caption.forEach((ln, i) => say2(ln, cx, p.y + i * 11, C.dim));
    }
  }

  return { atlas, preview, json, palette: C, count: frames.length };
}
G.debug.spriteSheet = buildSpriteSheet;

function showSpriteSheet() {
  const { preview, count } = buildSpriteSheet();
  canvas.style.display = "none";
  for (const el of [document.documentElement, document.body]) {
    el.style.overflow = "auto";
    el.style.height = "auto";
  }
  stage.style.height = "auto";
  stage.style.padding = "16px 0";
  const s = Math.max(1, Math.min(4, Math.floor((window.innerWidth - 32) / preview.width)));
  Object.assign(preview.style, { width: `${preview.width * s}px`, maxWidth: "100%", height: "auto", imageRendering: "pixelated" });
  preview.setAttribute("role", "img");
  preview.setAttribute("aria-label", `ember's complete sprite sheet: ${count} sprites, including every creature frame, attack, glow, icon and font glyph`);
  stage.appendChild(preview);
}

/* ----------------------------------------------------------------------- */
/* ASCII view: the world drawn in glyphs, the stone UI kept as pixels       */
/* ----------------------------------------------------------------------- */
// The world is drawn into two layers (background, actors) and the interface
// into a third. In the ASCII view each 2×2 block of world pixels becomes one
// glyph, picked by what's there: every material has its own symbols, edges
// follow their direction, your glow tints what it touches, and an empty sky
// fills with a dim field of drifting letters. Bullets and particles skip the
// grid and are drawn as glyphs at their exact positions. The UI goes on top,
// pixel for pixel.
const CELL = 2;
const COLS = BW / CELL;
const ROWS = BH / CELL;
const MONO = 'ui-monospace, SFMono-Regular, Menlo, Consolas, "DejaVu Sans Mono", "Liberation Mono", monospace';
const GLY = {
  field: "#1d2c42", night: "#34465f", faint: "#435470", stone: "#7d899e", snow: "#eef3f8", white: "#ffffff",
  body: "#5f6f88", bodyStone: "#8a96aa", moss: "#5f8a35", warm: "#d0782f", deep: "#7c4321",
};

// every palette color gets a bit, so a cell's contents are one small number
const BIT = Object.fromEntries(Object.keys(C).map((k, i) => [k, 1 << i]));
const RGB_BIT = new Map(Object.entries(C).map(([k, h]) => [parseInt(h.slice(1), 16), BIT[k]]));
const PAL_LIST = Object.entries(C).map(([k, h]) => [BIT[k], [1, 3, 5].map((i) => parseInt(h.slice(i, i + 2), 16))]);
function bitOf(r, g, b) {
  const exact = RGB_BIT.get((r << 16) | (g << 8) | b);
  if (exact) return exact;
  let best = BIT.bg;
  let bd = Infinity;
  for (const [bit, [pr, pg, pb]] of PAL_LIST) {
    const d = (r - pr) ** 2 + (g - pg) ** 2 + (b - pb) ** 2;
    if (d < bd) {
      bd = d;
      best = bit;
    }
  }
  return best;
}
const has = (mask, ...names) => names.some((n) => mask & BIT[n]);
const hash2 = (x, y) => {
  const v = Math.sin(x * 12.9898 + y * 78.233) * 43758.5453;
  return v - Math.floor(v);
};
const pick = (str, h) => str[Math.floor(h * str.length) % str.length];

// Glyph images, cached per character, color and size. Glyphs are drawn a
// little bigger than their cell and centered on it, so neighbors touch and
// shapes read as one texture; bold keeps the strokes alive at small sizes.
const GLYPH_SCALE = 1.35;
let atlas = new Map();
function glyphImage(ch, color, w, h) {
  const key = `${ch}|${color}|${w}|${h}`;
  let c = atlas.get(key);
  if (c) return c;
  if (atlas.size > 4000) atlas = new Map();
  const size = h * GLYPH_SCALE;
  c = document.createElement("canvas");
  c.width = Math.max(1, Math.ceil(Math.max(w, size * 0.62 * ch.length) + 2));
  c.height = Math.max(1, Math.ceil(size + 2));
  const g = c.getContext("2d");
  g.font = `bold ${Math.round(size)}px ${MONO}`;
  g.textAlign = "center";
  g.textBaseline = "middle";
  g.fillStyle = color;
  g.fillText(ch, c.width / 2, c.height / 2 + size * 0.05);
  atlas.set(key, c);
  return c;
}

// Which way an edge runs through (x, y), from a Sobel pass over brightness.
function edgeChar(L, x, y) {
  const at = (xx, yy) => L[Math.min(BH - 1, Math.max(0, yy)) * BW + Math.min(BW - 1, Math.max(0, xx))];
  const gx = at(x + 1, y - 1) + 2 * at(x + 1, y) + at(x + 1, y + 1) - at(x - 1, y - 1) - 2 * at(x - 1, y) - at(x - 1, y + 1);
  const gy = at(x - 1, y + 1) + 2 * at(x, y + 1) + at(x + 1, y + 1) - at(x - 1, y - 1) - 2 * at(x, y - 1) - at(x + 1, y - 1);
  if (Math.abs(gx) + Math.abs(gy) < 60) return null;
  const a = ((Math.atan2(gy, gx) * 180) / Math.PI + 90 + 180) % 180;
  return a < 22 || a >= 158 ? "-" : a < 68 ? "\\" : a < 112 ? "|" : "/";
}

function actorGlyph(m, L, x, y, h) {
  if (has(m, "ember")) return [pick("@*+", h), C.ember];
  if (has(m, "core")) return ["*", C.core];
  if (has(m, "glim")) return ["*", C.glim];
  if (has(m, "rune")) return [pick("FRYXTP", h), C.rune];
  if (has(m, "ink")) return [edgeChar(L, x, y) || "#", GLY.white];
  if (has(m, "dim")) return [edgeChar(L, x, y) || "+", C.dim];
  if (has(m, "moss")) return ["o", GLY.moss];
  if (has(m, "warm")) return [":", GLY.warm];
  if (has(m, "deep")) return [".", GLY.deep];
  if (has(m, "stone", "stoneL")) return [pick("#=", h), GLY.bodyStone];
  return [pick("%#&", h), GLY.body];
}

function backgroundGlyph(m, L, x, y, h, cx, cy, quiet, drift) {
  if (has(m, "ink")) return [(m !== BIT.ink && edgeChar(L, x, y)) || pick("*=~+", h), GLY.snow];
  if (has(m, "moss")) return [pick("A^", h), GLY.moss];
  if (has(m, "stone", "stoneL", "stoneD")) return [pick("#=%", h), GLY.stone];
  if (has(m, "warm")) return [pick(":.", h), GLY.warm];
  if (has(m, "deep")) return [pick(".:", h), GLY.deep];
  if (has(m, "dim")) return [has(m, "night") ? "'" : pick("*.'", h), C.dim];
  if (has(m, "faint")) return [pick(":.", h), GLY.faint];
  if (has(m, "night")) return [(has(m, "bg") && edgeChar(L, x, y)) || pick(":;.'", h), GLY.night];
  if (quiet) return null;
  // the letter field: clustered like weather, drifting slowly down
  const iy = Math.floor(cy - drift);
  const d = 0.5 + 0.5 * Math.sin(cx * 0.19) * Math.sin(iy * 0.31 + 1.3);
  if (hash2(cx, iy) < 0.03 + 0.3 * d * d * d) return [pick("Q08dbq", hash2(cx + 7, iy)), GLY.field];
  return null;
}

// Snap a layer to the palette. With `transparent`, clear pixels are skipped
// and partly clear ones keep their alpha, so fades blend over what's below.
function snapToPalette(g, { transparent = false } = {}) {
  const img = g.getImageData(0, 0, BW, BH);
  const d = img.data;
  for (let y = 0; y < BH; y++) {
    for (let x = 0; x < BW; x++) {
      const i = (y * BW + x) * 4;
      if (transparent && d[i + 3] === 0) continue;
      const r = d[i];
      const gg = d[i + 1];
      const b = d[i + 2];
      if (PAL_KEYS.has((r << 16) | (gg << 8) | b)) continue;
      const bias = BAYER[((y & 3) << 2) | (x & 3)] * SPREAD;
      let best = 0;
      let bestD = Infinity;
      for (let p = 0; p < PAL.length; p++) {
        const c = PAL[p];
        const dr = r + bias - c[0];
        const dg = gg + bias - c[1];
        const db = b + bias - c[2];
        const dist = 2 * dr * dr + 4 * dg * dg + 3 * db * db;
        if (dist < bestD) {
          bestD = dist;
          best = p;
        }
      }
      const c = PAL[best];
      d[i] = c[0];
      d[i + 1] = c[1];
      d[i + 2] = c[2];
      if (!transparent) d[i + 3] = 255;
    }
  }
  g.putImageData(img, 0, 0);
}

const uiOut = makeLayer();
const bgL = new Float32Array(BW * BH);
const actL = new Float32Array(BW * BH);
const worldGlyphs = document.createElement("canvas").getContext("2d");
let asciiFrame = 0;

function drawAscii() {
  const SW = canvas.width;
  const SH = canvas.height;
  const cw = SW / COLS;
  const chh = SH / ROWS;
  const quietAt = (lx, ly) => G.quiet.some((q) => lx >= q.x && lx < q.x + q.w && ly >= q.y && ly < q.y + q.h);
  // the world's glyphs are rebuilt every other frame; everything that moves
  // fast (bullets, your ember in the arena, particles) is drawn every frame
  const sized = worldGlyphs.canvas.width === SW && worldGlyphs.canvas.height === SH;
  if (!sized) {
    worldGlyphs.canvas.width = SW;
    worldGlyphs.canvas.height = SH;
  }
  if (!sized || asciiFrame++ % 2 === 0) drawWorldGlyphs(SW, SH, cw, chh, quietAt);
  screen.drawImage(worldGlyphs.canvas, 0, 0);
  drawFreeGlyphs(SW, SH, cw, chh, quietAt);
  drawInterfaceOver(SW, SH);
}

function drawWorldGlyphs(SW, SH, cw, chh, quietAt) {
  const out = worldGlyphs;
  out.fillStyle = C.bg;
  out.fillRect(0, 0, SW, SH);
  const bg = LAYERS.bg.getImageData(0, 0, BW, BH).data;
  const act = LAYERS.act.getImageData(0, 0, BW, BH).data;
  const ui = LAYERS.ui.getImageData(0, 0, BW, BH).data;
  for (let i = 0, p = 0; p < BW * BH; p++, i += 4) {
    bgL[p] = (bg[i] + bg[i + 1] + bg[i + 2]) / 3;
    actL[p] = act[i + 3] > 60 ? (act[i] + act[i + 1] + act[i + 2]) / 3 + 40 : 0;
  }
  const drift = REDUCED ? 0 : G.t * 0.012;

  for (let cy = 0; cy < ROWS; cy++) {
    for (let cx = 0; cx < COLS; cx++) {
      const x0 = cx * CELL;
      const y0 = cy * CELL;
      let bgMask = 0;
      let actMask = 0;
      let covered = 0;
      for (let j = 0; j < CELL; j++) {
        for (let k = 0; k < CELL; k++) {
          const i = ((y0 + j) * BW + x0 + k) * 4;
          if (ui[i + 3] > 200) covered++;
          bgMask |= bitOf(bg[i], bg[i + 1], bg[i + 2]);
          if (act[i + 3] > 60) actMask |= bitOf(act[i], act[i + 1], act[i + 2]);
        }
      }
      if (covered === CELL * CELL) continue; // the interface will sit on top
      const h = hash2(cx, cy);
      const g = actMask
        ? actorGlyph(actMask, actL, x0, y0, h)
        : backgroundGlyph(bgMask, bgL, x0, y0, h, cx, cy, quietAt((x0 + 1) * PX, (y0 + 1) * PX), drift);
      if (!g) continue;
      const img = glyphImage(g[0], g[1], cw, chh);
      out.drawImage(img, Math.round((cx + 0.5) * cw - img.width / 2), Math.round((cy + 0.5) * chh - img.height / 2));
    }
  }
}

// Free-floating glyphs: bullets, particles, drifting motes.
function drawFreeGlyphs(SW, SH, cw, chh, quietAt) {
  const sx = SW / W;
  const sy = SH / H;
  for (const o of G.glyphs) {
    if (o.clip && (o.x < o.clip.x || o.x >= o.clip.x + o.clip.w || o.y < o.clip.y || o.y >= o.clip.y + o.clip.h)) continue;
    const size = o.size ?? 1;
    const img = glyphImage(o.ch, o.color, cw * size, chh * size);
    screen.globalAlpha = o.alpha ?? 1;
    screen.drawImage(img, Math.round((o.x + G.shakeX) * sx - img.width / 2), Math.round((o.y + G.shakeY) * sy - img.height / 2));
  }
  screen.globalAlpha = 1;
  if (G.scene !== "battle" || G.phase !== "dodge") {
    for (const m of G.motes) {
      if (quietAt(m.x, m.y)) continue;
      const img = glyphImage(m.ch, m.color, cw * m.ch.length, chh);
      screen.drawImage(img, Math.round(m.x * sx - img.width / 2), Math.round(m.y * sy - img.height / 2));
    }
  }
}

// The stone interface, pixel for pixel, on top.
function drawInterfaceOver(SW, SH) {
  uiOut.setTransform(1, 0, 0, 1, 0, 0);
  uiOut.clearRect(0, 0, BW, BH);
  uiOut.drawImage(LAYERS.ui.canvas, 0, 0);
  snapToPalette(uiOut, { transparent: true });
  screen.drawImage(uiOut.canvas, 0, 0, SW, SH);
}

function toggleView() {
  G.view = G.view === "ascii" ? "pixel" : "ascii";
  storage.set("ember:view", G.view);
  sfx.select();
  say(G.view === "ascii" ? "ascii view" : "pixel view");
}

// The sound and view toggles in the top-right corner.
function drawToggles() {
  drawBitmap(muted ? SPR.soundOff : SPR.soundOn, W - 26, 20, { color: C.dim, center: true, alpha: 0.8 });
  if (G.view === "ascii") text("@", W - 60, 20, { color: C.dim, align: "center", base: "middle" });
  else drawBitmap(SPR.checker, W - 60, 20, { color: C.dim, center: true });
}

/* ----------------------------------------------------------------------- */
/* Loop                                                                    */
/* ----------------------------------------------------------------------- */
function update() {
  G.t++;
  G.sceneT++;
  if (pressed.has("mute")) toggleMute();
  if (pressed.has("view")) toggleView();
  for (let i = taps.length - 1; i >= 0; i--) {
    if (taps[i].y >= 40) continue;
    if (taps[i].x > W - 44) toggleMute();
    else if (taps[i].x > W - 78) toggleView();
    else continue;
    taps.splice(i, 1);
  }
  if (S.started && !document.hidden) gain(warmthRate() / 60);
  if (S.started && G.t % 300 === 0) persist();
  updateAmbient();
  switch (G.scene) {
    case "title": updateTitle(); break;
    case "intro": updateIntro(); break;
    case "hub": updateHub(); break;
    case "battle": updateBattle(); break;
    case "over": updateOver(); break;
  }
}

let last = performance.now();
let acc = 0;
function frame(now) {
  acc += Math.min(100, now - last);
  last = now;
  while (acc >= STEP) {
    update();
    acc -= STEP;
    pressed.clear();
    taps.length = 0;
  }
  draw();
  requestAnimationFrame(frame);
}

// Warmth keeps building while the page is hidden or closed.
let hiddenAt = 0;
document.addEventListener("visibilitychange", () => {
  held.clear();
  if (document.hidden) {
    hiddenAt = Date.now();
    if (S.started) persist();
    return;
  }
  last = performance.now();
  if (!hiddenAt) return;
  const secs = (Date.now() - hiddenAt) / 1000;
  hiddenAt = 0;
  const walking = G.scene === "hub";
  const g = catchUp(secs, walking);
  if (g >= 1 && secs > 20 && walking && G.hubPhase === "walk") {
    G.dialog = new Typer(`while you were away, you gathered ${fmt(g)} warmth.`);
  }
});
window.addEventListener("pagehide", () => {
  if (S.started) persist();
});

const away = (Date.now() - S.t) / 1000;
const gathered = catchUp(away, true);
if (gathered >= 1 && away > 30) G.awayMsg = `while you were away, you gathered ${fmt(gathered)} warmth.`;
if (S.started) persist();

if (location.hash === "#sprites") {
  showSpriteSheet();
} else {
  startTitle();
  requestAnimationFrame(frame);
}
window.addEventListener("hashchange", () => location.reload());
