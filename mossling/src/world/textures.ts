import * as THREE from "three";
import { mulberry32 } from "./noise";

// Tiny hand-rolled pixel textures. They're greyscale-ish "detail" maps that
// multiply over vertex colors, so one texture can serve many tints.

type Painter = (ctx: CanvasRenderingContext2D, size: number, rand: () => number) => void;

function makeTexture(size: number, seed: number, paint: Painter): THREE.CanvasTexture {
  const canvas = document.createElement("canvas");
  canvas.width = canvas.height = size;
  const ctx = canvas.getContext("2d")!;
  paint(ctx, size, mulberry32(seed));
  const tex = new THREE.CanvasTexture(canvas);
  tex.magFilter = THREE.NearestFilter;
  tex.minFilter = THREE.NearestFilter;
  tex.generateMipmaps = false;
  tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
  // Detail maps are multipliers, so keep them linear (no sRGB darkening).
  tex.colorSpace = THREE.NoColorSpace;
  return tex;
}

const grey = (v: number) => {
  const c = Math.round(Math.max(0, Math.min(1, v)) * 255);
  return `rgb(${c},${c},${c})`;
};

const tinted = (v: number, r: number, g: number, b: number) => {
  const f = (x: number) => Math.round(Math.max(0, Math.min(1, v * x)) * 255);
  return `rgb(${f(r)},${f(g)},${f(b)})`;
};

/** Mossy ground: speckles, little tufts and pebbles. */
export const groundTexture = () =>
  makeTexture(32, 11, (ctx, s, rand) => {
    for (let y = 0; y < s; y++)
      for (let x = 0; x < s; x++) {
        ctx.fillStyle = grey(0.82 + rand() * 0.14);
        ctx.fillRect(x, y, 1, 1);
      }
    for (let i = 0; i < 26; i++) {
      const x = Math.floor(rand() * s);
      const y = Math.floor(rand() * s);
      ctx.fillStyle = grey(1);
      ctx.fillRect(x, y, 1, 2);
      ctx.fillRect(x + 1, y + 1, 1, 1);
    }
    for (let i = 0; i < 14; i++) {
      ctx.fillStyle = grey(0.62 + rand() * 0.1);
      ctx.fillRect(Math.floor(rand() * s), Math.floor(rand() * s), 2, 1);
    }
  });

/** Vertical bark grooves. */
export const barkTexture = () =>
  makeTexture(16, 21, (ctx, s, rand) => {
    for (let x = 0; x < s; x++) {
      const base = x % 4 === 0 ? 0.62 : 0.86 + rand() * 0.12;
      for (let y = 0; y < s; y++) {
        ctx.fillStyle = grey(base - (rand() < 0.08 ? 0.2 : 0));
        ctx.fillRect(x, y, 1, 1);
      }
    }
  });

/** Clumpy leaves with bright highlights. */
export const leafTexture = () =>
  makeTexture(16, 31, (ctx, s, rand) => {
    for (let y = 0; y < s; y++)
      for (let x = 0; x < s; x++) {
        ctx.fillStyle = grey(0.72 + rand() * 0.2);
        ctx.fillRect(x, y, 1, 1);
      }
    for (let i = 0; i < 18; i++) {
      const x = Math.floor(rand() * s);
      const y = Math.floor(rand() * s);
      ctx.fillStyle = grey(1);
      ctx.fillRect(x, y, 2, 1);
      ctx.fillStyle = grey(0.55);
      ctx.fillRect(x, y + 1, 2, 1);
    }
  });

/** Blocky stones with mortar-ish cracks and lichen dots. */
export const stoneTexture = () =>
  makeTexture(16, 41, (ctx, s, rand) => {
    for (let y = 0; y < s; y++)
      for (let x = 0; x < s; x++) {
        const crack = y % 8 === 0 || (x + (y < 8 ? 0 : 4)) % 8 === 0;
        ctx.fillStyle = crack ? grey(0.6) : grey(0.84 + rand() * 0.14);
        ctx.fillRect(x, y, 1, 1);
      }
    for (let i = 0; i < 8; i++) {
      ctx.fillStyle = tinted(1, 0.85, 1, 0.6);
      ctx.fillRect(Math.floor(rand() * s), Math.floor(rand() * s), 1, 1);
    }
  });

/** Wood planks for the cottage and bridge. */
export const plankTexture = () =>
  makeTexture(16, 51, (ctx, s, rand) => {
    for (let y = 0; y < s; y++) {
      const seam = y % 4 === 3;
      for (let x = 0; x < s; x++) {
        ctx.fillStyle = seam ? grey(0.58) : grey(0.84 + rand() * 0.12);
        ctx.fillRect(x, y, 1, 1);
      }
    }
  });

/** Soft round blob used for fake shadows and glows (alpha only). */
export const blobTexture = () => {
  const canvas = document.createElement("canvas");
  canvas.width = canvas.height = 32;
  const ctx = canvas.getContext("2d")!;
  const g = ctx.createRadialGradient(16, 16, 0, 16, 16, 16);
  g.addColorStop(0, "rgba(255,255,255,1)");
  g.addColorStop(0.55, "rgba(255,255,255,0.7)");
  g.addColorStop(1, "rgba(255,255,255,0)");
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, 32, 32);
  const tex = new THREE.CanvasTexture(canvas);
  tex.magFilter = THREE.NearestFilter;
  tex.minFilter = THREE.NearestFilter;
  tex.generateMipmaps = false;
  return tex;
};
