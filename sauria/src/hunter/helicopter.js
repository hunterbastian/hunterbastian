// Helicopter — the expedition's utility chopper in Hunter mode. It drops the
// hunter at the landing zone, leaves, and comes back for the extraction.
//
// Model: a Huey-class utility helicopter built procedurally at load from
// smooth lofted surfaces — fuselage + tail boom (superellipse cross-sections
// blended with a monotone spline), engine doghouse, airfoil-section fin,
// stabilisers and rotor blades — with a canvas-painted livery (bone over moss,
// ochre stripe, panel lines, rivets, soot) that also drives a bump/roughness
// map. Both cargo doors are slid open and the cabin is furnished (troop bench,
// pilot seats, two pilots, instrument panel), so the hunter can ride the door.
//
// Motion: a point-mass "pilot" flies a short route — offshore entry, a dog-leg
// so the run-in ends in a banked turn, a braking approach and a low hover —
// with terrain + tree look-ahead and a hard whole-airframe floor. The attitude
// is derived from the rotor thrust vector (acceleration + drag + gravity), so
// it banks into turns, dips its nose to accelerate and flares to stop for free.
// At speed the rotors blur into a shader disc; when low, pooled rotor-wash
// particles (dust / grass / spray) and a water ripple ring; nav + strobe
// lights, a warm cabin glow and a landing spotlight (one SpotLight) at night.

import * as THREE from "three";
import { makeRng, rand } from "../core/rng.js";
import { TAU, HALF_PI, clamp, lerp, smoothstep, damp, angleDiff, wrapAngle } from "../core/math.js";

/* --- Airframe (metres) ------------------------------------------------------ */
// Model space: +Z forward (nose), +Y up, +X = the helicopter's LEFT (port) side.
// The origin sits on the ground plane under the mast: skid bottoms at y = 0.

const Z_NOSE = 4.35;
const NOSE_CAP = 0.75; // elliptical nose cap length
const TAIL_CAP = 0.25;
const MAST_Y = 3.78; // rotor hub height
const ROTOR_R = 7.3;
const TAIL_HUB = new THREE.Vector3(0.38, 3.02, -9.3);
const TAIL_R = 1.3;
const FLOOR_Y = 0.9;
// Cargo door openings (both sides): z range and cross-section angle range
// (θ = 0 on the roof centre line, π/2 on the left flank, π under the belly).
const DOOR_Z0 = -1.2;
const DOOR_Z1 = 0.95;
const DOOR_T0 = 0.95;
const DOOR_T1 = 2.29;
const DOOR_SLIDE = DOOR_Z1 - DOOR_Z0 - 0.05; // doors are slid fully back
const DOOR_WIN = { z0: -0.75, z1: 0.55, t0: 1.05, t1: 1.5 };
// Livery: bone above, moss below this cross-section angle (swoops up at the nose).
const SPLIT = 1.75;

// Fuselage cross-sections, nose → tail: [z, centreY, halfWidth, top, bottom, squareness].
// The first key sits NOSE_CAP behind the tip, the last TAIL_CAP before the end.
const FUSE_KEYS = [
  [3.6, 1.42, 0.86, 0.8, 0.6, 2.5],
  [3.2, 1.52, 1.06, 0.86, 0.68, 2.8],
  [2.6, 1.6, 1.18, 0.83, 0.78, 3.3],
  [2.0, 1.62, 1.22, 0.8, 0.82, 3.6],
  [-3.2, 1.62, 1.22, 0.8, 0.82, 3.6],
  [-3.75, 1.72, 1.08, 0.7, 0.72, 3.4],
  [-4.35, 1.87, 0.76, 0.54, 0.54, 3.0],
  [-5.05, 1.96, 0.5, 0.43, 0.42, 2.5],
  [-6.3, 2.02, 0.41, 0.37, 0.35, 2.3],
  [-8.5, 2.1, 0.29, 0.29, 0.27, 2.2],
  [-9.35, 2.13, 0.25, 0.26, 0.24, 2.2],
];
// Engine/transmission "doghouse" on the cabin roof.
// Low and broad so it reads as part of the airframe, not a tank on the roof.
const DOG_KEYS = [
  [0.7, 2.46, 0.62, 0.34, 0.3, 2.8],
  [0.15, 2.5, 0.8, 0.45, 0.32, 3.2],
  [-2.8, 2.5, 0.8, 0.45, 0.32, 3.2],
  [-3.4, 2.46, 0.6, 0.34, 0.3, 2.8],
];
const DOG_FRONT = 1.25;

// Glazing as rectangles in (z, θ) loft space, mirrored to both sides.
const WINDOWS = [
  { z0: 2.45, z1: 3.75, t0: 0.04, t1: 1.45 }, // wrap-around windscreen (two panes, centre post)
  { z0: 1.75, z1: 2.4, t0: 0.04, t1: 0.55 }, // green-tinted roof windows
  { z0: 1.4, z1: 2.3, t0: 0.95, t1: 1.63 }, // pilot door windows
  { z0: 2.75, z1: 3.85, t0: 2.29, t1: 2.85 }, // chin windows
];

// Texture layout: the fuselage band (u = along the length, v = around the
// section) fills the top 80 %; the bottom strip holds the fin and stabilisers.
const TEX_W = 1024;
const TEX_H = 640;
const BAND_V = 0.8;

/* --- Flight tuning ---------------------------------------------------------- */

const G = 9.81;
const CRUISE_SPEED = 36; // m/s
const CRUISE_AGL = 60; // transit height above ground / sea
const MIN_TRANSIT_AGL = 22; // look-ahead clearance away from the landing point
const OBSTACLE_AGL = 34; // clearance over trees (canopy height is unknown, be safe)
const OBSTACLE_R = 10.5; // rotor radius + a canopy
const TURN_ACCEL = 4.2; // m/s² across the flight path (≈ 23° bank in a turn)
const LONG_ACCEL = 2.6; // m/s² along it (≈ 15° nose down / flare)
const BRAKE = 1.8; // m/s² planned deceleration, below LONG_ACCEL so the plan is always flyable
const DRAG = 0.042; // 1/s — forward-flight nose-down attitude
const CLIMB_RATE = 8;
const DESCENT_RATE = 4.5;
const VERT_ACCEL = 3.5;
const YAW_RATE = 0.65; // rad/s
const MAX_TILT = 0.55; // rad
const HOVER_AGL = 2.6; // skids this far above the ground in a low hover
const DEPART_AGL = 16;
const APPROACH_RANGE = 420; // final-leg distance at which we report "approach"
const LOOK_STEPS = 6;
const ROTOR_OMEGA = 34; // rad/s (≈ 324 rpm)
const TAIL_OMEGA = 57; // visual rate — the real ~170 rad/s strobes into a wagon wheel
const DROP_HOLD = 1.8; // s settled before the hunter steps out
const DROP_LEAVE = 3.8; // s settled before lifting away
const EXIT_PAST_COAST = 420; // m beyond the coastline before the chopper vanishes

// Airframe floor: [localX, localZ, part height above origin, clearance]. The
// rotor tips are sampled on a ring so a slope or a hill can never touch them.
const FOOTPRINT = [
  [1.25, 3.0, 0, 0.5],
  [-1.25, 3.0, 0, 0.5],
  [1.25, -2.15, 0, 0.5],
  [-1.25, -2.15, 0, 0.5],
  [0, Z_NOSE, 0.85, 0.5],
  [TAIL_HUB.x, TAIL_HUB.z, TAIL_HUB.y - TAIL_R, 0.6],
  [0, -9.1, 1.35, 0.5],
];
for (let i = 0; i < 8; i++) {
  const a = (i / 8) * TAU;
  FOOTPRINT.push([Math.sin(a) * ROTOR_R, Math.cos(a) * ROTOR_R, MAST_Y - 0.15, 0.9]);
}

/* --- Palette (sRGB) ---------------------------------------------------------- */

const C = {
  bone: "#cfc8b2",
  moss: "#3d4a36",
  ochre: "#c08a33",
  rust: "#8e3b26",
  ink: "#23251f",
  rubber: "#202221",
  interior: "#585f4e",
};

/* --- Scratch (no per-frame allocation) ------------------------------------- */

const _v1 = new THREE.Vector3();
const _v2 = new THREE.Vector3();
const _v3 = new THREE.Vector3();
const _xAxis = new THREE.Vector3();
const _zAxis = new THREE.Vector3();
const _thrust = new THREE.Vector3();
const _m4 = new THREE.Matrix4();
const _q = new THREE.Quaternion();
const _e = new THREE.Euler();
const _size = new THREE.Vector2();
const _col = new THREE.Color();

/* --- Small geometry toolkit -------------------------------------------------- */

/** Monotone cubic (Fritsch–Carlson) interpolant — flat runs stay flat, no overshoot. */
function pchip(xs, ys) {
  const n = xs.length;
  const h = [];
  const d = [];
  const m = new Array(n);
  for (let i = 0; i < n - 1; i++) {
    h[i] = xs[i + 1] - xs[i];
    d[i] = (ys[i + 1] - ys[i]) / h[i];
  }
  m[0] = d[0];
  m[n - 1] = d[n - 2];
  for (let i = 1; i < n - 1; i++) {
    if (d[i - 1] * d[i] <= 0) m[i] = 0;
    else {
      const w1 = 2 * h[i] + h[i - 1];
      const w2 = h[i] + 2 * h[i - 1];
      m[i] = (w1 + w2) / (w1 / d[i - 1] + w2 / d[i]);
    }
  }
  return (x) => {
    if (x <= xs[0]) return ys[0];
    if (x >= xs[n - 1]) return ys[n - 1];
    let i = 0;
    while (x > xs[i + 1]) i++;
    const t = (x - xs[i]) / h[i];
    const t2 = t * t;
    const t3 = t2 * t;
    return (2 * t3 - 3 * t2 + 1) * ys[i] + (t3 - 2 * t2 + t) * h[i] * m[i] +
      (-2 * t3 + 3 * t2) * ys[i + 1] + (t3 - t2) * h[i] * m[i + 1];
  };
}

/**
 * Cross-section function for a lofted body: elliptical caps at both ends, a
 * monotone spline between the keys. s = distance back from the front tip.
 */
function makeLoft(keys, zFront, capF, capB, tipDrop = 0) {
  const ss = keys.map((k) => zFront - k[0]);
  const f = [1, 2, 3, 4, 5].map((c) => pchip(ss, keys.map((k) => k[c])));
  const first = keys[0];
  const last = keys[keys.length - 1];
  const sFirst = ss[0];
  const sLast = ss[ss.length - 1];
  return {
    zFront,
    sFirst,
    sLast,
    capB,
    len: sLast + capB,
    at(s, out) {
      if (s < sFirst) {
        const t = clamp(s / sFirst, 0, 1);
        const k = Math.sqrt(1 - (1 - t) * (1 - t));
        out.yc = first[1] + (1 - k) * tipDrop;
        out.w = first[2] * k;
        out.ht = first[3] * k;
        out.hb = first[4] * k;
        out.n = lerp(2, first[5], k);
      } else if (s > sLast) {
        const t = clamp((s - sLast) / capB, 0, 1);
        const k = Math.sqrt(1 - t * t);
        out.yc = last[1];
        out.w = last[2] * k;
        out.ht = last[3] * k;
        out.hb = last[4] * k;
        out.n = lerp(2, last[5], k);
      } else {
        out.yc = f[0](s);
        out.w = f[1](s);
        out.ht = f[2](s);
        out.hb = f[3](s);
        out.n = f[4](s);
      }
      return out;
    },
  };
}

/** Point on a superellipse section; `off` pushes it outward (door skins, trims). */
function sectionPoint(sec, theta, off, out) {
  const st = Math.sin(theta);
  const ct = Math.cos(theta);
  const e = 2 / sec.n;
  const sx = Math.sign(st) * Math.pow(Math.abs(st), e);
  const sy = Math.sign(ct) * Math.pow(Math.abs(ct), e);
  out.x = (sec.w + off) * sx;
  out.y = sec.yc + (sy >= 0 ? sec.ht + off : sec.hb + off) * sy;
  return out;
}

/** Ring stations along a loft: cosine-clustered caps, `step(s)` spacing, forced boundaries. */
function loftStations(loft, step, capRings, extraZ = []) {
  const list = [];
  for (let i = 0; i < capRings; i++) list.push(loft.sFirst * (1 - Math.cos((i / capRings) * HALF_PI)));
  for (let s = loft.sFirst; s < loft.sLast - 1e-3; s += step(s)) list.push(s);
  list.push(loft.sLast);
  for (let i = 1; i <= Math.max(2, capRings >> 1); i++) {
    list.push(loft.sLast + loft.capB * Math.sin((i / Math.max(2, capRings >> 1)) * HALF_PI));
  }
  return withBoundaries(list, extraZ.map((z) => loft.zFront - z), 0.04);
}

/** Merge forced boundary values into a sorted list, dropping near-duplicates. */
function withBoundaries(list, bounds, gap) {
  let out = list.filter((v) => !bounds.some((b) => Math.abs(v - b) < gap));
  out = out.concat(bounds);
  out.sort((a, b) => a - b);
  return out;
}

/** Average normals of coincident vertices (seams, collapsed tips) for one smooth skin. */
function weldNormals(geo) {
  const p = geo.attributes.position;
  const n = geo.attributes.normal;
  const map = new Map();
  const key = (i) => `${Math.round(p.getX(i) * 2000)},${Math.round(p.getY(i) * 2000)},${Math.round(p.getZ(i) * 2000)}`;
  for (let i = 0; i < p.count; i++) {
    const k = key(i);
    let acc = map.get(k);
    if (!acc) map.set(k, (acc = [0, 0, 0]));
    acc[0] += n.getX(i);
    acc[1] += n.getY(i);
    acc[2] += n.getZ(i);
  }
  for (let i = 0; i < p.count; i++) {
    const a = map.get(key(i));
    const l = Math.hypot(a[0], a[1], a[2]) || 1;
    n.setXYZ(i, a[0] / l, a[1] / l, a[2] / l);
  }
  return geo;
}

/** Flip winding if the normals point inward (checked against the vertex centroid). */
function orientOutward(geo) {
  const p = geo.attributes.position;
  const n = geo.attributes.normal;
  let cx = 0;
  let cy = 0;
  let cz = 0;
  for (let i = 0; i < p.count; i++) {
    cx += p.getX(i);
    cy += p.getY(i);
    cz += p.getZ(i);
  }
  cx /= p.count;
  cy /= p.count;
  cz /= p.count;
  let s = 0;
  for (let i = 0; i < p.count; i++) {
    s += (p.getX(i) - cx) * n.getX(i) + (p.getY(i) - cy) * n.getY(i) + (p.getZ(i) - cz) * n.getZ(i);
  }
  if (s < 0) {
    const idx = geo.index.array;
    for (let i = 0; i < idx.length; i += 3) {
      const t = idx[i + 1];
      idx[i + 1] = idx[i + 2];
      idx[i + 2] = t;
    }
    for (let i = 0; i < n.count; i++) n.setXYZ(i, -n.getX(i), -n.getY(i), -n.getZ(i));
  }
  return geo;
}

