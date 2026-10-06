// Vegetation — every tree, food plant, rock, log and grass tuft on the island.
//
// Look: naturalistic, not low-poly. Trees are smooth tapered trunks (bark from
// a procedural atlas strip) carrying alpha-cut foliage cards — araucaria
// needle-ropes, layered fir sprays, ginkgo fan-leaf clusters, arching tree-fern
// fronds — whose normals are bent outward from the canopy centre so the crowns
// light like soft volumes instead of flat planes. Everything that sways shares
// one vertex hook (`uTime`, wind vector, per-instance phase from position).
//
// Cost: every plant type is ONE InstancedMesh and every foliage/bark surface
// samples ONE mip-mapped atlas through ONE material, so a whole forest is a
// handful of draw calls (≈19 + shadow casters). Trees and rocks have two LODs
// (detailed near the focus, simplified far away); the per-chunk instance lists
// are rebuilt only when the focus has moved ~12 m. The hand-over is per
// instance, at its own hashed distance inside the LOD band: for a few metres
// the far version is drawn around a slightly shrunken near one, then the near
// one goes — never a screen-door dither, which reads as dotted noise (and turns
// into chunky noise in the pixel style). Food plants, logs, grass and
// forest-floor undergrowth shrink to nothing at the edge of their radius.
//
// Shadows: foliage casts through a custom depth material (subclass of
// MeshDepthMaterial so three's internal per-material clone keeps the wind hook)
// that alpha-tests the same atlas, so canopies throw dappled, swaying shadows.
//
// Placement is seeded and biome-driven (jittered grids + noise masks for
// clearings, groves and species patches); colliders and food plants live in
// flat spatial hashes for the gameplay queries in the contract.

import * as THREE from "three";
import { makeRng, rand, hash, weightedPick } from "../core/rng.js";
import { TAU, clamp, lerp, smoothstep, damp } from "../core/math.js";
import { createNoise2D, fbm2D } from "../core/noise.js";

/* --- Tuning ---------------------------------------------------------------- */

/** Food plant defaults (kg) and regrowth as a fraction of maxFood per second. */
const PLANT_DEFS = {
  fern: { maxFood: 40, regrow: 0.018 },
  horsetail: { maxFood: 60, regrow: 0.016 },
  shrub: { maxFood: 80, regrow: 0.013 },
  cycad: { maxFood: 140, regrow: 0.011 },
};
const PLANT_KINDS = ["fern", "cycad", "horsetail", "shrub"];
/** Seconds after the last bite before a plant starts to regrow. */
const REGROW_DELAY = 10;
/** Visual scale of a fully eaten plant (a stub) relative to its full size. */
const EATEN_SCALE = 0.26;

const TREE_KINDS = ["araucaria", "podocarp", "ginkgo", "treefern", "snag"];
/** Nominal (instance-scale 1) heights in metres. */
const TREE_H = { araucaria: 26, podocarp: 19, ginkgo: 15, treefern: 6.5, snag: 11.5 };

const HASH_CELL = 16; // spatial hash cell (m) for colliders and plants
const LOD_CHUNK = 32; // trees / rocks are bucketed into chunks this big for LOD lists
const LOD_REBUILD = 12; // rebuild LOD lists after the focus moves this far (m)
const FAR_VIEW_MARGIN = 48; // m of slack around the frustum / fog end for far-LOD lists
const FAR_TOP = 42; // m above its base a far-LOD instance can reach (chunk boxes for view tests)

/* --- Atlas layout ------------------------------------------------------------ */

// One square atlas (2048² high / 1024² low). Fractions of the atlas, y from the
// top (the DataTexture is uploaded unflipped, so v = y). Two bark strips run the
// full height on the left (they tile vertically via RepeatWrapping on T), the
// rest is a 3 × 4 grid of foliage cards.
const STRIP = 0.125;
const card = (c, r) => ({ x: 0.25 + c * 0.25, y: r * 0.25, w: 0.25, h: 0.25 });
const REG = {
  barkA: { x: 0, y: 0, w: STRIP, h: 1 }, // plated conifer bark (also logs, snags)
  barkB: { x: STRIP, y: 0, w: STRIP, h: 1 }, // fibrous tree-fern / cycad trunk
  araucaria: card(0, 0),
  fir: card(1, 0),
  broadleaf: card(2, 0),
  treefern: card(0, 1),
  fern: card(1, 1),
  cycad: card(2, 1),
  horsetail: card(0, 2),
  shrub: card(1, 2),
  deadfrond: card(2, 2),
  grass: card(0, 3),
  grassDry: card(1, 3),
  herb: card(2, 3),
};
const CARD_KEYS = Object.keys(REG).filter((k) => !k.startsWith("bark"));

/* --- Canvas helpers ------------------------------------------------------------ */

function makeCanvas(w, h) {
  if (typeof document !== "undefined") {
    const c = document.createElement("canvas");
    c.width = w;
    c.height = h;
    return c;
  }
  return new OffscreenCanvas(w, h);
}

const hsl = (h, s, l, a = 1) => `hsla(${h.toFixed(1)},${s.toFixed(1)}%,${l.toFixed(1)}%,${a})`;

/** A palette of `n` fill styles from dark to light — drawing is batched per entry. */
function ramp(n, h0, h1, s0, s1, l0, l1, a = 1) {
  const out = [];
  for (let i = 0; i < n; i++) {
    const t = n === 1 ? 0.5 : i / (n - 1);
    out.push(hsl(lerp(h0, h1, t), lerp(s0, s1, t), lerp(l0, l1, t), a));
  }
  return out;
}

/**
 * Path buckets: shapes are appended to one Path2D per colour and filled (or
 * stroked) in palette order at the end. Thousands of leaflets cost a dozen
 * canvas calls, and darker buckets end up underneath the lighter ones.
 */
class Buckets {
  constructor(styles) {
    this.styles = styles;
    this.paths = styles.map(() => new Path2D());
  }
  get(i) {
    return this.paths[clamp(i | 0, 0, this.paths.length - 1)];
  }
  pick(t) {
    return this.get(Math.floor(clamp(t, 0, 0.999) * this.paths.length));
  }
  fill(ctx) {
    for (let i = 0; i < this.paths.length; i++) {
      ctx.fillStyle = this.styles[i];
      ctx.fill(this.paths[i]);
    }
  }
  stroke(ctx, width) {
    ctx.lineWidth = width;
    ctx.lineCap = "round";
    ctx.lineJoin = "round";
    for (let i = 0; i < this.paths.length; i++) {
      ctx.strokeStyle = this.styles[i];
      ctx.stroke(this.paths[i]);
    }
  }
}

/** Lanceolate leaf from (x, y) pointing along `ang`, into a Path2D. */
function leafPath(p, x, y, ang, len, wid, tipBias = 0.42) {
  const c = Math.cos(ang);
  const s = Math.sin(ang);
  const mx = x + c * len * tipBias;
  const my = y + s * len * tipBias;
  const tx = x + c * len;
  const ty = y + s * len;
  p.moveTo(x, y);
  p.quadraticCurveTo(mx - s * wid, my + c * wid, tx, ty);
  p.quadraticCurveTo(mx + s * wid, my - c * wid, x, y);
  p.closePath();
}

/** Sharp scale-leaf (triangle with a slightly convex base) — araucaria. */
function scalePath(p, x, y, ang, len, wid) {
  const c = Math.cos(ang);
  const s = Math.sin(ang);
  p.moveTo(x - s * wid, y + c * wid);
  p.quadraticCurveTo(x + c * len * 0.55 - s * wid * 0.7, y + s * len * 0.55 + c * wid * 0.7, x + c * len, y + s * len);
  p.quadraticCurveTo(x + c * len * 0.55 + s * wid * 0.7, y + s * len * 0.55 - c * wid * 0.7, x + s * wid, y - c * wid);
  p.closePath();
}

function linePath(p, x0, y0, x1, y1) {
  p.moveTo(x0, y0);
  p.lineTo(x1, y1);
}

/* --- Bark ---------------------------------------------------------------------- */

// Both bark strips tile horizontally (around the trunk) and vertically: every
// mark is drawn at its position and wrapped copies, clipped to the strip.
function wrapDraw(ctx, r, fn) {
  ctx.save();
  ctx.beginPath();
  ctx.rect(r.x, r.y, r.w, r.h);
  ctx.clip();
  for (const ox of [-r.w, 0, r.w]) {
    for (const oy of [-r.h, 0, r.h]) fn(ox, oy);
  }
  ctx.restore();
}

function drawBarkPlated(ctx, rng, r) {
  const k = r.w / 256;
  ctx.fillStyle = "#463b31";
  ctx.fillRect(r.x, r.y, r.w, r.h);
  // Broad tonal blotches so the trunk never looks flat.
  const blots = [];
  for (let i = 0; i < 80; i++) {
    blots.push([r.x + rng() * r.w, r.y + rng() * r.h, rand(rng, 20, 90) * k, rand(rng, 60, 220) * k,
      hsl(rand(rng, 20, 36), rand(rng, 8, 20), rand(rng, 20, 36), 0.3)]);
  }
  wrapDraw(ctx, r, (ox, oy) => {
    for (const [x, y, rx, ry, c] of blots) {
      ctx.fillStyle = c;
      ctx.beginPath();
      ctx.ellipse(x + ox, y + oy, rx, ry, 0, 0, TAU);
      ctx.fill();
    }
  });
  ctx.save();
  ctx.beginPath();
  ctx.rect(r.x, r.y, r.w, r.h);
  ctx.clip();
  // Narrow ridges broken into short plates: lighter, slightly varied.
  const cols = 13;
  const colW = r.w / cols;
  const plates = new Buckets(ramp(6, 22, 32, 10, 18, 27, 40));
  const cracks = new Buckets(["rgba(20,15,11,0.75)"]);
  for (let c = 0; c < cols; c++) {
    let y = rng() * 40 * k;
    while (y < r.h) {
      const len = rand(rng, 18, 64) * k;
      const w = colW * rand(rng, 0.55, 0.85);
      const x0 = c * colW + (colW - w) * rng();
      const t = rng();
      for (const ox of [-r.w, 0, r.w]) {
        for (const oy of [-r.h, 0]) {
          const px = r.x + x0 + ox;
          const py = r.y + y + oy;
          const p = plates.pick(t);
          const j = rand(rng, -2, 2) * k;
          p.moveTo(px + w * 0.2, py);
          p.lineTo(px + w * 0.85 + j, py + len * 0.08);
          p.lineTo(px + w + j, py + len * 0.7);
          p.lineTo(px + w * 0.8, py + len);
          p.lineTo(px + w * 0.12 - j, py + len * 0.94);
          p.lineTo(px - j, py + len * 0.35);
          p.closePath();
          linePath(cracks.get(0), px + w * 0.1, py + len + 1.5 * k, px + w * 0.9, py + len + 1.5 * k);
        }
      }
      y += len + rand(rng, 2, 7) * k;
    }
  }
  plates.fill(ctx);
  cracks.stroke(ctx, 2.2 * k);
  // Deep vertical furrows, wandering but periodic in y so the strip tiles.
  const fur = new Buckets(["rgba(18,13,10,0.85)", "rgba(28,21,16,0.7)"]);
  for (let c = 0; c < cols; c++) {
    const x0 = c * colW;
    const kx = 1 + ((rng() * 3) | 0);
    const ph = rng() * TAU;
    const amp = rand(rng, 2, 6) * k;
    for (const ox of [-r.w, 0, r.w]) {
      const p = fur.get(c % 2);
      for (let i = 0; i <= 64; i++) {
        const yy = (i / 64) * r.h;
        const xx = r.x + ox + x0 + Math.sin((yy / r.h) * TAU * kx + ph) * amp;
        if (i === 0) p.moveTo(xx, r.y + yy);
        else p.lineTo(xx, r.y + yy);
      }
    }
  }
  fur.stroke(ctx, 3.4 * k);
  // Fine fibres.
  const fib = new Buckets(["rgba(20,15,12,0.3)", "rgba(130,112,92,0.18)"]);
  for (let i = 0; i < 900; i++) {
    const x = r.x + rng() * r.w;
    const y = r.y + rng() * r.h;
    const l = rand(rng, 6, 30) * k;
    linePath(fib.get(rng() < 0.6 ? 0 : 1), x, y, x + rand(rng, -1.5, 1.5) * k, y + l);
  }
  fib.stroke(ctx, 1.3 * k);
  // Sparse lichen.
  const lich = new Buckets(["rgba(150,158,120,0.3)", "rgba(178,170,130,0.26)"]);
  for (let i = 0; i < 140; i++) {
    const p = lich.get(rng() < 0.5 ? 0 : 1);
    const x = r.x + rng() * r.w;
    const y = r.y + rng() * r.h;
    const rr = rand(rng, 1.5, 5) * k;
    p.moveTo(x + rr, y);
    p.ellipse(x, y, rr, rr * 0.8, 0, 0, TAU);
  }
  lich.fill(ctx);
  ctx.restore();
}

function drawBarkFibrous(ctx, rng, r) {
  const k = r.w / 256;
  ctx.fillStyle = "#35291f";
  ctx.fillRect(r.x, r.y, r.w, r.h);
  // Helical lattice of leaf-base scars (tree ferns, cycads).
  const scar = new Buckets(ramp(5, 22, 32, 18, 26, 19, 29));
  const rim = new Buckets(["rgba(16,11,8,0.5)"]);
  const rowH = 30 * k;
  const perRow = 6;
  const rows = Math.round(r.h / rowH);
  const dy = r.h / rows;
  for (let row = 0; row < rows; row++) {
    for (let j = 0; j < perRow; j++) {
      const cx = ((j + (row % 2) * 0.5) / perRow) * r.w + rand(rng, -4, 4) * k;
      const cy = row * dy + rand(rng, -3, 3) * k;
      const hw = (r.w / perRow) * rand(rng, 0.34, 0.44);
      const hh = dy * rand(rng, 0.5, 0.62);
      const t = rng();
      for (const ox of [-r.w, 0, r.w]) {
        for (const oy of [-r.h, 0, r.h]) {
          const x = r.x + cx + ox;
          const y = r.y + cy + oy;
          const p = scar.pick(t);
          p.moveTo(x, y - hh);
          p.quadraticCurveTo(x + hw * 0.9, y - hh * 0.2, x + hw, y);
          p.quadraticCurveTo(x + hw * 0.6, y + hh * 0.7, x, y + hh);
          p.quadraticCurveTo(x - hw * 0.6, y + hh * 0.7, x - hw, y);
          p.quadraticCurveTo(x - hw * 0.9, y - hh * 0.2, x, y - hh);
          p.closePath();
          const q = rim.get(0);
          q.moveTo(x - hw * 0.5, y + hh * 0.35);
          q.quadraticCurveTo(x, y + hh * 0.75, x + hw * 0.5, y + hh * 0.35);
        }
      }
    }
  }
  ctx.save();
  ctx.beginPath();
  ctx.rect(r.x, r.y, r.w, r.h);
  ctx.clip();
  scar.fill(ctx);
  rim.stroke(ctx, 2 * k);
  // Matted fibrous roots / hairs over everything.
  const hair = new Buckets(["rgba(16,11,8,0.5)", "rgba(92,70,48,0.3)", "rgba(60,44,30,0.45)"]);
  for (let i = 0; i < 1700; i++) {
    const x = r.x + rng() * r.w;
    const y = r.y + rng() * r.h;
    const l = rand(rng, 8, 30) * k;
    const a = Math.PI / 2 + rand(rng, -0.5, 0.5);
    const p = hair.get((rng() * 3) | 0);
    p.moveTo(x, y);
    p.quadraticCurveTo(x + Math.cos(a) * l * 0.5 + rand(rng, -4, 4) * k, y + Math.sin(a) * l * 0.5, x + Math.cos(a) * l, y + Math.sin(a) * l);
  }
  hair.stroke(ctx, 1.4 * k);
  ctx.restore();
}

/* --- Foliage cards ---------------------------------------------------------------- */

// All card pictures leave a margin so mip levels never bleed into neighbours.
// "Along" pictures run base (left) → tip (right) on the horizontal centre line;
// "up" pictures grow from the bottom edge.

function drawAraucaria(ctx, rng, r) {
  const k = r.h / 512;
  const x0 = r.x + r.w * 0.03;
  const x1 = r.x + r.w * 0.96;
  const cy = r.y + r.h * 0.5;
  const stemY = (s) => cy - Math.sin(s * Math.PI) * r.h * 0.025;
  const leaves = new Buckets(ramp(7, 110, 92, 28, 40, 16, 38));
  const rope = (sx, sy, ang, len, thick, n) => {
    const c = Math.cos(ang);
    const s = Math.sin(ang);
    for (let i = 0; i < n; i++) {
      const t = Math.pow(rng(), 0.85);
      const th = thick * (1 - 0.5 * t) * Math.min(1, 0.35 + t * 6);
      const off = (rng() * 2 - 1) * th * 0.5;
      const x = sx + c * len * t - s * off;
      const y = sy + s * len * t + c * off;
      const a = ang + (rng() * 2 - 1) * 1.05 + (off / th) * 0.7;
      const l = th * rand(rng, 0.75, 1.15);
      // Leaves on the rope's flanks are darker (self-shadowed), the crest lighter.
      const shade = clamp(0.62 - Math.abs(off / th) * 0.7 + rand(rng, -0.25, 0.3) + t * 0.15, 0, 0.999);
      scalePath(leaves.pick(shade), x, y, a, l, l * 0.24);
    }
  };
  // Side branchlets first so the main rope overlaps them.
  for (let i = 0; i < 9; i++) {
    const s0 = rand(rng, 0.22, 0.85);
    const side = i % 2 ? 1 : -1;
    const sx = lerp(x0, x1, s0);
    rope(sx, stemY(s0), side * rand(rng, 0.5, 0.85), r.w * rand(rng, 0.14, 0.26), r.h * 0.11, 220);
  }
  for (let i = 0; i < 1900; i++) {
    const s = Math.pow(rng(), 0.92);
    const th = r.h * 0.2 * (1 - 0.45 * s) * Math.min(1, 0.4 + s * 8);
    const off = (rng() * 2 - 1) * th * 0.55;
    const x = lerp(x0, x1, s);
    const y = stemY(s) + off;
    const a = (rng() * 2 - 1) * 1.1 + (off / th) * 0.8;
    const l = th * rand(rng, 0.7, 1.1);
    const shade = clamp(0.6 - Math.abs(off / th) * 0.75 + rand(rng, -0.25, 0.3) + s * 0.12, 0, 0.999);
    scalePath(leaves.pick(shade), x, y, a, l, l * 0.24);
  }
  // Rounded growing tip.
  rope(x1 - r.w * 0.04, stemY(0.98), 0, r.w * 0.05, r.h * 0.07, 60);
  leaves.fill(ctx);
}

function drawFir(ctx, rng, r) {
  const k = r.h / 512;
  const x0 = r.x + r.w * 0.03;
  const x1 = r.x + r.w * 0.97;
  const cy = r.y + r.h * 0.5;
  const needles = new Buckets(ramp(6, 150, 128, 22, 30, 11, 26));
  const tips = new Buckets(ramp(3, 98, 88, 34, 40, 28, 38));
  const twig = new Buckets(["#3a2e22"]);
  const needleRow = (x, y, ang, len, nl, density, tipFrac) => {
    const c = Math.cos(ang);
    const s = Math.sin(ang);
    const n = Math.max(3, Math.round(len / (density * k)));
    for (let i = 0; i < n; i++) {
      const t = i / n;
      const px = x + c * len * t;
      const py = y + s * len * t;
      const l = nl * k * (1 - t * 0.45) * rand(rng, 0.8, 1.15);
      const fresh = t > 1 - tipFrac;
      for (const side of [-1, 1]) {
        const a = ang + side * rand(rng, 0.85, 1.25);
        const b = fresh ? tips.pick(rng()) : needles.pick(rng() * 0.75 + t * 0.25);
        linePath(b, px, py, px + Math.cos(a) * l, py + Math.sin(a) * l);
      }
    }
    linePath(twig.get(0), x, y, x + c * len, y + s * len);
  };
  // Main shoot with alternating branchlets that shorten toward the tip.
  const n = 11;
  for (let i = 0; i < n; i++) {
    const s = 0.06 + (i / n) * 0.84;
    for (const side of [-1, 1]) {
      const off = side === 1 ? 0 : 0.035;
      const sx = lerp(x0, x1, s + off);
      const len = r.h * 0.4 * (1 - s * 0.6) * rand(rng, 0.85, 1.1);
      const ang = side * rand(rng, 0.75, 1.0);
      needleRow(sx, cy, ang, len, 19, 4.2, 0.25);
      // Secondary twigs on the longer branchlets.
      if (len > r.h * 0.22) {
        for (let j = 0; j < 2; j++) {
          const t = rand(rng, 0.3, 0.6);
          const px = sx + Math.cos(ang) * len * t;
          const py = cy + Math.sin(ang) * len * t;
          needleRow(px, py, ang + (j ? 0.7 : -0.7), len * 0.38, 14, 4.6, 0.3);
        }
      }
    }
  }
  needleRow(x0, cy, 0, x1 - x0, 20, 4, 0.12);
  ctx.lineCap = "round";
  twig.stroke(ctx, 3.2 * k);
  needles.stroke(ctx, 3.4 * k);
  tips.stroke(ctx, 3.2 * k);
}

