// Procedural dinosaurs: one smooth, skinned mesh per animal, lofted along a
// spine curve from the species blueprint in species.js, plus a procedural
// rig and gait / action animation.
//
// Look: smooth-shaded, organic geometry (no flat shading). Skin detail —
// scales, crevices, bands, spots, countershading, wet sheen — comes from one
// shared mip-mapped detail texture sampled tri-planar in BIND-POSE space, so
// the pattern sticks to the skin as it bends and survives the low-res "pixel"
// render style without shimmering. Geometry is cached per species and LOD and
// shared by every individual; individuality (palette, pattern phase, head
// size) lives in per-model uniforms and bone scales, so a herd costs one
// geometry upload and one draw call per animal (two for the feathered raptor).

import * as THREE from "three";
import { makeRng, hash } from "../core/rng.js";
import { clamp, lerp, damp, smoothstep, TAU } from "../core/math.js";
import { getSpecies } from "./species.js";

/* --- Tuning ------------------------------------------------------------- */

const LOD_LEVELS = [
  { radial: 28, rings: 1, limbRadial: 14, limbRings: 1, detail: 1 },
  { radial: 14, rings: 0.4, limbRadial: 8, limbRings: 0.45, detail: 0 },
];
const BODY_RINGS = 118; // ring budget for the main loft at LOD0 (×1.35 for very long bodies)

// Fixed (non-skin) colours, sRGB.
const FIXED = {
  tooth: "#d8ccad",
  claw: "#2c2621",
  hoof: "#3a332b",
  mouth: "#47262a",
  tongue: "#6e3a3a",
  beak: "#4d4238",
  nostril: "#1c1714",
  pupil: "#070606",
  horn: "#b9aa8a",
};

/* --- Shared detail texture --------------------------------------------- */
// RGBA, tileable, 256²:
//   R  scale relief (1 = top of a scale, 0 = crevice) — periodic Voronoi
//   G  per-scale random value (scale-to-scale colour jitter)
//   B  smooth fbm blotches (pattern warp, mottling)
//   A  finer fbm (spot field)

let _detailTex = null;

function periodicValueNoise(rng, period) {
  const grid = new Float32Array(period * period);
  for (let i = 0; i < grid.length; i++) grid[i] = rng();
  return (u, v) => {
    const x = u * period;
    const y = v * period;
    const x0 = Math.floor(x);
    const y0 = Math.floor(y);
    const fx = x - x0;
    const fy = y - y0;
    const sx = fx * fx * (3 - 2 * fx);
    const sy = fy * fy * (3 - 2 * fy);
    const ix0 = ((x0 % period) + period) % period;
    const iy0 = ((y0 % period) + period) % period;
    const ix1 = (ix0 + 1) % period;
    const iy1 = (iy0 + 1) % period;
    const a = grid[iy0 * period + ix0];
    const b = grid[iy0 * period + ix1];
    const c = grid[iy1 * period + ix0];
    const d = grid[iy1 * period + ix1];
    return lerp(lerp(a, b, sx), lerp(c, d, sx), sy);
  };
}

function getDetailTexture() {
  if (_detailTex) return _detailTex;
  const N = 256;
  const CELLS = 16;
  const rng = makeRng(0x5ca1e5);
  const px = new Float32Array(CELLS * CELLS);
  const py = new Float32Array(CELLS * CELLS);
  const pr = new Float32Array(CELLS * CELLS);
  for (let i = 0; i < CELLS * CELLS; i++) {
    px[i] = 0.12 + 0.76 * rng();
    py[i] = 0.12 + 0.76 * rng();
    pr[i] = rng();
  }
  const nB = [periodicValueNoise(rng, 4), periodicValueNoise(rng, 8), periodicValueNoise(rng, 16)];
  const nA = [periodicValueNoise(rng, 3), periodicValueNoise(rng, 6), periodicValueNoise(rng, 12)];
  // Value noise looks blocky at a hard threshold; sampling alternate octaves on a
  // 45°-rotated integer lattice (still periodic) breaks the grid alignment.
  const rot = (n) => (u, v) => n(u + v, v - u);
  nB[1] = rot(nB[1]);
  nA[1] = rot(nA[1]);
  const fB = new Float32Array(N * N);
  const fA = new Float32Array(N * N);
  const data = new Uint8Array(N * N * 4);
  let bMin = 1, bMax = 0, aMin = 1, aMax = 0;
  for (let y = 0; y < N; y++) {
    for (let x = 0; x < N; x++) {
      const u = (x + 0.5) / N;
      const v = (y + 0.5) / N;
      const gx = u * CELLS;
      const gy = v * CELLS;
      const cx = Math.floor(gx);
      const cy = Math.floor(gy);
      let f1 = 9, f2 = 9, id = 0;
      for (let oy = -1; oy <= 1; oy++) {
        for (let ox = -1; ox <= 1; ox++) {
          const ncx = cx + ox;
          const ncy = cy + oy;
          const wcx = (ncx + CELLS) % CELLS;
          const wcy = (ncy + CELLS) % CELLS;
          const k = wcy * CELLS + wcx;
          const dx = ncx + px[k] - gx;
          const dy = ncy + py[k] - gy;
          const d = Math.sqrt(dx * dx + dy * dy);
          if (d < f1) {
            f2 = f1;
            f1 = d;
            id = k;
          } else if (d < f2) f2 = d;
        }
      }
      // Domed scales with soft grooves between them.
      const edge = smoothstep(0.0, 0.32, f2 - f1);
      const dome = 1 - 0.45 * Math.min(1, f1 * f1 * 1.6);
      const h = edge * dome;
      const o = (y * N + x) * 4;
      data[o] = Math.round(clamp(h, 0, 1) * 255);
      data[o + 1] = Math.round(pr[id] * 255);
      const b = nB[0](u, v) * 0.55 + nB[1](u, v) * 0.3 + nB[2](u, v) * 0.15;
      const a = nA[0](u, v) * 0.55 + nA[1](u, v) * 0.3 + nA[2](u, v) * 0.15;
      fB[y * N + x] = b;
      fA[y * N + x] = a;
      bMin = Math.min(bMin, b); bMax = Math.max(bMax, b);
      aMin = Math.min(aMin, a); aMax = Math.max(aMax, a);
    }
  }
  // Stretch the fbm channels to the full range so thresholds behave the same for every seed.
  for (let i = 0; i < N * N; i++) {
    data[i * 4 + 2] = Math.round(((fB[i] - bMin) / (bMax - bMin)) * 255);
    data[i * 4 + 3] = Math.round(((fA[i] - aMin) / (aMax - aMin)) * 255);
  }
  const tex = new THREE.DataTexture(data, N, N, THREE.RGBAFormat, THREE.UnsignedByteType);
  tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
  tex.magFilter = THREE.LinearFilter;
  tex.minFilter = THREE.LinearMipmapLinearFilter;
  tex.generateMipmaps = true;
  tex.anisotropy = 4;
  tex.colorSpace = THREE.NoColorSpace;
  tex.needsUpdate = true;
  _detailTex = tex;
  return tex;
}

/* --- Shared feather texture -------------------------------------------- */
// 2×2 atlas of feather shapes (white-ish vanes, darker shaft, barb striations)
// with an alpha cut-out. Mip levels are built by hand with the alpha rescaled
// to keep the same coverage at alphaTest 0.5, so the coat doesn't thin out
// and vanish at distance or in the pixel style.

let _featherTex = null;

const FEATHER_SHAPES = [
  { width: 0.42, tipPow: 0.75, fluff: 0.18, bar: 0.0 }, // contour feather
  { width: 0.3, tipPow: 0.9, fluff: 0.1, bar: 0.5 }, // narrow, barred
  { width: 0.5, tipPow: 0.6, fluff: 0.3, bar: 0.0 }, // broad, downy base
  { width: 0.24, tipPow: 1.1, fluff: 0.05, bar: 0.35 }, // remex / tail quill
];

function getFeatherTexture() {
  if (_featherTex) return _featherTex;
  const N = 256;
  const C = N / 2;
  const level0 = new Uint8Array(N * N * 4);
  const rng = makeRng(0xfea7);
  const jag = new Float32Array(64);
  for (let i = 0; i < jag.length; i++) jag[i] = rng();
  for (let cell = 0; cell < 4; cell++) {
    const sh = FEATHER_SHAPES[cell];
    const ox = (cell % 2) * C;
    const oy = Math.floor(cell / 2) * C;
    for (let y = 0; y < C; y++) {
      for (let x = 0; x < C; x++) {
        const t = (y + 0.5) / C; // 0 base → 1 tip
        const s = ((x + 0.5) / C) * 2 - 1; // -1..1 across
        const prof = Math.pow(Math.sin(Math.PI * Math.pow(clamp(t * 0.98 + 0.01, 0, 1), sh.tipPow)), 0.75);
        const j = jag[Math.floor(t * 40 + (s > 0 ? 0 : 20)) % 64];
        let w = sh.width * 2 * prof * (1 - 0.13 * j);
        if (t < sh.fluff) w *= 0.6 + 0.4 * (t / sh.fluff);
        const as = Math.abs(s);
        let alpha = 1 - smoothstep(w - 0.06, w + 0.02, as);
        if (t < sh.fluff) alpha *= 0.55 + 0.45 * (t / sh.fluff);
        // Luminance: barbs angled toward the tip, dark shaft, optional bars.
        const barb = 0.88 + 0.12 * Math.sin((t * 46 - as * 14) * 1.0);
        const shaft = as < 0.04 ? 0.82 : 1;
        const bar = sh.bar > 0 ? 1 - sh.bar * smoothstep(0.55, 0.75, Math.sin(t * 22) * 0.5 + 0.5) : 1;
        const edgeDark = 1 - 0.1 * smoothstep(0.5 * w, w, as);
        const lum = clamp(0.92 * barb * shaft * bar * edgeDark, 0, 1);
        const o = ((oy + y) * N + ox + x) * 4;
        const l = Math.round(lum * 255);
        level0[o] = l;
        level0[o + 1] = l;
        level0[o + 2] = l;
        level0[o + 3] = Math.round(clamp(alpha, 0, 1) * 255);
      }
    }
  }
  const coverage = (d) => {
    let c = 0;
    for (let i = 3; i < d.length; i += 4) if (d[i] >= 128) c++;
    return c / (d.length / 4);
  };
  const target = coverage(level0);
  const mipmaps = [{ data: level0, width: N, height: N }];
  let prev = level0;
  let size = N;
  while (size > 1) {
    const ns = size >> 1;
    const next = new Uint8Array(ns * ns * 4);
    for (let y = 0; y < ns; y++) {
      for (let x = 0; x < ns; x++) {
        let r = 0, a = 0, wsum = 0;
        for (let dy = 0; dy < 2; dy++) {
          for (let dx = 0; dx < 2; dx++) {
            const o = ((y * 2 + dy) * size + x * 2 + dx) * 4;
            const wa = prev[o + 3] / 255 + 0.02;
            r += prev[o] * wa;
            wsum += wa;
            a += prev[o + 3];
          }
        }
        const o = (y * ns + x) * 4;
        const l = Math.round(r / wsum);
        next[o] = next[o + 1] = next[o + 2] = l;
        next[o + 3] = Math.round(a / 4);
      }
    }
    // Rescale alpha so the alpha-tested coverage matches level 0.
    if (ns >= 2) {
      let lo = 0.5, hi = 4;
      const tmp = new Uint8Array(next.length);
      for (let it = 0; it < 14; it++) {
        const mid = (lo + hi) * 0.5;
        for (let i = 3; i < next.length; i += 4) tmp[i] = Math.min(255, next[i] * mid);
        if (coverage(tmp) < target) lo = mid;
        else hi = mid;
      }
      const sc = (lo + hi) * 0.5;
      for (let i = 3; i < next.length; i += 4) next[i] = Math.min(255, Math.round(next[i] * sc));
    }
    mipmaps.push({ data: next, width: ns, height: ns });
    prev = next;
    size = ns;
  }
  const tex = new THREE.DataTexture(level0, N, N, THREE.RGBAFormat, THREE.UnsignedByteType);
  tex.mipmaps = mipmaps;
  tex.generateMipmaps = false;
  tex.magFilter = THREE.LinearFilter;
  tex.minFilter = THREE.LinearMipmapLinearFilter;
  tex.wrapS = tex.wrapT = THREE.ClampToEdgeWrapping;
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.anisotropy = 4;
  tex.needsUpdate = true;
  _featherTex = tex;
  return tex;
}

/* --- Skin material ------------------------------------------------------ */

const SKIN_VERTEX_PARS = /* glsl */ `
attribute vec4 aSkin;
attribute vec2 aSurf;
varying vec4 vSkin;
varying vec2 vSurf;
varying vec3 vRestPos;
varying vec3 vRestNormal;
`;

const SKIN_VERTEX_MAIN = /* glsl */ `
vRestPos = position;
vRestNormal = normal;
vSkin = aSkin;
vSurf = aSurf;
`;

const SKIN_FRAGMENT_PARS = /* glsl */ `
uniform sampler2D uDetail;
uniform vec3 uBase;
uniform vec3 uDorsal;
uniform vec3 uBelly;
uniform vec3 uPatternCol;
uniform vec3 uLight;
uniform vec3 uAccent;
uniform vec4 uBands;   // x rad/m, y threshold, z warp, w strength
uniform vec4 uSpots;   // x strength, y threshold, z mottle, w dorsal darkening
uniform vec4 uStripe;  // x rest-normal height, y width, z strength
uniform vec4 uScales;  // x fine tiles/m, y coarse tiles/m, z bump, w crevice darkening
uniform vec3 uSeed;
uniform vec4 uTint;
uniform float uWet;
varying vec4 vSkin;    // x skin palette amount, y pattern mask, z accent, w scale detail
varying vec2 vSurf;    // x roughness, y eye glint
varying vec3 vRestPos;
varying vec3 vRestNormal;

// Derivative bump (same maths as three's bumpmap, minus the uv requirement).
vec3 sauriaPerturb( vec3 surfPos, vec3 surfNorm, vec2 dHdxy, float faceDir ) {
  vec3 sx = normalize( dFdx( surfPos ) );
  vec3 sy = normalize( dFdy( surfPos ) );
  vec3 r1 = cross( sy, surfNorm );
  vec3 r2 = cross( surfNorm, sx );
  float det = dot( sx, r1 ) * faceDir;
  vec3 grad = sign( det ) * ( dHdxy.x * r1 + dHdxy.y * r2 );
  return normalize( abs( det ) * surfNorm - grad );
}
`;

const SKIN_FRAGMENT_COLOR = /* glsl */ `
vec3 rn = normalize( vRestNormal );
vec3 tw = pow( abs( rn ), vec3( 4.0 ) );
tw /= ( tw.x + tw.y + tw.z );
vec3 fp = vRestPos * uScales.x + uSeed;
vec4 fineT = texture2D( uDetail, fp.zy ) * tw.x + texture2D( uDetail, fp.xz ) * tw.y + texture2D( uDetail, fp.xy ) * tw.z;
vec3 cp = vRestPos * uScales.y + uSeed.yzx;
vec4 coarseT = texture2D( uDetail, cp.zy ) * tw.x + texture2D( uDetail, cp.xz ) * tw.y + texture2D( uDetail, cp.xy ) * tw.z;
float sDors = smoothstep( -0.25, 0.85, rn.y ) * uSpots.w;
float sBelly = 1.0 - smoothstep( -0.62, -0.1, rn.y );
float sFlank = smoothstep( -0.45, 0.25, rn.y );
vec3 skin = mix( uBase, uDorsal, sDors );
float band = sin( vRestPos.z * uBands.x + ( coarseT.b - 0.5 ) * uBands.z + uSeed.x * 9.0 );
band = smoothstep( uBands.y, uBands.y + 0.28, band ) * sFlank * vSkin.y * uBands.w;
skin = mix( skin, uPatternCol, band );
float spot = smoothstep( uSpots.y - 0.02, uSpots.y + 0.1, coarseT.a ) * vSkin.y * ( 1.0 - sBelly ) * uSpots.x;
skin = mix( skin, uPatternCol, spot );
float lstripe = 1.0 - smoothstep( uStripe.y * 0.15, uStripe.y * 1.5, abs( rn.y - uStripe.x + ( coarseT.b - 0.5 ) * 0.3 ) );
skin = mix( skin, uLight, lstripe * uStripe.z * vSkin.y );
skin = mix( skin, uBelly, sBelly );
skin = mix( skin, uAccent, vSkin.z );
skin *= 1.0 + ( coarseT.b - 0.5 ) * uSpots.z;
// Scale colour fades out before individual scales shrink under ~2 px (no speckle at range or when pixelated).
float sDetailFade = 1.0 - smoothstep( 0.008, 0.035, length( fwidth( fp ) ) );
skin *= mix( 1.0, 0.96 + 0.08 * fineT.g, vSkin.w * sDetailFade );
skin *= 1.0 - ( 1.0 - fineT.r ) * uScales.w * vSkin.w * ( 0.3 + 0.7 * sDetailFade );
vec3 albedo = mix( vColor, skin, vSkin.x );
albedo *= 1.0 - 0.3 * uWet;
float sLum = dot( albedo, vec3( 0.299, 0.587, 0.114 ) );
albedo = mix( albedo, uTint.rgb * ( 0.45 + 2.0 * sLum ), uTint.a );
diffuseColor.rgb *= albedo;
`;

const SKIN_FRAGMENT_ROUGH = /* glsl */ `
float roughnessFactor = clamp( vSurf.x * ( 0.9 + 0.2 * fineT.g ) * ( 1.0 - 0.6 * uWet ) + ( 1.0 - fineT.r ) * 0.08 * vSkin.w, 0.04, 1.0 );
`;

const SKIN_FRAGMENT_NORMAL = /* glsl */ `
#ifdef SAURIA_FEATHER
  normal = normalize( vNormal ); // cards shade like the coat underneath, from both sides
#else
  // Fade the relief out once a scale shrinks below ~3 px: no shimmer far away or in the pixel style.
  float bumpFade = 1.0 - smoothstep( 0.012, 0.05, length( fwidth( fp ) ) );
  vec2 sdH = vec2( dFdx( fineT.r ), dFdy( fineT.r ) ) * uScales.z * vSkin.w * bumpFade;
  normal = sauriaPerturb( - vViewPosition, normal, sdH, faceDirection );
#endif
`;

const SKIN_FRAGMENT_GLINT = /* glsl */ `
float sLight = dot( reflectedLight.directDiffuse + reflectedLight.indirectDiffuse, vec3( 0.3333 ) ) / max( dot( diffuseColor.rgb, vec3( 0.3333 ) ), 0.03 );
vec3 sGlintH = normalize( vec3( 0.35, 0.5, 1.0 ) );
outgoingLight += vSurf.y * pow( max( dot( normal, sGlintH ), 0.0 ), 70.0 ) * min( sLight, 2.5 ) * 0.55;
`;

function patchSkinShader(shader, uniforms) {
  Object.assign(shader.uniforms, uniforms);
  shader.vertexShader = shader.vertexShader
    .replace("#include <common>", "#include <common>\n" + SKIN_VERTEX_PARS)
    .replace("#include <begin_vertex>", "#include <begin_vertex>\n" + SKIN_VERTEX_MAIN);
  shader.fragmentShader = shader.fragmentShader
    .replace("#include <common>", "#include <common>\n" + SKIN_FRAGMENT_PARS)
    .replace("#include <color_fragment>", SKIN_FRAGMENT_COLOR)
    .replace("#include <roughnessmap_fragment>", SKIN_FRAGMENT_ROUGH)
    .replace("#include <normal_fragment_maps>", "#include <normal_fragment_maps>\n" + SKIN_FRAGMENT_NORMAL)
    .replace("#include <opaque_fragment>", SKIN_FRAGMENT_GLINT + "\n#include <opaque_fragment>");
}