/** Indexed geometry from flat arrays, smooth normals welded across seams. */
function gridMesh(pos, uv, index) {
  const g = new THREE.BufferGeometry();
  g.setAttribute("position", new THREE.Float32BufferAttribute(pos, 3));
  g.setAttribute("uv", new THREE.Float32BufferAttribute(uv, 2));
  g.setIndex(index);
  g.computeVertexNormals();
  return weldNormals(g);
}

/** Box with softly rounded edges (smooth analytic normals, seamless). */
function roundedBox(w, h, d, r, seg = 4) {
  const g = new THREE.BoxGeometry(w, h, d, seg, seg, seg);
  const p = g.attributes.position;
  const n = g.attributes.normal;
  const hx = w / 2 - r;
  const hy = h / 2 - r;
  const hz = d / 2 - r;
  for (let i = 0; i < p.count; i++) {
    const x = p.getX(i);
    const y = p.getY(i);
    const z = p.getZ(i);
    const ix = clamp(x, -hx, hx);
    const iy = clamp(y, -hy, hy);
    const iz = clamp(z, -hz, hz);
    let dx = x - ix;
    let dy = y - iy;
    let dz = z - iz;
    const l = Math.hypot(dx, dy, dz);
    if (l < 1e-6) continue;
    dx /= l;
    dy /= l;
    dz /= l;
    p.setXYZ(i, ix + dx * r, iy + dy * r, iz + dz * r);
    n.setXYZ(i, dx, dy, dz);
  }
  return g;
}

/** Give a geometry a uniform vertex colour (sRGB hex → linear). */
function tint(geo, hex) {
  _col.set(hex);
  const count = geo.attributes.position.count;
  const arr = new Float32Array(count * 3);
  for (let i = 0; i < count; i++) {
    arr[i * 3] = _col.r;
    arr[i * 3 + 1] = _col.g;
    arr[i * 3 + 2] = _col.b;
  }
  geo.setAttribute("color", new THREE.BufferAttribute(arr, 3));
  return geo;
}

/** Concatenate indexed/non-indexed geometries (position, normal, uv, color). */
function mergeGeometries(list) {
  let nv = 0;
  let ni = 0;
  const hasColor = list.some((g) => g.attributes.color);
  for (const g of list) {
    nv += g.attributes.position.count;
    ni += g.index ? g.index.count : g.attributes.position.count;
  }
  const pos = new Float32Array(nv * 3);
  const nor = new Float32Array(nv * 3);
  const uv = new Float32Array(nv * 2);
  const col = hasColor ? new Float32Array(nv * 3).fill(1) : null;
  const idx = nv > 65535 ? new Uint32Array(ni) : new Uint16Array(ni);
  let vo = 0;
  let io = 0;
  for (const g of list) {
    const a = g.attributes;
    const c = a.position.count;
    pos.set(a.position.array.subarray(0, c * 3), vo * 3);
    if (!a.normal) g.computeVertexNormals();
    nor.set(g.attributes.normal.array.subarray(0, c * 3), vo * 3);
    if (a.uv) uv.set(a.uv.array.subarray(0, c * 2), vo * 2);
    if (col && a.color) col.set(a.color.array.subarray(0, c * 3), vo * 3);
    if (g.index) {
      const src = g.index.array;
      for (let i = 0; i < g.index.count; i++) idx[io + i] = src[i] + vo;
      io += g.index.count;
    } else {
      for (let i = 0; i < c; i++) idx[io + i] = vo + i;
      io += c;
    }
    vo += c;
    g.dispose();
  }
  const out = new THREE.BufferGeometry();
  out.setAttribute("position", new THREE.BufferAttribute(pos, 3));
  out.setAttribute("normal", new THREE.BufferAttribute(nor, 3));
  out.setAttribute("uv", new THREE.BufferAttribute(uv, 2));
  if (col) out.setAttribute("color", new THREE.BufferAttribute(col, 3));
  out.setIndex(new THREE.BufferAttribute(idx, 1));
  out.computeBoundingSphere();
  return out;
}

/** NACA 4-digit half thickness (fraction of chord) at chord position s ∈ [0, 1]. */
function naca(s, t) {
  return 5 * t * (0.2969 * Math.sqrt(s) - 0.126 * s - 0.3516 * s * s + 0.2843 * s * s * s - 0.1036 * s * s * s * s);
}

/**
 * Smooth airfoil-section loft along a span (fin, stabilisers, rotor blades).
 * stations: [{ le: Vector3 leading-edge point, chord, thick, chordDir, thickDir }].
 * The two surfaces get separate UV columns (side A / side B of `uvRect`), so
 * liveries never mirror; the duplicated leading/trailing edges are welded.
 */
function airfoilGeometry(stations, segs, uvRect = null, colorAt = null) {
  const cols = segs + 1;
  const pos = [];
  const uv = [];
  const colors = colorAt ? [] : null;
  const rows = stations.length;
  for (let i = 0; i < rows; i++) {
    const st = stations[i];
    for (let side = 0; side < 2; side++) {
      for (let j = 0; j < cols; j++) {
        const phi = side * Math.PI + (Math.PI * j) / segs;
        const s = 0.5 * (1 + Math.cos(phi)); // 1 = trailing edge, 0 = leading edge
        const sign = phi <= Math.PI ? 1 : -1;
        const yt = naca(s, st.thick) * st.chord * sign;
        pos.push(
          st.le.x + st.chordDir.x * s * st.chord + st.thickDir.x * yt,
          st.le.y + st.chordDir.y * s * st.chord + st.thickDir.y * yt,
          st.le.z + st.chordDir.z * s * st.chord + st.thickDir.z * yt,
        );
        if (uvRect) {
          const um = (uvRect.u0 + uvRect.u1) / 2;
          const u = side === 0 ? lerp(uvRect.u0, um, s) : lerp(um, uvRect.u1, s);
          uv.push(u, lerp(uvRect.v0, uvRect.v1, i / (rows - 1)));
        } else uv.push(0, 0);
        if (colors) {
          _col.set(colorAt(i, s));
          colors.push(_col.r, _col.g, _col.b);
        }
      }
    }
  }
  const index = [];
  const rowLen = cols * 2;
  for (let i = 0; i < rows - 1; i++) {
    for (let side = 0; side < 2; side++) {
      for (let j = 0; j < segs; j++) {
        const a = i * rowLen + side * cols + j;
        const b = a + 1;
        const c = a + rowLen;
        const d = c + 1;
        index.push(a, b, c, b, d, c);
      }
    }
  }
  const g = gridMesh(pos, uv, index);
  if (colors) g.setAttribute("color", new THREE.Float32BufferAttribute(colors, 3));
  return orientOutward(g);
}

/* --- Procedural livery ------------------------------------------------------- */

function makeCanvas(w, h) {
  if (typeof OffscreenCanvas !== "undefined") return new OffscreenCanvas(w, h);
  const c = document.createElement("canvas");
  c.width = w;
  c.height = h;
  return c;
}

/** Livery colour map + detail map (R = bump height, G = roughness). */
function makeLiveryTextures(low) {
  const k = low ? 0.5 : 1;
  const W = TEX_W * k;
  const H = TEX_H * k;
  const band = H * BAND_V;
  const colorCanvas = makeCanvas(W, H);
  const detailCanvas = makeCanvas(W, H);
  const c = colorCanvas.getContext("2d");
  const d = detailCanvas.getContext("2d");
  const rng = makeRng(1998);
  const len = Z_NOSE - (FUSE_KEYS[FUSE_KEYS.length - 1][0] - TAIL_CAP);
  const X = (z) => ((Z_NOSE - z) / len) * W;
  const Y = (t) => (t / TAU) * band;
  // Livery split swoops up toward the nose.
  const splitAt = (z) => SPLIT - 0.06 - smoothstep(2.4, 4.3, z) * 0.55;

  /* Base paint */
  c.fillStyle = C.bone;
  c.fillRect(0, 0, W, band);
  d.fillStyle = "rgb(128,105,0)"; // flat, semi-gloss
  d.fillRect(0, 0, W, H);
  const splitPath = (ctx, offset, mirror) => {
    ctx.beginPath();
    const steps = 64;
    for (let i = 0; i <= steps; i++) {
      const x = (i / steps) * W;
      const z = Z_NOSE - (i / steps) * len;
      const t = splitAt(z) + offset;
      const y = mirror ? Y(TAU - t) : Y(t);
      if (i === 0) ctx.moveTo(x, y);
      else ctx.lineTo(x, y);
    }
  };
  // Moss belly between the two split lines.
  c.fillStyle = C.moss;
  c.beginPath();
  for (let i = 0; i <= 64; i++) {
    const z = Z_NOSE - (i / 64) * len;
    c.lineTo((i / 64) * W, Y(splitAt(z)));
  }
  for (let i = 64; i >= 0; i--) {
    const z = Z_NOSE - (i / 64) * len;
    c.lineTo((i / 64) * W, Y(TAU - splitAt(z)));
  }
  c.closePath();
  c.fill();
  d.fillStyle = "rgb(128,125,0)"; // the moss is a slightly flatter paint
  d.beginPath();
  for (let i = 0; i <= 64; i++) d.lineTo((i / 64) * W, Y(splitAt(Z_NOSE - (i / 64) * len)));
  for (let i = 64; i >= 0; i--) d.lineTo((i / 64) * W, Y(TAU - splitAt(Z_NOSE - (i / 64) * len)));
  d.closePath();
  d.fill();
  // Ochre stripe with a thin rust pinstripe above it, both flanks.
  for (const mirror of [false, true]) {
    c.lineCap = "butt";
    c.strokeStyle = C.ochre;
    c.lineWidth = 9 * k;
    splitPath(c, -0.075, mirror);
    c.stroke();
    c.strokeStyle = C.rust;
    c.lineWidth = 2.2 * k;
    splitPath(c, -0.15, mirror);
    c.stroke();
  }
  // Anti-glare panel on the nose in front of the windscreen.
  c.fillStyle = C.moss;
  c.fillRect(0, 0, X(3.78), Y(0.95));
  c.fillRect(0, Y(TAU - 0.95), X(3.78), band - Y(TAU - 0.95));
  // Weathering: soft mottling everywhere.
  for (let i = 0; i < 260; i++) {
    const x = rng() * W;
    const y = rng() * band;
    const r = rand(rng, 6, 34) * k;
    const dark = rng() < 0.6;
    c.fillStyle = dark ? `rgba(30,32,24,${rand(rng, 0.02, 0.05)})` : `rgba(255,250,235,${rand(rng, 0.02, 0.04)})`;
    c.beginPath();
    c.ellipse(x, y, r * 2.2, r, 0, 0, TAU);
    c.fill();
    d.fillStyle = `rgba(128,${Math.round(rand(rng, 95, 150))},0,0.25)`;
    d.beginPath();
    d.ellipse(x, y, r * 2.2, r, 0, 0, TAU);
    d.fill();
  }
  // Belly grime and exhaust soot along the top of the tail boom.
  const belly = c.createLinearGradient(0, Y(Math.PI - 0.9), 0, Y(Math.PI));
  belly.addColorStop(0, "rgba(20,20,14,0)");
  belly.addColorStop(1, "rgba(20,20,14,0.28)");
  c.fillStyle = belly;
  c.fillRect(0, Y(Math.PI - 0.9), W, Y(0.9));
  const belly2 = c.createLinearGradient(0, Y(Math.PI), 0, Y(Math.PI + 0.9));
  belly2.addColorStop(0, "rgba(20,20,14,0.28)");
  belly2.addColorStop(1, "rgba(20,20,14,0)");
  c.fillStyle = belly2;
  c.fillRect(0, Y(Math.PI), W, Y(0.9));
  // Soot: fades along the boom and away from the top centre line (stacked strips).
  const soot = c.createLinearGradient(X(-3.75), 0, X(-8.2), 0);
  soot.addColorStop(0, "rgba(16,15,12,0.16)");
  soot.addColorStop(1, "rgba(16,15,12,0)");
  c.fillStyle = soot;
  for (let i = 0; i < 6; i++) {
    const t = 0.55 * (1 - i / 6);
    c.fillRect(X(-3.75), 0, X(-8.2) - X(-3.75), Y(t));
    c.fillRect(X(-3.75), Y(TAU - t), X(-8.2) - X(-3.75), band - Y(TAU - t));
  }
  d.fillStyle = "rgba(128,175,0,0.5)";
  d.fillRect(X(-3.75), 0, X(-7) - X(-3.75), Y(0.4));
  d.fillRect(X(-3.75), Y(TAU - 0.4), X(-7) - X(-3.75), band - Y(TAU - 0.4));
  // Oil streaks running down the aft cabin flanks.
  for (let i = 0; i < 7; i++) {
    const z = rand(rng, -3.1, -1.35);
    const t0 = rand(rng, 0.62, 0.85);
    const t1 = t0 + rand(rng, 0.25, 0.6);
    for (const mirror of [false, true]) {
      const g = c.createLinearGradient(0, Y(mirror ? TAU - t0 : t0), 0, Y(mirror ? TAU - t1 : t1));
      g.addColorStop(0, "rgba(26,22,16,0.35)");
      g.addColorStop(1, "rgba(26,22,16,0)");
      c.fillStyle = g;
      const ya = Y(mirror ? TAU - t1 : t0);
      const yb = Y(mirror ? TAU - t0 : t1);
      c.fillRect(X(z) - 1.5 * k, ya, 3 * k, yb - ya);
    }
  }

  /* Panel lines + rivets (colour + bump + roughness) */
  const groove = (draw, width = 1.6) => {
    c.strokeStyle = "rgba(24,24,20,0.55)";
    c.lineWidth = width * k;
    draw(c);
    c.stroke();
    d.strokeStyle = "rgb(60,150,0)";
    d.lineWidth = (width + 0.8) * k;
    draw(d);
    d.stroke();
  };
  const rivets = (x0, y0, x1, y1) => {
    const n = Math.max(1, Math.floor(Math.hypot(x1 - x0, y1 - y0) / (7 * k)));
    for (let i = 0; i <= n; i++) {
      const x = lerp(x0, x1, i / n);
      const y = lerp(y0, y1, i / n);
      c.fillStyle = "rgba(20,20,16,0.28)";
      c.fillRect(x - 0.8 * k, y - 0.8 * k, 1.6 * k, 1.6 * k);
      d.fillStyle = "rgb(178,110,0)";
      d.fillRect(x - 0.9 * k, y - 0.9 * k, 1.8 * k, 1.8 * k);
    }
  };
  const ring = (z) => {
    groove((ctx) => {
      ctx.beginPath();
      ctx.moveTo(X(z), 0);
      ctx.lineTo(X(z), band);
    });
    rivets(X(z) + 3 * k, 0, X(z) + 3 * k, band);
  };
  const rectLine = (z0, z1, t0, t1, radius = 6) => {
    for (const mirror of [false, true]) {
      const ya = Y(mirror ? TAU - t1 : t0);
      const yb = Y(mirror ? TAU - t0 : t1);
      const xa = X(z1);
      const xb = X(z0);
      groove((ctx) => {
        ctx.beginPath();
        if (ctx.roundRect) ctx.roundRect(xa, ya, xb - xa, yb - ya, radius * k);
        else ctx.rect(xa, ya, xb - xa, yb - ya);
      });
      rivets(xa + 3 * k, ya - 3 * k, xb - 3 * k, ya - 3 * k);
      rivets(xa + 3 * k, yb + 3 * k, xb - 3 * k, yb + 3 * k);
    }
  };
  for (const z of [2.42, -3.3, -4.4, -5.6, -6.9, -8.1, -9.0]) ring(z);
  rectLine(1.25, 2.35, 0.92, 2.25, 10); // pilot doors
  rectLine(3.0, 3.6, 1.55, 2.2); // nose avionics bay
  rectLine(-3.1, -2.0, 2.36, 2.75); // aft cabin access
  rectLine(-6.2, -5.6, 1.3, 1.9); // boom access
  rectLine(-1.15, 0.9, 0.98, 2.26, 8); // cargo door skin (shows on the slid-back door)
  for (const t of [Math.PI - 0.5, Math.PI + 0.5]) {
    groove((ctx) => {
      ctx.beginPath();
      ctx.moveTo(X(3.2), Y(t));
      ctx.lineTo(X(-3.2), Y(t));
    });
  }
  for (const t of [1.2, 2.05]) {
    for (const mirror of [false, true]) {
      const y = Y(mirror ? TAU - t : t);
      groove((ctx) => {
        ctx.beginPath();
        ctx.moveTo(X(-3.3), y);
        ctx.lineTo(X(-9.2), y);
      }, 1.2);
    }
  }

  /* Window seals, door handle, cargo-door window frame */
  const seal = (z0, z1, t0, t1) => {
    for (const mirror of [false, true]) {
      const ya = Y(mirror ? TAU - t1 : t0);
      const yb = Y(mirror ? TAU - t0 : t1);
      c.strokeStyle = C.rubber;
      c.lineWidth = 9 * k;
      c.strokeRect(X(z1), ya, X(z0) - X(z1), yb - ya);
      d.strokeStyle = "rgb(110,225,0)";
      d.lineWidth = 9 * k;
      d.strokeRect(X(z1), ya, X(z0) - X(z1), yb - ya);
    }
  };
  for (const w of WINDOWS) seal(w.z0, w.z1, w.t0, w.t1);
  seal(DOOR_WIN.z0, DOOR_WIN.z1, DOOR_WIN.t0, DOOR_WIN.t1);
  c.fillStyle = C.rubber;
  c.fillRect(X(3.75), 0, X(2.45) - X(3.75), Y(0.04)); // windscreen centre post
  c.fillRect(X(3.75), Y(TAU - 0.04), X(2.45) - X(3.75), band - Y(TAU - 0.04));
  for (const mirror of [false, true]) {
    c.fillStyle = C.ink;
    const t = 1.62;
    const y = Y(mirror ? TAU - t : t);
    c.fillRect(X(0.75), y - 2 * k, X(0.45) - X(0.75), 4 * k); // cargo door handle
    c.fillRect(X(2.28), Y(mirror ? TAU - 1.7 : 1.7) - 2 * k, X(2.05) - X(2.28), 4 * k); // pilot door handle
  }

  /* Expedition emblem on the cargo doors: a theropod track in a ring. */
  const emblem = (cx, cy, r, flip) => {
    c.save();
    c.translate(cx, cy);
    if (flip) c.rotate(Math.PI);
    c.strokeStyle = C.ochre;
    c.fillStyle = C.ochre;
    c.lineWidth = 3 * k;
    c.beginPath();
    c.arc(0, 0, r, 0, TAU);
    c.stroke();
    // Toes point toward the nose (canvas −x on the left flank).
    c.beginPath();
    c.ellipse(r * 0.18, 0, r * 0.22, r * 0.2, 0, 0, TAU);
    c.fill();
    for (const a of [-0.55, 0, 0.55]) {
      c.save();
      c.rotate(Math.PI + a);
      c.beginPath();
      c.ellipse(r * 0.42, 0, r * 0.3, r * 0.085, 0, 0, TAU);
      c.fill();
      c.restore();
    }
    c.restore();
  };
  const emblemZ = 0.12;
  const emblemT = 2.0;
  // The door section is ~1.25× taller in v than in u per metre; squash to stay round.
  for (const mirror of [false, true]) {
    c.save();
    const cx = X(emblemZ);
    const cy = Y(mirror ? TAU - emblemT : emblemT);
    c.translate(cx, cy);
    c.scale(1, 0.93);
    c.translate(-cx, -cy);
    emblem(cx, cy, 15 * k, mirror);
    c.restore();
  }

  /* Registration on the tail boom (v is ~2.6× denser than u there). */
  for (const mirror of [false, true]) {
    const cx = (X(-5.7) + X(-7.2)) / 2;
    const tMid = 1.02;
    const cy = Y(mirror ? TAU - tMid : tMid);
    c.save();
    c.translate(cx, cy);
    if (mirror) c.rotate(Math.PI);
    c.scale(1, 2.9);
    c.fillStyle = C.ink;
    c.font = `600 ${Math.round(17 * k)}px "Helvetica Neue", Arial, sans-serif`;
    c.textAlign = "center";
    c.textBaseline = "middle";
    c.fillText("SX-07", 0, 0);
    c.restore();
  }

  /* Parts strip: fin (two sides) and stabilisers. */
  const py0 = band;
  const ph = H - band;
  c.fillStyle = C.moss;
  c.fillRect(0, py0, W, ph);
  for (const x0 of [0, W * 0.25]) {
    // fin: bone cap, ochre stripe below it (v grows root → tip)
    c.fillStyle = C.bone;
    c.fillRect(x0, py0 + ph * 0.86, W * 0.25, ph * 0.14);
    c.fillStyle = C.ochre;
    c.fillRect(x0, py0 + ph * 0.74, W * 0.25, ph * 0.07);
    c.fillStyle = "rgba(20,20,14,0.25)";
    c.fillRect(x0, py0, W * 0.25, ph * 0.12);
  }
  for (const x0 of [W * 0.5, W * 0.75]) {
    c.fillStyle = C.bone;
    c.fillRect(x0, py0 + ph * 0.84, W * 0.25, ph * 0.16);
    c.fillStyle = C.ochre;
    c.fillRect(x0, py0, W * 0.012, ph); // leading-edge pinstripe
  }

  const map = new THREE.CanvasTexture(colorCanvas);
  map.colorSpace = THREE.SRGBColorSpace;
  map.flipY = false;
  map.anisotropy = 8;
  const detail = new THREE.CanvasTexture(detailCanvas);
  detail.colorSpace = THREE.NoColorSpace;
  detail.flipY = false;
  detail.anisotropy = 4;
  return { map, detail };
}