function drawBroadleaf(ctx, rng, r) {
  const k = r.h / 512;
  const cx = r.x + r.w * 0.5;
  const cy = r.y + r.h * 0.5;
  const R = r.w * 0.44;
  const twig = new Buckets(["#3b2f24"]);
  for (let i = 0; i < 6; i++) {
    const a = rng() * TAU;
    const l = R * rand(rng, 0.45, 0.75);
    twig.get(0).moveTo(cx, cy);
    twig.get(0).quadraticCurveTo(cx + Math.cos(a + 0.3) * l * 0.5, cy + Math.sin(a + 0.3) * l * 0.5, cx + Math.cos(a) * l, cy + Math.sin(a) * l);
  }
  twig.stroke(ctx, 4.5 * k);
  // Ginkgo-style fan leaves on short stalks; inner leaves darker.
  const fans = new Buckets([
    ...ramp(5, 86, 72, 28, 38, 20, 36),
    hsl(66, 40, 40),
    hsl(58, 44, 46),
  ]);
  const veins = new Buckets(["rgba(190,196,120,0.22)"]);
  const stalks = new Buckets(["#4a4a26"]);
  const N = 74;
  for (let i = 0; i < N; i++) {
    const d = R * Math.pow(rng(), 0.55) * 0.8;
    const a0 = rng() * TAU;
    const px = cx + Math.cos(a0) * d;
    const py = cy + Math.sin(a0) * d;
    const ang = a0 + rand(rng, -0.7, 0.7);
    const fr = rand(rng, 34, 54) * k;
    const spread = rand(rng, 1.25, 1.8);
    const stalk = rand(rng, 8, 16) * k;
    const bx = px - Math.cos(ang) * stalk;
    const by = py - Math.sin(ang) * stalk;
    linePath(stalks.get(0), bx, by, px, py);
    const shade = clamp((d / R) * 0.6 + rand(rng, -0.2, 0.4), 0, 0.999);
    const p = shade > 0.93 && rng() < 0.5 ? fans.get(6) : fans.pick(shade * 0.86);
    const a1 = ang - spread / 2;
    const a2 = ang + spread / 2;
    p.moveTo(px, py);
    p.arc(px, py, fr, a1, ang - 0.06);
    p.lineTo(px + Math.cos(ang) * fr * 0.78, py + Math.sin(ang) * fr * 0.78);
    p.arc(px, py, fr, ang + 0.06, a2);
    p.closePath();
    for (let v = 0; v < 4; v++) {
      const va = lerp(a1 + 0.15, a2 - 0.15, v / 3);
      linePath(veins.get(0), px, py, px + Math.cos(va) * fr * 0.85, py + Math.sin(va) * fr * 0.85);
    }
  }
  stalks.stroke(ctx, 2 * k);
  fans.fill(ctx);
  veins.stroke(ctx, 1.1 * k);
}

/**
 * Generic pinnate frond (tree fern, fern, cycad, withered frond).
 * @param {object} o shape: pinnae per side, len (pinna length / h), angle at base/tip
 *   (rad from the rachis), lobes (bipinnate), lobe size, width, palette, rachis colour…
 */
function drawFrond(ctx, rng, r, o) {
  const k = r.h / 512;
  const x0 = r.x + r.w * 0.025;
  const x1 = r.x + r.w * 0.975;
  const cy = r.y + r.h * 0.5;
  const arch = o.arch ?? 0.02;
  const rachisY = (s) => cy - Math.sin(s * Math.PI) * r.h * arch;
  const body = new Buckets(o.palette);
  const mid = new Buckets([o.midrib ?? "rgba(30,36,14,0.5)"]);
  const rachis = new Buckets([o.rachis]);
  const n = o.pinnae;
  for (let i = 0; i < n; i++) {
    for (const side of [-1, 1]) {
      if (o.gaps && rng() < o.gaps) continue;
      const s = clamp((i + (side > 0 ? 0.25 : 0.75)) / n, 0, 1) * 0.94 + 0.03;
      const env = Math.pow(1 - s, o.taper ?? 0.85) * (0.35 + 0.65 * smoothstep(0, o.widest ?? 0.32, s));
      const L = o.len * r.h * env * rand(rng, 0.9, 1.08);
      if (L < 3 * k) continue;
      const bx = lerp(x0, x1, s);
      const by = rachisY(s);
      const ang = side * lerp(o.angle, o.angleTip, s) + rand(rng, -0.06, 0.06);
      const c = Math.cos(ang);
      const sn = Math.sin(ang);
      const shadeBase = clamp(0.25 + s * 0.4 + rand(rng, -0.2, 0.25), 0, 1);
      if (o.lobes) {
        const nl = Math.max(3, Math.round(L / (o.lobeSize * k)));
        for (let j = 0; j < nl; j++) {
          const t = (j + 0.5) / nl;
          const px = bx + c * L * t;
          const py = by + sn * L * t;
          const ll = o.lobeSize * k * 1.55 * (1 - t * 0.65) * rand(rng, 0.85, 1.15);
          const shade = clamp(shadeBase + t * 0.25 + rand(rng, -0.12, 0.12), 0, 0.999);
          for (const ls of [-1, 1]) {
            if (o.gaps && rng() < o.gaps * 0.4) continue;
            const la = ang + ls * (o.lobeAngle ?? 1.05) * (1 - t * 0.3);
            leafPath(body.pick(shade), px, py, la, ll, ll * (o.lobeWidth ?? 0.42), 0.38);
          }
        }
        // Pinna tip.
        leafPath(body.pick(shadeBase + 0.3), bx + c * L * 0.96, by + sn * L * 0.96, ang, o.lobeSize * k * 1.3, o.lobeSize * k * 0.4);
        linePath(mid.get(0), bx, by, bx + c * L, by + sn * L);
      } else {
        leafPath(body.pick(shadeBase), bx, by, ang, L, (o.width ?? 0.035) * r.h, 0.35);
        linePath(mid.get(0), bx + c * L * 0.05, by + sn * L * 0.05, bx + c * L * 0.85, by + sn * L * 0.85);
      }
    }
  }
  const rp = rachis.get(0);
  rp.moveTo(x0, rachisY(0));
  for (let i = 1; i <= 24; i++) {
    const s = i / 24;
    rp.lineTo(lerp(x0, x1, s), rachisY(s));
  }
  body.fill(ctx);
  mid.stroke(ctx, (o.lobes ? 1.6 : 1.4) * k);
  rachis.stroke(ctx, (o.rachisWidth ?? 4) * k);
}

function drawHorsetail(ctx, rng, r) {
  const k = r.h / 512;
  const base = r.y + r.h * 0.985;
  const cx = r.x + r.w * 0.5;
  const whorl = new Buckets(ramp(4, 92, 80, 30, 38, 22, 36));
  const stem = new Buckets(ramp(3, 84, 78, 26, 34, 30, 42));
  const node = new Buckets(["rgba(34,28,18,0.95)"]);
  const cone = new Buckets([hsl(38, 40, 46), hsl(32, 36, 36)]);
  const fertileStem = new Buckets([hsl(44, 30, 58)]);
  const stalks = 9;
  for (let i = 0; i < stalks; i++) {
    const fertile = i % 4 === 3;
    const bx = cx + rand(rng, -0.14, 0.14) * r.w;
    const H = r.h * (fertile ? rand(rng, 0.45, 0.6) : rand(rng, 0.7, 0.95));
    const lean = (bx - cx) / r.w * 0.9 + rand(rng, -0.12, 0.12);
    const segs = Math.round(rand(rng, 9, 13));
    const pt = (t) => [bx + lean * H * t * t, base - H * t];
    // Whorled branchlets (behind the stem).
    if (!fertile) {
      for (let j = 2; j < segs; j++) {
        const t = j / segs;
        const [px, py] = pt(t);
        const n = Math.round(rand(rng, 10, 15));
        const bl = r.h * rand(rng, 0.07, 0.12) * (1 - t * 0.6);
        for (let m = 0; m < n; m++) {
          const side = m % 2 ? 1 : -1;
          const a = -Math.PI / 2 + side * rand(rng, 0.55, 1.35);
          const ex = px + Math.cos(a) * bl;
          const ey = py + Math.sin(a) * bl;
          const p = whorl.pick(rng());
          p.moveTo(px, py);
          p.quadraticCurveTo(px + Math.cos(a) * bl * 0.6, py + Math.sin(a) * bl * 0.4, ex, ey + bl * 0.25);
        }
      }
    }
    const sp = (fertile ? fertileStem : stem).pick(rng());
    const [tx0, ty0] = pt(0);
    sp.moveTo(tx0, ty0);
    for (let j = 1; j <= 16; j++) {
      const [px, py] = pt(j / 16);
      sp.lineTo(px, py);
    }
    for (let j = 1; j < segs; j++) {
      const [px, py] = pt(j / segs);
      linePath(node.get(0), px - 4.5 * k, py, px + 4.5 * k, py);
    }
    if (fertile) {
      const [px, py] = pt(1);
      const c = cone.get(0);
      c.moveTo(px + 9 * k, py - 14 * k);
      c.ellipse(px, py - 14 * k, 9 * k, 22 * k, 0, 0, TAU);
    }
  }
  ctx.lineCap = "round";
  whorl.stroke(ctx, 2.4 * k);
  stem.stroke(ctx, 7.5 * k);
  fertileStem.stroke(ctx, 6.5 * k);
  node.stroke(ctx, 2.6 * k);
  cone.fill(ctx);
}

function drawShrub(ctx, rng, r) {
  const k = r.h / 512;
  const cx = r.x + r.w * 0.5;
  const cy = r.y + r.h * 0.5;
  const R = r.w * 0.44;
  const twig = new Buckets(["#33281c"]);
  for (let i = 0; i < 7; i++) {
    const a = rng() * TAU;
    linePath(twig.get(0), cx, cy, cx + Math.cos(a) * R * 0.7, cy + Math.sin(a) * R * 0.7);
  }
  twig.stroke(ctx, 4 * k);
  const leaves = new Buckets(ramp(7, 112, 92, 26, 38, 12, 32));
  const vein = new Buckets(["rgba(160,180,110,0.25)"]);
  for (let i = 0; i < 230; i++) {
    const d = R * Math.pow(rng(), 0.5) * 0.9;
    const a0 = rng() * TAU;
    const px = cx + Math.cos(a0) * d;
    const py = cy + Math.sin(a0) * d;
    const ang = a0 + rand(rng, -1.0, 1.0);
    const len = rand(rng, 26, 42) * k;
    const shade = clamp((d / R) * 0.75 + rand(rng, -0.3, 0.3), 0, 0.999);
    leafPath(leaves.pick(shade), px, py, ang, len, len * 0.3, 0.45);
    linePath(vein.get(0), px, py, px + Math.cos(ang) * len * 0.8, py + Math.sin(ang) * len * 0.8);
  }
  leaves.fill(ctx);
  vein.stroke(ctx, 1.1 * k);
  // Subtle berry clusters.
  const berries = new Buckets([hsl(352, 52, 26), hsl(330, 34, 22), hsl(8, 58, 32)]);
  const glint = new Buckets(["rgba(255,236,230,0.45)"]);
  for (let i = 0; i < 15; i++) {
    const d = R * Math.sqrt(rng()) * 0.78;
    const a0 = rng() * TAU;
    const bx = cx + Math.cos(a0) * d;
    const by = cy + Math.sin(a0) * d;
    const col = (rng() * 3) | 0;
    const m = Math.round(rand(rng, 3, 6));
    for (let j = 0; j < m; j++) {
      const rr = rand(rng, 4, 6) * k;
      const x = bx + rand(rng, -9, 9) * k;
      const y = by + rand(rng, -9, 9) * k;
      const p = berries.get(col);
      p.moveTo(x + rr, y);
      p.arc(x, y, rr, 0, TAU);
      const g = glint.get(0);
      g.moveTo(x - rr * 0.3 + rr * 0.3, y - rr * 0.35);
      g.arc(x - rr * 0.3, y - rr * 0.35, rr * 0.3, 0, TAU);
    }
  }
  berries.fill(ctx);
  glint.fill(ctx);
}

function drawGrass(ctx, rng, r, dry) {
  const k = r.h / 512;
  const base = r.y + r.h * 0.99;
  const cx = r.x + r.w * 0.5;
  const N = dry ? 70 : 90;
  for (let i = 0; i < N; i++) {
    const bx = cx + (rng() * 2 - 1) * r.w * 0.26;
    const H = r.h * (dry ? rand(rng, 0.35, 0.85) : rand(rng, 0.35, 0.94));
    const lean = ((bx - cx) / r.w) * 1.1 + rand(rng, -0.28, 0.28);
    const w0 = rand(rng, 5, 9) * k;
    const tx = bx + lean * H;
    const ty = base - H;
    const g = ctx.createLinearGradient(0, base, 0, ty);
    if (dry) {
      g.addColorStop(0, hsl(58, 22, 16));
      g.addColorStop(0.45, hsl(rand(rng, 46, 56), rand(rng, 26, 36), rand(rng, 32, 42)));
      g.addColorStop(1, hsl(rand(rng, 40, 48), rand(rng, 38, 50), rand(rng, 52, 64)));
    } else {
      g.addColorStop(0, hsl(86, 30, 12));
      g.addColorStop(0.5, hsl(rand(rng, 72, 88), rand(rng, 28, 38), rand(rng, 24, 32)));
      g.addColorStop(1, hsl(rand(rng, 62, 80), rand(rng, 30, 42), rand(rng, 36, 50)));
    }
    ctx.fillStyle = g;
    ctx.beginPath();
    ctx.moveTo(bx - w0 / 2, base);
    ctx.quadraticCurveTo(bx - w0 * 0.4 + lean * H * 0.3, base - H * 0.55, tx, ty);
    ctx.quadraticCurveTo(bx + w0 * 0.4 + lean * H * 0.3, base - H * 0.55, bx + w0 / 2, base);
    ctx.closePath();
    ctx.fill();
  }
  if (dry) {
    // Seed heads on thin stalks.
    for (let i = 0; i < 9; i++) {
      const bx = cx + (rng() * 2 - 1) * r.w * 0.2;
      const H = r.h * rand(rng, 0.78, 0.95);
      const lean = rand(rng, -0.2, 0.2);
      const tx = bx + lean * H;
      const ty = base - H;
      ctx.strokeStyle = hsl(45, 30, 48);
      ctx.lineWidth = 2.2 * k;
      ctx.beginPath();
      ctx.moveTo(bx, base);
      ctx.quadraticCurveTo(bx + lean * H * 0.4, base - H * 0.6, tx, ty);
      ctx.stroke();
      ctx.fillStyle = hsl(40, 42, 58);
      for (let j = 0; j < 9; j++) {
        const t = j / 9;
        const x = lerp(tx - lean * H * 0.16, tx, t);
        const y = lerp(ty + H * 0.16, ty, t);
        ctx.beginPath();
        ctx.ellipse(x + (j % 2 ? 4 : -4) * k, y, 3.2 * k, 7 * k, (j % 2 ? 0.5 : -0.5) + lean, 0, TAU);
        ctx.fill();
      }
    }
  }
}

function drawHerb(ctx, rng, r) {
  const k = r.h / 512;
  const base = r.y + r.h * 0.98;
  const cx = r.x + r.w * 0.5;
  const stalks = new Buckets([hsl(88, 30, 26)]);
  const blades = new Buckets(ramp(5, 94, 80, 24, 34, 15, 30));
  const veins = new Buckets(["rgba(200,214,150,0.3)"]);
  for (let i = 0; i < 13; i++) {
    const t = i / 12;
    const ex = cx + (t * 2 - 1) * r.w * 0.34 + rand(rng, -0.05, 0.05) * r.w;
    const ey = base - r.h * rand(rng, 0.2, 0.55);
    const sp = stalks.get(0);
    sp.moveTo(cx + rand(rng, -6, 6) * k, base);
    sp.quadraticCurveTo(cx + (ex - cx) * 0.2, ey + (base - ey) * 0.3, ex, ey);
    const ang = Math.atan2(ey - base, ex - cx) + rand(rng, -0.4, 0.4);
    const len = r.h * rand(rng, 0.2, 0.3);
    leafPath(blades.pick(rng()), ex, ey, ang, len, len * 0.36, 0.5);
    const c = Math.cos(ang);
    const s = Math.sin(ang);
    linePath(veins.get(0), ex, ey, ex + c * len * 0.9, ey + s * len * 0.9);
    for (let v = 1; v < 4; v++) {
      const px = ex + c * len * v * 0.22;
      const py = ey + s * len * v * 0.22;
      for (const side of [-1, 1]) {
        const a = ang + side * 0.8;
        linePath(veins.get(0), px, py, px + Math.cos(a) * len * 0.16, py + Math.sin(a) * len * 0.16);
      }
    }
  }
  stalks.stroke(ctx, 3 * k);
  blades.fill(ctx);
  veins.stroke(ctx, 1.2 * k);
}

/* --- Atlas assembly ----------------------------------------------------------------- */

/**
 * Card regions keep their RGB defined under alpha 0 (set to the region's mean
 * leaf colour) so mip-mapping doesn't drag dark fringes into the cut-outs.
 */
function bleedRegions(data, size, regions) {
  for (const reg of regions) {
    const x0 = Math.round(reg.x * size);
    const y0 = Math.round(reg.y * size);
    const x1 = Math.round((reg.x + reg.w) * size);
    const y1 = Math.round((reg.y + reg.h) * size);
    let r = 0;
    let g = 0;
    let b = 0;
    let n = 0;
    for (let y = y0; y < y1; y += 2) {
      for (let x = x0; x < x1; x += 2) {
        const i = (y * size + x) * 4;
        if (data[i + 3] > 200) {
          r += data[i];
          g += data[i + 1];
          b += data[i + 2];
          n++;
        }
      }
    }
    if (!n) continue;
    r = (r / n) | 0;
    g = (g / n) | 0;
    b = (b / n) | 0;
    for (let y = y0; y < y1; y++) {
      for (let x = x0; x < x1; x++) {
        const i = (y * size + x) * 4;
        const a = data[i + 3];
        if (a < 16) {
          data[i] = r;
          data[i + 1] = g;
          data[i + 2] = b;
          data[i + 3] = 0;
        }
      }
    }
  }
}

function buildAtlas(size, seed) {
  const canvas = makeCanvas(size, size);
  const ctx = canvas.getContext("2d", { willReadFrequently: true });
  const rng = makeRng(hash(seed, "veg-atlas"));
  const px = (r) => ({ x: r.x * size, y: r.y * size, w: r.w * size, h: r.h * size });
  ctx.clearRect(0, 0, size, size);
  drawBarkPlated(ctx, rng, px(REG.barkA));
  drawBarkFibrous(ctx, rng, px(REG.barkB));
  drawAraucaria(ctx, rng, px(REG.araucaria));
  drawFir(ctx, rng, px(REG.fir));
  drawBroadleaf(ctx, rng, px(REG.broadleaf));
  drawFrond(ctx, rng, px(REG.treefern), {
    pinnae: 30, len: 0.44, angle: 1.2, angleTip: 0.8, lobes: true, lobeSize: 7.5, widest: 0.38,
    palette: ramp(6, 100, 84, 34, 46, 14, 34), rachis: "#4a3a22", arch: 0.03,
  });
  drawFrond(ctx, rng, px(REG.fern), {
    pinnae: 24, len: 0.42, angle: 1.05, angleTip: 0.7, lobes: true, lobeSize: 8.5, lobeWidth: 0.5, widest: 0.3,
    palette: ramp(6, 92, 78, 34, 46, 19, 40), rachis: "#3f4420", arch: 0.025,
  });
  drawFrond(ctx, rng, px(REG.cycad), {
    pinnae: 44, len: 0.4, angle: 0.95, angleTip: 0.6, lobes: false, width: 0.022, widest: 0.2, taper: 0.6,
    palette: ramp(6, 118, 100, 30, 40, 11, 27), rachis: "#4a4426", midrib: "rgba(150,170,110,0.35)", rachisWidth: 5,
  });
  drawHorsetail(ctx, rng, px(REG.horsetail));
  drawShrub(ctx, rng, px(REG.shrub));
  drawFrond(ctx, rng, px(REG.deadfrond), {
    pinnae: 24, len: 0.36, angle: 1.45, angleTip: 1.0, lobes: true, lobeSize: 7, lobeWidth: 0.32, gaps: 0.22,
    palette: ramp(5, 34, 24, 34, 44, 18, 34), rachis: "#3a2a1a", midrib: "rgba(30,20,10,0.5)", arch: -0.02,
  });
  drawGrass(ctx, rng, px(REG.grass), false);
  drawGrass(ctx, rng, px(REG.grassDry), true);
  drawHerb(ctx, rng, px(REG.herb));

  const img = ctx.getImageData(0, 0, size, size);
  bleedRegions(img.data, size, CARD_KEYS.map((k) => REG[k]));
  const tex = new THREE.DataTexture(new Uint8Array(img.data.buffer), size, size, THREE.RGBAFormat);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.wrapS = THREE.ClampToEdgeWrapping;
  tex.wrapT = THREE.RepeatWrapping; // bark strips tile vertically
  tex.magFilter = THREE.LinearFilter;
  tex.minFilter = THREE.LinearMipmapLinearFilter;
  tex.generateMipmaps = true;
  tex.anisotropy = 4;
  tex.needsUpdate = true;
  return tex;
}