function createSkinUniforms() {
  return {
    uDetail: { value: getDetailTexture() },
    uBase: { value: new THREE.Color() },
    uDorsal: { value: new THREE.Color() },
    uBelly: { value: new THREE.Color() },
    uPatternCol: { value: new THREE.Color() },
    uLight: { value: new THREE.Color() },
    uAccent: { value: new THREE.Color() },
    uBands: { value: new THREE.Vector4() },
    uSpots: { value: new THREE.Vector4() },
    uStripe: { value: new THREE.Vector4() },
    uScales: { value: new THREE.Vector4() },
    uSeed: { value: new THREE.Vector3() },
    uTint: { value: new THREE.Vector4(0, 0, 0, 0) },
    uWet: { value: 0 },
  };
}

/**
 * Per-individual skin material. Every instance shares one compiled program
 * (same patch + cache key); only the uniform values differ.
 */
function createSkinMaterial(uniforms, feather) {
  const m = new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 1, metalness: 0 });
  if (feather) {
    m.map = getFeatherTexture();
    m.alphaTest = 0.5;
    m.side = THREE.DoubleSide;
    m.defines = { SAURIA_FEATHER: "" };
  }
  m.onBeforeCompile = (shader) => patchSkinShader(shader, uniforms);
  m.customProgramCacheKey = () => "sauria-dino-skin-1";
  return m;
}

/* --- Build utilities ---------------------------------------------------- */

/** Monotone cubic (PCHIP) interpolation through (xs, ys): smooth, no overshoot. */
function pchip(xs, ys) {
  const n = xs.length;
  const h = new Float64Array(n - 1);
  const d = new Float64Array(n - 1);
  const m = new Float64Array(n);
  for (let i = 0; i < n - 1; i++) {
    h[i] = Math.max(1e-6, xs[i + 1] - xs[i]);
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
    let lo = 0;
    let hi = n - 1;
    while (hi - lo > 1) {
      const mid = (lo + hi) >> 1;
      if (xs[mid] <= x) lo = mid;
      else hi = mid;
    }
    const t = (x - xs[lo]) / h[lo];
    const t2 = t * t;
    const t3 = t2 * t;
    return (2 * t3 - 3 * t2 + 1) * ys[lo] + (t3 - 2 * t2 + t) * h[lo] * m[lo] + (-2 * t3 + 3 * t2) * ys[lo + 1] + (t3 - t2) * h[lo] * m[lo + 1];
  };
}

/** Superellipse cross-section point for angle theta (0 = top, PI/2 = +X side). */
function section(theta, w, t, b, n, taper, out) {
  const c = Math.cos(theta);
  const s = Math.sin(theta);
  const e = 2 / n;
  const cy = Math.sign(c) * Math.pow(Math.abs(c), e);
  const sx = Math.sign(s) * Math.pow(Math.abs(s), e);
  out.y = cy * (c >= 0 ? t : b);
  out.x = sx * w * (1 + taper * cy);
  return out;
}

const wrapPi = (a) => {
  a = (a + Math.PI) % TAU;
  if (a < 0) a += TAU;
  return a - Math.PI;
};

/** Bone influences of one vertex; resolves to the strongest four, normalised. */
class Influence {
  constructor() {
    this.b = new Int32Array(24);
    this.w = new Float32Array(24);
    this.n = 0;
  }
  reset() {
    this.n = 0;
    return this;
  }
  add(bone, w) {
    if (!(w > 1e-5)) return this;
    for (let i = 0; i < this.n; i++) {
      if (this.b[i] === bone) {
        this.w[i] += w;
        return this;
      }
    }
    if (this.n < 24) {
      this.b[this.n] = bone;
      this.w[this.n] = w;
      this.n++;
    }
    return this;
  }
  scale(f) {
    for (let i = 0; i < this.n; i++) this.w[i] *= f;
    return this;
  }
  copy(o) {
    this.n = o.n;
    for (let i = 0; i < o.n; i++) {
      this.b[i] = o.b[i];
      this.w[i] = o.w[i];
    }
    return this;
  }
}

/**
 * Smooth weights along an ordered bone chain. `centers` = [{ a, bone, k }]
 * sorted by arc position; k (0..1) is how wide the blend toward the next
 * centre is (1 = fully smooth, organic bending; small = rigid segments).
 */
function chainInfluence(a, centers, inf, scale = 1) {
  const n = centers.length;
  if (n === 1 || a <= centers[0].a) return inf.add(centers[0].bone, scale);
  if (a >= centers[n - 1].a) return inf.add(centers[n - 1].bone, scale);
  let i = 0;
  while (i < n - 2 && a >= centers[i + 1].a) i++;
  const c0 = centers[i];
  const c1 = centers[i + 1];
  const t = (a - c0.a) / Math.max(1e-6, c1.a - c0.a);
  const k = c0.k;
  const u = k <= 0.001 ? (t < 0.5 ? 0 : 1) : smoothstep(0.5 - k * 0.5, 0.5 + k * 0.5, t);
  inf.add(c0.bone, (1 - u) * scale);
  inf.add(c1.bone, u * scale);
  return inf;
}

/** Surface look of the vertices being emitted (mutated while building). */
function makeLook() {
  return { color: new THREE.Color(1, 1, 1), skin: 1, pattern: 1, accent: 0, detail: 1, rough: 0.78, glint: 0 };
}
const FIXED_LINEAR = {};
for (const k in FIXED) FIXED_LINEAR[k] = new THREE.Color(FIXED[k]);

/** Growable vertex soup → indexed, skinned BufferGeometry. */
class Builder {
  constructor(withUv = false) {
    this.p = [];
    this.c = [];
    this.k = [];
    this.s = [];
    this.bi = [];
    this.bw = [];
    this.idx = [];
    this.nrm = withUv ? [] : null;
    this.uv = withUv ? [] : null;
  }
  get count() {
    return this.p.length / 3;
  }
  vert(x, y, z, look, inf) {
    this.p.push(x, y, z);
    this.c.push(look.color.r, look.color.g, look.color.b);
    this.k.push(look.skin, look.pattern, look.accent, look.detail);
    this.s.push(look.rough, look.glint);
    // Strongest four influences, renormalised.
    const n = inf.n;
    const used = [-1, -1, -1, -1];
    let total = 0;
    for (let slot = 0; slot < 4; slot++) {
      let best = -1;
      let bw = 0;
      for (let i = 0; i < n; i++) {
        if (used[0] === i || used[1] === i || used[2] === i) continue;
        if (inf.w[i] > bw) {
          bw = inf.w[i];
          best = i;
        }
      }
      used[slot] = best;
      if (best >= 0) total += bw;
    }
    for (let slot = 0; slot < 4; slot++) {
      const i = used[slot];
      if (i >= 0 && total > 0) {
        this.bi.push(inf.b[i]);
        this.bw.push(inf.w[i] / total);
      } else {
        this.bi.push(0);
        this.bw.push(0);
      }
    }
    return this.count - 1;
  }
  tri(a, b, c) {
    this.idx.push(a, b, c);
  }
  toGeometry(computeNormals = true) {
    const g = new THREE.BufferGeometry();
    g.setAttribute("position", new THREE.Float32BufferAttribute(this.p, 3));
    g.setAttribute("color", new THREE.Float32BufferAttribute(this.c, 3));
    g.setAttribute("aSkin", new THREE.Float32BufferAttribute(this.k, 4));
    g.setAttribute("aSurf", new THREE.Float32BufferAttribute(this.s, 2));
    g.setAttribute("skinIndex", new THREE.Uint16BufferAttribute(this.bi, 4));
    g.setAttribute("skinWeight", new THREE.Float32BufferAttribute(this.bw, 4));
    if (this.uv) g.setAttribute("uv", new THREE.Float32BufferAttribute(this.uv, 2));
    g.setIndex(this.count > 65535 ? new THREE.Uint32BufferAttribute(this.idx, 1) : new THREE.Uint16BufferAttribute(this.idx, 1));
    if (this.nrm) g.setAttribute("normal", new THREE.Float32BufferAttribute(this.nrm, 3));
    else if (computeNormals) g.computeVertexNormals();
    return g;
  }
}

/** Arc-length parameterised centripetal Catmull-Rom spine through station points. */
class SpinePath {
  constructor(points) {
    this.curve = new THREE.CatmullRomCurve3(points, false, "centripetal");
    const N = 3000;
    this.N = N;
    this.t = new Float64Array(N + 1);
    this.a = new Float64Array(N + 1);
    this.z = new Float64Array(N + 1);
    const prev = this.curve.getPoint(0);
    const cur = new THREE.Vector3();
    let acc = 0;
    this.z[0] = prev.z;
    for (let i = 1; i <= N; i++) {
      const t = i / N;
      this.curve.getPoint(t, cur);
      acc += cur.distanceTo(prev);
      prev.copy(cur);
      this.t[i] = t;
      this.a[i] = acc;
      this.z[i] = cur.z;
    }
    this.length = acc;
    const segs = points.length - 1;
    this.nodeArc = points.map((_, j) => this.a[Math.round((j / segs) * N)]);
  }
  tAt(a) {
    const A = this.a;
    if (a <= 0) return 0;
    if (a >= this.length) return 1;
    let lo = 0;
    let hi = this.N;
    while (hi - lo > 1) {
      const mid = (lo + hi) >> 1;
      if (A[mid] <= a) lo = mid;
      else hi = mid;
    }
    const f = (a - A[lo]) / Math.max(1e-9, A[hi] - A[lo]);
    return lerp(this.t[lo], this.t[hi], f);
  }
  point(a, out = new THREE.Vector3()) {
    return this.curve.getPoint(this.tAt(a), out);
  }
  tangent(a, out = new THREE.Vector3()) {
    return this.curve.getTangent(clamp(this.tAt(a), 0.0005, 0.9995), out).normalize();
  }
  /** Arc position where the spine first reaches z (it runs tail → snout, mostly monotonic). */
  arcAtZ(z) {
    const Z = this.z;
    if (z <= Z[0]) return 0;
    for (let i = 1; i <= this.N; i++) {
      if (Z[i] >= z) {
        const f = (z - Z[i - 1]) / Math.max(1e-9, Z[i] - Z[i - 1]);
        return lerp(this.a[i - 1], this.a[i], f);
      }
    }
    return this.length;
  }
}

/** Two-bone IK: knee position for hip H → ankle A with lengths l1, l2 bending toward `pole`. */
function solveKnee(H, A, l1, l2, pole, out) {
  const dx = A.x - H.x;
  const dy = A.y - H.y;
  const dz = A.z - H.z;
  const len = Math.sqrt(dx * dx + dy * dy + dz * dz) || 1e-6;
  const nx = dx / len;
  const ny = dy / len;
  const nz = dz / len;
  const d = clamp(len, Math.abs(l1 - l2) + 1e-4, (l1 + l2) * 0.9995);
  const ca = clamp((l1 * l1 + d * d - l2 * l2) / (2 * l1 * d), -1, 1);
  const sa = Math.sqrt(1 - ca * ca);
  // Pole projected perpendicular to the hip→ankle line.
  const pd = pole.x * nx + pole.y * ny + pole.z * nz;
  let px = pole.x - nx * pd;
  let py = pole.y - ny * pd;
  let pz = pole.z - nz * pd;
  const pl = Math.sqrt(px * px + py * py + pz * pz) || 1;
  px /= pl;
  py /= pl;
  pz /= pl;
  out.set(H.x + (nx * ca + px * sa) * l1, H.y + (ny * ca + py * sa) * l1, H.z + (nz * ca + pz * sa) * l1);
  return out;
}

/* --- Blueprint (per species, LOD independent) ------------------------- */
// Everything about the bind pose: spine stations and interpolators, bone
// positions, chain centres for skin weights, leg/arm joint positions, head
// landmarks (eyes, nostrils, jaw) and surface bumps.

const _blueprints = new Map();

function getBlueprint(sp) {
  let bp = _blueprints.get(sp.id);
  if (!bp) {
    bp = makeBlueprint(sp);
    extendBlueprint(bp);
    _blueprints.set(sp.id, bp);
  }
  return bp;
}