/* --- Materials --------------------------------------------------------------- */

/**
 * Shared shader patches for the standard materials:
 *  env      cheap sky-gradient reflection (fresnel, gloss-weighted) so paint,
 *           glass and metal read as such without an environment map;
 *  interior back faces of the (double-sided) skin show the cabin lining;
 *  cabin    warm emissive "cabin light" proportional to albedo at night;
 *  glass    fresnel raises opacity at grazing angles.
 */
function patchMaterial(mat, uniforms, { env = true, interior = false, cabin = false, glass = false } = {}) {
  mat.onBeforeCompile = (shader) => {
    Object.assign(shader.uniforms, uniforms);
    let fs = shader.fragmentShader;
    fs = fs.replace(
      "#include <common>",
      `#include <common>
uniform vec3 uEnvSky;
uniform vec3 uEnvHorizon;
uniform vec3 uEnvGround;
uniform float uEnvStrength;
uniform float uCabinLight;
uniform vec3 uInterior;`,
    );
    if (interior) {
      fs = fs.replace("#include <map_fragment>", "#include <map_fragment>\n  if (!gl_FrontFacing) diffuseColor.rgb = uInterior;");
      fs = fs.replace("#include <roughnessmap_fragment>", "#include <roughnessmap_fragment>\n  if (!gl_FrontFacing) roughnessFactor = 0.9;");
    }
    if (interior || cabin) {
      fs = fs.replace(
        "#include <emissivemap_fragment>",
        `#include <emissivemap_fragment>
  totalEmissiveRadiance += diffuseColor.rgb * uCabinLight * vec3(1.0, 0.82, 0.58) * ${interior ? "(gl_FrontFacing ? 0.0 : 1.0)" : "1.0"};`,
      );
    }
    if (env) {
      fs = fs.replace(
        "#include <opaque_fragment>",
        `{
    vec3 rN = normalize(normal);
    vec3 rV = normalize(vViewPosition);
    vec3 wR = inverseTransformDirection(reflect(-rV, rN), viewMatrix);
    float up = wR.y;
    vec3 envC = up > 0.0 ? mix(uEnvHorizon, uEnvSky, pow(clamp(up, 0.0, 1.0), 0.55)) : mix(uEnvHorizon, uEnvGround, pow(clamp(-up, 0.0, 1.0), 0.35));
    float NoV = clamp(dot(rN, rV), 0.0, 1.0);
    vec3 F0 = mix(vec3(0.04), diffuseColor.rgb, metalnessFactor);
    vec3 F = F0 + (1.0 - F0) * pow(1.0 - NoV, 5.0);
    float gloss = 1.0 - roughnessFactor;
    float facing = ${interior ? "(gl_FrontFacing ? 1.0 : 0.0)" : "1.0"};
    outgoingLight += envC * F * (0.15 + 0.85 * gloss * gloss) * uEnvStrength * facing;
    ${glass ? "diffuseColor.a = clamp(diffuseColor.a + (F.g - 0.04) * 0.9, 0.0, 1.0);" : ""}
  }
  #include <opaque_fragment>`,
      );
    }
    shader.fragmentShader = fs;
  };
  mat.customProgramCacheKey = () => `sauria-heli-${env}-${interior}-${cabin}-${glass}`;
  return mat;
}

const BILLBOARD_VERT = /* glsl */ `
attribute vec3 iOffset;
attribute vec2 iSizeAlpha;
attribute vec3 iColor;
uniform float uViewportH;
uniform float uMinPx;
varying vec2 vUv;
varying float vAlpha;
varying vec3 vColor;
#include <fog_pars_vertex>
void main() {
  vUv = position.xy + 0.5;
  vec4 mvPosition = modelViewMatrix * vec4(iOffset, 1.0);
  // Never smaller than uMinPx on screen, so far lights still read as points.
  float minSize = uMinPx * 2.0 * -mvPosition.z / (uViewportH * projectionMatrix[1][1]);
  float size = max(iSizeAlpha.x, minSize);
  mvPosition.xy += position.xy * size;
  gl_Position = projectionMatrix * mvPosition;
  vAlpha = iSizeAlpha.y * clamp(iSizeAlpha.x / max(size, 1e-4), 0.35, 1.0);
  vColor = iColor;
  #include <fog_vertex>
}`;

// Additive fog: fade out instead of mixing toward the fog colour.
const FOG_FADE = /* glsl */ `
#ifdef USE_FOG
  #ifdef FOG_EXP2
    float fogF = 1.0 - exp(-fogDensity * fogDensity * vFogDepth * vFogDepth);
  #else
    float fogF = smoothstep(fogNear, fogFar, vFogDepth);
  #endif
  a *= 1.0 - fogF;
#endif`;

function glowMaterial() {
  return new THREE.ShaderMaterial({
    uniforms: THREE.UniformsUtils.merge([THREE.UniformsLib.fog, { uViewportH: { value: 720 }, uMinPx: { value: 3 } }]),
    vertexShader: BILLBOARD_VERT,
    fragmentShader: /* glsl */ `
varying vec2 vUv;
varying float vAlpha;
varying vec3 vColor;
#include <fog_pars_fragment>
void main() {
  vec2 p = vUv * 2.0 - 1.0;
  float r2 = dot(p, p);
  if (r2 > 1.0) discard;
  float a = exp(-r2 * 5.0) + 0.35 * exp(-r2 * 1.6);
  a *= vAlpha;
  ${FOG_FADE}
  gl_FragColor = vec4(vColor, a);
  #include <tonemapping_fragment>
  #include <colorspace_fragment>
}`,
    transparent: true,
    depthWrite: false,
    blending: THREE.AdditiveBlending,
    fog: true,
  });
}

function dustMaterial() {
  return new THREE.ShaderMaterial({
    uniforms: THREE.UniformsUtils.merge([THREE.UniformsLib.fog, { uViewportH: { value: 720 }, uMinPx: { value: 0 }, uLight: { value: new THREE.Color(1, 1, 1) } }]),
    vertexShader: BILLBOARD_VERT,
    fragmentShader: /* glsl */ `
uniform vec3 uLight;
varying vec2 vUv;
varying float vAlpha;
varying vec3 vColor;
#include <fog_pars_fragment>
void main() {
  vec2 p = vUv * 2.0 - 1.0;
  float r2 = dot(p, p);
  if (r2 > 1.0) discard;
  // Lumpy, soft puff: radial falloff broken up by a couple of cheap waves.
  float lump = 0.82 + 0.18 * sin(p.x * 5.1 + p.y * 3.3 + vAlpha * 40.0) * sin(p.y * 4.7 - p.x * 2.1);
  float a = (1.0 - r2) * (1.0 - r2) * lump * vAlpha;
  gl_FragColor = vec4(vColor * uLight, a);
  #include <tonemapping_fragment>
  #include <colorspace_fragment>
  #include <fog_fragment>
}`,
    transparent: true,
    depthWrite: false,
    fog: true,
  });
}

/** Motion-blurred rotor disc: faint haze plus a smear trailing each blade. */
function rotorDiscMaterial({ chord, hub, color, tip, blades = 2 }) {
  return new THREE.ShaderMaterial({
    uniforms: THREE.UniformsUtils.merge([THREE.UniformsLib.fog, {
      uAngle: { value: 0 },
      uSweep: { value: 0.6 },
      uOpacity: { value: 1 },
      uRadius: { value: 1 },
      uHub: { value: hub },
      uChord: { value: chord },
      uBlades: { value: blades },
      uColor: { value: new THREE.Color(color) },
      uTip: { value: new THREE.Color(tip) },
      uLight: { value: new THREE.Color(1, 1, 1) },
    }]),
    vertexShader: /* glsl */ `
varying vec2 vP;
#include <fog_pars_vertex>
void main() {
  vP = position.xy;
  vec4 mvPosition = modelViewMatrix * vec4(position, 1.0);
  gl_Position = projectionMatrix * mvPosition;
  #include <fog_vertex>
}`,
    fragmentShader: /* glsl */ `
uniform float uAngle;
uniform float uSweep;
uniform float uOpacity;
uniform float uRadius;
uniform float uHub;
uniform float uChord;
uniform float uBlades;
uniform vec3 uColor;
uniform vec3 uTip;
uniform vec3 uLight;
varying vec2 vP;
#include <fog_pars_fragment>
void main() {
  float r = length(vP);
  float rn = r / uRadius;
  if (rn > 1.0 || r < uHub) discard;
  float seg = 6.2831853 / uBlades;
  float d = mod(uAngle - atan(vP.y, vP.x), seg); // radians behind the nearest blade
  float bladeAng = uChord / max(r, 0.2);
  // The blade sweeps uSweep radians per frame: its paint spreads over that arc.
  float density = clamp(bladeAng / uSweep, 0.0, 1.0);
  float smear = density * (1.0 - smoothstep(uSweep * 0.55, uSweep * 1.05, d));
  float blade = 1.0 - smoothstep(0.0, bladeAng * 1.2, d);
  float haze = 0.05 + 0.05 * (1.0 - rn);
  float tipBand = smoothstep(0.935, 0.95, rn) * (1.0 - smoothstep(0.99, 1.0, rn));
  float edge = 1.0 - smoothstep(0.985, 1.0, rn);
  float a = (haze + max(smear * 0.85, blade * 0.55) + tipBand * 0.04) * edge * uOpacity;
  vec3 col = mix(uColor, uTip, tipBand * 0.6) * uLight;
  gl_FragColor = vec4(col, a);
  #include <tonemapping_fragment>
  #include <colorspace_fragment>
  #include <fog_fragment>
}`,
    transparent: true,
    depthWrite: false,
    side: THREE.DoubleSide,
    fog: true,
  });
}