/* --- Rock texture (tileable value-noise stone with lichen) -------------------------- */

function buildRockTexture(size, seed) {
  const perm = new Uint8Array(512);
  const rng = makeRng(hash(seed, "veg-rock"));
  for (let i = 0; i < 256; i++) perm[i] = i;
  for (let i = 255; i > 0; i--) {
    const j = (rng() * (i + 1)) | 0;
    const t = perm[i];
    perm[i] = perm[j];
    perm[j] = t;
  }
  for (let i = 0; i < 256; i++) perm[i + 256] = perm[i];
  // Periodic value noise: lattice wraps at `period` so the texture tiles.
  const vn = (x, y, period) => {
    const xi = Math.floor(x);
    const yi = Math.floor(y);
    const fx = x - xi;
    const fy = y - yi;
    const x0 = ((xi % period) + period) % period;
    const y0 = ((yi % period) + period) % period;
    const x1 = (x0 + 1) % period;
    const y1 = (y0 + 1) % period;
    const h = (a, b) => perm[(perm[a & 255] + b) & 255] / 255;
    const u = fx * fx * (3 - 2 * fx);
    const v = fy * fy * (3 - 2 * fy);
    return lerp(lerp(h(x0, y0), h(x1, y0), u), lerp(h(x0, y1), h(x1, y1), u), v);
  };
  const fbm = (x, y, base, oct) => {
    let sum = 0;
    let amp = 0.5;
    let p = base;
    for (let o = 0; o < oct; o++) {
      sum += vn((x * p) / size, (y * p) / size, p) * amp;
      amp *= 0.5;
      p *= 2;
    }
    return sum;
  };
  const data = new Uint8Array(size * size * 4);
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const n = fbm(x, y, 4, 6); // 0..~1
      const m = fbm(x + 37, y + 91, 2, 3);
      const crack = Math.abs(fbm(x + 11, y + 5, 8, 3) - 0.47);
      const lichen = fbm(x + 203, y + 17, 16, 3);
      let l = 0.36 + (n - 0.5) * 0.55 + (m - 0.5) * 0.18;
      if (crack < 0.018) l *= 0.55 + crack * 20;
      let r = l * 1.04;
      let g = l * 1.0;
      let b = l * 0.93;
      if (lichen > 0.6) {
        const t = smoothstep(0.6, 0.7, lichen) * 0.6;
        r = lerp(r, 0.62, t);
        g = lerp(g, 0.62, t);
        b = lerp(b, 0.46, t);
      } else if (lichen < 0.26) {
        const t = smoothstep(0.26, 0.2, lichen) * 0.35;
        r = lerp(r, 0.6, t);
        g = lerp(g, 0.42, t);
        b = lerp(b, 0.22, t);
      }
      const i = (y * size + x) * 4;
      data[i] = clamp(r * 255, 0, 255);
      data[i + 1] = clamp(g * 255, 0, 255);
      data[i + 2] = clamp(b * 255, 0, 255);
      data[i + 3] = 255;
    }
  }
  const tex = new THREE.DataTexture(data, size, size, THREE.RGBAFormat);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
  tex.magFilter = THREE.LinearFilter;
  tex.minFilter = THREE.LinearMipmapLinearFilter;
  tex.generateMipmaps = true;
  tex.anisotropy = 4;
  tex.needsUpdate = true;
  return tex;
}

/* --- Shaders ------------------------------------------------------------------------- */

// Per-vertex `aWind`: x = bend (metres of sway at full gust, unit instance scale),
// y = flutter weight (leaf tips), z = 1 for foliage cards / 0 for bark.
// `uLod` = (bandStart, bandEnd, far, overlap). Swap mode (trees): each instance
// hands over at its own hashed distance in [bandStart, bandEnd - overlap]; over the
// next `overlap` metres the near version shrinks to LOD_INSET inside the (slightly
// larger) far version, which is already drawn, then collapses. `far` = 1 selects
// the far side. VEG_SHRINK mode (plants, logs, grass): scale to nothing across
// the band.
const LOD_INSET = 0.88;
const VEG_VERT_PARS = /* glsl */ `
uniform float uTime;
uniform vec3 uWind;
uniform vec3 uFocus;
uniform vec4 uLod;
attribute vec3 aWind;
varying float vLeaf;
`;

// Runs right after <begin_vertex>, in object space, so the shadow-coordinate,
// fog and world-position chunks that follow all see the swayed vertex.
const VEG_VERT_MAIN = /* glsl */ `
{
  vec3 vegBase = vec3( 0.0 );
  mat3 vegM = mat3( 1.0 );
  #ifdef USE_INSTANCING
    vegBase = instanceMatrix[ 3 ].xyz;
    vegM = mat3( instanceMatrix );
  #endif
  float vegScale = length( vegM[ 1 ] );
  float vegDist = distance( vegBase.xz, uFocus.xz );
  #ifdef VEG_SHRINK
    float vegKeep = 1.0 - smoothstep( uLod.x, uLod.y, vegDist );
  #else
    float vegAt = mix( uLod.x, uLod.y - uLod.w, fract( sin( dot( vegBase.xz, vec2( 41.37, 17.91 ) ) ) * 23421.631 ) );
    float vegT = clamp( ( vegDist - vegAt ) / max( uLod.w, 0.001 ), 0.0, 1.0 );
    float vegKeep = uLod.z > 0.5 ? step( vegAt, vegDist ) : ( vegT < 1.0 ? mix( 1.0, ${LOD_INSET.toFixed(3)}, vegT ) : 0.0 );
  #endif
  vLeaf = aWind.z;
  float vegPh = dot( vegBase.xz, vec2( 0.071, 0.053 ) ) + fract( sin( dot( vegBase.xz, vec2( 12.9898, 78.233 ) ) ) * 43758.5453 ) * 6.2832;
  float vegGust = uWind.z;
  float vegSway = sin( uTime * 0.83 + vegPh ) * 0.55 + sin( uTime * 1.73 + vegPh * 1.37 ) * 0.3 + sin( uTime * 0.29 + vegPh * 0.5 ) * 0.35;
  float vegBend = aWind.x * vegScale * ( 0.25 + 0.9 * vegGust );
  vec3 vegD = vec3( uWind.x, 0.0, uWind.y ) * vegBend * ( 0.55 + 0.45 * vegSway );
  float vegFl = aWind.y * ( 0.03 + 0.1 * vegGust ) * min( vegScale, 1.4 );
  vec3 vegP = transformed;
  vegD += vec3(
    sin( uTime * 4.3 + vegPh + vegP.y * 1.7 + vegP.x * 0.9 ),
    sin( uTime * 5.1 + vegPh * 1.3 + vegP.z * 1.1 ) * 0.6,
    cos( uTime * 3.9 + vegPh + vegP.z * 1.4 + vegP.y )
  ) * vegFl;
  #ifdef USE_INSTANCING
    transformed += inverse( vegM ) * vegD;
  #else
    transformed += vegD;
  #endif
  transformed *= vegKeep; // 0 collapses the instance: no fragments at all
}
`;

// Instance tint applies fully to foliage and only faintly to bark, so a yellowing
// ginkgo doesn't get a yellow trunk.
const VEG_COLOR_VERTEX = /* glsl */ `
#if defined( USE_COLOR ) || defined( USE_INSTANCING_COLOR )
  vColor = vec3( 1.0 );
#endif
#ifdef USE_COLOR
  vColor *= color;
#endif
#ifdef USE_INSTANCING_COLOR
  vColor.xyz *= mix( vec3( 1.0 ), instanceColor.xyz, 0.15 + 0.85 * aWind.z );
#endif
`;

const VEG_FRAG_PARS = /* glsl */ `
uniform float uAtlasSize;
varying float vLeaf;
float vegDither( vec2 p ) {
  return fract( 52.9829189 * fract( dot( p, vec2( 0.06711056, 0.00583715 ) ) ) );
}
`;

// Before <alphatest_fragment>: bark is opaque whatever its texel alpha, foliage
// alpha is boosted with the mip level so canopies don't thin out with distance.
const VEG_FRAG_ALPHA = /* glsl */ `
#ifdef USE_MAP
{
  vec2 vegTx = vMapUv * uAtlasSize;
  vec2 vegDx = dFdx( vegTx );
  vec2 vegDy = dFdy( vegTx );
  float vegLod = 0.5 * log2( max( max( dot( vegDx, vegDx ), dot( vegDy, vegDy ) ), 1.0 ) );
  diffuseColor.a = vLeaf < 0.5 ? 1.0 : diffuseColor.a * ( 1.0 + vegLod * 0.24 );
}
#endif
#ifdef VEG_DEPTH
  // Canopies let some light through: a fine hole pattern in the shadow map that
  // PCF blurs into partial transmission, so forest floors stay dappled, not black.
  if ( vLeaf > 0.5 && vegDither( gl_FragCoord.xy * 0.71 + 3.7 ) < 0.3 ) discard;
#endif
`;

function patchVegShader(shader, mat, depth) {
  const u = mat.vegShared;
  shader.uniforms.uTime = u.uTime;
  shader.uniforms.uWind = u.uWind;
  shader.uniforms.uFocus = u.uFocus;
  shader.uniforms.uAtlasSize = u.uAtlasSize;
  shader.uniforms.uLod = mat.vegLod;
  let vs = shader.vertexShader;
  vs = vs.replace("#include <common>", `#include <common>\n${VEG_VERT_PARS}`);
  vs = vs.replace(
    "#include <begin_vertex>",
    `#include <begin_vertex>\n${mat.vegShrink ? "#define VEG_SHRINK\n" : ""}${VEG_VERT_MAIN}`,
  );
  if (!depth) vs = vs.replace("#include <color_vertex>", VEG_COLOR_VERTEX);
  shader.vertexShader = vs;
  let fs = shader.fragmentShader;
  fs = fs.replace("#include <common>", `#include <common>\n${depth ? "#define VEG_DEPTH\n" : ""}${VEG_FRAG_PARS}`);
  fs = fs.replace("#include <alphatest_fragment>", `${VEG_FRAG_ALPHA}\n#include <alphatest_fragment>`);
  if (!depth) {
    // Foliage keeps its bent (outward) normal on both faces; bark flips as usual.
    fs = fs.replace(
      "#include <normal_fragment_begin>",
      THREE.ShaderChunk.normal_fragment_begin.replace(
        "normal *= faceDirection;",
        "normal *= ( vLeaf > 0.5 ? 1.0 : faceDirection );",
      ),
    );
  }
  shader.fragmentShader = fs;
}

/**
 * The one material behind every tree, food plant, log and grass tuft. A
 * subclass (not a patched instance) so three's internal clones keep the hook.
 */
class PlantMaterial extends THREE.MeshStandardMaterial {
  constructor(params, veg = {}) {
    super(params);
    this.vegShared = veg.shared || null;
    this.vegLod = { value: new THREE.Vector4(1e7, 2e7, 0, 0) };
    this.vegShrink = !!veg.shrink;
  }
  copy(src) {
    super.copy(src);
    this.vegShared = src.vegShared;
    this.vegLod = src.vegLod;
    this.vegShrink = src.vegShrink;
    return this;
  }
  onBeforeCompile(shader) {
    patchVegShader(shader, this, false);
  }
  customProgramCacheKey() {
    return this.vegShrink ? "sauria-veg-shrink" : "sauria-veg";
  }
}

/** Shadow-pass twin: alpha-tested atlas + identical sway → dappled, moving shadows. */
class PlantDepthMaterial extends THREE.MeshDepthMaterial {
  constructor(params, veg = {}) {
    super({ depthPacking: THREE.RGBADepthPacking, ...(params || {}) });
    this.vegShared = veg.shared || null;
    this.vegLod = veg.lod || { value: new THREE.Vector4(1e7, 2e7, 0, 0) };
    this.vegShrink = !!veg.shrink;
  }
  copy(src) {
    super.copy(src);
    this.vegShared = src.vegShared;
    this.vegLod = src.vegLod;
    this.vegShrink = src.vegShrink;
    return this;
  }
  onBeforeCompile(shader) {
    patchVegShader(shader, this, true);
  }
  customProgramCacheKey() {
    return this.vegShrink ? "sauria-veg-depth-shrink" : "sauria-veg-depth";
  }
}

/** Boulders: object-space triplanar stone texture, moss on upward faces, per-instance LOD swap. */
class RockMaterial extends THREE.MeshStandardMaterial {
  constructor(params, veg = {}) {
    super(params);
    this.vegShared = veg.shared || null;
    this.vegLod = { value: new THREE.Vector4(1e7, 2e7, 0, 0) };
    this.rockMap = veg.rockMap || null;
  }
  copy(src) {
    super.copy(src);
    this.vegShared = src.vegShared;
    this.vegLod = src.vegLod;
    this.rockMap = src.rockMap;
    return this;
  }
  onBeforeCompile(shader) {
    shader.uniforms.uFocus = this.vegShared.uFocus;
    shader.uniforms.uLod = this.vegLod;
    shader.uniforms.uRockMap = { value: this.rockMap };
    shader.vertexShader = shader.vertexShader
      .replace("#include <common>", /* glsl */ `#include <common>
uniform vec3 uFocus;
uniform vec4 uLod;
attribute float aMoss;
varying vec3 vRockP;
varying vec3 vRockN;
varying float vRockUp;
varying float vMoss;`)
      .replace("#include <begin_vertex>", /* glsl */ `#include <begin_vertex>
{
  vec3 rBase = vec3( 0.0 );
  mat3 rM = mat3( 1.0 );
  #ifdef USE_INSTANCING
    rBase = instanceMatrix[ 3 ].xyz;
    rM = mat3( instanceMatrix );
  #endif
  // Whole-rock swap at a hashed distance inside the band (see VEG_VERT_PARS).
  float rAt = mix( uLod.x, uLod.y, fract( sin( dot( rBase.xz, vec2( 41.37, 17.91 ) ) ) * 23421.631 ) );
  float rKeep = step( rAt, distance( rBase.xz, uFocus.xz ) );
  if ( uLod.z < 0.5 ) rKeep = 1.0 - rKeep;
  vRockP = position * vec3( length( rM[ 0 ] ), length( rM[ 1 ] ), length( rM[ 2 ] ) );
  vRockN = normal;
  vRockUp = normalize( rM * normal ).y;
  vMoss = aMoss;
  transformed *= rKeep;
}`);
    shader.fragmentShader = shader.fragmentShader
      .replace("#include <common>", /* glsl */ `#include <common>
uniform sampler2D uRockMap;
varying vec3 vRockP;
varying vec3 vRockN;
varying float vRockUp;
varying float vMoss;`)
      .replace("#include <map_fragment>", /* glsl */ `#include <map_fragment>
{
  vec3 rw = pow( abs( normalize( vRockN ) ), vec3( 4.0 ) );
  rw /= rw.x + rw.y + rw.z;
  vec3 rp = vRockP * 0.38;
  vec3 rc = texture2D( uRockMap, rp.zy ).rgb * rw.x + texture2D( uRockMap, rp.xz ).rgb * rw.y + texture2D( uRockMap, rp.xy + 0.37 ).rgb * rw.z;
  diffuseColor.rgb *= rc * 1.15;
  float rMoss = smoothstep( 0.32, 0.78, vRockUp + ( rc.g - 0.1 ) * 1.6 ) * vMoss;
  diffuseColor.rgb = mix( diffuseColor.rgb, vec3( 0.07, 0.095, 0.03 ) * ( 0.75 + rc.g * 3.0 ), rMoss );
}`);
  }
  customProgramCacheKey() {
    return "sauria-rock";
  }
}

/* --- Geometry builder ---------------------------------------------------------------- */

const V3 = THREE.Vector3;
const ZERO = () => 0;
const gray = (v) => [v, v, v];

/** Accumulates vertices (position, normal, uv, colour, aWind) and indices. */
class GeoBuilder {
  constructor() {
    this.pos = [];
    this.nor = [];
    this.uv = [];
    this.col = [];
    this.wnd = [];
    this.idx = [];
    this.n = 0;
  }
  vert(x, y, z, nx, ny, nz, u, v, c, bend, flutter, leaf) {
    this.pos.push(x, y, z);
    this.nor.push(nx, ny, nz);
    this.uv.push(u, v);
    this.col.push(c[0], c[1], c[2]);
    this.wnd.push(bend, flutter, leaf);
    return this.n++;
  }
  tri(a, b, c) {
    this.idx.push(a, b, c);
  }
  build() {
    const g = new THREE.BufferGeometry();
    g.setAttribute("position", new THREE.Float32BufferAttribute(this.pos, 3));
    g.setAttribute("normal", new THREE.Float32BufferAttribute(this.nor, 3));
    g.setAttribute("uv", new THREE.Float32BufferAttribute(this.uv, 2));
    g.setAttribute("color", new THREE.Float32BufferAttribute(this.col, 3));
    g.setAttribute("aWind", new THREE.Float32BufferAttribute(this.wnd, 3));
    g.setIndex(this.n > 65535 ? new THREE.Uint32BufferAttribute(this.idx, 1) : new THREE.Uint16BufferAttribute(this.idx, 1));
    g.computeBoundingSphere();
    g.computeBoundingBox();
    return g;
  }
}

const UV_EPS = 0.0005;

/**
 * Smooth tapered tube through `pts` with per-point `radii` (parallel-transport
 * frames, so curved limbs don't twist). Bark UVs wrap once around the strip and
 * advance along the length so texels stay roughly square at any girth.
 * @returns {{ start: number, ring: number }} first vertex index and ring size
 */
function addTube(b, pts, radii, sides, strip, o = {}) {
  const n = pts.length;
  const bend = o.bend || ZERO;
  const color = o.color || (() => gray(1));
  const rough = o.rough || 0;
  const jit = rough && o.rng ? Array.from({ length: n * sides }, () => o.rng() * 2 - 1) : null;
  const T = [];
  const N = [];
  const B = [];
  for (let i = 0; i < n; i++) {
    const t = new V3().subVectors(pts[Math.min(n - 1, i + 1)], pts[Math.max(0, i - 1)]).normalize();
    let nn;
    if (i === 0) {
      nn = Math.abs(t.y) < 0.9 ? new V3(0, 1, 0).cross(t) : new V3(1, 0, 0).cross(t);
    } else {
      nn = N[i - 1].clone().addScaledVector(t, -N[i - 1].dot(t));
    }
    nn.normalize();
    T.push(t);
    N.push(nn);
    B.push(new V3().crossVectors(t, nn).normalize());
  }
  const start = b.n;
  const u0 = strip.x + UV_EPS;
  const uw = strip.w - UV_EPS * 2;
  let v = o.v0 ?? 0;
  for (let i = 0; i < n; i++) {
    if (i > 0) {
      const seg = pts[i].distanceTo(pts[i - 1]);
      const rr = Math.max(0.025, (radii[i] + radii[i - 1]) * 0.5);
      v += (seg / (TAU * rr)) * strip.w;
    }
    const t = n > 1 ? i / (n - 1) : 0;
    for (let j = 0; j <= sides; j++) {
      const a = (j / sides) * TAU;
      const ca = Math.cos(a);
      const sa = Math.sin(a);
      const dx = N[i].x * ca + B[i].x * sa;
      const dy = N[i].y * ca + B[i].y * sa;
      const dz = N[i].z * ca + B[i].z * sa;
      const r = radii[i] * (1 + (jit ? jit[i * sides + (j % sides)] * rough : 0));
      const x = pts[i].x + dx * r;
      const y = pts[i].y + dy * r;
      const z = pts[i].z + dz * r;
      b.vert(x, y, z, dx, dy, dz, u0 + uw * (j / sides), v, color(t, dx, dy, dz, x, y, z), bend(x, y, z), 0, 0);
    }
  }
  for (let i = 0; i < n - 1; i++) {
    for (let j = 0; j < sides; j++) {
      const a = start + i * (sides + 1) + j;
      const c = a + sides + 1;
      b.tri(a, a + 1, c + 1);
      b.tri(a, c + 1, c);
    }
  }
  return { start, ring: sides + 1 };
}

