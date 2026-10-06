// First-person viewmodels for Hunter mode: five detailed, smooth-shaded guns —
// .44 revolver, side-by-side 12ga, recurve crossbow, scoped bolt-action and a
// .50 sniper — held in gloved hands under canvas sleeves.
//
// Everything is built procedurally at load. Steel is lathed from profiles with
// tiny machined chamfers, frames and stocks are rounded extrusions (quarter-round
// edges with analytic normals), guards, limbs and strings are swept tubes. All
// normals are smooth; nothing is flat-shaded. Surfaces use PBR materials whose
// textures (walnut grain, bluing, case-hardening, cerakote, leather, canvas
// weave, grip checkering) are generated once into mip-mapped DataTextures and
// shared by every viewmodel. A small shader patch adds believable wear: a
// per-vertex curvature term brightens convex edges toward bare steel (or scuffed
// leather) and darkens cavities with grime, broken up by a noise channel.
//
// The viewmodel lives in camera space (the camera looks down -Z). WeaponSystem
// renders it in its own scene after the world with the depth buffer cleared, so
// it never clips into terrain or dinosaurs.

import * as THREE from "three";
import { clamp, lerp, smoothstep, TAU, HALF_PI } from "../core/math.js";
import { makeRng } from "../core/rng.js";

/* --- Scratch objects (no allocation in update paths) --- */

const _a = new THREE.Vector3();
const _b = new THREE.Vector3();
const _c = new THREE.Vector3();
const _d = new THREE.Vector3();
const _v = new THREE.Vector3();
const _w = new THREE.Vector3();
const _q = new THREE.Quaternion();
const _q2 = new THREE.Quaternion();
const _e = new THREE.Euler();
const _m = new THREE.Matrix4();
const _m2 = new THREE.Matrix4();
const _s1 = new THREE.Vector3(1, 1, 1);
const X_AXIS = new THREE.Vector3(1, 0, 0);
const Y_AXIS = new THREE.Vector3(0, 1, 0);
const Z_AXIS = new THREE.Vector3(0, 0, 1);
const NEG_Z = new THREE.Vector3(0, 0, -1);

const smootherstep = (t) => {
  t = clamp(t, 0, 1);
  return t * t * t * (t * (t * 6 - 15) + 10);
};

/* --- Tileable noise (texture generation only) --- */

/** Periodic 2D gradient noise: noise(x, y, px, py) tiles every px × py lattice cells. */
function tileNoise(seed) {
  const rng = makeRng(seed);
  const p = new Uint8Array(256);
  for (let i = 0; i < 256; i++) p[i] = i;
  for (let i = 255; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    const t = p[i];
    p[i] = p[j];
    p[j] = t;
  }
  const perm = new Uint8Array(512);
  for (let i = 0; i < 512; i++) perm[i] = p[i & 255];
  const gx = new Float32Array(256);
  const gy = new Float32Array(256);
  for (let i = 0; i < 256; i++) {
    const a = rng() * TAU;
    gx[i] = Math.cos(a);
    gy[i] = Math.sin(a);
  }
  const fade = (t) => t * t * t * (t * (t * 6 - 15) + 10);
  return function noise(x, y, px, py) {
    const xi = Math.floor(x);
    const yi = Math.floor(y);
    const xf = x - xi;
    const yf = y - yi;
    const x0 = ((xi % px) + px) % px;
    const y0 = ((yi % py) + py) % py;
    const x1 = (x0 + 1) % px;
    const y1 = (y0 + 1) % py;
    const h00 = perm[perm[x0 & 255] + (y0 & 255)];
    const h10 = perm[perm[x1 & 255] + (y0 & 255)];
    const h01 = perm[perm[x0 & 255] + (y1 & 255)];
    const h11 = perm[perm[x1 & 255] + (y1 & 255)];
    const d00 = gx[h00] * xf + gy[h00] * yf;
    const d10 = gx[h10] * (xf - 1) + gy[h10] * yf;
    const d01 = gx[h01] * xf + gy[h01] * (yf - 1);
    const d11 = gx[h11] * (xf - 1) + gy[h11] * (yf - 1);
    const u = fade(xf);
    const v = fade(yf);
    return (d00 + (d10 - d00) * u + (d01 + (d11 - d01) * u - d00 - (d10 - d00) * u) * v) * 1.414;
  };
}

/** Tileable fBm over the unit tile; fx/fy are integer base frequencies. */
function tfbm(n, u, v, fx, fy, oct = 4, gain = 0.5) {
  let s = 0;
  let a = 1;
  let norm = 0;
  for (let o = 0; o < oct; o++) {
    s += a * n(u * fx, v * fy, fx, fy);
    norm += a;
    a *= gain;
    fx *= 2;
    fy *= 2;
  }
  return s / norm;
}

function hash01(x, y, s) {
  let h = Math.imul(x, 374761393) ^ Math.imul(y, 668265263) ^ Math.imul(s, 1274126177);
  h = Math.imul(h ^ (h >>> 13), 1103515245);
  h ^= h >>> 16;
  return (h >>> 0) / 4294967296;
}

/** Tileable Worley (cellular) F1 distance, in cell units. */
function worley(u, v, cells, seed) {
  const x = u * cells;
  const y = v * cells;
  const xi = Math.floor(x);
  const yi = Math.floor(y);
  let best = 9;
  for (let dy = -1; dy <= 1; dy++) {
    for (let dx = -1; dx <= 1; dx++) {
      const cx = xi + dx;
      const cy = yi + dy;
      const wx = ((cx % cells) + cells) % cells;
      const wy = ((cy % cells) + cells) % cells;
      const px = cx + hash01(wx, wy, seed);
      const py = cy + hash01(wx, wy, seed + 17);
      const d = (px - x) * (px - x) + (py - y) * (py - y);
      if (d < best) best = d;
    }
  }
  return Math.sqrt(best);
}

/* --- Procedural textures --- */

function dataTexture(data, size, srgb) {
  const t = new THREE.DataTexture(data, size, size, THREE.RGBAFormat, THREE.UnsignedByteType);
  t.wrapS = t.wrapT = THREE.RepeatWrapping;
  t.magFilter = THREE.LinearFilter;
  t.minFilter = THREE.LinearMipmapLinearFilter;
  t.generateMipmaps = true;
  t.anisotropy = 4;
  t.colorSpace = srgb ? THREE.SRGBColorSpace : THREE.NoColorSpace;
  t.needsUpdate = true;
  return t;
}

const to8 = (v) => clamp(Math.round(v * 255), 0, 255);

/** Normal map (tangent space) from a tileable height field. */
function normalFromHeight(h, size, strength) {
  const out = new Uint8Array(size * size * 4);
  for (let j = 0; j < size; j++) {
    const jn = ((j + 1) % size) * size;
    const jp = ((j - 1 + size) % size) * size;
    for (let i = 0; i < size; i++) {
      const ip = (i - 1 + size) % size;
      const inx = (i + 1) % size;
      const dx = (h[j * size + inx] - h[j * size + ip]) * strength;
      const dy = (h[jn + i] - h[jp + i]) * strength;
      const inv = 1 / Math.sqrt(dx * dx + dy * dy + 1);
      const o = (j * size + i) * 4;
      out[o] = to8((-dx * inv) * 0.5 + 0.5);
      out[o + 1] = to8((-dy * inv) * 0.5 + 0.5);
      out[o + 2] = to8(inv * 0.5 + 0.5);
      out[o + 3] = 255;
    }
  }
  return dataTexture(out, size, false);
}

/**
 * Sample a material description over the unit tile into three textures:
 * colour (sRGB), ORM-style data (R wear noise, G roughness, B metalness) and a
 * normal map derived from the sampled height.
 */
function textureSet(size, sample, bump) {
  const n = size * size;
  const col = new Uint8Array(n * 4);
  const orm = new Uint8Array(n * 4);
  const h = new Float32Array(n);
  const s = { r: 0.5, g: 0.5, b: 0.5, rough: 0.5, metal: 0, wear: 0.5, height: 0 };
  for (let j = 0; j < size; j++) {
    for (let i = 0; i < size; i++) {
      sample(i / size, j / size, s);
      const k = j * size + i;
      const o = k * 4;
      col[o] = to8(s.r);
      col[o + 1] = to8(s.g);
      col[o + 2] = to8(s.b);
      col[o + 3] = 255;
      orm[o] = to8(s.wear);
      orm[o + 1] = to8(s.rough);
      orm[o + 2] = to8(s.metal);
      orm[o + 3] = 255;
      h[k] = s.height;
    }
  }
  return { map: dataTexture(col, size, true), orm: dataTexture(orm, size, false), normal: normalFromHeight(h, size, bump) };
}

function buildTextures(lowDetail) {
  const S = lowDetail ? 128 : 256;
  const n = tileNoise(9137);
  const n2 = tileNoise(4421);

  // Walnut: fine growth lines running along the stock, bent by a broad flowing
  // figure, with soft dark latewood and long open pores. Kept low in contrast:
  // oiled walnut reads as warm and deep, not striped.
  const wood = textureSet(lowDetail ? 256 : 512, (u, v, s) => {
    const w1 = tfbm(n, u, v, 1, 2, 4);
    const w2 = n(u * 4, v * 32, 4, 32);
    const g = v * 26 + w1 * 3.4 + w2 * 0.18;
    const ring = g - Math.floor(g);
    const late = smoothstep(0.55, 0.93, ring) * (1 - smoothstep(0.94, 1, ring));
    const fig = tfbm(n2, u, v, 2, 3, 4) * 0.5 + 0.5;
    const pore = smoothstep(0.38, 0.85, n2(u * 4 + 11, v * 150, 4, 150) * 0.5 + n(u * 9, v * 260, 9, 260) * 0.5);
    const t = clamp(late * 0.4 + (1 - fig) * 0.55, 0, 1);
    const dark = 1 - pore * 0.2;
    s.r = lerp(0.42, 0.17, t) * dark;
    s.g = lerp(0.255, 0.095, t) * dark;
    s.b = lerp(0.14, 0.05, t) * dark;
    s.rough = 0.36 + pore * 0.26 + late * 0.05;
    s.metal = 0;
    s.wear = tfbm(n, u + 0.31, v, 5, 5, 3) * 0.5 + 0.5;
    s.height = -pore * 0.7 + late * 0.15;
  }, 1.0);

  // Generic machined steel: fine brushing along the part, soft mottling.
  // Neutral grey so a material colour gives bluing, parkerising, brass...
  const metal = textureSet(S, (u, v, s) => {
    const streak = n(u * 3, v * 120, 3, 120) * 0.6 + n2(u * 6, v * 240, 6, 240) * 0.4;
    const mott = tfbm(n2, u, v, 4, 4, 4);
    const g = 0.84 + streak * 0.05 + mott * 0.08;
    s.r = s.g = s.b = g;
    s.rough = clamp(0.55 + streak * 0.14 + mott * 0.12, 0, 1);
    s.metal = 1;
    s.wear = tfbm(n, u, v + 0.17, 6, 6, 4) * 0.5 + 0.5;
    s.height = streak * 0.35;
  }, 0.8);

  // Colour case-hardening: soft mottling of straw, bronze, plum and slate over
  // grey steel (subdued — old case colours fade toward grey), with faint scroll
  // engraving cut into it (normal map only).
  const caseSet = textureSet(S, (u, v, s) => {
    const a = tfbm(n, u, v, 3, 3, 5) * 0.5 + 0.5;
    const b = tfbm(n2, u, v, 5, 5, 4) * 0.5 + 0.5;
    const t = clamp(a * 0.85 + b * 0.35 - 0.1, 0, 1);
    // palette walk: straw → bronze → plum → slate → grey
    const P = [[0.6, 0.53, 0.4], [0.5, 0.42, 0.34], [0.43, 0.38, 0.42], [0.36, 0.4, 0.47], [0.5, 0.5, 0.51]];
    const f = t * (P.length - 1);
    const i = Math.min(P.length - 2, Math.floor(f));
    const k = smoothstep(0, 1, f - i);
    s.r = lerp(P[i][0], P[i + 1][0], k);
    s.g = lerp(P[i][1], P[i + 1][1], k);
    s.b = lerp(P[i][2], P[i + 1][2], k);
    const e = tfbm(n2, u, v, 4, 4, 3);
    const mask = smoothstep(0.2, 0.45, tfbm(n, u + 0.5, v, 2, 2, 2) * 0.5 + 0.5);
    const line = (1 - smoothstep(0.0, 0.12, Math.abs(Math.sin(e * 14)))) * mask;
    s.rough = 0.42 + line * 0.15;
    s.metal = 1;
    s.wear = tfbm(n, u, v, 4, 4, 3) * 0.5 + 0.5;
    s.height = -line * 0.5;
  }, 1.0);

  // Coatings (cerakote, polymer, rubber): fine stipple, matte.
  const coat = textureSet(S, (u, v, s) => {
    const f = n(u * 64, v * 64, 64, 64) * 0.5 + n2(u * 128, v * 128, 128, 128) * 0.5;
    const m = tfbm(n, u, v, 4, 4, 3);
    const g = 0.86 + m * 0.06 + f * 0.035;
    s.r = s.g = s.b = g;
    s.rough = clamp(0.72 + f * 0.12, 0, 1);
    s.metal = 0;
    s.wear = tfbm(n2, u, v, 6, 6, 3) * 0.5 + 0.5;
    s.height = f * 0.7;
  }, 1.2);

  // Fine pebbled leather with a few soft creases (gloves). The grain is small
  // and shallow so it reads as leather at arm's length and doesn't shimmer.
  const leather = textureSet(S, (u, v, s) => {
    const d = worley(u, v, 64, 77);
    const crease = 1 - smoothstep(0.0, 0.04, Math.abs(n(u * 6, v * 9, 6, 9)));
    const m = tfbm(n2, u, v, 3, 3, 3) * 0.5 + 0.5;
    const shade = (0.9 + m * 0.16) * (1 - crease * 0.16) * (0.96 + d * 0.05);
    s.r = 0.4 * shade;
    s.g = 0.285 * shade;
    s.b = 0.185 * shade;
    s.rough = 0.62 + crease * 0.12 - d * 0.04;
    s.metal = 0;
    s.wear = tfbm(n, u, v, 5, 5, 3) * 0.5 + 0.5;
    s.height = smoothstep(0.0, 0.8, d) * 0.4 - crease * 0.45;
  }, 0.9);

  // Cotton duck canvas: plain weave with slubbed threads (sleeves, straps, string).
  const canvas = textureSet(S, (u, v, s) => {
    const K = 48;
    const x = u * K;
    const y = v * K;
    const ix = Math.floor(x);
    const iy = Math.floor(y);
    const fx = x - ix;
    const fy = y - iy;
    const over = (ix + iy) & 1;
    const hgt = over ? Math.sin(fx * Math.PI) * 0.8 + Math.sin(fy * Math.PI) * 0.2 : Math.sin(fy * Math.PI) * 0.8 + Math.sin(fx * Math.PI) * 0.2;
    const slub = 0.92 + hash01(over ? iy : ix, over ? 3 : 5, 9) * 0.14;
    const m = tfbm(n2, u, v, 3, 3, 3) * 0.5 + 0.5;
    const shade = (0.8 + hgt * 0.2) * slub * (0.9 + m * 0.18);
    s.r = 0.33 * shade;
    s.g = 0.335 * shade;
    s.b = 0.23 * shade;
    s.rough = 0.9;
    s.metal = 0;
    s.wear = tfbm(n, u, v, 4, 4, 3) * 0.5 + 0.5;
    s.height = hgt;
  }, 1.0);

  // Diamond checkering for grips (normal only; repeated finer than the grain).
  const chk = new Float32Array(S * S);
  const K = 24;
  for (let j = 0; j < S; j++) {
    for (let i = 0; i < S; i++) {
      const u = i / S;
      const v = j / S;
      const a = (u + v) * K;
      const b = (u - v) * K;
      const ta = 1 - 2 * Math.abs(a - Math.floor(a) - 0.5);
      const tb = 1 - 2 * Math.abs(b - Math.floor(b) - 0.5);
      chk[j * S + i] = Math.min(ta, tb);
    }
  }
  const checker = normalFromHeight(chk, S, 2.2);
  checker.repeat.set(3, 3);

  return { wood, metal, caseSet, coat, leather, canvas, checker };
}

/* --- Materials --- */

/**
 * Uniforms shared by every viewmodel material. WeaponSystem tints the baked
 * neutral environment toward the current sky each frame through `envTint`.
 */
export const viewmodelUniforms = { envTint: { value: new THREE.Color(1, 1, 1) } };

const WEAR_CHUNK = /* glsl */ `
#include <metalnessmap_fragment>
#ifdef USE_ROUGHNESSMAP
	float wearN = texture2D( roughnessMap, vRoughnessMapUv ).r;
#else
	float wearN = 0.5;
#endif
	float edgeWear = smoothstep( 0.32, 0.8, vWear * uWear + ( wearN - 0.5 ) * 0.75 ) * step( 0.001, uWear );
	diffuseColor.rgb = mix( diffuseColor.rgb, uWearColor, edgeWear );
	roughnessFactor = mix( roughnessFactor, uWearRough, edgeWear );
	metalnessFactor = mix( metalnessFactor, uWearMetal, edgeWear );
	float grime = smoothstep( 0.05, 0.6, -vWear ) * uGrime;
	diffuseColor.rgb *= 1.0 - grime * 0.6;
	roughnessFactor = mix( roughnessFactor, 1.0, grime * 0.5 );
`;