function lightConeMaterial() {
  return new THREE.ShaderMaterial({
    uniforms: THREE.UniformsUtils.merge([THREE.UniformsLib.fog, { uOpacity: { value: 0 }, uColor: { value: new THREE.Color("#ffe6bf") } }]),
    vertexShader: /* glsl */ `
varying float vAxial;
varying float vFacing;
#include <fog_pars_vertex>
void main() {
  vAxial = clamp(-position.y, 0.0, 1.0);
  vec4 mvPosition = modelViewMatrix * vec4(position, 1.0);
  vec3 n = normalize(normalMatrix * normal);
  vFacing = abs(dot(n, normalize(-mvPosition.xyz)));
  gl_Position = projectionMatrix * mvPosition;
  #include <fog_vertex>
}`,
    fragmentShader: /* glsl */ `
uniform float uOpacity;
uniform vec3 uColor;
varying float vAxial;
varying float vFacing;
#include <fog_pars_fragment>
void main() {
  float a = uOpacity * pow(1.0 - vAxial, 1.6) * smoothstep(0.0, 0.08, vAxial) * pow(vFacing, 1.4);
  ${FOG_FADE}
  gl_FragColor = vec4(uColor, a);
  #include <tonemapping_fragment>
  #include <colorspace_fragment>
}`,
    transparent: true,
    depthWrite: false,
    blending: THREE.AdditiveBlending,
    side: THREE.DoubleSide,
    fog: true,
  });
}

function washRingMaterial() {
  return new THREE.ShaderMaterial({
    uniforms: THREE.UniformsUtils.merge([THREE.UniformsLib.fog, {
      uTime: { value: 0 },
      uAmount: { value: 0 },
      uRadius: { value: 16 },
      uLight: { value: new THREE.Color(1, 1, 1) },
    }]),
    vertexShader: /* glsl */ `
varying vec2 vP;
#include <fog_pars_vertex>
void main() {
  vP = position.xy;
  vec4 mvPosition = modelViewMatrix * vec4(position, 1.0);
  gl_Position = projectionMatrix * mvPosition;
  #include <fog_vertex>
}`,
    fragmentShader: /* glsl */ `
uniform float uTime;
uniform float uAmount;
uniform float uRadius;
uniform vec3 uLight;
varying vec2 vP;
#include <fog_pars_fragment>
void main() {
  float r = length(vP) / uRadius;
  if (r > 1.0) discard;
  float ang = atan(vP.y, vP.x);
  float rings = pow(0.5 + 0.5 * sin(r * 38.0 - uTime * 8.0 + sin(ang * 5.0) * 0.6), 5.0);
  float streak = 0.5 + 0.5 * sin(ang * 23.0 + sin(r * 7.0 - uTime * 2.6) * 2.2);
  float fall = smoothstep(1.0, 0.3, r) * smoothstep(0.04, 0.2, r);
  float a = (rings * 0.5 + streak * 0.14 + 0.12) * fall * uAmount;
  gl_FragColor = vec4(vec3(0.86, 0.92, 0.93) * uLight, a);
  #include <tonemapping_fragment>
  #include <colorspace_fragment>
  #include <fog_fragment>
}`,
    transparent: true,
    depthWrite: false,
    polygonOffset: true,
    polygonOffsetFactor: -2,
    polygonOffsetUnits: -2,
    fog: true,
  });
}

/** Instanced camera-facing quads (one draw call) driven by per-instance attributes. */
function billboardGeometry(count) {
  const g = new THREE.InstancedBufferGeometry();
  g.setAttribute("position", new THREE.Float32BufferAttribute([-0.5, -0.5, 0, 0.5, -0.5, 0, 0.5, 0.5, 0, -0.5, 0.5, 0], 3));
  g.setIndex([0, 1, 2, 0, 2, 3]);
  const off = new THREE.InstancedBufferAttribute(new Float32Array(count * 3), 3);
  const sa = new THREE.InstancedBufferAttribute(new Float32Array(count * 2), 2);
  const col = new THREE.InstancedBufferAttribute(new Float32Array(count * 3), 3);
  off.setUsage(THREE.DynamicDrawUsage);
  sa.setUsage(THREE.DynamicDrawUsage);
  col.setUsage(THREE.DynamicDrawUsage);
  g.setAttribute("iOffset", off);
  g.setAttribute("iSizeAlpha", sa);
  g.setAttribute("iColor", col);
  g.instanceCount = 0;
  return g;
}

/** Keep billboard sizing correct in both render styles (full-res canvas or low-res target). */
function trackViewport(mesh, uniforms) {
  mesh.onBeforeRender = (renderer) => {
    const rt = renderer.getRenderTarget();
    uniforms.uViewportH.value = rt ? rt.height : renderer.getDrawingBufferSize(_size).y;
  };
}

/* --- Model ------------------------------------------------------------------- */

const FUSE = makeLoft(FUSE_KEYS, Z_NOSE, NOSE_CAP, TAIL_CAP, -0.1);
const DOG = makeLoft(DOG_KEYS, DOG_FRONT, DOG_FRONT - DOG_KEYS[0][0], 0.42);
const FUSE_LEN = FUSE.len;

const HOLE = 0;
const PAINT = 1;
const GLASS = 2;

function fuselageFace(zc, tc) {
  const ts = tc > Math.PI ? TAU - tc : tc;
  if (zc > DOOR_Z0 && zc < DOOR_Z1 && ts > DOOR_T0 && ts < DOOR_T1) return HOLE;
  for (const w of WINDOWS) if (zc > w.z0 && zc < w.z1 && ts > w.t0 && ts < w.t1) return GLASS;
  return PAINT;
}

function thetaColumns(n, bounds) {
  const base = [];
  for (let j = 0; j <= n; j++) base.push((j / n) * TAU);
  const all = [];
  for (const b of bounds) all.push(b, TAU - b);
  return withBoundaries(base, all, 0.025);
}

/** Fuselage skin → { paint, glass } geometries sharing one vertex layout. */
function buildFuselage(low) {
  const sec = {};
  const p = {};
  const zBounds = [3.85, 3.75, 2.75, 2.45, 2.4, 2.3, 1.75, 1.4, DOOR_Z1, DOOR_Z0];
  const step = (s) => {
    const z = Z_NOSE - s;
    const base = z > -2.3 ? 0.11 : z > -4.2 ? 0.15 : 0.32;
    return low ? base * 1.5 : base;
  };
  const rings = loftStations(FUSE, step, low ? 8 : 12, zBounds);
  const thetas = thetaColumns(low ? 44 : 60, [0.04, 0.55, DOOR_T0, 1.45, 1.63, DOOR_T1, 2.85]);
  const cols = thetas.length;
  const pos = [];
  const uv = [];
  for (const s of rings) {
    FUSE.at(s, sec);
    for (const t of thetas) {
      sectionPoint(sec, t, 0, p);
      pos.push(p.x, p.y, Z_NOSE - s);
      uv.push(s / FUSE_LEN, (t / TAU) * BAND_V);
    }
  }
  const paint = [];
  const glass = [];
  for (let i = 0; i < rings.length - 1; i++) {
    const zc = Z_NOSE - (rings[i] + rings[i + 1]) / 2;
    for (let j = 0; j < cols - 1; j++) {
      const kind = fuselageFace(zc, (thetas[j] + thetas[j + 1]) / 2);
      if (kind === HOLE) continue;
      const a = i * cols + j;
      const b = a + 1;
      const c = a + cols;
      const d = c + 1;
      (kind === GLASS ? glass : paint).push(a, b, c, b, d, c);
    }
  }
  const geo = gridMesh(pos, uv, paint.concat(glass));
  const paintGeo = geo.clone();
  paintGeo.setIndex(paint);
  const glassGeo = geo.clone();
  glassGeo.setIndex(glass);
  geo.dispose();
  return { paint: paintGeo, glass: glassGeo };
}

/** The two cargo doors, slid back along their rails (skin patches with a window). */
function buildDoors() {
  const sec = {};
  const p = {};
  const zs = withBoundaries(Array.from({ length: 11 }, (_, i) => lerp(DOOR_Z0, DOOR_Z1, i / 10)), [DOOR_WIN.z0, DOOR_WIN.z1], 0.05);
  const tsLeft = withBoundaries(Array.from({ length: 13 }, (_, i) => lerp(DOOR_T0, DOOR_T1, i / 12)), [DOOR_WIN.t0, DOOR_WIN.t1], 0.03);
  const paints = [];
  const glasses = [];
  for (const mirror of [false, true]) {
    const ts = mirror ? tsLeft.map((t) => TAU - t).reverse() : tsLeft;
    const zDesc = zs.slice().reverse(); // rings run nose → tail like the fuselage
    const build = (off, kindWanted) => {
      const pos = [];
      const uv = [];
      for (const z of zDesc) {
        FUSE.at(Z_NOSE - z, sec);
        for (const t of ts) {
          sectionPoint(sec, t, off, p);
          pos.push(p.x, p.y, z - DOOR_SLIDE);
          uv.push((Z_NOSE - z) / FUSE_LEN, (t / TAU) * BAND_V);
        }
      }
      const index = [];
      const cols = ts.length;
      for (let i = 0; i < zDesc.length - 1; i++) {
        const zc = (zDesc[i] + zDesc[i + 1]) / 2;
        for (let j = 0; j < cols - 1; j++) {
          const tc = (ts[j] + ts[j + 1]) / 2;
          const tl = tc > Math.PI ? TAU - tc : tc;
          const inWin = zc > DOOR_WIN.z0 && zc < DOOR_WIN.z1 && tl > DOOR_WIN.t0 && tl < DOOR_WIN.t1;
          if (inWin !== (kindWanted === GLASS)) continue;
          const a = i * cols + j;
          index.push(a, a + 1, a + cols, a + 1, a + cols + 1, a + cols);
        }
      }
      return gridMesh(pos, uv, index);
    };
    paints.push(build(0.05, PAINT));
    glasses.push(build(0.035, GLASS));
  }
  return { paint: mergeGeometries(paints), glass: mergeGeometries(glasses) };
}

function buildDoghouse(low) {
  const sec = {};
  const p = {};
  const rings = loftStations(DOG, () => (low ? 0.3 : 0.18), low ? 5 : 8);
  const thetas = thetaColumns(low ? 28 : 40, []);
  const pos = [];
  const uv = [];
  for (const s of rings) {
    DOG.at(s, sec);
    const z = DOG.zFront - s;
    for (const t of thetas) {
      sectionPoint(sec, t, 0, p);
      pos.push(p.x, p.y, z);
      // Map into the cabin-roof strip of the fuselage band (bone, panel lines).
      uv.push((Z_NOSE - z) / FUSE_LEN, (t / TAU) * 0.085);
    }
  }
  const cols = thetas.length;
  const index = [];
  for (let i = 0; i < rings.length - 1; i++) {
    for (let j = 0; j < cols - 1; j++) {
      const a = i * cols + j;
      index.push(a, a + 1, a + cols, a + 1, a + cols + 1, a + cols);
    }
  }
  return gridMesh(pos, uv, index);
}

function buildTailSurfaces(low) {
  const segs = low ? 8 : 12;
  const back = new THREE.Vector3(0, 0, -1);
  // Vertical fin: swept, root buried in the boom, airfoil section.
  const finStations = [
    [1.95, -8.55, 1.26],
    [2.6, -8.78, 1.06],
    [3.3, -9.04, 0.86],
    [3.85, -9.28, 0.66],
    [3.97, -9.36, 0.42],
    [4.0, -9.39, 0.2],
  ].map(([y, z, chord], i, arr) => ({
    le: new THREE.Vector3(0, y, z),
    chord,
    thick: i >= arr.length - 2 ? 0.07 : 0.13,
    chordDir: back,
    thickDir: new THREE.Vector3(1, 0, 0),
  }));
  const fin = airfoilGeometry(finStations, segs, { u0: 0, u1: 0.5, v0: BAND_V + 0.004, v1: 0.996 });
  // Horizontal stabilisers (synchronised elevator), one per side.
  const stabs = [];
  for (const sx of [1, -1]) {
    const st = [0, 0.6, 1.2, 1.42, 1.48].map((x, i, arr) => ({
      le: new THREE.Vector3(sx * x, 2.03, -6.05 - x * 0.06),
      chord: i === arr.length - 1 ? 0.3 : i === arr.length - 2 ? 0.5 : 0.56,
      thick: i === arr.length - 1 ? 0.06 : 0.12,
      chordDir: back,
      thickDir: new THREE.Vector3(0, 1, 0),
    }));
    stabs.push(airfoilGeometry(st, segs, { u0: 0.5, u1: 1, v0: BAND_V + 0.004, v1: 0.996 }));
  }
  return mergeGeometries([fin, ...stabs]);
}