/** Cap a tube end (ring of `count` vertices from `first`) with a fan around `centre`. */
function addCap(b, first, count, centre, normal, colour, bend, uvc) {
  const c = b.vert(centre.x, centre.y, centre.z, normal.x, normal.y, normal.z, uvc[0], uvc[1], colour, bend(centre.x, centre.y, centre.z), 0, 0);
  const ring = [];
  for (let j = 0; j < count; j++) {
    const k = (first + j) * 3;
    const x = b.pos[k];
    const y = b.pos[k + 1];
    const z = b.pos[k + 2];
    const a = (j / (count - 1)) * TAU;
    ring.push(b.vert(x, y, z, normal.x, normal.y, normal.z, uvc[0] + Math.cos(a) * 0.01, uvc[1] + Math.sin(a) * 0.01, colour, bend(x, y, z), 0, 0));
  }
  // Wind the fan so its front face looks along `normal` (bark flips back faces).
  const ax = b.pos[ring[0] * 3] - centre.x;
  const ay = b.pos[ring[0] * 3 + 1] - centre.y;
  const az = b.pos[ring[0] * 3 + 2] - centre.z;
  const k1 = Math.max(1, (count / 4) | 0);
  const bx = b.pos[ring[k1] * 3] - centre.x;
  const by = b.pos[ring[k1] * 3 + 1] - centre.y;
  const bz = b.pos[ring[k1] * 3 + 2] - centre.z;
  const flip = (ay * bz - az * by) * normal.x + (az * bx - ax * bz) * normal.y + (ax * by - ay * bx) * normal.z < 0;
  for (let j = 0; j < count - 1; j++) {
    if (flip) b.tri(c, ring[j + 1], ring[j]);
    else b.tri(c, ring[j], ring[j + 1]);
  }
}

const _fn = new V3();
const _out = new V3();
const _p = new V3();
const _tan = new V3();

/** Normal for a foliage vertex: face normal turned toward `centre`'s outward direction. */
function bentNormal(face, p, o, target) {
  target.copy(face);
  if (o.centre) {
    _out.subVectors(p, typeof o.centre === "function" ? o.centre(p) : o.centre);
    if (_out.lengthSq() < 1e-6) _out.set(0, 1, 0);
    _out.normalize();
    if (target.dot(_out) < 0) target.negate();
    target.lerp(_out, o.bendN ?? 0.6);
  } else if (target.y < 0) {
    target.negate();
  }
  if (o.upN) target.lerp(_out.set(0, 1, 0), o.upN);
  return target.normalize();
}

/**
 * Foliage strip: a card following the spine `pts`, `sides[i]` spanning its width.
 * orient "along": picture base→tip runs along the spine; "up": picture bottom→top.
 */
function addRibbon(b, pts, sides, width, reg, orient, o = {}) {
  const n = pts.length;
  const lens = [0];
  for (let i = 1; i < n; i++) lens.push(lens[i - 1] + pts[i].distanceTo(pts[i - 1]));
  const total = lens[n - 1] || 1;
  const bend = o.bend || ZERO;
  const flutter = o.flutter || ZERO;
  const color = o.color || (() => gray(1));
  const start = b.n;
  for (let i = 0; i < n; i++) {
    const s = lens[i] / total;
    _tan.subVectors(pts[Math.min(n - 1, i + 1)], pts[Math.max(0, i - 1)]).normalize();
    const S = sides[i];
    _fn.crossVectors(_tan, S).normalize();
    const w = (typeof width === "function" ? width(s) : width) * 0.5;
    for (let e = -1; e <= 1; e += 2) {
      _p.copy(pts[i]).addScaledVector(S, w * e);
      const nrm = bentNormal(_fn, _p, o, new V3());
      const tt = (e + 1) / 2;
      let u;
      let v;
      if (orient === "along") {
        u = reg.x + reg.w * s;
        v = reg.y + reg.h * (1 - tt);
      } else {
        u = reg.x + reg.w * tt;
        v = reg.y + reg.h * (1 - s);
      }
      b.vert(_p.x, _p.y, _p.z, nrm.x, nrm.y, nrm.z, u, v, color(s, _p), bend(_p.x, _p.y, _p.z), flutter(s), 1);
    }
  }
  for (let i = 0; i < n - 1; i++) {
    const a = start + i * 2;
    b.tri(a, a + 1, a + 3);
    b.tri(a, a + 3, a + 2);
  }
}

/** Square foliage card centred on `c`, facing `dir`. */
function addQuad(b, c, dir, upHint, size, reg, o = {}) {
  const nrm0 = dir.clone().normalize();
  const right = new V3().crossVectors(upHint, nrm0);
  if (right.lengthSq() < 1e-6) right.set(1, 0, 0);
  right.normalize();
  const up = new V3().crossVectors(nrm0, right).normalize();
  const h = size * 0.5;
  const bend = o.bend || ZERO;
  const color = o.color || (() => gray(1));
  const fl = o.flutter ?? 0.6;
  const start = b.n;
  for (const [sx, sy] of [[-1, -1], [1, -1], [1, 1], [-1, 1]]) {
    _p.copy(c).addScaledVector(right, sx * h).addScaledVector(up, sy * h);
    const nrm = bentNormal(nrm0, _p, o, new V3());
    const u = reg.x + reg.w * (sx * 0.5 + 0.5);
    const v = reg.y + reg.h * (0.5 - sy * 0.5);
    b.vert(_p.x, _p.y, _p.z, nrm.x, nrm.y, nrm.z, u, v, color(_p), bend(_p.x, _p.y, _p.z), fl, 1);
  }
  b.tri(start, start + 1, start + 2);
  b.tri(start, start + 2, start + 3);
}

/**
 * Spine for an arching frond/branch: starts at `origin` heading along azimuth
 * `az` with elevation `e0`, curving to `e1` at the tip (gravity droop or upturn).
 * Returns points plus two side-vector sets (flat, and crossed at 90°).
 */
function arcSpine(origin, az, e0, e1, len, segs, roll = 0, pow = 1) {
  const pts = [origin.clone()];
  const p = origin.clone();
  const step = len / segs;
  for (let i = 1; i <= segs; i++) {
    const t = (i - 0.5) / segs;
    const e = lerp(e0, e1, Math.pow(t, pow));
    p.x += Math.sin(az) * Math.cos(e) * step;
    p.y += Math.sin(e) * step;
    p.z += Math.cos(az) * Math.cos(e) * step;
    pts.push(p.clone());
  }
  const hs = new V3(Math.cos(az), 0, -Math.sin(az));
  const sidesH = [];
  const sidesV = [];
  for (let i = 0; i <= segs; i++) {
    const t = new V3().subVectors(pts[Math.min(segs, i + 1)], pts[Math.max(0, i - 1)]).normalize();
    const upish = new V3().crossVectors(t, hs).normalize();
    const side = hs.clone().multiplyScalar(Math.cos(roll)).addScaledVector(upish, Math.sin(roll)).normalize();
    sidesH.push(side);
    sidesV.push(new V3().crossVectors(t, side).normalize());
  }
  return { pts, sidesH, sidesV };
}

const randomUnit = (rng, target = new V3()) => {
  const y = rng() * 2 - 1;
  const a = rng() * TAU;
  const r = Math.sqrt(1 - y * y);
  return target.set(Math.cos(a) * r, y, Math.sin(a) * r);
};

/** Sway that grows with the square of height: metres at the top at full gust. */
const treeBend = (H, amp) => (x, y) => amp * Math.pow(clamp(y / H, 0, 1.2), 2);
/** Bark ambient occlusion: darker toward the ground. */
const trunkAO = (lo, h, tint = [1, 1, 1]) => (t, nx, ny, nz, x, y) => {
  const a = lerp(lo, 1, smoothstep(-0.5, h, y));
  return [a * tint[0], a * tint[1], a * tint[2]];
};

/* --- Trees ------------------------------------------------------------------------------ */

// Every builder makes the nominal (instance-scale 1) plant with its base at the
// origin; `near` selects the detailed or the cheap far-LOD version. Both use
// the same seed so the far silhouette matches the near one.

function buildAraucaria(rng, near) {
  const b = new GeoBuilder();
  const H = TREE_H.araucaria;
  const bend = treeBend(H, 0.6);
  const rings = near ? 12 : 3;
  const pts = [];
  const radii = [];
  const trunkR = (y) => lerp(0.52, 0.07, Math.pow(clamp(y / H, 0, 1), 0.85));
  for (let i = 0; i < rings; i++) {
    const t = i / (rings - 1);
    const y = lerp(-0.7, H * 0.99, near ? Math.pow(t, 1.25) : t);
    pts.push(new V3(Math.sin(t * 6.1) * 0.07 * t, y, Math.cos(t * 4.7) * 0.06 * t));
    radii.push(trunkR(y) * (1 + 0.5 * Math.exp(-(y + 0.7) * 1.4)));
  }
  addTube(b, pts, radii, near ? 10 : 5, REG.barkA, { bend, color: trunkAO(0.45, 3), rough: near ? 0.05 : 0, rng, v0: rng() });

  const crown = new V3(0, H * 0.8, 0);
  const whorls = near ? 7 : 4;
  for (let k = 0; k < whorls; k++) {
    const t = k / (whorls - 1);
    const y = lerp(H * 0.55, H * 0.94, Math.pow(t, 0.8));
    const nb = near ? (k === whorls - 1 ? 4 : 5 + (rng() < 0.45 ? 1 : 0)) : 4;
    const az0 = rng() * TAU;
    const shade = lerp(0.74, 1.0, t);
    for (let j = 0; j < nb; j++) {
      const az = az0 + (j / nb) * TAU + rand(rng, -0.22, 0.22);
      const L = lerp(8.2, 2.6, t) * rand(rng, 0.85, 1.12) * (near ? 1 : 1.05);
      const e0 = lerp(-0.22, 0.26, t) + rand(rng, -0.08, 0.08);
      const e1 = e0 + lerp(0.85, 0.45, t) + rand(rng, -0.1, 0.1);
      const rr = trunkR(y) * 0.6;
      const o = new V3(Math.sin(az) * rr, y, Math.cos(az) * rr);
      const sp = arcSpine(o, az, e0, e1, L, near ? 4 : 2, rand(rng, -0.3, 0.3), 1.4);
      const opts = {
        centre: crown, bendN: 0.55, bend, flutter: (s) => s * 0.45,
        color: (s) => gray(shade * lerp(0.74, 1.05, s)),
      };
      const w = near ? 1.95 : 2.7;
      addRibbon(b, sp.pts, sp.sidesH, w, REG.araucaria, "along", opts);
      addRibbon(b, sp.pts, sp.sidesV, w * 0.9, REG.araucaria, "along", opts);
    }
  }
  // Upright leader tuft.
  const top = new V3(pts[rings - 1].x, H * 0.95, pts[rings - 1].z);
  for (let j = 0; j < (near ? 4 : 2); j++) {
    const sp = arcSpine(top, (j / 4) * TAU + rng(), 1.15, 0.7, 2.1, 2);
    const opts = { centre: crown, bendN: 0.5, bend, flutter: (s) => s * 0.4, color: (s) => gray(lerp(0.85, 1.05, s)) };
    addRibbon(b, sp.pts, sp.sidesH, 1.3, REG.araucaria, "along", opts);
    addRibbon(b, sp.pts, sp.sidesV, 1.2, REG.araucaria, "along", opts);
  }
  // Shed-branch stubs on the bare bole.
  if (near) {
    for (let i = 0; i < 4; i++) {
      const y = rand(rng, H * 0.28, H * 0.5);
      const az = rng() * TAU;
      const rr = trunkR(y) * 0.8;
      const s0 = new V3(Math.sin(az) * rr, y, Math.cos(az) * rr);
      const l = rand(rng, 0.5, 1.1);
      const s1 = s0.clone().add(new V3(Math.sin(az) * l, -l * 0.25, Math.cos(az) * l));
      addTube(b, [s0, s1], [0.07, 0.02], 4, REG.barkA, { bend, color: () => gray(0.7) });
    }
  }
  return b.build();
}

function buildPodocarp(rng, near) {
  const b = new GeoBuilder();
  const H = TREE_H.podocarp;
  const bend = treeBend(H, 0.5);
  const rings = near ? 7 : 3;
  const pts = [];
  const radii = [];
  for (let i = 0; i < rings; i++) {
    const t = i / (rings - 1);
    const y = lerp(-0.6, H * 0.98, t);
    pts.push(new V3(Math.sin(t * 4.3) * 0.08 * t, y, Math.sin(t * 3.1 + 1) * 0.06 * t));
    radii.push(lerp(0.42, 0.05, Math.pow(t, 0.9)) * (1 + 0.45 * Math.exp(-(y + 0.6) * 1.5)));
  }
  addTube(b, pts, radii, near ? 8 : 5, REG.barkA, { bend, color: trunkAO(0.4, 2.5, [0.82, 0.8, 0.8]), rng, v0: rng() });

  const tiers = near ? 12 : 5;
  for (let k = 0; k < tiers; k++) {
    const t = k / (tiers - 1);
    const y = lerp(H * 0.16, H * 0.93, Math.pow(t, 0.92));
    const reach = lerp(4.8, 0.95, Math.pow(t, 0.85)) * rand(rng, 0.88, 1.12) * (near ? 1 : 1.1);
    const nc = near ? Math.max(3, Math.round(lerp(7, 4, t))) : Math.max(3, Math.round(lerp(5, 3, t)));
    const az0 = rng() * TAU;
    const shade = lerp(0.55, 0.98, t);
    const centre = new V3(0, y - 1.6, 0);
    for (let j = 0; j < nc; j++) {
      const az = az0 + (j / nc) * TAU + rand(rng, -0.3, 0.3);
      const o = new V3(Math.sin(az) * 0.15, y + rand(rng, -0.3, 0.3), Math.cos(az) * 0.15);
      const e0 = rand(rng, 0.12, 0.3);
      const sp = arcSpine(o, az, e0, e0 - rand(rng, 0.45, 0.75), reach, near ? 2 : 1, rand(rng, -0.25, 0.25));
      addRibbon(b, sp.pts, sp.sidesH, Math.max(1.3, reach * 0.85), REG.fir, "along", {
        centre, bendN: 0.5, bend, flutter: (s) => s * 0.55,
        color: (s) => gray(shade * lerp(0.7, 1.05, s)),
      });
    }
  }
  // Spire.
  const top = new V3(pts[rings - 1].x, H * 0.88, pts[rings - 1].z);
  const az = rng() * TAU;
  for (let j = 0; j < 2; j++) {
    const sp = arcSpine(top, az + j * Math.PI * 0.5, 1.5, 1.52, H * 0.15, near ? 2 : 1);
    addRibbon(b, sp.pts, sp.sidesH, 1.25, REG.fir, "along", {
      centre: new V3(0, H * 0.7, 0), bendN: 0.4, bend, flutter: (s) => s * 0.4, color: () => gray(1),
    });
  }
  return b.build();
}

function buildGinkgo(rng, near) {
  const b = new GeoBuilder();
  const H = TREE_H.ginkgo;
  const bend = treeBend(H, 0.55);
  const split = H * rand(rng, 0.3, 0.36);
  const lean = new V3(rand(rng, -0.4, 0.4), 0, rand(rng, -0.4, 0.4));
  const trunk = [];
  const tr = [];
  const rings = near ? 5 : 2;
  for (let i = 0; i < rings; i++) {
    const t = i / (rings - 1);
    const y = lerp(-0.6, split, t);
    trunk.push(new V3(lean.x * t * t, y, lean.z * t * t));
    tr.push(lerp(0.55, 0.38, t) * (1 + 0.5 * Math.exp(-(y + 0.6) * 1.3)));
  }
  const barkTint = [0.95, 0.92, 0.9];
  addTube(b, trunk, tr, near ? 9 : 5, REG.barkA, { bend, color: trunkAO(0.45, 2.5, barkTint), rough: near ? 0.06 : 0, rng, v0: rng() });
  const fork = trunk[rings - 1];
  const clumps = [];
  const az0 = rng() * TAU;
  for (let i = 0; i < 3; i++) {
    const az = az0 + (i / 3) * TAU + rand(rng, -0.4, 0.4);
    const e = rand(rng, 0.8, 1.1);
    const L = H * rand(rng, 0.3, 0.38);
    const sp = arcSpine(fork, az, e, e + 0.25, L, near ? 3 : 1);
    const n = sp.pts.length;
    addTube(b, sp.pts, sp.pts.map((_, k) => lerp(0.3, 0.13, k / (n - 1))), near ? 7 : 4, REG.barkA, { bend, color: () => barkTint, rng, v0: rng() });
    const end = sp.pts[n - 1];
    if (near) {
      for (const side of [-1, 1]) {
        const baz = az + side * rand(rng, 0.45, 0.85);
        const bs = arcSpine(end, baz, rand(rng, 0.35, 0.8), rand(rng, 0.6, 1.0), H * rand(rng, 0.17, 0.25), 2);
        addTube(b, bs.pts, [0.13, 0.08, 0.035], 5, REG.barkA, { bend, color: () => barkTint });
        clumps.push(bs.pts[2]);
      }
      const mid = sp.pts[1].clone().add(new V3(Math.sin(az) * 1.2, 0.6, Math.cos(az) * 1.2));
      clumps.push(mid);
    } else {
      clumps.push(end.clone().add(new V3(Math.sin(az) * 1.4, 1.2, Math.cos(az) * 1.4)));
    }
  }
  clumps.push(new V3(lean.x, H * 0.9, lean.z));
  const crown = new V3();
  for (const c of clumps) crown.add(c);
  crown.multiplyScalar(1 / clumps.length);
  crown.y -= 1;
  const tmp = new V3();
  for (const c of clumps) {
    const cards = near ? 10 : 4;
    for (let i = 0; i < cards; i++) {
      const out = tmp.subVectors(c, crown).normalize();
      const dir = out.clone().add(randomUnit(rng).multiplyScalar(0.8)).normalize();
      const pos = c.clone().add(randomUnit(rng).multiplyScalar(near ? 0.9 : 1.3));
      const shade = lerp(0.72, 1.02, clamp((pos.y - split) / (H - split), 0, 1));
      addQuad(b, pos, dir, randomUnit(rng), near ? rand(rng, 3.0, 3.8) : 4.6, REG.broadleaf, {
        centre: crown, bendN: 0.72, bend, flutter: 0.7,
        color: (p) => gray(shade * (0.78 + 0.22 * clamp(p.distanceTo(crown) / 5, 0, 1))),
      });
    }
  }
  return b.build();
}

function buildTreeFern(rng, near) {
  const b = new GeoBuilder();
  const H = TREE_H.treefern;
  const bend = treeBend(H, 0.4);
  const rings = near ? 7 : 3;
  const pts = [];
  const radii = [];
  for (let i = 0; i < rings; i++) {
    const t = i / (rings - 1);
    const y = lerp(-0.4, H, t);
    pts.push(new V3(Math.sin(t * 2.2) * 0.25 * t, y, t * t * 0.3));
    radii.push(lerp(0.21, 0.17, t) * (1 + 0.6 * Math.exp(-(y + 0.4) * 2)) * (t > 0.84 ? 1.22 : 1));
  }
  addTube(b, pts, radii, near ? 8 : 5, REG.barkB, { bend, color: trunkAO(0.5, 1.5), rough: near ? 0.08 : 0, rng, v0: rng() });
  const top = pts[rings - 1];
  const crown = top.clone().add(new V3(0, -0.4, 0));
  const nf = near ? 12 : 7;
  const az0 = rng() * TAU;
  for (let j = 0; j < nf; j++) {
    const az = az0 + (j / nf) * TAU + rand(rng, -0.2, 0.2);
    const sp = arcSpine(top, az, rand(rng, 0.65, 1.0), rand(rng, -0.75, -0.35), rand(rng, 3.0, 3.9) * (near ? 1 : 1.05), near ? 5 : 2, rand(rng, -0.2, 0.2));
    addRibbon(b, sp.pts, sp.sidesH, near ? 1.35 : 1.6, REG.treefern, "along", {
      centre: crown, bendN: 0.45, bend, flutter: (s) => s * 0.9, color: (s) => gray(lerp(0.66, 1.05, s)),
    });
  }
  if (near) {
    for (let j = 0; j < 3; j++) {
      const sp = arcSpine(top, az0 + (j / 3) * TAU + 0.5, 1.3, 0.85, 1.6, 3);
      addRibbon(b, sp.pts, sp.sidesH, 0.9, REG.treefern, "along", {
        centre: crown, bendN: 0.4, bend, flutter: (s) => s * 0.7, color: (s) => gray(lerp(0.85, 1.1, s)),
      });
    }
  }
  // Skirt of withered fronds hanging against the trunk.
  const dead = near ? 5 : 3;
  for (let j = 0; j < dead; j++) {
    const az = az0 + (j / dead) * TAU + 0.3;
    const o = top.clone().add(new V3(0, -0.2, 0));
    const sp = arcSpine(o, az, -0.55, -1.35, rand(rng, 2.0, 2.6), near ? 3 : 1, rand(rng, -0.4, 0.4));
    addRibbon(b, sp.pts, sp.sidesH, 1.05, REG.deadfrond, "along", {
      centre: crown, bendN: 0.3, bend, flutter: (s) => s * 0.3, color: () => gray(0.85),
    });
  }
  return b.build();
}