function patchMaterial(mat, o) {
  const uniforms = {
    uWearColor: { value: new THREE.Color(o.wearColor ?? 0x9a9ca0) },
    uWearRough: { value: o.wearRough ?? 0.3 },
    uWearMetal: { value: o.wearMetal ?? 1 },
    uWear: { value: o.wear ?? 1 },
    uGrime: { value: o.grime ?? 0.6 },
    uEnvTint: o.envTint === false ? { value: new THREE.Color(1, 1, 1) } : viewmodelUniforms.envTint,
  };
  mat.userData.wearUniforms = uniforms;
  mat.onBeforeCompile = (shader) => {
    Object.assign(shader.uniforms, uniforms);
    shader.vertexShader = shader.vertexShader
      .replace("#include <common>", "#include <common>\nattribute float aWear;\nvarying float vWear;")
      .replace("#include <begin_vertex>", "#include <begin_vertex>\n\tvWear = aWear;");
    shader.fragmentShader = shader.fragmentShader
      .replace(
        "#include <common>",
        "#include <common>\nvarying float vWear;\nuniform vec3 uWearColor;\nuniform float uWearRough;\nuniform float uWearMetal;\nuniform float uWear;\nuniform float uGrime;\nuniform vec3 uEnvTint;",
      )
      .replace("#include <metalnessmap_fragment>", WEAR_CHUNK)
      .replace(
        "#include <lights_fragment_maps>",
        "#include <lights_fragment_maps>\n#if defined( RE_IndirectSpecular )\n\tradiance *= uEnvTint;\n#endif\n#if defined( RE_IndirectDiffuse )\n\tiblIrradiance *= uEnvTint;\n#endif",
      );
  };
  mat.customProgramCacheKey = () => "sauria-viewmodel";
}

function pbr(set, o = {}) {
  const mat = new THREE.MeshStandardMaterial({
    color: o.color ?? 0xffffff,
    map: o.map === undefined ? set.map : o.map,
    roughnessMap: set.orm,
    metalnessMap: set.orm,
    normalMap: o.normal === undefined ? set.normal : o.normal,
    roughness: o.rough ?? 1,
    metalness: o.metal ?? 0,
  });
  const ns = o.normalScale ?? 0.5;
  mat.normalScale.set(ns, ns);
  if (o.envIntensity !== undefined) mat.envMapIntensity = o.envIntensity;
  mat.userData.uvMode = o.uv ?? "axial";
  mat.userData.uvScale = o.uvScale ?? 0.2;
  patchMaterial(mat, o);
  return mat;
}

let LIB = null;

/** Shared material library (built once, on first use). */
function library(lowDetail = false) {
  if (LIB) return LIB;
  const T = buildTextures(lowDetail);
  const L = { textures: T };
  L.walnut = pbr(T.wood, { metal: 0, normalScale: 0.3, uvScale: 0.24, wearColor: 0x6a4a30, wearRough: 0.62, wearMetal: 0, wear: 0.5, grime: 0.7 });
  L.walnutChecker = pbr(T.wood, { color: 0xc8c0b8, metal: 0, normal: T.checker, normalScale: 0.7, uvScale: 0.24, rough: 1.25, wearColor: 0x6a4a30, wearRough: 0.7, wearMetal: 0, wear: 0.4 });
  L.ash = pbr(T.wood, { color: 0xe8d2b4, metal: 0, normalScale: 0.3, uvScale: 0.3, wearColor: 0x8a6a48, wearRough: 0.6, wearMetal: 0, wear: 0.5 });
  L.blued = pbr(T.metal, { color: 0x4d5566, rough: 0.6, metal: 0.92, normalScale: 0.12, uvScale: 0.16, wearColor: 0xa4a7ad, wearRough: 0.26, wearMetal: 1, wear: 1 });
  L.caseColor = pbr(T.caseSet, { rough: 0.62, metal: 0.95, normalScale: 0.3, uvScale: 0.12, wearColor: 0xb4b2ae, wearRough: 0.24, wearMetal: 1, wear: 0.9 });
  L.parkerized = pbr(T.metal, { color: 0x3c3f3d, rough: 1.4, metal: 0.55, normalScale: 0.2, uvScale: 0.14, wearColor: 0x8d9093, wearRough: 0.35, wearMetal: 1, wear: 0.9 });
  L.anodized = pbr(T.metal, { color: 0x1f2124, rough: 0.85, metal: 0.6, normalScale: 0.1, uvScale: 0.12, wearColor: 0x7b7f86, wearRough: 0.35, wearMetal: 1, wear: 0.7 });
  L.steel = pbr(T.metal, { color: 0xb2b5ba, rough: 0.48, metal: 1, normalScale: 0.12, uvScale: 0.1, wearColor: 0xcfd1d4, wearRough: 0.2, wearMetal: 1, wear: 0.4, grime: 0.8 });
  L.brass = pbr(T.metal, { color: 0xd6aa62, rough: 0.48, metal: 1, normalScale: 0.08, uvScale: 0.05, wearColor: 0xf0d090, wearRough: 0.2, wearMetal: 1, wear: 0.5 });
  L.bore = pbr(T.metal, { color: 0x0c0c0d, rough: 1.4, metal: 0.4, normalScale: 0, wear: 0, grime: 0 });
  L.fde = pbr(T.coat, { color: 0x9c8466, rough: 0.95, metal: 0, normalScale: 0.35, uvScale: 0.12, wearColor: 0x4a4c4e, wearRough: 0.4, wearMetal: 0.8, wear: 0.85 });
  L.polymer = pbr(T.coat, { color: 0x1d1d1f, rough: 1.0, metal: 0, normalScale: 1.1, uvScale: 0.05, wearColor: 0x3a3a3c, wearRough: 0.55, wearMetal: 0, wear: 0.5 });
  L.rubber = pbr(T.coat, { color: 0x141414, rough: 1.3, metal: 0, normalScale: 0.8, uvScale: 0.06, wear: 0, grime: 0.4 });
  L.limb = pbr(T.coat, { color: 0x202224, rough: 0.6, metal: 0.1, normalScale: 0.25, uvScale: 0.2, uv: "axialX", wearColor: 0x505356, wearRough: 0.4, wearMetal: 0.3, wear: 0.6 });
  L.red = pbr(T.coat, { color: 0xc4301f, rough: 0.6, metal: 0, normalScale: 0, wear: 0 });
  L.orange = pbr(T.coat, { color: 0xe8691d, rough: 0.65, metal: 0, normalScale: 0.2, wear: 0, grime: 0.2 });
  L.shell = pbr(T.coat, { color: 0x8e2016, rough: 0.5, metal: 0, normalScale: 0.15, wear: 0.3, wearColor: 0xa83a2c, wearRough: 0.4, wearMetal: 0 });
  L.carbon = pbr(T.canvas, { color: 0x3a3b3e, map: null, rough: 0.5, metal: 0.25, normalScale: 0.3, uvScale: 0.03, wear: 0, grime: 0.3 });
  L.string = pbr(T.canvas, { color: 0x4a4636, map: null, rough: 0.95, metal: 0, normalScale: 0.6, uvScale: 0.02, wear: 0, grime: 0 });
  L.glove = pbr(T.leather, { rough: 1, metal: 0, normalScale: 0.35, uv: "box", uvScale: 0.11, wearColor: 0x8c6c4e, wearRough: 0.78, wearMetal: 0, wear: 1.15, grime: 0.8 });
  L.gloveDark = pbr(T.leather, { color: 0xa39a90, rough: 1.1, metal: 0, normalScale: 0.3, uv: "box", uvScale: 0.08, wearColor: 0x7e6a58, wearRough: 0.8, wearMetal: 0, wear: 0.9, grime: 0.8 });
  L.strap = pbr(T.canvas, { color: 0x3c3c3a, map: null, rough: 1, metal: 0, normalScale: 0.8, uv: "box", uvScale: 0.04, wear: 0, grime: 0.6 });
  L.sleeve = pbr(T.canvas, { rough: 1, metal: 0, normalScale: 0.7, uv: "box", uvScale: 0.13, wear: 0.4, wearColor: 0x6e6c52, wearRough: 0.95, wearMetal: 0, grime: 1 });
  // Scope glass: dark coated optics with a strong fresnel reflection of the
  // environment, over a deep violet "inside the tube" disc for depth.
  L.glass = new THREE.MeshStandardMaterial({ color: 0x0a1416, roughness: 0.04, metalness: 0.2, transparent: true, opacity: 0.78, envMapIntensity: 1.8 });
  patchMaterial(L.glass, { wear: 0, grime: 0 });
  L.lensInner = new THREE.MeshStandardMaterial({ color: 0x241634, roughness: 0.25, metalness: 0.4, emissive: 0x080512 });
  patchMaterial(L.lensInner, { wear: 0, grime: 0 });
  LIB = L;
  return L;
}

/* --- Geometry: parametric surfaces --- */

function makeGeometry(pos, nor, uv, idx) {
  const g = new THREE.BufferGeometry();
  g.setAttribute("position", new THREE.BufferAttribute(pos instanceof Float32Array ? pos : new Float32Array(pos), 3));
  g.setAttribute("normal", new THREE.BufferAttribute(nor instanceof Float32Array ? nor : new Float32Array(nor), 3));
  g.setAttribute("uv", new THREE.BufferAttribute(uv instanceof Float32Array ? uv : new Float32Array(uv), 2));
  g.setIndex(idx);
  return g;
}

const _sa = new THREE.Vector3();
const _sb = new THREE.Vector3();
const _sc = new THREE.Vector3();
const _sd = new THREE.Vector3();
const _sp = new THREE.Vector3();
const _sn = new THREE.Vector3();

/** True surface normal from parameter derivatives; degenerate poles borrow from just inside. */
function surfaceNormal(fn, u, v, closedU, out) {
  const e = 1e-4;
  for (let k = 0; k < 5; k++) {
    const vv = k === 0 ? v : clamp(v + (v < 0.5 ? 1 : -1) * 0.0015 * k, 0, 1);
    const u0 = closedU ? u - e : Math.max(0, u - e);
    const u1 = closedU ? u + e : Math.min(1, u + e);
    fn(u0, vv, _sa);
    fn(u1, vv, _sb);
    fn(u, Math.max(0, vv - e), _sc);
    fn(u, Math.min(1, vv + e), _sd);
    _sb.sub(_sa);
    _sd.sub(_sc);
    out.crossVectors(_sb, _sd);
    if (out.lengthSq() > 1e-30) return out.normalize();
  }
  return out.set(0, 1, 0);
}

/**
 * Indexed grid surface P(u, v): u ∈ [0,1] around (nu segments), v over `rows`
 * (a count or explicit list of v values). Shading normals come from the
 * surface derivatives, so it is smooth independent of tessellation.
 */
function surface(nu, rows, fn, { closedU = true, flip = false } = {}) {
  const vs = typeof rows === "number" ? Array.from({ length: rows + 1 }, (_, j) => j / rows) : rows;
  const nv = vs.length - 1;
  const cols = nu + 1;
  const count = cols * vs.length;
  const pos = new Float32Array(count * 3);
  const nor = new Float32Array(count * 3);
  const uv = new Float32Array(count * 2);
  for (let j = 0; j <= nv; j++) {
    const v = vs[j];
    for (let i = 0; i <= nu; i++) {
      const u = closedU && i === nu ? 0 : i / nu;
      const k = j * cols + i;
      fn(u, v, _sp);
      surfaceNormal(fn, u, v, closedU, _sn);
      if (flip) _sn.negate();
      pos[k * 3] = _sp.x;
      pos[k * 3 + 1] = _sp.y;
      pos[k * 3 + 2] = _sp.z;
      nor[k * 3] = _sn.x;
      nor[k * 3 + 1] = _sn.y;
      nor[k * 3 + 2] = _sn.z;
      uv[k * 2] = i / nu;
      uv[k * 2 + 1] = v;
    }
  }
  const idx = [];
  for (let j = 0; j < nv; j++) {
    for (let i = 0; i < nu; i++) {
      const a = j * cols + i;
      const b = a + 1;
      const c = a + cols;
      const d = c + 1;
      if (flip) idx.push(a, c, b, b, c, d);
      else idx.push(a, b, c, b, d, c);
    }
  }
  return makeGeometry(pos, nor, uv, idx);
}

/**
 * Surface of revolution about Z from a profile of [r, z] points (one ring per
 * point, so chamfers stay crisp). rFn(theta, z) can sculpt the radius (flutes,
 * knurling). Orientation follows the profile's overall direction.
 */
function lathe(profile, segs = 32, { rFn = null, flip = null, arc = 1, phase = 0, sx = 1, sy = 1 } = {}) {
  const n = profile.length - 1;
  const fn = (u, v, out) => {
    const f = clamp(v, 0, 1) * n;
    const i = Math.min(n - 1, Math.floor(f));
    const t = f - i;
    const r0 = profile[i][0] + (profile[i + 1][0] - profile[i][0]) * t;
    const z = profile[i][1] + (profile[i + 1][1] - profile[i][1]) * t;
    const th = phase + u * arc * TAU;
    const r = rFn ? r0 * rFn(th, z) : r0;
    out.set(Math.cos(th) * r * sx, Math.sin(th) * r * sy, z);
  };
  const rows = profile.map((_, j) => j / n);
  const f = flip ?? profile[n][1] < profile[0][1];
  return surface(segs, rows, fn, { closedU: arc >= 1, flip: f });
}

/** Lathe profile helper: a cylinder from z0 to z1 with chamfered ends (optionally capped). */
function cylProfile(r, z0, z1, ch = 0.0008, capped = true) {
  const s = Math.sign(z1 - z0);
  const p = [];
  if (capped) p.push([0, z0]);
  p.push([r - ch, z0], [r, z0 + s * ch], [r, z1 - s * ch], [r - ch, z1]);
  if (capped) p.push([0, z1]);
  return p;
}

/**
 * Sweep an elliptical section along a path (t ∈ [0,1] → point). The frame uses a
 * fixed binormal `plane` (the path's plane normal), so planar paths never twist.
 */
function sweep(path, { rx = 0.003, ry = rx, plane = X_AXIS, segs = 12, rows = 24, ends = true, taper = null } = {}) {
  const P = new THREE.Vector3();
  const T = new THREE.Vector3();
  const T2 = new THREE.Vector3();
  const N = new THREE.Vector3();
  const B = plane.clone().normalize();
  let L = 0;
  path(0, T);
  for (let k = 1; k <= 48; k++) {
    path(k / 48, T2);
    L += T.distanceTo(T2);
    T.copy(T2);
  }
  const capT = ends ? Math.min(0.45, Math.max(rx, ry) / Math.max(L, 1e-6)) : 0;
  const fn = (u, v, out) => {
    const t = clamp(v, 0, 1);
    path(t, P);
    path(Math.min(1, t + 1e-3), T2);
    path(Math.max(0, t - 1e-3), T);
    T2.sub(T).normalize();
    N.crossVectors(T2, B).normalize();
    let s = taper ? taper(t) : 1;
    if (capT > 0) {
      if (t < capT) s *= Math.sqrt(Math.max(0, 1 - ((capT - t) / capT) ** 2));
      else if (t > 1 - capT) s *= Math.sqrt(Math.max(0, 1 - ((t - 1 + capT) / capT) ** 2));
    }
    const th = u * TAU;
    out.copy(P).addScaledVector(N, Math.cos(th) * rx * s).addScaledVector(B, Math.sin(th) * ry * s);
  };
  const vs = [];
  if (capT > 0) {
    const cap = 6;
    for (let k = 0; k < cap; k++) vs.push(capT * (1 - Math.cos((k / cap) * HALF_PI)));
    for (let k = 0; k <= rows; k++) vs.push(capT + (1 - 2 * capT) * (k / rows));
    for (let k = 1; k <= cap; k++) vs.push(1 - capT + capT * Math.sin((k / cap) * HALF_PI));
  } else {
    for (let k = 0; k <= rows; k++) vs.push(k / rows);
  }
  let g = surface(segs, vs, fn, { closedU: true });
  // Orientation check against the path centre at mid-length.
  const mid = Math.floor(vs.length / 2) * (segs + 1);
  path(vs[Math.floor(vs.length / 2)], P);
  const pa = g.attributes.position;
  const na = g.attributes.normal;
  _v.set(pa.getX(mid), pa.getY(mid), pa.getZ(mid)).sub(P);
  _w.set(na.getX(mid), na.getY(mid), na.getZ(mid));
  if (_v.dot(_w) < 0) {
    g.dispose();
    g = surface(segs, vs, fn, { closedU: true, flip: true });
  }
  return g;
}

/** Path helper: Catmull-Rom spline through points (Vector3 or [x, y, z]). */
function spline(points) {
  const curve = new THREE.CatmullRomCurve3(points.map((p) => (p.isVector3 ? p : new THREE.Vector3(p[0], p[1], p[2]))), false, "centripetal");
  return (t, out) => curve.getPoint(t, out);
}

/** Normal of the plane through three points (first, middle, last) — the binormal for a sweep. */
function planeOf(pts) {
  const a = new THREE.Vector3(...pts[0]);
  const b = new THREE.Vector3(...pts[Math.floor(pts.length / 2)]);
  const c = new THREE.Vector3(...pts[pts.length - 1]);
  return b.sub(a).cross(c.sub(a)).normalize();
}

/** Path helper: a straight segment. */
function segment(a, b) {
  return (t, out) => out.set(lerp(a[0], b[0], t), lerp(a[1], b[1], t), lerp(a[2], b[2], t));
}

/* --- Geometry: rounded extrusions --- */

function signedArea(pts) {
  let s = 0;
  for (let i = 0; i < pts.length; i++) {
    const p = pts[i];
    const q = pts[(i + 1) % pts.length];
    s += p[0] * q[1] - q[0] * p[1];
  }
  return s * 0.5;
}

function orient(pts, ccw) {
  const a = signedArea(pts);
  return (a > 0) === ccw ? pts : pts.slice().reverse();
}

/**
 * Round the corners of a closed polygon with quadratic fillets. `r` is the
 * tangent distance per corner (number or array, 0 keeps the corner sharp).
 */
function roundCorners(pts, r, segs = 5) {
  const out = [];
  const n = pts.length;
  for (let i = 0; i < n; i++) {
    const P = pts[i];
    const A = pts[(i - 1 + n) % n];
    const B = pts[(i + 1) % n];
    const ri = Array.isArray(r) ? r[i] : r;
    if (!ri) {
      out.push([P[0], P[1]]);
      continue;
    }
    const l1 = Math.hypot(A[0] - P[0], A[1] - P[1]);
    const l2 = Math.hypot(B[0] - P[0], B[1] - P[1]);
    const t = Math.min(ri, l1 * 0.5, l2 * 0.5);
    const q1 = [P[0] + ((A[0] - P[0]) / l1) * t, P[1] + ((A[1] - P[1]) / l1) * t];
    const q2 = [P[0] + ((B[0] - P[0]) / l2) * t, P[1] + ((B[1] - P[1]) / l2) * t];
    for (let k = 0; k <= segs; k++) {
      const s = k / segs;
      const w0 = (1 - s) * (1 - s);
      const w1 = 2 * (1 - s) * s;
      const w2 = s * s;
      out.push([w0 * q1[0] + w1 * P[0] + w2 * q2[0], w0 * q1[1] + w1 * P[1] + w2 * q2[1]]);
    }
  }
  // Drop coincident neighbours (fillets that meet exactly).
  const clean = [];
  for (const p of out) {
    const q = clean[clean.length - 1];
    if (!q || Math.hypot(p[0] - q[0], p[1] - q[1]) > 1e-6) clean.push(p);
  }
  if (clean.length > 2 && Math.hypot(clean[0][0] - clean[clean.length - 1][0], clean[0][1] - clean[clean.length - 1][1]) < 1e-6) clean.pop();
  return clean;
}

