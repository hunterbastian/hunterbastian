// Procedural skin: paints a small canvas texture from three colours and a
// pattern, mirrored across the back so creatures stay bilaterally symmetric.
// The bottom strip of the texture is a gradient used by legs and arms.

import * as THREE from './three.js';
import { makeRng, mixHex } from './util.js';

export const PATTERNS = ['plain', 'stripes', 'spots', 'bands', 'dapple', 'saddle'];

export const TEX_W = 256;
export const TEX_H = 288;
const BODY_H = 256;
export const V_BODY = 255.5 / TEX_H; // body uses v in [0, V_BODY]
export const V_LIMB0 = 260 / TEX_H; // limb strip start (hip)
export const V_LIMB1 = 285 / TEX_H; // limb strip end (ankle / wrist)

const FIXED = {
  bone: '#efe6d0',
  horn: '#d8c7a0',
  dark: '#3b2024',
  white: '#f8f5ee',
  pupil: '#15151a',
  pink: '#d77b8c',
  nose: '#2b2326',
  amber: '#e8c95a',
};

export function paintSkin(canvas, skin, seed = 1) {
  const ctx = canvas.getContext('2d');
  const W = TEX_W;
  const H = BODY_H;
  const HW = W / 2;
  const rnd = makeRng(seed);

  ctx.globalAlpha = 1;
  ctx.fillStyle = skin.base;
  ctx.fillRect(0, 0, W, TEX_H);

  // Pattern is drawn on one half (x = HW is the spine, x = 0 the belly seam)
  // and mirrored.
  const half = document.createElement('canvas');
  half.width = HW;
  half.height = H;
  const h = half.getContext('2d');
  h.fillStyle = skin.accent;
  h.globalAlpha = 0.92;

  switch (skin.pattern) {
    case 'stripes': {
      let y = rnd.range(4, 14);
      while (y < H) {
        const th = rnd.range(5, 10);
        const reach = HW * rnd.range(0.25, 0.55);
        const sag = rnd.range(-8, 8);
        h.beginPath();
        h.moveTo(HW, y - th / 2);
        h.quadraticCurveTo((HW + reach) / 2, y + sag - th / 2, reach, y + sag);
        h.quadraticCurveTo((HW + reach) / 2, y + sag + th / 2, HW, y + th / 2);
        h.fill();
        y += rnd.range(15, 27);
      }
      break;
    }
    case 'spots': {
      for (let i = 0; i < 20; i++) {
        h.beginPath();
        h.ellipse(rnd.range(38, HW + 6), rnd.range(0, H), rnd.range(5, 13), rnd.range(5, 13), rnd.range(0, 3), 0, Math.PI * 2);
        h.fill();
      }
      break;
    }
    case 'bands': {
      let y = rnd.range(0, 16);
      while (y < H) {
        const bw = rnd.range(11, 22);
        h.fillRect(0, y, HW, bw);
        y += bw + rnd.range(14, 28);
      }
      break;
    }
    case 'dapple': {
      for (let i = 0; i < 90; i++) {
        const off = Math.abs(rnd() + rnd() - 1) * 80;
        h.beginPath();
        h.arc(HW - off, rnd.range(0, H), rnd.range(1.5, 4.2), 0, Math.PI * 2);
        h.fill();
      }
      break;
    }
    case 'saddle': {
      h.beginPath();
      h.moveTo(HW, H * 0.12);
      for (let y = H * 0.12; y <= H * 0.82; y += 12) {
        const w = 34 + Math.sin(y * 0.09 + seed) * 12 + rnd.range(-5, 5);
        h.lineTo(HW - w, y);
      }
      h.lineTo(HW, H * 0.82);
      h.fill();
      h.globalAlpha = 0.6;
      h.fillRect(0, 0, HW, H * 0.07);
      h.fillRect(0, H * 0.93, HW, H * 0.07);
      break;
    }
    default:
      break;
  }

  ctx.drawImage(half, 0, 0);
  ctx.save();
  ctx.translate(W, 0);
  ctx.scale(-1, 1);
  ctx.drawImage(half, 0, 0);
  ctx.restore();

  // Soft belly along the ventral seam (both texture edges).
  const g = ctx.createLinearGradient(0, 0, W, 0);
  g.addColorStop(0, skin.belly);
  g.addColorStop(0.2, skin.belly + '00');
  g.addColorStop(0.8, skin.belly + '00');
  g.addColorStop(1, skin.belly);
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, W, H);

  // Fine speckle so flat colours don't read as plastic.
  for (let i = 0; i < 520; i++) {
    ctx.fillStyle = rnd() < 0.5 ? 'rgba(255,255,255,0.06)' : 'rgba(0,0,0,0.06)';
    ctx.fillRect(rnd() * W, rnd() * H, 2, 2);
  }

  // Limb strip: skin colour at the hip, darker "socks" toward the ankle.
  const lg = ctx.createLinearGradient(0, BODY_H + 2, 0, TEX_H);
  lg.addColorStop(0, skin.base);
  lg.addColorStop(1, mixHex(skin.base, skin.accent, 0.55));
  ctx.fillStyle = lg;
  ctx.fillRect(0, BODY_H, W, TEX_H - BODY_H);
}