function buildSnag(rng, near) {
  const b = new GeoBuilder();
  const H = TREE_H.snag;
  const bend = treeBend(H, 0.1);
  const rings = near ? 8 : 3;
  const sides = near ? 9 : 5;
  const pts = [];
  const radii = [];
  for (let i = 0; i < rings; i++) {
    const t = i / (rings - 1);
    const y = lerp(-0.6, H, t);
    pts.push(new V3(t * t * 0.6, y, Math.sin(t * 3) * 0.1));
    radii.push(lerp(0.46, 0.2, t) * (1 + 0.5 * Math.exp(-(y + 0.6) * 1.4)));
  }
  const pale = [1.75, 1.68, 1.6];
  const tube = addTube(b, pts, radii, sides, REG.barkA, { bend, color: trunkAO(0.45, 2, pale), rough: near ? 0.07 : 0, rng, v0: rng() });
  // Jagged break at the top.
  const ring = tube.start + (rings - 1) * tube.ring;
  const jag = [];
  for (let j = 0; j < sides; j++) jag.push(rand(rng, -1.0, 0.2) - (j % 3 === 0 ? 0.5 : 0));
  jag.push(jag[0]);
  for (let j = 0; j <= sides; j++) b.pos[(ring + j) * 3 + 1] += jag[j];
  addCap(b, ring, tube.ring, pts[rings - 1].clone().add(new V3(0, -0.6, 0)), new V3(0, 1, 0), [2.1, 1.85, 1.5], bend, [REG.barkB.x + 0.06, 0.5]);
  const nb = near ? 5 : 2;
  for (let i = 0; i < nb; i++) {
    const y = rand(rng, H * 0.35, H * 0.82);
    const az = rng() * TAU;
    const t = (y + 0.6) / (H + 0.6);
    const c = new V3(t * t * 0.6, y, Math.sin(t * 3) * 0.1);
    const sp = arcSpine(c, az, rand(rng, 0.25, 0.85), rand(rng, 0.4, 1.0), rand(rng, 1.4, 3.4) * (1 - t * 0.4), near ? 2 : 1);
    addTube(b, sp.pts, sp.pts.map((_, k) => lerp(0.12, 0.025, k / (sp.pts.length - 1))), near ? 4 : 3, REG.barkA, { bend, color: () => pale });
  }
  return b.build();
}

/* --- Logs, food plants, grass ------------------------------------------------------------- */

function buildLog(rng) {
  const b = new GeoBuilder();
  const L = 7;
  const n = 8;
  const pts = [];
  const radii = [];
  for (let i = 0; i < n; i++) {
    const t = i / (n - 1);
    pts.push(new V3(lerp(-L / 2, L / 2, t), Math.sin(t * Math.PI) * 0.08, Math.sin(t * 2.3) * 0.15));
    radii.push(lerp(0.44, 0.3, t) * (t < 0.12 ? 1.2 : 1));
  }
  const moss = (t, nx, ny) => {
    const m = smoothstep(0.1, 0.75, ny) * 0.85;
    return [lerp(1.25, 0.62, m), lerp(1.18, 0.9, m), lerp(1.1, 0.36, m)];
  };
  const tube = addTube(b, pts, radii, 10, REG.barkA, { color: moss, rough: 0.06, rng, v0: rng() });
  const endGrain = [1.9, 1.6, 1.2];
  addCap(b, tube.start, tube.ring, pts[0].clone().add(new V3(-0.05, 0, 0)), new V3(-1, 0, 0), endGrain, ZERO, [REG.barkB.x + 0.06, 0.25]);
  const tip = pts[n - 1].clone().add(new V3(0.05, 0, 0));
  addCap(b, tube.start + (n - 1) * tube.ring, tube.ring, tip, new V3(1, 0, 0), endGrain, ZERO, [REG.barkB.x + 0.06, 0.75]);
  for (let i = 0; i < 3; i++) {
    const t = rand(rng, 0.2, 0.85);
    const a = rand(rng, -1.2, 1.2);
    const base = new V3(lerp(-L / 2, L / 2, t), 0, 0);
    const r = lerp(0.44, 0.3, t);
    const d = new V3(rand(rng, -0.3, 0.3), Math.cos(a), Math.sin(a)).normalize();
    const stub = [base.clone().addScaledVector(d, r * 0.7), base.clone().addScaledVector(d, r + rand(rng, 0.3, 0.7))];
    addTube(b, stub, [0.09, 0.03], 5, REG.barkA, { color: moss });
  }
  return b.build();
}

function buildFern(rng) {
  const b = new GeoBuilder();
  const centre = new V3(0, 0.22, 0);
  const bend = (x, y, z) => 0.09 * (Math.hypot(x, z) / 1.2 + clamp(y, 0, 1.5) / 1.2);
  const nf = 13;
  const az0 = rng() * TAU;
  for (let j = 0; j < nf + 3; j++) {
    const young = j >= nf;
    const az = young ? az0 + j * 2.1 : az0 + (j / nf) * TAU + rand(rng, -0.25, 0.25);
    const o = new V3(rand(rng, -0.07, 0.07), 0, rand(rng, -0.07, 0.07));
    const sp = young
      ? arcSpine(o, az, 1.35, 0.85, rand(rng, 0.65, 0.85), 3, 0, 1)
      : arcSpine(o, az, rand(rng, 0.9, 1.25), rand(rng, -0.45, -0.05), rand(rng, 1.0, 1.45), 3, rand(rng, -0.35, 0.35), 0.8);
    addRibbon(b, sp.pts, sp.sidesH, young ? 0.36 : rand(rng, 0.48, 0.58), REG.fern, "along", {
      centre, bendN: 0.55, bend, flutter: (s) => s,
      color: (s) => gray(lerp(young ? 0.8 : 0.52, 1.05, s)),
    });
  }
  return b.build();
}

function buildCycad(rng) {
  const b = new GeoBuilder();
  const Ht = 1.25;
  const rings = 5;
  const pts = [];
  const radii = [0.34, 0.38, 0.36, 0.31, 0.26];
  for (let i = 0; i < rings; i++) pts.push(new V3(0, lerp(-0.25, Ht, i / (rings - 1)), 0));
  const bend = (x, y, z) => 0.06 * (Math.hypot(x, z) / 1.8 + clamp(y - Ht, 0, 2) / 2);
  addTube(b, pts, radii, 10, REG.barkB, { color: trunkAO(0.5, 0.8, [1.15, 1.02, 0.85]), rough: 0.05, rng, v0: rng() });
  const top = new V3(0, Ht - 0.05, 0);
  const crown = new V3(0, Ht + 0.2, 0);
  const nf = 16;
  for (let j = 0; j < nf + 5; j++) {
    const young = j >= nf;
    const az = j * 2.39996 + rand(rng, -0.1, 0.1);
    const sp = young
      ? arcSpine(top, az, 1.35, 1.05, rand(rng, 1.0, 1.3), 3)
      : arcSpine(top, az, rand(rng, 0.7, 1.05), rand(rng, -0.25, 0.12), rand(rng, 1.7, 2.25), 4, rand(rng, -0.25, 0.25));
    addRibbon(b, sp.pts, sp.sidesH, young ? 0.62 : 0.86, REG.cycad, "along", {
      centre: crown, bendN: 0.5, bend, flutter: (s) => s * 0.5,
      color: (s) => gray(lerp(young ? 0.85 : 0.6, 1.05, s)),
    });
  }
  // Seed cone.
  const cone = [new V3(0, Ht - 0.1, 0), new V3(0, Ht + 0.15, 0), new V3(0.02, Ht + 0.38, 0), new V3(0.03, Ht + 0.5, 0)];
  addTube(b, cone, [0.15, 0.16, 0.11, 0.02], 7, REG.barkB, { color: () => [1.9, 1.45, 0.75] });
  return b.build();
}

function buildHorsetail(rng) {
  const b = new GeoBuilder();
  const centre = new V3(0, 0.5, 0);
  const bend = (x, y) => 0.12 * Math.pow(clamp(y / 1.5, 0, 1.3), 1.6);
  const cards = 7;
  for (let j = 0; j < cards; j++) {
    const yaw = (j / cards) * Math.PI + rand(rng, -0.15, 0.15);
    const base = new V3(rand(rng, -0.25, 0.25), -0.05, rand(rng, -0.25, 0.25));
    const H = rand(rng, 1.25, 1.75) * (j === cards - 1 ? 0.7 : 1);
    const lean = rand(rng, 0.04, 0.16);
    const lAz = rng() * TAU;
    const pts = [];
    for (let i = 0; i <= 2; i++) {
      const t = i / 2;
      pts.push(base.clone().add(new V3(Math.sin(lAz) * lean * H * t * t, H * t, Math.cos(lAz) * lean * H * t * t)));
    }
    const S = new V3(Math.cos(yaw), 0, -Math.sin(yaw));
    addRibbon(b, pts, [S, S, S], rand(rng, 0.9, 1.1), REG.horsetail, "up", {
      centre, bendN: 0.35, bend, flutter: (s) => s * 0.7, color: (s) => gray(lerp(0.6, 1.02, s)),
    });
  }
  return b.build();
}

function buildShrub(rng) {
  const b = new GeoBuilder();
  const C = new V3(0, 0.75, 0);
  const bend = (x, y) => 0.06 * clamp(y / 1.5, 0, 1.4);
  const n = 18;
  for (let i = 0; i < n + 3; i++) {
    const inner = i >= n;
    let dir;
    let pos;
    if (inner) {
      dir = randomUnit(rng);
      pos = C.clone().add(new V3(rand(rng, -0.2, 0.2), rand(rng, -0.25, 0.05), rand(rng, -0.2, 0.2)));
    } else {
      const y = lerp(1, -0.35, (i + 0.5) / n);
      const r = Math.sqrt(1 - y * y);
      const a = i * 2.39996;
      dir = new V3(Math.cos(a) * r, y, Math.sin(a) * r);
      pos = C.clone().add(new V3(dir.x * 0.55, dir.y * 0.42, dir.z * 0.55).multiplyScalar(rand(rng, 0.85, 1.12)));
      dir.add(randomUnit(rng).multiplyScalar(0.35)).normalize();
    }
    const shade = inner ? 0.5 : lerp(0.55, 1.05, clamp(pos.y / 1.45, 0, 1));
    addQuad(b, pos, dir, randomUnit(rng), inner ? 1.2 : rand(rng, 1.05, 1.35), REG.shrub, {
      centre: C, bendN: 0.8, bend, flutter: 0.5, color: () => gray(shade),
    });
  }
  return b.build();
}

function buildGrassClump(rng) {
  const b = new GeoBuilder();
  const bend = (x, y) => 0.2 * Math.pow(clamp(y / 0.62, 0, 1.3), 2);
  for (let j = 0; j < 3; j++) {
    const yaw = (j / 3) * Math.PI + rand(rng, -0.2, 0.2);
    const S = new V3(Math.cos(yaw), 0, -Math.sin(yaw));
    const lx = rand(rng, -0.06, 0.06);
    const lz = rand(rng, -0.06, 0.06);
    const pts = [new V3(0, -0.03, 0), new V3(lx * 0.3, 0.3, lz * 0.3), new V3(lx, 0.62, lz)];
    addRibbon(b, pts, [S, S, S], 0.9, j === 2 ? REG.grassDry : REG.grass, "up", {
      upN: 0.7, bend, flutter: (s) => s * 0.5, color: (s) => gray(lerp(0.72, 1.05, s)),
    });
  }
  return b.build();
}

function buildUndergrowth(rng) {
  const b = new GeoBuilder();
  const centre = new V3(0, 0.12, 0);
  const bend = (x, y, z) => 0.07 * (Math.hypot(x, z) / 0.6 + clamp(y, 0, 1));
  {
    const yaw = rand(rng, 0, Math.PI);
    const S = new V3(Math.cos(yaw), 0, -Math.sin(yaw));
    const pts = [new V3(0, -0.03, 0), new V3(0, 0.24, 0), new V3(0, 0.5, 0)];
    addRibbon(b, pts, [S, S, S], 0.66, REG.herb, "up", {
      centre, bendN: 0.4, upN: 0.3, bend, flutter: (s) => s * 0.6, color: (s) => gray(lerp(0.65, 1.0, s)),
    });
  }
  const az0 = rng() * TAU;
  for (let j = 0; j < 7; j++) {
    const az = az0 + (j / 7) * TAU + rand(rng, -0.3, 0.3);
    const sp = arcSpine(new V3(0, 0, 0), az, rand(rng, 0.8, 1.1), rand(rng, -0.3, 0.1), rand(rng, 0.5, 0.7), 2, rand(rng, -0.3, 0.3));
    addRibbon(b, sp.pts, sp.sidesH, 0.3, REG.fern, "along", {
      centre, bendN: 0.5, bend, flutter: (s) => s, color: (s) => gray(lerp(0.6, 1.0, s)),
    });
  }
  return b.build();
}

/* --- Rocks -------------------------------------------------------------------------------- */

function hash3(ix, iy, iz, seed) {
  let h = (Math.imul(ix, 374761393) + Math.imul(iy, 668265263) + Math.imul(iz, 1440662683) + seed) | 0;
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  return ((h ^ (h >>> 16)) >>> 0) / 4294967296;
}

/** Smooth 3D value noise in [-1, 1] (build-time only). */
function noise3(x, y, z, seed) {
  const ix = Math.floor(x);
  const iy = Math.floor(y);
  const iz = Math.floor(z);
  const fx = x - ix;
  const fy = y - iy;
  const fz = z - iz;
  const u = fx * fx * (3 - 2 * fx);
  const v = fy * fy * (3 - 2 * fy);
  const w = fz * fz * (3 - 2 * fz);
  const c = (a, b2, d) => hash3(ix + a, iy + b2, iz + d, seed);
  const x00 = lerp(c(0, 0, 0), c(1, 0, 0), u);
  const x10 = lerp(c(0, 1, 0), c(1, 1, 0), u);
  const x01 = lerp(c(0, 0, 1), c(1, 0, 1), u);
  const x11 = lerp(c(0, 1, 1), c(1, 1, 1), u);
  return lerp(lerp(x00, x10, v), lerp(x01, x11, v), w) * 2 - 1;
}

/** Indexed icosphere (shared vertices → smooth normals). */
function icosphere(detail) {
  const t = (1 + Math.sqrt(5)) / 2;
  const verts = [[-1, t, 0], [1, t, 0], [-1, -t, 0], [1, -t, 0], [0, -1, t], [0, 1, t], [0, -1, -t], [0, 1, -t],
    [t, 0, -1], [t, 0, 1], [-t, 0, -1], [-t, 0, 1]].map((v) => new V3(...v).normalize());
  let faces = [[0, 11, 5], [0, 5, 1], [0, 1, 7], [0, 7, 10], [0, 10, 11], [1, 5, 9], [5, 11, 4], [11, 10, 2], [10, 7, 6],
    [7, 1, 8], [3, 9, 4], [3, 4, 2], [3, 2, 6], [3, 6, 8], [3, 8, 9], [4, 9, 5], [2, 4, 11], [6, 2, 10], [8, 6, 7], [9, 8, 1]];
  for (let d = 0; d < detail; d++) {
    const cache = new Map();
    const mid = (a, b2) => {
      const key = a < b2 ? a * 100000 + b2 : b2 * 100000 + a;
      let i = cache.get(key);
      if (i === undefined) {
        i = verts.length;
        verts.push(verts[a].clone().add(verts[b2]).normalize());
        cache.set(key, i);
      }
      return i;
    };
    const next = [];
    for (const [a, b2, c] of faces) {
      const ab = mid(a, b2);
      const bc = mid(b2, c);
      const ca = mid(c, a);
      next.push([a, ab, ca], [b2, bc, ab], [c, ca, bc], [ab, bc, ca]);
    }
    faces = next;
  }
  return { verts, faces };
}

/**
 * Boulder: noise-displaced icosphere with a few planar facets (a touch of
 * fractured, hard-edged stone) and a flattened, sunk base. The same seed gives
 * the same silhouette at any detail, so near and far LODs match.
 */
function buildRockGeometry(detail, seed) {
  const { verts, faces } = icosphere(detail);
  const rng = makeRng(hash(seed, "rock-shape"));
  const planes = [];
  for (let i = 0; i < 6; i++) {
    const n = randomUnit(rng);
    n.y = clamp(n.y, -0.15, 0.85);
    planes.push({ n: n.normalize(), d: rand(rng, 0.7, 0.86) });
  }
  const ns = (rng() * 1e6) | 0;
  const pos = new Float32Array(verts.length * 3);
  const q = new V3();
  for (let i = 0; i < verts.length; i++) {
    const p = verts[i];
    const r = 1 + 0.2 * noise3(p.x * 1.5, p.y * 1.5, p.z * 1.5, ns) + 0.06 * noise3(p.x * 4.2, p.y * 4.2, p.z * 4.2, ns + 7);
    q.copy(p).multiplyScalar(r);
    for (const pl of planes) {
      const dd = q.dot(pl.n) - pl.d;
      if (dd > 0) q.addScaledVector(pl.n, -dd * 0.88);
    }
    if (q.y < -0.3) q.y = -0.3 + (q.y + 0.3) * 0.25;
    pos[i * 3] = q.x * 1.08;
    pos[i * 3 + 1] = q.y;
    pos[i * 3 + 2] = q.z * 0.96;
  }
  const idx = [];
  for (const f of faces) idx.push(f[0], f[1], f[2]);
  const g = new THREE.BufferGeometry();
  g.setAttribute("position", new THREE.BufferAttribute(pos, 3));
  g.setIndex(idx);
  g.computeVertexNormals();
  g.computeBoundingSphere();
  return g;
}

/* --- Spatial hash ------------------------------------------------------------------------- */

/** Flat grid of buckets over the terrain tile (items carry x, z). */
class SpatialHash {
  constructor(half, cell) {
    this.half = half;
    this.cell = cell;
    this.n = Math.ceil((half * 2) / cell) + 1;
    this.cells = new Array(this.n * this.n);
    this.maxR = 0; // largest item radius, widens queries
    this.ix0 = 0;
    this.ix1 = 0;
    this.iz0 = 0;
    this.iz1 = 0;
  }
  _i(v) {
    return clamp(Math.floor((v + this.half) / this.cell), 0, this.n - 1);
  }
  insert(item) {
    const k = this._i(item.z) * this.n + this._i(item.x);
    (this.cells[k] || (this.cells[k] = [])).push(item);
    if (item.r > this.maxR) this.maxR = item.r;
  }
  /** Sets the cell range covering a query circle (read ix0..iz1 afterwards). */
  range(x, z, r) {
    this.ix0 = this._i(x - r);
    this.ix1 = this._i(x + r);
    this.iz0 = this._i(z - r);
    this.iz1 = this._i(z + r);
  }
  /** True if any item lies within `r` (+ its own radius) of (x, z). */
  any(x, z, r) {
    this.range(x, z, r + this.maxR);
    for (let iz = this.iz0; iz <= this.iz1; iz++) {
      for (let ix = this.ix0; ix <= this.ix1; ix++) {
        const list = this.cells[iz * this.n + ix];
        if (!list) continue;
        for (let i = 0; i < list.length; i++) {
          const c = list[i];
          const dx = c.x - x;
          const dz = c.z - z;
          const rr = r + (c.r || 0);
          if (dx * dx + dz * dz < rr * rr) return true;
        }
      }
    }
    return false;
  }
}

/* --- Instance helpers ----------------------------------------------------------------------- */

/** Column-major TRS with yaw only (food plants, grass): no allocation. */
function writeTRS(a, o, x, y, z, yaw, sxz, sy) {
  const c = Math.cos(yaw);
  const s = Math.sin(yaw);
  a[o] = c * sxz;
  a[o + 1] = 0;
  a[o + 2] = -s * sxz;
  a[o + 3] = 0;
  a[o + 4] = 0;
  a[o + 5] = sy;
  a[o + 6] = 0;
  a[o + 7] = 0;
  a[o + 8] = s * sxz;
  a[o + 9] = 0;
  a[o + 10] = c * sxz;
  a[o + 11] = 0;
  a[o + 12] = x;
  a[o + 13] = y;
  a[o + 14] = z;
  a[o + 15] = 1;
}