function contourNormals(c) {
  const n = c.length;
  const out = [];
  for (let i = 0; i < n; i++) {
    const p0 = c[(i - 1 + n) % n];
    const p1 = c[i];
    const p2 = c[(i + 1) % n];
    let ax = p1[1] - p0[1];
    let ay = -(p1[0] - p0[0]);
    let bx = p2[1] - p1[1];
    let by = -(p2[0] - p1[0]);
    const la = Math.hypot(ax, ay) || 1;
    const lb = Math.hypot(bx, by) || 1;
    ax /= la;
    ay /= la;
    bx /= lb;
    by /= lb;
    let nx = ax + bx;
    let ny = ay + by;
    const l = Math.hypot(nx, ny) || 1;
    nx /= l;
    ny /= l;
    // Keep the offset distance right at corners (miter), bounded for spikes.
    const cosHalf = Math.max(0.35, nx * ax + ny * ay);
    out.push([nx, ny, 1 / cosHalf]);
  }
  return out;
}

/**
 * Extrude a closed 2D outline (XY) along Z with quarter-round edges of radius
 * `bevel` on both faces. Normals are analytic, so the round-overs and long walls
 * shade perfectly smoothly. Holes are supported (inner contours).
 */
function extrude(outline, depth, bevel, { holes = [], segs = 3 } = {}) {
  const contours = [orient(outline, true), ...holes.map((h) => orient(h, false))];
  bevel = Math.min(bevel, depth * 0.5);
  const zf = depth * 0.5 - bevel;
  const ringS = [];
  const ringZ = [];
  for (let k = 0; k <= segs; k++) {
    const s = (k / segs) * HALF_PI;
    ringS.push(s);
    ringZ.push(zf + bevel * Math.cos(s));
  }
  for (let k = 0; k <= segs; k++) {
    const s = HALF_PI + (k / segs) * HALF_PI;
    ringS.push(s);
    ringZ.push(-zf + bevel * Math.cos(s));
  }
  const R = ringS.length;
  const pos = [];
  const nor = [];
  const idx = [];
  const caps = [];
  for (const c of contours) {
    const n = c.length;
    const N2 = contourNormals(c);
    const base = pos.length / 3;
    for (let r = 0; r < R; r++) {
      const s = ringS[r];
      const ins = bevel * (1 - Math.sin(s));
      const sn = Math.sin(s);
      const cs = Math.cos(s);
      for (let i = 0; i < n; i++) {
        pos.push(c[i][0] - N2[i][0] * ins * N2[i][2], c[i][1] - N2[i][1] * ins * N2[i][2], ringZ[r]);
        nor.push(N2[i][0] * sn, N2[i][1] * sn, cs);
      }
    }
    for (let r = 0; r < R - 1; r++) {
      for (let i = 0; i < n; i++) {
        const a = base + r * n + i;
        const b = base + r * n + ((i + 1) % n);
        const cc = a + n;
        const d = b + n;
        idx.push(a, cc, b, b, cc, d);
      }
    }
    caps.push(c.map((p, i) => new THREE.Vector2(p[0] - N2[i][0] * bevel * N2[i][2], p[1] - N2[i][1] * bevel * N2[i][2])));
  }
  const tris = THREE.ShapeUtils.triangulateShape(caps[0], caps.slice(1));
  const flat = caps.flat();
  for (const zs of [1, -1]) {
    const base = pos.length / 3;
    for (const p of flat) {
      pos.push(p.x, p.y, zs * depth * 0.5);
      nor.push(0, 0, zs);
    }
    for (const t of tris) {
      const p0 = flat[t[0]];
      const p1 = flat[t[1]];
      const p2 = flat[t[2]];
      const ccw = (p1.x - p0.x) * (p2.y - p0.y) - (p1.y - p0.y) * (p2.x - p0.x) > 0;
      if ((zs > 0) === ccw) idx.push(base + t[0], base + t[1], base + t[2]);
      else idx.push(base + t[0], base + t[2], base + t[1]);
    }
  }
  const uv = new Float32Array((pos.length / 3) * 2);
  return makeGeometry(pos, nor, uv, idx);
}

/** Side-profile part: points are [z, y] in gun space, extruded across X (width) centred on `x`. */
function side(pts, width, bevel, { r = 0, fs = 4, segs = 3, x = 0, holes = [] } = {}) {
  const conv = (p) => [-p[0], p[1]];
  const outline = roundCorners(pts.map(conv), r, fs);
  const hs = holes.map((h) => roundCorners(h.map(conv), r, fs));
  const g = extrude(outline, width, bevel, { segs, holes: hs });
  g.rotateY(HALF_PI);
  if (x) g.translate(x, 0, 0);
  return g;
}

/** Top-profile part: points are [x, z] in gun space, extruded along Y (height) centred on `y`. */
function topProfile(pts, height, bevel, { r = 0, fs = 4, segs = 3, y = 0 } = {}) {
  const conv = (p) => [p[0], -p[1]];
  const g = extrude(roundCorners(pts.map(conv), r, fs), height, bevel, { segs });
  g.rotateX(-HALF_PI);
  if (y) g.translate(0, y, 0);
  return g;
}

/** Front-profile part: points are [x, y], extruded along Z centred on `z`. */
function frontProfile(pts, depth, bevel, { r = 0, fs = 4, segs = 3, z = 0 } = {}) {
  const g = extrude(roundCorners(pts, r, fs), depth, bevel, { segs });
  if (z) g.translate(0, 0, z);
  return g;
}

/** Rounded box from ranges [x0,x1], [y0,y1], [z0,z1]; `r` rounds every edge. */
function rbox(xr, yr, zr, r, { fs = 3, segs = 2, rc = null } = {}) {
  const pts = [[zr[0], yr[0]], [zr[1], yr[0]], [zr[1], yr[1]], [zr[0], yr[1]]];
  return side(pts, Math.abs(xr[1] - xr[0]), r, { r: rc ?? r, fs, segs, x: (xr[0] + xr[1]) * 0.5 });
}

/** Ellipsoid centred at the origin. */
function ellipsoid(rx, ry, rz, segs = 16, rows = 10) {
  const prof = [];
  for (let k = 0; k <= rows; k++) {
    const a = (k / rows) * Math.PI;
    prof.push([Math.sin(a), Math.cos(a)]);
  }
  const g = lathe(prof, segs);
  return scaleGeo(g, rx, ry, rz);
}

/** Non-uniform scale with correct normals. */
function scaleGeo(g, sx, sy, sz) {
  const p = g.attributes.position;
  const n = g.attributes.normal;
  for (let i = 0; i < p.count; i++) {
    p.setXYZ(i, p.getX(i) * sx, p.getY(i) * sy, p.getZ(i) * sz);
    _v.set(n.getX(i) / sx, n.getY(i) / sy, n.getZ(i) / sz).normalize();
    n.setXYZ(i, _v.x, _v.y, _v.z);
  }
  return g;
}

/** Scale X by a function of (y, z) (stock width profiles), fixing normals approximately. */
function widthProfile(g, fn) {
  const p = g.attributes.position;
  const n = g.attributes.normal;
  for (let i = 0; i < p.count; i++) {
    const s = fn(p.getY(i), p.getZ(i));
    p.setX(i, p.getX(i) * s);
    _v.set(n.getX(i) / s, n.getY(i), n.getZ(i)).normalize();
    n.setXYZ(i, _v.x, _v.y, _v.z);
  }
  return g;
}

function xform(g, x = 0, y = 0, z = 0, rx = 0, ry = 0, rz = 0, order = "XYZ") {
  _e.set(rx, ry, rz, order);
  _q.setFromEuler(_e);
  _v.set(x, y, z);
  _m.compose(_v, _q, _s1);
  g.applyMatrix4(_m);
  return g;
}

/* --- Surface detail: curvature-driven wear, UV projection, merging --- */

/**
 * Per-vertex convexity (≈ mean curvature, 1/2R) → aWear in [-1, 1]:
 * positive on convex edges (worn bright), negative in creases (grime).
 */
function computeWear(geo) {
  const pos = geo.attributes.position.array;
  const nor = geo.attributes.normal.array;
  const index = geo.index.array;
  const n = pos.length / 3;
  geo.computeBoundingBox();
  const mn = geo.boundingBox.min;
  const q = 4e-5;
  const map = new Map();
  const id = new Int32Array(n);
  let m = 0;
  for (let i = 0; i < n; i++) {
    const kx = Math.round((pos[i * 3] - mn.x) / q);
    const ky = Math.round((pos[i * 3 + 1] - mn.y) / q);
    const kz = Math.round((pos[i * 3 + 2] - mn.z) / q);
    const key = (kx * 65536 + ky) * 65536 + kz;
    let k = map.get(key);
    if (k === undefined) {
      k = m++;
      map.set(key, k);
    }
    id[i] = k;
  }
  const P = new Float64Array(m * 3);
  const N = new Float64Array(m * 3);
  for (let i = 0; i < n; i++) {
    const k = id[i] * 3;
    P[k] = pos[i * 3];
    P[k + 1] = pos[i * 3 + 1];
    P[k + 2] = pos[i * 3 + 2];
    N[k] += nor[i * 3];
    N[k + 1] += nor[i * 3 + 1];
    N[k + 2] += nor[i * 3 + 2];
  }
  for (let k = 0; k < m; k++) {
    const l = Math.hypot(N[k * 3], N[k * 3 + 1], N[k * 3 + 2]) || 1;
    N[k * 3] /= l;
    N[k * 3 + 1] /= l;
    N[k * 3 + 2] /= l;
  }
  const acc = new Float64Array(m);
  const cnt = new Float64Array(m);
  for (let t = 0; t < index.length; t += 3) {
    for (let e = 0; e < 3; e++) {
      const a = id[index[t + e]];
      const b = id[index[t + ((e + 1) % 3)]];
      if (a === b) continue;
      const dx = P[b * 3] - P[a * 3];
      const dy = P[b * 3 + 1] - P[a * 3 + 1];
      const dz = P[b * 3 + 2] - P[a * 3 + 2];
      const d2 = dx * dx + dy * dy + dz * dz;
      if (d2 < 1e-14) continue;
      acc[a] -= (N[a * 3] * dx + N[a * 3 + 1] * dy + N[a * 3 + 2] * dz) / d2;
      acc[b] += (N[b * 3] * dx + N[b * 3 + 1] * dy + N[b * 3 + 2] * dz) / d2;
      cnt[a]++;
      cnt[b]++;
    }
  }
  let w = new Float64Array(m);
  for (let k = 0; k < m; k++) {
    const c = cnt[k] ? acc[k] / cnt[k] : 0;
    w[k] = c > 0 ? smoothstep(22, 240, c) : -smoothstep(22, 240, -c);
  }
  // Two relaxation passes so wear fades softly away from the edge.
  for (let pass = 0; pass < 2; pass++) {
    const sum = new Float64Array(m);
    const num = new Float64Array(m);
    for (let t = 0; t < index.length; t += 3) {
      for (let e = 0; e < 3; e++) {
        const a = id[index[t + e]];
        const b = id[index[t + ((e + 1) % 3)]];
        sum[a] += w[b];
        num[a]++;
        sum[b] += w[a];
        num[b]++;
      }
    }
    const nw = new Float64Array(m);
    for (let k = 0; k < m; k++) nw[k] = num[k] ? w[k] * 0.5 + (sum[k] / num[k]) * 0.5 : w[k];
    w = nw;
  }
  const out = new Float32Array(n);
  for (let i = 0; i < n; i++) out[i] = w[id[i]];
  geo.setAttribute("aWear", new THREE.BufferAttribute(out, 1));
}

/** Metric UV projection so texel density is consistent across parts. */
function projectUV(geo, mode, scale) {
  const p = geo.attributes.position.array;
  const nr = geo.attributes.normal.array;
  const count = p.length / 3;
  const uv = new Float32Array(count * 2);
  const s = 1 / scale;
  for (let i = 0; i < count; i++) {
    const x = p[i * 3];
    const y = p[i * 3 + 1];
    const z = p[i * 3 + 2];
    let u;
    let v;
    if (mode === "axial") {
      u = -z;
      v = x + y;
    } else if (mode === "axialX") {
      u = x;
      v = y - z;
    } else {
      const ax = Math.abs(nr[i * 3]);
      const ay = Math.abs(nr[i * 3 + 1]);
      const az = Math.abs(nr[i * 3 + 2]);
      if (ax >= ay && ax >= az) {
        u = z;
        v = y;
      } else if (ay >= az) {
        u = x;
        v = z;
      } else {
        u = x;
        v = y;
      }
    }
    uv[i * 2] = u * s;
    uv[i * 2 + 1] = v * s;
  }
  geo.setAttribute("uv", new THREE.BufferAttribute(uv, 2));
}

function mergeGeometries(list) {
  let vc = 0;
  let ic = 0;
  for (const g of list) {
    vc += g.attributes.position.count;
    ic += g.index.count;
  }
  const pos = new Float32Array(vc * 3);
  const nor = new Float32Array(vc * 3);
  const uv = new Float32Array(vc * 2);
  const wear = new Float32Array(vc);
  const idx = vc > 65535 ? new Uint32Array(ic) : new Uint16Array(ic);
  let vo = 0;
  let io = 0;
  for (const g of list) {
    const c = g.attributes.position.count;
    pos.set(g.attributes.position.array, vo * 3);
    nor.set(g.attributes.normal.array, vo * 3);
    uv.set(g.attributes.uv.array, vo * 2);
    if (g.attributes.aWear) wear.set(g.attributes.aWear.array, vo);
    const src = g.index.array;
    for (let i = 0; i < src.length; i++) idx[io + i] = src[i] + vo;
    vo += c;
    io += src.length;
    g.dispose();
  }
  const out = new THREE.BufferGeometry();
  out.setAttribute("position", new THREE.BufferAttribute(pos, 3));
  out.setAttribute("normal", new THREE.BufferAttribute(nor, 3));
  out.setAttribute("uv", new THREE.BufferAttribute(uv, 2));
  out.setAttribute("aWear", new THREE.BufferAttribute(wear, 1));
  out.setIndex(new THREE.BufferAttribute(idx, 1));
  out.computeBoundingSphere();
  return out;
}

/** Collects finished geometry per material and merges it: one draw call per material per part. */
class Parts {
  constructor() {
    this.byMat = new Map();
  }

  add(geo, mat, matrix = null) {
    if (matrix) geo.applyMatrix4(matrix);
    computeWear(geo);
    projectUV(geo, mat.userData.uvMode || "axial", mat.userData.uvScale || 0.2);
    let list = this.byMat.get(mat);
    if (!list) this.byMat.set(mat, (list = []));
    list.push(geo);
    return geo;
  }

  build(name = "") {
    const group = new THREE.Group();
    group.name = name;
    for (const [mat, list] of this.byMat) {
      const mesh = new THREE.Mesh(mergeGeometries(list), mat);
      mesh.frustumCulled = false;
      group.add(mesh);
    }
    this.byMat.clear();
    return group;
  }
}

/** Finish a single geometry for use outside Parts (morph meshes). */
function finish(geo, mat) {
  computeWear(geo);
  projectUV(geo, mat.userData.uvMode || "axial", mat.userData.uvScale || 0.2);
  return geo;
}

/* --- Hands --- */

// Right hand, hand-local frame: wrist at the origin, fingers along -Z, palm
// facing -Y, thumb on the -X side. The left hand is the same geometry mirrored.
const FINGERS = [
  { x: -0.029, f: 0.093, len: [0.043, 0.026, 0.021], r: 0.0093, spread: -0.07 },
  { x: -0.0095, f: 0.097, len: [0.047, 0.029, 0.023], r: 0.0096, spread: -0.015 },
  { x: 0.0105, f: 0.094, len: [0.044, 0.027, 0.022], r: 0.0091, spread: 0.04 },
  { x: 0.0285, f: 0.086, len: [0.034, 0.021, 0.019], r: 0.0081, spread: 0.1 },
];

function fingerSegment(len, r0, r1, tip, segs) {
  const prof = [];
  const hs = 4;
  for (let k = 0; k <= hs; k++) {
    const a = (k / hs) * HALF_PI;
    prof.push([r0 * Math.sin(a), r0 * Math.cos(a)]);
  }
  prof.push([(r0 + r1) * 0.53, -len * 0.5]);
  for (let k = 0; k <= hs; k++) {
    const a = HALF_PI - (k / hs) * HALF_PI;
    prof.push([r1 * Math.sin(a), -len - r1 * Math.cos(a) * (tip ? 1.12 : 1)]);
  }
  return lathe(prof, segs, { sy: 0.92 });
}

/**
 * A gloved hand with cuff, strap and canvas sleeve, posed for one grip.
 * pose = { curl: [[a,b,c] × 4], spread?: [4], thumb: { yaw, roll, pitch, curl: [a, b] }, arm: [x, y, z] }
 */