/** Main rotor: { hub, blades } — two twisted, tapered blades + the head (vertex coloured). */
function buildMainRotor(low) {
  const parts = [];
  const radii = low
    ? [0.55, 1.4, 3.0, 4.6, 6.0, 6.95, 7.2, 7.3]
    : [0.55, 0.9, 1.5, 2.3, 3.2, 4.1, 5.0, 5.8, 6.5, 6.95, 7.15, 7.25, 7.3];
  const blade = (sign) => {
    const st = radii.map((r) => {
      const pitch = lerp(0.16, 0.05, r / ROTOR_R);
      const chord = r < 0.7 ? 0.42 : r > 7.27 ? 0.14 : r > 7.2 ? 0.38 : r > 7.1 ? 0.5 : 0.53;
      const chordDir = new THREE.Vector3(0, -Math.sin(pitch), Math.cos(pitch) * sign);
      const thickDir = new THREE.Vector3(0, Math.cos(pitch), Math.sin(pitch) * sign);
      const axis = new THREE.Vector3(r * sign, r * 0.028, 0); // slight coning
      return { le: axis.addScaledVector(chordDir, -0.25 * chord), chord, thick: r > 7.2 ? 0.07 : 0.12, chordDir, thickDir };
    });
    return airfoilGeometry(st, low ? 7 : 10, null, (i) => (radii[i] > 6.92 ? "#c9a03c" : radii[i] > 6.85 ? "#d8d2c0" : "#2a2c2d"));
  };
  const blades = mergeGeometries([blade(1), blade(-1)]);
  parts.push(tint(roundedBox(0.66, 0.16, 0.34, 0.05, 3), "#3a3e3f"));
  for (const sx of [1, -1]) {
    const grip = new THREE.CylinderGeometry(0.075, 0.07, 0.42, 12);
    grip.rotateZ(HALF_PI);
    grip.translate(sx * 0.42, 0, 0);
    parts.push(tint(grip, "#45494a"));
    const link = new THREE.CylinderGeometry(0.018, 0.018, 0.42, 6);
    link.translate(sx * 0.3, -0.24, 0.12 * sx);
    parts.push(tint(link, "#5a5e5e"));
  }
  // Stabiliser (fly-)bar across the blades with its weights.
  const bar = new THREE.CylinderGeometry(0.024, 0.024, 2.7, 8);
  bar.rotateX(HALF_PI);
  bar.translate(0, 0.13, 0);
  parts.push(tint(bar, "#2f3233"));
  for (const sz of [1, -1]) {
    const w = new THREE.CapsuleGeometry(0.06, 0.26, 4, 10);
    w.rotateX(HALF_PI);
    w.translate(0, 0.13, sz * 1.32);
    parts.push(tint(w, "#26292a"));
  }
  const nut = new THREE.CylinderGeometry(0.1, 0.12, 0.16, 14);
  nut.translate(0, 0.12, 0);
  parts.push(tint(nut, "#3a3e3f"));
  return { hub: mergeGeometries(parts), blades };
}

/** Tail rotor: { hub, blades } with warning bands; spins about local X. */
function buildTailRotor(low) {
  const parts = [];
  const bladeParts = [];
  const radii = [0.14, 0.4, 0.75, 1.05, 1.22, 1.28, 1.3];
  for (const sign of [1, -1]) {
    const st = radii.map((r) => {
      const pitch = 0.14;
      const chordDir = new THREE.Vector3(Math.sin(pitch) * sign, 0, -Math.cos(pitch) * sign);
      const thickDir = new THREE.Vector3(Math.cos(pitch), 0, Math.sin(pitch) * sign);
      const chord = r > 1.27 ? 0.1 : 0.21;
      const le = new THREE.Vector3(0, r * sign, 0).addScaledVector(chordDir, -0.25 * chord);
      return { le, chord, thick: 0.11, chordDir, thickDir };
    });
    bladeParts.push(airfoilGeometry(st, low ? 6 : 8, null, (i) => {
      const r = radii[i];
      if (r < 0.5) return "#2d3031";
      return Math.floor((r - 0.5) / 0.2) % 2 === 0 ? "#9c3a26" : "#d6d0bd";
    }));
  }
  const hub = new THREE.CylinderGeometry(0.09, 0.09, 0.16, 12);
  hub.rotateZ(HALF_PI);
  parts.push(tint(hub, "#3a3e3f"));
  const cap = new THREE.SphereGeometry(0.075, 12, 8);
  cap.translate(0.08, 0, 0);
  parts.push(tint(cap, "#3a3e3f"));
  return { hub: mergeGeometries(parts), blades: mergeGeometries(bladeParts) };
}

/** Skids, tubes, mast, exhaust, trims, antennas — one vertex-coloured metal mesh. */
function buildMetal(low) {
  const parts = [];
  const rs = low ? 6 : 10;
  const tube = (pts, r, color, segs = 24, closed = false) => {
    const curve = new THREE.CatmullRomCurve3(pts, closed, "centripetal");
    parts.push(tint(new THREE.TubeGeometry(curve, segs, r, rs, closed), color));
  };
  const skid = "#3c4038";
  for (const sx of [1, -1]) {
    const x = 1.25 * sx;
    tube([
      new THREE.Vector3(x, 0.06, -2.15),
      new THREE.Vector3(x, 0.06, 0.4),
      new THREE.Vector3(x, 0.06, 2.35),
      new THREE.Vector3(x, 0.13, 2.78),
      new THREE.Vector3(x, 0.33, 3.04),
      new THREE.Vector3(x, 0.53, 3.13),
    ], 0.055, skid, 40);
    for (const [z, y] of [[-2.15, 0.06], [3.13, 0.53]]) {
      const end = new THREE.SphereGeometry(0.055, 10, 8);
      end.translate(x, y, z);
      parts.push(tint(end, skid));
    }
    // Boarding step on the door side.
    const step = roundedBox(0.46, 0.035, 0.24, 0.012, 2);
    step.translate(1.4 * sx, 0.6, -0.12);
    parts.push(tint(step, "#2f322d"));
    for (const z of [-0.3, 0.06]) {
      tube([new THREE.Vector3(1.22 * sx, 0.84, z), new THREE.Vector3(1.38 * sx, 0.6, z)], 0.016, "#2f322d", 4);
    }
  }
  for (const z of [1.45, -1.55]) {
    const pts = [[1.25, 0.06], [1.22, 0.36], [1.08, 0.64], [0.7, 0.76], [0, 0.8], [-0.7, 0.76], [-1.08, 0.64], [-1.22, 0.36], [-1.25, 0.06]];
    tube(pts.map(([x, y]) => new THREE.Vector3(x, y, z)), 0.05, skid, 32);
  }
  // Door-opening trims and the sliding-door rails.
  const sec = {};
  const p = {};
  // `sectionZ` lets the door rails run straight along the cabin section.
  const surf = (z, t, off, sectionZ = z) => {
    FUSE.at(Z_NOSE - sectionZ, sec);
    sectionPoint(sec, t, off, p);
    return new THREE.Vector3(p.x, p.y, z);
  };
  for (const mirror of [false, true]) {
    const T = (t) => (mirror ? TAU - t : t);
    const pts = [];
    const n = 7;
    for (let i = 0; i < n; i++) pts.push(surf(lerp(DOOR_Z1, DOOR_Z0, i / n), T(DOOR_T0), 0.015));
    for (let i = 0; i < n; i++) pts.push(surf(DOOR_Z0, T(lerp(DOOR_T0, DOOR_T1, i / n)), 0.015));
    for (let i = 0; i < n; i++) pts.push(surf(lerp(DOOR_Z0, DOOR_Z1, i / n), T(DOOR_T1), 0.015));
    for (let i = 0; i < n; i++) pts.push(surf(DOOR_Z1, T(lerp(DOOR_T1, DOOR_T0, i / n)), 0.015));
    tube(pts, 0.03, C.rubber, 96, true);
    for (const t of [DOOR_T0 - 0.05, DOOR_T1 + 0.03]) {
      const rail = [];
      for (let i = 0; i <= 8; i++) rail.push(surf(lerp(DOOR_Z1 + 0.05, DOOR_Z0 - DOOR_SLIDE - 0.05, i / 8), T(t), 0.03, 0));
      tube(rail, 0.018, "#4a4e48", 24);
    }
  }
  // Mast and swashplate (non-rotating).
  const mast = new THREE.CylinderGeometry(0.085, 0.1, MAST_Y - 2.9, 14);
  mast.translate(0, (MAST_Y + 2.9) / 2, 0);
  parts.push(tint(mast, "#4b4f50"));
  const swash = new THREE.CylinderGeometry(0.24, 0.24, 0.07, 20);
  swash.translate(0, MAST_Y - 0.42, 0);
  parts.push(tint(swash, "#3d4142"));
  const fairing = new THREE.LatheGeometry([new THREE.Vector2(0.3, 0), new THREE.Vector2(0.24, 0.1), new THREE.Vector2(0.14, 0.2)], 20);
  fairing.translate(0, 2.9, 0);
  parts.push(tint(fairing, C.moss));
  // Exhaust stack, angled up and back.
  const ex = new THREE.LatheGeometry([
    new THREE.Vector2(0.13, -0.15), new THREE.Vector2(0.15, 0.1), new THREE.Vector2(0.16, 0.3),
    new THREE.Vector2(0.135, 0.32), new THREE.Vector2(0.12, 0.12),
  ], 18);
  ex.rotateX(-HALF_PI + 0.5);
  ex.translate(0, 2.62, -3.78);
  parts.push(tint(ex, "#2a2521"));
  // Engine intake grilles on the doghouse shoulders.
  for (const sx of [1, -1]) {
    const gr = roundedBox(0.05, 0.2, 0.7, 0.02, 2);
    gr.rotateZ(sx * 0.42);
    gr.translate(sx * 0.7, 2.7, -0.2);
    parts.push(tint(gr, "#1c1e1e"));
  }
  // Tail skid.
  tube([new THREE.Vector3(0, 1.86, -8.2), new THREE.Vector3(0, 1.45, -8.75), new THREE.Vector3(0, 1.4, -9.05)], 0.03, skid, 10);
  // Antennas, pitot tubes and wire cutters.
  tube([new THREE.Vector3(0, 2.37, -5.0), new THREE.Vector3(0, 2.95, -5.55), new THREE.Vector3(0, 3.2, -5.9)], 0.012, "#2a2c2a", 8);
  tube([new THREE.Vector3(0, 0.82, 0.2), new THREE.Vector3(0, 0.45, -0.1)], 0.01, "#2a2c2a", 4);
  for (const sx of [1, -1]) {
    tube([new THREE.Vector3(0.22 * sx, 2.05, 3.5), new THREE.Vector3(0.22 * sx, 2.18, 3.72), new THREE.Vector3(0.22 * sx, 2.18, 4.1)], 0.014, "#8a8c86", 8);
  }
  const cutterTop = roundedBox(0.035, 0.5, 0.07, 0.012, 2);
  cutterTop.rotateX(0.62);
  cutterTop.translate(0, 2.62, 2.32);
  parts.push(tint(cutterTop, "#55584f"));
  const cutterLow = roundedBox(0.035, 0.42, 0.07, 0.012, 2);
  cutterLow.rotateX(-0.75);
  cutterLow.translate(0, 0.72, 3.62);
  parts.push(tint(cutterLow, "#55584f"));
  // Landing-light housing under the nose.
  const lamp = new THREE.CylinderGeometry(0.12, 0.13, 0.1, 16);
  lamp.rotateX(0.6);
  lamp.translate(0, 0.86, 3.2);
  parts.push(tint(lamp, "#2a2c2a"));
  // Rescue hoist arm above the left door.
  tube([new THREE.Vector3(1.24, 2.2, 1.08), new THREE.Vector3(1.3, 2.52, 1.08), new THREE.Vector3(1.55, 2.6, 1.08), new THREE.Vector3(1.78, 2.58, 1.08)], 0.04, "#4a4e48", 12);
  const pulley = new THREE.SphereGeometry(0.07, 10, 8);
  pulley.translate(1.78, 2.54, 1.08);
  parts.push(tint(pulley, "#2a2c2a"));
  // Tail rotor gearbox on the fin.
  const gb = new THREE.LatheGeometry([new THREE.Vector2(0.01, 0.0), new THREE.Vector2(0.14, 0.05), new THREE.Vector2(0.15, 0.22), new THREE.Vector2(0.1, 0.32)], 16);
  gb.rotateZ(-HALF_PI);
  gb.translate(0.04, TAIL_HUB.y, TAIL_HUB.z);
  parts.push(tint(gb, C.moss));
  return mergeGeometries(parts);
}

/** Cabin floor, bulkhead, troop bench, pilot seats, two pilots, instrument panel. */
function buildInterior(low) {
  const parts = [];
  const box = (w, h, d, r, color, x, y, z, rx = 0) => {
    const g = roundedBox(w, h, d, r, low ? 2 : 3);
    if (rx) g.rotateX(rx);
    g.translate(x, y, z);
    parts.push(tint(g, color));
  };
  box(2.3, 0.08, 4.35, 0.02, "#2c302a", 0, FLOOR_Y - 0.04, 0.05); // floor
  box(2.3, 1.52, 0.06, 0.02, "#3a3f36", 0, 1.62, -2.27); // aft bulkhead
  // Troop bench (rust canvas on a tube frame).
  box(2.0, 0.08, 0.46, 0.03, C.rust, 0, 1.3, -1.98);
  box(2.0, 0.56, 0.06, 0.03, C.rust, 0, 1.66, -2.2, -0.08);
  for (const x of [-0.9, 0, 0.9]) {
    const leg = new THREE.CylinderGeometry(0.02, 0.02, 0.4, 6);
    leg.translate(x, 1.08, -1.82);
    parts.push(tint(leg, "#555950"));
  }
  // Gear bags on the floor.
  const bag = (x, z, len, color) => {
    const g = new THREE.CapsuleGeometry(0.17, len, 4, 10);
    g.rotateZ(HALF_PI);
    g.translate(x, FLOOR_Y + 0.17, z);
    parts.push(tint(g, color));
  };
  bag(-0.55, -1.45, 0.55, "#4b5338");
  bag(-0.75, -1.05, 0.4, "#5b4a33");
  // Cockpit: seats, pedestal, panel + glare shield.
  for (const sx of [1, -1]) {
    box(0.5, 0.1, 0.5, 0.03, "#2e312c", sx * 0.48, 1.22, 1.95);
    box(0.5, 0.7, 0.08, 0.03, "#2e312c", sx * 0.48, 1.6, 1.68, -0.12);
  }
  box(0.32, 0.5, 0.9, 0.04, "#232623", 0, 1.15, 2.35);
  box(1.75, 0.44, 0.1, 0.03, "#1d201e", 0, 1.62, 2.88, -0.35);
  box(1.85, 0.05, 0.36, 0.02, "#151715", 0, 1.86, 2.8);
  // Pilots: flight suits, helmets with dark visors, arms forward to the controls.
  for (const sx of [1, -1]) {
    const x = sx * 0.48;
    const torso = new THREE.CapsuleGeometry(0.19, 0.38, 4, 12);
    torso.rotateX(-0.2);
    torso.translate(x, 1.62, 1.86);
    parts.push(tint(torso, "#565a43"));
    const thigh = new THREE.CapsuleGeometry(0.1, 0.36, 4, 8);
    thigh.rotateX(HALF_PI - 0.15);
    thigh.translate(x + sx * -0.1, 1.33, 2.2);
    parts.push(tint(thigh, "#565a43"));
    const thigh2 = thigh.clone();
    thigh2.translate(sx * 0.2, 0, 0);
    parts.push(thigh2);
    const helmet = new THREE.SphereGeometry(0.15, 16, 12);
    helmet.scale(1, 1.06, 1.08);
    helmet.translate(x, 2.06, 1.84);
    parts.push(tint(helmet, "#62664f"));
    const visor = new THREE.SphereGeometry(0.155, 16, 8, HALF_PI - 0.95, 1.9, 1.05, 0.75);
    visor.translate(x, 2.06, 1.85);
    parts.push(tint(visor, "#121414"));
    for (const ax of [-1, 1]) {
      const arm = new THREE.CapsuleGeometry(0.06, 0.4, 3, 8);
      arm.rotateX(HALF_PI - 0.5);
      arm.translate(x + ax * 0.2, 1.62, 2.12);
      parts.push(tint(arm, "#565a43"));
    }
  }
  return mergeGeometries(parts);
}

