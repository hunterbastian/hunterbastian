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
import { makeRng, rand, hash } from "../core/rng.js";
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
  tooth: "#e9dfc6",
  claw: "#2c2621",
  hoof: "#3a332b",
  mouth: "#6a302e",
  tongue: "#8c4a46",
  beak: "#2f2a25",
  nostril: "#1c1714",
  pupil: "#070606",
  horn: "#d9ccae",
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
  const nA = [periodicValueNoise(rng, 6), periodicValueNoise(rng, 12), periodicValueNoise(rng, 24)];
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
        const shaft = as < 0.05 ? 0.62 : 1;
        const bar = sh.bar > 0 ? 1 - sh.bar * smoothstep(0.55, 0.75, Math.sin(t * 22) * 0.5 + 0.5) : 1;
        const edgeDark = 1 - 0.18 * smoothstep(0.5 * w, w, as);
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
float spot = smoothstep( uSpots.y, uSpots.y + 0.06, coarseT.a ) * vSkin.y * ( 1.0 - sBelly ) * uSpots.x;
skin = mix( skin, uPatternCol, spot );
float lstripe = 1.0 - smoothstep( uStripe.y * 0.45, uStripe.y, abs( rn.y - uStripe.x + ( coarseT.b - 0.5 ) * 0.14 ) );
skin = mix( skin, uLight, lstripe * uStripe.z * vSkin.y );
skin = mix( skin, uBelly, sBelly );
skin = mix( skin, uAccent, vSkin.z );
skin *= 1.0 + ( coarseT.b - 0.5 ) * uSpots.z;
skin *= mix( 1.0, 0.9 + 0.2 * fineT.g, vSkin.w );
skin *= 1.0 - ( 1.0 - fineT.r ) * uScales.w * vSkin.w;
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
  // Fade the relief out once a scale shrinks below ~2 px: no shimmer far away or in the pixel style.
  float bumpFade = 1.0 - smoothstep( 0.025, 0.09, length( fwidth( fp ) ) );
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
    addBump(a, thetaForY(a, ft(a) * 0.84), 0.075, 0.042, 0.07, 0.75);
    const a2 = arcAtU(0.62);
    addBump(a2, thetaForY(a2, ft(a2) * 0.96), 0.24, 0.02, 0.016, 0.15);
  }
  if (f.browBosses) {
    const a = arcAtU(0.23);
    addBump(a, thetaForY(a, ft(a) * 0.8), 0.06, 0.045, 0.055, 0.7);
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

/* @@PART3@@ */