function buildHand(L, pose, detail) {
  const P = new Parts();
  const S = Math.round(14 * detail);
  const m = new THREE.Matrix4();
  const t = new THREE.Matrix4();

  // Palm: a pillowy rounded slab, plus the thenar / hypothenar pads.
  const palm = extrude(
    roundCorners([[-0.031, 0.0], [0.031, 0.0], [0.042, 0.052], [0.039, 0.083], [0.019, 0.095], [-0.006, 0.099], [-0.03, 0.094], [-0.044, 0.074], [-0.045, 0.044], [-0.039, 0.016]], 0.012, 4),
    0.029,
    0.0128,
    { segs: 4 },
  );
  palm.rotateX(-HALF_PI);
  P.add(palm, L.glove);
  P.add(xform(ellipsoid(0.0165, 0.0115, 0.031, S, 9), -0.026, -0.008, -0.034, 0, 0.3, 0), L.glove);
  P.add(xform(ellipsoid(0.012, 0.0095, 0.03, S, 8), 0.029, -0.008, -0.042, 0, -0.1, 0), L.glove);

  // Fingers: three lathed phalanges per finger, chained through the curl joints.
  const knuckles = [];
  for (let fi = 0; fi < 4; fi++) {
    const F = FINGERS[fi];
    const curl = pose.curl[fi];
    m.makeTranslation(F.x, 0.0015, -F.f + 0.009);
    m.multiply(t.makeRotationY(F.spread + (pose.spread ? pose.spread[fi] : 0)));
    for (let s = 0; s < 3; s++) {
      m.multiply(t.makeRotationX(-curl[s]));
      const len = F.len[s];
      const r0 = F.r * (s === 0 ? 1.06 : s === 1 ? 0.98 : 0.93);
      const r1 = F.r * (s === 0 ? 0.99 : s === 1 ? 0.94 : 0.9);
      P.add(fingerSegment(len, r0, r1, s === 2, S), L.glove, m);
      if (s === 0) {
        // Padded panel over the proximal phalanx (knuckle detail).
        const pad = ellipsoid(r0 * 0.78, r0 * 0.4, len * 0.3, S, 7);
        pad.translate(0, r0 * 0.8, -len * 0.52);
        P.add(pad, L.gloveDark, m);
        _v.set(0, 0, 0).applyMatrix4(m);
        knuckles.push(_v.clone());
      }
      if (s === 1) {
        // Seam ridge across the middle joint.
        const ridge = ellipsoid(r0 * 0.9, r0 * 0.3, 0.0022, S, 5);
        ridge.translate(0, r0 * 0.72, 0.0005);
        P.add(ridge, L.gloveDark, m);
      }
      m.multiply(t.makeTranslation(0, 0, -len));
    }
  }

  // Thumb: metacarpal (blended into the thenar pad) + two phalanges.
  const T = pose.thumb;
  m.makeTranslation(-0.025, -0.006, -0.014);
  m.multiply(t.makeRotationY(T.yaw));
  m.multiply(t.makeRotationZ(T.roll));
  m.multiply(t.makeRotationX(-T.pitch));
  const tl = [0.04, 0.032, 0.028];
  const tr = [0.0128, 0.0114, 0.0104];
  for (let s = 0; s < 3; s++) {
    if (s > 0) m.multiply(t.makeRotationX(-T.curl[s - 1]));
    P.add(fingerSegment(tl[s], tr[s], tr[s] * 0.95, s === 2, S), L.glove, m);
    if (s === 1) {
      const pad = ellipsoid(tr[s] * 0.75, tr[s] * 0.38, tl[s] * 0.3, S, 7);
      pad.translate(0, tr[s] * 0.82, -tl[s] * 0.5);
      P.add(pad, L.gloveDark, m);
    }
    m.multiply(t.makeTranslation(0, 0, -tl[s]));
  }

  // Knuckle bar: a padded strip across the backs of the knuckles.
  const kpts = knuckles.map((k) => [k.x, k.y + 0.011, k.z + 0.004]);
  kpts.unshift([kpts[0][0] - 0.008, kpts[0][1] - 0.002, kpts[0][2] + 0.004]);
  kpts.push([kpts[kpts.length - 1][0] + 0.007, kpts[kpts.length - 1][1] - 0.002, kpts[kpts.length - 1][2] + 0.005]);
  P.add(sweep(spline(kpts), { rx: 0.0062, ry: 0.0042, plane: Y_AXIS, segs: S, rows: 16 }), L.gloveDark);
  // Back-of-hand panel stitched over the metacarpals.
  P.add(xform(ellipsoid(0.03, 0.0055, 0.034, S + 4, 9), 0.0, 0.0122, -0.045), L.gloveDark);

  // Gauntlet cuff with a hook-and-loop strap.
  const cuff = lathe([[0.0305, -0.02], [0.034, -0.002], [0.0372, 0.03], [0.0405, 0.058], [0.0418, 0.0635], [0.0402, 0.0668], [0.0365, 0.0672]], S + 10, { sy: 0.78 });
  P.add(cuff, L.glove);
  P.add(lathe([[0.0388, 0.019], [0.0402, 0.0205], [0.0404, 0.0405], [0.039, 0.042]], S + 10, { sy: 0.8 }), L.strap);
  P.add(rbox([-0.012, 0.012], [0.0298, 0.0352], [0.017, 0.044], 0.0024), L.strap);

  // Canvas sleeve with a rolled hem and soft wrinkles, bent at the wrist.
  const sleeve = lathe(
    [[0.0425, 0.052], [0.0478, 0.0535], [0.0495, 0.06], [0.049, 0.068], [0.0468, 0.073], [0.0475, 0.1], [0.05, 0.16], [0.053, 0.24], [0.055, 0.33], [0.056, 0.44]],
    S + 14,
    {
      sy: 0.86,
      rFn: (th, z) => 1 + smoothstep(0.075, 0.12, z) * (0.034 * Math.sin(th * 3 + z * 47) * Math.sin(z * 23 + 1.3) + 0.018 * Math.sin(th * 5 - z * 31)),
    },
  );
  const arm = pose.arm || [0, 0, 0];
  _e.set(arm[0], arm[1], arm[2], "XYZ");
  _q.setFromEuler(_e);
  _m2.makeTranslation(0, 0, -0.035);
  _m.compose(_v.set(0, 0, 0.035), _q, _s1).multiply(_m2);
  P.add(sleeve, L.sleeve, _m);

  return P.build("hand");
}

/** Place a hand group in gun space; mirrored for the left hand. */
function mountHand(handMesh, mirror) {
  const holder = new THREE.Group();
  const inner = new THREE.Group();
  if (mirror) inner.scale.x = -1;
  inner.add(handMesh);
  holder.add(inner);
  return holder;
}

/* --- Small shared parts --- */

/** Crossbow bolt: carbon shaft, three vanes, orange nock, three-blade broadhead. Tip at z=0, nock at +0.43. */
function buildBoltParts(P, L, S) {
  const len = 0.43;
  P.add(lathe(cylProfile(0.0042, len - 0.004, 0.034, 0.0006, false), S), L.carbon);
  P.add(lathe([[0, len + 0.006], [0.0036, len + 0.006], [0.0046, len + 0.002], [0.0046, len - 0.008], [0.0042, len - 0.01]], S), L.orange);
  // Ferrule + broadhead blades.
  P.add(lathe([[0.0042, 0.036], [0.0047, 0.03], [0.0047, 0.022], [0.0032, 0.008], [0.0006, 0.0005], [0, 0]], S), L.steel);
  for (let k = 0; k < 3; k++) {
    const blade = side([[0.034, 0.0], [0.03, 0.0], [0.004, 0.0], [0.03, 0.0125], [0.034, 0.0105]], 0.0008, 0.0003, { r: 0.0006, fs: 2, segs: 1 });
    xform(blade, 0, 0, 0, 0, 0, (k * TAU) / 3 + 0.3);
    P.add(blade, L.steel);
  }
  // Vanes (parabolic), one cock vane in white-ish orange.
  for (let k = 0; k < 3; k++) {
    const pts = [];
    for (let i = 0; i <= 10; i++) {
      const s = i / 10;
      pts.push([len - 0.012 - s * 0.068, 0.0038 + Math.sin(s * Math.PI * 0.92) * 0.0125 * (1 - s * 0.35)]);
    }
    pts.push([len - 0.084, 0.0038]);
    const vane = side(pts.reverse(), 0.0007, 0.00028, { r: 0.0015, fs: 2, segs: 1 });
    xform(vane, 0, 0, 0, 0, 0, (k * TAU) / 3 + HALF_PI);
    P.add(vane, k === 0 ? L.orange : L.red);
  }
}

/** Standalone crossbow bolt mesh (tip at the origin, shaft along +Z) for world projectiles. */
export function createBoltMesh() {
  const L = library();
  const P = new Parts();
  buildBoltParts(P, L, 10);
  const g = P.build("crossbow-bolt");
  g.traverse((o) => {
    if (o.isMesh) o.castShadow = true;
  });
  return g;
}

function casingGeometry(L, kind, S) {
  const P = new Parts();
  if (kind === "shell") {
    P.add(lathe([[0, 0.0], [0.0108, 0.0], [0.0118, -0.0012], [0.0112, -0.0016], [0.0108, -0.012], [0.0104, -0.0125], [0, -0.0125]], S), L.brass);
    P.add(lathe([[0.0103, -0.012], [0.0103, -0.064], [0.0096, -0.0665], [0.003, -0.0675], [0, -0.0675]], S), L.shell);
  } else {
    const len = kind === "rifle" ? 0.056 : kind === "sniper" ? 0.098 : 0.032;
    const r = kind === "sniper" ? 0.0102 : kind === "rifle" ? 0.006 : 0.0058;
    const neck = kind === "pistol" ? r * 0.98 : r * 0.62;
    P.add(lathe([[0, 0], [r * 1.02, 0], [r * 1.04, -0.0012], [r * 0.9, -0.0022], [r, -0.0034], [r * 0.97, -len * 0.78], [neck, -len * 0.86], [neck, -len], [neck * 0.8, -len], [neck * 0.8, -len + 0.004]], S), L.brass);
  }
  return P.build("casing");
}

/* --- Muzzle flash --- */

let FLASH_TEX = null;

function flashTexture() {
  if (FLASH_TEX) return FLASH_TEX;
  const W = 256;
  const H = 128;
  const data = new Uint8Array(W * H * 4);
  const n = tileNoise(331);
  for (let j = 0; j < H; j++) {
    for (let i = 0; i < W; i++) {
      const o = (j * W + i) * 4;
      let a;
      let heat;
      if (i < 128) {
        // Front view: hot core with a ragged six-point star.
        const x = (i - 63.5) / 64;
        const y = (j - 63.5) / 64;
        const r = Math.hypot(x, y);
        const ang = Math.atan2(y, x);
        const spikes = Math.pow(Math.abs(Math.cos(ang * 3)), 6) * (0.75 + 0.25 * n(ang * 3 + 7, 0.5, 64, 64));
        const reach = 0.3 + spikes * 0.62;
        a = clamp(1 - r / reach, 0, 1);
        a = a * a * (0.8 + 0.2 * n(x * 6 + 8, y * 6 + 8, 64, 64));
        heat = clamp(1 - r * 2.2, 0, 1);
      } else {
        // Side view: a tapered plume along u.
        const x = (i - 128) / 127;
        const y = (j - 63.5) / 64;
        const width = 0.15 + 0.7 * Math.sin(Math.min(1, x * 1.25) * Math.PI * 0.85) * (1 - x * 0.55);
        const lobe = 0.75 + 0.25 * n(x * 8 + 3, y * 2 + 4, 64, 64);
        a = clamp(1 - Math.abs(y) / Math.max(0.02, width * lobe), 0, 1) * clamp((1 - x) * 1.6, 0, 1) * clamp(x * 9, 0, 1);
        a *= a;
        heat = clamp(1 - x * 1.6 - Math.abs(y) * 1.5, 0, 1);
      }
      data[o] = to8(lerp(1.0, 1.0, heat));
      data[o + 1] = to8(lerp(0.55, 0.92, heat));
      data[o + 2] = to8(lerp(0.18, 0.72, heat));
      data[o + 3] = to8(a);
    }
  }
  const t = new THREE.DataTexture(data, W, H, THREE.RGBAFormat);
  t.magFilter = THREE.LinearFilter;
  t.minFilter = THREE.LinearMipmapLinearFilter;
  t.generateMipmaps = true;
  t.colorSpace = THREE.SRGBColorSpace;
  t.needsUpdate = true;
  FLASH_TEX = t;
  return t;
}

/** Additive flash: a front "flower" quad plus two crossed side plumes along the barrel. */
function buildFlash(size) {
  const mat = new THREE.MeshBasicMaterial({
    map: flashTexture(),
    color: new THREE.Color(3.2, 2.6, 2.0),
    transparent: true,
    blending: THREE.AdditiveBlending,
    depthWrite: false,
    side: THREE.DoubleSide,
    toneMapped: true,
  });
  const pos = [];
  const uv = [];
  const idx = [];
  const quad = (p, q) => {
    const b = pos.length / 3;
    for (let k = 0; k < 4; k++) {
      pos.push(p[k][0], p[k][1], p[k][2]);
      uv.push(q[k][0], q[k][1]);
    }
    idx.push(b, b + 1, b + 2, b, b + 2, b + 3);
  };
  quad([[-0.5, -0.5, -0.05], [0.5, -0.5, -0.05], [0.5, 0.5, -0.05], [-0.5, 0.5, -0.05]], [[0, 0], [0.5, 0], [0.5, 1], [0, 1]]);
  quad([[0, -0.32, 0.05], [0, -0.32, -1.5], [0, 0.32, -1.5], [0, 0.32, 0.05]], [[0.5, 0], [1, 0], [1, 1], [0.5, 1]]);
  quad([[-0.32, 0, 0.05], [-0.32, 0, -1.5], [0.32, 0, -1.5], [0.32, 0, 0.05]], [[0.5, 0], [1, 0], [1, 1], [0.5, 1]]);
  const g = new THREE.BufferGeometry();
  g.setAttribute("position", new THREE.Float32BufferAttribute(pos, 3));
  g.setAttribute("uv", new THREE.Float32BufferAttribute(uv, 2));
  g.setIndex(idx);
  const mesh = new THREE.Mesh(g, mat);
  mesh.frustumCulled = false;
  mesh.renderOrder = 10;
  mesh.visible = false;
  mesh.userData.size = size;
  return mesh;
}

/* --- Animation helpers --- */

/** Piecewise keyframe track with smoothstep easing; keys = [[t, v], ...]. */
function track(t, keys) {
  if (t <= keys[0][0]) return keys[0][1];
  for (let i = 1; i < keys.length; i++) {
    if (t <= keys[i][0]) {
      const k0 = keys[i - 1];
      const k1 = keys[i];
      return k0[1] + (k1[1] - k0[1]) * smoothstep(k0[0], k1[0], t);
    }
  }
  return keys[keys.length - 1][1];
}

/** 0 → 1 → 0 window: rises over [a, b], holds, falls over [c, d]. */
function windowed(t, a, b, c, d) {
  return smoothstep(a, b, t) * (1 - smoothstep(c, d, t));
}

/* --- Rig scaffolding --- */

function newRig(id) {
  return {
    id,
    gun: new THREE.Group(),
    muzzle: new THREE.Object3D(),
    sights: null, // { rear: [x,y,z], front: [x,y,z], eye }
    hip: null, // { pos: [x,y,z], rot: [x,y,z] }
    scoped: false,
    flashSize: 0.12,
    kick: { back: 0.04, rot: 0.12, yaw: 0.02 },
    casing: null,
    eject: new THREE.Vector3(),
    ejectDir: new THREE.Vector3(1, 0.6, 0.3),
    right: null,
    left: null,
    rightBase: { pos: new THREE.Vector3(), quat: new THREE.Quaternion() },
    leftBase: { pos: new THREE.Vector3(), quat: new THREE.Quaternion() },
    animate: null,
  };
}

function setBase(base, holder, pos, rot, order = "XYZ") {
  base.pos.set(pos[0], pos[1], pos[2]);
  _e.set(rot[0], rot[1], rot[2], order);
  base.quat.setFromEuler(_e);
  holder.position.copy(base.pos);
  holder.quaternion.copy(base.quat);
}

/** Right hand around a pistol grip (palm on the right side, thumb over the left). */
const GRIP_POSE = {
  curl: [[0.55, 0.85, 0.55], [1.45, 1.35, 0.9], [1.5, 1.35, 0.95], [1.5, 1.3, 0.95]],
  spread: [0.05, 0, -0.02, -0.06],
  thumb: { yaw: 0.65, roll: -0.95, pitch: 0.35, curl: [0.25, 0.3] },
  arm: [0.05, 0.75, 0],
};

/** Left hand cradling a forend from below. */
const FOREND_POSE = {
  curl: [[0.75, 0.75, 0.45], [0.85, 0.85, 0.5], [0.95, 0.9, 0.5], [1.05, 0.9, 0.55]],
  spread: [-0.04, 0, 0.03, 0.06],
  thumb: { yaw: 0.5, roll: -0.35, pitch: 0.15, curl: [0.12, 0.15] },
  arm: [-0.1, -0.3, 0],
};

/* --- Guns --- */