/** Small emissive lens geometry for the nav lights / beacons (MeshBasic, vertex colours). */
const LIGHTS = [
  { pos: [1.5, 2.04, -6.42], color: "#ff2a1c", kind: "nav" }, // port (left) — red
  { pos: [-1.5, 2.04, -6.42], color: "#22ff6a", kind: "nav" }, // starboard — green
  { pos: [0, 2.2, -9.78], color: "#fff4e0", kind: "nav" }, // tail — white
  { pos: [0, 3.1, -1.5], color: "#ff2a1c", kind: "beacon" }, // anti-collision, top
  { pos: [0, 0.74, -0.45], color: "#ff2a1c", kind: "beacon2" }, // anti-collision, belly
  { pos: [0, 0.8, 3.27], color: "#fff0d0", kind: "landing" },
];

function buildLenses() {
  const parts = LIGHTS.map((l) => {
    const g = new THREE.SphereGeometry(l.kind === "landing" ? 0.09 : 0.055, 10, 8);
    g.translate(l.pos[0], l.pos[1], l.pos[2]);
    return tint(g, l.color);
  });
  return mergeGeometries(parts);
}

function buildModel(low, shadows) {
  const { map, detail } = makeLiveryTextures(low);
  const uniforms = {
    uEnvSky: { value: new THREE.Color(0.32, 0.45, 0.62) },
    uEnvHorizon: { value: new THREE.Color(0.55, 0.6, 0.62) },
    uEnvGround: { value: new THREE.Color(0.12, 0.11, 0.08) },
    uEnvStrength: { value: 1 },
    uCabinLight: { value: 0 },
    uInterior: { value: new THREE.Color(C.interior) },
  };
  const paintMat = patchMaterial(new THREE.MeshStandardMaterial({
    map,
    bumpMap: detail,
    bumpScale: 1.4,
    roughnessMap: detail,
    roughness: 1,
    metalness: 0.08,
    side: THREE.DoubleSide,
  }), uniforms, { interior: true });
  const glassMat = patchMaterial(new THREE.MeshStandardMaterial({
    color: "#1c2a2a",
    roughness: 0.04,
    metalness: 0,
    transparent: true,
    opacity: 0.42,
    depthWrite: false,
  }), uniforms, { glass: true });
  const metalMat = patchMaterial(new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.48, metalness: 0.45 }), uniforms);
  const rotorMat = patchMaterial(new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.5, metalness: 0.3, transparent: true }), uniforms);
  const interiorMat = patchMaterial(new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.88, metalness: 0.04 }), uniforms, { env: false, cabin: true });
  const lensMat = new THREE.MeshBasicMaterial({ vertexColors: true, toneMapped: false });

  const object = new THREE.Group();
  object.name = "helicopter";

  const fuse = buildFuselage(low);
  const doors = buildDoors();
  const paintGeo = mergeGeometries([fuse.paint, doors.paint, buildDoghouse(low), buildTailSurfaces(low)]);
  const glassGeo = mergeGeometries([fuse.glass, doors.glass]);
  const body = new THREE.Mesh(paintGeo, paintMat);
  const glass = new THREE.Mesh(glassGeo, glassMat);
  glass.renderOrder = 1;
  const metal = new THREE.Mesh(buildMetal(low), metalMat);
  const interior = new THREE.Mesh(buildInterior(low), interiorMat);
  const lenses = new THREE.Mesh(buildLenses(), lensMat);
  body.castShadow = metal.castShadow = interior.castShadow = shadows;
  body.receiveShadow = interior.receiveShadow = shadows;
  object.add(body, glass, metal, interior, lenses);

  // Main rotor: spinning head + blades, and a non-rotating blur disc.
  const mainPivot = new THREE.Group();
  mainPivot.position.set(0, MAST_Y, 0);
  const mainGeo = buildMainRotor(low);
  const mainRotor = new THREE.Group(); // spins
  const mainBlades = new THREE.Mesh(mainGeo.blades, rotorMat);
  mainRotor.add(new THREE.Mesh(mainGeo.hub, metalMat), mainBlades);
  const mainDiscMat = rotorDiscMaterial({ chord: 0.53, hub: 0.35, color: "#1d1f1f", tip: "#c9a03c" });
  mainDiscMat.uniforms.uRadius.value = ROTOR_R;
  // The disc stays in its XY plane (the shader reads position.xy); the mesh is
  // laid flat so disc angle == rotor angle.
  const mainDisc = new THREE.Mesh(new THREE.CircleGeometry(ROTOR_R, low ? 48 : 72), mainDiscMat);
  mainDisc.rotation.x = -HALF_PI;
  mainDisc.renderOrder = 2;
  mainDisc.position.y = 0.03;
  mainPivot.add(mainRotor, mainDisc);
  object.add(mainPivot);

  const tailPivot = new THREE.Group();
  tailPivot.position.copy(TAIL_HUB);
  const tailGeo = buildTailRotor(low);
  const tailRotor = new THREE.Group();
  const tailBlades = new THREE.Mesh(tailGeo.blades, rotorMat);
  tailRotor.add(new THREE.Mesh(tailGeo.hub, metalMat), tailBlades);
  const tailDiscMat = rotorDiscMaterial({ chord: 0.21, hub: 0.12, color: "#3a2e2a", tip: "#d6d0bd" });
  tailDiscMat.uniforms.uRadius.value = TAIL_R;
  // In the YZ plane; disc angle = tail rotor angle + π/2 (see _effects).
  const tailDisc = new THREE.Mesh(new THREE.CircleGeometry(TAIL_R, 40), tailDiscMat);
  tailDisc.rotation.y = HALF_PI;
  tailDisc.renderOrder = 2;
  tailPivot.add(tailRotor, tailDisc);
  object.add(tailPivot);

  // Billboard glows for the lights (one instanced draw).
  const glowGeo = billboardGeometry(LIGHTS.length);
  glowGeo.instanceCount = LIGHTS.length;
  const glowMat = glowMaterial();
  const glows = new THREE.Mesh(glowGeo, glowMat);
  glows.frustumCulled = false;
  glows.renderOrder = 3;
  trackViewport(glows, glowMat.uniforms);
  const off = glowGeo.attributes.iOffset;
  LIGHTS.forEach((l, i) => off.setXYZ(i, l.pos[0], l.pos[1], l.pos[2]));
  object.add(glows);

  // Landing light mount (under the nose, angled forward-down) + volumetric cone.
  const lightMount = new THREE.Object3D();
  lightMount.position.set(0, 0.8, 3.27);
  lightMount.rotation.x = -0.95; // −Y of the mount points forward-down
  const coneGeo = new THREE.ConeGeometry(Math.tan(0.36), 1, 28, 1, true);
  coneGeo.translate(0, -0.5, 0); // apex at the origin, opening along −Y
  const cone = new THREE.Mesh(coneGeo, lightConeMaterial());
  cone.renderOrder = 3;
  cone.visible = false;
  lightMount.add(cone);
  object.add(lightMount);

  // Hoist cable for canopy pickups (hangs from the arm above the left door).
  const cableGeo = new THREE.CylinderGeometry(0.012, 0.012, 1, 6);
  cableGeo.translate(0, -0.5, 0);
  const hookGeo = mergeGeometries([
    tint(new THREE.TorusGeometry(0.09, 0.025, 8, 16), "#3d3f3c"),
    tint(new THREE.CapsuleGeometry(0.06, 0.18, 3, 8).translate(0, 0.18, 0), "#b08a2e"),
  ]);
  const cable = new THREE.Mesh(tint(cableGeo, "#2a2c2a"), metalMat);
  const hook = new THREE.Mesh(hookGeo, metalMat);
  const hoist = new THREE.Group();
  hoist.position.set(1.78, 2.48, 1.08);
  hoist.add(cable, hook);
  hoist.visible = false;
  object.add(hoist);

  // Hunter's seat in the left door: camera anchor looking out, a little forward and down.
  const anchor = new THREE.Object3D();
  anchor.name = "hunterAnchor";
  anchor.position.set(0.42, 1.52, -0.22);
  const look = new THREE.Vector3(Math.cos(0.42), 0, Math.sin(0.42)).multiplyScalar(Math.cos(0.2));
  look.y = -Math.sin(0.2);
  anchor.quaternion.setFromRotationMatrix(new THREE.Matrix4().lookAt(new THREE.Vector3(), look, new THREE.Vector3(0, 1, 0)));
  object.add(anchor);

  return {
    object,
    anchor,
    uniforms,
    map,
    detail,
    mainRotor,
    mainBlades,
    mainDisc,
    tailRotor,
    tailBlades,
    tailDisc,
    glows,
    lightMount,
    cone,
    hoist,
    cable,
    hook,
    interior,
    rotorMat,
  };
}

/* --- Rotor wash ---------------------------------------------------------------- */

/** Pooled dust / grass / spray puffs pushed out by the downwash (one instanced draw). */
class RotorWash {
  constructor(scene, capacity) {
    this.capacity = capacity;
    this.px = new Float32Array(capacity);
    this.py = new Float32Array(capacity);
    this.pz = new Float32Array(capacity);
    this.vx = new Float32Array(capacity);
    this.vy = new Float32Array(capacity);
    this.vz = new Float32Array(capacity);
    this.age = new Float32Array(capacity).fill(1e3);
    this.life = new Float32Array(capacity).fill(1);
    this.s0 = new Float32Array(capacity);
    this.s1 = new Float32Array(capacity);
    this.a0 = new Float32Array(capacity);
    this.cr = new Float32Array(capacity);
    this.cg = new Float32Array(capacity);
    this.cb = new Float32Array(capacity);
    this.next = 0;
    this.carry = 0;
    this.rng = makeRng(4207);
    this.geometry = billboardGeometry(capacity);
    this.material = dustMaterial();
    this.mesh = new THREE.Mesh(this.geometry, this.material);
    this.mesh.frustumCulled = false;
    this.mesh.renderOrder = 2;
    this.mesh.visible = false;
    this.mesh.name = "rotorWash";
    trackViewport(this.mesh, this.material.uniforms);
    scene.add(this.mesh);
  }

  /**
   * @param {number} dt
   * @param {number} amount 0..1 emission strength
   * @param {number} x centre under the rotor
   * @param {number} groundY surface height there
   * @param {number} z
   * @param {THREE.Color} color base puff colour (linear)
   * @param {boolean} water spray behaves lighter and higher
   */
  update(dt, amount, x, groundY, z, color, water) {
    const rng = this.rng;
    if (amount > 0.01 && dt > 0) {
      this.carry += amount * this.capacity * 0.5 * dt; // the pool turns over about every 2 s at full wash
      while (this.carry >= 1) {
        this.carry -= 1;
        const i = this.next;
        this.next = (this.next + 1) % this.capacity;
        const a = rng() * TAU;
        const r0 = rand(rng, 1.2, 4.5);
        const ca = Math.cos(a);
        const sa = Math.sin(a);
        this.px[i] = x + ca * r0;
        this.pz[i] = z + sa * r0;
        this.py[i] = groundY + rand(rng, 0.05, 0.5);
        const sp = rand(rng, 5, 11) * (0.55 + 0.45 * amount);
        this.vx[i] = ca * sp;
        this.vz[i] = sa * sp;
        this.vy[i] = water ? rand(rng, 1.2, 3.4) : rand(rng, 0.2, 1.5);
        this.age[i] = 0;
        this.life[i] = water ? rand(rng, 0.9, 1.7) : rand(rng, 1.3, 2.5);
        this.s0[i] = water ? rand(rng, 0.4, 0.8) : rand(rng, 0.6, 1.2);
        this.s1[i] = water ? rand(rng, 1.6, 2.8) : rand(rng, 2.6, 4.8);
        this.a0[i] = (water ? rand(rng, 0.35, 0.55) : rand(rng, 0.22, 0.42)) * (0.5 + 0.5 * amount);
        const jitter = rand(rng, 0.9, 1.1);
        this.cr[i] = color.r * jitter;
        this.cg[i] = color.g * jitter;
        this.cb[i] = color.b * jitter;
      }
    }
    const off = this.geometry.attributes.iOffset;
    const sa = this.geometry.attributes.iSizeAlpha;
    const col = this.geometry.attributes.iColor;
    const drag = Math.exp(-1.6 * dt);
    let n = 0;
    for (let i = 0; i < this.capacity; i++) {
      if (this.age[i] >= this.life[i]) continue;
      this.age[i] += dt;
      const t = this.age[i] / this.life[i];
      if (t >= 1) continue;
      this.vx[i] *= drag;
      this.vz[i] *= drag;
      this.vy[i] = this.vy[i] * drag - 0.4 * dt; // lofted, then settles
      this.px[i] += this.vx[i] * dt;
      this.py[i] += this.vy[i] * dt;
      this.pz[i] += this.vz[i] * dt;
      off.setXYZ(n, this.px[i], this.py[i], this.pz[i]);
      const fade = smoothstep(0, 0.12, t) * (1 - smoothstep(0.45, 1, t));
      sa.setXY(n, lerp(this.s0[i], this.s1[i], Math.sqrt(t)), this.a0[i] * fade);
      col.setXYZ(n, this.cr[i], this.cg[i], this.cb[i]);
      n++;
    }
    this.geometry.instanceCount = n;
    this.mesh.visible = n > 0;
    if (n > 0) {
      off.needsUpdate = true;
      sa.needsUpdate = true;
      col.needsUpdate = true;
    }
  }

  clear() {
    this.age.fill(1e3);
    this.geometry.instanceCount = 0;
    this.mesh.visible = false;
  }

  dispose() {
    this.mesh.removeFromParent();
    this.geometry.dispose();
    this.material.dispose();
  }
}

// Downwash colours by surface (sRGB).
const WASH_COLORS = {
  water: new THREE.Color("#e2ecec"),
  beach: new THREE.Color("#d2c29a"),
  plains: new THREE.Color("#b7a77c"),
  forest: new THREE.Color("#7b7456"),
  swamp: new THREE.Color("#7b7a5c"),
  highland: new THREE.Color("#a59b86"),
  rock: new THREE.Color("#9c968b"),
};

function isLowQuality(q) {
  if (!q) return false;
  if (q === "low") return true;
  if (typeof q === "object") return q.name === "low" || q.grass === false || q.shadows === false;
  return false;
}

/* --- Helicopter ---------------------------------------------------------------- */