function makeBlueprint(sp) {
  const body = sp.body;
  const H = sp.height;
  const hd = body.head;
  const quad = body.plan === "quadruped";

  /* Stations: trunk (spine line) then head (mouth line), tail tip → snout tip. */
  const st = [];
  for (const r of body.trunk) st.push({ z: r[0], y: r[1], w: r[2], t: r[3], b: r[4], n: r[5] ?? 2, taper: r[6] ?? 0, head: false, u: -1 });
  const pc = Math.cos(hd.pitch);
  const ps = Math.sin(hd.pitch);
  const head = {
    O: new THREE.Vector3(0, hd.at[1], hd.at[0]),
    D: new THREE.Vector3(0, ps, pc),
    N: new THREE.Vector3(0, pc, -ps),
    len: hd.length,
    def: hd,
  };
  for (const r of hd.stations) {
    st.push({ z: hd.at[0] + pc * r[0] * hd.length, y: hd.at[1] + ps * r[0] * hd.length, w: r[3], t: r[1], b: r[2], n: hd.square ?? 2, taper: r[4] ?? 0, head: true, u: r[0] });
  }
  const path = new SpinePath(st.map((s) => new THREE.Vector3(0, s.y, s.z)));
  st.forEach((s, j) => (s.a = path.nodeArc[j]));
  const xs = st.map((s) => s.a);
  const fw = pchip(xs, st.map((s) => s.w));
  const ft = pchip(xs, st.map((s) => s.t));
  const fb = pchip(xs, st.map((s) => s.b));
  const fn = pchip(xs, st.map((s) => s.n));
  const ftap = pchip(xs, st.map((s) => s.taper));
  const L = path.length;
  const headSt = st.filter((s) => s.head);
  const headA0 = headSt[0].a;
  const headA1 = headSt[headSt.length - 1].a;
  const arcAtU = (u) => {
    for (let i = 0; i < headSt.length - 1; i++) {
      const s0 = headSt[i];
      const s1 = headSt[i + 1];
      if (u <= s1.u || i === headSt.length - 2) return lerp(s0.a, s1.a, (u - s0.u) / Math.max(1e-6, s1.u - s0.u));
    }
    return headA1;
  };
  const uAtArc = (a) => {
    for (let i = 0; i < headSt.length - 1; i++) {
      const s0 = headSt[i];
      const s1 = headSt[i + 1];
      if (a <= s1.a || i === headSt.length - 2) return lerp(s0.u, s1.u, (a - s0.a) / Math.max(1e-6, s1.a - s0.a));
    }
    return 1;
  };
  head.arcAtU = arcAtU;
  head.uAtArc = uAtArc;
  head.a0 = headA0;
  head.a1 = headA1;

  const prof = (a, out) => {
    out.w = fw(a);
    out.t = ft(a);
    out.b = fb(a);
    out.n = fn(a);
    out.taper = ftap(a);
    return out;
  };

  /* Bones. */
  const bones = [];
  const index = {};
  const addBone = (name, parent, pos) => {
    index[name] = bones.length;
    bones.push({ name, parent: parent == null ? -1 : index[parent], pos: pos.clone() });
    return index[name];
  };
  const P = (a) => path.point(a);
  addBone("root", null, new THREE.Vector3());
  addBone("hips", "root", new THREE.Vector3(0, H, 0));
  const aHips = path.arcAtZ(0);
  const aSpine = path.arcAtZ(body.bones.spineZ);
  const aChest = path.arcAtZ(body.bones.chestZ);
  const aNeck = path.arcAtZ(body.bones.neckZ);
  const aTail = path.arcAtZ(body.bones.tailZ);
  addBone("spine", "hips", P(aSpine));
  addBone("chest", "spine", P(aChest));
  const pSpine = P(aSpine);
  const pChest = P(aChest);
  const ribsZ = (body.bones.spineZ + body.bones.chestZ) * 0.5;
  const aRibs = path.arcAtZ(ribsZ);
  const ribsProf = prof(aRibs, {});
  const pRibs = P(aRibs);
  addBone("ribs", "spine", new THREE.Vector3(0, pRibs.y - ribsProf.b * 0.35, pRibs.z));

  // Neck chain from the base to the head joint.
  const aHeadJoint = arcAtU(0.03);
  const nNeck = body.bones.neck;
  const neckArcs = [];
  for (let k = 0; k < nNeck; k++) neckArcs.push(lerp(aNeck, aHeadJoint, k / nNeck));
  let parent = "chest";
  for (let k = 0; k < nNeck; k++) {
    addBone("neck" + k, parent, P(neckArcs[k]));
    parent = "neck" + k;
  }
  const t0 = headSt[0].t;
  const headPos = P(aHeadJoint).addScaledVector(head.N, t0 * 0.3);
  addBone("head", parent, headPos);
  const jaw = hd.jaw;
  const jawDepth0 = jaw.depth[0][1];
  const jawPivot = head.O.clone().addScaledVector(head.D, jaw.hinge * hd.length).addScaledVector(head.N, -jawDepth0 * 0.45);
  addBone("jaw", "head", jawPivot);

  // Tail chain from behind the hips to near the tip.
  const nTail = body.bones.tail;
  const tailArcs = [];
  for (let k = 0; k < nTail; k++) tailArcs.push(aTail * (1 - k / nTail));
  parent = "hips";
  for (let k = 0; k < nTail; k++) {
    addBone("tail" + k, parent, P(tailArcs[k]));
    parent = "tail" + k;
  }

  /* Chain centres for skin weights along the main loft (ascending arc). */
  const centers = [];
  for (let k = nTail - 1; k >= 0; k--) {
    const aNext = k + 1 < nTail ? tailArcs[k + 1] : 0;
    centers.push({ a: (tailArcs[k] + aNext) * 0.5, bone: index["tail" + k], k: 1 });
  }
  centers.push({ a: (aHips + aSpine) * 0.5, bone: index.hips, k: 1 });
  centers.push({ a: (aSpine + aChest) * 0.5, bone: index.spine, k: 1 });
  centers.push({ a: (aChest + neckArcs[0]) * 0.5, bone: index.chest, k: 1 });
  for (let k = 0; k < nNeck; k++) {
    const aNext = k + 1 < nNeck ? neckArcs[k + 1] : aHeadJoint;
    centers.push({ a: (neckArcs[k] + aNext) * 0.5, bone: index["neck" + k], k: k === nNeck - 1 ? 0.75 : 1 });
  }
  centers.push({ a: arcAtU(0.16), bone: index.head, k: 1 });

  /* Legs (hind always; fore for quadrupeds) — bind pose from the foot placement. */
  const legs = [];
  const makeLeg = (def, side, fore) => {
    const pre = (fore ? "f" : "h") + (side > 0 ? "L" : "R");
    const l1 = fore ? def.upper : def.thigh;
    const l2 = fore ? def.fore : def.shin;
    const l3 = def.meta;
    const l4 = def.toe;
    const ballH = def.radii.ball[0] * 0.92;
    const hip = new THREE.Vector3(side * def.x, fore ? def.y : H, fore ? def.z : 0);
    const ball = new THREE.Vector3(side * def.footX, ballH, def.footZ);
    const phi = def.metaAngle;
    const ankle = ball.clone().add(new THREE.Vector3(0, Math.cos(phi) * l3, -Math.sin(phi) * l3));
    // Keep the bind pose reachable (slightly bent) whatever the blueprint says.
    const reach = (l1 + l2) * 0.985;
    if (ankle.distanceTo(hip) > reach) {
      const dir = ankle.clone().sub(hip).normalize();
      const fix = hip.clone().addScaledVector(dir, reach).sub(ankle);
      ankle.add(fix);
      ball.add(fix);
    }
    const pole = new THREE.Vector3(0, 0, fore ? -1 : 1);
    const knee = solveKnee(hip, ankle, l1, l2, pole, new THREE.Vector3());
    const toeEnd = ball.clone().add(new THREE.Vector3(0, -ballH * 0.6, l4));
    const parentName = fore ? "chest" : "hips";
    const leg = {
      name: pre,
      side,
      fore,
      def,
      parentName,
      lengths: [l1, l2, l3, l4],
      ballH,
      phi,
      hip,
      knee,
      ankle,
      ball,
      toeEnd,
      pole,
      bones: [],
    };
    leg.bones.push(addBone(pre + "upper", parentName, hip));
    leg.bones.push(addBone(pre + "lower", pre + "upper", knee));
    leg.bones.push(addBone(pre + "meta", pre + "lower", ankle));
    leg.bones.push(addBone(pre + "foot", pre + "meta", ball));
    legs.push(leg);
    return leg;
  };
  for (const side of [1, -1]) makeLeg(body.hind, side, false);
  if (quad) for (const side of [1, -1]) makeLeg(body.fore, side, true);

  /* Arms (bipeds): authored by joint directions, FK-animated. */
  const arms = [];
  if (!quad && body.arms) {
    const ad = body.arms;
    for (const side of [1, -1]) {
      const pre = "a" + (side > 0 ? "L" : "R");
      const sh = new THREE.Vector3(side * ad.x, ad.y, ad.z);
      const d1 = ad.folded ? new THREE.Vector3(side * 0.32, -0.5, -0.8) : new THREE.Vector3(side * 0.28, -0.9, -0.3);
      const d2 = ad.folded ? new THREE.Vector3(side * 0.12, -0.2, 1) : new THREE.Vector3(side * 0.08, -0.4, 1);
      const d3 = ad.folded ? new THREE.Vector3(side * 0.18, -0.35, -0.92) : new THREE.Vector3(side * 0.02, -0.75, 0.66);
      const elbow = sh.clone().addScaledVector(d1.normalize(), ad.upper);
      const wrist = elbow.clone().addScaledVector(d2.normalize(), ad.fore);
      const handEnd = wrist.clone().addScaledVector(d3.normalize(), ad.hand);
      const arm = { name: pre, side, def: ad, shoulder: sh, elbow, wrist, handEnd, dirs: [d1, d2, d3], bones: [] };
      arm.bones.push(addBone(pre + "upper", "chest", sh));
      arm.bones.push(addBone(pre + "fore", pre + "upper", elbow));
      arm.bones.push(addBone(pre + "hand", pre + "fore", wrist));
      arms.push(arm);
    }
  }

  /* Surface queries on the analytic loft (bind pose). */
  const _sec = { x: 0, y: 0 };
  const _pr = {};
  const T = new THREE.Vector3();
  const U = new THREE.Vector3();
  const X = new THREE.Vector3(1, 0, 0);
  const rawSurface = (a, th, out) => {
    prof(a, _pr);
    path.point(a, out);
    path.tangent(a, T);
    U.crossVectors(T, X).normalize();
    section(th, _pr.w, _pr.t, _pr.b, _pr.n, _pr.taper, _sec);
    return out.addScaledVector(X, _sec.x).addScaledVector(U, _sec.y);
  };
  const surface = (a, th, outP, outN) => {
    rawSurface(a, th, outP);
    if (outN) {
      const e = 0.004;
      const p1 = rawSurface(a, th + e, new THREE.Vector3());
      const p2 = rawSurface(Math.min(L, a + e * L * 0.05 + 0.002), th, new THREE.Vector3());
      const p0 = rawSurface(Math.max(0, a - e * L * 0.05 - 0.002), th, new THREE.Vector3());
      const dTh = p1.sub(outP);
      const dA = p2.sub(p0);
      outN.crossVectors(dA, dTh).normalize();
      // Make sure it faces outward (away from the spine line).
      const c = path.point(a, new THREE.Vector3());
      if (outN.dot(outP.clone().sub(c)) < 0) outN.negate();
    }
    return outP;
  };
  /** Angle on the +X side where the section reaches height v above its centre line. */
  const thetaForY = (a, v) => {
    prof(a, _pr);
    let lo = 0;
    let hi = Math.PI;
    for (let i = 0; i < 40; i++) {
      const mid = (lo + hi) * 0.5;
      section(mid, _pr.w, _pr.t, _pr.b, _pr.n, _pr.taper, _sec);
      if (_sec.y > v) lo = mid;
      else hi = mid;
    }
    return (lo + hi) * 0.5;
  };
  const localRadius = (a) => {
    prof(a, _pr);
    return (_pr.w + (_pr.t + _pr.b) * 0.5) * 0.5;
  };

  /* Head landmarks and bumps. */
  const bumps = [];
  const addBump = (a, th, rs, rt, amp, accent = 0, mirror = true) => bumps.push({ a, th, rs, rt, amp, accent, mirror });
  const eye = hd.eye;
  const aEye = arcAtU(eye.u);
  const thEye = thetaForY(aEye, eye.v);
  const eyeN = new THREE.Vector3();
  const eyeSurf = surface(aEye, thEye, new THREE.Vector3(), eyeN);
  const rLoc = localRadius(aEye);
  addBump(aEye, thEye, eye.r * 1.7, eye.r * 1.7, -eye.r * 0.32);
  addBump(aEye + eye.r * 0.4, thEye - (eye.r * 1.55) / rLoc, eye.r * 2.8, eye.r * 1.05, eye.r * 0.55);
  const eyeAxis = eyeN.clone().addScaledVector(head.D, 0.28).addScaledVector(head.N, 0.08).normalize();
  const eyeCenter = eyeSurf.clone().addScaledVector(eyeN, -eye.r * 0.3);
  const nos = hd.nostril;
  const aNos = arcAtU(nos.u);
  const thNos = nos.top ? 0.38 : thetaForY(aNos, nos.v);
  addBump(aNos, thNos, nos.r * 1.8, nos.r * 1.1, -nos.r * 0.45);
  if (nos.top) addBump(aNos, 0, nos.r * 4, nos.r * 3, nos.r * 1.2, 0, false); // diplodocid nasal dome
  const f = body.features || {};
  if (f.browHorns) {
    const a = arcAtU(0.27);
    addBump(a, thetaForY(a, ft(a) * 0.84), 0.075, 0.042, 0.07, 0.2);
    const a2 = arcAtU(0.62);
    addBump(a2, thetaForY(a2, ft(a2) * 0.96), 0.24, 0.02, 0.016, 0.15);
  }
  if (f.browBosses) {
    const a = arcAtU(0.23);
    addBump(a, thetaForY(a, ft(a) * 0.8), 0.06, 0.045, 0.055, 0.2);
  }
  if (f.armor === "gastonia") {
    const a = arcAtU(0.12);
    addBump(a, thetaForY(a, ft(a) * 0.55), 0.06, 0.05, 0.04, 0.4);
  }

  /* Bounding sphere big enough for any pose (lying down, rearing, dead). */
  const zMin = st[0].z;
  const zMax = st[st.length - 1].z;
  const bound = new THREE.Sphere(new THREE.Vector3(0, H * 0.7, (zMin + zMax) * 0.5), (zMax - zMin) * 0.62 + H * 0.5);

  // Highest point of the back above the hip joint, for the swim pose.
  const backTop = st.filter((s) => !s.head && Math.abs(s.z) < 0.8).reduce((m, s) => Math.max(m, s.y + s.t - H), 0);
  // Lowest belly point below the hip joint (rest pose: lie on the belly).
  const bellyLow = st.filter((s) => !s.head).reduce((m, s) => Math.max(m, H - (s.y - s.b)), -9);

  return {
    sp,
    body,
    H,
    quad,
    st,
    path,
    L,
    prof,
    head,
    bones,
    index,
    centers,
    aHips,
    aSpine,
    aChest,
    aRibs,
    aTail,
    legs,
    arms,
    bumps,
    surface,
    thetaForY,
    localRadius,
    eye: { center: eyeCenter, axis: eyeAxis, r: eye.r, a: aEye, th: thEye },
    nostril: { a: aNos, th: thNos, r: nos.r },
    jaw: { pivot: jawPivot },
    bound,
    backTop,
    bellyLow,
    snoutLocal: path.point(L).sub(bones[index.head].pos),
    legLength: legs[0].lengths[0] + legs[0].lengths[1] + legs[0].lengths[2],
  };
}


/* --- Blueprint extras: sculpting, hit volumes, pose solving -------------- */

const V3 = THREE.Vector3;
const sq = (x) => x * x;

/** Centre of the cross-section at arc `a` (bind pose); returns its bounding radius. */
function sectionCentre(bp, a, out) {
  const pr = bp.prof(a, {});
  const T = bp.path.tangent(a, new V3());
  const U = new V3().crossVectors(T, new V3(1, 0, 0)).normalize();
  bp.path.point(a, out).addScaledVector(U, (pr.t - pr.b) * 0.5);
  return Math.max(pr.w, (pr.t + pr.b) * 0.5);
}

/** Bone that dominates the skin at arc `a` of the main loft. */
function dominantBone(bp, a) {
  const inf = chainInfluence(a, bp.centers, new Influence());
  let best = 0;
  let bw = -1;
  for (let i = 0; i < inf.n; i++) {
    if (inf.w[i] > bw) {
      bw = inf.w[i];
      best = inf.b[i];
    }
  }
  return best;
}

/**
 * Second blueprint pass: extra skull sculpting, ballistic hit spheres, and the
 * per-species pose numbers the animator needs (how far the neck bends to
 * reach the ground, how low the hips go lying down, how long a stride the legs
 * can reach without skating).
 */
function extendBlueprint(bp) {
  const { body, head, path, index: I, bones, H } = bp;
  const hd = head.def;
  const f = body.features || {};
  const pr = {};

  /* Sculpting. */
  if (hd.teeth && !hd.teeth.peg) {
    // Theropods: a shallow antorbital fossa and bulging jaw muscles behind the eye.
    const a1 = head.arcAtU(0.5);
    bp.prof(a1, pr);
    bp.bumps.push({ a: a1, th: bp.thetaForY(a1, pr.t * 0.42), rs: head.len * 0.11, rt: head.len * 0.05, amp: -head.len * 0.016, accent: 0, mirror: true });
    const a2 = head.arcAtU(0.06);
    bp.prof(a2, pr);
    bp.bumps.push({ a: a2, th: bp.thetaForY(a2, pr.t * 0.12), rs: head.len * 0.09, rt: head.len * 0.07, amp: head.len * 0.02, accent: 0, mirror: true });
  }
  if (f.throatGular) {
    // Stegosaur throat ossicles: a pebbly patch under the neck.
    const aN0 = path.arcAtZ(body.bones.neckZ);
    for (let k = 0; k < 8; k++) {
      const a = lerp(aN0, head.a0, 0.12 + k * 0.1);
      const th = Math.PI * (k % 2 ? 0.86 : -0.9);
      bp.bumps.push({ a, th, rs: 0.05, rt: 0.045, amp: 0.024, accent: 0.4, mirror: false });
    }
  }

  bp.ribSpan = Math.max(0.25, (bp.aChest - bp.aHips) * 0.65);
  for (const leg of bp.legs) {
    const r = leg.def.radii.top;
    leg.flankR = Math.max(r[0], r[1], r[2]) * 1.7;
  }

  /* Hit spheres: { bone, off (bind offset from the bone), r, part }. */
  const hits = [];
  const addAt = (a, part, rMul = 1) => {
    const c = new V3();
    const r = sectionCentre(bp, a, c) * rMul;
    const b = dominantBone(bp, a);
    hits.push({ bone: b, off: c.sub(bones[b].pos), r, part });
  };
  // Head: skull and snout, tight around upper + lower jaw.
  const jawDepth = pchip(hd.jaw.depth.map((d) => d[0]), hd.jaw.depth.map((d) => d[1]));
  for (const u of [0.24, 0.68]) {
    const a = head.arcAtU(u);
    bp.prof(a, pr);
    const jd = jawDepth(u);
    const c = head.O.clone().addScaledVector(head.D, u * head.len).addScaledVector(head.N, (pr.t - pr.b - jd) * 0.5);
    const r = Math.max(pr.w * 1.05, (pr.t + pr.b + jd) * 0.5);
    hits.push({ bone: I.head, off: c.sub(bones[I.head].pos), r, part: "head" });
  }
  // Neck.
  const aNeck = path.arcAtZ(body.bones.neckZ);
  const aHeadJ = head.arcAtU(0.0);
  const neckR = bp.localRadius((aNeck + aHeadJ) * 0.5);
  const nNeckHits = clamp(Math.round((aHeadJ - aNeck) / (neckR * 2.2)), 1, 5);
  for (let k = 0; k < nNeckHits; k++) addAt(lerp(aNeck, aHeadJ, (k + 0.5) / nNeckHits), "neck", 1.05);
  // Body.
  const aBack = bp.aHips;
  const aFront = Math.max(bp.aChest, (aNeck + bp.aChest) * 0.5);
  const bodyR = bp.localRadius(bp.aRibs);
  const nBody = clamp(Math.round((aFront - aBack) / (bodyR * 1.3)) + 1, 2, 4);
  for (let k = 0; k < nBody; k++) addAt(lerp(aBack, aFront, k / (nBody - 1)), "body", 1.0);
  // Tail.
  for (const fr of [0.82, 0.55, 0.3]) addAt(bp.aHips * fr, "tail", 1.08);
  // Legs: thigh + shin for bipeds, one sphere per limb for quadrupeds.
  for (const leg of bp.legs) {
    const rad = leg.def.radii;
    const rT = Math.max(...rad.thigh);
    const rC = Math.max(...rad.calf);
    if (bp.quad) {
      const c = leg.hip.clone().lerp(leg.knee, 0.6);
      hits.push({ bone: leg.bones[0], off: c.sub(leg.hip), r: rT * 1.25, part: "leg" });
    } else {
      const c1 = leg.hip.clone().lerp(leg.knee, 0.45);
      hits.push({ bone: leg.bones[0], off: c1.sub(leg.hip), r: rT * 1.15, part: "leg" });
      const c2 = leg.knee.clone().lerp(leg.ankle, 0.4);
      hits.push({ bone: leg.bones[1], off: c2.sub(leg.knee), r: rC * 1.2, part: "leg" });
    }
  }
  bp.hits = hits;

  /* Tail tip (for getTailPosition) relative to the last tail bone. */
  const lastTail = I["tail" + (body.bones.tail - 1)];
  bp.tailBone = lastTail;
  bp.tailLocal = path.point(bp.L * 0.03).sub(bones[lastTail].pos);

  /* Planar FK of the trunk + neck chain, used to solve the feeding poses. */
  const chain = [I.hips, I.spine, I.chest];
  for (let k = 0; k < body.bones.neck; k++) chain.push(I["neck" + k]);
  chain.push(I.head);
  const snout = path.point(bp.L);
  const snoutY = (hipsY, angles) => {
    let y = hipsY;
    let ang = 0;
    for (let j = 0; j < chain.length; j++) {
      ang += angles[j];
      const from = bones[chain[j]].pos;
      const to = j + 1 < chain.length ? bones[chain[j + 1]].pos : snout;
      const oy = to.y - from.y;
      const oz = to.z - from.z;
      y += oy * Math.cos(ang) - oz * Math.sin(ang);
    }
    return y;
  };
  const nNeck = body.bones.neck;
  // How a lowering neck shares its bend: evenly by default; `body.neckFlexBase`
  // (0..0.95) moves it toward the base, so a tall, deep-necked sauropod reaches
  // the ground with a straight sloping neck instead of curling it (and kneeling).
  const flexBase = clamp(body.neckFlexBase ?? 0, 0, 0.95);
  bp.neckFlex = null;
  if (flexBase > 0) {
    const w = [];
    for (let k = 0; k < nNeck; k++) w.push(1 - flexBase * (nNeck > 1 ? k / (nNeck - 1) : 0));
    const sum = w.reduce((acc, v) => acc + v, 0);
    bp.neckFlex = w.map((v) => v / sum);
  }
  const flexW = bp.neckFlex;
  const solveBend = (drop, hipsPitch, spinePitch, chestPitch, headPitch, target) => {
    const angles = new Array(chain.length).fill(0);
    angles[0] = hipsPitch;
    angles[1] = spinePitch;
    angles[2] = chestPitch;
    angles[chain.length - 1] = headPitch;
    let best = 0;
    let bestY = Infinity;
    for (let B = 0; B <= 2.4; B += 0.02) {
      for (let k = 0; k < nNeck; k++) angles[3 + k] = flexW ? B * flexW[k] : B / nNeck;
      const y = snoutY(H - drop, angles);
      if (y < bestY) {
        bestY = y;
        best = B;
      }
      if (y <= target) return { B, y };
    }
    return { B: best, y: bestY };
  };
  const quad = bp.quad;
  // Lean / crouch further until the snout actually reaches the target height.
  // `body.feedLean` scales how far a quadruped dips its shoulders before the
  // neck takes over (a sauropod's neck does the reaching; its legs stay columns).
  const lean = body.feedLean ?? 1;
  const solvePose = (headPitch, target) => {
    const p = quad
      ? { drop: H * 0.03 * lean, hips: 0.0, spine: 0.04 * lean, chest: 0.08 * lean, head: headPitch }
      : { drop: H * 0.1, hips: 0.3, spine: 0.05, chest: 0.05, head: headPitch };
    for (let it = 0; it < 14; it++) {
      const r = solveBend(p.drop, p.hips, p.spine, p.chest, p.head, target);
      p.bend = r.B;
      if (r.y <= target + H * 0.01) break;
      if (quad) {
        p.chest += 0.04;
        p.drop += H * 0.015;
      } else {
        p.hips += 0.035;
        p.drop += H * 0.018;
      }
    }
    return p;
  };
  bp.eat = solvePose(0.32, H * 0.06);
  bp.drink = solvePose(0.42, -H * 0.015);

  /* Lying down: hips height that rests the belly on the ground. */
  const restPitch = quad ? 0.0 : 0.07;
  let low = Infinity;
  let widest = 0;
  for (const s of bp.st) {
    if (s.head || s.z < body.bones.tailZ || s.z > body.bones.neckZ) continue;
    const dy = s.y - s.b - H;
    low = Math.min(low, dy * Math.cos(restPitch) - s.z * Math.sin(restPitch));
    widest = Math.max(widest, s.w);
  }
  bp.rest = { pitch: restPitch, hipsY: Math.max(0.05, -low + H * 0.015) };
  bp.dead = { hipsY: widest * 0.94 };

  /* Longest stance (half-length, model units) every leg can reach, walking
     upright and running in the lowered, bent-leg sprint posture. */
  const RUN_DROP = 0.08;
  bp.runDrop = RUN_DROP;
  const reachHalf = (leg, drop, ext) => {
    const [l1, l2, l3] = leg.lengths;
    const ankleY = leg.ballH + l3 * Math.cos(leg.phi);
    const hy = (leg.fore ? leg.hip.y : H) - H * drop - ankleY;
    const reach = Math.sqrt(Math.max(0, sq((l1 + l2) * ext) - hy * hy));
    return Math.max(0.1 * (l1 + l2), reach - Math.abs(leg.ankle.z - leg.hip.z));
  };
  const st = { walk: Infinity, run: Infinity, walkHind: Infinity, runHind: Infinity };
  for (const leg of bp.legs) {
    const w = reachHalf(leg, 0.03, 0.96);
    const r = reachHalf(leg, RUN_DROP + 0.02, 0.985);
    leg.reachHalf = w;
    st.walk = Math.min(st.walk, w);
    st.run = Math.min(st.run, r);
    if (!leg.fore) {
      st.walkHind = Math.min(st.walkHind, w);
      st.runHind = Math.min(st.runHind, r);
    }
  }
  for (const k in st) st[k] *= 0.92;
  bp.stance = st;

  /* Static bind bases for the IK aim (see aimRotation). */
  const X = new V3(1, 0, 0);
  const basisT = (from, to) => {
    const d = to.clone().sub(from).normalize();
    const y = X.clone().addScaledVector(d, -X.dot(d));
    if (y.lengthSq() < 1e-6) y.set(0, 0, 1).addScaledVector(d, -d.z);
    y.normalize();
    const z = new V3().crossVectors(d, y);
    return new THREE.Matrix4().makeBasis(d, y, z).transpose();
  };
  for (const leg of bp.legs) {
    leg.basisT = [basisT(leg.hip, leg.knee), basisT(leg.knee, leg.ankle), basisT(leg.ankle, leg.ball), basisT(leg.ball, leg.toeEnd)];
    leg.metaDir = leg.ankle.clone().sub(leg.ball).normalize();
    leg.toeSlope = Math.atan2(leg.ball.y - leg.toeEnd.y, leg.toeEnd.z - leg.ball.z);
    leg.parentIndex = I[leg.parentName];
    leg.hipLocal = leg.hip.clone().sub(bones[leg.parentIndex].pos);
    leg.len = leg.lengths[0] + leg.lengths[1] + leg.lengths[2];
  }
}

