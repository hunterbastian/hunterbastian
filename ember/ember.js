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

// The whole game uses these eleven colors and nothing else. Shadows lean cool
// (night), light leans warm (your ember), and fireflies get their own green.
const C = {
  bg: "#0c0b10",
  night: "#17151f",
  faint: "#2d2a38",
  dim: "#7f7a8c",
  ink: "#efe9dc",
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

const buf = document.createElement("canvas");
buf.width = BW;
buf.height = BH;
const ctx = buf.getContext("2d", { willReadFrequently: true });

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

function pixelate() {
  const img = ctx.getImageData(0, 0, BW, BH);
  const d = img.data;
  for (let y = 0; y < BH; y++) {
    for (let x = 0; x < BW; x++) {
      const i = (y * BW + x) * 4;
      const r = d[i];
      const g = d[i + 1];
      const b = d[i + 2];
      if (PAL_KEYS.has((r << 16) | (g << 8) | b)) continue;
      const bias = BAYER[((y & 3) << 2) | (x & 3)] * SPREAD;
      let best = 0;
      let bestD = Infinity;
      for (let p = 0; p < PAL.length; p++) {
        const c = PAL[p];
        const dr = r + bias - c[0];
        const dg = g + bias - c[1];
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
      d[i + 3] = 255;
    }
  }
  ctx.putImageData(img, 0, 0);
}

function present() {
  pixelate();
  screen.setTransform(1, 0, 0, 1, 0, 0);
  screen.imageSmoothingEnabled = false;
  screen.drawImage(buf, 0, 0, canvas.width, canvas.height);
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
  owlA: ["#.......#", ".#.....#.", ".#######.", "#ooo#ooo#", "#o.o#o.o#", "#ooo+ooo#", "#*******#", "#**#*#**#", ".#*****#.", "..#####..", "...+.+..."],
  owlB: ["#.......#", ".#.....#.", ".#######.", "#########", "#ooo#ooo#", "####+####", "#*******#", "#**#*#**#", ".#*****#.", "..#####..", "...+.+..."],
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
  pine: ["..#..", ".###.", "..#..", ".###.", "#####", "..#.."],
  soundOn: ["...#.....", "..##..#..", "####...#.", "####.#.#.", "####...#.", "..##..#..", "...#....."],
  soundOff: ["...#.....", "..##.....", "####.#.#.", "####..#..", "####.#.#.", "..##.....", "...#....."],
};

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

function text(str, x, y, { scale = 1, color = C.ink, align = "left", alpha = 1, base = "top", spacing = 0 } = {}) {
  str = String(str).toLowerCase();
  const w = textWidth(str, scale, spacing);
  const tx = snap(align === "center" ? x - w / 2 : align === "right" ? x - w : x);
  const ty = snap(base === "middle" ? y - 3.5 * scale * PX : y);
  const step = (ADV + spacing) * scale * PX;
  ctx.globalAlpha = alpha;
  for (let i = 0; i < str.length; i++) {
    const rows = FONT[str[i]];
    if (!rows) continue;
    const g = bitmap(epx(rows, scale), [color]);
    ctx.drawImage(g, tx + i * step, ty, g.width * PX, g.height * PX);
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
function drawTyped(str, n, x, y, maxW, lh, { align = "left", color = C.ink, scale = 1, alpha = 1 } = {}) {
  const lines = wrap(str, maxW, scale);
  let left = n;
  lines.forEach((ln, i) => {
    if (left <= 0) return;
    const lx = align === "center" ? x - textWidth(ln, scale) / 2 : x;
    text(ln.slice(0, left), lx, y + i * lh, { color, scale, alpha });
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

function bakeOwl(mood, color, k) {
  const detail = k >= 0.4;
  const ox = Math.ceil(64 * k) + 2;
  const oy = Math.ceil(50 * k) + 2;
  const pen = new Pen(ox * 2, oy + Math.ceil(50 * k) + 2, ox, oy, k);
  // the branch it sits on
  pen.line([[-62, 46], [58, 44]], C.dim);
  pen.line([[-60, 48], [56, 46]], C.faint);
  pen.line([[36, 45], [48, 35]], C.dim);
  for (const side of [-1, 1]) pen.shape(mirror([[12, -26], [26, -46], [28, -20]], side), C.night, color);
  const body = oval(0, 4, 32, 38);
  pen.fill(body, C.night);
  pen.fill(oval(0, 17, 19, 21), C.faint);
  if (detail) {
    for (const [u, v] of [[-8, 12], [8, 12], [0, 20], [-8, 28], [8, 28]]) pen.line([[u - 3, v], [u, v + 3], [u + 3, v]], C.dim);
  }
  for (const side of [-1, 1]) {
    pen.line(mirror(qbez([30, -6], [38, 20], [20, 38]), side), color);
    if (detail) pen.line(mirror(qbez([24, 2], [30, 20], [17, 31]), side), C.faint);
  }
  pen.line(body, color, true);
  for (const fx of [-9, -5, 5, 9]) pen.line([[fx, 40], [fx, 45]], C.ember);
  // eyes: squinting at your light, wide open, drowsy, then shut
  for (const side of [-1, 1]) {
    const ex = side * 13;
    pen.shape(oval(ex, -12, 10, 10), C.bg, color);
    if (mood === "open") {
      pen.disc(ex, -12, 5, C.core);
      pen.disc(ex, -12, 2.5, C.bg);
    } else if (mood === "drowsy") {
      pen.disc(ex, -9, 4, C.core);
      pen.disc(ex, -9, 2, C.bg);
      pen.fill(oval(ex, -16, 9, 6), C.night);
      pen.line([[ex - 8, -11], [ex + 8, -11]], color);
    } else if (mood === "squint") {
      pen.line([[ex - 6, -12 + side * 2], [ex + 6, -12 - side * 2]], color);
    } else {
      pen.line(qbez([ex - 6, -13], [ex, -7], [ex + 6, -13]), color);
    }
  }
  pen.shape([[-3, -5], [0, 3], [3, -5]], C.dim, color);
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
    return { ...base, ...s, up: { ...base.up, ...(s.up || {}) }, friends: Array.isArray(s.friends) ? s.friends : [] };
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
  owl: {
    names: ["hush", "quill", "sorrel", "fen"],
    plural: "owls",
    hp: 80, rate: 4, burst: 110, y: 92, bullet: "dust",
    jitter: 0.1, bob: 0.3, flap: [0.05, 0.02],
    intro: "an owl sits on a low branch. it squints at your light and does not look happy.",
    acts: [
      { label: "check", lines: [["{name}. an owl, up far too late.", "your light is right in its eyes."]] },
      {
        label: "dim", dims: true, max: 2, gain: 20,
        lines: [["you dim your glow.", "{name} stops squinting quite so hard."], ["you dim yourself even further.", "{name}'s eyes open a little wider."]],
        spent: "any dimmer and you'd go out.",
        say: ["...better.", "...much better."],
      },
      {
        label: "look away", max: 2, gain: 20,
        lines: [["you turn your light away from {name}.", "it ruffles its feathers."], ["you keep your light turned away.", "{name} settles on its branch."]],
        spent: "you're already facing the other way.",
        say: ["...hm.", "...hoo."],
      },
      {
        label: "hoot", need: 45, gain: 40, failGain: 0,
        lines: [["you try your best hoot.", "{name} stares at you for a long time. then it hoots back."]],
        fail: ["you try your best hoot.", "{name} is not impressed."],
        say: ["hoo. hoo."], failSay: "...",
      },
    ],
    talk: [["put that out.", "too bright. too bright.", "it's the middle of the night."], ["...hoo.", "...you're very small.", "...the moon was nicer."], ["...sleepy.", "...hoo... hoo..."]],
    strikeSay: ["!", "rude.", "..."],
    missSay: "...", partSay: "that light won't get far.", restSay: "...the dark is nice with you in it.",
    flavor: [
      ["{name} glares at you, feathers puffed.", "the owl turns its head to keep you in view."],
      ["{name} blinks slowly.", "the owl shifts on its branch."],
      ["{name}'s eyes are half closed.", "the owl looks almost asleep."],
    ],
    hurt: "{name} has lost a lot of feathers.",
    calmed: "{name} doesn't mind you anymore.",
    resting: "{name} is dozing. it's ready to part ways.",
    spare: ["you tip your light toward the path and go.", "a while later, soft wingbeats follow you."],
    fall: ["the owl falls from its branch.", "a few feathers drift down after it."],
    patterns: ["feathers", "swoop", "spiral", "ring"],
  },
};
const ROSTER = ["moth", "firefly", "owl"];

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
const MENU_BOX = { x: 20, y: 186, w: 440, h: 118 };
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
  overReady: false,
  overAt: null,
};
window.ember = G; // handy for poking at from the console (and for the smoke test)

const fill = (str) => str.replaceAll("{name}", G.foe?.name ?? "");

function setScene(name) {
  G.scene = name;
  G.sceneT = 0;
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

const optionRect = (i, n) => ({ x: 20 + (i * 440) / n, y: OPT_Y - 20, w: 440 / n, h: 40 });
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
  pl.x = clamp(pl.x + mx * speed + drag.dx, a.x + 8, a.x + a.w - 8);
  pl.y = clamp(pl.y + my * speed + drag.dy, a.y + 8, a.y + a.h - 8);
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
const owlMood = (calm, blink) => (blink || calm >= 100 ? "shut" : calm >= 70 ? "drowsy" : calm >= 30 ? "open" : "squint");

function foeSprite(key, { frame = 0, lit = 1, mood = "open", color = C.ink, k = 0.5 } = {}) {
  if (key === "moth") return baked(`moth|${frame}|${color}|${k}`, () => bakeMoth(frame, color, k));
  if (key === "firefly") return baked(`firefly|${frame}|${lit}|${color}|${k}`, () => bakeFirefly(frame, lit, color, k));
  return baked(`owl|${mood}|${color}|${k}`, () => bakeOwl(mood, color, k));
}

function drawFoe(f) {
  const pose = foePose(f);
  const flashing = f.flash > 0 && (f.flash >> 1) % 2 === 0;
  const color = flashing ? C.ember : C.ink;
  const k = f.key === "firefly" ? 0.75 : 0.5;
  if (f.key === "firefly" && pose.lit && f.alpha > 0.5) drawGlow(pose.x, pose.y + 21, 16, [C.moss]);
  const spr = foeSprite(f.key, { frame: flapFrame(f.phase), lit: pose.lit, mood: owlMood(f.calm, pose.blink), color, k });
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
    drawSprite(foeSprite("owl", { mood: G.t % 190 < 7 ? "shut" : "squint", color, k: 0.25 }), x, GROUND - 22);
  }
}

function drawMini(key, x, y, frame) {
  const rows = SPR[`${key}${frame ? "B" : "A"}`];
  if (key === "moth") drawBitmap(rows, x, y, { color: C.ink, color3: C.dim, center: true });
  else if (key === "firefly") drawBitmap(rows, x, y, { color: C.ink, color2: frame ? C.moss : C.glim, center: true });
  else drawBitmap(rows, x, y, { color: C.ink, color2: C.core, color3: C.dim, color4: C.ember, center: true });
}

function drawBullets() {
  for (const b of G.bullets) {
    const alpha = b.fade ? 1 - b.fade / 20 : Math.min(1, b.age / 8);
    const o = { center: true, alpha };
    if (b.kind === "moth") {
      drawBitmap(Math.floor(b.age / 6) % 2 ? SPR.bugB : SPR.bugA, b.x, b.y, { ...o, color3: C.dim });
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

// A box with notched corners and a faint inner rule, like an old RPG window.
function drawFrame(b, { inner = true } = {}) {
  const x = snap(b.x);
  const y = snap(b.y);
  const w = snap(b.w);
  const h = snap(b.h);
  ctx.fillStyle = C.bg;
  ctx.fillRect(x + PX, y + PX, w - 2 * PX, h - 2 * PX);
  ctx.fillStyle = C.ink;
  ctx.fillRect(x + PX, y, w - 2 * PX, PX);
  ctx.fillRect(x + PX, y + h - PX, w - 2 * PX, PX);
  ctx.fillRect(x, y + PX, PX, h - 2 * PX);
  ctx.fillRect(x + w - PX, y + PX, PX, h - 2 * PX);
  if (inner && w > 10 * PX && h > 10 * PX) {
    const i = 2 * PX;
    ctx.fillStyle = C.faint;
    ctx.fillRect(x + i, y + i, w - 2 * i, PX);
    ctx.fillRect(x + i, y + h - i - PX, w - 2 * i, PX);
    ctx.fillRect(x + i, y + i, PX, h - 2 * i);
    ctx.fillRect(x + w - i - PX, y + i, PX, h - 2 * i);
  }
  return { x, y, w, h, inset: inner ? 3 * PX : PX };
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

function drawOptionRow(labels, sel, active, { ready = [], off = [], counts = {} } = {}) {
  labels.forEach((label, i) => {
    const r = optionRect(i, labels.length);
    const cx = r.x + r.w / 2;
    const isSel = active && sel === i;
    const color = ready[i] ? C.ember : isSel ? C.ink : C.dim;
    const alpha = active ? (off[i] && !isSel ? 0.5 : 1) : 0.4;
    const tw = textWidth(label);
    text(label, cx, OPT_Y, { color, align: "center", base: "middle", alpha });
    if (counts[i] != null) text(String(counts[i]), cx + tw / 2 + 6, OPT_Y - 8, { color: C.dim, base: "middle", alpha });
    if (isSel) drawBitmap(SPR.pick, cx - tw / 2 - 12, OPT_Y, { color: C.ember, center: true, alpha });
  });
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

function drawSoundIcon() {
  drawBitmap(muted ? SPR.soundOff : SPR.soundOn, W - 26, 20, { color: C.dim, center: true, alpha: 0.8 });
}

/* --- title & intro ------------------------------------------------------- */
function drawTitle() {
  emberGlow(W / 2, 164, 1.7);
  text("ember", W / 2, 66, { scale: 4, align: "center", spacing: 1 });
  drawEmber(W / 2, 164, { scale: 2 });
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
  text("arrows move · z ok · x back · m sound", W / 2, 392, { color: C.dim, align: "center" });
}

function drawIntro() {
  emberGlow(W / 2, 200, 1.2);
  drawEmber(W / 2, 200);
  drawStack(G.dialog, 250);
  if (G.dialog?.full) drawNext(W - 28, H - 28);
}

/* --- the path ------------------------------------------------------------ */
function drawHub() {
  if (G.box.y > 200) drawPath(); // the campfire and friends panels cover the path

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
    else if (G.dialog) drawTyped(G.dialog.text, G.dialog.n, b.x + 22, b.y + 20, HUB_BOX.w - 44, 24);
  });

  drawOptionRow(HUB_OPTS, G.hubPhase === "camp" ? 1 : G.hubPhase === "friends" ? 2 : G.hubSel, true, {
    ready: [arrived()],
    off: [!arrived()],
  });
}

const ridgeY = (wx) => snap(172 + Math.sin(wx * 0.013) * 7 + Math.sin(wx * 0.041) * 3);

function drawPath() {
  const off = S.dist * PX_PER_M;
  const far = off * 0.3;

  drawGlow(338, 104, 12, [C.night]);
  drawSprite(baked("moon", bakeMoon), 338, 104);

  // far hills with pines, scrolling slower than the ground
  for (let x = 0; x < W; x += PX) {
    const y = ridgeY(x + far);
    ctx.fillStyle = C.night;
    ctx.fillRect(x, y, PX, GROUND - y);
    ctx.fillStyle = C.faint;
    ctx.fillRect(x, y, PX, PX);
  }
  const tcell = 46;
  for (let c = Math.floor(far / tcell) - 1; c <= Math.floor((far + W) / tcell) + 1; c++) {
    if (hash(c + 7.7) > 0.5) continue;
    const x = snap(c * tcell - far + hash(c + 3.1) * 30);
    drawBitmap(SPR.pine, x, ridgeY(x + far) - 10, { color: C.faint });
  }

  const walking = !arrived() && !REDUCED;
  const bob = walking ? -Math.round(Math.abs(Math.sin(G.walkT * 0.18)) * 2) * PX : 0;
  const ey = GROUND - 14 + bob;
  emberGlow(WALK_X, ey);

  // the path itself, with pebbles and grass placed by distance
  ctx.fillStyle = C.dim;
  ctx.fillRect(0, GROUND, W, PX);
  const cell = 34;
  for (let c = Math.floor(off / cell) - 1; c <= Math.floor((off + W) / cell) + 1; c++) {
    const h = hash(c);
    const x = snap(c * cell - off + hash(c + 0.5) * 20);
    if (h < 0.3) {
      ctx.fillStyle = C.dim;
      ctx.fillRect(x, GROUND + 6, 4, 2);
    } else if (h < 0.55) {
      ctx.fillStyle = C.dim;
      ctx.fillRect(x, GROUND - 4, 2, 4);
      ctx.fillRect(x + 4, GROUND - 6, 2, 6);
      ctx.fillRect(x + 8, GROUND - 4, 2, 4);
    } else if (h < 0.65) {
      ctx.fillStyle = C.faint;
      ctx.fillRect(x, GROUND + 12, 6, 2);
    }
  }

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
  if (S.friends.length > 8) text(`+${S.friends.length - 8}`, WALK_X - 32 - 8 * 30, GROUND - 30, { color: C.dim, align: "center" });

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
    if (sel) drawBitmap(SPR.pick, b.x + 20, y + 7, { color: C.ember, center: true });
    text(u.label, b.x + 34, y, { color: sel ? C.ink : C.dim });
    text(u.desc, b.x + 34, y + 18, { color: C.dim });
    let costColor = maxed ? C.dim : S.warmth >= cost ? C.ember : C.dim;
    if (flash) costColor = G.campFlash.ok ? C.core : C.faint;
    text(maxed ? "max" : fmt(cost), b.x + b.w - 20, y, { color: costColor, align: "right" });
    text(`lv ${level}`, b.x + b.w - 20, y + 18, { color: C.dim, align: "right" });
  });
}

function drawFriends(b) {
  let y = b.y + 18;
  text("following you", b.x + 20, y, { color: C.dim });
  y += 26;
  if (!S.friends.length) {
    drawTyped("no one yet. spare someone on the path and they'll follow your light.", 999, b.x + 20, y, b.w - 40, 22);
    return;
  }
  for (const key of ROSTER) {
    const list = S.friends.filter((f) => f.key === key);
    if (!list.length) continue;
    drawMini(key, b.x + 28, y + 6, Math.floor(G.t / 9) % 2);
    text(`${SPECIES[key].plural} ${list.length}`, b.x + 48, y);
    text(`+${fmtRate(list.reduce((s, f) => s + f.rate, 0))} / s`, b.x + b.w - 20, y, { color: C.ember, align: "right" });
    y += 18;
    const names = list.length > 6 ? `${list.slice(-6).map((f) => f.name).join(", ")} and ${list.length - 6} more` : list.map((f) => f.name).join(", ");
    y += drawTyped(names, 999, b.x + 48, y, b.w - 68, 18, { color: C.dim }) * 18 + 12;
  }
  text("your own glow", b.x + 48, y);
  text(`+${fmtRate(ownGlow())} / s`, b.x + b.w - 20, y, { color: C.ember, align: "right" });
}

/* --- battle -------------------------------------------------------------- */
function drawBattle() {
  const f = G.foe;
  const pose = drawFoe(f);

  if (G.slash) {
    const t = G.slash.t;
    const grow = clamp(t / 8, 0, 1);
    ctx.globalAlpha = t < 10 ? 1 : 1 - (t - 10) / 16;
    pixelLine(pose.x + 56, pose.y - 50, pose.x + 56 - 112 * grow, pose.y - 50 + 100 * grow, C.ember, 2);
    ctx.globalAlpha = 1;
  }

  const inArena = G.phase === "enemy" || G.phase === "dodge";
  if (f.barT > 0) {
    ctx.globalAlpha = Math.min(1, f.barT / 20);
    ctx.fillStyle = C.faint;
    ctx.fillRect(190, 166, 100, 4);
    ctx.fillStyle = C.ink;
    ctx.fillRect(190, 166, snap(100 * (f.shown / f.max)), 4);
    ctx.globalAlpha = 1;
  } else if (!inArena && !f.dead) {
    text(f.name, 240, 158, { color: f.calm >= 100 ? C.ember : C.dim, align: "center", spacing: 1 });
  }

  const b = drawFrame(G.box, { inner: !inArena });
  withClip(b, () => {
    if (G.phase === "menu" || G.phase === "result") {
      const d = G.dialog;
      if (d) {
        drawTyped(d.text, d.n, b.x + 22, b.y + 20, MENU_BOX.w - 44, 24);
        if (G.phase === "result" && d.full) drawNext(b.x + b.w - 22, b.y + b.h - 16);
      }
    } else if (G.phase === "talk") {
      drawActs(b);
    } else if (G.phase === "strike") {
      drawStrike(b);
    } else {
      drawArena();
    }
  });

  drawHud();
  drawOptionRow(MENU, G.menu, G.phase === "menu" || G.phase === "talk", {
    ready: [false, false, false, f.calm >= 100],
    counts: { 2: G.mends },
  });
  drawBubble();
}

function drawActs(b) {
  G.foe.sp.acts.forEach((a, i) => {
    const r = actRect(i);
    const sel = G.act === i;
    if (sel) drawBitmap(SPR.pick, r.x - 16, r.y + 7, { color: C.ember, center: true });
    text(a.label, r.x, r.y, { color: sel ? C.ink : C.dim, alpha: actSpent(i) ? 0.45 : 1 });
  });
  text("x back", b.x + b.w - 18, b.y + b.h - 24, { color: C.dim, align: "right" });
}

function drawStrike(b) {
  const s = G.strike;
  if (!s) return;
  const x0 = b.x + 40;
  const x1 = b.x + b.w - 40;
  const cy = snap(b.y + b.h / 2 + 10);
  text("stop the line at the center", b.x + b.w / 2, b.y + 18, { color: C.dim, align: "center" });
  ctx.fillStyle = C.faint;
  ctx.fillRect(x0, cy, x1 - x0, PX);
  for (let i = 0; i <= 10; i++) {
    const x = snap(lerp(x0, x1, i / 10));
    const h = i === 5 ? 24 : 8;
    ctx.fillStyle = i === 5 ? C.ember : C.dim;
    ctx.fillRect(x, cy - h / 2 + 1, PX, h);
  }
  const cx = snap(lerp(x0, x1, s.x));
  ctx.fillStyle = s.stopped && (s.hold >> 2) % 2 === 0 ? C.ember : C.ink;
  ctx.fillRect(cx - 2, cy - 20, 4, 42);
}

function drawArena() {
  const p = G.player;
  emberGlow(p.x, p.y, 0.8 - G.dimmed * 0.2);
  if (G.phase === "dodge" && G.pattern === "spiral" && G.patT >= 0) {
    const a = G.boxTarget;
    drawSprite(baked("ring|4", () => bakeRing(4, C.dim)), a.x + a.w / 2, a.y + a.h / 2);
  }
  drawBullets();
  const blink = p.inv > 0 && (p.inv >> 2) % 2 === 0;
  if (!blink) drawEmber(p.x, p.y);
}

function drawHud() {
  text("ember", 20, HUD_Y, { base: "middle" });
  text("hp", 94, HUD_Y, { color: C.dim, base: "middle" });
  const bx = 128;
  const bw = 96;
  ctx.fillStyle = C.faint;
  ctx.fillRect(bx, HUD_Y - 4, bw, 8);
  ctx.fillStyle = G.hp <= G.maxHp * 0.3 ? C.ember : C.ink;
  ctx.fillRect(bx, HUD_Y - 4, snap((bw * G.hp) / G.maxHp), 8);
  text(`${G.hp} / ${G.maxHp}`, bx + bw + 12, HUD_Y, { base: "middle" });
}

function drawBubble() {
  const d = G.bubble;
  if (!d) return;
  const lines = wrap(d.text, 120);
  const bx = 330;
  const by = 40;
  const bw = 140;
  const bh = 22 + lines.length * 20;
  drawFrame({ x: bx, y: by, w: bw, h: bh }, { inner: false });
  // a little tail pointing at the creature
  ctx.fillStyle = C.ink;
  for (let i = 0; i < 5; i++) ctx.fillRect(bx - 2 - i * 2, by + 14 + i * 2, 2, 2);
  for (let i = 0; i < 5; i++) ctx.fillRect(bx - 2 - i * 2, by + 30 - i * 2, 2, 2);
  drawTyped(d.text, d.n, bx + 12, by + 12, 120, 20);
}

/* --- losing -------------------------------------------------------------- */
function drawOver() {
  if (G.sceneT < 30 && G.overAt) {
    emberGlow(G.overAt.x, G.overAt.y, 1 - G.sceneT / 30);
    drawEmber(G.overAt.x, G.overAt.y, { alpha: 1 - G.sceneT / 30 });
  }
  const y = drawStack(G.dialog, 180);
  if (G.overReady) text("z to keep going", W / 2, y + 34, { color: C.ember, align: "center", alpha: pulse() });
}

function drawParticles() {
  for (const p of G.particles) {
    ctx.globalAlpha = 1 - p.age / p.life;
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
  ctx.setTransform(1 / PX, 0, 0, 1 / PX, 0, 0);
  ctx.imageSmoothingEnabled = false;
  ctx.fillStyle = C.bg;
  ctx.fillRect(0, 0, W, H);

  ctx.save();
  if (G.shake > 0) ctx.translate(snap(rand(-1, 1) * G.shake), snap(rand(-1, 1) * G.shake));
  drawStars();
  switch (G.scene) {
    case "title": drawTitle(); break;
    case "intro": drawIntro(); break;
    case "hub": drawHub(); break;
    case "battle": drawBattle(); break;
    case "over": drawOver(); break;
  }
  drawParticles();
  drawFloaters();
  ctx.restore();

  if (G.fade > 0) {
    ctx.globalAlpha = G.fade;
    ctx.fillStyle = C.bg;
    ctx.fillRect(0, 0, W, H);
    ctx.globalAlpha = 1;
  }
  drawSoundIcon();
  present();
}

/* ----------------------------------------------------------------------- */
/* The complete sprite sheet: open the page with #sprites to see it, or    */
/* run export-sprites.mjs to save it as files                              */
/* ----------------------------------------------------------------------- */
const WINGS = ["wings-open", "wings-mid", "wings-up"];
const OWL_MOODS = [["squint", "squint"], ["open", "awake"], ["drowsy", "drowsy"], ["shut", "asleep"]];
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

  const owl = group("owl", "squinting at your light, awake, drowsy, asleep · then the hit flash");
  for (const color of [C.ink, C.ember]) OWL_MOODS.forEach(([mood, label]) => owl(label + hit(color), foeSprite("owl", { mood, color })));

  const path = group("path", "waiting up ahead: still far off (grey), then close");
  for (const color of [C.dim, C.ink]) {
    const far = color === C.dim ? "-far" : "";
    WINGS.forEach((w, f) => path(`moth-${w}${far}`, foeSprite("moth", { frame: f, color, k: 0.25 })));
    for (const lit of [1, 0]) WINGS.forEach((w, f) => path(`firefly-${w}-${lit ? "lit" : "dark"}${far}`, foeSprite("firefly", { frame: f, lit, color, k: 0.4 })));
    path(`owl-squint${far}`, foeSprite("owl", { mood: "squint", color, k: 0.25 }));
    path(`owl-blink${far}`, foeSprite("owl", { mood: "shut", color, k: 0.25 }));
  }

  const friends = group("friends", "following you, two frames each");
  friends("moth-a", bmp(SPR.mothA, [C.ink, C.ink, C.dim]));
  friends("moth-b", bmp(SPR.mothB, [C.ink, C.ink, C.dim]));
  friends("firefly-a", bmp(SPR.fireflyA, [C.ink, C.glim]));
  friends("firefly-b", bmp(SPR.fireflyB, [C.ink, C.moss]));
  friends("owl-a", bmp(SPR.owlA, [C.ink, C.core, C.dim, C.ember]));
  friends("owl-blink", bmp(SPR.owlB, [C.ink, C.core, C.dim, C.ember]));

  const you = group("ember", "you: three flicker frames, then twice the size for the title");
  SPR.ember.forEach((rows, i) => you(`flicker-${i + 1}`, bmp(rows, [C.ember, C.core])));
  SPR.ember.forEach((rows, i) => you(`title-${i + 1}`, bmp(rows, [C.ember, C.core], 2)));

  const atk = group("attacks", "dust, spark, firefly, feathers, little moth, warning flash");
  atk("dust-small", bmp(SPR.dustS, [C.ink]));
  atk("dust-large", bmp(SPR.dustL, [C.ink]));
  atk("spark", bmp(SPR.spark, [C.ink, C.core]));
  atk("firefly-lit", bmp(SPR.fly, [C.ink, C.glim]));
  atk("firefly-dark", bmp(SPR.fly, [C.ink, C.dim]));
  atk("feather-left", bmp(SPR.featherL, [C.ink]));
  atk("feather-flat", bmp(SPR.featherF, [C.ink]));
  atk("feather-right", bmp(SPR.featherR, [C.ink]));
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
  scenery("pine", bmp(SPR.pine, [C.faint]));

  const ui = group("ui", "menu pick, next, sound on, sound off");
  ui("pick", bmp(SPR.pick, [C.ember]));
  ui("next", bmp(SPR.next, [C.dim]));
  ui("sound-on", bmp(SPR.soundOn, [C.dim]));
  ui("sound-off", bmp(SPR.soundOff, [C.dim]));

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
/* Loop                                                                    */
/* ----------------------------------------------------------------------- */
function update() {
  G.t++;
  G.sceneT++;
  if (pressed.has("mute")) toggleMute();
  for (let i = taps.length - 1; i >= 0; i--) {
    if (taps[i].x > W - 44 && taps[i].y < 40) {
      toggleMute();
      taps.splice(i, 1);
    }
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