export class Helicopter {
  /**
   * Builds the model (hidden until a flight starts) and adds it to the scene.
   * @param {THREE.Scene} scene
   * @param {object} [opts] optional world hooks — all may be null
   * @param {object} [opts.terrain] heightAt/isWater/isFreshWater/biomeAt/seaLevel/half — clearance + wash
   * @param {object} [opts.sky] daylight/skyColor/fogColor/sunColor — night lights, reflections
   * @param {object} [opts.vegetation] collidersNear — keeps the rotor clear of trees
   * @param {object} [opts.wind] Wind — hover sway leans into gusts
   * @param {object|string} [opts.quality] quality profile (or "low") — model/particle detail, shadows
   */
  constructor(scene, { terrain = null, sky = null, vegetation = null, wind = null, quality = null } = {}) {
    this.scene = scene;
    this.terrain = terrain;
    this.sky = sky;
    this.vegetation = vegetation;
    this.wind = wind;
    const low = isLowQuality(quality);
    const shadows = !(quality && typeof quality === "object" && quality.shadows === false);
    this._model = buildModel(low, shadows);
    /** THREE.Group in the scene (hidden while inactive). */
    this.object = this._model.object;
    this.object.visible = false;
    scene.add(this.object);
    /** Camera anchor in the left door (child of `object`) — ride along during the drop-off. */
    this.anchor = this._model.anchor;

    /** World position of the airframe (same Vector3 as object.position; includes hover bob). */
    this.position = this.object.position;
    /** m/s, world. */
    this.velocity = new THREE.Vector3();
    /** True while flying (audio plays the rotor loop). */
    this.active = false;
    /** "idle" | "inbound" | "approach" | "hover" | "waiting" | "departing" | "outbound" */
    this.phase = "idle";
    /** Heading (radians, 0 = +Z). */
    this.yaw = 0;
    /** Seconds until the current approach settles into its hover (0 when there / idle). */
    this.eta = 0;
    /** 0..1 rotor rpm (full while flying). */
    this.rotorSpeed = 0;
    /** Height of the skids above the ground / water below. */
    this.altitude = 0;
    /** Current hover point { x, z, hover, clearR } or null. */
    this.target = null;

    // Flight state.
    this._sea = terrain?.seaLevel ?? 0;
    this._pos = new THREE.Vector3();
    this._acc = new THREE.Vector3();
    this._ay = 0;
    this._yawRate = 0;
    this._up = new THREE.Vector3(0, 1, 0);
    this._route = [];
    this._routeIndex = 0;
    this._exit = new THREE.Vector3();
    this._exitYaw = 0;
    this._hold = new THREE.Vector3();
    this._holdYaw = 0;
    this._climbLimit = 1;
    this._settle = 0;
    this._mission = null;
    this._onDone = null;
    this._onArrive = null;
    this._onGone = null;
    this._dropped = false;
    this._time = 0;
    this._rotorAngle = 0;
    this._tailAngle = 0;
    this._colliders = [];
    this._washColor = new THREE.Color();
    this._hoverFactor = 0;

    // Lights live directly in the scene and are never removed/hidden while the
    // helicopter exists: toggling a light's presence recompiles every material.
    this.spot = new THREE.SpotLight(0xfff0d8, 0, 160, 0.38, 0.6, 2);
    this.spot.castShadow = false;
    this.spot.name = "helicopterSpot";
    scene.add(this.spot, this.spot.target);

    this._wash = new RotorWash(scene, low ? 70 : 150);
    this._ringMat = washRingMaterial();
    const ringGeo = new THREE.CircleGeometry(16, 48);
    ringGeo.rotateX(-HALF_PI);
    this._ring = new THREE.Mesh(ringGeo, this._ringMat);
    this._ring.renderOrder = 1;
    this._ring.visible = false;
    this._ring.frustumCulled = false;
    scene.add(this._ring);
  }

  /* --- Missions ------------------------------------------------------------- */

  /**
   * Fly in from offshore (~60 m), brake into a low hover over `point`, pause, call
   * `onDone` (the hunter steps out), then climb away out to sea and deactivate.
   * @param {{x:number, z:number}} point landing zone
   * @param {() => void} [onDone]
   * @param {{hover?:number, clearR?:number}} [opts] hover height (skids above ground), clear radius around the point
   */
  dropOff(point, onDone = null, opts = {}) {
    this._mission = "dropoff";
    this._onDone = onDone;
    this._onArrive = null;
    this._onGone = null;
    this._dropped = false;
    this._setTarget(point, opts);
    const coast = this._coastDirection(point.x, point.z);
    // Far enough out for a full-speed run-in and a gentle stop, whatever the coast distance.
    const entryDist = Math.max(coast.dist + 230, 650);
    this._planRun(point, coast, entryDist, Math.min(260, entryDist * 0.42));
    this.phase = "inbound";
  }

  /**
   * Come in from the nearest coast (or swing round if already airborne), settle into
   * a low hover over `point`, call `onArrive`, then wait until `depart()`.
   * @param {{x:number, z:number}} point pickup point
   * @param {() => void} [onArrive]
   * @param {{hover?:number, clearR?:number}} [opts] use a high hover + hoist over trees
   */
  pickUp(point, onArrive = null, opts = {}) {
    this._mission = "pickup";
    this._onArrive = onArrive;
    this._onDone = null;
    this._onGone = null;
    this._setTarget(point, opts);
    if (this.active && this.phase !== "idle") {
      // Still in the area (e.g. leaving the LZ): just turn back.
      this._route.length = 0;
      this._routeIndex = 0;
      this.phase = "inbound";
    } else {
      const coast = this._coastDirection(point.x, point.z);
      const entryDist = clamp(coast.dist + 200, 560, 1300);
      this._planRun(point, coast, entryDist, Math.min(240, entryDist * 0.4));
      this.phase = "inbound";
    }
    this.eta = this._estimateEta();
  }

  /**
   * Leave: climb out of the hover, turn toward the nearest coast and fly out to
   * sea; deactivates (hidden, `active = false`) once well offshore.
   * @param {() => void} [onGone]
   */
  depart(onGone = null) {
    if (!this.active) {
      onGone?.();
      return;
    }
    this._mission = null;
    this._onGone = onGone;
    this._onArrive = null;
    this._onDone = null;
    this.target = null;
    this._hold.copy(this._pos);
    const c = this._coastDirection(this._pos.x, this._pos.z);
    const d = c.dist + EXIT_PAST_COAST;
    this._exit.set(this._pos.x + c.x * d, 0, this._pos.z + c.z * d);
    this._exitYaw = Math.atan2(c.x, c.z);
    this.phase = "departing";
  }

  /** Jump an inbound flight to its short final (a skippable intro). */
  skipToFinal() {
    if (!this.active || !this.target || (this.phase !== "inbound" && this.phase !== "approach")) return;
    const t = this.target;
    const dx = this._pos.x - t.x;
    const dz = this._pos.z - t.z;
    const d = Math.hypot(dx, dz) || 1;
    const back = 70;
    const x = t.x + (dx / d) * back;
    const z = t.z + (dz / d) * back;
    this._route.length = 0;
    this._routeIndex = 0;
    const yaw = Math.atan2(-dx, -dz);
    this._spawnAt(x, z, yaw, 12, 14 + t.hover);
    this.phase = "approach";
  }

  /* --- Update -------------------------------------------------------------- */

  /**
   * Fly, animate and light the helicopter. Call every frame (cheap when idle).
   * @param {number} dt seconds
   */
  update(dt) {
    if (!this.active) {
      this.spot.intensity = 0;
      this._ring.visible = false;
      this._wash.update(dt, 0, 0, 0, 0, this._washColor, false);
      return;
    }
    if (dt <= 0) return;
    this._time += dt;
    this._fly(dt);
    if (!this.active) return; // flew off-map this frame
    this._pose(dt);
    this._effects(dt);
  }

  /** Remove from the scene and free GPU resources. */
  dispose() {
    this.active = false;
    this.object.removeFromParent();
    this.spot.removeFromParent();
    this.spot.target.removeFromParent();
    this.spot.dispose?.();
    this._ring.removeFromParent();
    this._ring.geometry.dispose();
    this._ringMat.dispose();
    this._wash.dispose();
    const mats = new Set();
    this.object.traverse((o) => {
      if (o.geometry) o.geometry.dispose();
      if (o.material) mats.add(o.material);
    });
    for (const m of mats) m.dispose();
    this._model.map.dispose();
    this._model.detail.dispose();
  }

  /* --- Internals: planning -------------------------------------------------- */

  _setTarget(point, opts) {
    this.target = {
      x: point.x,
      z: point.z,
      hover: opts.hover ?? HOVER_AGL,
      clearR: opts.clearR ?? 14,
    };
  }

  /** Offshore entry point + a dog-leg waypoint, so the run-in ends with a banked turn. */
  _planRun(point, coast, entryDist, legLen) {
    const ex = point.x + coast.x * entryDist;
    const ez = point.z + coast.z * entryDist;
    const side = Math.sin(point.x * 0.37 + point.z * 0.11) >= 0 ? 1 : -1;
    const ang = Math.atan2(coast.x, coast.z) + side * 0.62;
    const wx = point.x + Math.sin(ang) * legLen;
    const wz = point.z + Math.cos(ang) * legLen;
    this._route.length = 0;
    this._route.push({ x: wx, z: wz });
    this._routeIndex = 0;
    this._spawnAt(ex, ez, Math.atan2(wx - ex, wz - ez), CRUISE_SPEED, CRUISE_AGL);
  }

  _spawnAt(x, z, yaw, speed, agl) {
    const g = this._ground(x, z);
    this._pos.set(x, Math.max(g + agl, this._sea + agl), z);
    const floor = this._footprintFloor(x, z, yaw);
    if (this._pos.y < floor) this._pos.y = floor;
    this.yaw = yaw;
    this._yawRate = 0;
    this.velocity.set(Math.sin(yaw) * speed, 0, Math.cos(yaw) * speed);
    this._acc.set(0, 0, 0);
    this._ay = 0;
    // Start already leaning into cruise so the first frame doesn't snap.
    this._up.set(this.velocity.x * DRAG, G, this.velocity.z * DRAG).normalize();
    this._settle = 0;
    this._climbLimit = 1;
    this.active = true;
    this.rotorSpeed = 1;
    this.object.visible = true;
    this._wash.clear();
    this.altitude = this._pos.y - g;
    this.object.position.copy(this._pos);
  }

  /** Direction (unit x/z) and distance to open ocean, searching 24 bearings. */
  _coastDirection(x, z) {
    const t = this.terrain;
    let best = null;
    if (t) {
      for (let i = 0; i < 24; i++) {
        const a = (i / 24) * TAU;
        const ux = Math.sin(a);
        const uz = Math.cos(a);
        let run = 0;
        for (let r = 20; r <= 1600; r += 20) {
          if (best && r > best.dist + 60) break;
          const sx = x + ux * r;
          const sz = z + uz * r;
          const ocean = t.heightAt(sx, sz) < this._sea - 1.5 && !(t.isFreshWater && t.isFreshWater(sx, sz));
          run = ocean ? run + 1 : 0;
          if (run >= 3) {
            const dist = r - 40;
            if (!best || dist < best.dist) best = { x: ux, z: uz, dist };
            break;
          }
        }
      }
    }
    if (!best) {
      const d = Math.hypot(x, z);
      best = d > 1 ? { x: x / d, z: z / d, dist: 0 } : { x: 0, z: -1, dist: 0 };
    }
    return best;
  }

  /* --- Internals: flight ---------------------------------------------------- */

  _ground(x, z) {
    const t = this.terrain;
    return t ? Math.max(t.heightAt(x, z), this._sea) : this._sea;
  }

  _obstacle(x, z) {
    const v = this.vegetation;
    if (!v || !v.collidersNear) return false;
    this._colliders.length = 0;
    const list = v.collidersNear(x, z, OBSTACLE_R, this._colliders) || this._colliders;
    for (let i = 0; i < list.length; i++) {
      const c = list[i];
      const h = c.height ?? c.h;
      // Boulders and stumps don't reach the rotor; unknown heights count as trees.
      if (h === undefined || h > 4) return true;
    }
    return false;
  }

  /** Lowest origin height at which no part of the airframe is within its clearance of the ground. */
  _footprintFloor(x, z, yaw) {
    const cy = Math.cos(yaw);
    const sy = Math.sin(yaw);
    let floor = -Infinity;
    for (let i = 0; i < FOOTPRINT.length; i++) {
      const f = FOOTPRINT[i];
      const wx = x + f[0] * cy + f[1] * sy;
      const wz = z - f[0] * sy + f[1] * cy;
      const need = this._ground(wx, wz) - f[2] + f[3];
      if (need > floor) floor = need;
    }
    return floor;
  }

