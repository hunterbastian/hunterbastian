// Vertical relief carved into the island after the base heights are built:
// a cliff-sided bluff with a trail cut into its flank, a waterfall that drops
// off the face looking at the tree into a plunge pool, the creek ravine that
// drains it to the cove, and a crag on the lantern islet.

import { clamp, lerp, smoothstep, vnoise, fbm } from "./math.js";

export const BLUFF = { x: 48, z: 62, rx: 18, rz: 14, H: 26, W: 10 };
const TAU = Math.PI * 2;
const TRAIL_HALF = 1.7;

// Outline of the bluff top: an ellipse with a ragged, buttressed edge.
export const ellipseR = (phi) => {
  const c = Math.cos(phi) / BLUFF.rx, s = Math.sin(phi) / BLUFF.rz;
  const rag = 1 + 0.07 * Math.sin(3 * phi + 1.3) + 0.045 * Math.sin(5 * phi + 0.4) + 0.025 * Math.sin(11 * phi + 2.1);
  return rag / Math.sqrt(c * c + s * s);
};
// The face that looks back at the tree gets the waterfall and no trail.
export const PHI_FALL = Math.atan2(-BLUFF.z, -BLUFF.x);
const GAP = 0.8;
const PHI0 = PHI_FALL + GAP;
const PHI1 = PHI_FALL + TAU - GAP;

const angDiff = (a, b) => {
  let d = (a - b) % TAU;
  if (d > Math.PI) d -= TAU;
  if (d < -Math.PI) d += TAU;
  return d;
};

function segParam(px, pz, ax, az, bx, bz) {
  const pax = px - ax, paz = pz - az, bax = bx - ax, baz = bz - az;
  const t = clamp((pax * bax + paz * baz) / (bax * bax + baz * baz || 1), 0, 1);
  return { d: Math.hypot(pax - bax * t, paz - baz * t), t };
}

// Distance to a polyline of {x, z, y} points, with y interpolated at the closest point.
function nearest(px, pz, pts) {
  let best = { d: Infinity, y: 0, i: 0 };
  for (let i = 0; i < pts.length - 1; i++) {
    const a = pts[i], b = pts[i + 1];
    const s = segParam(px, pz, a.x, a.z, b.x, b.z);
    if (s.d < best.d) best = { d: s.d, y: lerp(a.y, b.y, s.t), i: i + s.t };
  }
  return best;
}

function trailPoint(phi) {
  const t = (phi - PHI0) / (PHI1 - PHI0);
  const r = ellipseR(phi) + BLUFF.W * (1 - t);
  return { x: BLUFF.x + Math.cos(phi) * r, z: BLUFF.z + Math.sin(phi) * r, y: BLUFF.H * t };
}

export function applyRelief(T, islet) {
  const { n, step, x0, z0, h, mask } = T;
  const base = h.slice();
  const W = BLUFF.W;

  const trail = [];
  for (let i = 0; i <= 180; i++) trail.push(trailPoint(lerp(PHI0, PHI1, i / 180)));

  const fd = [Math.cos(PHI_FALL), Math.sin(PHI_FALL)];
  const reF = ellipseR(PHI_FALL);
  const at = (r) => [BLUFF.x + fd[0] * r, BLUFF.z + fd[1] * r];
  const spring = at(reF - 11);
  const lip = at(reF - 0.2);
  const pool = at(reF + W + 4.5);
  const creek = [
    { x: pool[0], z: pool[1], y: 0 },
    { x: 22, z: 37, y: 0 },
    { x: 14, z: 35.5, y: 0 },
    { x: 6, z: 35, y: 0 },
    { x: -3, z: 35, y: 0 },
  ];

  // a ramp climbing out of the plunge pool toward the trailhead
  const rampA = [pool[0] + 4.2, pool[1] - 0.6];
  const rampB = [pool[0] + 14, pool[1] - 7.5];
  const baseAt = (x, z) => base[Math.round((z - z0) / step) * n + Math.round((x - x0) / step)];
  const rampTop = baseAt(rampB[0], rampB[1]);

  for (let j = 0; j < n; j++) {
    for (let i = 0; i < n; i++) {
      const k = j * n + i;
      const x = x0 + i * step, z = z0 + j * step;
      const b = base[k];
      let y = b;
      let path = 0, cliff = 0;

      const dx = x - BLUFF.x, dz = z - BLUFF.z;
      const r = Math.hypot(dx, dz);
      if (r < 60) {
        const phi = Math.atan2(dz, dx);
        const s = r - ellipseR(phi);
        const t = clamp(s / W, 0, 1);
        let p = 1 - t;
        p = p * 0.8 + smoothstep(0, 1, p) * 0.2;
        if (p > 0) {
          const top = s < 0 ? fbm(x * 0.06, z * 0.06, 3, 81) * 1.4 * smoothstep(0, -4, s) : 0;
          let rock = 0;
          if (s > 0 && s < W) {
            const quiet = smoothstep(0.1, 0.3, Math.abs(angDiff(phi, PHI_FALL)));
            rock = (vnoise(x * 0.33, z * 0.33, 82) - 0.5) * 2.6 * Math.sin(t * Math.PI) * quiet;
          }
          y = b + BLUFF.H * p + top + rock;
          cliff = smoothstep(-0.6, 0.4, s) * (1 - smoothstep(W - 0.5, W + 0.8, s));
        }
        if (s < W + 4) {
          const nr = nearest(x, z, trail);
          if (nr.d < TRAIL_HALF + 1.1) {
            const kk = 1 - smoothstep(TRAIL_HALF, TRAIL_HALF + 1.1, nr.d);
            y = lerp(y, b + nr.y, kk);
            path = Math.max(path, kk);
            cliff *= 1 - kk;
          }
        }
        const ch = segParam(x, z, spring[0], spring[1], lip[0] + fd[0] * 1.5, lip[1] + fd[1] * 1.5);
        if (ch.d < 1.9) y -= 0.75 * (1 - smoothstep(0.7, 1.9, ch.d));
      }

      const dp = Math.hypot(x - pool[0], z - pool[1]);
      if (dp < 11) y = Math.min(y, lerp(-1.25, y, smoothstep(3.5, 10, dp)));
      const cr = nearest(x, z, creek);
      if (cr.d < 8) y = Math.min(y, lerp(-0.5, y, smoothstep(1.8, 7.2, cr.d)));

      const rp = segParam(x, z, rampA[0], rampA[1], rampB[0], rampB[1]);
      if (rp.d < 2.8) {
        const kk = 1 - smoothstep(1.4, 2.8, rp.d);
        y = lerp(y, lerp(0.15, rampTop, rp.t), kk);
        path = Math.max(path, kk * smoothstep(0.05, 0.2, rp.t));
      }

      const di = Math.hypot(x - islet[0], z - islet[1]);
      if (di < 5) y += 4.2 * (1 - smoothstep(2.4, 4.4, di));

      h[k] = y;
      mask[k * 3] = path;
      mask[k * 3 + 1] = cliff;
    }
  }

  return { trail, spring, lip, pool, creek, fallDir: fd };
}