/* --- Geometry: primitives ------------------------------------------------ */

/**
 * Join consecutive rings of `segs` vertices into a closed tube. Rings are
 * parametrised P = C + cos(φ)·A + sin(φ)·B; the winding faces outward when
 * A × B points along the tube axis, `flip` handles the opposite case.
 */
function tube(B, first, rings, segs, flip) {
  for (let i = 0; i < rings - 1; i++) {
    const r0 = first + i * segs;
    const r1 = r0 + segs;
    for (let j = 0; j < segs; j++) {
      const j1 = (j + 1) % segs;
      const a = r0 + j;
      const b = r0 + j1;
      const c = r1 + j;
      const d = r1 + j1;
      if (flip) {
        B.tri(a, d, b);
        B.tri(a, c, d);
      } else {
        B.tri(a, b, d);
        B.tri(a, d, c);
      }
    }
  }
}

/** Close a ring with a fan to `centre`; `end` = the ring is the last one along the axis. */
function fan(B, ring, segs, centre, end, flip) {
  const out = end !== flip;
  for (let j = 0; j < segs; j++) {
    const a = ring + j;
    const b = ring + ((j + 1) % segs);
    if (out) B.tri(a, b, centre);
    else B.tri(a, centre, b);
  }
}

const _sp = { C: new V3(), T: new V3(), W: new V3(), V: new V3(), P: new V3() };

/**
 * Lofted horn / claw / tooth / spike / plate: elliptical sections along an
 * axis that can bend (quadratic) toward `bendDir`, closing to a tip.
 * Options: base, dir, wide (axis of the `rw` radius), len, rw, rt, bendDir,
 * bend, segs, rings, prof(s) & profT(s) (radius factors 0 base → 1 tip),
 * shade(s, look) per ring, look, inf, cap (close the base).
 */
function spike(B, o) {
  const segs = o.segs ?? 6;
  const rings = o.rings ?? 4;
  const prof = o.prof || ((s) => Math.pow(1 - s, 0.85));
  const profT = o.profT || prof;
  const { C, T, W, V, P } = _sp;
  const first = B.count;
  const bend = o.bend || 0;
  for (let i = 0; i < rings; i++) {
    const s = i / rings;
    C.copy(o.base).addScaledVector(o.dir, o.len * s);
    T.copy(o.dir);
    if (bend) {
      C.addScaledVector(o.bendDir, bend * o.len * s * s);
      T.addScaledVector(o.bendDir, 2 * bend * s);
    }
    T.normalize();
    W.copy(o.wide).addScaledVector(T, -o.wide.dot(T));
    if (W.lengthSq() < 1e-8) W.set(0, 1, 0).addScaledVector(T, -T.y);
    W.normalize();
    V.crossVectors(T, W);
    const fw = prof(s) * o.rw;
    const ft = profT(s) * o.rt;
    if (o.shade) o.shade(s, o.look);
    for (let j = 0; j < segs; j++) {
      const ang = (j / segs) * TAU;
      P.copy(C).addScaledVector(W, Math.cos(ang) * fw).addScaledVector(V, Math.sin(ang) * ft);
      B.vert(P.x, P.y, P.z, o.look, o.inf);
    }
  }
  C.copy(o.base).addScaledVector(o.dir, o.len);
  if (bend) C.addScaledVector(o.bendDir, bend * o.len);
  if (o.shade) o.shade(1, o.look);
  const tip = B.vert(C.x, C.y, C.z, o.look, o.inf);
  tube(B, first, rings, segs, false);
  fan(B, first + (rings - 1) * segs, segs, tip, true, false);
  if (o.cap) {
    if (o.shade) o.shade(0, o.look);
    const c = B.vert(o.base.x, o.base.y, o.base.z, o.look, o.inf);
    fan(B, first, segs, c, false, false);
  }
  return tip;
}

/** Weights along a limb: `firstBone` up to the first joint, then each joint's bone. */
function jointInfluence(s, firstBone, joints, inf) {
  inf.reset();
  let bone = firstBone;
  let w = 1;
  for (const J of joints) {
    const u = smoothstep(J.s - J.w, J.s + J.w, s);
    inf.add(bone, w * (1 - u));
    w *= u;
    bone = J.bone;
  }
  inf.add(bone, w);
  return inf;
}

/**
 * Lofted limb along a smooth curve through `pts` with [halfWidth, front,
 * back] radii per point. Options: pts, rad, fwd (which way "front" faces),
 * firstBone, joints [{ at: point index, w, bone }], segs, rings, look,
 * flatEnd (flatten the end cap onto the ground plane: padded feet).
 */
function limbLoft(B, o) {
  const curve = new THREE.CatmullRomCurve3(o.pts, false, "centripetal");
  const NL = 200;
  curve.arcLengthDivisions = NL;
  const lens = curve.getLengths(NL);
  const total = lens[NL];
  const n = o.pts.length;
  const sArc = [];
  for (let k = 0; k < n; k++) sArc.push(lens[Math.round((k / (n - 1)) * NL)]);
  for (let k = 1; k < n; k++) if (sArc[k] <= sArc[k - 1]) sArc[k] = sArc[k - 1] + 1e-4;
  const fw = pchip(sArc, o.rad.map((r) => r[0]));
  const ff = pchip(sArc, o.rad.map((r) => r[1]));
  const fb = pchip(sArc, o.rad.map((r) => r[2]));
  const joints = o.joints.map((J) => ({ s: sArc[J.at] + (J.shift || 0), w: J.w, bone: J.bone }));
  const P = new V3();
  const T = new V3();
  const F = new V3();
  const S = new V3();
  const Q = new V3();
  const inf = new Influence();
  const first = B.count;
  const { rings, segs, look } = o;
  for (let i = 0; i < rings; i++) {
    // Rings bunch slightly toward the ends, where the caps need the curvature.
    const x = i / (rings - 1);
    const s = (x - 0.06 * Math.sin(TAU * x)) * total;
    const t = curve.getUtoTmapping(0, Math.max(1e-6, s));
    curve.getPoint(t, P);
    curve.getTangent(clamp(t, 1e-4, 1 - 1e-4), T).normalize();
    F.copy(o.fwd).addScaledVector(T, -o.fwd.dot(T));
    if (F.lengthSq() < 1e-4) F.set(0, 1, 0).addScaledVector(T, -T.y);
    F.normalize();
    S.crossVectors(F, T);
    const w = fw(s);
    const rf = ff(s);
    const rb = fb(s);
    jointInfluence(s, o.firstBone, joints, inf);
    for (let j = 0; j < segs; j++) {
      const ph = (j / segs) * TAU;
      const c = Math.cos(ph);
      const sn = Math.sin(ph);
      Q.copy(P).addScaledVector(F, c * (c >= 0 ? rf : rb)).addScaledVector(S, sn * w);
      if (o.flatEnd && i === rings - 1) Q.y = Math.max(Q.y, 0.004);
      B.vert(Q.x, Q.y, Q.z, look, inf);
    }
  }
  tube(B, first, rings, segs, true);
  // Caps: the start sits inside the body; the end rounds off (or lands flat).
  jointInfluence(0, o.firstBone, joints, inf);
  const p0 = o.pts[0];
  const c0 = B.vert(p0.x, p0.y, p0.z, look, inf);
  fan(B, first, segs, c0, false, true);
  jointInfluence(total, o.firstBone, joints, inf);
  curve.getPoint(1, P);
  curve.getTangent(1 - 1e-4, T).normalize();
  if (o.flatEnd) P.y = 0;
  else P.addScaledVector(T, o.rad[n - 1][0] * 0.55);
  const c1 = B.vert(P.x, P.y, P.z, look, inf);
  fan(B, first + (rings - 1) * segs, segs, c1, true, true);
  return { curve, total, sArc };
}

/* --- Geometry: body loft ------------------------------------------------- */

/** Ring positions along the main loft: denser on the head and the bulky body. */
function ringArcs(bp, count) {
  const S = 1600;
  const L = bp.L;
  const r = new Float64Array(S);
  let rMax = 0;
  for (let i = 0; i < S; i++) {
    r[i] = bp.localRadius(((i + 0.5) / S) * L);
    rMax = Math.max(rMax, r[i]);
  }
  const headA = bp.head.a0 - 0.15 * bp.head.len;
  const cum = new Float64Array(S + 1);
  for (let i = 0; i < S; i++) {
    const a = ((i + 0.5) / S) * L;
    const d = (0.45 + 0.55 * Math.sqrt(r[i] / rMax)) * (a > headA ? 2.9 : 1) * (a < L * 0.02 || a > L * 0.995 ? 1.8 : 1);
    cum[i + 1] = cum[i] + d;
  }
  const out = [];
  let i = 0;
  for (let k = 1; k <= count; k++) {
    const target = (k / (count + 1)) * cum[S];
    while (i < S - 1 && cum[i + 1] < target) i++;
    const fr = (target - cum[i]) / Math.max(1e-9, cum[i + 1] - cum[i]);
    out.push(((i + fr) / S) * L);
  }
  return out;
}

/** Skin weights of a main-loft vertex: spine chain + jaw (throat), ribs (belly), thighs (flanks). */
function bodyInfluence(bp, a, ths, p, inf) {
  inf.reset();
  chainInfluence(a, bp.centers, inf);
  const at = Math.abs(ths);
  const bottom = smoothstep(0.52 * Math.PI, 0.88 * Math.PI, at);
  const head = bp.head;
  if (bottom > 0 && a > head.a0 - 0.3 * head.len) {
    // The throat stretches with the jaw so the mouth can open without tearing.
    const u = head.uAtArc(a);
    const f = bottom * smoothstep(-0.12, 0.06, u) * (1 - smoothstep(0.17, 0.32, u)) * 0.75;
    if (f > 0.001) inf.scale(1 - f).add(bp.index.jaw, f);
  }
  if (bottom > 0) {
    const d = Math.abs(a - bp.aRibs) / bp.ribSpan;
    const f = bottom * (1 - smoothstep(0.35, 1, d)) * 0.7;
    if (f > 0.001) inf.scale(1 - f).add(bp.index.ribs, f);
  }
  for (const leg of bp.legs) {
    if (p.x * leg.side <= 0) continue;
    const R = leg.flankR;
    const d = Math.sqrt(sq(p.x - leg.hip.x) + sq(p.y - leg.hip.y) + sq(p.z - leg.hip.z));
    if (d >= R) continue;
    const lateral = smoothstep(0, 0.6, Math.abs(p.x) / Math.max(0.01, Math.abs(leg.hip.x) + 0.5 * R));
    const f = (1 - smoothstep(0.3 * R, R, d)) * 0.4 * lateral;
    if (f > 0.001) inf.scale(1 - f).add(leg.bones[0], f);
  }
  return inf;
}

/** Surface look of a main-loft vertex: mouth lining, beak, nostrils, a calmer pattern on the head. */
function bodyLook(bp, look, a, u, ths, R, acc) {
  look.skin = 1;
  look.pattern = 1;
  look.accent = clamp(acc, 0, 1);
  look.detail = 1;
  look.rough = 0.8;
  look.glint = 0;
  if (u < -0.45) return look;
  look.pattern = u < 0 ? lerp(1, 0.55, smoothstep(-0.45, 0, u)) : 0.55;
  if (u < 0) return look;
  const hd = bp.head.def;
  const at = Math.abs(ths);
  const mouth = smoothstep(0.74 * Math.PI, 0.86 * Math.PI, at) * smoothstep(hd.jaw.hinge - 0.02, hd.jaw.hinge + 0.12, u);
  look.color.copy(FIXED_LINEAR.mouth);
  let skin = 1 - mouth;
  if (hd.beak > 0) {
    const k = smoothstep(1 - hd.beak - 0.05, 1 - hd.beak + 0.04, u);
    if (k > 0) {
      look.color.lerp(FIXED_LINEAR.beak, k);
      skin *= 1 - k;
      look.rough = lerp(0.8, 0.5, k);
    }
  }
  const n = bp.nostril;
  const dA = a - n.a;
  const dT = Math.min(Math.abs(wrapPi(ths - n.th)), Math.abs(wrapPi(ths + n.th))) * R;
  const kn = 1 - smoothstep(0.5, 1.05, Math.sqrt(dA * dA + dT * dT) / n.r);
  if (kn > 0) {
    look.color.lerp(FIXED_LINEAR.nostril, kn);
    skin *= 1 - kn;
  }
  look.skin = skin;
  look.detail = lerp(0.4, 1, skin);
  look.rough = lerp(look.rough, 0.45, mouth);
  return look;
}

function buildBody(bp, lod, B) {
  const radial = lod.radial;
  const rings = Math.round(BODY_RINGS * lod.rings * (bp.L > 16 ? 1.35 : 1));
  const arcs = ringArcs(bp, rings);
  const look = makeLook();
  const inf = new Influence();
  const P = new V3();
  const N = new V3();
  const first = B.count;
  for (const a of arcs) {
    const R = bp.localRadius(a);
    const u = a >= bp.head.a0 - 0.45 * bp.head.len ? bp.head.uAtArc(a) : -1;
    for (let j = 0; j < radial; j++) {
      const th = (j / radial) * TAU;
      const ths = wrapPi(th);
      bp.surface(a, th, P, N);
      let disp = 0;
      let acc = 0;
      for (const b of bp.bumps) {
        const ga = (a - b.a) / b.rs;
        if (ga > 3.2 || ga < -3.2) continue;
        const ea = Math.exp(-ga * ga);
        let g = Math.exp(-sq((wrapPi(ths - b.th) * R) / b.rt));
        if (b.mirror) g += Math.exp(-sq((wrapPi(ths + b.th) * R) / b.rt));
        disp += b.amp * ea * g;
        acc += b.accent * ea * g;
      }
      if (disp !== 0) P.addScaledVector(N, disp);
      bodyLook(bp, look, a, u, ths, R, acc);
      bodyInfluence(bp, a, ths, P, inf);
      B.vert(P.x, P.y, P.z, look, inf);
    }
  }
  tube(B, first, arcs.length, radial, true);
  bodyLook(bp, look, 0, -1, 0, 0, 0);
  const tail = bp.path.point(0);
  const ti = B.vert(tail.x, tail.y, tail.z, look, bodyInfluence(bp, 0, 0, tail, inf));
  fan(B, first, radial, ti, false, true);
  bodyLook(bp, look, bp.L, 1, 0, 0, 0);
  const nose = bp.path.point(bp.L);
  const ni = B.vert(nose.x, nose.y, nose.z, look, bodyInfluence(bp, bp.L, 0, nose, inf));
  fan(B, first + (arcs.length - 1) * radial, radial, ni, true, true);
}

/* --- Geometry: head parts ------------------------------------------------ */

function headInfluence(bp, bone) {
  return new Influence().add(bone ?? bp.index.head, 1);
}

/** Eyeballs: concentric rings around the gaze axis so iris and pupil stay round (slit for predators). */
function buildEyes(bp, lod, B) {
  const e = bp.eye;
  const sp = bp.sp;
  const iris = new THREE.Color(sp.colors.eye);
  const irisDark = iris.clone().multiplyScalar(0.45);
  const irisLight = iris.clone().lerp(new THREE.Color(1, 0.95, 0.8), 0.25);
  const pupil = FIXED_LINEAR.pupil;
  const rim = new THREE.Color(0.02, 0.018, 0.015);
  const slit = sp.diet === "carnivore";
  const alphas = lod.detail ? [0.12, 0.24, 0.36, 0.5, 0.64, 0.8, 0.95, 1.2, 1.65, 2.3] : [0.3, 0.62, 0.95, 1.6];
  const segs = lod.detail ? 14 : 8;
  const look = makeLook();
  look.skin = 0;
  look.pattern = 0;
  look.detail = 0;
  look.rough = 0.12;
  look.glint = 1;
  const inf = headInfluence(bp);
  const A = new V3();
  const U1 = new V3();
  const U2 = new V3();
  const C = new V3();
  const P = new V3();
  const colorAt = (alpha, phi, out) => {
    const pr = slit ? 0.07 + 0.3 * Math.abs(Math.cos(phi)) : 0.3;
    if (alpha < pr) return out.copy(pupil);
    if (alpha < pr + 0.1) return out.copy(pupil).lerp(irisDark, (alpha - pr) / 0.1);
    if (alpha < 0.55) return out.copy(irisDark).lerp(irisLight, smoothstep(pr + 0.1, 0.55, alpha));
    if (alpha < 0.85) return out.copy(irisLight).lerp(irisDark, smoothstep(0.55, 0.85, alpha));
    return out.copy(irisDark).lerp(rim, smoothstep(0.85, 1.0, alpha));
  };
  for (const side of [1, -1]) {
    C.copy(e.center);
    C.x *= side;
    A.copy(e.axis);
    A.x *= side;
    A.normalize();
    U1.set(0, 1, 0).addScaledVector(A, -A.y).normalize(); // "up" on the eye: slit pupils stand vertical
    U2.crossVectors(A, U1);
    const r = e.r;
    look.color.copy(pupil);
    const front = B.vert(C.x + A.x * r, C.y + A.y * r, C.z + A.z * r, look, inf);
    const first = B.count;
    for (const al of alphas) {
      const ca = Math.cos(al);
      const sa = Math.sin(al);
      for (let j = 0; j < segs; j++) {
        const phi = (j / segs) * TAU;
        colorAt(al, phi, look.color);
        P.copy(C).addScaledVector(A, r * ca).addScaledVector(U1, r * sa * Math.cos(phi)).addScaledVector(U2, r * sa * Math.sin(phi));
        B.vert(P.x, P.y, P.z, look, inf);
      }
    }
    look.color.copy(rim);
    const back = B.vert(C.x - A.x * r, C.y - A.y * r, C.z - A.z * r, look, inf);
    // Rings run front → back with angle φ from U1 toward U2 (U1 × U2 = A, i.e. against the run).
    fan(B, first, segs, front, false, true);
    tube(B, first, alphas.length, segs, true);
    fan(B, first + (alphas.length - 1) * segs, segs, back, true, true);
  }
}