function buildRevolver(L, S) {
  const rig = newRig("revolver");
  const yc = 0.034; // cylinder axis
  const yb = 0.0475; // bore axis (top chamber)
  const ys = 0.0685; // sight line
  const P = new Parts();

  // Frame: top strap, front, bottom and recoil shield around the cylinder window.
  P.add(rbox([-0.0098, 0.0098], [0.0552, 0.0628], [-0.047, 0.036], 0.0028), L.blued);
  P.add(rbox([-0.0115, 0.0115], [0.0045, 0.0628], [-0.049, -0.0285], 0.0038), L.blued);
  P.add(rbox([-0.011, 0.011], [0.0045, 0.0132], [-0.049, 0.031], 0.003), L.blued);
  P.add(rbox([-0.012, 0.012], [0.0045, 0.0628], [0.0188, 0.041], 0.0045), L.blued);
  P.add(side([[0.03, 0.006], [0.041, 0.04], [0.047, 0.058], [0.056, 0.062], [0.065, 0.05], [0.072, 0.02], [0.081, -0.03], [0.086, -0.083], [0.046, -0.088], [0.035, -0.04], [0.027, -0.004]], 0.0176, 0.004, { r: 0.006 }), L.blued);
  // Walnut grip panels with checkering, and the grip screw.
  P.add(side([[0.031, 0.004], [0.04, 0.03], [0.05, 0.037], [0.061, 0.035], [0.069, 0.012], [0.0785, -0.03], [0.0832, -0.0805], [0.048, -0.0852], [0.037, -0.04], [0.03, -0.006]], 0.0368, 0.0128, { r: 0.008, segs: 4 }), L.walnutChecker);
  P.add(xform(lathe([[0, 0.0026], [0.0024, 0.0022], [0.0036, 0.0008], [0.0038, 0]], S), -0.0182, -0.026, 0.057, 0, -HALF_PI, 0), L.steel);
  P.add(xform(lathe([[0, 0.0026], [0.0024, 0.0022], [0.0036, 0.0008], [0.0038, 0]], S), 0.0182, -0.026, 0.057, 0, HALF_PI, 0), L.steel);
  // Barrel with crowned muzzle, full underlug, rib and ramp front sight.
  P.add(xform(lathe([[0.0094, -0.028], [0.0098, -0.03], [0.0098, -0.187], [0.0094, -0.1905], [0.0082, -0.1918], [0.0057, -0.1918], [0.0055, -0.17]], S * 3), 0, yb, 0), L.blued);
  P.add(side([[-0.0285, 0.0215], [-0.1905, 0.0215], [-0.1905, 0.0405], [-0.0285, 0.0405]], 0.0172, 0.0045, { r: [0.002, 0.008, 0.002, 0.002] }), L.blued);
  P.add(side([[-0.03, 0.0552], [-0.191, 0.0552], [-0.191, 0.0618], [-0.03, 0.0618]], 0.0092, 0.0016, { r: 0.0015 }), L.blued);
  P.add(side([[-0.168, 0.0605], [-0.1715, ys], [-0.1855, ys], [-0.1875, 0.0605]], 0.0034, 0.0007, { r: 0.001, fs: 2 }), L.blued);
  P.add(rbox([-0.00178, 0.00178], [0.0636, ys - 0.0012], [-0.1765, -0.1728], 0.0005, { fs: 1, segs: 1 }), L.red);
  // Rear sight: base and two ears forming the notch.
  P.add(rbox([-0.0064, 0.0064], [0.0624, ys], [0.017, 0.033], 0.0012), L.blued);
  P.add(rbox([0.0021, 0.0064], [ys - 0.001, ys + 0.0036], [0.02, 0.032], 0.0008), L.blued);
  P.add(rbox([-0.0064, -0.0021], [ys - 0.001, ys + 0.0036], [0.02, 0.032], 0.0008), L.blued);
  // Cylinder latch (left side) — case-coloured like the hammer and trigger.
  P.add(rbox([-0.0129, -0.0108], [0.029, 0.037], [0.024, 0.04], 0.0009), L.caseColor);
  // Trigger guard and trigger.
  P.add(sweep(spline([[0, 0.008, -0.03], [0, -0.012, -0.031], [0, -0.0255, -0.016], [0, -0.0255, 0.012], [0, -0.006, 0.028], [0, 0.004, 0.031]]), { rx: 0.0026, ry: 0.0045, plane: X_AXIS, segs: S, rows: 28 }), L.blued);
  P.add(sweep(spline([[0, 0.008, -0.001], [0, -0.002, -0.004], [0, -0.011, -0.002], [0, -0.0155, 0.004]]), { rx: 0.0021, ry: 0.0034, plane: X_AXIS, segs: S, rows: 14 }), L.caseColor);
  rig.gun.add(P.build("revolver-frame"));

  // Hammer (pivots for the double-action cycle).
  const hammer = new THREE.Group();
  hammer.position.set(0, 0.047, 0.04);
  const HP = new Parts();
  const hg = side([[0.034, 0.05], [0.035, 0.066], [0.041, 0.075], [0.053, 0.083], [0.064, 0.0855], [0.066, 0.081], [0.056, 0.0735], [0.05, 0.062], [0.047, 0.046]], 0.0076, 0.0016, { r: 0.0025 });
  hg.translate(0, -0.047, -0.04);
  HP.add(hg, L.caseColor);
  hammer.add(HP.build("hammer"));
  rig.gun.add(hammer);

  // Crane → cylinder: the crane swings out to the left about an axis along Z.
  const crane = new THREE.Group();
  crane.position.set(-0.0075, 0.0125, 0);
  const CP = new Parts();
  CP.add(sweep(segment([0, 0, -0.0293], [0.0075, yc - 0.0125, -0.0293]), { rx: 0.0034, ry: 0.0034, plane: Z_AXIS, segs: S, rows: 4 }), L.blued);
  CP.add(xform(lathe([[0.0027, -0.026], [0.0027, -0.061], [0.0033, -0.0625], [0.0034, -0.069], [0.0026, -0.0705], [0, -0.0705]], S, { rFn: (th, z) => (z < -0.062 ? 1 + 0.06 * Math.max(0, Math.cos(th * 18)) : 1) }), 0.0075, yc - 0.0125, 0), L.blued);
  crane.add(CP.build("crane"));
  const cylinder = new THREE.Group();
  cylinder.position.set(0.0075, yc - 0.0125, 0);
  const YP = new Parts();
  const flute = (th, z) => {
    const mask = smoothstep(0.0118, 0.0078, z) * smoothstep(-0.0218, -0.0178, z);
    const g = -Math.cos(6 * th);
    return 1 - 0.14 * smoothstep(0.2, 1, g) * mask;
  };
  const cprof = [[0, 0.0175], [0.0042, 0.0175], [0.0042, 0.0188], [0.0175, 0.0188], [0.0192, 0.0184], [0.0201, 0.0176], [0.0205, 0.0163], [0.0205, 0.013]];
  for (let z = 0.0115; z > -0.0225; z -= 0.0025) cprof.push([0.0205, z]);
  cprof.push([0.0205, -0.0232], [0.0201, -0.0249], [0.019, -0.0262], [0.0172, -0.0268], [0.0052, -0.0268], [0.0052, -0.025], [0, -0.025]);
  YP.add(lathe(cprof, Math.round(96 * Math.max(0.6, S / 14)), { rFn: flute }), L.blued);
  const star = [];
  for (let k = 0; k < 12; k++) {
    const a = (k / 12) * TAU;
    const r = k % 2 ? 0.0034 : 0.0057;
    star.push([Math.cos(a) * r, Math.sin(a) * r]);
  }
  YP.add(frontProfile(star, 0.0018, 0.0004, { r: 0.0006, fs: 2, segs: 1, z: 0.0193 }), L.steel);
  const rounds = new Parts();
  for (let k = 0; k < 6; k++) {
    const a = (k / 6) * TAU + HALF_PI;
    const cx = Math.cos(a) * 0.0135;
    const cy = Math.sin(a) * 0.0135;
    YP.add(xform(lathe([[0, 0.019], [0.0061, 0.019], [0.0061, 0.0182]], S), cx, cy, 0), L.bore);
    rounds.add(xform(lathe([[0, 0.01945], [0.0056, 0.01945], [0.0062, 0.0192], [0.0062, 0.0183]], S + 4), cx, cy, 0), L.brass);
    rounds.add(xform(lathe([[0, 0.0196], [0.002, 0.0196], [0.0022, 0.01935]], S), cx, cy, 0), L.steel);
  }
  cylinder.add(YP.build("cylinder"));
  const loaded = rounds.build("cylinder-rounds");
  cylinder.add(loaded);
  crane.add(cylinder);
  rig.gun.add(crane);

  // Speedloader (left hand brings it in during the reload).
  const loader = new THREE.Group();
  const SP = new Parts();
  SP.add(lathe([[0, 0.0], [0.0165, 0.0], [0.0172, -0.002], [0.0172, -0.011], [0.0165, -0.013], [0.006, -0.013], [0.005, -0.022], [0.0068, -0.026], [0.006, -0.03], [0, -0.03]].map(([r, z]) => [r, -z]), S + 10, { rFn: (th, z) => (z > 0.014 ? 1 + 0.05 * Math.max(0, Math.cos(th * 16)) : 1) }), L.polymer);
  for (let k = 0; k < 6; k++) {
    const a = (k / 6) * TAU + HALF_PI;
    SP.add(xform(lathe([[0, 0.002], [0.0058, 0.002], [0.0058, -0.024], [0.0049, -0.028], [0.0029, -0.032], [0, -0.0335]], S), Math.cos(a) * 0.0135, Math.sin(a) * 0.0135, 0), L.brass);
  }
  const loaderMesh = SP.build("speedloader");
  loader.add(loaderMesh);
  loader.visible = false;
  rig.gun.add(loader);

  rig.muzzle.position.set(0, yb, -0.193);
  rig.gun.add(rig.muzzle);
  rig.sights = { rear: [0, ys, 0.026], front: [0, ys, -0.18], eye: 0.34 };
  rig.hip = { pos: [0.118, -0.122, -0.31], rot: [0.03, 0.07, -0.05] };
  rig.flashSize = 0.13;
  rig.kick = { back: 0.05, rot: 0.32, yaw: 0.05 };
  rig.casing = "pistol";
  rig.eject.set(-0.027, 0.024, 0.026);

  // Hands: right on the grip, left only appears to reload.
  const right = mountHand(buildHand(L, GRIP_POSE, S / 14), false);
  rig.right = right;
  setBase(rig.rightBase, right, [0.034, -0.026, 0.126], [-0.38, 0.0, -HALF_PI]);
  rig.gun.add(right);
  const leftPose = {
    curl: [[0.7, 0.8, 0.5], [0.8, 0.9, 0.55], [0.9, 0.9, 0.55], [1.0, 0.9, 0.55]],
    thumb: { yaw: 0.6, roll: -0.5, pitch: 0.3, curl: [0.3, 0.3] },
    arm: [0.2, -0.4, 0],
  };
  const left = mountHand(buildHand(L, leftPose, S / 14), true);
  rig.left = left;
  setBase(rig.leftBase, left, [-0.06, -0.3, 0.12], [0.4, -0.6, Math.PI * 0.6], "YXZ");
  left.visible = false;
  rig.gun.add(left);

  const state = { cyl: 0, cylTarget: 0, hammer: 0, ejected: false };
  const swing = [[0, 0], [0.09, 0], [0.19, 1.35], [0.7, 1.35], [0.79, 0]];
  rig.animate = (st, off, dt) => {
    // Double action: on each shot the hammer falls; through the cycle it
    // cocks again while the cylinder indexes 60°.
    if (st.fired) state.cylTarget -= Math.PI / 3;
    // The shot is the hammer falling: show it slam home from full cock.
    state.hammer = st.cycle >= 0 ? 1 - smoothstep(0.0, 0.1, st.cycle) : 0;
    state.cyl += (state.cylTarget - state.cyl) * (1 - Math.exp(-dt * 18));
    hammer.rotation.x = 0.5 * state.hammer;
    cylinder.rotation.z = state.cyl;

    const t = st.reload;
    if (t >= 0) {
      crane.rotation.z = track(t, swing);
      // Gun rolls left and tips the muzzle up to dump the empties, then levels to load.
      off.rx += track(t, [[0, 0], [0.12, 0.42], [0.24, 0.95], [0.32, 0.25], [0.7, 0.2], [0.78, 0.05], [0.95, 0]]);
      off.rz += track(t, [[0, 0], [0.12, 0.75], [0.7, 0.7], [0.76, -0.1], [0.86, 0.05], [1, 0]]);
      off.px += track(t, [[0, 0], [0.15, -0.055], [0.8, -0.05], [1, 0]]);
      off.py += track(t, [[0, 0], [0.15, 0.03], [0.32, 0.015], [0.8, 0.02], [1, 0]]);
      if (t > 0.22 && !state.ejected) {
        state.ejected = true;
        loaded.visible = false;
        st.ejectCount = 6;
      }
      if (t > 0.57) loaded.visible = true;
      // Speedloader + left hand: in from below-left, insert, twist, withdraw.
      const vis = t > 0.3 && t < 0.78;
      loader.visible = vis && t < 0.62;
      left.visible = vis;
      if (vis) {
        const ins = smoothstep(0.42, 0.56, t);
        const away = smoothstep(0.62, 0.77, t);
        const come = 1 - smoothstep(0.3, 0.44, t);
        _a.set(0.0075 - 0.0075, yc - 0.0125, 0).applyAxisAngle(Z_AXIS, crane.rotation.z);
        const cx = -0.0075 + _a.x;
        const cy = 0.0125 + _a.y;
        loader.position.set(cx - come * 0.05 - away * 0.03, cy - come * 0.11 - away * 0.12, lerp(0.05, 0.0205, ins) + come * 0.06 + away * 0.05);
        loader.rotation.z = smoothstep(0.55, 0.6, t) * 0.4;
        left.position.set(loader.position.x - 0.012, loader.position.y - 0.035, loader.position.z + 0.095);
        _e.set(0.15, -0.35, Math.PI * 0.62, "YXZ");
        left.quaternion.setFromEuler(_e);
      }
    } else {
      crane.rotation.z = 0;
      loader.visible = false;
      left.visible = false;
      loaded.visible = true;
      state.ejected = false;
    }
  };
  return rig;
}

/** Shared walnut stock (pistol grip) used by the shotgun, rifle and crossbow. */
function buildStock(P, L, o) {
  const pts = o.points;
  const g = side(pts, o.width, o.bevel, { r: o.r ?? 0.012, fs: 5, segs: 4 });
  widthProfile(g, o.widthFn);
  P.add(g, o.mat || L.walnut);
}