function makeInstanced(geo, mat, capacity, { dynamic = false, cast = false, receive = true, depth = null } = {}) {
  const m = new THREE.InstancedMesh(geo, mat, Math.max(1, capacity));
  m.instanceColor = new THREE.InstancedBufferAttribute(new Float32Array(Math.max(1, capacity) * 3).fill(1), 3);
  if (dynamic) {
    m.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    m.instanceColor.setUsage(THREE.DynamicDrawUsage);
  }
  m.count = 0;
  m.castShadow = cast;
  m.receiveShadow = receive;
  if (depth) m.customDepthMaterial = depth;
  m.matrixAutoUpdate = false;
  m.boundingSphere = new THREE.Sphere(new V3(), 1);
  return m;
}

/** Flag the first `count` instances for upload (not the whole capacity). */
function markInstances(mesh, count, extra = null) {
  const im = mesh.instanceMatrix;
  im.clearUpdateRanges();
  im.addUpdateRange(0, Math.max(1, count) * 16);
  im.needsUpdate = true;
  const ic = mesh.instanceColor;
  ic.clearUpdateRanges();
  ic.addUpdateRange(0, Math.max(1, count) * 3);
  ic.needsUpdate = true;
  if (extra) {
    extra.clearUpdateRanges();
    extra.addUpdateRange(0, Math.max(1, count));
    extra.needsUpdate = true;
  }
}

/**
 * Two-LOD instance lists for one family of objects (trees, rocks; or one-LOD
 * food plants and logs with no far meshes), bucketed into LOD_CHUNK chunks.
 * `update` refills the near/far InstancedMeshes with every chunk that can
 * contain a visible instance until the focus has moved LOD_REBUILD metres; the
 * exact per-instance hand-over happens in the shader. With `slots`, `slot[i]`
 * is item i's current near-mesh instance (-1 when not listed) so single
 * instances can be rewritten in place.
 *
 * The far list (which casts no shadows) is also culled to the last rendered
 * view (`view`, see Vegetation#_onView): chunks outside the frustum, or whose
 * nearest point is deeper than the fog's far end (pure fog colour), are left
 * out. `checkView` rebuilds it only when something on screen is missing or a
 * lot of what is listed has left the view, keeping a margin so turning is cheap
 * (the view is one frame old when the lists draw; the margin covers that too).
 */
class LodSet {
  constructor(half, items, nearMeshes, farMeshes, { nearR, band, farR, slots = false }) {
    this.half = half;
    this.items = items; // { count, type: Uint8Array, mat: Float32Array, col: Float32Array, extra: Float32Array|null }
    this.near = nearMeshes;
    this.far = farMeshes;
    this.nearR = nearR;
    this.band = band;
    this.farR = farR;
    this.nc = Math.ceil((half * 2) / LOD_CHUNK);
    const nc2 = this.nc * this.nc;
    const start = new Int32Array(nc2 + 1);
    const chunkOf = new Int32Array(items.count);
    for (let i = 0; i < items.count; i++) {
      const cx = clamp(Math.floor((items.mat[i * 16 + 12] + half) / LOD_CHUNK), 0, this.nc - 1);
      const cz = clamp(Math.floor((items.mat[i * 16 + 14] + half) / LOD_CHUNK), 0, this.nc - 1);
      chunkOf[i] = cz * this.nc + cx;
      start[chunkOf[i] + 1]++;
    }
    for (let c = 0; c < nc2; c++) start[c + 1] += start[c];
    const fill = start.slice(0, nc2);
    this.order = new Int32Array(items.count);
    for (let i = 0; i < items.count; i++) this.order[fill[chunkOf[i]]++] = i;
    this.start = start;
    this.nn = new Int32Array(nearMeshes.length);
    this.fn = new Int32Array(farMeshes.length);
    this.slot = slots ? new Int32Array(items.count).fill(-1) : null;
    this.lastX = Infinity;
    this.lastZ = Infinity;
    /** Last rendered view { planes, px, py, pz, dx, dy, dz, fogFar } or null (no culling). */
    this.view = null;
    if (farMeshes.length) {
      // Vertical extent per chunk (instance bases up to FAR_TOP above) for the view tests.
      this.ylo = new Float32Array(nc2).fill(1e9);
      this.yhi = new Float32Array(nc2).fill(-1e9);
      for (let i = 0; i < items.count; i++) {
        const c = chunkOf[i];
        const y = items.mat[i * 16 + 13];
        if (y < this.ylo[c]) this.ylo[c] = y;
        if (y + FAR_TOP > this.yhi[c]) this.yhi[c] = y + FAR_TOP;
      }
      this.farOn = new Uint8Array(nc2); // chunk is in the far lists right now
    }
  }

  update(fx, fz, force = false) {
    const dx = fx - this.lastX;
    const dz = fz - this.lastZ;
    if (!force && dx * dx + dz * dz < LOD_REBUILD * LOD_REBUILD) return false;
    this.lastX = fx;
    this.lastZ = fz;
    const { items, nn, near, nc, half, slot } = this;
    nn.fill(0);
    if (slot) slot.fill(-1);
    const nearMax = this.nearR + LOD_REBUILD;
    const cz0 = clamp(Math.floor((fz - nearMax + half) / LOD_CHUNK), 0, nc - 1);
    const cz1 = clamp(Math.floor((fz + nearMax + half) / LOD_CHUNK), 0, nc - 1);
    const cx0 = clamp(Math.floor((fx - nearMax + half) / LOD_CHUNK), 0, nc - 1);
    const cx1 = clamp(Math.floor((fx + nearMax + half) / LOD_CHUNK), 0, nc - 1);
    for (let cz = cz0; cz <= cz1; cz++) {
      const z0 = -half + cz * LOD_CHUNK;
      const ddz = Math.max(z0 - fz, 0, fz - (z0 + LOD_CHUNK));
      for (let cx = cx0; cx <= cx1; cx++) {
        const c = cz * nc + cx;
        const s0 = this.start[c];
        const s1 = this.start[c + 1];
        if (s0 === s1) continue;
        const x0 = -half + cx * LOD_CHUNK;
        const ddx = Math.max(x0 - fx, 0, fx - (x0 + LOD_CHUNK));
        if (ddx * ddx + ddz * ddz >= nearMax * nearMax) continue;
        for (let k = s0; k < s1; k++) {
          const i = this.order[k];
          const t = items.type[i];
          if (slot) slot[i] = nn[t];
          this._copy(i, near[t], nn[t]++);
        }
      }
    }
    for (let t = 0; t < near.length; t++) this._finish(near[t], nn[t], fx, fz, this.nearR + LOD_REBUILD + 40);
    if (this.far.length) this._rebuildFar();
    return true;
  }

  /** Is chunk `c` of the far ring around the last focus (and its 0/1 view state with `margin`)? */
  _farWanted(c, cx, cz, margin) {
    const fx = this.lastX;
    const fz = this.lastZ;
    const x0 = -this.half + cx * LOD_CHUNK;
    const z0 = -this.half + cz * LOD_CHUNK;
    const ddx = Math.max(x0 - fx, 0, fx - (x0 + LOD_CHUNK));
    const ddz = Math.max(z0 - fz, 0, fz - (z0 + LOD_CHUNK));
    const fdx = Math.max(Math.abs(fx - x0), Math.abs(fx - x0 - LOD_CHUNK));
    const fdz = Math.max(Math.abs(fz - z0), Math.abs(fz - z0 - LOD_CHUNK));
    const farMin = this.nearR - this.band - LOD_REBUILD;
    const farMax = this.farR + LOD_REBUILD;
    if (fdx * fdx + fdz * fdz <= farMin * farMin || ddx * ddx + ddz * ddz >= farMax * farMax) return false;
    const v = this.view;
    if (!v) return true;
    const x1 = x0 + LOD_CHUNK;
    const z1 = z0 + LOD_CHUNK;
    const y0 = this.ylo[c];
    const y1 = this.yhi[c];
    // Frustum (planes pushed out by `margin`).
    for (let i = 0; i < 6; i++) {
      const pl = v.planes[i];
      const n = pl.normal;
      if (n.x * (n.x > 0 ? x1 : x0) + n.y * (n.y > 0 ? y1 : y0) + n.z * (n.z > 0 ? z1 : z0) + pl.constant < -margin) return false;
    }
    // Nearest view depth of the box vs the fog's far end.
    const d =
      (v.dx > 0 ? x0 : x1) * v.dx + (v.dy > 0 ? y0 : y1) * v.dy + (v.dz > 0 ? z0 : z1) * v.dz - (v.px * v.dx + v.py * v.dy + v.pz * v.dz);
    return d < v.fogFar + margin;
  }

  _rebuildFar() {
    const { items, fn, far, nc, farOn } = this;
    fn.fill(0);
    farOn.fill(0);
    const fx = this.lastX;
    const fz = this.lastZ;
    const r = this.farR + LOD_REBUILD;
    const cz0 = clamp(Math.floor((fz - r + this.half) / LOD_CHUNK), 0, nc - 1);
    const cz1 = clamp(Math.floor((fz + r + this.half) / LOD_CHUNK), 0, nc - 1);
    const cx0 = clamp(Math.floor((fx - r + this.half) / LOD_CHUNK), 0, nc - 1);
    const cx1 = clamp(Math.floor((fx + r + this.half) / LOD_CHUNK), 0, nc - 1);
    for (let cz = cz0; cz <= cz1; cz++) {
      for (let cx = cx0; cx <= cx1; cx++) {
        const c = cz * nc + cx;
        const s0 = this.start[c];
        const s1 = this.start[c + 1];
        if (s0 === s1 || !this._farWanted(c, cx, cz, FAR_VIEW_MARGIN)) continue;
        farOn[c] = 1;
        for (let k = s0; k < s1; k++) {
          const i = this.order[k];
          const t = items.type[i];
          if (far[t]) this._copy(i, far[t], fn[t]++);
        }
      }
    }
    for (let t = 0; t < far.length; t++) if (far[t]) this._finish(far[t], fn[t], fx, fz, this.farR + LOD_REBUILD + 40);
    this.farRebuilds = (this.farRebuilds || 0) + 1;
  }

  /** After the view changed: rebuild the far lists if needed (see class comment). */
  checkView() {
    if (!this.far.length || !Number.isFinite(this.lastX)) return;
    const { nc, farOn } = this;
    const fx = this.lastX;
    const fz = this.lastZ;
    const r = this.farR + LOD_REBUILD;
    const cz0 = clamp(Math.floor((fz - r + this.half) / LOD_CHUNK), 0, nc - 1);
    const cz1 = clamp(Math.floor((fz + r + this.half) / LOD_CHUNK), 0, nc - 1);
    const cx0 = clamp(Math.floor((fx - r + this.half) / LOD_CHUNK), 0, nc - 1);
    const cx1 = clamp(Math.floor((fx + r + this.half) / LOD_CHUNK), 0, nc - 1);
    let have = 0;
    let want = 0;
    for (let cz = cz0; cz <= cz1; cz++) {
      for (let cx = cx0; cx <= cx1; cx++) {
        const c = cz * nc + cx;
        const n = this.start[c + 1] - this.start[c];
        if (!n) continue;
        const wide = this._farWanted(c, cx, cz, FAR_VIEW_MARGIN);
        if (farOn[c]) have += n;
        if (wide) want += n;
        // Something about to come on screen isn't listed: rebuild now. The view is
        // a frame old by the time the lists draw, so test with half the margin.
        if (wide && !farOn[c] && this._farWanted(c, cx, cz, FAR_VIEW_MARGIN * 0.5)) return this._rebuildFar();
      }
    }
    if (have > want * 1.3 + 64) this._rebuildFar();
  }

  _copy(i, mesh, j) {
    const src = this.items.mat;
    const dst = mesh.instanceMatrix.array;
    const s = i * 16;
    const d = j * 16;
    for (let q = 0; q < 16; q++) dst[d + q] = src[s + q];
    const sc = this.items.col;
    const dc = mesh.instanceColor.array;
    dc[j * 3] = sc[i * 3];
    dc[j * 3 + 1] = sc[i * 3 + 1];
    dc[j * 3 + 2] = sc[i * 3 + 2];
    const ex = this.items.extra;
    if (ex) mesh.geometry.attributes.aMoss.array[j] = ex[i];
  }

  _finish(mesh, count, fx, fz, radius) {
    mesh.count = count;
    // The view anchor stays "visible" with no instances (three skips the empty
    // draw) so its onBeforeRender keeps reporting the camera.
    mesh.visible = count > 0 || mesh.userData.vegViewAnchor === true;
    markInstances(mesh, count, this.items.extra ? mesh.geometry.attributes.aMoss : null);
    mesh.boundingSphere.center.set(fx, 0, fz);
    mesh.boundingSphere.radius = radius;
  }
}

/* --- Grass & undergrowth around the focus ------------------------------------------------- */

const GRASS_CHUNK = 12;
const GRASS_BUILDS = 3; // new grass chunks generated per frame while walking (each ≈1 ms); the rest follow
const UNDER_TRIES = 40; // undergrowth candidates per chunk
const GRASS_DENSITY = { plains: 0.62, forest: 0.13, swamp: 0.42, highland: 0.3, beach: 0.04, rock: 0.02 };
const UNDER_DENSITY = { forest: 0.24, swamp: 0.1, plains: 0.018, highland: 0.006 };
const GRASS_TINT = {
  forest: [0.78, 0.9, 0.7],
  swamp: [1.0, 1.05, 0.7],
  highland: [0.92, 0.93, 0.8],
  beach: [1.25, 1.12, 0.8],
  rock: [0.95, 0.95, 0.85],
};

/**
 * Grass tufts and forest-floor herbs/ferns within `radius` of the focus,
 * generated deterministically per 12 m chunk (cached) and shrunk to nothing by
 * the shader over the outer band, so recentring never pops.
 */
class GrassField {
  constructor(veg, low) {
    this.veg = veg;
    this.radius = low ? 52 : 74;
    this.band = low ? 14 : 18;
    const span = this.radius + GRASS_CHUNK * 1.5;
    const area = Math.PI * span * span;
    const d = Math.max(0.3, veg.density);
    this.grassCap = Math.ceil(area * 0.66 * d);
    this.underCap = Math.ceil(area * 0.26 * d);
    const rng = makeRng(hash(veg.seed, "grass-geo"));
    this.grass = makeInstanced(buildGrassClump(rng), veg._mat.grass, this.grassCap, { dynamic: true, receive: true });
    this.under = makeInstanced(buildUndergrowth(rng), veg._mat.grass, this.underCap, { dynamic: true, receive: true });
    this.grass.name = "veg-grass";
    this.under.name = "veg-undergrowth";
    this.cache = new Map();
    this.pending = false; // some chunks in reach still to be generated
    this.lastX = Infinity;
    this.lastZ = Infinity;
  }

  update(fx, fz, force = false) {
    const dx = fx - this.lastX;
    const dz = fz - this.lastZ;
    const step = GRASS_CHUNK * 0.5;
    const moved = dx * dx + dz * dz;
    if (!force && !this.pending && moved < step * step) return;
    this.lastX = fx;
    this.lastZ = fz;
    const half = this.veg.terrain.half;
    const reach = this.radius + step;
    // Walking only uncovers chunks at the faded rim: build a few per frame
    // instead of a whole row at once (a ~15 ms hitch). Jumps build everything.
    let budget = force || moved > reach * reach * 0.25 ? Infinity : GRASS_BUILDS;
    this.pending = false;
    const c0x = Math.floor((fx - reach + half) / GRASS_CHUNK);
    const c1x = Math.floor((fx + reach + half) / GRASS_CHUNK);
    const c0z = Math.floor((fz - reach + half) / GRASS_CHUNK);
    const c1z = Math.floor((fz + reach + half) / GRASS_CHUNK);
    let ng = 0;
    let nu = 0;
    const gm = this.grass.instanceMatrix.array;
    const gc = this.grass.instanceColor.array;
    const um = this.under.instanceMatrix.array;
    const uc = this.under.instanceColor.array;
    for (let cz = c0z; cz <= c1z; cz++) {
      const z0 = cz * GRASS_CHUNK - half;
      const ddz = Math.max(z0 - fz, 0, fz - z0 - GRASS_CHUNK);
      for (let cx = c0x; cx <= c1x; cx++) {
        const x0 = cx * GRASS_CHUNK - half;
        const ddx = Math.max(x0 - fx, 0, fx - x0 - GRASS_CHUNK);
        if (ddx * ddx + ddz * ddz > reach * reach) continue;
        if (!this.cache.has(cz * 4096 + cx)) {
          if (budget <= 0) {
            this.pending = true;
            continue;
          }
          budget--;
        }
        const ch = this._chunk(cx, cz);
        if (ch.gn && ng + ch.gn <= this.grassCap) {
          gm.set(ch.gm, ng * 16);
          gc.set(ch.gc, ng * 3);
          ng += ch.gn;
        }
        if (ch.un && nu + ch.un <= this.underCap) {
          um.set(ch.um, nu * 16);
          uc.set(ch.uc, nu * 3);
          nu += ch.un;
        }
      }
    }
    for (const [mesh, n] of [[this.grass, ng], [this.under, nu]]) {
      mesh.count = n;
      mesh.visible = n > 0;
      markInstances(mesh, n);
      mesh.boundingSphere.center.set(fx, 0, fz);
      mesh.boundingSphere.radius = this.radius + GRASS_CHUNK * 2;
    }
    // Forget far chunks so a long trek doesn't grow the cache forever.
    if (this.cache.size > 1400) {
      const keep = (reach + GRASS_CHUNK * 4) / GRASS_CHUNK;
      const fcx = (fx + half) / GRASS_CHUNK;
      const fcz = (fz + half) / GRASS_CHUNK;
      for (const [key, ch] of this.cache) {
        if (Math.abs(ch.cx - fcx) > keep || Math.abs(ch.cz - fcz) > keep) this.cache.delete(key);
      }
    }
  }

  _chunk(cx, cz) {
    const key = cz * 4096 + cx;
    let ch = this.cache.get(key);
    if (ch) return ch;
    const veg = this.veg;
    const T = veg.terrain;
    const sea = T.seaLevel;
    const half = T.half;
    const noise = veg._noise;
    const rng = makeRng(hash(veg.seed, "grass", cx, cz));
    const d = veg.density;
    const gmat = [];
    const gcol = [];
    const umat = [];
    const ucol = [];
    const x0 = cx * GRASS_CHUNK - half;
    const z0 = cz * GRASS_CHUNK - half;
    const tries = Math.round(GRASS_CHUNK * GRASS_CHUNK * 0.62 * Math.min(1.4, d));
    const m = new Array(16);
    for (let i = 0; i < tries + UNDER_TRIES; i++) {
      const under = i >= tries;
      const x = x0 + rng() * GRASS_CHUNK;
      const z = z0 + rng() * GRASS_CHUNK;
      if (!T.inBounds(x, z, 2)) continue;
      const h = T.heightAt(x, z);
      if (h < sea + 0.15) continue;
      const biome = T.biomeAt(x, z);
      let p;
      if (under) p = ((UNDER_DENSITY[biome] || 0) * GRASS_CHUNK * GRASS_CHUNK) / UNDER_TRIES;
      else p = (GRASS_DENSITY[biome] || 0) / 0.62;
      if (p <= 0) continue;
      const patch = noise(x * 0.035 + 3.3, z * 0.035 - 8.1);
      p *= under ? 0.4 + 0.9 * smoothstep(-0.5, 0.4, -patch) : 0.2 + 0.8 * smoothstep(-0.5, 0.25, patch);
      if (rng() >= p) continue;
      const slope = T.slopeAt(x, z);
      if (slope > (under ? 0.4 : 0.32)) continue;
      if (veg._solid.any(x, z, 0.15)) continue;
      const yaw = rng() * TAU;
      if (under) {
        const s = rand(rng, 0.85, 1.7);
        writeTRS(m, 0, x, h - 0.04 - slope * 0.5, z, yaw, s, s * rand(rng, 0.85, 1.15));
        umat.push(...m);
        const v = rand(rng, 0.72, 0.98);
        if (rng() < 0.16) ucol.push(1.3 * v, 0.84 * v, 0.52 * v);
        else ucol.push(v * rand(rng, 0.88, 1.02), v, v * rand(rng, 0.8, 0.95));
      } else {
        const tall = biome === "swamp" ? 1.25 : biome === "plains" ? 1.08 : biome === "forest" ? 0.85 : 0.75;
        const s = rand(rng, 0.8, 1.25);
        writeTRS(m, 0, x, h - 0.03 - slope * 0.45, z, yaw, s, s * tall * rand(rng, 0.8, 1.25));
        gmat.push(...m);
        const v = rand(rng, 0.86, 1.08);
        if (biome === "plains") {
          const dry = smoothstep(-0.35, 0.45, noise(x * 0.011 + 40.2, z * 0.011 - 12.7)) * 0.9 + rng() * 0.1;
          gcol.push(lerp(0.9, 1.32, dry) * v, lerp(1.0, 1.1, dry) * v, lerp(0.8, 0.68, dry) * v);
        } else {
          const t = GRASS_TINT[biome] || GRASS_TINT.forest;
          gcol.push(t[0] * v, t[1] * v, t[2] * v);
        }
      }
    }
    ch = {
      cx, cz,
      gm: new Float32Array(gmat), gc: new Float32Array(gcol), gn: gmat.length / 16,
      um: new Float32Array(umat), uc: new Float32Array(ucol), un: umat.length / 16,
    };
    this.cache.set(key, ch);
    return ch;
  }
}