/** Lower jaw: its own loft under the mouth line, hinged at the jaw bone. */
function buildJaw(bp, lod, B) {
  const head = bp.head;
  const hd = head.def;
  const jd = hd.jaw;
  const depthF = pchip(jd.depth.map((d) => d[0]), jd.depth.map((d) => d[1]));
  const rings = lod.detail ? 24 : 10;
  const segs = lod.detail ? 16 : 10;
  const look = makeLook();
  const inf = headInfluence(bp, bp.index.jaw);
  const pr = {};
  const sec = { x: 0, y: 0 };
  const P = new V3();
  const first = B.count;
  const u0 = -0.02;
  const ringU = [];
  for (let i = 0; i < rings; i++) {
    const x = i / (rings - 1);
    ringU.push(lerp(u0, 0.995, x - 0.05 * Math.sin(TAU * x)));
  }
  for (const u of ringU) {
    const a = head.arcAtU(clamp(u, 0, 1));
    bp.prof(a, pr);
    const depth = depthF(clamp(u, 0, 1)) * (u < 0 ? 0.8 : 1);
    const w = jd.width * pr.w * (1 - 0.25 * smoothstep(0.85, 1, u));
    const top = pr.b * 0.72;
    const half = depth * 0.5;
    const cy = -(top + half);
    for (let j = 0; j < segs; j++) {
      const th = (j / segs) * TAU;
      section(th, w, half, half, 2.3, 0.14, sec);
      const at = Math.abs(wrapPi(th));
      // Inside of the mouth on top, skin (with the shader's pale belly) below.
      const inner = 1 - smoothstep(0.16 * Math.PI, 0.27 * Math.PI, at);
      look.color.copy(FIXED_LINEAR.mouth).lerp(FIXED_LINEAR.tongue, 1 - smoothstep(0.05 * Math.PI, 0.2 * Math.PI, at));
      let skin = 1 - inner;
      look.rough = lerp(0.8, 0.45, inner);
      if (hd.beak > 0) {
        const k = smoothstep(1 - hd.beak - 0.05, 1 - hd.beak + 0.04, u);
        if (k > 0) {
          look.color.lerp(FIXED_LINEAR.beak, k * (1 - inner * 0.5));
          skin *= 1 - k;
        }
      }
      look.skin = skin;
      look.pattern = 0.4;
      look.detail = lerp(0.3, 1, skin);
      P.copy(head.O).addScaledVector(head.D, u * head.len).addScaledVector(head.N, cy + sec.y);
      P.x += sec.x;
      B.vert(P.x, P.y, P.z, look, inf);
    }
  }
  // Rings run along D with φ from N (top) toward +X: N × X = -D → flipped winding.
  tube(B, first, rings, segs, true);
  look.skin = 1;
  look.color.copy(FIXED_LINEAR.mouth);
  const back = head.O.clone().addScaledVector(head.D, u0 * head.len - 0.01).addScaledVector(head.N, -(bp.prof(head.a0, pr).b * 0.85 + depthF(0) * 0.4));
  const bi = B.vert(back.x, back.y, back.z, look, inf);
  fan(B, first, segs, bi, false, true);
  if (hd.beak > 0) {
    look.color.copy(FIXED_LINEAR.beak);
    look.skin = 0;
  }
  const tip = head.O.clone().addScaledVector(head.D, head.len * 1.0).addScaledVector(head.N, -(bp.prof(head.a1, pr).b * 0.85 + depthF(1) * 0.5));
  const ti = B.vert(tip.x, tip.y, tip.z, look, inf);
  fan(B, first + (rings - 1) * segs, segs, ti, true, true);
}

/** Teeth: recurved blades along the upper lip line and the jaw's edge (pegs for sauropods). */
function buildTeeth(bp, B) {
  const head = bp.head;
  const hd = head.def;
  const td = hd.teeth;
  if (!td) return;
  const jd = hd.jaw;
  const depthF = pchip(jd.depth.map((d) => d[0]), jd.depth.map((d) => d[1]));
  const look = makeLook();
  look.skin = 0;
  look.pattern = 0;
  look.detail = 0;
  look.rough = 0.35;
  look.color.copy(FIXED_LINEAR.tooth);
  const pr = {};
  const D = head.D;
  const N = head.N;
  const negN = N.clone().negate();
  const back = D.clone().negate();
  const base = new V3();
  const dir = new V3();
  const rows = [
    { count: td.upper, bone: bp.index.head, upper: true },
    { count: td.lower, bone: bp.index.jaw, upper: false },
  ];
  for (const row of rows) {
    const inf = headInfluence(bp, row.bone);
    for (const side of [1, -1]) {
      for (let k = 0; k < row.count; k++) {
        const f = (k + 0.5) / row.count;
        const u = lerp(td.from, td.to, f) + (row.upper ? 0 : 0.5 / row.count);
        if (u > 0.985) continue;
        const a = head.arcAtU(u);
        bp.prof(a, pr);
        // Biggest teeth a third of the way along the tooth row, small at the front and back.
        const len = td.length * (0.5 + 0.5 * Math.sin(Math.PI * Math.pow(f, 0.75))) * (row.upper ? 0.85 : 0.75);
        const jawW = jd.width * pr.w;
        if (row.upper) {
          base.copy(head.O).addScaledVector(D, u * head.len).addScaledVector(N, pr.b * 0.1);
          base.x += side * pr.w * 0.86;
          dir.copy(negN).addScaledVector(D, td.peg ? 0.5 : -0.12).normalize();
        } else {
          const top = pr.b * 0.85;
          base.copy(head.O).addScaledVector(D, u * head.len).addScaledVector(N, -top - depthF(u) * 0.15);
          base.x += side * jawW * 0.78;
          dir.copy(N).addScaledVector(D, td.peg ? 0.5 : -0.08).normalize();
        }
        spike(B, {
          base,
          dir,
          wide: D,
          len: td.peg ? len * 0.8 : len,
          rw: len * (td.peg ? 0.22 : 0.32),
          rt: len * (td.peg ? 0.2 : 0.15),
          bendDir: back,
          bend: td.peg ? 0 : 0.22,
          segs: 4,
          rings: 2,
          prof: (s) => 1 - s * 0.55,
          look,
          inf,
        });
      }
    }
  }
}

/* --- Geometry: limbs ----------------------------------------------------- */

const _lerpV = (a, b, t) => a.clone().lerp(b, t);

function buildLeg(bp, leg, lod, B) {
  const d = leg.def;
  const r = d.radii;
  const pad = !!d.foot.pad;
  const topR = Math.max(...r.top);
  const top = leg.hip.clone().add(new V3(-leg.side * topR * 0.2, topR * 0.55, 0));
  const pts = [top, leg.hip, _lerpV(leg.hip, leg.knee, 0.42), leg.knee, _lerpV(leg.knee, leg.ankle, 0.3), leg.ankle, _lerpV(leg.ankle, leg.ball, 0.5), leg.ball];
  const rad = [r.top, r.hip, r.thigh, r.knee, r.calf, r.ankle, r.meta, r.ball];
  if (pad) {
    // Graviportal feet: the column spreads into a fleshy pad that lands flat.
    const b = r.ball;
    pts.push(leg.ball.clone().add(new V3(0, -leg.ballH * 0.72, d.toe * 0.08)));
    rad.push([b[0] * 1.12, b[1] * 1.12, b[2] * 1.08]);
  }
  const [l1, l2, l3] = leg.lengths;
  const [bU, bL, bM, bF] = leg.bones;
  const look = makeLook();
  look.pattern = 0.7;
  limbLoft(B, {
    pts,
    rad,
    fwd: new V3(0, 0, 1),
    firstBone: leg.parentIndex,
    joints: [
      { at: 1, w: topR * 0.9, bone: bU, shift: -topR * 0.2 },
      { at: 3, w: 0.2 * Math.min(l1, l2), bone: bL },
      { at: 5, w: 0.2 * Math.min(l2, l3), bone: bM },
      { at: 7, w: Math.max(...r.ball) * 0.5, bone: bF, shift: -Math.max(...r.ball) * 0.3 },
    ],
    segs: lod.limbRadial,
    rings: Math.max(10, Math.round(30 * lod.limbRings)),
    look,
    flatEnd: pad,
  });
  buildFoot(bp, leg, lod, B);
}

function clawLook(look, hoof) {
  look.skin = 0;
  look.pattern = 0;
  look.detail = 0;
  look.accent = 0;
  look.rough = hoof ? 0.6 : 0.35;
  look.color.copy(hoof ? FIXED_LINEAR.hoof : FIXED_LINEAR.claw);
  return look;
}

function buildFoot(bp, leg, lod, B) {
  const d = leg.def;
  const foot = d.foot;
  const side = leg.side;
  const ballR = d.radii.ball[0];
  const look = makeLook();
  look.pattern = 0.3;
  const cl = clawLook(makeLook(), !!foot.hoof);
  const infFoot = new Influence().add(leg.bones[3], 1);
  const infMeta = new Influence().add(leg.bones[2], 1);
  const down = new V3(0, -1, 0);
  const up = new V3(0, 1, 0);
  const segs = lod.detail ? 8 : 5;
  const rings = lod.detail ? 4 : 2;
  const toeTip = (base, dir, len, rr, clawLen, hoof) => {
    const tipBase = base.clone().addScaledVector(dir, len * 0.86);
    const cdir = dir.clone().addScaledVector(down, hoof ? 0.25 : 0.45).normalize();
    spike(B, {
      base: tipBase,
      dir: cdir,
      wide: hoof ? new V3(-cdir.z, 0, cdir.x) : up,
      len: clawLen,
      rw: rr * (hoof ? 1.05 : 0.72),
      rt: rr * (hoof ? 0.6 : 0.45),
      bendDir: down,
      bend: hoof ? 0.2 : 0.4,
      segs: lod.detail ? 6 : 4,
      rings: lod.detail ? 3 : 2,
      prof: hoof ? (s) => Math.sqrt(Math.max(0, 1 - s * s)) : (s) => Math.pow(1 - s, 0.8),
      look: cl,
      inf: infFoot,
    });
  };
  for (const toe of foot.toes) {
    const yaw = toe.yaw * side;
    const dir = new V3(Math.sin(yaw), 0, Math.cos(yaw));
    const len = toe.len * d.toe;
    const rr = ballR * (foot.hoof ? 0.55 : 0.42) * toe.r;
    const base = leg.ball.clone().addScaledVector(dir, ballR * 0.2);
    base.y = leg.ballH * 0.82;
    const tip = base.clone().addScaledVector(dir, len);
    tip.y = rr * 0.75;
    const tdir = tip.clone().sub(base);
    const tl = tdir.length();
    tdir.normalize();
    spike(B, {
      base,
      dir: tdir,
      wide: new V3(-dir.z, 0, dir.x),
      len: tl * 1.04,
      rw: rr * 1.05,
      rt: rr * 0.88,
      segs,
      rings,
      prof: (s) => (1 - 0.42 * s) * (1 + 0.07 * Math.sin(s * Math.PI * 3)),
      look,
      inf: infFoot,
    });
    const clawLen = foot.hoof ? rr * 0.9 : foot.claw * d.toe * (0.75 + 0.25 * toe.len) * 1.25;
    toeTip(base, tdir, tl, rr, clawLen, !!foot.hoof);
  }
  if (foot.hallux) {
    // Dewclaw high on the inner back of the metatarsus.
    const base = _lerpV(leg.ankle, leg.ball, 0.72).add(new V3(-side * ballR * 0.55, 0, -ballR * 0.5));
    const dir = new V3(-side * 0.35, -0.55, -0.75).normalize();
    const len = d.toe * 0.32;
    const rr = ballR * 0.3;
    spike(B, { base, dir, wide: new V3(side, 0, 0), len, rw: rr, rt: rr * 0.85, segs, rings: 2, prof: (s) => 1 - 0.5 * s, look, inf: infMeta });
    spike(B, {
      base: base.clone().addScaledVector(dir, len * 0.85),
      dir: dir.clone().addScaledVector(down, 0.4).normalize(),
      wide: up,
      len: len * 0.55,
      rw: rr * 0.7,
      rt: rr * 0.45,
      bendDir: down,
      bend: 0.35,
      segs: 4,
      rings: 2,
      look: cl,
      inf: infMeta,
    });
  }
  if (foot.sickle) {
    // Raptor digit II: held up off the ground, carrying the killing claw.
    const base = leg.ball.clone().add(new V3(-side * ballR * 0.55, ballR * 0.35, ballR * 0.2));
    const dir = new V3(-side * 0.2, 0.62, 0.76).normalize();
    const len = d.toe * 0.5;
    const rr = ballR * 0.45;
    spike(B, { base, dir, wide: new V3(side, 0, 0), len, rw: rr, rt: rr * 0.9, segs, rings, prof: (s) => 1 - 0.4 * s, look, inf: infFoot });
    const cb = base.clone().addScaledVector(dir, len * 0.85);
    spike(B, {
      base: cb,
      dir: new V3(-side * 0.1, 0.88, 0.47).normalize(),
      wide: new V3(0, 0.3, 1).normalize(),
      len: d.toe * 1.05,
      rw: rr * 0.95,
      rt: rr * 0.42,
      bendDir: new V3(0, -0.85, 0.75).normalize(),
      bend: 0.95,
      segs: lod.detail ? 7 : 4,
      rings: lod.detail ? 7 : 3,
      prof: (s) => Math.pow(1 - s, 0.75),
      look: clawLook(makeLook(), false),
      inf: infFoot,
    });
  }
  if (foot.thumbClaw || foot.thumbSpike) {
    // Sauropod thumb claw / Camptosaurus thumb spike on the inside of the hand.
    const base = leg.ball.clone().add(new V3(-side * ballR * 0.75, ballR * 0.35, ballR * 0.3));
    const dir = new V3(-side * 0.65, foot.thumbSpike ? 0.25 : -0.15, 0.72).normalize();
    spike(B, {
      base,
      dir,
      wide: up,
      len: ballR * (foot.thumbSpike ? 1.2 : 1.0),
      rw: ballR * 0.32,
      rt: ballR * 0.26,
      bendDir: down,
      bend: 0.25,
      segs: 5,
      rings: 3,
      look: clawLook(makeLook(), false),
      inf: infFoot,
    });
  }
}

function buildArm(bp, arm, lod, B) {
  const d = arm.def;
  const [ru, rf, rh] = d.radii;
  const side = arm.side;
  const top = arm.shoulder.clone().add(new V3(-side * ru * 0.6, ru * 0.7, -ru * 0.2));
  const pts = [top, arm.shoulder, _lerpV(arm.shoulder, arm.elbow, 0.45), arm.elbow, _lerpV(arm.elbow, arm.wrist, 0.5), arm.wrist, arm.handEnd];
  const rad = [
    [ru * 1.5, ru * 1.5, ru * 1.5],
    [ru * 1.2, ru * 1.25, ru * 1.2],
    [ru, ru * 1.05, ru],
    [rf * 1.1, rf, rf * 1.15],
    [rf, rf * 1.05, rf],
    [rh * 1.1, rh, rh],
    [rh * 0.75, rh * 0.6, rh * 0.6],
  ];
  const [bU, bF, bH] = arm.bones;
  const look = makeLook();
  look.pattern = 0.6;
  limbLoft(B, {
    pts,
    rad,
    fwd: new V3(0, 0.25, 1),
    firstBone: bp.index.chest,
    joints: [
      { at: 1, w: ru * 1.1, bone: bU, shift: -ru * 0.3 },
      { at: 3, w: 0.18 * Math.min(d.upper, d.fore), bone: bF },
      { at: 5, w: 0.18 * Math.min(d.fore, d.hand), bone: bH },
    ],
    segs: Math.max(6, lod.limbRadial - 4),
    rings: Math.max(8, Math.round(18 * lod.limbRings)),
    look,
  });
  // Fingers + claws.
  const inf = new Influence().add(bH, 1);
  const hdir = arm.handEnd.clone().sub(arm.wrist).normalize();
  const sideAxis = new V3(1, 0, 0);
  const palm = new V3().crossVectors(hdir, sideAxis).normalize(); // fingers fan in the arm's swing plane
  const cl = clawLook(makeLook(), false);
  const segs = lod.detail ? 6 : 4;
  for (const fg of d.fingers) {
    const dir = hdir.clone().applyAxisAngle(sideAxis, fg.yaw * 0.9).addScaledVector(new V3(side, 0, 0), 0.12 + fg.yaw * side * 0.2).normalize();
    const base = _lerpV(arm.wrist, arm.handEnd, 0.7);
    const len = fg.len * d.hand * 0.75;
    const rr = rh * 0.42;
    spike(B, { base, dir, wide: palm, len, rw: rr, rt: rr * 0.85, segs, rings: 2, prof: (s) => 1 - 0.4 * s, look, inf });
    const cb = base.clone().addScaledVector(dir, len * 0.85);
    spike(B, {
      base: cb,
      dir,
      wide: palm,
      len: d.claw * d.hand * 1.3 * fg.len,
      rw: rr * 0.8,
      rt: rr * 0.42,
      bendDir: palm.clone().negate(),
      bend: 0.45,
      segs: 4,
      rings: lod.detail ? 3 : 2,
      look: cl,
      inf,
    });
  }
}

/* --- Geometry: species ornaments ----------------------------------------- */

/** Weights + frame for something rooted on the body surface at (a, θ). */
function bodyAnchor(bp, a, th) {
  const P = new V3();
  const N = new V3();
  bp.surface(a, th, P, N);
  const T = bp.path.tangent(a, new V3());
  const inf = bodyInfluence(bp, a, wrapPi(th), P, new Influence());
  return { P, N, T, inf };
}

function hornLook(look, s, from = 0.15, to = 0.55) {
  const k = smoothstep(from, to, s);
  look.skin = 1 - k;
  look.accent = 0;
  look.color.copy(FIXED_LINEAR.horn);
  look.pattern = 0.2;
  look.detail = 1 - k * 0.7;
  look.rough = lerp(0.75, 0.5, k);
  return look;
}