  _fly(dt) {
    const p = this._pos;
    const v = this.velocity;
    const tg = this.target;
    const phase = this.phase;
    let tx = p.x;
    let tz = p.z;
    let finalLeg = false;
    let speed = 0;

    /* Navigation: where are we steering, how fast? */
    if (phase === "inbound" || phase === "approach") {
      if (this._routeIndex < this._route.length) {
        const w = this._route[this._routeIndex];
        tx = w.x;
        tz = w.z;
        speed = CRUISE_SPEED;
        if ((tx - p.x) ** 2 + (tz - p.z) ** 2 < 75 * 75) this._routeIndex++;
      } else {
        tx = tg.x;
        tz = tg.z;
        finalLeg = true;
      }
    } else if (phase === "hover" || phase === "waiting") {
      tx = tg.x;
      tz = tg.z;
      finalLeg = true;
    } else if (phase === "departing") {
      tx = this._hold.x;
      tz = this._hold.z;
      finalLeg = true;
    } else if (phase === "outbound") {
      tx = this._exit.x;
      tz = this._exit.z;
      speed = CRUISE_SPEED;
    }
    const dx = tx - p.x;
    const dz = tz - p.z;
    const d = Math.hypot(dx, dz);
    if (finalLeg) {
      // Brake so we come to rest exactly over the point (≈ v² = 2·a·d).
      speed = Math.min(CRUISE_SPEED, Math.sqrt(2 * BRAKE * Math.max(0, d - 0.2)), d * 0.9);
    } else if (phase === "inbound" || phase === "approach") {
      // Plan the stop along the whole remaining route, so a short final leg
      // still gets a full-length deceleration (no overshoot and go-around).
      speed = Math.min(speed, Math.sqrt(2 * BRAKE * this._routeRemaining(d)));
    }
    if (phase === "inbound" && finalLeg && d < APPROACH_RANGE) this.phase = "approach";
    speed *= this._climbLimit;

    /* Horizontal: steer velocity toward the plan, accel- and jerk-limited
       separately along the flight path (pitch) and across it (bank). */
    const inv = d > 1e-4 ? 1 / d : 0;
    let ax = (dx * inv * speed - v.x) * 1.2;
    let az = (dz * inv * speed - v.z) * 1.2;
    const sp0 = Math.hypot(v.x, v.z);
    if (sp0 > 1.5) {
      const ux = v.x / sp0;
      const uz = v.z / sp0;
      const along = clamp(ax * ux + az * uz, -LONG_ACCEL, LONG_ACCEL);
      const across = clamp(-ax * uz + az * ux, -TURN_ACCEL, TURN_ACCEL);
      ax = along * ux - across * uz;
      az = along * uz + across * ux;
    } else {
      const al = Math.hypot(ax, az);
      if (al > LONG_ACCEL) {
        ax *= LONG_ACCEL / al;
        az *= LONG_ACCEL / al;
      }
    }
    const jerk = 1 - Math.exp(-3.2 * dt);
    this._acc.x += (ax - this._acc.x) * jerk;
    this._acc.z += (az - this._acc.z) * jerk;
    v.x += this._acc.x * dt;
    v.z += this._acc.z * dt;
    p.x += v.x * dt;
    p.z += v.z * dt;
    const sp = Math.hypot(v.x, v.z);

    /* Vertical: phase altitude profile, terrain/tree look-ahead, hard floor. */
    const g0 = this._ground(p.x, p.z);
    const dT = tg ? Math.hypot(tg.x - p.x, tg.z - p.z) : Infinity;
    let profile = CRUISE_AGL;
    if ((phase === "inbound" || phase === "approach") && tg) {
      profile = lerp(tg.hover, CRUISE_AGL, smoothstep(tg.clearR, tg.clearR + 260, dT));
    } else if (phase === "hover" || phase === "waiting") profile = tg.hover;
    else if (phase === "departing") profile = DEPART_AGL;

    let floor = -Infinity;
    if (phase !== "hover" && phase !== "waiting") {
      const ux = sp > 0.5 ? v.x / sp : 0;
      const uz = sp > 0.5 ? v.z / sp : 0;
      let look = sp * 7 + 12;
      if (finalLeg && phase !== "departing") look = Math.min(look, d + 6);
      for (let k = 0; k <= LOOK_STEPS; k++) {
        const L = (look * k) / LOOK_STEPS;
        const sx = p.x + ux * L;
        const sz = p.z + uz * L;
        let clr = MIN_TRANSIT_AGL;
        if (tg) clr = lerp(tg.hover, MIN_TRANSIT_AGL, smoothstep(tg.clearR * 0.5, tg.clearR + 60, Math.hypot(sx - tg.x, sz - tg.z)));
        if (clr < OBSTACLE_AGL && this._obstacle(sx, sz)) clr = OBSTACLE_AGL;
        const need = this._ground(sx, sz) + clr;
        if (need > floor) floor = need;
      }
    }
    const desiredY = Math.max(g0 + profile, floor);
    // Terrain rising faster than we can climb: slow down instead of popping up.
    this._climbLimit = clamp(1 - (floor - p.y - 8) / 45, 0.25, 1);
    const vyCmd = clamp((desiredY - p.y) * 0.8, -DESCENT_RATE, CLIMB_RATE);
    const dv = clamp(vyCmd - v.y, -VERT_ACCEL * dt, VERT_ACCEL * dt);
    this._ay = dv / dt;
    v.y += dv;
    p.y += v.y * dt;
    const hard = this._footprintFloor(p.x, p.z, this.yaw);
    if (p.y < hard) {
      p.y = hard;
      if (v.y < 0) v.y = 0;
    }
    this.altitude = p.y - g0;

    /* Heading: nose into the direction of travel, hold it in the hover. */
    let desiredYaw = this.yaw;
    if (phase === "hover" || phase === "waiting") desiredYaw = this._holdYaw;
    else if (phase === "departing") desiredYaw = this._exitYaw;
    else if (sp > 6) desiredYaw = Math.atan2(v.x, v.z);
    else if (d > 4) desiredYaw = Math.atan2(dx, dz);
    const err = angleDiff(this.yaw, desiredYaw);
    this._yawRate = damp(this._yawRate, clamp(err * 1.4, -YAW_RATE, YAW_RATE), 3, dt);
    this.yaw = wrapAngle(this.yaw + this._yawRate * dt);

    /* Phase transitions. */
    if (phase === "approach" && tg) {
      const settled = dT < 1.2 && sp < 0.7 && Math.abs(this.altitude - tg.hover) < 0.5 && Math.abs(v.y) < 0.5;
      this._settle = settled ? this._settle + dt : 0;
      if (this._settle > 0.35) {
        this._holdYaw = this.yaw;
        this._settle = 0;
        if (this._mission === "dropoff") this.phase = "hover";
        else {
          this.phase = "waiting";
          const cb = this._onArrive;
          this._onArrive = null;
          cb?.();
        }
      }
    } else if (phase === "hover") {
      this._settle += dt;
      if (!this._dropped && this._settle >= DROP_HOLD) {
        this._dropped = true;
        const cb = this._onDone;
        this._onDone = null;
        cb?.();
      }
      if (this._settle >= DROP_LEAVE && this.phase === "hover") this.depart(this._onGone);
    } else if (phase === "departing") {
      const minAgl = Math.max(DEPART_AGL - 1, floor - g0 - 1);
      if (this.altitude >= minAgl && Math.abs(angleDiff(this.yaw, this._exitYaw)) < 0.35) this.phase = "outbound";
    } else if (phase === "outbound") {
      if (d < 80) {
        this.active = false;
        this.phase = "idle";
        this.object.visible = false;
        this.rotorSpeed = 0;
        this.eta = 0;
        this.spot.intensity = 0;
        this._ring.visible = false;
        const cb = this._onGone;
        this._onGone = null;
        cb?.();
        return;
      }
    }

    const est = this._estimateEta();
    this.eta = est <= 0 ? 0 : damp(this.eta, est, 2, dt);
  }

  /** Path length still to fly: `dToNext` to the current waypoint, then the rest of the route. */
  _routeRemaining(dToNext) {
    const tg = this.target;
    let rem = dToNext;
    if (!tg) return rem;
    let cx = this._route[this._routeIndex]?.x ?? tg.x;
    let cz = this._route[this._routeIndex]?.z ?? tg.z;
    for (let i = this._routeIndex + 1; i < this._route.length; i++) {
      const w = this._route[i];
      rem += Math.hypot(w.x - cx, w.z - cz);
      cx = w.x;
      cz = w.z;
    }
    if (this._routeIndex < this._route.length) rem += Math.hypot(tg.x - cx, tg.z - cz);
    return rem;
  }

  _estimateEta() {
    const tg = this.target;
    if (!tg || (this.phase !== "inbound" && this.phase !== "approach")) return 0;
    const p = this._pos;
    const next = this._route[this._routeIndex] ?? tg;
    const rem = this._routeRemaining(Math.hypot(next.x - p.x, next.z - p.z));
    const brakeDist = (CRUISE_SPEED * CRUISE_SPEED) / (2 * BRAKE);
    const travel = rem > brakeDist ? rem / CRUISE_SPEED + CRUISE_SPEED / (2 * BRAKE) : Math.sqrt((2 * rem) / BRAKE);
    const drop = Math.max(0, this.altitude - tg.hover);
    return travel + Math.max(0, drop - rem * 0.2) / DESCENT_RATE + 1.2;
  }

  /* --- Internals: attitude & effects ---------------------------------------- */

  _pose(dt) {
    const v = this.velocity;
    const sp = Math.hypot(v.x, v.z);
    const hf = (this._hoverFactor = 1 - smoothstep(2, 9, sp));
    // Rotor thrust = the specific force the airframe needs: accel + drag + gravity.
    let fx = this._acc.x + v.x * DRAG;
    let fz = this._acc.z + v.z * DRAG;
    const fy = G + this._ay;
    const w = this.wind;
    if (w && w.vector) {
      // Holding a hover in wind means leaning into it.
      const lean = (0.15 + w.strength * 0.5) * 0.6 * hf;
      fx -= w.vector.x * lean;
      fz -= w.vector.z * lean;
    }
    const h = Math.hypot(fx, fz);
    const maxH = fy * Math.tan(MAX_TILT);
    if (h > maxH) {
      fx *= maxH / h;
      fz *= maxH / h;
    }
    _thrust.set(fx, fy, fz).normalize();
    this._up.lerp(_thrust, 1 - Math.exp(-5 * dt)).normalize();
    const up = this._up;
    _v1.set(Math.sin(this.yaw), 0, Math.cos(this.yaw));
    _zAxis.copy(_v1).addScaledVector(up, -_v1.dot(up)).normalize();
    _xAxis.crossVectors(up, _zAxis);
    _m4.makeBasis(_xAxis, up, _zAxis);
    const o = this.object;
    o.quaternion.setFromRotationMatrix(_m4);
    // A hovering helicopter is never perfectly still.
    const t = this._time;
    const gust = w ? w.gust ?? 0 : 0;
    _e.set(
      hf * (0.012 * Math.sin(t * 0.83) + 0.006 * Math.sin(t * 2.1 + 1.3)),
      0,
      hf * (0.016 * Math.sin(t * 1.07 + 0.4) + 0.008 * Math.sin(t * 2.6) + gust * 0.04 * Math.sin(t * 3.1)),
    );
    _q.setFromEuler(_e);
    o.quaternion.multiply(_q);
    let bx = hf * (0.16 * Math.sin(t * 0.37) + 0.05 * Math.sin(t * 1.3));
    let bz = hf * (0.16 * Math.sin(t * 0.29 + 1.0) + 0.05 * Math.sin(t * 1.1 + 2.0));
    if (w && w.vector) {
      bx += w.vector.x * gust * 0.5 * hf;
      bz += w.vector.z * gust * 0.5 * hf;
    }
    const by = hf * (0.1 * Math.sin(t * 1.6) + 0.045 * Math.sin(t * 2.7 + 0.5));
    o.position.set(this._pos.x + bx, this._pos.y + by, this._pos.z + bz);
    o.updateMatrixWorld(true);
  }

  _effects(dt) {
    const m = this._model;
    const sky = this.sky;
    const p = this.object.position;

    /* Rotors */
    const step = ROTOR_OMEGA * this.rotorSpeed * dt;
    this._rotorAngle = (this._rotorAngle + step) % TAU;
    this._tailAngle = (this._tailAngle + TAIL_OMEGA * this.rotorSpeed * dt) % TAU;
    m.mainRotor.rotation.y = this._rotorAngle;
    m.tailRotor.rotation.x = this._tailAngle;
    const blur = smoothstep(0.3, 0.85, this.rotorSpeed);
    m.mainBlades.visible = blur < 0.97;
    m.tailBlades.visible = blur < 0.97;
    m.rotorMat.opacity = 1 - blur * 0.8;
    const mu = m.mainDisc.material.uniforms;
    mu.uAngle.value = this._rotorAngle;
    mu.uSweep.value = clamp(step, 0.25, 1.4);
    mu.uOpacity.value = blur;
    const tu = m.tailDisc.material.uniforms;
    tu.uAngle.value = this._tailAngle + HALF_PI;
    tu.uSweep.value = clamp(TAIL_OMEGA * dt, 0.3, 1.6);
    tu.uOpacity.value = blur * 0.75;
    m.mainDisc.visible = m.tailDisc.visible = blur > 0.01;

    /* Sky-driven light levels */
    const daylight = sky ? sky.daylight ?? 1 : 1;
    const night = 1 - smoothstep(0.12, 0.45, daylight);
    const u = m.uniforms;
    if (sky) {
      if (sky.skyColor) u.uEnvSky.value.copy(sky.skyColor);
      if (sky.fogColor) u.uEnvHorizon.value.copy(sky.fogColor);
      if (sky.hemiLight) u.uEnvGround.value.copy(sky.hemiLight.groundColor).multiplyScalar(0.6 * (sky.hemiLight.intensity ?? 1));
    }
    // A little fill by day (the cabin is in the roof's shadow), warm cabin light at night.
    u.uCabinLight.value = 0.07 + night * 0.4;
    const lightLevel = lerp(0.12, 1, daylight);
    _col.setRGB(lightLevel, lightLevel * 0.98, lightLevel * 0.95);
    mu.uLight.value.copy(_col);
    tu.uLight.value.copy(_col);

    /* Nav lights, strobes, landing light */
    const sa = m.glows.geometry.attributes.iSizeAlpha;
    const col = m.glows.geometry.attributes.iColor;
    const t = this._time;
    const strobe = (phase) => {
      const c = (t + phase) % 1.1;
      return c < 0.09 ? 1 : c < 0.16 ? 0.3 : 0;
    };
    for (let i = 0; i < LIGHTS.length; i++) {
      const L = LIGHTS[i];
      let size = 0.75;
      let alpha = lerp(0.45, 1, night);
      if (L.kind === "beacon") {
        alpha = strobe(0);
        size = 1.3;
      } else if (L.kind === "beacon2") {
        alpha = strobe(0.55);
        size = 1.3;
      } else if (L.kind === "landing") {
        alpha = night;
        size = 0.9;
      }
      _col.set(L.color);
      sa.setXY(i, size, alpha);
      col.setXYZ(i, _col.r * 2.2, _col.g * 2.2, _col.b * 2.2);
    }
    sa.needsUpdate = true;
    col.needsUpdate = true;

    // Spot: follow the nose mount; steeper while hovering so it pools on the LZ.
    const lm = m.lightMount;
    lm.rotation.x = lerp(-0.95, -0.35, this._hoverFactor);
    lm.updateMatrixWorld(true);
    lm.getWorldPosition(_v2);
    _v3.set(0, -1, 0).transformDirection(lm.matrixWorld);
    this.spot.position.copy(_v2);
    this.spot.target.position.copy(_v2).addScaledVector(_v3, 20);
    this.spot.target.updateMatrixWorld();
    this.spot.intensity = night * 2600;
    // Volumetric cone, trimmed where the beam meets the ground.
    m.cone.visible = night > 0.02;
    if (m.cone.visible) {
      let hit = 140;
      for (let s = 3; s <= 140; s += 3) {
        if (_v2.y + _v3.y * s <= this._ground(_v2.x + _v3.x * s, _v2.z + _v3.z * s)) {
          hit = s;
          break;
        }
      }
      m.cone.scale.setScalar(hit);
      m.cone.material.uniforms.uOpacity.value = night * 0.22;
    }

    /* Hoist line when hovering high over trees */
    const tg = this.target;
    const hoistOn = (this.phase === "waiting" || this.phase === "approach") && tg && tg.hover > 6 && this.altitude > 6;
    m.hoist.visible = !!hoistOn;
    if (hoistOn) {
      const len = clamp(this.altitude + 2.4 - 1.2, 0.5, 60);
      m.cable.scale.set(1, len, 1);
      m.hook.position.y = -len;
    }

    /* Rotor wash */
    const g0 = this._ground(p.x, p.z);
    const agl = p.y - g0;
    const amount = this.rotorSpeed * (1 - smoothstep(4, 22, agl));
    const water = this.terrain ? this.terrain.heightAt(p.x, p.z) < this._sea - 0.15 : true;
    let base = WASH_COLORS.plains;
    if (water) base = WASH_COLORS.water;
    else if (amount > 0.01 && this.terrain?.biomeAt) base = WASH_COLORS[this.terrain.biomeAt(p.x, p.z)] || WASH_COLORS.plains;
    this._washColor.copy(base);
    const wl = this._wash.material.uniforms.uLight.value;
    const spotBoost = night * 0.25;
    wl.setRGB(lightLevel + spotBoost, lightLevel * 0.98 + spotBoost * 0.92, lightLevel * 0.95 + spotBoost * 0.8);
    this._wash.update(dt, amount, p.x, g0, p.z, this._washColor, water);

    const ringOn = water && amount > 0.02;
    this._ring.visible = ringOn;
    if (ringOn) {
      this._ring.position.set(p.x, this._sea + 0.22, p.z);
      this._ringMat.uniforms.uTime.value = t;
      this._ringMat.uniforms.uAmount.value = amount;
      this._ringMat.uniforms.uLight.value.copy(wl);
    }
  }
}