function buildShotgun(L, S) {
  const rig = newRig("shotgun");
  const yb = 0.042;
  const bx = 0.0119;
  const P = new Parts();

  // Boxlock action in case colours, fences, top tang, lever and safety.
  P.add(side([[-0.1135, 0.012], [-0.108, 0.002], [-0.095, -0.006], [-0.04, -0.008], [0.03, -0.008], [0.044, 0.004], [0.046, 0.04], [0.04, 0.0548], [-0.058, 0.0548], [-0.058, 0.025], [-0.1, 0.0248], [-0.111, 0.021]], 0.0462, 0.0055, { r: 0.006, segs: 3 }), L.caseColor);
  for (const sx of [-1, 1]) {
    P.add(xform(lathe([[0.0136, -0.058], [0.0136, -0.054], [0.0128, -0.046], [0.0098, -0.038], [0.006, -0.034]], S * 2), sx * bx, yb, 0), L.caseColor);
  }
  P.add(rbox([-0.0085, 0.0085], [0.044, 0.0545], [0.035, 0.112], 0.003, { rc: [0.002, 0.008, 0.002, 0.002] }), L.caseColor);
  P.add(topProfile([[-0.004, 0.03], [0.004, 0.03], [0.02, 0.055], [0.027, 0.07], [0.021, 0.075], [0.006, 0.06], [-0.003, 0.046]], 0.0045, 0.0012, { r: 0.004, y: 0.0565 }), L.blued);
  P.add(rbox([-0.0035, 0.0035], [0.0548, 0.0578], [0.078, 0.091], 0.0012), L.blued);
  // Trigger guard and the two triggers.
  P.add(sweep(spline([[0, -0.004, -0.034], [0, -0.03, -0.03], [0, -0.042, -0.006], [0, -0.04, 0.026], [0, -0.03, 0.046], [0, -0.035, 0.062], [0, -0.055, 0.085]]), { rx: 0.0024, ry: 0.0048, plane: X_AXIS, segs: S, rows: 30 }), L.blued);
  for (const tz of [0, 0.016]) {
    P.add(sweep(spline([[0, -0.006, tz - 0.001], [0, -0.016, tz - 0.004], [0, -0.025, tz - 0.002], [0, -0.03, tz + 0.004]]), { rx: 0.002, ry: 0.0032, plane: X_AXIS, segs: S, rows: 12 }), L.caseColor);
  }
  // Stock with pistol grip, steel grip cap and rubber pad.
  buildStock(P, L, {
    points: [[0.04, 0.052], [0.11, 0.0485], [0.16, 0.046], [0.4, 0.033], [0.405, -0.1], [0.2, -0.038], [0.14, -0.04], [0.113, -0.094], [0.078, -0.098], [0.06, -0.035], [0.044, -0.01], [0.04, 0.0]],
    width: 0.042,
    bevel: 0.0155,
    r: 0.014,
    widthFn: (y, z) => lerp(0.8, 1, smoothstep(0.13, 0.28, z)) * lerp(1, 0.92, smoothstep(-0.03, -0.09, y) * (1 - smoothstep(0.15, 0.2, z))),
  });
  P.add(side([[0.402, 0.034], [0.418, 0.034], [0.418, -0.102], [0.402, -0.102]], 0.04, 0.008, { r: 0.008 }), L.rubber);
  P.add(side([[0.077, -0.095], [0.112, -0.091], [0.113, -0.097], [0.078, -0.101]], 0.026, 0.004, { r: 0.002 }), L.blued);
  rig.gun.add(P.build("shotgun-action"));

  // Barrels assembly hinges about the cross pin.
  const hinge = new THREE.Group();
  hinge.position.set(0, 0.009, -0.104);
  const BP = new Parts();
  const off = (g) => g.translate(0, -0.009, 0.104);
  const bprof = [[0.0099, -0.075], [0.0099, -0.058], [0.0128, -0.058], [0.0128, -0.12]];
  for (let k = 1; k <= 10; k++) {
    const s = k / 10;
    bprof.push([lerp(0.0128, 0.0104, Math.pow(s, 0.6)), lerp(-0.12, -0.72, s)]);
  }
  bprof.push([0.0106, -0.735], [0.0103, -0.7445], [0.0091, -0.7455], [0.0091, -0.72]);
  for (const sx of [-1, 1]) {
    BP.add(off(xform(lathe(bprof, S * 3), sx * bx, yb, 0)), L.blued);
    BP.add(off(xform(lathe([[0, -0.075], [0.0099, -0.075]], S * 2, { flip: true }), sx * bx, yb, 0)), L.bore);
  }
  BP.add(off(side([[-0.06, 0.0505], [-0.742, 0.0505], [-0.742, 0.0555], [-0.06, 0.0555]], 0.0104, 0.0016, { r: 0.0015 })), L.parkerized);
  BP.add(off(side([[-0.13, 0.0286], [-0.742, 0.0286], [-0.742, 0.0336], [-0.13, 0.0336]], 0.0084, 0.0016, { r: 0.0015 })), L.blued);
  BP.add(off(xform(ellipsoid(0.0021, 0.0021, 0.0021, S, 8), 0, 0.0576, -0.737)), L.brass);
  BP.add(off(side([[-0.058, 0.019], [-0.103, 0.0165], [-0.103, 0.031], [-0.058, 0.031]], 0.021, 0.003, { r: 0.004 })), L.blued);
  // Splinter forend with its iron and latch.
  BP.add(off(side([[-0.128, 0.032], [-0.36, 0.032], [-0.372, 0.021], [-0.356, 0.0055], [-0.16, 0.0035], [-0.132, 0.008]], 0.047, 0.0125, { r: 0.008, segs: 4 })), L.walnut);
  BP.add(off(side([[-0.112, 0.0065], [-0.15, 0.0045], [-0.15, 0.031], [-0.112, 0.031]], 0.042, 0.004, { r: 0.004 })), L.caseColor);
  BP.add(off(rbox([-0.0045, 0.0045], [0.0005, 0.0045], [-0.268, -0.238], 0.0014)), L.blued);
  const barrels = BP.build("barrels");
  hinge.add(barrels);
  // Chambered shells (visible with the action open).
  const shellsIn = new THREE.Group();
  for (const sx of [-1, 1]) {
    const sh = casingGeometry(L, "shell", S);
    sh.position.set(sx * bx, yb - 0.009, -0.058 + 0.104 + 0.0004);
    shellsIn.add(sh);
  }
  hinge.add(shellsIn);
  rig.gun.add(hinge);

  // Fresh shells the right hand carries in during the reload.
  const shellsHand = new THREE.Group();
  for (const sx of [-1, 1]) {
    const sh = casingGeometry(L, "shell", S);
    sh.position.set(sx * bx, 0, 0);
    shellsHand.add(sh);
  }
  shellsHand.visible = false;
  rig.gun.add(shellsHand);

  rig.muzzle.position.set(bx, yb, -0.746);
  rig.gun.add(rig.muzzle);
  rig.sights = { rear: [0, 0.0578, -0.06], front: [0, 0.0597, -0.737], eye: 0.16 };
  rig.hip = { pos: [0.112, -0.108, -0.2], rot: [0.035, 0.045, -0.03] };
  rig.flashSize = 0.2;
  rig.kick = { back: 0.075, rot: 0.3, yaw: 0.05 };
  rig.casing = "shell";

  const right = mountHand(buildHand(L, GRIP_POSE, S / 14), false);
  rig.right = right;
  setBase(rig.rightBase, right, [0.034, -0.036, 0.168], [-0.42, 0.0, -HALF_PI]);
  rig.gun.add(right);
  const left = mountHand(buildHand(L, FOREND_POSE, S / 14), true);
  rig.left = left;
  // The left hand rides on the forend, so it follows the barrels when they drop.
  setBase(rig.leftBase, left, [-0.072, -0.022 - 0.009, -0.255 + 0.104], [0.12, -0.95, Math.PI], "YXZ");
  hinge.add(left);

  const state = { ejected: false, barrel: 0 };
  const shellsArr = shellsIn.children;
  rig.animate = (st, o) => {
    // Alternate barrels: right fires first, then left.
    rig.muzzle.position.x = st.mag % 2 === 1 ? bx : -bx;
    const t = st.reload;
    if (t >= 0) {
      const open = track(t, [[0, 0], [0.08, 0], [0.18, 1], [0.8, 1], [0.86, 0]]);
      hinge.rotation.x = -0.6 * open;
      o.rx += track(t, [[0, 0], [0.12, 0.12], [0.25, 0.3], [0.45, 0.18], [0.8, 0.22], [0.87, -0.06], [1, 0]]);
      o.rz += track(t, [[0, 0], [0.15, 0.25], [0.8, 0.28], [0.9, 0], [1, 0]]);
      o.px += track(t, [[0, 0], [0.15, -0.05], [0.82, -0.055], [1, 0]]);
      o.py += track(t, [[0, 0], [0.15, 0.04], [0.82, 0.045], [1, 0]]);
      o.pz += track(t, [[0, 0], [0.15, 0.04], [0.82, 0.04], [1, 0]]);
      if (t > 0.2 && !state.ejected) {
        state.ejected = true;
        st.ejectCount = 2;
      }
      const loadedIn = t > 0.66;
      for (const s of shellsArr) s.visible = !state.ejected || loadedIn;
      // Right hand leaves the grip, fetches two shells and drops them in.
      const away = windowed(t, 0.24, 0.38, 0.72, 0.86);
      const fetch = windowed(t, 0.3, 0.42, 0.44, 0.52);
      shellsHand.visible = t > 0.44 && t < 0.66;
      // Breech position (moves with the barrels).
      _a.set(0, yb - 0.009, -0.058 + 0.104 + 0.004).applyAxisAngle(X_AXIS, hinge.rotation.x).add(hinge.position);
      shellsHand.position.set(_a.x, _a.y + 0.012 + (1 - smoothstep(0.52, 0.64, t)) * 0.03, _a.z + 0.02 + (1 - smoothstep(0.52, 0.64, t)) * 0.05);
      shellsHand.rotation.x = hinge.rotation.x + (1 - smoothstep(0.52, 0.64, t)) * 0.5;
      _b.set(_a.x + 0.035, _a.y + 0.045, _a.z + 0.12);
      const hand = rig.right;
      hand.position.lerpVectors(rig.rightBase.pos, _b, away);
      hand.position.y -= fetch * 0.16;
      hand.position.x += fetch * 0.05;
      _e.set(0.2, 0.25, -HALF_PI * 0.4, "XYZ");
      _q.setFromEuler(_e);
      hand.quaternion.slerpQuaternions(rig.rightBase.quat, _q, away);
    } else {
      hinge.rotation.x = 0;
      state.ejected = false;
      shellsHand.visible = false;
      for (const s of shellsArr) s.visible = true;
      rig.right.position.copy(rig.rightBase.pos);
      rig.right.quaternion.copy(rig.rightBase.quat);
    }
  };
  // Ejected empties come from the breech.
  rig.eject.set(0, yb + 0.01, -0.05);
  rig.ejectDir.set(0.3, 1.2, 1.4);
  return rig;
}

function buildCrossbow(L, S) {
  const rig = newRig("crossbow");
  const yr = 0.045; // rail top
  const yBolt = yr + 0.0043;
  const zLatch = -0.056;
  const zRiser = -0.5;
  const P = new Parts();

  // Stock: ash with a pistol grip and a long forestock up to the riser.
  buildStock(P, L, {
    points: [[-0.47, yr - 0.004], [-0.06, yr - 0.004], [0.0, 0.036], [0.12, 0.052], [0.35, 0.047], [0.36, -0.08], [0.18, -0.035], [0.13, -0.035], [0.105, -0.095], [0.072, -0.098], [0.055, -0.028], [0.0, -0.02], [-0.2, -0.012], [-0.43, 0.0], [-0.468, 0.016]],
    width: 0.046,
    bevel: 0.015,
    r: 0.014,
    mat: L.ash,
    widthFn: (y, z) => (z < 0 ? lerp(1.05, 0.95, smoothstep(-0.05, -0.45, z)) : lerp(0.74, 0.92, smoothstep(0.12, 0.26, z))),
  });
  P.add(side([[0.357, 0.048], [0.372, 0.048], [0.372, -0.082], [0.357, -0.082]], 0.038, 0.008, { r: 0.008 }), L.rubber);
  // Flight rail with twin guide rails.
  P.add(rbox([-0.013, 0.013], [yr - 0.012, yr - 0.002], [-0.505, -0.03], 0.003), L.anodized);
  for (const sx of [-1, 1]) P.add(rbox([sx * 0.0035, sx * 0.0085], [yr - 0.003, yr + 0.0015], [-0.49, -0.07], 0.0012), L.steel);
  // Trigger box + latch claws + safety.
  P.add(rbox([-0.017, 0.017], [0.026, 0.061], [-0.062, 0.035], 0.006, { rc: [0.006, 0.012, 0.01, 0.006] }), L.parkerized);
  for (const sx of [-1, 1]) P.add(side([[-0.06, 0.06], [-0.052, 0.066], [-0.046, 0.06]], 0.004, 0.001, { r: 0.002, x: sx * 0.005 }), L.steel);
  P.add(rbox([-0.021, -0.017], [0.04, 0.047], [-0.01, 0.012], 0.0015), L.red);
  // Rear peep sight on a post.
  P.add(rbox([-0.0025, 0.0025], [0.06, 0.071], [-0.02, -0.012], 0.0012), L.parkerized);
  P.add(xform(lathe([[0.0042, -0.0015], [0.0058, -0.0015], [0.0062, 0], [0.0058, 0.0015], [0.0042, 0.0015], [0.0038, 0], [0.0042, -0.0015]], S * 2), 0, 0.0765, -0.016), L.parkerized);
  // Riser with front post and hood, plus the stirrup.
  P.add(rbox([-0.034, 0.034], [0.01, 0.064], [zRiser - 0.03, zRiser + 0.012], 0.008), L.parkerized);
  P.add(side([[zRiser - 0.006, 0.064], [zRiser - 0.01, 0.0765], [zRiser - 0.014, 0.0765], [zRiser - 0.018, 0.064]], 0.0026, 0.0007, { r: 0.0012, fs: 2 }), L.steel);
  P.add(xform(lathe([[0.0068, -0.004], [0.0082, -0.004], [0.0084, 0.004], [0.007, 0.004]], S * 2, { arc: 0.5 }), 0, 0.0765, zRiser - 0.012), L.parkerized);
  P.add(sweep(spline([[-0.042, 0.03, zRiser - 0.028], [-0.052, 0.005, zRiser - 0.075], [-0.03, -0.012, zRiser - 0.112], [0.03, -0.012, zRiser - 0.112], [0.052, 0.005, zRiser - 0.075], [0.042, 0.03, zRiser - 0.028]]), { rx: 0.0038, ry: 0.0038, plane: new THREE.Vector3(0, 0.88, -0.47), segs: S, rows: 40 }), L.parkerized);
  // Trigger guard + trigger.
  P.add(sweep(spline([[0, -0.016, -0.028], [0, -0.036, -0.022], [0, -0.042, 0.005], [0, -0.038, 0.034], [0, -0.03, 0.05]]), { rx: 0.0024, ry: 0.0045, plane: X_AXIS, segs: S, rows: 24 }), L.parkerized);
  P.add(sweep(spline([[0, -0.014, 0.0], [0, -0.022, -0.003], [0, -0.03, 0.0], [0, -0.034, 0.006]]), { rx: 0.002, ry: 0.0033, plane: X_AXIS, segs: S, rows: 12 }), L.steel);
  rig.gun.add(P.build("crossbow-body"));

  // Limbs + string as morphing meshes: base = drawn (cocked), morph = relaxed.
  const limbPath = (relaxed, sx) => {
    const pts = relaxed
      ? [[0.03, -0.5], [0.12, -0.536], [0.225, -0.56], [0.3, -0.558], [0.345, -0.538]]
      : [[0.03, -0.5], [0.115, -0.522], [0.2, -0.522], [0.255, -0.496], [0.282, -0.462]];
    return spline(pts.map(([x, z]) => [sx * x, yBolt - 0.003, z]));
  };
  const limbGeo = (relaxed) => {
    const parts = [];
    for (const sx of [-1, 1]) {
      parts.push(sweep(limbPath(relaxed, sx), { rx: 0.0062, ry: 0.019, plane: Y_AXIS, segs: S + 4, rows: 30, ends: true, taper: (t) => lerp(1.12, 0.62, t) + 0.25 * smoothstep(0.92, 1, t) }));
    }
    return mergeGeometries(parts);
  };
  const limbBase = finish(limbGeo(false), L.limb);
  const limbRelaxed = limbGeo(true);
  limbBase.morphAttributes.position = [limbRelaxed.attributes.position];
  limbBase.morphAttributes.normal = [limbRelaxed.attributes.normal];
  const limbs = new THREE.Mesh(limbBase, L.limb);
  limbs.frustumCulled = false;
  limbs.morphTargetInfluences = [0];
  rig.gun.add(limbs);
  const tipOf = (relaxed, sx, out) => limbPath(relaxed, sx)(1, out);
  const stringGeo = (relaxed) => {
    const l = tipOf(relaxed, -1, new THREE.Vector3());
    const r = tipOf(relaxed, 1, new THREE.Vector3());
    const mid = relaxed ? new THREE.Vector3(0, yBolt, r.z - 0.004) : new THREE.Vector3(0, yBolt, zLatch);
    const path = (t, out) => {
      if (t < 0.5) out.lerpVectors(l, mid, t * 2);
      else out.lerpVectors(mid, r, (t - 0.5) * 2);
      return out;
    };
    return sweep(path, { rx: 0.0019, ry: 0.0019, plane: Y_AXIS, segs: 8, rows: 40, ends: false });
  };
  const strBase = finish(stringGeo(false), L.string);
  const strRelaxed = stringGeo(true);
  strBase.morphAttributes.position = [strRelaxed.attributes.position];
  strBase.morphAttributes.normal = [strRelaxed.attributes.normal];
  const string = new THREE.Mesh(strBase, L.string);
  string.frustumCulled = false;
  string.morphTargetInfluences = [0];
  rig.gun.add(string);

  // The loaded bolt.
  const BP = new Parts();
  buildBoltParts(BP, L, S);
  const bolt = BP.build("bolt");
  bolt.position.set(0, yBolt, zLatch - 0.433);
  rig.gun.add(bolt);

  rig.muzzle.position.set(0, yBolt, zRiser - 0.03);
  rig.gun.add(rig.muzzle);
  rig.sights = { rear: [0, 0.0765, -0.016], front: [0, 0.0765, zRiser - 0.012], eye: 0.11 };
  rig.hip = { pos: [0.105, -0.112, -0.2], rot: [0.03, 0.05, -0.04] };
  rig.flashSize = 0;
  rig.kick = { back: 0.025, rot: 0.08, yaw: 0.01 };

  const right = mountHand(buildHand(L, GRIP_POSE, S / 14), false);
  rig.right = right;
  setBase(rig.rightBase, right, [0.033, -0.034, 0.163], [-0.4, 0.0, -HALF_PI]);
  rig.gun.add(right);
  const left = mountHand(buildHand(L, FOREND_POSE, S / 14), true);
  rig.left = left;
  setBase(rig.leftBase, left, [-0.07, -0.028, -0.23], [0.12, -0.95, Math.PI], "YXZ");
  rig.gun.add(left);

  const state = { drawn: 1 };
  rig.animate = (st, o) => {
    const t = st.reload;
    if (st.fired) state.drawn = 0;
    let drawn = st.mag > 0 ? 1 : state.drawn;
    let boltVis = st.mag > 0;
    let boltSlide = 0;
    if (t >= 0) {
      o.rx += track(t, [[0, 0], [0.15, -0.32], [0.6, -0.3], [0.75, -0.12], [1, 0]]);
      o.rz += track(t, [[0, 0], [0.15, 0.2], [0.7, 0.22], [1, 0]]);
      o.py += track(t, [[0, 0], [0.15, 0.03], [0.7, 0.03], [1, 0]]);
      o.pz += track(t, [[0, 0], [0.15, 0.05], [0.7, 0.05], [1, 0]]);
      // Left hand hooks the string and draws it back to the latch.
      const draw = smoothstep(0.22, 0.52, t);
      drawn = Math.max(drawn, draw);
      const toString = windowed(t, 0.12, 0.22, 0.52, 0.6);
      const toBolt = windowed(t, 0.58, 0.66, 0.8, 0.9);
      boltVis = boltVis || t > 0.62;
      boltSlide = (1 - smoothstep(0.66, 0.8, t)) * 0.09;
      _a.set(-0.02, yBolt + 0.03, lerp(-0.47, zLatch + 0.03, draw));
      _b.set(-0.035, yBolt + 0.03, zLatch - 0.1 + boltSlide * 0.5);
      const hand = rig.left;
      hand.position.copy(rig.leftBase.pos);
      hand.position.lerp(_a, toString);
      hand.position.lerp(_b, toBolt);
      _e.set(-0.3, -1.4, Math.PI * 0.95, "YXZ");
      _q.setFromEuler(_e);
      hand.quaternion.slerpQuaternions(rig.leftBase.quat, _q, Math.max(toString, toBolt));
    } else {
      rig.left.position.copy(rig.leftBase.pos);
      rig.left.quaternion.copy(rig.leftBase.quat);
    }
    state.drawn = drawn;
    const relax = 1 - drawn;
    limbs.morphTargetInfluences[0] = relax;
    string.morphTargetInfluences[0] = relax;
    bolt.visible = boltVis;
    bolt.position.z = zLatch - 0.433 + boltSlide;
  };
  return rig;
}