function buildFeatures(bp, lod, B) {
  const f = bp.body.features || {};
  const path = bp.path;
  const head = bp.head;
  const detail = lod.detail;
  const up = new V3(0, 1, 0);
  const back = new V3(0, 0, -1);
  const look = makeLook();
  const aZ = (z) => path.arcAtZ(z);

  if (f.plates) {
    // Stegosaurus: two staggered rows of broad, rounded, thick-rooted plates,
    // biggest over the hips, plus the thagomizer.
    const z0 = bp.body.bones.neckZ + 0.75;
    const z1 = bp.body.bones.tailZ - 2.15;
    const n = 9;
    for (const row of [0, 1]) {
      const side = row ? -1 : 1;
      for (let k = 0; k < n; k++) {
        const fz = (k + row * 0.5) / (n - 0.5);
        const z = lerp(z0, z1, fz);
        const a = aZ(z);
        const fr = (z - z1) / (z0 - z1);
        const h = 0.92 * (0.26 + 0.74 * Math.exp(-sq((fr - 0.42) / 0.3)));
        const { P, N, T, inf } = bodyAnchor(bp, a, side * 0.1);
        const dir = up.clone().multiplyScalar(0.82).addScaledVector(N, 0.18).add(new V3(side * 0.13, 0, 0)).normalize();
        spike(B, {
          base: P.addScaledVector(dir, -h * 0.12),
          dir,
          wide: T,
          len: h,
          rw: h * 0.47,
          rt: 0.035 + h * 0.035,
          bendDir: back,
          bend: 0.14,
          segs: detail ? 10 : 6,
          rings: detail ? 7 : 4,
          prof: (s) => Math.sin(Math.PI * Math.pow(0.22 + 0.78 * s, 0.85)) * (1 - 0.1 * s),
          profT: (s) => 1 - 0.72 * s,
          shade: (s, lk) => {
            lk.skin = 1;
            lk.pattern = 0.25;
            lk.detail = 0.45;
            lk.accent = smoothstep(0.2, 0.85, s) * 0.85;
            lk.rough = 0.72;
          },
          look,
          inf,
        });
      }
    }
  }
  if (f.thagomizer) {
    const zt = bp.st[0].z;
    for (const [dz, len] of [[0.82, 0.78], [0.42, 0.66]]) {
      const a = aZ(zt + dz);
      for (const side of [1, -1]) {
        const { P, N, inf } = bodyAnchor(bp, a, side * 0.5);
        const dir = new V3(side * 0.72, 0.42, -0.55).normalize();
        spike(B, {
          base: P.addScaledVector(N, -0.03),
          dir,
          wide: up,
          len,
          rw: 0.07,
          rt: 0.065,
          bendDir: up,
          bend: 0.08,
          segs: detail ? 8 : 5,
          rings: detail ? 5 : 3,
          prof: (s) => Math.pow(1 - s, 0.9),
          shade: (s, lk) => hornLook(lk, s, 0.05, 0.4),
          look,
          inf,
        });
      }
    }
  }
  if (f.armor === "gastonia") {
    // Dorsal osteoderm field.
    if (detail) {
      const zA = bp.body.bones.neckZ - 0.05;
      const zB = bp.body.bones.tailZ - 0.35;
      const rowsTh = [0.0, 0.42, 0.85, 1.22];
      for (let z = zA, k = 0; z > zB; z -= 0.24, k++) {
        const a = aZ(z);
        for (const th0 of rowsTh) {
          for (const side of th0 === 0 ? [1] : [1, -1]) {
            const th = side * (th0 + (k % 2) * 0.12);
            const { P, N, T, inf } = bodyAnchor(bp, a, th);
            const sz = 0.065 + 0.03 * Math.cos(th0);
            spike(B, {
              base: P.addScaledVector(N, -sz * 0.35),
              dir: N,
              wide: T,
              len: sz * 0.95,
              rw: sz * 1.1,
              rt: sz * 0.85,
              segs: 6,
              rings: 2,
              prof: (s) => Math.sqrt(Math.max(0, 1 - s * s)),
              shade: (s, lk) => hornLook(lk, s, 0.3, 1.2),
              look,
              inf,
            });
          }
        }
      }
    }
    // Lateral blades along the flanks (biggest at the shoulder) and down the tail.
    const flank = [];
    for (let k = 0; k < 7; k++) flank.push({ z: lerp(1.45, -0.55, k / 6), len: lerp(0.42, 0.2, k / 6), th: Math.PI * 0.45 });
    for (let k = 0; k < 6; k++) flank.push({ z: lerp(-1.05, -2.25, k / 5), len: lerp(0.24, 0.1, k / 5), th: Math.PI * 0.5 });
    for (const sp of flank) {
      const a = aZ(sp.z);
      for (const side of [1, -1]) {
        const { P, N, T, inf } = bodyAnchor(bp, a, side * sp.th);
        const dir = N.clone().add(new V3(0, 0.15, -0.45)).normalize();
        spike(B, {
          base: P.addScaledVector(N, -0.03),
          dir,
          wide: T,
          len: sp.len,
          rw: Math.min(0.13, sp.len * 0.45),
          rt: 0.035,
          bendDir: back,
          bend: 0.12,
          segs: detail ? 7 : 5,
          rings: detail ? 4 : 2,
          shade: (s, lk) => hornLook(lk, s, 0.0, 0.45),
          look,
          inf,
        });
      }
    }
    // Shoulder spikes.
    for (const side of [1, -1]) {
      const { P, N, inf } = bodyAnchor(bp, aZ(1.3), side * 0.95);
      const dir = new V3(side * 0.6, 0.62, -0.5).normalize();
      spike(B, { base: P.addScaledVector(N, -0.04), dir, wide: up, len: 0.4, rw: 0.075, rt: 0.06, bendDir: back, bend: 0.1, segs: detail ? 8 : 5, rings: detail ? 4 : 3, shade: (s, lk) => hornLook(lk, s, 0.0, 0.4), look, inf });
    }
    // Squamosal hornlets at the back corners of the skull.
    const ah = head.arcAtU(0.06);
    for (const side of [1, -1]) {
      const { P, N } = bodyAnchor(bp, ah, side * 1.0);
      const dir = N.clone().add(new V3(0, 0, -0.6)).normalize();
      spike(B, { base: P.addScaledVector(N, -0.015), dir, wide: up, len: 0.09, rw: 0.035, rt: 0.025, segs: 5, rings: 2, shade: (s, lk) => hornLook(lk, s, 0.0, 0.5), look, inf: headInfluence(bp) });
    }
  }
  if (f.nasalHorn) {
    // Ceratosaurus: a tall, blade-like horn on the nose.
    const a = head.arcAtU(0.74);
    const { P, N } = bodyAnchor(bp, a, 0);
    const dir = head.N.clone().addScaledVector(head.D, 0.22).normalize();
    spike(B, {
      base: P.addScaledVector(N, -0.025),
      dir,
      wide: head.D,
      len: 0.13,
      rw: 0.085,
      rt: 0.024,
      bendDir: head.D.clone().negate(),
      bend: 0.15,
      segs: detail ? 8 : 5,
      rings: detail ? 4 : 2,
      prof: (s) => Math.pow(1 - s, 0.7),
      shade: (s, lk) => hornLook(lk, s, 0.45, 1.1),
      look,
      inf: headInfluence(bp),
    });
  }
  if (f.browHorns || f.browBosses) {
    // Allosaurus lacrimal horns / Ceratosaurus brow bosses: rounded hornlets ahead of the eyes.
    const u = f.browHorns ? 0.27 : 0.21;
    const a = head.arcAtU(u);
    const pr = bp.prof(a, {});
    const th = bp.thetaForY(a, pr.t * (f.browHorns ? 0.86 : 0.82));
    for (const side of [1, -1]) {
      const { P, N } = bodyAnchor(bp, a, side * th);
      const dir = N.clone().addScaledVector(head.N, 0.6).normalize();
      const hgt = f.browHorns ? head.len * 0.085 : head.len * 0.055;
      spike(B, {
        base: P.addScaledVector(N, -hgt * 0.3),
        dir,
        wide: head.D,
        len: hgt,
        rw: hgt * (f.browHorns ? 0.95 : 0.8),
        rt: hgt * 0.5,
        segs: detail ? 7 : 5,
        rings: 3,
        prof: (s) => Math.pow(Math.max(0, 1 - s * s), 0.6),
        shade: (s, lk) => {
          lk.skin = 1;
          lk.accent = 0.35;
          lk.pattern = 0.2;
          lk.detail = 0.8;
          lk.rough = 0.7;
        },
        look,
        inf: headInfluence(bp),
      });
    }
  }
  if (f.scuteRow && detail) {
    // Ceratosaurus: one row of small osteoderms down the midline.
    for (let z = bp.body.bones.neckZ + 0.55; z > bp.st[0].z * 0.55; z -= 0.2) {
      const { P, N, T, inf } = bodyAnchor(bp, aZ(z), 0);
      spike(B, { base: P.addScaledVector(N, -0.015), dir: N, wide: T, len: 0.05, rw: 0.06, rt: 0.04, segs: 5, rings: 2, prof: (s) => Math.sqrt(Math.max(0, 1 - s * s)), shade: (s, lk) => hornLook(lk, s, 0.4, 1.4), look, inf });
    }
  }
  if (f.dorsalSpines) {
    // Diplodocus: a row of soft keratin spines along the back and tail.
    const z0 = 6.0;
    const z1 = -11.0;
    for (let z = z0; z > z1; z -= detail ? 0.36 : 0.6) {
      const fr = (z - z1) / (z0 - z1);
      const h = 0.1 + 0.2 * Math.exp(-sq((fr - 0.55) / 0.3));
      const { P, N, T, inf } = bodyAnchor(bp, aZ(z), 0);
      spike(B, { base: P.addScaledVector(N, -0.02), dir: N, wide: T, len: h, rw: h * 0.45, rt: 0.025, bendDir: back, bend: 0.25, segs: 5, rings: detail ? 3 : 2, shade: (s, lk) => hornLook(lk, s, 0.3, 1.3), look, inf });
    }
  }
}

/* --- Geometry: feathers -------------------------------------------------- */

/** One bent feather card (2 quads), rooted at P on a coat with normal N, pointing along D. */
function featherCard(B, P, N, D, len, wid, lift, cell, look, inf) {
  const S = new V3().crossVectors(N, D).normalize();
  const ax1 = D.clone().multiplyScalar(Math.cos(lift)).addScaledVector(N, Math.sin(lift));
  const ax2 = D.clone().multiplyScalar(Math.cos(lift * 0.15)).addScaledVector(N, Math.sin(lift * 0.15));
  const r1 = P.clone().addScaledVector(ax1, len * 0.5);
  const r2 = r1.clone().addScaledVector(ax2, len * 0.5);
  const cu = (cell % 2) * 0.5;
  const cv = Math.floor(cell / 2) * 0.5;
  const rows = [
    [P, wid * 0.55, cv + 0.01],
    [r1, wid, cv + 0.25],
    [r2, wid * 0.92, cv + 0.49],
  ];
  const first = B.count;
  for (const [C, w, v] of rows) {
    for (const e of [-1, 1]) {
      const x = C.x + S.x * w * 0.5 * e;
      const y = C.y + S.y * w * 0.5 * e;
      const z = C.z + S.z * w * 0.5 * e;
      B.vert(x, y, z, look, inf);
      B.nrm.push(N.x, N.y, N.z);
      B.uv.push(cu + (e < 0 ? 0.01 : 0.49), v);
    }
  }
  B.tri(first, first + 1, first + 3);
  B.tri(first, first + 3, first + 2);
  B.tri(first + 2, first + 3, first + 5);
  B.tri(first + 2, first + 5, first + 4);
}

function buildFeathers(bp, B) {
  const rng = makeRng(hash(bp.sp.id, "feathers"));
  const look = makeLook();
  look.detail = 0;
  look.rough = 0.88;
  look.pattern = 1;
  const inf = new Influence();
  const P = new V3();
  const N = new V3();
  const T = new V3();
  const D = new V3();
  const L = bp.L;
  const head = bp.head;
  const aNeck = bp.path.arcAtZ(bp.body.bones.neckZ);
  const aEnd = head.a0 + 0.06 * head.len;
  const aTail = bp.aHips;
  let a = 0.05;
  while (a < aEnd) {
    const R = bp.localRadius(a);
    const n = Math.max(4, Math.round((TAU * R) / 0.095));
    const tailF = a < aTail ? 1 - a / aTail : 0; // 1 at the tail tip → 0 at the hips
    const neck = a > aNeck;
    const crest = a > head.a0 - 0.12 * head.len;
    for (let k = 0; k < n; k++) {
      const th = ((k + rng() * 0.7) / n) * TAU;
      const ths = wrapPi(th);
      const at = Math.abs(ths);
      const limit = crest ? 0.35 * Math.PI : tailF > 0 ? 0.84 * Math.PI : neck ? 0.78 * Math.PI : 0.7 * Math.PI;
      if (at > limit) continue;
      bp.surface(a, th, P, N);
      bp.path.tangent(a, T);
      D.copy(T).negate().addScaledVector(N, T.dot(N));
      const fanF = smoothstep(0.55, 0.95, tailF) * (1 - smoothstep(0.2, 0.45, Math.abs(at - Math.PI * 0.5)));
      if (fanF > 0) D.x += Math.sign(P.x || 1) * fanF * 0.75;
      D.normalize();
      let len = neck ? 0.17 : 0.3;
      let lift = neck ? 0.55 : 0.36;
      let cell = neck ? (rng() < 0.6 ? 2 : 1) : rng() < 0.5 ? 0 : 2;
      if (tailF > 0) {
        len = lerp(0.3, 0.34, tailF) * (1 + fanF * 1.5);
        lift = lerp(0.3, 0.16, tailF);
        cell = fanF > 0.3 ? 3 : rng() < 0.5 ? 1 : 0;
      }
      if (crest) {
        len = 0.16;
        lift = 0.65;
        cell = 1;
      }
      len *= 0.85 + rng() * 0.3;
      const wid = len * (cell === 3 ? 0.42 : 0.62);
      P.addScaledVector(N, -0.004);
      featherCard(B, P, N, D, len, wid, lift + (rng() - 0.5) * 0.12, cell, look, bodyInfluence(bp, a, ths, P, inf));
    }
    a += 0.085 * (0.8 + 0.4 * rng());
  }
  // Wings: remiges along the forearm and hand, coverts over them.
  for (const arm of bp.arms) {
    const side = arm.side;
    const segsPts = [
      [arm.elbow, arm.wrist, arm.bones[1], 8, 0.34, 0.5],
      [arm.wrist, arm.handEnd, arm.bones[2], 6, 0.5, 0.58],
    ];
    for (const [p0, p1, bone, count, l0, l1] of segsPts) {
      const binf = new Influence().add(bone, 1);
      for (let k = 0; k < count; k++) {
        const t = (k + 0.5) / count;
        const root = p0.clone().lerp(p1, t);
        const out = new V3(side, 0, 0);
        const dir = new V3(side * 0.12, -0.42, -1).normalize();
        root.addScaledVector(out, arm.def.radii[1] * 0.3);
        featherCard(B, root, out, dir, lerp(l0, l1, t) * (0.9 + rng() * 0.2), 0.11, 0.08, 3, look, binf);
        featherCard(B, root.clone().addScaledVector(new V3(0, 1, 0), 0.02), out, dir, lerp(l0, l1, t) * 0.55, 0.12, 0.2, 0, look, binf);
      }
    }
  }
}

/* --- Geometry assembly + cache ------------------------------------------- */

const _geoCache = new Map();

/**
 * Shared, per-species geometry for one LOD: { skin, feathers, tris }.
 * Built lazily the first time a species is spawned, then reused by every
 * individual (only skeletons and materials are per animal).
 */
function getGeometry(sp, lodIndex) {
  const key = sp.id + ":" + lodIndex;
  let g = _geoCache.get(key);
  if (g) return g;
  const bp = getBlueprint(sp);
  const lod = LOD_LEVELS[lodIndex];
  const B = new Builder();
  buildBody(bp, lod, B);
  buildJaw(bp, lod, B);
  buildEyes(bp, lod, B);
  if (lod.detail) buildTeeth(bp, B);
  for (const leg of bp.legs) buildLeg(bp, leg, lod, B);
  for (const arm of bp.arms) buildArm(bp, arm, lod, B);
  buildFeatures(bp, lod, B);
  const skin = B.toGeometry(true);
  let feathers = null;
  if (bp.body.features?.feathers) {
    const shared = _geoCache.get(sp.id + ":feathers");
    if (shared) feathers = shared;
    else {
      const FB = new Builder(true);
      buildFeathers(bp, FB);
      feathers = FB.toGeometry(false);
      _geoCache.set(sp.id + ":feathers", feathers);
    }
  }
  const tris = skin.index.count / 3 + (feathers ? feathers.index.count / 3 : 0);
  g = { skin, feathers, tris };
  _geoCache.set(key, g);
  return g;
}

/* --- Animation helpers --------------------------------------------------- */

const ACTION_KEYS = ["bite", "tail", "kick", "call", "eat", "drink", "rest"];
const ONE_SHOT = [true, true, true, true, false, false, false];
const ACTION_RATE = [12, 10, 12, 8, 4, 4, 1.6];
const A_BITE = 0;
const A_TAIL = 1;
const A_KICK = 2;
const A_CALL = 3;
const A_EAT = 4;
const A_DRINK = 5;
const A_REST = 6;
const LEG_STRIDE = 15; // floats per leg in a pose: ground ball (3), meta dir (3), toe pitch, limp ball (3), limp meta (3), -, limp weight
const DEFAULT_ANIM = Object.freeze({ speed: 0, crouch: 0, swim: 0, turn: 0, action: null, actionT: 0, lookYaw: 0, hurt: 0 });

const _e = new THREE.Euler(0, 0, 0, "YXZ");
const _va = new V3();
const _vb = new V3();
const _vc = new V3();
const _vd = new V3();
const _hip = new V3();
const _knee = new V3();
const _ankle = new V3();
const _ball = new V3();
const _meta = new V3();
const _pole = new V3();
const _side = new V3();
const _toe = new V3();
const _m4 = new THREE.Matrix4();
const _ax = new V3();
const _ay = new V3();
const _az = new V3();
const _X = new V3(1, 0, 0);
const _Y = new V3(0, 1, 0);
const _Z = new V3(0, 0, 1);
const _col = new THREE.Color();

/**
 * Rotation that takes a bone's bind direction onto `dir`, twisting so the
 * bind side axis (+X) lines up with `side` as well as it can.
 */
function aimRotation(basisT, dir, side, out) {
  _ax.copy(dir).normalize();
  _ay.copy(side).addScaledVector(_ax, -side.dot(_ax));
  if (_ay.lengthSq() < 1e-6) _ay.copy(_Z).addScaledVector(_ax, -_ax.z);
  _ay.normalize();
  _az.crossVectors(_ax, _ay);
  _m4.makeBasis(_ax, _ay, _az).multiply(basisT);
  return out.setFromRotationMatrix(_m4);
}

function jitterColor(hex, rng, light) {
  const c = new THREE.Color(hex);
  const hsl = { h: 0, s: 0, l: 0 };
  c.getHSL(hsl);
  return c.setHSL(
    (hsl.h + (rng() - 0.5) * 0.03 + 1) % 1,
    clamp(hsl.s * (1 + (rng() - 0.5) * 0.3), 0, 1),
    clamp(hsl.l * (1 + (rng() - 0.5) * light), 0, 1)
  );
}

/* --- DinoModel ----------------------------------------------------------- */

/**
 * One animated dinosaur: a procedural skeleton driving a single smooth
 * SkinnedMesh (two LODs; a second, alpha-tested mesh carries the raptor's
 * feathers). Built at adult size facing +Z with its origin on the ground under
 * the hips; `setScale` shrinks it for juveniles.
 */