/* --- Placement tables ------------------------------------------------------------------------ */

const TREE_P = { forest: 0.5, swamp: 0.2, plains: 0.035, highland: 0.06, beach: 0.025, rock: 0.012 };
const TREE_R = { araucaria: 0.5, podocarp: 0.4, ginkgo: 0.5, treefern: 0.24, snag: 0.42 };
const TREE_SCALE = { araucaria: [0.62, 1.18], podocarp: [0.6, 1.2], ginkgo: [0.62, 1.2], treefern: [0.65, 1.25], snag: [0.6, 1.2] };
const ROCK_P = { rock: 0.38, highland: 0.22, beach: 0.05, plains: 0.034, forest: 0.045, swamp: 0.022 };
const ROCK_MOSS = { forest: 0.9, swamp: 0.95, plains: 0.45, highland: 0.3, rock: 0.15, beach: 0.05 };
const LOG_P = { forest: 0.17, swamp: 0.2, plains: 0.025, highland: 0.02 };
const PLANT_SCALE = { fern: [0.95, 1.45], cycad: [0.8, 1.2], horsetail: [0.8, 1.2], shrub: [0.75, 1.25] };

function treeWeights(biome, mix, moist, shore) {
  if (shore) return { snag: 0.3, treefern: 0.4, ginkgo: 0.3 };
  switch (biome) {
    case "forest":
      return { araucaria: 0.34 + 0.3 * mix, podocarp: 0.34 - 0.3 * mix, ginkgo: 0.14, treefern: 0.1 + 0.22 * moist };
    case "plains":
      return { ginkgo: 0.42, araucaria: 0.32, podocarp: 0.1, treefern: 0.16 };
    case "swamp":
      return { snag: 0.32, treefern: 0.34, ginkgo: 0.16, podocarp: 0.18 };
    case "highland":
      return { podocarp: 0.62, araucaria: 0.38 };
    case "beach":
      return { araucaria: 0.45, treefern: 0.55 };
    default:
      return { podocarp: 1 };
  }
}

function plantWeights(biome, shore, clearing, lowland) {
  let w;
  switch (biome) {
    case "forest":
      w = { fern: 0.055 + 0.07 * clearing, shrub: 0.026, cycad: 0.012, horsetail: 0 };
      break;
    case "plains":
      w = { fern: 0.025, shrub: 0.035, cycad: 0.016 + (lowland ? 0.035 : 0), horsetail: 0 };
      break;
    case "swamp":
      w = { horsetail: 0.2, fern: 0.05, shrub: 0.012, cycad: 0 };
      break;
    case "beach":
      w = { cycad: 0.13, shrub: 0.01, fern: 0, horsetail: 0 };
      break;
    case "highland":
      w = { shrub: 0.025, fern: 0.012, cycad: 0, horsetail: 0 };
      break;
    default:
      w = { shrub: 0.01, fern: 0, cycad: 0, horsetail: 0 };
  }
  if (shore) w.horsetail += 0.28;
  return w;
}

const nowMs = () => (typeof performance !== "undefined" ? performance.now() : Date.now());

/* --- Vegetation ------------------------------------------------------------------------------ */

const TREE_BUILDERS = {
  araucaria: buildAraucaria,
  podocarp: buildPodocarp,
  ginkgo: buildGinkgo,
  treefern: buildTreeFern,
  snag: buildSnag,
};
const PLANT_BUILDERS = { fern: buildFern, cycad: buildCycad, horsetail: buildHorsetail, shrub: buildShrub };

const _m4 = new THREE.Matrix4();
const _q = new THREE.Quaternion();
const _q2 = new THREE.Quaternion();
const _pos = new V3();
const _scl = new V3();
const _axis = new V3();
const _nrm = new V3();
const UP = new V3(0, 1, 0);
const ZAXIS = new V3(0, 0, 1);
const _pv = new THREE.Matrix4();

export class Vegetation {
  /**
   * Scatter the island's plant life (deterministic for a seed).
   * @param {object} terrain Terrain (heightAt, slopeAt, normalAt, biomeAt, isWater, isFreshWater, inBounds, half, seaLevel)
   * @param {{ seed?: number, density?: number, grass?: boolean, renderer?: THREE.WebGLRenderer }} [opts]
   *   density scales every population (QUALITY.vegetationDensity; < 0.7 also selects the
   *   light LOD/texture profile); grass=false skips grass and undergrowth; renderer
   *   (optional) enables alpha-to-coverage foliage when the canvas has MSAA — without it
   *   this is detected on the first rendered frame.
   */
  constructor(terrain, { seed = 1, density = 1, grass = true, renderer = null } = {}) {
    const t0 = nowMs();
    this.terrain = terrain;
    this.seed = seed >>> 0 || 1;
    this.density = clamp(Number.isFinite(density) ? density : 1, 0, 2);
    this.grassEnabled = !!grass;
    /** THREE.Group of every vegetation InstancedMesh — add it to the scene. */
    this.group = new THREE.Group();
    this.group.name = "vegetation";
    this.group.matrixAutoUpdate = false;
    /** FoodPlant[]: { id, kind, x, y, z, food, maxFood, regrow (kg/s) }. */
    this.plants = [];
    /**
     * Optional Wind (world/wind.js): when set, sway follows its `vector` and
     * `strength`; otherwise a gentle built-in breeze is used.
     */
    this.wind = null;
    this.time = 0;
    this.stats = {};

    const low = this.density < 0.7;
    this._low = low;
    this._half = terrain.half ?? terrain.size / 2;
    this._noise = createNoise2D(hash(this.seed, "veg-noise"));
    this._fx = 0;
    this._fz = 0;
    const wy = makeRng(hash(this.seed, "veg-wind"))() * TAU;
    this._windYaw = wy;
    this._windX = Math.sin(wy);
    this._windZ = Math.cos(wy);
    this._windS = 0.35;
    this._a2cChecked = false;
    this._view = null; // last rendered camera, for far-LOD culling (see _onView)
    this._regrowing = [];
    this._lod = {
      treeNear: low ? 95 : 135,
      treeBand: low ? 18 : 24,
      treeOverlap: 6, // metres both tree LODs overlap during an instance's hand-over
      treeFar: low ? 400 : 600,
      rockNear: low ? 60 : 90,
      rockBand: 14,
      rockFar: low ? 300 : 450,
      plantFar: low ? 125 : 190,
      plantBand: 28,
      logFar: low ? 200 : 280,
      grass: low ? 52 : 74,
      grassBand: low ? 14 : 18,
    };

    const atlasSize = low ? 1024 : 2048;
    this._u = {
      uTime: { value: 0 },
      uWind: { value: new V3(this._windX, this._windZ, this._windS) },
      uFocus: { value: new V3() },
      uAtlasSize: { value: atlasSize },
    };

    let t = nowMs();
    this._atlas = buildAtlas(atlasSize, this.seed);
    this._rockTex = buildRockTexture(low ? 256 : 512, this.seed);
    this.stats.texturesMs = nowMs() - t;

    t = nowMs();
    this._buildMaterials();
    this._buildGeometries();
    this.stats.geometryMs = nowMs() - t;

    t = nowMs();
    this._colliders = new SpatialHash(this._half, HASH_CELL);
    this._solid = new SpatialHash(this._half, HASH_CELL);
    this._plantHash = new SpatialHash(this._half, HASH_CELL);
    this._place();
    this.stats.placementMs = nowMs() - t;

    t = nowMs();
    this._buildMeshes();
    this._grass = null;
    if (this.grassEnabled) {
      this._grass = new GrassField(this, low);
      this.group.add(this._grass.grass, this._grass.under);
    }
    if (renderer) this._detectA2C(renderer);
    this._refocus(0, 0, true);
    this.stats.meshMs = nowMs() - t;
    this.stats.drawCalls = this.group.children.length;
    this.stats.genMs = nowMs() - t0;
  }

  /* --- Per frame ------------------------------------------------------------------------------ */

  /**
   * Advance wind sway, regrow eaten plants, and recentre LOD lists and grass on
   * the focus (usually the player). Cheap when nothing changed.
   * @param {number} dt seconds
   * @param {{ x: number, z: number }} [focus]
   */
  update(dt, focus) {
    dt = Number.isFinite(dt) && dt > 0 ? Math.min(dt, 0.25) : 0;
    this.time += dt;
    if (focus && Number.isFinite(focus.x) && Number.isFinite(focus.z)) {
      this._fx = focus.x;
      this._fz = focus.z;
    }
    this._u.uTime.value = this.time;
    this._updateWind(dt);
    this._refocus(this._fx, this._fz, false);
    const v = this._view;
    if (v && v.dirty) {
      v.dirty = false;
      this._treeLod.view = v;
      this._rockLod.view = v;
      this._treeLod.checkView();
      this._rockLod.checkView();
    }
    if (this._regrowing.length) this._updateRegrowth(dt);
  }

  /**
   * Called while the scene renders (onBeforeRender of one far-tree mesh): note
   * the camera so the next update() can cull the far-LOD lists to it. Lists are
   * never touched mid-render (instance uploads for this frame already happened).
   */
  _onView(scene, camera) {
    if (!camera || !camera.isPerspectiveCamera) return;
    const v =
      this._view ||
      (this._view = { frustum: new THREE.Frustum(), planes: null, px: 0, py: 0, pz: 0, dx: 0, dy: 0, dz: 1, fogFar: Infinity, p0: 0, p5: 0, dirty: false });
    const e = camera.matrixWorld.elements;
    const px = e[12];
    const py = e[13];
    const pz = e[14];
    const len = Math.hypot(e[8], e[9], e[10]) || 1;
    const dx = -e[8] / len;
    const dy = -e[9] / len;
    const dz = -e[10] / len;
    const fog = scene && scene.fog && scene.fog.isFog ? scene.fog.far : Infinity;
    const pm = camera.projectionMatrix.elements;
    const same =
      v.planes &&
      (px - v.px) ** 2 + (py - v.py) ** 2 + (pz - v.pz) ** 2 < 1 &&
      dx * v.dx + dy * v.dy + dz * v.dz > 0.9997 &&
      !(Math.abs(fog - v.fogFar) > 4) &&
      pm[0] === v.p0 &&
      pm[5] === v.p5;
    if (same) return;
    v.frustum.setFromProjectionMatrix(_pv.multiplyMatrices(camera.projectionMatrix, camera.matrixWorldInverse));
    v.planes = v.frustum.planes;
    v.px = px;
    v.py = py;
    v.pz = pz;
    v.dx = dx;
    v.dy = dy;
    v.dz = dz;
    v.fogFar = fog;
    v.p0 = pm[0];
    v.p5 = pm[5];
    v.dirty = true;
  }

  /* --- Queries (gameplay) ----------------------------------------------------------------------- */

  /**
   * Solid obstacles touching a circle: tree trunks, snags, boulders and logs.
   * @returns {{ x: number, z: number, r: number, height: number, kind: string }[]} `out`, refilled
   *   (kind: "tree" | "treefern" | "snag" | "boulder" | "log"; height in metres above the ground)
   */
  collidersNear(x, z, radius, out = []) {
    out.length = 0;
    const h = this._colliders;
    h.range(x, z, radius + h.maxR);
    for (let iz = h.iz0; iz <= h.iz1; iz++) {
      for (let ix = h.ix0; ix <= h.ix1; ix++) {
        const list = h.cells[iz * h.n + ix];
        if (!list) continue;
        for (let i = 0; i < list.length; i++) {
          const c = list[i];
          const dx = c.x - x;
          const dz = c.z - z;
          const rr = radius + c.r;
          if (dx * dx + dz * dz <= rr * rr) out.push(c);
        }
      }
    }
    return out;
  }

  /**
   * Closest food plant within `radius` that still holds at least `minFood` kg.
   * @returns {object|null} FoodPlant
   */
  nearestPlant(x, z, radius, minFood = 1) {
    const h = this._plantHash;
    h.range(x, z, radius);
    let best = null;
    let bestD = radius * radius;
    for (let iz = h.iz0; iz <= h.iz1; iz++) {
      for (let ix = h.ix0; ix <= h.ix1; ix++) {
        const list = h.cells[iz * h.n + ix];
        if (!list) continue;
        for (let i = 0; i < list.length; i++) {
          const p = list[i];
          if (p.food < minFood) continue;
          const dx = p.x - x;
          const dz = p.z - z;
          const d2 = dx * dx + dz * dz;
          if (d2 <= bestD) {
            bestD = d2;
            best = p;
          }
        }
      }
    }
    return best;
  }

  /** Every food plant within `radius` (any amount of food). @returns {object[]} `out`, refilled */
  plantsNear(x, z, radius, out = []) {
    out.length = 0;
    const h = this._plantHash;
    h.range(x, z, radius);
    const r2 = radius * radius;
    for (let iz = h.iz0; iz <= h.iz1; iz++) {
      for (let ix = h.ix0; ix <= h.ix1; ix++) {
        const list = h.cells[iz * h.n + ix];
        if (!list) continue;
        for (let i = 0; i < list.length; i++) {
          const p = list[i];
          const dx = p.x - x;
          const dz = p.z - z;
          if (dx * dx + dz * dz <= r2) out.push(p);
        }
      }
    }
    return out;
  }

  /**
   * Take up to `amount` kg from a plant. It visibly shrinks toward a stub and,
   * after a short pause, regrows at `plant.regrow` kg/s.
   * @returns {number} kg actually removed
   */
  eatPlant(plant, amount) {
    if (!plant || !(amount > 0) || !(plant.food > 0)) return 0;
    const removed = Math.min(amount, plant.food);
    plant.food -= removed;
    const id = plant.id;
    if (this.plants[id] === plant) {
      this._pWait[id] = REGROW_DELAY;
      if (!this._pListed[id]) {
        this._pListed[id] = 1;
        this._regrowing.push(plant);
      }
      const vis = lerp(EATEN_SCALE, 1, plant.food / plant.maxFood);
      if (Math.abs(vis - this._pVis[id]) > 0.004) this._writePlant(plant);
    }
    return removed;
  }

  /**
   * Canopy cover 0..1 around a point (trees within `radius`, weighted by size).
   * Not in the core contract — for hunter visibility / AI hiding spots.
   */
  coverAt(x, z, radius = 9) {
    const list = this.collidersNear(x, z, radius, this._coverScratch || (this._coverScratch = []));
    let sum = 0;
    for (let i = 0; i < list.length; i++) {
      const c = list[i];
      if (c.kind === "tree" || c.kind === "treefern") sum += Math.min(1, c.height / 14);
    }
    return 1 - Math.exp(-sum * 0.45);
  }

  /** Force alpha-to-coverage on/off for foliage (normally auto-detected from the canvas MSAA). */
  setAlphaToCoverage(on) {
    on = !!on;
    this._a2cChecked = true;
    for (const m of [this._mat.near, this._mat.far, this._mat.plant, this._mat.log, this._mat.grass]) {
      if (m.alphaToCoverage !== on) {
        m.alphaToCoverage = on;
        m.needsUpdate = true;
      }
    }
  }

  /** Free GPU resources and detach from the scene. */
  dispose() {
    this.group.removeFromParent();
    const geos = new Set();
    const mats = new Set();
    this.group.traverse((o) => {
      if (!o.isMesh) return;
      geos.add(o.geometry);
      mats.add(o.material);
      if (o.customDepthMaterial) mats.add(o.customDepthMaterial);
      if (o.isInstancedMesh) o.dispose();
    });
    for (const g of geos) g.dispose();
    for (const m of mats) m.dispose();
    this._atlas.dispose();
    this._rockTex.dispose();
    this.group.clear();
  }

  /* --- Internals: frame ---------------------------------------------------------------------- */

  _refocus(fx, fz, force) {
    this._u.uFocus.value.set(fx, 0, fz);
    this._treeLod.update(fx, fz, force);
    this._rockLod.update(fx, fz, force);
    this._plantLod.update(fx, fz, force);
    this._logLod.update(fx, fz, force);
    if (this._grass) this._grass.update(fx, fz, force);
  }

  _updateWind(dt) {
    let dx;
    let dz;
    let s;
    const w = this.wind;
    if (w && w.vector && Number.isFinite(w.vector.x)) {
      dx = w.vector.x;
      dz = w.vector.z;
      s = clamp(Number.isFinite(w.strength) ? w.strength : 0.4, 0, 1);
    } else {
      const t = this.time;
      const yaw = this._windYaw + Math.sin(t * 0.0041) * 0.7 + Math.sin(t * 0.013 + 2) * 0.2;
      dx = Math.sin(yaw);
      dz = Math.cos(yaw);
      s = clamp(0.34 + 0.16 * Math.sin(t * 0.13) + 0.1 * Math.sin(t * 0.41 + 1.3) + 0.06 * Math.sin(t * 1.07 + 0.4), 0.05, 1);
    }
    // Ease toward the target so a veering wind never snaps the whole forest.
    this._windX = damp(this._windX, dx, 0.6, dt);
    this._windZ = damp(this._windZ, dz, 0.6, dt);
    this._windS = damp(this._windS, s, 1.5, dt);
    const len = Math.hypot(this._windX, this._windZ) || 1;
    this._u.uWind.value.set(this._windX / len, this._windZ / len, this._windS);
  }

  _updateRegrowth(dt) {
    const list = this._regrowing;
    for (let i = list.length - 1; i >= 0; i--) {
      const p = list[i];
      const id = p.id;
      if (this._pWait[id] > 0) {
        this._pWait[id] -= dt;
        continue;
      }
      p.food = Math.min(p.maxFood, p.food + p.regrow * dt);
      const full = p.food >= p.maxFood;
      const vis = lerp(EATEN_SCALE, 1, p.food / p.maxFood);
      if (full || Math.abs(vis - this._pVis[id]) > 0.006) this._writePlant(p);
      if (full) {
        list[i] = list[list.length - 1];
        list.pop();
        this._pListed[id] = 0;
      }
    }
  }

  /** Rewrite one food plant's instance matrix from its food level (partial upload). */
  _writePlant(p) {
    const id = p.id;
    const vis = lerp(EATEN_SCALE, 1, clamp(p.food / p.maxFood, 0, 1));
    const s = this._pScale[id] * vis;
    const src = this._plantItems.mat;
    writeTRS(src, id * 16, p.x, this._pY[id], p.z, this._pYaw[id], s, s * this._pSy[id]);
    this._pVis[id] = vis;
    // Listed near the focus right now: patch that one instance too (partial upload).
    const k = this._plantLod.slot[id];
    if (k < 0) return;
    const mesh = this._plantMesh[p.kind];
    mesh.instanceMatrix.array.set(src.subarray(id * 16, id * 16 + 16), k * 16);
    mesh.instanceMatrix.addUpdateRange(k * 16, 16);
    mesh.instanceMatrix.needsUpdate = true;
  }

  _detectA2C(renderer) {
    let on = false;
    try {
      const attrs = renderer.getContext().getContextAttributes();
      on = !!(attrs && attrs.antialias);
    } catch {
      on = false;
    }
    this.setAlphaToCoverage(on);
  }

  /* --- Internals: build ----------------------------------------------------------------------- */