/** Scope: tube, bells, turrets, rings and coated glass, built along Z on the axis y = ys. */
function buildScope(P, L, S, o) {
  const { ys, z1, r, rObj, zObj, rOc, zOc, rings, ringBase, big, zTurret: zt } = o;
  const seg = S * 3;
  const at = (g) => g.translate(0, ys, 0);
  const zF = zObj - (big ? 0.07 : 0); // front end (sunshade on the big scope)
  // One continuous outer skin, front lip → objective bell → tube → ocular bell → rear lip.
  P.add(at(lathe([
    [rObj - 0.0035, zF + 0.004], [rObj - 0.0035, zF], [rObj - 0.0009, zF], [rObj, zF + 0.0012],
    [rObj, zObj + 0.032], [rObj - 0.0012, zObj + 0.035], [r + 0.0016, zObj + 0.056], [r, zObj + 0.062],
    [r, z1 - 0.003], [r + 0.001, z1], [rOc * 0.86, z1 + 0.012], [rOc, z1 + 0.024],
    [rOc, zOc - 0.0015], [rOc - 0.0012, zOc], [rOc - 0.0035, zOc], [rOc - 0.0035, zOc - 0.004],
  ], seg)), L.anodized);
  if (big) P.add(at(lathe([[rObj + 0.0003, zObj - 0.004], [rObj + 0.0011, zObj - 0.002], [rObj + 0.0011, zObj + 0.002], [rObj + 0.0003, zObj + 0.004]], seg)), L.anodized);
  // Power-selector ring with grip ridges, and the eyepiece rubber.
  P.add(at(lathe([[rOc + 0.0003, zOc - 0.036], [rOc + 0.0014, zOc - 0.034], [rOc + 0.0014, zOc - 0.022], [rOc + 0.0003, zOc - 0.02]], seg, { rFn: (th) => 1 + 0.035 * Math.max(0, Math.cos(th * 30)) })), L.rubber);
  P.add(at(lathe([[rOc + 0.0005, zOc - 0.011], [rOc + 0.0013, zOc - 0.009], [rOc + 0.0013, zOc - 0.0012], [rOc - 0.0004, zOc + 0.0016], [rOc - 0.0036, zOc + 0.0016]], seg)), L.rubber);
  // Glass: domed ocular and objective lenses over dark inner discs.
  P.add(at(lathe([[0, zOc - 0.0026], [(rOc - 0.0035) * 0.6, zOc - 0.003], [rOc - 0.0035, zOc - 0.0038]], seg)), L.glass);
  P.add(at(lathe([[0, zOc - 0.012], [rOc - 0.0035, zOc - 0.012]], seg, { flip: true })), L.lensInner);
  P.add(at(lathe([[0, zF + 0.0035], [rObj - 0.0035, zF + 0.0045]], seg)), L.glass);
  P.add(at(lathe([[0, zF + 0.014], [rObj - 0.0035, zF + 0.014]], seg)), L.lensInner);
  // Turret saddle + elevation (top) and windage (right); parallax knob (left) on the big scope.
  P.add(at(lathe([[r + 0.0002, zt - 0.022], [r + 0.0042, zt - 0.016], [r + 0.0046, zt + 0.016], [r + 0.0002, zt + 0.022]], seg)), L.anodized);
  const tr = big ? 0.0155 : 0.0108;
  const th = big ? 0.029 : 0.017;
  const turret = (axisRot, len, rad) => {
    const g = lathe([[rad * 0.8, r - 0.001], [rad * 0.8, r + 0.004], [rad, r + 0.0055], [rad, r + len - 0.003], [rad - 0.0015, r + len], [0, r + len]], seg, {
      rFn: (t, z) => (z > r + len * 0.45 ? 1 + 0.035 * Math.max(0, Math.cos(t * 36)) : 1),
    });
    g.rotateX(-HALF_PI); // lathe axis Z → +Y
    g.rotateZ(axisRot);
    g.translate(0, ys, zt);
    return g;
  };
  P.add(turret(0, th, tr), L.anodized);
  P.add(turret(-HALF_PI, th * 0.85, tr * 0.95), L.anodized);
  if (big) P.add(turret(HALF_PI, th * 0.55, tr * 1.25), L.anodized);
  // Zero index line on the elevation cap.
  P.add(rbox([-0.0005, 0.0005], [ys + r + th - 0.0018, ys + r + th + 0.0003], [zt - tr - 0.0004, zt - tr + 0.0028], 0.0002, { fs: 1, segs: 1 }), L.steel);
  // Rings with bases and cap screws.
  for (const rz of rings) {
    const w = big ? 0.016 : 0.012;
    P.add(at(lathe([[r + 0.0003, rz - w / 2], [r + 0.003, rz - w / 2], [r + 0.0036, rz - w / 2 + 0.0012], [r + 0.0036, rz + w / 2 - 0.0012], [r + 0.003, rz + w / 2], [r + 0.0003, rz + w / 2]], seg)), L.anodized);
    const bw = big ? 0.012 : 0.008;
    P.add(rbox([-bw, bw], [ringBase, ys - r + 0.001], [rz - w / 2, rz + w / 2], 0.0025), L.anodized);
    for (const sx of [-1, 1]) {
      P.add(xform(lathe([[0, 0.0022], [0.0018, 0.0019], [0.0024, 0.0006], [0.0024, 0]], S), sx * (r + 0.0042), ys + 0.004, rz, 0, sx * HALF_PI, 0), L.steel);
    }
  }
  return { ocular: [0, ys, zOc], objective: [0, ys, zF] };
}

function buildRifle(L, S) {
  const rig = newRig("rifle");
  const yb = 0.03;
  const ys = 0.081;
  const P = new Parts();

  // Receiver, front ring, recoil lug; barrel with a gentle taper and crown.
  P.add(xform(lathe([[0, 0.106], [0.0155, 0.106], [0.0168, 0.104], [0.0168, -0.08], [0.0174, -0.083], [0.0174, -0.122], [0.0162, -0.126], [0.013, -0.126]], S * 3), 0, yb, 0), L.blued);
  const bar = [[0.0128, -0.126], [0.0128, -0.18]];
  for (let k = 1; k <= 12; k++) {
    const s = k / 12;
    bar.push([lerp(0.0128, 0.0082, Math.pow(s, 0.8)), lerp(-0.18, -0.725, s)]);
  }
  bar.push([0.0078, -0.729], [0.0062, -0.7305], [0.0035, -0.7305], [0.0033, -0.71]);
  P.add(xform(lathe(bar, S * 3), 0, yb, 0), L.blued);
  // Scope bases on the receiver.
  for (const bz of [-0.104, 0.052]) P.add(rbox([-0.008, 0.008], [yb + 0.0145, yb + 0.022], [bz - 0.011, bz + 0.011], 0.0018), L.blued);
  // Walnut stock with schnabel forend, checkered wrist panel, pad and swivel studs.
  buildStock(P, L, {
    points: [[-0.425, 0.026], [-0.13, 0.027], [-0.125, 0.033], [0.106, 0.033], [0.13, 0.031], [0.2, 0.043], [0.43, 0.035], [0.44, -0.105], [0.2, -0.045], [0.142, -0.04], [0.118, -0.1], [0.084, -0.103], [0.066, -0.036], [0.05, -0.022], [-0.07, -0.025], [-0.13, -0.021], [-0.35, -0.006], [-0.41, 0.0], [-0.428, 0.013]],
    width: 0.044,
    bevel: 0.0158,
    r: 0.013,
    widthFn: (y, z) => (z < -0.13 ? lerp(1.0, 0.86, smoothstep(-0.15, -0.42, z)) : z < 0.12 ? (z > 0.045 && y < -0.01 ? 0.8 : 1.04) : lerp(0.78, 0.96, smoothstep(0.13, 0.27, z))),
  });
  P.add(side([[0.437, 0.036], [0.452, 0.036], [0.452, -0.107], [0.437, -0.107]], 0.04, 0.008, { r: 0.008 }), L.rubber);
  P.add(side([[0.083, -0.1], [0.117, -0.097], [0.118, -0.103], [0.084, -0.106]], 0.026, 0.004, { r: 0.002 }), L.blued);
  // Floorplate + trigger guard + trigger.
  P.add(rbox([-0.0125, 0.0125], [-0.029, -0.022], [-0.088, -0.018], 0.0025), L.blued);
  P.add(sweep(spline([[0, -0.024, -0.026], [0, -0.042, -0.02], [0, -0.048, 0.006], [0, -0.042, 0.035], [0, -0.03, 0.052], [0, -0.024, 0.06]]), { rx: 0.0025, ry: 0.0052, plane: X_AXIS, segs: S, rows: 24 }), L.blued);
  P.add(sweep(spline([[0, -0.02, 0.0], [0, -0.029, -0.003], [0, -0.037, 0.0], [0, -0.041, 0.006]]), { rx: 0.0021, ry: 0.0035, plane: X_AXIS, segs: S, rows: 12 }), L.steel);
  for (const sz of [-0.36, 0.33]) {
    const y0 = sz < 0 ? -0.004 : -0.07;
    P.add(xform(lathe(cylProfile(0.0035, 0, 0.008, 0.0008), S), 0, y0 - 0.004, sz, HALF_PI, 0, 0), L.blued);
  }
  // Scope (2.5×).
  const sc = buildScope(P, L, S, { ys, z0: -0.2, z1: 0.075, r: 0.0127, rObj: 0.0195, zObj: -0.2, rOc: 0.0185, zOc: 0.138, zTurret: -0.03, rings: [-0.104, 0.052], ringBase: yb + 0.02, big: false });
  rig.gun.add(P.build("rifle-body"));

  // Bolt: lifts and draws back to cycle.
  const bolt = new THREE.Group();
  bolt.position.set(0, yb, 0);
  const BP = new Parts();
  BP.add(lathe([[0.0088, -0.06], [0.0088, 0.104], [0.0118, 0.108], [0.0118, 0.124], [0.0105, 0.134], [0.006, 0.142], [0, 0.143]], S * 2), L.steel);
  BP.add(sweep(spline([[0.006, 0.0, 0.09], [0.022, -0.004, 0.094], [0.036, -0.016, 0.099], [0.042, -0.024, 0.103]]), { rx: 0.0032, ry: 0.0032, plane: planeOf([[0.006, 0.0, 0.09], [0.036, -0.016, 0.099], [0.042, -0.024, 0.103]]), segs: S, rows: 14, ends: false }), L.steel);
  BP.add(xform(ellipsoid(0.0092, 0.0092, 0.0092, S + 4, 10), 0.044, -0.028, 0.104), L.steel);
  bolt.add(BP.build("bolt"));
  rig.gun.add(bolt);

  rig.muzzle.position.set(0, yb, -0.731);
  rig.gun.add(rig.muzzle);
  rig.sights = { rear: sc.ocular, front: sc.objective, eye: 0.075 };
  rig.scoped = true;
  rig.hip = { pos: [0.11, -0.122, -0.2], rot: [0.035, 0.045, -0.035] };
  rig.flashSize = 0.17;
  rig.kick = { back: 0.06, rot: 0.24, yaw: 0.04 };
  rig.casing = "rifle";
  rig.eject.set(0.018, yb + 0.012, 0.04);

  const right = mountHand(buildHand(L, GRIP_POSE, S / 14), false);
  rig.right = right;
  setBase(rig.rightBase, right, [0.034, -0.035, 0.172], [-0.42, 0.0, -HALF_PI]);
  rig.gun.add(right);
  const left = mountHand(buildHand(L, FOREND_POSE, S / 14), true);
  rig.left = left;
  setBase(rig.leftBase, left, [-0.072, -0.03, -0.25], [0.1, -0.95, Math.PI], "YXZ");
  rig.gun.add(left);

  boltAnimation(rig, bolt, { lift: 1.05, travel: 0.088, knob: [0.044, -0.028, 0.104] }, (st, o) => {
    // Reload: bolt open, five rounds thumbed in from the top, bolt closed.
    const t = st.reload;
    o.rx += track(t, [[0, 0], [0.12, 0.05], [0.25, 0.14], [0.75, 0.14], [0.9, 0.04], [1, 0]]);
    o.rz += track(t, [[0, 0], [0.15, 0.35], [0.8, 0.35], [1, 0]]);
    o.px += track(t, [[0, 0], [0.15, -0.045], [0.8, -0.045], [1, 0]]);
    o.py += track(t, [[0, 0], [0.15, 0.035], [0.8, 0.035], [1, 0]]);
    const boltT = track(t, [[0, 0], [0.06, 0], [0.16, 0.5], [0.24, 1], [0.78, 1], [0.86, 0.5], [0.94, 0]]);
    const push = t > 0.3 && t < 0.72 ? Math.max(0, Math.sin(((t - 0.3) / 0.42) * Math.PI * 5)) : 0;
    const there = windowed(t, 0.26, 0.34, 0.68, 0.76);
    _a.set(-0.012, yb + 0.03 - push * 0.012, 0.03);
    rig.left.position.copy(rig.leftBase.pos).lerp(_a, there);
    _e.set(0.6, -1.2, Math.PI * 0.75, "YXZ");
    _q.setFromEuler(_e);
    rig.left.quaternion.slerpQuaternions(rig.leftBase.quat, _q, there);
    return boltT;
  });
  return rig;
}

/**
 * Bolt-action cycle shared by rifle and sniper: after each shot (st.cycle) and
 * during reloads the right hand leaves the grip, lifts and draws the bolt
 * (ejecting a case), runs it home and returns.
 */
function boltAnimation(rig, bolt, o, reloadFn) {
  const knob = new THREE.Vector3(...o.knob);
  const state = { ejected: false };
  rig.animate = (st, off) => {
    let b = 0;
    let handW = 0;
    if (st.reload >= 0) {
      b = reloadFn(st, off);
      handW = windowed(st.reload, 0.02, 0.1, 0.9, 0.99);
      if (st.reload < 0.02) state.ejected = false;
    } else {
      rig.left.position.copy(rig.leftBase.pos);
      rig.left.quaternion.copy(rig.leftBase.quat);
      if (st.cycle >= 0) {
        const t = st.cycle;
        b = track(t, [[0, 0], [0.16, 0], [0.32, 0.5], [0.48, 1], [0.64, 0.5], [0.78, 0]]);
        handW = windowed(t, 0.04, 0.16, 0.8, 0.96);
        off.rz += windowed(t, 0.1, 0.3, 0.7, 0.9) * 0.12;
        off.px -= windowed(t, 0.1, 0.3, 0.7, 0.9) * 0.012;
        if (t < 0.05) state.ejected = false;
      }
    }
    // b ∈ [0, 0.5]: lift the handle; [0.5, 1]: draw back.
    const lift = smoothstep(0, 0.5, b);
    const travel = smoothstep(0.5, 1, b);
    bolt.rotation.z = lift * o.lift;
    bolt.position.z = travel * o.travel;
    if (travel > 0.85 && !state.ejected && (st.cycle >= 0 || st.reload >= 0)) {
      state.ejected = true;
      st.ejectCount = st.cycle >= 0 ? 1 : 0;
    }
    if (travel < 0.2 && st.cycle < 0 && st.reload < 0) state.ejected = false;
    // Right hand rides the bolt knob.
    const hand = rig.right;
    if (handW > 0) {
      _a.copy(knob).applyAxisAngle(Z_AXIS, bolt.rotation.z).add(bolt.position);
      _b.set(_a.x + 0.026, _a.y - 0.03, _a.z + 0.085);
      hand.position.lerpVectors(rig.rightBase.pos, _b, handW);
      _e.set(-0.2, 0.55, -1.2, "XYZ");
      _q.setFromEuler(_e);
      hand.quaternion.slerpQuaternions(rig.rightBase.quat, _q, handW);
    } else {
      hand.position.copy(rig.rightBase.pos);
      hand.quaternion.copy(rig.rightBase.quat);
    }
  };
}