export class DinoModel {
  /**
   * @param {object|string} species SpeciesDef or id
   * @param {{ seed?: number, variant?: number }} [opts] seed picks the colour
   *   morph and individual variation; variant offsets the morph choice.
   */
  constructor(species, { seed = 1, variant = 0 } = {}) {
    const sp = typeof species === "string" ? getSpecies(species) : species;
    const bp = getBlueprint(sp);
    this.species = sp;
    this.seed = seed;
    this._bp = bp;
    const rng = makeRng(hash(sp.id, seed, variant, "dino"));

    /* Rig: bones in blueprint order (parents first), identity bind rotations. */
    const nb = bp.bones.length;
    this._nb = nb;
    const bones = bp.bones.map((b) => {
      const o = new THREE.Bone();
      o.name = b.name;
      return o;
    });
    this._parent = new Int16Array(nb);
    bp.bones.forEach((b, i) => {
      this._parent[i] = b.parent;
      if (b.parent >= 0) {
        bones[b.parent].add(bones[i]);
        bones[i].position.copy(b.pos).sub(bp.bones[b.parent].pos);
      } else bones[i].position.copy(b.pos);
    });
    this._bones = bones;
    this._skeleton = new THREE.Skeleton(
      bones,
      bp.bones.map((b) => new THREE.Matrix4().makeTranslation(-b.pos.x, -b.pos.y, -b.pos.z))
    );
    this._isLeg = new Uint8Array(nb);
    for (const leg of bp.legs) for (const b of leg.bones) this._isLeg[b] = 1;
    this._wq = Array.from({ length: nb }, () => new THREE.Quaternion());
    this._wp = Array.from({ length: nb }, () => new V3());
    this._ws = new Float32Array(nb).fill(1);
    const I = bp.index;
    this._iHips = I.hips;
    this._iSpine = I.spine;
    this._iChest = I.chest;
    this._iHead = I.head;
    this._iJaw = I.jaw;
    this._iNeck = [];
    for (let k = 0; k < bp.body.bones.neck; k++) this._iNeck.push(I["neck" + k]);
    this._iTail = [];
    for (let k = 0; k < bp.body.bones.tail; k++) this._iTail.push(I["tail" + k]);

    /* Individual look. */
    const morphs = sp.colors.morphs;
    const m = morphs[(Math.floor(rng() * morphs.length) + Math.abs(variant | 0)) % morphs.length];
    const pat = sp.colors.pattern;
    const u = createSkinUniforms();
    u.uBase.value.copy(jitterColor(m.base, rng, 0.2));
    u.uDorsal.value.copy(jitterColor(m.dorsal, rng, 0.2));
    u.uBelly.value.copy(jitterColor(m.belly, rng, 0.1));
    u.uPatternCol.value.copy(jitterColor(m.pattern, rng, 0.2));
    u.uLight.value.copy(jitterColor(m.light, rng, 0.1));
    u.uAccent.value.copy(jitterColor(m.accent, rng, 0.15));
    u.uBands.value.set(pat.bands[0] * TAU * (0.9 + 0.2 * rng()), pat.bands[1] + (rng() - 0.5) * 0.18, pat.bands[2], pat.bands[0] > 0 ? 0.85 : 0);
    u.uSpots.value.set(pat.spots[0], pat.spots[1] + (rng() - 0.5) * 0.06, pat.mottle, pat.dorsal);
    u.uStripe.value.set(pat.stripe[0], pat.stripe[1], pat.stripe[2], 0);
    const tile = sp.body.scaleTile || 0.3;
    u.uScales.value.set(1 / tile, 1 / (tile * 6), 2.2, 0.28);
    u.uSeed.value.set(rng() * 40, rng() * 40, rng() * 40);
    this._uniforms = u;
    this._mat = createSkinMaterial(u, false);
    this._featherMat = sp.body.features?.feathers ? createSkinMaterial(u, true) : null;
    this._headScale = 1 + (rng() - 0.5) * 0.08;
    this._bones[I.head].scale.setScalar(this._headScale);

    /* Meshes: two LODs sharing the skeleton. */
    this.object = new THREE.Group();
    this.object.name = "dino:" + sp.id;
    this.object.add(bones[0]);
    const lod = new THREE.LOD();
    this._meshes = [];
    for (let i = 0; i < LOD_LEVELS.length; i++) {
      const g = getGeometry(sp, i);
      const level = new THREE.Group();
      const parts = [[g.skin, this._mat]];
      if (g.feathers) parts.push([g.feathers, this._featherMat]);
      for (const [geo, mat] of parts) {
        const mesh = new THREE.SkinnedMesh(geo, mat);
        mesh.bind(this._skeleton, new THREE.Matrix4());
        mesh.boundingSphere = bp.bound.clone();
        mesh.castShadow = true;
        mesh.receiveShadow = true;
        level.add(mesh);
        this._meshes.push(mesh);
      }
      lod.addLevel(level, i === 0 ? 0 : 1, 0.1);
    }
    this._lod = lod;
    this.object.add(lod);
    const g0 = getGeometry(sp, 0);
    const g1 = getGeometry(sp, 1);
    /** Render cost: triangles per LOD and draw calls (excluding shadow passes). */
    this.stats = { triangles: [g0.tris, g1.tris], drawCalls: g0.feathers ? 2 : 1 };

    /* Animation state. */
    this._time = rng() * 100;
    this._idleSeed = rng() * TAU;
    this._phase = rng();
    this._swimPhase = rng();
    this._breath = rng() * TAU;
    this._breathRate = 0.3 * Math.pow(3.5 / sp.length, 0.3);
    this._speed = 0;
    this._gaitAmp = 0;
    this._run = 0;
    this._rear = 0;
    this._crouch = 0;
    this._swim = 0;
    this._turn = 0;
    this._look = 0;
    this._w = new Float32Array(ACTION_KEYS.length);
    this._t = new Float32Array(ACTION_KEYS.length);
    this._deadT = 0;
    this._wDead = 0;
    this._deadSide = rng() < 0.5 ? 1 : -1;
    this._restCurl = rng() < 0.5 ? 1 : -1;
    this._tailSide = 1;
    this._kickSide = 1;
    this._lastAction = null;
    this._wet = 0;
    this._scale = 1;

    this._oRot = 3;
    this._oRibs = 3 + nb * 3;
    this._oLeg = this._oRibs + 1;
    const size = this._oLeg + bp.legs.length * LEG_STRIDE;
    this._pa = new Float32Array(size);
    this._pb = new Float32Array(size);
    this._hitPool = bp.hits.map((h) => ({ x: 0, y: 0, z: 0, r: h.r, part: h.part }));

    this.setScale(1);
    this.update(0, DEFAULT_ANIM);
  }

  /** Uniform size multiplier (growthScale); the model is authored at adult size. */
  setScale(s) {
    this._scale = Math.max(0.01, s);
    this.object.scale.setScalar(this._scale);
    // Switch to the light mesh once the animal is small on screen.
    const d = (14 + 5 * this.species.length) * Math.pow(this._scale, 0.7);
    if (this._lod.levels[1]) this._lod.levels[1].distance = d;
  }

  /** World position of the snout tip (after scale and parent transforms). */
  getHeadPosition(target = new THREE.Vector3()) {
    return this._worldPoint(this._iHead, this._bp.snoutLocal, target);
  }

  /** World position near the tail tip. */
  getTailPosition(target = new THREE.Vector3()) {
    return this._worldPoint(this._bp.tailBone, this._bp.tailLocal, target);
  }

  /**
   * Blend the skin toward `color` (carcass darkening / rot). amount 0..1.
   * @param {THREE.Color|number|string} color
   * @param {number} amount
   */
  setTint(color, amount) {
    _col.set(color ?? 0x000000);
    this._uniforms.uTint.value.set(_col.r, _col.g, _col.b, clamp(amount || 0, 0, 1));
  }

  /**
   * [hunter] World-space spheres approximating the body in its current pose
   * (head ×2, neck, body, tail ×3, legs). `out` is cleared and refilled with
   * pooled objects owned by this model (valid until its next call), so a
   * caller can keep one array per creature without it growing.
   * @returns {{x:number,y:number,z:number,r:number,part:string}[]}
   */
  getHitSpheres(out = []) {
    out.length = 0;
    this.object.updateWorldMatrix(true, false);
    const M = this.object.matrixWorld;
    const sc = M.getMaxScaleOnAxis();
    const hits = this._bp.hits;
    for (let i = 0; i < hits.length; i++) {
      const h = hits[i];
      const o = this._hitPool[i];
      const ws = this._ws[h.bone];
      _va.copy(h.off).multiplyScalar(ws).applyQuaternion(this._wq[h.bone]).add(this._wp[h.bone]).applyMatrix4(M);
      o.x = _va.x;
      o.y = _va.y;
      o.z = _va.z;
      o.r = h.r * sc * ws;
      out.push(o);
    }
    return out;
  }

  _worldPoint(bone, local, target) {
    target.copy(local).multiplyScalar(this._ws[bone]).applyQuaternion(this._wq[bone]).add(this._wp[bone]);
    this.object.updateWorldMatrix(true, false);
    return target.applyMatrix4(this.object.matrixWorld);
  }

  /**
   * Advance the procedural animation.
   * @param {number} dt seconds
   * @param {object} anim { speed, crouch, swim, turn, action, actionT, lookYaw, hurt } (see ARCHITECTURE.md)
   */
  update(dt, anim = DEFAULT_ANIM) {
    const a = anim || DEFAULT_ANIM;
    dt = clamp(dt || 0, 0, 0.25);
    const bp = this._bp;
    this._time += dt;

    /* Smoothed inputs. */
    this._speed = damp(this._speed, Math.max(0, a.speed || 0), 10, dt);
    const legW = bp.legLength * this._scale;
    this._gaitAmp = damp(this._gaitAmp, smoothstep(0.02, 0.16, this._speed / legW), 6, dt);
    this._crouch = damp(this._crouch, clamp(a.crouch || 0, 0, 1), 7, dt);
    this._swim = damp(this._swim, clamp(a.swim || 0, 0, 1), 3, dt);
    this._turn = damp(this._turn, a.turn || 0, 5, dt);
    this._look = damp(this._look, clamp(a.lookYaw || 0, -1.2, 1.2), 7, dt);
    const fr = (this._speed * this._speed) / (9.81 * legW);
    this._runRaw = smoothstep(0.4, 2.2, fr);
    this._run = this._runRaw * this._gaitAmp;
    this._fr = fr;
    this._breath += dt * TAU * this._breathRate * (1 + 1.5 * this._run);
    this._swimPhase = (this._swimPhase + dt * (0.45 + 0.35 * Math.min(2, this._speed / legW))) % 1;

    /* Action weights (one-shots remember their last progress while fading out). */
    const act = a.action || null;
    const at = clamp(a.actionT || 0, 0, 1);
    if (act === "tail" && (this._lastAction !== "tail" || at < this._t[A_TAIL] - 0.25)) this._tailSide = -this._tailSide;
    if (act === "kick" && (this._lastAction !== "kick" || at < this._t[A_KICK] - 0.25)) this._kickSide = -this._kickSide;
    for (let i = 0; i < ACTION_KEYS.length; i++) {
      const on = act === ACTION_KEYS[i];
      this._w[i] = damp(this._w[i], on ? 1 : 0, ACTION_RATE[i], dt);
      if (on && ONE_SHOT[i]) this._t[i] = at;
    }
    if (act === "dead") {
      this._deadT += dt;
      this._wDead = smoothstep(0, 0.3, this._deadT);
    } else {
      this._deadT = 0;
      this._wDead = damp(this._wDead, 0, 3, dt);
    }
    this._lastAction = act;
    this._wet = Math.max(this._swim > 0.3 ? 1 : 0, this._wet - dt / 30);

    /* Pose: locomotion → swim → overlays → rest → dead. */
    const pa = this._pa;
    const pb = this._pb;
    this._neutral(pa);
    this._locomotion(pa, dt);
    if (this._swim > 0.002) {
      this._neutral(pb);
      this._swimPose(pb);
      lerpPose(pa, pb, this._swim);
    }
    this._overlays(pa);
    if (this._w[A_REST] > 0.002) {
      this._neutral(pb);
      this._restPose(pb);
      lerpPose(pa, pb, this._w[A_REST]);
    }
    if (this._wDead > 0.002) {
      this._neutral(pb);
      this._deadPose(pb);
      lerpPose(pa, pb, this._wDead);
    }
    this._apply(pa);

    /* Surface. */
    const h = clamp(a.hurt || 0, 0, 1);
    this._mat.emissive.setRGB(0.55 * h, 0.04 * h, 0.03 * h);
    if (this._featherMat) this._featherMat.emissive.copy(this._mat.emissive);
    this._uniforms.uWet.value = this._wet * 0.8;
  }

  /** Release per-individual GPU resources (geometry is shared per species and kept). */
  dispose() {
    if (this.object.parent) this.object.parent.remove(this.object);
    this._mat.dispose();
    if (this._featherMat) this._featherMat.dispose();
    this._skeleton.dispose();
  }

  /* --- Poses ------------------------------------------------------------- */

  _neutral(P) {
    const bp = this._bp;
    P.fill(0);
    P[1] = bp.H;
    P[this._oRibs] = 1;
    for (let i = 0; i < bp.legs.length; i++) {
      const leg = bp.legs[i];
      const o = this._oLeg + i * LEG_STRIDE;
      P[o] = leg.ball.x;
      P[o + 1] = leg.ball.y;
      P[o + 2] = leg.ball.z;
      P[o + 3] = leg.metaDir.x;
      P[o + 4] = leg.metaDir.y;
      P[o + 5] = leg.metaDir.z;
      P[o + 7] = leg.ball.x - leg.hip.x;
      P[o + 8] = leg.ball.y - leg.hip.y;
      P[o + 9] = leg.ball.z - leg.hip.z;
      P[o + 10] = leg.metaDir.x;
      P[o + 11] = leg.metaDir.y;
      P[o + 12] = leg.metaDir.z;
    }
  }

  _locomotion(P, dt) {
    const bp = this._bp;
    const R = this._oRot;
    const H = bp.H;
    const s = this._scale;
    const quad = bp.quad;
    const amp = this._gaitAmp;
    const runRaw = this._runRaw;
    const legW = bp.legLength * s;
    const fr = this._fr;
    const v = this._speed;
    const rear = bp.body.bipedalSprint ? smoothstep(1.4, 3.0, fr) * amp : 0;
    this._rear = rear;
    const duty = lerp(0.62, quad && rear < 0.5 ? 0.5 : 0.3, runRaw);
    // Stride from Alexander's dynamic-similarity rule, capped by what the legs can reach.
    const st = bp.stance;
    const half = lerp(lerp(st.walk, st.run, runRaw), lerp(st.walkHind, st.runHind, runRaw), rear);
    const lamMax = Math.min(4.2 * legW, (2 * half * s) / duty);
    const lam = clamp(2.3 * legW * Math.pow(Math.max(fr, 0.01), 0.3), Math.min(0.7 * legW, lamMax), lamMax);
    this._phase = (this._phase + (v * dt) / lam) % 1;
    const ph = this._phase;
    const S = (lam / s) * duty;
    const lift = bp.legLength * (0.09 + 0.08 * runRaw);
    const mid = duty * 0.5;
    const t = this._time;
    const iH = R + this._iHips * 3;
    const iS = R + this._iSpine * 3;
    const iC = R + this._iChest * 3;
    const iHead = R + this._iHead * 3;
    const nN = this._iNeck.length;
    const nT = this._iTail.length;

    /* Body: vaulting bob at a walk, dipping bob at a run, side sway over the stance foot. */
    const bob = H * (quad ? 0.6 : 1) * lerp(0.016, 0.04, runRaw) * amp;
    P[1] += bob * (1 - 2 * runRaw) * Math.cos(TAU * 2 * (ph - mid)) - H * bp.runDrop * runRaw * amp * (quad && rear < 0.5 ? 0.5 : 1);
    if (!quad || rear > 0.5) P[0] += H * 0.018 * (1 - 0.6 * runRaw) * amp * Math.cos(TAU * (ph - mid));
    const lean = quad ? 0.02 * runRaw * amp : (0.03 + 0.15 * runRaw) * amp;
    P[iH] += lean - rear * 0.3;
    P[iH + 1] += 0.05 * amp * Math.sin(TAU * ph) * (quad ? 0.4 : 1);
    P[iH + 2] -= 0.025 * amp * Math.cos(TAU * (ph - mid)) * (quad ? 0.4 : 1);
    P[iC + 1] -= P[iH + 1] * 0.8;
    P[iS] += rear * 0.08;
    P[iC] -= 0.008 * Math.sin(this._breath);

    /* Neck & head: steady gaze, gentle bob, idle glances around. */
    const idle = 1 - amp;
    const sd = this._idleSeed;
    const bodyPitch = P[iH] + P[iS] + P[iC];
    const glance = idle * 0.22 * (0.6 * Math.sin(t * 0.23 + sd) + 0.4 * Math.sin(t * 0.61 + sd * 2.3));
    const nod = idle * 0.05 * Math.sin(t * 0.47 + sd * 1.7);
    for (let k = 0; k < nN; k++) {
      const b = R + this._iNeck[k] * 3;
      P[b] += (-0.65 * bodyPitch) / nN + (0.02 * amp * Math.cos(TAU * 2 * (ph - mid) - 0.6)) / Math.sqrt(nN);
      P[b + 1] += (glance * 0.6) / nN;
    }
    P[iHead] += -0.25 * bodyPitch + nod;
    P[iHead + 1] += glance * 0.4;

    /* Tail: sways against the pelvis, held level when leaning. */
    for (let k = 0; k < nT; k++) {
      const b = R + this._iTail[k] * 3;
      const f = (k + 1) / nT;
      P[b + 1] += -(0.025 + 0.05 * f) * amp * Math.sin(TAU * ph - 0.55 * k) * (quad ? 0.7 : 1);
      P[b + 1] += idle * 0.02 * Math.sin(t * 0.6 - 0.4 * k + sd);
      P[b] += (k < 3 ? -lean * 0.3 + rear * 0.12 : 0) + 0.015 * amp * Math.cos(TAU * 2 * (ph - mid) - 0.5 * k);
    }

    /* Breathing; predators pant at speed. */
    P[this._oRibs] = 1 + (0.018 + 0.02 * runRaw) * Math.sin(this._breath);
    if (this.species.diet === "carnivore") P[R + this._iJaw * 3] += 0.08 * this._run * (0.5 + 0.5 * Math.sin(this._breath));

    /* Arms swing a little with the stride. */
    for (const arm of bp.arms) {
      const b = R + arm.bones[0] * 3;
      P[b] += 0.12 * amp * Math.sin(TAU * (ph + (arm.side > 0 ? 0.5 : 0))) * (arm.def.folded ? 0.35 : 1);
      P[R + arm.bones[1] * 3] -= 0.08 * amp;
    }

    /* Feet: planted during stance (moving back at exactly the body's speed), arcing forward in swing. */
    for (let i = 0; i < bp.legs.length; i++) {
      const leg = bp.legs[i];
      const o = this._oLeg + i * LEG_STRIDE;
      let off = leg.side > 0 ? 0 : 0.5;
      if (leg.fore) off += lerp(0.25, 0.42, runRaw);
      const p = (ph + off) % 1;
      let dz;
      let dy = 0;
      let metaLift;
      let toe = 0;
      if (p < duty) {
        const q = p / duty;
        dz = S * (0.5 - q);
        metaLift = smoothstep(0.6, 1, q) * 0.4;
      } else {
        const q = (p - duty) / (1 - duty);
        const e = q * q * (3 - 2 * q);
        dz = S * (e - 0.5);
        dy = lift * Math.pow(Math.sin(Math.PI * q), 0.8);
        metaLift = 0.4 * (1 - q) + 0.25 * Math.sin(Math.PI * q);
        toe = 0.55 * Math.sin(Math.PI * q) - 0.15 * smoothstep(0.7, 1, q);
      }
      const ga = leg.fore ? amp * (1 - rear) : amp;
      P[o + 1] += dy * ga;
      P[o + 2] += dz * ga;
      const phi = leg.phi + metaLift * ga;
      P[o + 3] = 0;
      P[o + 4] = Math.cos(phi);
      P[o + 5] = -Math.sin(phi);
      P[o + 6] = toe * ga;
      if (leg.fore && rear > 0.001) {
        // Running on the hind legs: forelimbs tuck up under the chest.
        P[o + 7] = leg.side * 0.02;
        P[o + 8] = -leg.len * 0.55;
        P[o + 9] = leg.len * 0.12;
        P[o + 10] = 0;
        P[o + 11] = 0.35;
        P[o + 12] = 0.94;
        P[o + 14] = rear;
      }
    }
  }

