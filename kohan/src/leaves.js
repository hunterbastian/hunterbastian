// Leaves that fall from the canopy, drift on the wind, and either rest on the
// ground or float on the cove until they fade.

import { mulberry32, v3 } from "./math.js";

const TONES = [
  [0.65, 0.38, 0.17],
  [0.5, 0.3, 0.18],
  [0.74, 0.47, 0.22],
  [0.42, 0.25, 0.17],
];

export class Leaves {
  constructor(world, count) {
    this.terrain = world.terrain;
    this.spots = world.spots;
    this.wind = world.windDir;
    this.n = count;
    this.rng = mulberry32(77);
    this.items = [];
    this.pos = new Float32Array(count * 12);
    this.nrm = new Float32Array(count * 12);
    this.col = new Float32Array(count * 12);
    this.ext = new Float32Array(count * 16);
    this.idx = new Uint32Array(count * 6);
    for (let i = 0; i < count; i++) {
      const b = i * 4;
      this.idx.set([b, b + 1, b + 2, b, b + 2, b + 3], i * 6);
      const L = { tone: TONES[i % TONES.length], seed: this.rng() };
      this.items.push(L);
      if (i < count * 0.4) this.float(L, true);
      else {
        this.fall(L);
        L.y -= this.rng() * 10;
      }
    }
  }

  fall(L) {
    const r = this.rng;
    const s = this.spots[Math.floor(r() * this.spots.length)];
    L.x = s[0] + (r() - 0.5);
    L.y = s[1] - 0.3;
    L.z = s[2] + (r() - 0.5);
    L.mode = 0;
    L.t = 0;
    L.delay = r() * 6;
    L.size = 0.09 + r() * 0.06;
    L.spin = [0.8 + r() * 2.2, 0.4 + r() * 1.2];
    L.ph = r() * 6.28;
  }

  float(L, initial) {
    const r = this.rng;
    for (let k = 0; k < 40; k++) {
      const a = r() * Math.PI * 2;
      const d = 4 + r() * 26;
      const x = Math.cos(a) * d, z = Math.sin(a) * d;
      const g = this.terrain.heightAt(x, z);
      if (g < -0.05 && g > -3.5) {
        L.x = x;
        L.z = z;
        break;
      }
    }
    L.y = 0.012;
    L.mode = 1;
    L.t = initial ? r() * 30 : 0;
    L.delay = 0;
    L.size = 0.1 + r() * 0.06;
    L.ph = r() * 6.28;
    L.spin = [0.05 + r() * 0.1, 0];
  }

  update(dt, windAmt) {
    const w = this.wind;
    for (const L of this.items) {
      if (L.delay > 0) {
        L.delay -= dt;
        continue;
      }
      L.t += dt;
      if (L.mode === 0) {
        const gust = 0.7 + 0.6 * Math.sin(L.t * 1.3 + L.ph);
        const flutter = Math.sin(L.t * 2.4 + L.ph) * 0.6;
        const k = (0.6 + windAmt * 1.6) * gust;
        L.x += (w[0] * k - w[2] * flutter) * dt;
        L.z += (w[2] * k + w[0] * flutter) * dt;
        L.y -= (0.65 + 0.35 * Math.sin(L.t * 3.1 + L.ph)) * dt;
        const g = this.terrain.heightAt(L.x, L.z);
        if (L.y <= Math.max(g, 0) + 0.02) {
          if (g < 0) {
            L.mode = 1;
            L.y = 0.012;
          } else {
            L.mode = 2;
            L.y = g + 0.03;
          }
          L.t = 0;
        }
      } else if (L.mode === 1) {
        const k = 0.07 + windAmt * 0.12;
        const nx = L.x + w[0] * k * dt, nz = L.z + w[2] * k * dt;
        if (this.terrain.heightAt(nx, nz) < -0.02) {
          L.x = nx;
          L.z = nz;
        }
        if (L.t > 40) this.fall(L);
      } else if (L.t > 18) {
        this.fall(L);
      }
    }
  }

  write() {
    const { pos, nrm, col, ext } = this;
    this.items.forEach((L, i) => {
      let n, t1;
      const life = L.mode === 1 ? Math.min(1, (40 - L.t) / 4) : L.mode === 2 ? Math.min(1, (18 - L.t) / 3) : 1;
      const s = L.delay > 0 ? 0 : L.size * Math.max(life, 0);
      if (L.mode === 0) {
        const a = L.t * L.spin[0] + L.ph, b = L.t * L.spin[1];
        n = v3.norm([Math.sin(a) * Math.cos(b), 0.5 + Math.cos(a), Math.sin(a) * Math.sin(b)]);
        t1 = v3.norm(v3.cross(n, [Math.cos(b), 0.1, Math.sin(b)]));
      } else {
        const a = L.ph + L.t * L.spin[0];
        n = [0, 1, 0];
        t1 = [Math.cos(a), 0, Math.sin(a)];
      }
      const t2 = v3.cross(n, t1);
      const c = [L.x, L.y, L.z];
      const corners = [
        [-1, -1, 0, 0],
        [1, -1, 1, 0],
        [1, 1, 1, 1],
        [-1, 1, 0, 1],
      ];
      corners.forEach(([u, v, cu, cv], k) => {
        const o = (i * 4 + k) * 3;
        pos[o] = c[0] + (t1[0] * u * 0.6 + t2[0] * v) * s;
        pos[o + 1] = c[1] + (t1[1] * u * 0.6 + t2[1] * v) * s;
        pos[o + 2] = c[2] + (t1[2] * u * 0.6 + t2[2] * v) * s;
        nrm[o] = n[0];
        nrm[o + 1] = n[1];
        nrm[o + 2] = n[2];
        col[o] = L.tone[0];
        col[o + 1] = L.tone[1];
        col[o + 2] = L.tone[2];
        const e = (i * 4 + k) * 4;
        ext[e] = cu;
        ext[e + 1] = cv;
        ext[e + 2] = L.seed;
        ext[e + 3] = 2;
      });
    });
  }

  arrays() {
    this.write();
    return { pos: this.pos, nrm: this.nrm, col: this.col, ext: this.ext, idx: this.idx };
  }
}