function buildSniper(L, S) {
  const rig = newRig("sniper");
  const yb = 0.034;
  const ys = 0.108;
  const P = new Parts();

  // Chassis: receiver block and round receiver top.
  P.add(side([[-0.175, 0.008], [0.12, 0.008], [0.124, 0.03], [0.12, 0.05], [-0.175, 0.05]], 0.052, 0.006, { r: 0.006 }), L.parkerized);
  P.add(xform(lathe(cylProfile(0.0205, 0.112, -0.17, 0.0016), S * 3), 0, yb, 0), L.parkerized);
  // Long top rail with cross slots.
  P.add(rbox([-0.0112, 0.0112], [0.052, 0.0605], [-0.57, 0.112], 0.0016), L.parkerized);
  for (let z = -0.562; z < 0.108; z += 0.01) P.add(rbox([-0.0113, 0.0113], [0.0605, 0.0638], [z, z + 0.0052], 0.0007, { fs: 1, segs: 1 }), L.parkerized);
  // Handguard: rounded-octagon tube in FDE with dark M-LOK slots.
  const hg = roundCorners([[-0.028, -0.016], [-0.016, -0.028], [0.016, -0.028], [0.028, -0.016], [0.028, 0.016], [0.016, 0.026], [-0.016, 0.026], [-0.028, 0.016]], 0.009, 4);
  P.add(frontProfile(hg, 0.42, 0.004, { segs: 3, z: -0.385 }).translate(0, yb, 0), L.fde);
  for (let k = 0; k < 4; k++) {
    const z = -0.235 - k * 0.075;
    for (const sx of [-1, 1]) P.add(rbox([sx * 0.0278, sx * 0.0284], [yb - 0.0055, yb + 0.0055], [z - 0.025, z + 0.025], 0.0003, { fs: 3, segs: 1, rc: 0.005 }), L.bore);
  }
  // Fluted heavy barrel + ported muzzle brake.
  const fl = (th, z) => 1 - 0.1 * smoothstep(0.3, 1, Math.cos(th * 6)) * smoothstep(-0.6, -0.63, z) * smoothstep(-0.97, -0.94, z);
  const bp = [[0.0158, -0.58]];
  for (let z = -0.6; z > -0.98; z -= 0.02) bp.push([0.0158, z]);
  bp.push([0.0158, -0.985]);
  P.add(xform(lathe(bp, S * 4, { rFn: fl }), 0, yb, 0), L.parkerized);
  P.add(xform(lathe([[0.013, -0.98], [0.013, -1.09]], S * 2), 0, yb, 0), L.bore);
  for (const bz of [-0.985, -1.032, -1.078]) P.add(xform(lathe(cylProfile(0.0215, bz, bz - 0.013, 0.0018, true), S * 3), 0, yb, 0), L.parkerized);
  for (const sy of [-1, 1]) P.add(rbox([-0.012, 0.012], [yb + sy * 0.0135, yb + sy * 0.0205], [-1.091, -0.982], 0.002), L.parkerized);
  // Bipod folded under the handguard.
  P.add(rbox([-0.022, 0.022], [yb - 0.044, yb - 0.026], [-0.585, -0.545], 0.005), L.anodized);
  for (const sx of [-1, 1]) {
    P.add(xform(lathe(cylProfile(0.0068, -0.55, -0.79, 0.0012), S * 2), sx * 0.017, yb - 0.038, 0), L.anodized);
    P.add(xform(lathe(cylProfile(0.0052, -0.79, -0.87, 0.001), S * 2), sx * 0.017, yb - 0.038, 0), L.steel);
    P.add(xform(ellipsoid(0.0085, 0.0085, 0.012, S, 8), sx * 0.017, yb - 0.038, -0.875), L.rubber);
  }
  // Skeleton stock with cheek riser and its adjustment knobs, thick pad.
  const stock = side(
    [[0.118, 0.05], [0.18, 0.05], [0.2, 0.068], [0.37, 0.066], [0.395, 0.058], [0.4, -0.07], [0.36, -0.076], [0.17, -0.026], [0.15, -0.015], [0.118, 0.008]],
    0.044,
    0.0065,
    { r: 0.008, holes: [[[0.215, 0.012], [0.345, 0.004], [0.345, -0.05], [0.25, -0.02]]] },
  );
  P.add(stock, L.fde);
  for (const kz of [0.235, 0.33]) P.add(xform(lathe([[0, 0.0], [0.0065, 0.0], [0.0068, -0.002], [0.0068, -0.008], [0.006, -0.0095], [0, -0.0095]], S + 6, { rFn: (th) => 1 + 0.06 * Math.max(0, Math.cos(th * 12)) }), -0.022, 0.056, kz, 0, -HALF_PI, 0), L.polymer);
  P.add(side([[0.398, 0.062], [0.425, 0.062], [0.425, -0.074], [0.398, -0.074]], 0.042, 0.009, { r: 0.009 }), L.rubber);
  // Stippled polymer pistol grip, guard and trigger.
  P.add(side([[0.033, 0.01], [0.068, 0.01], [0.104, -0.088], [0.072, -0.096], [0.052, -0.06], [0.046, -0.042], [0.04, -0.018]], 0.033, 0.0105, { r: 0.007, segs: 4 }), L.polymer);
  P.add(sweep(spline([[0, 0.006, -0.036], [0, -0.022, -0.032], [0, -0.03, -0.006], [0, -0.028, 0.022], [0, -0.01, 0.04]]), { rx: 0.003, ry: 0.006, plane: X_AXIS, segs: S, rows: 22 }), L.parkerized);
  P.add(sweep(spline([[0, 0.006, 0.0], [0, -0.004, -0.003], [0, -0.012, 0.0], [0, -0.016, 0.006]]), { rx: 0.0022, ry: 0.0036, plane: X_AXIS, segs: S, rows: 12 }), L.steel);
  // 6× scope with sunshade and parallax knob.
  const sc = buildScope(P, L, S, { ys, z0: -0.28, z1: 0.082, r: 0.017, rObj: 0.0305, zObj: -0.268, rOc: 0.0228, zOc: 0.168, zTurret: -0.045, rings: [-0.13, 0.055], ringBase: 0.0638, big: true });
  rig.gun.add(P.build("sniper-body"));

  // Detachable box magazine.
  const mag = new THREE.Group();
  const MP = new Parts();
  MP.add(rbox([-0.017, 0.017], [-0.072, 0.01], [-0.108, -0.032], 0.004), L.parkerized);
  for (let k = 0; k < 4; k++) MP.add(rbox([-0.0178, 0.0178], [-0.062 + k * 0.016, -0.054 + k * 0.016], [-0.1, -0.04], 0.0012, { fs: 2, segs: 1 }), L.parkerized);
  MP.add(rbox([-0.019, 0.019], [-0.078, -0.07], [-0.111, -0.029], 0.003), L.polymer);
  mag.add(MP.build("magazine"));
  rig.gun.add(mag);

  // Bolt with the big knob.
  const bolt = new THREE.Group();
  bolt.position.set(0, yb, 0);
  const BP = new Parts();
  BP.add(lathe([[0.0115, -0.05], [0.0115, 0.112], [0.0145, 0.116], [0.0145, 0.14], [0.012, 0.152], [0, 0.154]], S * 2), L.steel);
  BP.add(sweep(spline([[0.008, 0.0, 0.098], [0.026, -0.006, 0.101], [0.042, -0.018, 0.105]]), { rx: 0.0042, ry: 0.0042, plane: planeOf([[0.008, 0.0, 0.098], [0.026, -0.006, 0.101], [0.042, -0.018, 0.105]]), segs: S, rows: 12, ends: false }), L.steel);
  BP.add(xform(ellipsoid(0.0128, 0.0128, 0.0128, S + 6, 12), 0.046, -0.022, 0.106), L.polymer);
  bolt.add(BP.build("bolt"));
  rig.gun.add(bolt);

  rig.muzzle.position.set(0, yb, -1.092);
  rig.gun.add(rig.muzzle);
  rig.sights = { rear: sc.ocular, front: sc.objective, eye: 0.08 };
  rig.scoped = true;
  rig.hip = { pos: [0.112, -0.156, -0.245], rot: [0.04, 0.04, -0.035] };
  rig.flashSize = 0.3;
  rig.kick = { back: 0.1, rot: 0.42, yaw: 0.06 };
  rig.casing = "sniper";
  rig.eject.set(0.02, yb + 0.014, 0.04);

  const right = mountHand(buildHand(L, GRIP_POSE, S / 14), false);
  rig.right = right;
  setBase(rig.rightBase, right, [0.032, -0.033, 0.15], [-0.32, 0.0, -HALF_PI]);
  rig.gun.add(right);
  const left = mountHand(buildHand(L, FOREND_POSE, S / 14), true);
  rig.left = left;
  setBase(rig.leftBase, left, [-0.078, -0.005, -0.33], [0.1, -0.95, Math.PI], "YXZ");
  rig.gun.add(left);

  boltAnimation(rig, bolt, { lift: 0.95, travel: 0.11, knob: [0.046, -0.022, 0.106] }, (st, o) => {
    // Reload: drop the empty magazine, seat a fresh one, then run the bolt.
    const t = st.reload;
    o.rx += track(t, [[0, 0], [0.12, 0.08], [0.6, 0.1], [0.75, 0.05], [1, 0]]);
    o.rz += track(t, [[0, 0], [0.15, -0.3], [0.62, -0.32], [0.75, 0.1], [0.9, 0.12], [1, 0]]);
    o.px += track(t, [[0, 0], [0.15, -0.03], [0.62, -0.03], [1, 0]]);
    o.py += track(t, [[0, 0], [0.15, 0.04], [0.7, 0.04], [1, 0]]);
    const drop = track(t, [[0, 0], [0.12, 0], [0.26, 1], [0.38, 1.6], [0.44, 1], [0.56, 0]]);
    mag.position.y = -drop * 0.12;
    mag.position.z = drop * 0.02;
    mag.rotation.x = drop * 0.25;
    const hold = windowed(t, 0.08, 0.16, 0.56, 0.66);
    _a.set(-0.036, -0.066 + mag.position.y, -0.07 + mag.position.z);
    rig.left.position.copy(rig.leftBase.pos).lerp(_a, hold);
    _e.set(-0.2, -0.4, Math.PI * 0.85, "YXZ");
    _q.setFromEuler(_e);
    rig.left.quaternion.slerpQuaternions(rig.leftBase.quat, _q, hold);
    return track(t, [[0, 0], [0.62, 0], [0.7, 0.5], [0.76, 1], [0.84, 0.5], [0.92, 0]]);
  });
  const baseAnimate = rig.animate;
  rig.animate = (st, off, dt) => {
    if (st.reload < 0) {
      mag.position.set(0, 0, 0);
      mag.rotation.x = 0;
    }
    baseAnimate(st, off, dt);
  };
  return rig;
}

const BUILDERS = { revolver: buildRevolver, shotgun: buildShotgun, crossbow: buildCrossbow, rifle: buildRifle, sniper: buildSniper };

/* --- Viewmodel --- */

const CASING_POOL = 6;
const GRAVITY = 9.8;

/**
 * Build the first-person viewmodel for a weapon.
 * @param {string} weaponId  revolver | shotgun | crossbow | rifle | sniper
 * @param {{ detail?: number }} [opts]  detail < 1 lowers tessellation (low quality profile)
 * @returns {{ object: THREE.Group, muzzle: THREE.Object3D, scoped: boolean, update(dt: number, state: object): void, dispose(): void }}
 *
 * `object` is posed in camera space (the camera looks down -Z); WeaponSystem
 * parents it to its viewmodel camera. `update(dt, state)` reads:
 *   aim 0..1 (eased ADS), move 0..1+ (walk speed factor), sprint 0..1, crouch 0..1,
 *   lower 0..1 (switch / binoculars), reload -1 | 0..1, cycle -1 | 0..1 (bolt / hammer
 *   cycle after a shot), fired (a shot this frame), mag (rounds loaded), swayX / swayY
 *   (aim drift, radians), lagX / lagY (look inertia, radians), scoped (hide when the
 *   HUD scope takes over).
 */
export function createViewmodel(weaponId, { detail = 1 } = {}) {
  const build = BUILDERS[weaponId];
  if (!build) throw new Error(`Unknown weapon "${weaponId}"`);
  const L = library(detail < 0.8);
  const S = Math.max(8, Math.round(14 * detail));
  const rig = build(L, S);

  const object = new THREE.Group();
  object.name = `viewmodel-${weaponId}`;
  const pose = new THREE.Group();
  object.add(pose);
  pose.add(rig.gun);

  // Hip and ADS poses. ADS aligns the sight line with the view axis.
  const hipPos = new THREE.Vector3(...rig.hip.pos);
  const hipQuat = new THREE.Quaternion().setFromEuler(new THREE.Euler(...rig.hip.rot, "YXZ"));
  const rear = new THREE.Vector3(...rig.sights.rear);
  const front = new THREE.Vector3(...rig.sights.front);
  const adsQuat = new THREE.Quaternion().setFromUnitVectors(front.clone().sub(rear).normalize(), NEG_Z);
  const adsPos = new THREE.Vector3(0, 0, -rig.sights.eye).sub(rear.clone().applyQuaternion(adsQuat));

  // Muzzle flash.
  let flash = null;
  if (rig.flashSize > 0) {
    flash = buildFlash(rig.flashSize);
    rig.muzzle.add(flash);
  }
  // Ejected casings (camera-space, short-lived).
  const casings = [];
  if (rig.casing) {
    const proto = casingGeometry(L, rig.casing, Math.max(8, S - 2));
    for (let i = 0; i < CASING_POOL; i++) {
      const c = i === 0 ? proto : proto.clone();
      c.visible = false;
      c.userData = { vel: new THREE.Vector3(), spin: new THREE.Vector3(), life: 0 };
      object.add(c);
      casings.push(c);
    }
  }
  let nextCasing = 0;

  const spring = { z: 0, vz: 0, p: 0, vp: 0, y: 0, vy: 0 };
  const off = { px: 0, py: 0, pz: 0, rx: 0, ry: 0, rz: 0 };
  let time = Math.random() * 10;
  let bob = 0;
  let flashT = 1;
  const pos = new THREE.Vector3();
  const quat = new THREE.Quaternion();

  function spawnCasing(count) {
    for (let k = 0; k < count && casings.length; k++) {
      const c = casings[nextCasing];
      nextCasing = (nextCasing + 1) % casings.length;
      _a.copy(rig.eject);
      rig.gun.localToWorld(_a);
      object.worldToLocal(_a);
      c.position.copy(_a);
      c.position.x += (Math.random() - 0.5) * 0.01;
      c.position.y += (Math.random() - 0.5) * 0.01;
      _b.copy(rig.ejectDir).normalize().multiplyScalar(1.1 + Math.random() * 0.7);
      if (count > 2) _b.set((Math.random() - 0.5) * 0.4, -0.3 - Math.random() * 0.4, 0.3 + Math.random() * 0.3);
      _b.applyQuaternion(pose.quaternion);
      c.userData.vel.copy(_b);
      c.userData.spin.set((Math.random() - 0.5) * 30, (Math.random() - 0.5) * 30, (Math.random() - 0.5) * 30);
      c.userData.life = 0.9;
      c.quaternion.copy(pose.quaternion);
      c.rotateX(rig.casing === "shell" ? -HALF_PI * 0.6 : HALF_PI);
      c.visible = true;
    }
  }

  function update(dt, st) {
    time += dt;
    st.ejectCount = 0;

    // Recoil: a stiff spring kicked on each shot (back, muzzle-up, a touch of yaw).
    if (st.fired) {
      const k = rig.kick;
      spring.vz += k.back * 28 * (0.9 + Math.random() * 0.2);
      spring.vp += k.rot * 22 * (0.85 + Math.random() * 0.3);
      spring.vy += (Math.random() - 0.5) * k.yaw * 40;
      flashT = 0;
      if (flash) {
        flash.rotation.z = Math.random() * TAU;
        const s = rig.flashSize * (0.85 + Math.random() * 0.35);
        flash.scale.set(s, s, s * (0.8 + Math.random() * 0.5));
      }
    }
    const sub = 2;
    const h = dt / sub;
    for (let i = 0; i < sub; i++) {
      spring.vz += (-260 * spring.z - 26 * spring.vz) * h;
      spring.vp += (-220 * spring.p - 22 * spring.vp) * h;
      spring.vy += (-200 * spring.y - 20 * spring.vy) * h;
      spring.z += spring.vz * h;
      spring.p += spring.vp * h;
      spring.y += spring.vy * h;
    }

    const a = smootherstep(st.aim);
    pos.lerpVectors(hipPos, adsPos, a);
    quat.slerpQuaternions(hipQuat, adsQuat, a);

    off.px = off.py = off.pz = off.rx = off.ry = off.rz = 0;
    const hipW = 1 - a * 0.85;
    // Breathing.
    off.py += Math.sin(time * 1.7) * 0.0012 * hipW;
    off.rx += Math.sin(time * 1.7 + 0.6) * 0.004 * hipW;
    off.rz += Math.sin(time * 0.9) * 0.003 * hipW;
    // Walk / sprint bob: a figure-eight that deepens with speed.
    const move = clamp(st.move, 0, 1.6);
    const sprint = clamp(st.sprint, 0, 1);
    bob += dt * (6.4 + sprint * 3.2) * Math.min(1, move + sprint);
    const amp = (Math.min(1, move) * 0.9 + sprint * 0.9) * lerp(1, 0.25, a);
    off.px += Math.sin(bob) * 0.0055 * amp;
    off.py += -Math.abs(Math.cos(bob)) * 0.007 * amp + 0.0035 * amp;
    off.rz += Math.sin(bob) * 0.012 * amp;
    off.ry += Math.cos(bob) * 0.008 * amp;
    // Sprint: gun canted down and across the body.
    off.px -= 0.035 * sprint;
    off.py -= 0.035 * sprint;
    off.pz += 0.02 * sprint;
    off.rx -= 0.3 * sprint;
    off.ry += 0.55 * sprint;
    off.rz += 0.35 * sprint;
    // Crouch settles the gun a little.
    off.py -= 0.006 * clamp(st.crouch, 0, 1) * hipW;
    // Switch / binoculars: dropped out of view.
    const low = smootherstep(st.lower);
    off.py -= 0.24 * low;
    off.rx -= 0.75 * low;
    off.pz += 0.04 * low;

    rig.animate(st, off, dt);
    if (st.ejectCount) spawnCasing(st.ejectCount);

    _e.set(off.rx, off.ry, off.rz, "YXZ");
    _q.setFromEuler(_e);
    pose.position.set(pos.x + off.px, pos.y + off.py, pos.z + off.pz);
    pose.quaternion.copy(_q).multiply(quat);
    // Recoil in gun space about the grip.
    _v.set(0, 0, spring.z);
    _v.applyQuaternion(pose.quaternion);
    pose.position.add(_v);
    _e.set(spring.p, spring.y, 0, "YXZ");
    _q2.setFromEuler(_e);
    pose.quaternion.multiply(_q2);

    // Aim drift and look inertia rotate the whole rig about the eye, so the
    // sights track exactly where shots go.
    object.rotation.set(st.swayY + st.lagY, -st.swayX + st.lagX, 0, "YXZ");

    // Flash: two quick frames, then gone.
    if (flash) {
      flashT += dt;
      flash.visible = flashT < 0.05;
      flash.material.opacity = 1 - flashT / 0.05;
    }
    for (const c of casings) {
      if (!c.visible) continue;
      const u = c.userData;
      u.life -= dt;
      if (u.life <= 0) {
        c.visible = false;
        continue;
      }
      u.vel.y -= GRAVITY * dt;
      c.position.addScaledVector(u.vel, dt);
      c.rotation.x += u.spin.x * dt;
      c.rotation.y += u.spin.y * dt;
      c.rotation.z += u.spin.z * dt;
    }
    pose.visible = !st.scoped;
    if (flash && st.scoped) flash.visible = false;
  }

  function dispose() {
    object.traverse((o) => {
      if (o.isMesh && o.geometry) o.geometry.dispose();
    });
    if (flash) flash.material.dispose();
    object.removeFromParent();
  }

  return { object, muzzle: rig.muzzle, scoped: rig.scoped, update, dispose };
}

/* --- Environment --- */

/**
 * Bake a soft, neutral environment for viewmodel reflections (PMREM). It is
 * world-oriented — bright sky, a brighter horizon band, dark warm ground and a
 * soft overhead key — and WeaponSystem tints it toward the live sky via
 * `viewmodelUniforms.envTint`.
 * @param {THREE.WebGLRenderer} renderer
 * @returns {THREE.WebGLRenderTarget} target whose `.texture` is the env map
 */
export function createViewmodelEnvironment(renderer) {
  const pmrem = new THREE.PMREMGenerator(renderer);
  const scene = new THREE.Scene();
  const geo = new THREE.SphereGeometry(10, 48, 24);
  const mat = new THREE.ShaderMaterial({
    side: THREE.BackSide,
    depthWrite: false,
    vertexShader: /* glsl */ `
      varying vec3 vDir;
      void main() {
        vDir = normalize( position );
        gl_Position = projectionMatrix * modelViewMatrix * vec4( position, 1.0 );
      }`,
    fragmentShader: /* glsl */ `
      varying vec3 vDir;
      void main() {
        float y = vDir.y;
        vec3 zenith = vec3( 0.55, 0.62, 0.72 );
        vec3 horizon = vec3( 0.95, 0.93, 0.88 );
        vec3 ground = vec3( 0.16, 0.14, 0.11 );
        vec3 c = mix( horizon, zenith, smoothstep( 0.02, 0.75, y ) );
        c = mix( c, mix( vec3( 0.32, 0.29, 0.24 ), ground, smoothstep( -0.02, -0.5, y ) ), step( y, 0.0 ) );
        float key = pow( max( dot( vDir, normalize( vec3( 0.35, 0.85, -0.4 ) ) ), 0.0 ), 18.0 );
        c += key * 2.2;
        float strip = smoothstep( 0.12, 0.0, abs( y - 0.12 ) ) * 0.25;
        c += strip;
        gl_FragColor = vec4( c, 1.0 );
      }`,
  });
  scene.add(new THREE.Mesh(geo, mat));
  const rt = pmrem.fromScene(scene, 0, 0.1, 100, { size: 128 });
  geo.dispose();
  mat.dispose();
  pmrem.dispose();
  return rt;
}