  _swimPose(P) {
    const bp = this._bp;
    const R = this._oRot;
    const sw = this._swimPhase;
    const nN = this._iNeck.length;
    const nT = this._iTail.length;
    P[1] = bp.H * 0.92;
    P[R + this._iHips * 3] = -0.08;
    for (let k = 0; k < nN; k++) P[R + this._iNeck[k] * 3] -= 0.12;
    P[R + this._iHead * 3] += 0.12 * nN * 0.6 + 0.05;
    const power = 1 + (this.species.swim || 0);
    for (let k = 0; k < nT; k++) {
      const f = (k + 1) / nT;
      P[R + this._iTail[k] * 3 + 1] += 0.06 * (0.5 + f) * power * Math.sin(TAU * sw - 0.7 * k);
      P[R + this._iTail[k] * 3] -= 0.02;
    }
    for (const arm of bp.arms) {
      P[R + arm.bones[0] * 3] += 0.35;
      P[R + arm.bones[1] * 3] -= 0.5;
    }
    for (let i = 0; i < bp.legs.length; i++) {
      const leg = bp.legs[i];
      const o = this._oLeg + i * LEG_STRIDE;
      const ang = TAU * ((sw + (leg.side > 0 ? 0 : 0.5) + (leg.fore ? 0.25 : 0)) % 1);
      P[o + 1] = leg.ball.y + leg.len * (0.3 + 0.14 * Math.cos(ang));
      P[o + 2] = leg.ball.z + leg.len * 0.3 * Math.sin(ang);
      const phi = leg.phi + 0.5 + 0.3 * Math.sin(ang);
      P[o + 4] = Math.cos(phi);
      P[o + 5] = -Math.sin(phi);
      P[o + 6] = 0.5;
    }
  }

  _overlays(P) {
    const bp = this._bp;
    const R = this._oRot;
    const H = bp.H;
    const nN = this._iNeck.length;
    const nT = this._iTail.length;
    const iH = R + this._iHips * 3;
    const iS = R + this._iSpine * 3;
    const iC = R + this._iChest * 3;
    const iHead = R + this._iHead * 3;
    const iJaw = R + this._iJaw * 3;
    const neck = (ch, v) => {
      for (let k = 0; k < nN; k++) P[R + this._iNeck[k] * 3 + ch] += v;
    };
    const tail = (ch, v, from = 0, to = nT, grow = 0) => {
      for (let k = from; k < to; k++) P[R + this._iTail[k] * 3 + ch] += v * (1 + grow * (k / nT));
    };
    const arms = (up, fore) => {
      for (const arm of bp.arms) {
        P[R + arm.bones[0] * 3] += up;
        P[R + arm.bones[1] * 3] += fore;
      }
    };

    /* Crouch: lower and slink. */
    const c = this._crouch;
    if (c > 0.001) {
      P[1] -= c * H * (bp.quad ? 0.14 : 0.2);
      P[iH] += c * (bp.quad ? 0.03 : 0.09);
      neck(0, c * 0.05);
      P[iHead] -= c * 0.1;
      tail(0, -c * 0.03, 0, Math.min(3, nT));
    }

    /* Turning bends the whole body into the turn (tail swings out). */
    const tn = clamp(this._turn / Math.max(0.6, this.species.turnRate || 1), -1, 1);
    if (tn !== 0) {
      P[iS + 1] += tn * 0.05;
      P[iC + 1] += tn * 0.07;
      neck(1, tn * 0.08);
      P[iHead + 1] += tn * 0.08;
      tail(1, -tn * 0.06);
      P[iH + 2] -= tn * 0.12 * this._run;
    }

    /* Look. */
    const look = this._look;
    neck(1, (look * 0.55) / nN);
    P[iHead + 1] += look * 0.45;
    P[iHead + 2] += look * 0.08;

    const w = this._w;
    const T = this._t;
    const time = this._time;

    /* Feeding: head down to the ground, jaws working. */
    const wE = w[A_EAT];
    const wD = w[A_DRINK];
    if (wE + wD > 0.001) {
      const e = bp.eat;
      const d = bp.drink;
      const wf = Math.min(1, wE + wD);
      P[1] -= wE * e.drop + wD * d.drop;
      P[iH] += wE * e.hips + wD * d.hips;
      P[iS] += wE * e.spine + wD * d.spine;
      P[iC] += wE * e.chest + wD * d.chest;
      const bend = wE * e.bend + wD * d.bend;
      if (bp.neckFlex) for (let k = 0; k < nN; k++) P[R + this._iNeck[k] * 3] += bend * bp.neckFlex[k];
      else neck(0, bend / nN);
      P[iHead] += wE * e.head + wD * d.head;
      tail(0, -wf * Math.max(e.hips, d.hips) * 0.3, 0, Math.min(3, nT));
      P[iJaw] += wE * (0.08 + 0.1 * (0.5 + 0.5 * Math.sin(time * 7))) + wD * (0.05 + 0.03 * Math.sin(time * 12));
      if (this.species.diet === "carnivore") {
        neck(1, (wE * 0.06 * Math.sin(time * 1.7)) / nN);
        neck(0, (wE * 0.05 * Math.sin(time * 3.1)) / nN);
        P[iHead + 2] += wE * 0.15 * Math.sin(time * 2.3);
      } else {
        P[iHead + 1] += wE * 0.1 * Math.sin(time * 0.9);
      }
    }

    /* Call: head up, chest out, jaws wide. */
    const wC = w[A_CALL];
    if (wC > 0.001) {
      const tc = T[A_CALL];
      const env = wC * smoothstep(0, 0.18, tc) * (1 - smoothstep(0.8, 1, tc));
      neck(0, (-0.5 * env) / Math.max(1, nN * 0.75));
      P[iHead] -= env * 0.22;
      P[iJaw] += env * (0.55 + 0.05 * Math.sin(tc * 60));
      P[iC] -= env * 0.06;
      P[iS] -= env * 0.03;
      P[iH] -= env * 0.04;
      tail(0, env * 0.03);
      arms(-env * 0.3, 0);
    }

    /* Bite: wind up with jaws open, lunge, snap shut. */
    const wB = w[A_BITE];
    if (wB > 0.001) {
      const tb = T[A_BITE];
      const wind = smoothstep(0, 0.25, tb) * (1 - smoothstep(0.25, 0.42, tb));
      const strike = smoothstep(0.22, 0.42, tb) * (1 - smoothstep(0.55, 1, tb));
      const open = smoothstep(0.02, 0.22, tb) * (1 - smoothstep(0.38, 0.48, tb));
      neck(0, (wB * (-0.35 * wind + 0.4 * strike)) / nN);
      P[iHead] += wB * (-0.12 * wind + 0.1 * strike);
      P[2] += wB * H * (-0.04 * wind + 0.14 * strike);
      P[iH] += wB * (-0.04 * wind + 0.07 * strike);
      P[iJaw] += wB * open * 0.75;
      arms(wB * (-0.3 * wind - 0.8 * strike), wB * -0.4 * strike);
    }

    /* Tail swipe: twist the hips away, then whip the tail across. */
    const wT = w[A_TAIL];
    if (wT > 0.001) {
      const tt = T[A_TAIL];
      const wind = smoothstep(0, 0.3, tt) * (1 - smoothstep(0.3, 0.5, tt));
      const swing = smoothstep(0.3, 0.55, tt) * (1 - smoothstep(0.65, 1, tt));
      const y = wT * this._tailSide * (-0.6 * wind + swing);
      P[iH + 1] -= y * 0.4;
      P[iS + 1] += y * 0.12;
      P[iC + 1] += y * 0.22;
      neck(1, (y * 0.25) / nN);
      P[iHead + 1] += y * 0.1;
      tail(1, -y * 0.17 * 0.6, 0, nT, 1.4);
      tail(0, wT * swing * 0.03);
      P[iH + 2] += y * 0.05;
    }

    /* Kick: bipeds strike with a hind foot; quadrupeds rear and stamp with the forelimbs. */
    const wK = w[A_KICK];
    if (wK > 0.001) {
      const tk = T[A_KICK];
      if (!bp.quad) {
        const cock = smoothstep(0, 0.3, tk) * (1 - smoothstep(0.3, 0.42, tk));
        const strike = smoothstep(0.28, 0.45, tk) * (1 - smoothstep(0.62, 1, tk));
        for (let i = 0; i < bp.legs.length; i++) {
          const leg = bp.legs[i];
          if (leg.side !== this._kickSide) continue;
          const o = this._oLeg + i * LEG_STRIDE;
          P[o + 1] += wK * (0.32 * cock + 0.42 * strike) * leg.len;
          P[o + 2] += wK * (-0.12 * cock + 0.7 * strike) * leg.len;
          const phi = leg.phi + wK * (0.8 * cock - 0.3 * strike);
          P[o + 4] = Math.cos(phi);
          P[o + 5] = -Math.sin(phi);
          P[o + 6] += wK * (0.4 * cock - 0.3 * strike);
        }
        P[iH] -= wK * 0.12 * strike;
        P[0] -= this._kickSide * wK * 0.04 * H * (cock + strike);
        neck(0, (-wK * 0.04 * strike) / Math.max(1, nN * 0.25));
      } else {
        const up = wK * smoothstep(0, 0.3, tk) * (1 - smoothstep(0.48, 0.62, tk));
        P[iH] -= up * 0.4;
        neck(0, (up * 0.3) / nN);
        for (let i = 0; i < bp.legs.length; i++) {
          const leg = bp.legs[i];
          if (!leg.fore || up < P[this._oLeg + i * LEG_STRIDE + 14]) continue;
          const o = this._oLeg + i * LEG_STRIDE;
          P[o + 7] = leg.side * 0.03;
          P[o + 8] = -leg.len * 0.55;
          P[o + 9] = leg.len * 0.45;
          P[o + 10] = 0;
          P[o + 11] = 0.2;
          P[o + 12] = 0.98;
          P[o + 14] = up;
        }
      }
    }
  }

  _restPose(P) {
    const bp = this._bp;
    const R = this._oRot;
    const H = bp.H;
    const rs = bp.rest;
    const nN = this._iNeck.length;
    const nT = this._iTail.length;
    const iH = R + this._iHips * 3;
    P[1] = rs.hipsY + 0.006 * H * Math.sin(this._breath);
    P[iH] = rs.pitch;
    P[iH + 2] = 0.04 * this._restCurl;
    const long = nN > 5;
    for (let k = 0; k < nN; k++) {
      P[R + this._iNeck[k] * 3] += long ? 0.09 : 0.05;
      P[R + this._iNeck[k] * 3 + 1] += 0.05 * this._restCurl;
    }
    P[R + this._iHead * 3] -= long ? 0.25 : 0.12;
    // Tail drops to the ground near its base, then lies along it, curling to one side.
    const alpha = Math.atan2(rs.hipsY * 0.9, bp.aHips * 0.3);
    const prof = [-1, -0.25, 0.45, 0.45, 0.3, 0.05, 0, 0];
    for (let k = 0; k < nT; k++) {
      P[R + this._iTail[k] * 3] += alpha * (prof[Math.min(k, prof.length - 1)] ?? 0) * (8 / Math.max(8, nT));
      P[R + this._iTail[k] * 3 + 1] += 0.07 * this._restCurl;
    }
    for (const arm of bp.arms) {
      P[R + arm.bones[0] * 3] += 0.45;
      P[R + arm.bones[1] * 3] -= 0.6;
    }
    P[this._oRibs] = 1 + 0.028 * Math.sin(this._breath);
    for (let i = 0; i < bp.legs.length; i++) {
      const leg = bp.legs[i];
      const o = this._oLeg + i * LEG_STRIDE;
      const l3 = leg.lengths[2];
      if (!leg.fore) {
        // Folded like a resting bird: metatarsus flat on the ground, heel back, toes forward.
        P[o] = leg.ball.x * 1.15;
        P[o + 1] = leg.ballH;
        P[o + 2] = leg.hip.z - 0.12 * leg.len + l3;
        P[o + 3] = 0;
        P[o + 4] = 0.08;
        P[o + 5] = -1;
      } else {
        P[o] = leg.ball.x * 1.1;
        P[o + 1] = leg.ballH;
        P[o + 2] = leg.ball.z - 0.25 * leg.len;
        P[o + 3] = 0;
        P[o + 4] = 0.15;
        P[o + 5] = 1;
      }
      P[o + 6] = 0.1;
    }
  }

  _deadPose(P) {
    const bp = this._bp;
    const R = this._oRot;
    const H = bp.H;
    const d = this._deadT;
    const nN = this._iNeck.length;
    const nT = this._iTail.length;
    const iH = R + this._iHips * 3;
    const fall = smoothstep(0.05, 0.95, d);
    const settle = d > 0.95 ? 0.05 * Math.exp(-(d - 0.95) * 6) * Math.sin((d - 0.95) * 18) : 0;
    const side = this._deadSide;
    P[0] = -side * (H - bp.dead.hipsY) * 0.45 * fall;
    P[1] = lerp(H, bp.dead.hipsY, fall);
    P[iH] = 0.05 * fall;
    P[iH + 2] = side * (fall * fall * 1.48 + settle);
    // The classic death pose: neck thrown back, tail arched, jaws agape.
    const curl = smoothstep(0.3, 1.8, d);
    for (let k = 0; k < nN; k++) P[R + this._iNeck[k] * 3] -= (curl * 0.8) / Math.max(nN, 3);
    P[R + this._iHead * 3] -= 0.3 * curl;
    P[R + this._iJaw * 3] += 0.35 * curl;
    for (let k = 0; k < nT; k++) {
      P[R + this._iTail[k] * 3] += (0.5 * curl) / nT;
      P[R + this._iTail[k] * 3 + 1] -= (side * 0.25 * curl) / nT;
    }
    for (const arm of bp.arms) {
      P[R + arm.bones[0] * 3] += 0.5 * fall;
      P[R + arm.bones[1] * 3] += 0.3 * fall;
    }
    const limp = smoothstep(0.1, 0.8, d);
    for (let i = 0; i < bp.legs.length; i++) {
      const leg = bp.legs[i];
      const o = this._oLeg + i * LEG_STRIDE;
      P[o + 7] = leg.side * 0.1 * leg.len;
      P[o + 8] = -0.8 * leg.len;
      P[o + 9] = (leg.fore ? 0.22 : 0.3) * leg.len;
      P[o + 10] = 0;
      P[o + 11] = leg.fore ? 0.5 : 0.4;
      P[o + 12] = leg.fore ? 0.86 : -0.92;
      P[o + 14] = limp;
    }
  }

  /* --- Apply pose to the rig ------------------------------------------- */

  _apply(P) {
    const bp = this._bp;
    const bones = this._bones;
    const R = this._oRot;
    const wq = this._wq;
    const wp = this._wp;
    const ws = this._ws;
    const par = this._parent;
    bones[this._iHips].position.set(P[0], P[1], P[2]);
    bones[bp.index.ribs].scale.setScalar(P[this._oRibs]);
    for (let i = 0; i < this._nb; i++) {
      if (this._isLeg[i]) continue;
      const b = bones[i];
      if (i > 0) {
        _e.set(P[R + i * 3], P[R + i * 3 + 1], P[R + i * 3 + 2], "YXZ");
        b.quaternion.setFromEuler(_e);
      }
      const p = par[i];
      if (p < 0) {
        wq[i].copy(b.quaternion);
        wp[i].copy(b.position);
        ws[i] = b.scale.x;
      } else {
        wq[i].multiplyQuaternions(wq[p], b.quaternion);
        wp[i].copy(b.position).multiplyScalar(ws[p]).applyQuaternion(wq[p]).add(wp[p]);
        ws[i] = ws[p] * b.scale.x;
      }
    }
    /* Legs: two-bone IK to the ankle, then the metatarsus onto the ball and the toes along the ground. */
    for (let li = 0; li < bp.legs.length; li++) {
      const leg = bp.legs[li];
      const o = this._oLeg + li * LEG_STRIDE;
      const [bU, bL, bM, bF] = leg.bones;
      const [l1, l2, l3] = leg.lengths;
      const p = leg.parentIndex;
      const pq = wq[p];
      _hip.copy(leg.hipLocal).applyQuaternion(pq).add(wp[p]);
      _ball.set(P[o], P[o + 1], P[o + 2]);
      _meta.set(P[o + 3], P[o + 4], P[o + 5]);
      const limp = P[o + 14];
      if (limp > 0.001) {
        _va.set(P[o + 7], P[o + 8], P[o + 9]).applyQuaternion(pq).add(_hip);
        _vb.set(P[o + 10], P[o + 11], P[o + 12]).applyQuaternion(pq);
        _ball.lerp(_va, limp);
        _meta.lerp(_vb, limp);
      }
      if (_meta.lengthSq() < 1e-8) _meta.copy(leg.metaDir);
      _meta.normalize();
      _ankle.copy(_ball).addScaledVector(_meta, l3);
      _pole.copy(leg.pole).applyQuaternion(pq);
      _side.copy(_X).applyQuaternion(pq);
      solveKnee(_hip, _ankle, l1, l2, _pole, _knee);
      // Thigh / upper arm.
      aimRotation(leg.basisT[0], _va.subVectors(_knee, _hip), _side, wq[bU]);
      bones[bU].quaternion.copy(pq).invert().multiply(wq[bU]);
      wp[bU].copy(_hip);
      // Shin / forearm.
      _vb.subVectors(_ankle, _knee).normalize();
      aimRotation(leg.basisT[1], _vb, _side, wq[bL]);
      bones[bL].quaternion.copy(wq[bU]).invert().multiply(wq[bL]);
      wp[bL].copy(_knee);
      _vc.copy(_knee).addScaledVector(_vb, l2);
      // Metatarsus.
      _vd.subVectors(_ball, _vc).normalize();
      aimRotation(leg.basisT[2], _vd, _side, wq[bM]);
      bones[bM].quaternion.copy(wq[bL]).invert().multiply(wq[bM]);
      wp[bM].copy(_vc);
      // Toes: along the ground (heading of the parent) — or relaxed against the metatarsus when limp.
      _toe.copy(_Z).applyQuaternion(pq);
      _toe.y = 0;
      if (_toe.lengthSq() < 1e-6) _toe.copy(_Z);
      _toe.normalize();
      const tp = leg.toeSlope + P[o + 6];
      _toe.multiplyScalar(Math.cos(tp)).addScaledVector(_Y, -Math.sin(tp));
      if (limp > 0.001) {
        _va.subVectors(leg.toeEnd, leg.ball).normalize().applyQuaternion(wq[bM]);
        _toe.lerp(_va, limp).normalize();
      }
      aimRotation(leg.basisT[3], _toe, _side, wq[bF]);
      bones[bF].quaternion.copy(wq[bM]).invert().multiply(wq[bF]);
      wp[bF].copy(_vc).addScaledVector(_vd, l3);
      ws[bU] = ws[bL] = ws[bM] = ws[bF] = 1;
    }
  }
}

function lerpPose(a, b, w) {
  for (let i = 0; i < a.length; i++) a[i] += (b[i] - a[i]) * w;
}

/**
 * Build a dinosaur model.
 * @param {object|string} species SpeciesDef or id
 * @param {{ seed?: number, variant?: number }} [opts]
 * @returns {DinoModel}
 */
export function createDinoModel(species, { seed = 1, variant = 0 } = {}) {
  return new DinoModel(species, { seed, variant });
}

/**
 * Optional: build and cache the shared geometry for some species ahead of
 * time (e.g. behind the loading screen) so the first spawn doesn't hitch.
 * @param {string[]} ids species ids
 */
export function prewarmDinoGeometry(ids) {
  for (const id of ids) {
    const sp = getSpecies(id);
    for (let i = 0; i < LOD_LEVELS.length; i++) getGeometry(sp, i);
  }
}