  _buildMaterials() {
    const shared = this._u;
    const L = this._lod;
    const base = {
      map: this._atlas,
      alphaTest: 0.5,
      side: THREE.DoubleSide,
      vertexColors: true,
      roughness: 0.82,
      metalness: 0,
    };
    const mk = (a, b, far, shrink, overlap = 0) => {
      const m = new PlantMaterial(base, { shared, shrink });
      m.vegLod.value.set(a, b, far, overlap);
      return m;
    };
    this._mat = {
      near: mk(L.treeNear - L.treeBand, L.treeNear, 0, false, L.treeOverlap),
      far: mk(L.treeNear - L.treeBand, L.treeNear, 1, false, L.treeOverlap),
      plant: mk(L.plantFar - L.plantBand, L.plantFar, 0, true),
      log: mk(L.logFar - 30, L.logFar, 0, true),
      grass: mk(L.grass - L.grassBand, L.grass, 0, true),
      rockNear: new RockMaterial({ roughness: 0.93, metalness: 0 }, { shared, rockMap: this._rockTex }),
      rockFar: new RockMaterial({ roughness: 0.93, metalness: 0 }, { shared, rockMap: this._rockTex }),
    };
    this._mat.rockNear.vegLod.value.set(L.rockNear - L.rockBand, L.rockNear, 0, 0);
    this._mat.rockFar.vegLod.value.set(L.rockNear - L.rockBand, L.rockNear, 1, 0);
    for (const k of ["near", "far", "plant", "log", "grass"]) this._mat[k].name = `veg-${k}`;
    this._depth = {
      near: new PlantDepthMaterial(null, { shared, lod: this._mat.near.vegLod }),
      plant: new PlantDepthMaterial(null, { shared, lod: this._mat.plant.vegLod, shrink: true }),
      log: new PlantDepthMaterial(null, { shared, lod: this._mat.log.vegLod, shrink: true }),
    };
  }

  _buildGeometries() {
    const geo = { near: {}, far: {}, plant: {} };
    for (const kind of TREE_KINDS) {
      const s = hash(this.seed, "tree-geo", kind);
      geo.near[kind] = TREE_BUILDERS[kind](makeRng(s), true);
      geo.far[kind] = TREE_BUILDERS[kind](makeRng(s), false);
    }
    for (const kind of PLANT_KINDS) geo.plant[kind] = PLANT_BUILDERS[kind](makeRng(hash(this.seed, "plant-geo", kind)));
    geo.log = buildLog(makeRng(hash(this.seed, "log-geo")));
    geo.rockNear = buildRockGeometry(this._low ? 2 : 3, this.seed);
    geo.rockFar = buildRockGeometry(1, this.seed);
    this._geo = geo;
    let verts = 0;
    for (const kind of TREE_KINDS) verts += geo.near[kind].attributes.position.count;
    this.stats.treeVertsNear = verts;
  }

  _place() {
    const T = this.terrain;
    const half = this._half;
    const sea = T.seaLevel ?? 0;
    const d = this.density;
    const nz = this._noise;
    const hasMoist = typeof T.moistureAt === "function";
    const hasFresh = typeof T.isFreshWater === "function";
    const freshNear = (x, z) => {
      if (!hasFresh) return false;
      for (let i = 0; i < 6; i++) {
        const a = (i / 6) * TAU;
        if (T.isFreshWater(x + Math.cos(a) * 7, z + Math.sin(a) * 7)) return true;
      }
      return false;
    };
    const clearingAt = (x, z) => fbm2D(nz, x * 0.0065 + 11.3, z * 0.0065 - 7.1, 3);
    const groveAt = (x, z) => fbm2D(nz, x * 0.013 - 41.7, z * 0.013 + 19.9, 3);

    /* Rocks first (trees and plants keep clear of them). */
    const rocks = { type: [], mat: [], col: [], extra: [] };
    let rng = makeRng(hash(this.seed, "veg-rocks"));
    const RC = 15;
    for (let gz = -half + RC / 2; gz < half; gz += RC) {
      for (let gx = -half + RC / 2; gx < half; gx += RC) {
        const x = gx + (rng() - 0.5) * 0.9 * RC;
        const z = gz + (rng() - 0.5) * 0.9 * RC;
        const roll = rng();
        if (!T.inBounds(x, z, 8)) continue;
        const h = T.heightAt(x, z);
        if (h < sea + 0.4) continue;
        const biome = T.biomeAt(x, z);
        const slope = T.slopeAt(x, z);
        const p = (ROCK_P[biome] || 0) + (slope > 0.4 ? 0.12 : 0);
        if (roll >= p * d) continue;
        const cluster = rng() < 0.32 ? 1 + Math.floor(rng() * 3) : 0;
        const big = biome === "highland" || biome === "rock";
        const base = big ? rand(rng, 1.0, 3.0) * (rng() < 0.1 ? 1.6 : 1) : rand(rng, 0.5, 1.5) * (rng() < 0.06 ? 2.3 : 1);
        for (let c = 0; c <= cluster; c++) {
          const cx = c ? x + rand(rng, -1, 1) * base * 2.2 : x;
          const cz = c ? z + rand(rng, -1, 1) * base * 2.2 : z;
          this._addRock(rocks, rng, cx, cz, c ? base * rand(rng, 0.3, 0.6) : base, biome);
        }
      }
    }

    /* Fallen logs. */
    const logs = { mat: [], col: [] };
    rng = makeRng(hash(this.seed, "veg-logs"));
    const LC = 24;
    for (let gz = -half + LC / 2; gz < half; gz += LC) {
      for (let gx = -half + LC / 2; gx < half; gx += LC) {
        const x = gx + (rng() - 0.5) * 0.9 * LC;
        const z = gz + (rng() - 0.5) * 0.9 * LC;
        const roll = rng();
        if (!T.inBounds(x, z, 10)) continue;
        const h = T.heightAt(x, z);
        if (h < sea + 0.3) continue;
        const biome = T.biomeAt(x, z);
        if (roll >= (LOG_P[biome] || 0) * d) continue;
        if (T.slopeAt(x, z) > 0.3) continue;
        const s = rand(rng, 0.7, 1.25);
        const yaw = rng() * TAU;
        const dx = Math.cos(yaw);
        const dz = -Math.sin(yaw);
        const L = 7 * s;
        const h1 = T.heightAt(x - dx * L * 0.45, z - dz * L * 0.45);
        const h2 = T.heightAt(x + dx * L * 0.45, z + dz * L * 0.45);
        if (Math.min(h1, h2) < sea + 0.2 || Math.abs(h2 - h1) > L * 0.35) continue;
        if (this._colliders.any(x, z, L * 0.5)) continue;
        _q.setFromAxisAngle(UP, yaw);
        _q2.setFromAxisAngle(ZAXIS, Math.atan2(h2 - h1, L * 0.9));
        _q.multiply(_q2);
        _pos.set(x, (h1 + h2) / 2 + 0.17 * s, z);
        _scl.set(s, s, s);
        _m4.compose(_pos, _q, _scl);
        logs.mat.push(..._m4.elements);
        logs.col.push(1, 1, 1);
        for (const k of [-0.33, 0, 0.33]) {
          const c = { x: x + dx * L * k, z: z + dz * L * k, r: 0.42 * s, height: 0.8 * s, kind: "log" };
          this._colliders.insert(c);
          this._solid.insert(c);
        }
      }
    }

    /* Trees. */
    const trees = { type: [], mat: [], col: [], extra: null };
    rng = makeRng(hash(this.seed, "veg-trees"));
    const TC = 5.4;
    for (let gz = -half + TC / 2; gz < half; gz += TC) {
      for (let gx = -half + TC / 2; gx < half; gx += TC) {
        const x = gx + (rng() - 0.5) * 0.9 * TC;
        const z = gz + (rng() - 0.5) * 0.9 * TC;
        const roll = rng();
        if (!T.inBounds(x, z, 4)) continue;
        const h = T.heightAt(x, z);
        if (h < sea + 0.25) continue;
        const slope = T.slopeAt(x, z);
        if (slope > 0.6) continue;
        const biome = T.biomeAt(x, z);
        let p = TREE_P[biome] || 0;
        const shore = h < sea + 2.2 && biome !== "beach" && freshNear(x, z);
        if (biome === "forest") p *= smoothstep(-0.42, -0.1, clearingAt(x, z)) * (1 - smoothstep(0.35, 0.6, slope));
        else if (biome === "plains") p *= 0.2 + 2.4 * smoothstep(0.05, 0.45, groveAt(x, z));
        if (shore) p = Math.max(p, 0.14);
        if (roll >= p * d) continue;
        const mix = nz(x * 0.018 + 5.1, z * 0.018 + 9.4);
        const moist = hasMoist ? clamp(T.moistureAt(x, z), 0, 1) : 0.5;
        const kind = weightedPick(rng, treeWeights(biome, mix, moist, shore));
        let s = rand(rng, TREE_SCALE[kind][0], TREE_SCALE[kind][1]);
        if (kind !== "treefern" && kind !== "snag" && (biome === "forest" || biome === "plains") && rng() < 0.1) {
          s *= rand(rng, 0.32, 0.5); // sapling
        }
        if (biome === "highland") s *= 0.85;
        const spacing = kind === "treefern" ? 1.4 : 2.2 * Math.max(0.6, s);
        if (this._colliders.any(x, z, spacing)) continue;
        const sy = s * rand(rng, 0.92, 1.1);
        const yaw = rng() * TAU;
        const tilt = kind === "snag" ? rand(rng, 0, 0.1) : kind === "treefern" ? rand(rng, 0, 0.09) : rand(rng, 0, 0.025);
        const ta = rng() * TAU;
        _q.setFromAxisAngle(_axis.set(Math.cos(ta), 0, Math.sin(ta)), tilt);
        _q2.setFromAxisAngle(UP, yaw);
        _q.multiply(_q2);
        _pos.set(x, h - 0.12 - slope * 1.2, z);
        _scl.set(s, sy, s);
        _m4.compose(_pos, _q, _scl);
        trees.mat.push(..._m4.elements);
        trees.type.push(TREE_KINDS.indexOf(kind));
        trees.col.push(...this._treeTint(kind, biome, rng));
        this._colliders.insert({
          x, z, r: TREE_R[kind] * s, height: TREE_H[kind] * sy,
          kind: kind === "snag" ? "snag" : kind === "treefern" ? "treefern" : "tree",
        });
      }
    }

    /* Food plants. */
    this._pData = [];
    rng = makeRng(hash(this.seed, "veg-plants"));
    const PC = 6.2;
    for (let gz = -half + PC / 2; gz < half; gz += PC) {
      for (let gx = -half + PC / 2; gx < half; gx += PC) {
        const x = gx + (rng() - 0.5) * 0.9 * PC;
        const z = gz + (rng() - 0.5) * 0.9 * PC;
        const roll = rng();
        if (!T.inBounds(x, z, 4)) continue;
        const h = T.heightAt(x, z);
        if (h < sea + 0.15) continue;
        if (T.slopeAt(x, z) > 0.5) continue;
        const biome = T.biomeAt(x, z);
        const shore = h < sea + 1.8 && freshNear(x, z);
        const clearing = biome === "forest" ? 1 - smoothstep(-0.42, -0.1, clearingAt(x, z)) : 0;
        const w = plantWeights(biome, shore, clearing, h < sea + 3.5);
        let total = 0;
        for (const k in w) total += w[k];
        if (roll >= total * d) continue;
        const kind = weightedPick(rng, w);
        this._tryPlant(kind, x, z, rng, biome);
        if ((kind === "fern" || kind === "horsetail") && rng() < 0.4) {
          const extra = 1 + (rng() < 0.4 ? 1 : 0);
          for (let e = 0; e < extra; e++) this._tryPlant(kind, x + rand(rng, -2.6, 2.6), z + rand(rng, -2.6, 2.6), rng, biome);
        }
      }
    }

    const typed = (o) => ({
      count: o.type.length,
      type: Uint8Array.from(o.type),
      mat: Float32Array.from(o.mat),
      col: Float32Array.from(o.col),
      extra: o.extra ? Float32Array.from(o.extra) : null,
    });
    this._treeItems = typed(trees);
    this._rockItems = typed(rocks);
    this._logItems = { count: logs.mat.length / 16, mat: Float32Array.from(logs.mat), col: Float32Array.from(logs.col) };
    const byKind = [0, 0, 0, 0, 0];
    for (const t of trees.type) byKind[t]++;
    this.stats.trees = trees.type.length;
    this.stats.treesByKind = Object.fromEntries(TREE_KINDS.map((k, i) => [k, byKind[i]]));
    this.stats.rocks = rocks.type.length;
    this.stats.logs = this._logItems.count;
    this.stats.plants = this.plants.length;
    const pk = {};
    for (const p of this.plants) pk[p.kind] = (pk[p.kind] || 0) + 1;
    this.stats.plantsByKind = pk;
  }

  _addRock(rocks, rng, x, z, size, biome) {
    const T = this.terrain;
    if (!T.inBounds(x, z, 6)) return;
    const h = T.heightAt(x, z);
    if (h < (T.seaLevel ?? 0) + 0.2) return;
    const slope = T.slopeAt(x, z);
    if (slope > 0.75) return;
    if (this._solid.any(x, z, size * 0.6)) return;
    const sx = size * rand(rng, 0.85, 1.25);
    const sy = size * rand(rng, 0.5, 0.95);
    const sz = size * rand(rng, 0.8, 1.2);
    if (typeof T.normalAt === "function") T.normalAt(x, z, _nrm);
    else _nrm.set(0, 1, 0);
    _nrm.lerp(UP, 0.4).normalize();
    _q.setFromUnitVectors(UP, _nrm);
    _q2.setFromAxisAngle(UP, rng() * TAU);
    _q.multiply(_q2);
    _pos.set(x, h - sy * 0.22 - slope * size * 0.35, z);
    _scl.set(sx, sy, sz);
    _m4.compose(_pos, _q, _scl);
    rocks.mat.push(..._m4.elements);
    let v = rand(rng, 0.95, 1.25);
    if (biome === "beach") v *= 1.12;
    else if (biome === "forest" || biome === "swamp") v *= 0.9;
    const warm = rand(rng, -0.04, 0.06);
    rocks.col.push(v * (1 + warm), v, v * (1 - warm * 1.5));
    rocks.extra.push((ROCK_MOSS[biome] ?? 0.3) * rand(rng, 0.6, 1.1));
    rocks.type.push(0);
    if (size > 0.35) {
      const c = { x, z, r: Math.max(sx, sz) * 0.88, height: sy * 1.05, kind: "boulder" };
      this._colliders.insert(c);
      this._solid.insert(c);
    }
  }

  _tryPlant(kind, x, z, rng, biome) {
    const T = this.terrain;
    if (!T.inBounds(x, z, 4)) return;
    const h = T.heightAt(x, z);
    if (h < (T.seaLevel ?? 0) + 0.12) return;
    const slope = T.slopeAt(x, z);
    if (slope > 0.55) return;
    if (this._colliders.any(x, z, 0.7)) return;
    if (this._plantHash.any(x, z, kind === "cycad" ? 2.0 : 1.2)) return;
    const [lo, hi] = PLANT_SCALE[kind];
    const s = rand(rng, lo, hi);
    const def = PLANT_DEFS[kind];
    const plant = {
      id: this.plants.length, kind, x, y: h, z,
      food: def.maxFood, maxFood: def.maxFood, regrow: def.maxFood * def.regrow,
    };
    this.plants.push(plant);
    this._plantHash.insert(plant);
    let tint;
    const v = rand(rng, 0.86, 1.08);
    if (kind === "fern" && rng() < 0.18) tint = [1.38 * v, 0.8 * v, 0.48 * v]; // rust fern
    else if (biome === "plains" || biome === "beach") tint = [1.1 * v, 1.04 * v, 0.74 * v];
    else tint = [v * rand(rng, 0.9, 1.04), v, v * rand(rng, 0.82, 0.96)];
    this._pData.push({ yaw: rng() * TAU, s, sy: rand(rng, 0.9, 1.1), y: h - 0.04 - slope * 0.5, tint });
  }

  _treeTint(kind, biome, rng) {
    const w = rng();
    let c;
    if (kind === "araucaria" || kind === "podocarp") {
      const v = rand(rng, 0.8, 1.06) * (biome === "highland" ? 0.9 : 1);
      c = [lerp(0.9, 1.08, w) * v, v, lerp(0.98, 0.82, w) * v];
    } else if (kind === "ginkgo") {
      const y = w * w;
      const v = rand(rng, 0.88, 1.05);
      c = [lerp(0.92, 1.3, y) * v, lerp(1.0, 1.06, y) * v, lerp(0.85, 0.6, y) * v];
    } else if (kind === "treefern") {
      const v = rand(rng, 0.9, 1.08);
      c = [v * lerp(0.95, 1.08, w), v, v * 0.9];
    } else {
      c = [1, 1, 1];
    }
    return c;
  }

  _buildMeshes() {
    const L = this._lod;
    const half = this._half;
    const g = this._geo;

    /* Trees: near + far InstancedMesh per kind, refilled by the LOD set. */
    const byKind = [0, 0, 0, 0, 0];
    for (let i = 0; i < this._treeItems.count; i++) byKind[this._treeItems.type[i]]++;
    const nearMeshes = [];
    const farMeshes = [];
    TREE_KINDS.forEach((kind, t) => {
      const n = byKind[t];
      const near = makeInstanced(g.near[kind], this._mat.near, n, { dynamic: true, cast: true, receive: true, depth: this._depth.near });
      const far = makeInstanced(g.far[kind], this._mat.far, n, { dynamic: true, cast: false, receive: false });
      near.name = `veg-${kind}-near`;
      far.name = `veg-${kind}-far`;
      near.onBeforeRender = (renderer) => {
        if (!this._a2cChecked) this._detectA2C(renderer);
      };
      nearMeshes.push(near);
      farMeshes.push(far);
      this.group.add(near, far);
    });
    this._treeLod = new LodSet(half, this._treeItems, nearMeshes, farMeshes, { nearR: L.treeNear, band: L.treeBand, farR: L.treeFar });
    const anchor = farMeshes[0];
    anchor.userData.vegViewAnchor = true;
    anchor.onBeforeRender = (renderer, scene, camera) => this._onView(scene, camera);

    /* Rocks. */
    const rc = this._rockItems.count;
    g.rockNear.setAttribute("aMoss", new THREE.InstancedBufferAttribute(new Float32Array(Math.max(1, rc)), 1));
    g.rockFar.setAttribute("aMoss", new THREE.InstancedBufferAttribute(new Float32Array(Math.max(1, rc)), 1));
    const rockNear = makeInstanced(g.rockNear, this._mat.rockNear, rc, { dynamic: true, cast: true, receive: true });
    const rockFar = makeInstanced(g.rockFar, this._mat.rockFar, rc, { dynamic: true, cast: false, receive: false });
    rockNear.name = "veg-rocks-near";
    rockFar.name = "veg-rocks-far";
    this.group.add(rockNear, rockFar);
    this._rockLod = new LodSet(half, this._rockItems, [rockNear], [rockFar], { nearR: L.rockNear, band: L.rockBand, farR: L.rockFar });

    /* Logs (one LOD, shrunk away at range): only the ones near the focus are listed. */
    const li = this._logItems;
    li.type = new Uint8Array(li.count);
    li.extra = null;
    const logs = makeInstanced(g.log, this._mat.log, li.count, { dynamic: true, cast: true, receive: true, depth: this._depth.log });
    logs.name = "veg-logs";
    this.group.add(logs);
    this._logLod = new LodSet(half, li, [logs], [], { nearR: L.logFar, band: 0, farR: 0 });

    /* Food plants: like logs, listed per chunk near the focus (the whole island's
       worth would cost hundreds of thousands of triangles, mostly shrunk to
       nothing by the shader). Each plant's matrix lives in `_plantItems.mat` by
       plant id; eating rewrites it there and in its listed slot, if any. */
    const n = this.plants.length;
    const pItems = { count: n, type: new Uint8Array(n), mat: new Float32Array(n * 16), col: new Float32Array(n * 3).fill(1), extra: null };
    this._plantItems = pItems;
    this._pYaw = new Float32Array(n);
    this._pScale = new Float32Array(n);
    this._pSy = new Float32Array(n);
    this._pY = new Float32Array(n);
    this._pVis = new Float32Array(n).fill(1);
    this._pWait = new Float32Array(n);
    this._pListed = new Uint8Array(n);
    this._plantMesh = {};
    const byPlantKind = PLANT_KINDS.map(() => 0);
    for (const p of this.plants) {
      const t = PLANT_KINDS.indexOf(p.kind);
      const d = this._pData[p.id];
      byPlantKind[t]++;
      pItems.type[p.id] = t;
      this._pYaw[p.id] = d.yaw;
      this._pScale[p.id] = d.s;
      this._pSy[p.id] = d.sy;
      this._pY[p.id] = d.y;
      writeTRS(pItems.mat, p.id * 16, p.x, d.y, p.z, d.yaw, d.s, d.s * d.sy);
      pItems.col.set(d.tint, p.id * 3);
    }
    const plantMeshes = PLANT_KINDS.map((kind, t) => {
      const mesh = makeInstanced(g.plant[kind], this._mat.plant, byPlantKind[t], { dynamic: true, cast: true, receive: true, depth: this._depth.plant });
      mesh.name = `veg-${kind}`;
      this._plantMesh[kind] = mesh;
      this.group.add(mesh);
      return mesh;
    });
    this._plantLod = new LodSet(half, pItems, plantMeshes, [], { nearR: L.plantFar, band: 0, farR: 0, slots: true });
    this._pData = null;
  }
}