let sharedPartMat = null;
export function partMaterial() {
  if (!sharedPartMat) {
    sharedPartMat = new THREE.MeshStandardMaterial({
      vertexColors: true,
      roughness: 0.62,
      metalness: 0,
      side: THREE.DoubleSide,
    });
  }
  return sharedPartMat;
}

// A "kit" is everything visual that members of one species share: the skin
// texture, resolved colours and a cache of part geometry with colours baked.
export function makeKit(skin, seed = 1) {
  const canvas = document.createElement('canvas');
  canvas.width = TEX_W;
  canvas.height = TEX_H;
  const tex = new THREE.CanvasTexture(canvas);
  tex.flipY = false;
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.wrapS = THREE.RepeatWrapping;
  tex.anisotropy = 4;
  const kit = {
    skin: null,
    seed,
    canvas,
    tex,
    colors: {},
    geo: new Map(),
    glowMat: new THREE.MeshBasicMaterial({ color: 0xffffff }),
    repaint(next) {
      this.skin = { ...next };
      paintSkin(canvas, this.skin, seed);
      tex.needsUpdate = true;
      const glowHex = this.skin.glow || mixHex(this.skin.accent, '#ffffff', 0.45);
      const table = {
        ...FIXED,
        base: this.skin.base,
        accent: this.skin.accent,
        belly: this.skin.belly,
        sock: mixHex(this.skin.base, this.skin.accent, 0.5),
        glow: glowHex,
      };
      this.colors = {};
      for (const k of Object.keys(table)) this.colors[k] = new THREE.Color(table[k]);
      this.glowMat.color.set(glowHex);
      for (const entry of this.geo.values()) for (const g of Object.values(entry)) if (g && g.dispose) g.dispose();
      this.geo.clear();
    },
    dispose() {
      tex.dispose();
      this.glowMat.dispose();
      for (const entry of this.geo.values()) for (const g of Object.values(entry)) if (g && g.dispose) g.dispose();
      this.geo.clear();
    },
  };
  kit.repaint(skin);
  return kit;
}

// Soft radial sprite texture for glows and blob shadows.
let haloTex = null;
export function haloTexture() {
  if (haloTex) return haloTex;
  const c = document.createElement('canvas');
  c.width = c.height = 64;
  const x = c.getContext('2d');
  const g = x.createRadialGradient(32, 32, 0, 32, 32, 32);
  g.addColorStop(0, 'rgba(255,255,255,1)');
  g.addColorStop(0.35, 'rgba(255,255,255,0.45)');
  g.addColorStop(1, 'rgba(255,255,255,0)');
  x.fillStyle = g;
  x.fillRect(0, 0, 64, 64);
  haloTex = new THREE.CanvasTexture(c);
  return haloTex;
}
