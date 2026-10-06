// Sky, sun & moon light, fog and the day/night cycle.
//
// One Sky owns everything that depends on the time of day:
//   - a camera-following sky dome (one ShaderMaterial: hazy gradient, sunrise /
//     sunset glow, sun disc + halo, moon, twinkling stars, a faint Milky Way and
//     soft sun-lit clouds from a mip-mapped procedural noise texture),
//   - the key DirectionalLight (the sun by day, a cool dim moon by night),
//   - a HemisphereLight for ambient fill,
//   - scene.fog, whose colour IS the dome's horizon so distant land melts into
//     the sky.
// Everything is driven by a single day phase: 0 midnight, 0.25 sunrise,
// 0.5 noon, 0.75 sunset.
//
// Colour pipeline. three.js tone-maps lit materials but mixes fog in *after*
// tone mapping, so the fog colour reaches the screen as-is. The dome is
// therefore not tone mapped either: its horizon equals the fog exactly, in the
// direct ("detailed") path and in a low-res render-target ("pixel") path, where
// everything — dome, fog and lit scene — goes through the final blit together.

import * as THREE from "three";
import { TIME } from "../config.js";
import { makeRng } from "../core/rng.js";
import { TAU, clamp, lerp, smoothstep } from "../core/math.js";

/* --- Celestial geometry --- */

// The sun rises in the east (+X), culminates toward +Z and sets in the west
// (-X). Tilting its orbit away from the zenith keeps noon shadows readable
// (noon elevation = 90° - tilt ≈ 58°).
const SUN_TILT = 0.56;
// The (always full) moon runs opposite the sun on a slightly lower arc, so it
// sets in the west at sunrise and rises in the east at sunset (~50° at midnight).
const MOON_TILT = 0.7;
// Stars rotate about the sun's orbital axis so the whole sky turns together.
const CELESTIAL_AXIS = new THREE.Vector3(0, -Math.sin(SUN_TILT), Math.cos(SUN_TILT));

const DOME_RADIUS = 1000; // anything inside the camera far plane (2000) works
const SUN_RADIUS = 0.028; // radians — a touch larger than life, it reads better
const MOON_RADIUS = 0.034;

/* --- Lighting constants (r180 physical units, tuned for ACES @ exposure 1) --- */

// Key light intensity by elevation (sine of altitude). The low sun stays
// strong for a proper golden hour instead of fading out with the sky.
const SUN_INTENSITY = [[-0.04, 0], [0.0, 0.55], [0.05, 1.45], [0.12, 2.0], [0.25, 2.45], [0.45, 2.8], [0.85, 2.95]];
const MOON_INTENSITY = [[-0.05, 0], [0.0, 0.3], [0.1, 1.05], [0.3, 1.7], [0.7, 1.9]];
const MOON_LIGHT = new THREE.Color("#9db3e2"); // cool blue moonlight
const MOON_DISC = new THREE.Color("#e9eef7");
const MOON_HALO = new THREE.Color("#7f95c4");
const BELT_COLOR = new THREE.Color("#b58aa5"); // pink anti-twilight band ("Belt of Venus")

// Lights never shine from below the horizon: near the crossing the key
// direction is lifted to at least this elevation (sine), which also lets the
// sun→moon hand-off swing smoothly overhead instead of through the ground.
const LIGHT_MIN_Y = 0.12;

/* --- Shadows --- */

const SHADOW_HALF = 60; // metres: the ortho shadow box is ±60 m around the focus
const SHADOW_DISTANCE = 170; // light sits this far from the focus along the light dir
const SHADOW_DEPTH = 360; // near..far range of the shadow camera

/* --- Fog --- */

// Haze is densest near the ground: as the camera climbs (title flight,
// mountain tops) the fog distances stretch, up to this factor.
const FOG_ALTITUDE_BOOST = 2.2;
const FOG_ALTITUDE_RANGE = [20, 220]; // metres above sea level

/* --- Palette keyframes --- */

// Authored in sRGB hex (picked by eye) and converted to linear once at load.
// `horizon` doubles as the fog colour. `near`/`far` are fog distances as a
// fraction of viewDistance. `glow` is the warm band hugging the horizon around
// the sun; `hemi*` drive the HemisphereLight; `cloud*` shade the clouds
// (`cloudLit` fully lit by the key light, `cloudDark` the shadowed underside).
const RAW_KEYS = [
  { p: 0.0, zenith: "#03060d", horizon: "#101a2c", glow: "#1b2540", glowAmt: 0, hemiSky: "#3e5480", hemiGround: "#0f131b", hemi: 3.5, cloudLit: "#3a4560", cloudDark: "#0b0f19", near: 0.03, far: 0.72 },
  { p: 0.17, zenith: "#040710", horizon: "#121c30", glow: "#1d2744", glowAmt: 0, hemiSky: "#3e5480", hemiGround: "#0f131b", hemi: 3.4, cloudLit: "#363f58", cloudDark: "#0b0f19", near: 0.03, far: 0.7 },
  { p: 0.21, zenith: "#0b1226", horizon: "#272a46", glow: "#6a4a6a", glowAmt: 0.35, hemiSky: "#424e74", hemiGround: "#131419", hemi: 3.0, cloudLit: "#4a4561", cloudDark: "#12141f", near: 0.02, far: 0.58 },
  { p: 0.235, zenith: "#1d2a52", horizon: "#7a667a", glow: "#d68a78", glowAmt: 0.72, hemiSky: "#6c6e8c", hemiGround: "#2a2420", hemi: 2.1, cloudLit: "#c08a90", cloudDark: "#3a3852", near: 0.0, far: 0.44 },
  { p: 0.255, zenith: "#3a578a", horizon: "#d0a089", glow: "#ffa060", glowAmt: 1.0, hemiSky: "#b0a4a8", hemiGround: "#4a3a2c", hemi: 1.65, cloudLit: "#ffc49a", cloudDark: "#665a70", near: 0.0, far: 0.4 },
  { p: 0.285, zenith: "#5481b5", horizon: "#e2c7a8", glow: "#ffc68a", glowAmt: 0.6, hemiSky: "#c4c6c8", hemiGround: "#5a4a36", hemi: 1.5, cloudLit: "#fff0dc", cloudDark: "#8c8c9c", near: 0.02, far: 0.5 },
  { p: 0.34, zenith: "#5589c0", horizon: "#cbd6d4", glow: "#ffe6c0", glowAmt: 0.2, hemiSky: "#b4c8da", hemiGround: "#5c5440", hemi: 1.5, cloudLit: "#fbfaf6", cloudDark: "#9eaabb", near: 0.07, far: 0.78 },
  { p: 0.42, zenith: "#4d84bf", horizon: "#c1d2da", glow: "#fff2d8", glowAmt: 0.06, hemiSky: "#b0c6dc", hemiGround: "#5e5844", hemi: 1.55, cloudLit: "#fbfbf8", cloudDark: "#a2b0c2", near: 0.12, far: 0.95 },
  { p: 0.5, zenith: "#4b83be", horizon: "#bfd1da", glow: "#fff4e0", glowAmt: 0.04, hemiSky: "#b0c6dc", hemiGround: "#605a46", hemi: 1.55, cloudLit: "#fbfbf8", cloudDark: "#a2b0c2", near: 0.13, far: 1.0 },
  { p: 0.6, zenith: "#4d83bb", horizon: "#c4d3d7", glow: "#fff0d4", glowAmt: 0.06, hemiSky: "#b4c6da", hemiGround: "#625a44", hemi: 1.55, cloudLit: "#fbf9f4", cloudDark: "#a4aebe", near: 0.12, far: 0.95 },
  { p: 0.68, zenith: "#5078a8", horizon: "#d8ceb4", glow: "#ffcc8a", glowAmt: 0.3, hemiSky: "#c4c2c0", hemiGround: "#62523c", hemi: 1.45, cloudLit: "#fff0d6", cloudDark: "#9a96a2", near: 0.1, far: 0.88 },
  { p: 0.725, zenith: "#3c5486", horizon: "#e0ac84", glow: "#ffa058", glowAmt: 0.78, hemiSky: "#c4aaa0", hemiGround: "#54402e", hemi: 1.45, cloudLit: "#ffb27a", cloudDark: "#6a5a6c", near: 0.06, far: 0.74 },
  { p: 0.75, zenith: "#29376a", horizon: "#c67c66", glow: "#ff7440", glowAmt: 1.0, hemiSky: "#a08498", hemiGround: "#3c2e28", hemi: 1.7, cloudLit: "#ff9a6a", cloudDark: "#4c3c58", near: 0.04, far: 0.68 },
  { p: 0.77, zenith: "#18214a", horizon: "#6a4a62", glow: "#cc566a", glowAmt: 0.6, hemiSky: "#62608a", hemiGround: "#1e1a1e", hemi: 2.3, cloudLit: "#8a5470", cloudDark: "#28233a", near: 0.04, far: 0.66 },
  { p: 0.795, zenith: "#0c1330", horizon: "#283050", glow: "#5a3e62", glowAmt: 0.25, hemiSky: "#425078", hemiGround: "#12141a", hemi: 3.0, cloudLit: "#3e3e5c", cloudDark: "#10131f", near: 0.035, far: 0.68 },
  { p: 0.84, zenith: "#050812", horizon: "#121c30", glow: "#1d2744", glowAmt: 0, hemiSky: "#3e5480", hemiGround: "#0f131b", hemi: 3.5, cloudLit: "#3a4560", cloudDark: "#0b0f19", near: 0.03, far: 0.72 },
];

const COLOR_FIELDS = ["zenith", "horizon", "glow", "hemiSky", "hemiGround", "cloudLit", "cloudDark"];
const NUMBER_FIELDS = ["glowAmt", "hemi", "near", "far"];

function buildKeys(raw) {
  const keys = raw.map((k) => {
    const out = { p: k.p };
    for (const f of COLOR_FIELDS) out[f] = new THREE.Color(k[f]);
    for (const f of NUMBER_FIELDS) out[f] = k[f];
    return out;
  });
  // Close the loop: phase 1 is midnight again.
  keys.push({ ...keys[0], p: 1 });
  return keys;
}

const KEYS = buildKeys(RAW_KEYS);

function makeKeyState() {
  const s = {};
  for (const f of COLOR_FIELDS) s[f] = new THREE.Color();
  for (const f of NUMBER_FIELDS) s[f] = 0;
  return s;
}

/** Linear interpolation of the palette keys at `phase` into `out` (no allocation). */
function sampleKeys(phase, out) {
  let i = 0;
  while (i < KEYS.length - 2 && phase >= KEYS[i + 1].p) i++;
  const a = KEYS[i];
  const b = KEYS[i + 1];
  const t = clamp((phase - a.p) / (b.p - a.p), 0, 1);
  for (const f of COLOR_FIELDS) out[f].lerpColors(a[f], b[f], t);
  for (const f of NUMBER_FIELDS) out[f] = lerp(a[f], b[f], t);
  return out;
}

// Sun light colour by elevation (sine of altitude): deep orange on the
// horizon, golden low, warm white high.
const SUN_COLOR_KEYS = [
  { y: -0.1, c: new THREE.Color("#ff5a2c") },
  { y: 0.0, c: new THREE.Color("#ff7a3c") },
  { y: 0.08, c: new THREE.Color("#ffa866") },
  { y: 0.2, c: new THREE.Color("#ffd2a0") },
  { y: 0.42, c: new THREE.Color("#ffedd6") },
  { y: 1.0, c: new THREE.Color("#fff4e6") },
];

/** Piecewise-linear lookup in [[x, value], ...] (clamped at both ends). */
function sampleCurve(keys, x) {
  if (x <= keys[0][0]) return keys[0][1];
  for (let i = 0; i < keys.length - 1; i++) {
    const a = keys[i];
    const b = keys[i + 1];
    if (x <= b[0]) return lerp(a[1], b[1], (x - a[0]) / (b[0] - a[0]));
  }
  return keys[keys.length - 1][1];
}

function sampleSunColor(y, out) {
  const k = SUN_COLOR_KEYS;
  if (y <= k[0].y) return out.copy(k[0].c);
  for (let i = 0; i < k.length - 1; i++) {
    if (y <= k[i + 1].y) return out.lerpColors(k[i].c, k[i + 1].c, (y - k[i].y) / (k[i + 1].y - k[i].y));
  }
  return out.copy(k[k.length - 1].c);
}

/** Unit vector toward the sun at `phase`. */
function sunDirAt(phase, out) {
  const th = (phase - 0.25) * TAU;
  const s = Math.sin(th);
  return out.set(Math.cos(th), s * Math.cos(SUN_TILT), s * Math.sin(SUN_TILT));
}

/** Unit vector toward the moon at `phase` (opposite the sun, own tilt). */
function moonDirAt(phase, out) {
  const th = (phase - 0.25) * TAU;
  const s = Math.sin(th);
  return out.set(-Math.cos(th), -s * Math.cos(MOON_TILT), -s * Math.sin(MOON_TILT));
}

/** Copy `dir` into `out`, raised to at least LIGHT_MIN_Y elevation. */
function liftDir(dir, out) {
  out.copy(dir);
  if (out.y < LIGHT_MIN_Y) out.y = LIGHT_MIN_Y;
  return out.normalize();
}

/**
 * Spherical interpolation between unit vectors a → b (constant angular speed).
 * A plain lerp of the near-opposite moon/sun directions would collapse and
 * whip overhead in a few seconds; this sweeps the arc evenly.
 */
function slerpDir(a, b, t, out) {
  const cos = clamp(a.dot(b), -1, 1);
  const ang = Math.acos(cos);
  if (ang < 1e-4) return out.copy(a);
  const s = Math.sin(ang);
  return out.copy(a).multiplyScalar(Math.sin((1 - t) * ang) / s).addScaledVector(b, Math.sin(t * ang) / s).normalize();
}

/* --- Cloud noise texture --- */

/**
 * Tileable 2D gradient noise. Returns n(x, y, period) ≈ [-1, 1] that repeats
 * every `period` units in x and y (period: integer ≤ 256), so fBm built from
 * integer periods tiles seamlessly on a texture.
 */
function makeTileNoise(seed) {
  const rng = makeRng(seed);
  const perm = new Uint8Array(512);
  for (let i = 0; i < 256; i++) perm[i] = i;
  for (let i = 255; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    const t = perm[i];
    perm[i] = perm[j];
    perm[j] = t;
  }
  for (let i = 0; i < 256; i++) perm[i + 256] = perm[i];
  const gx = new Float32Array(256);
  const gy = new Float32Array(256);
  for (let i = 0; i < 256; i++) {
    const a = rng() * TAU;
    gx[i] = Math.cos(a);
    gy[i] = Math.sin(a);
  }
  return (x, y, period) => {
    const xf = Math.floor(x);
    const yf = Math.floor(y);
    const fx = x - xf;
    const fy = y - yf;
    let x0 = xf % period;
    let y0 = yf % period;
    if (x0 < 0) x0 += period;
    if (y0 < 0) y0 += period;
    const x1 = x0 + 1 === period ? 0 : x0 + 1;
    const y1 = y0 + 1 === period ? 0 : y0 + 1;
    const h00 = perm[perm[x0] + y0];
    const h10 = perm[perm[x1] + y0];
    const h01 = perm[perm[x0] + y1];
    const h11 = perm[perm[x1] + y1];
    const v00 = gx[h00] * fx + gy[h00] * fy;
    const v10 = gx[h10] * (fx - 1) + gy[h10] * fy;
    const v01 = gx[h01] * fx + gy[h01] * (fy - 1);
    const v11 = gx[h11] * (fx - 1) + gy[h11] * (fy - 1);
    const u = fx * fx * fx * (fx * (fx * 6 - 15) + 10);
    const v = fy * fy * fy * (fy * (fy * 6 - 15) + 10);
    return lerp(lerp(v00, v10, u), lerp(v01, v11, u), v) * 1.42;
  };
}

const CLOUD_TEX_SIZE = 256;
let cloudPixels = null; // generated once per page, shared by every Sky

/**
 * RGBA8 tileable cloud noise:
 *   R — domain-warped fBm, the large cloud masses,
 *   G — warped mid-frequency fBm that frays the masses' edges,
 *   B — fine fBm for wisps and edges,
 *   A — stretched fBm for high cirrus streaks.
 */
function cloudNoisePixels() {
  if (cloudPixels) return cloudPixels;
  const S = CLOUD_TEX_SIZE;
  const nA = makeTileNoise(9127);
  const nB = makeTileNoise(4441);
  const nC = makeTileNoise(771);
  const raw = new Float32Array(S * S * 4);
  const fbm = (n, u, v, period, octaves) => {
    let sum = 0;
    let amp = 0.5;
    let norm = 0;
    let p = period;
    for (let o = 0; o < octaves; o++) {
      sum += amp * n(u * p, v * p, p);
      norm += amp;
      amp *= 0.5;
      p *= 2;
    }
    return sum / norm;
  };
  for (let y = 0; y < S; y++) {
    const v = y / S;
    for (let x = 0; x < S; x++) {
      const u = x / S;
      // Warping by a periodic field keeps the result periodic.
      const wx = nC(u * 3, v * 3, 3) * 0.06;
      const wy = nC(u * 3 + 17.3, v * 3 + 5.1, 3) * 0.06;
      // Octaves stop at ~8 texels per cycle: finer detail comes from the
      // shader sampling these channels at higher frequencies.
      const r = fbm(nA, u + wx, v + wy, 4, 4);
      const g = fbm(nB, u - wy * 0.7, v + wx * 0.7, 8, 3);
      const b = fbm(nC, u, v, 16, 3);
      const a = fbm(nB, u, v * 4, 4, 2);
      const i = (y * S + x) * 4;
      raw[i] = r;
      raw[i + 1] = g;
      raw[i + 2] = b;
      raw[i + 3] = a;
    }
  }
  // Normalise every channel to mean 0.5, ±2.5σ → [0, 1], so the shader's
  // coverage threshold means the same thing for each of them.
  const data = new Uint8Array(S * S * 4);
  for (let c = 0; c < 4; c++) {
    let sum = 0;
    let sq = 0;
    for (let i = c; i < raw.length; i += 4) {
      sum += raw[i];
      sq += raw[i] * raw[i];
    }
    const n = raw.length / 4;
    const mean = sum / n;
    const sd = Math.sqrt(Math.max(sq / n - mean * mean, 1e-8));
    for (let i = c; i < raw.length; i += 4) data[i] = Math.round(clamp(((raw[i] - mean) / sd) * 0.2 + 0.5, 0, 1) * 255);
  }
  cloudPixels = data;
  return data;
}

function makeCloudTexture() {
  const tex = new THREE.DataTexture(cloudNoisePixels(), CLOUD_TEX_SIZE, CLOUD_TEX_SIZE, THREE.RGBAFormat, THREE.UnsignedByteType);
  tex.wrapS = THREE.RepeatWrapping;
  tex.wrapT = THREE.RepeatWrapping;
  tex.magFilter = THREE.LinearFilter;
  // Mips make far clouds near the horizon average out instead of sparkling —
  // essential for the low-res pixel style.
  tex.minFilter = THREE.LinearMipmapLinearFilter;
  tex.generateMipmaps = true;
  tex.anisotropy = 4;
  tex.colorSpace = THREE.NoColorSpace;
  tex.needsUpdate = true;
  return tex;
}

/* --- Shared sky colour model (GLSL) --- */

/**
 * GLSL chunk: the sky's base colour for any direction — the hazy horizon →
 * zenith gradient, the warm glow around the sun's azimuth, the pink belt
 * opposite it and the broad sun halo. Below the horizon it returns the haze
 * at horizon level for that azimuth. The dome builds on it, and water.js uses
 * it for sky reflections and as its (azimuth-aware) fog colour so the sea
 * meets the sky without a seam. Values are linear and display-referred (not
 * tone mapped). Uniforms are fed from Sky (see Sky.uniforms).
 */
export const SKY_COLOR_GLSL = /* glsl */ `
uniform vec3 uZenith;
uniform vec3 uHorizon;
uniform vec3 uGlow;
uniform float uGlowAmt;
uniform vec3 uBelt;
uniform vec3 uSunDir;
uniform vec3 uSunHalo;

vec3 skyBase(vec3 dir) {
  float y = max(dir.y, 0.0);
  vec2 h = dir.xz;
  float hl = length(h);
  vec3 col = mix(uHorizon, uZenith, 1.0 - exp(-y * 3.2));
  float sl = length(uSunDir.xz);
  float az = (hl > 1e-4 && sl > 1e-4) ? dot(h / hl, uSunDir.xz / sl) : 0.0;
  float glow = pow(az * 0.5 + 0.5, 3.0) * exp(-y * 5.5) * uGlowAmt;
  col = mix(col, uGlow, clamp(glow, 0.0, 1.0));
  col += uBelt * pow(0.5 - az * 0.5, 2.0) * exp(-abs(y - 0.07) * 13.0);
  vec3 d = hl > 1e-4 ? normalize(vec3(dir.x, y, dir.z)) : vec3(0.0, 1.0, 0.0);
  float mu = max(dot(d, uSunDir), 0.0);
  float mu2 = mu * mu;
  float mu8 = mu2 * mu2;
  mu8 *= mu8;
  col += uSunHalo * (mu8 * 0.16 + pow(mu, 90.0) * 0.4);
  return col;
}
`;

/* --- Dome shader --- */

const DOME_VERTEX = /* glsl */ `
varying vec3 vDir;

void main() {
  vDir = position;
  vec4 clip = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
  // Pin the dome just inside the far plane so it can never be clipped,
  // whatever the camera's far distance is.
  gl_Position = vec4(clip.xy, clip.w * 0.99999, clip.w);
}
`;

const DOME_FRAGMENT = /* glsl */ `
${SKY_COLOR_GLSL}
uniform vec3 uSunDisc;
uniform float uSunVis;
uniform vec3 uMoonDir;
uniform vec3 uMoonDisc;
uniform float uMoonAlpha;
uniform vec3 uMoonHalo;
uniform float uStars;
uniform mat3 uCelestial;
uniform float uTime;
uniform vec3 uLightDir;
uniform sampler2D uClouds;
uniform vec4 uCloudOff;
uniform float uCirrusOff;
uniform float uCloudCover;
uniform float uCloudAmount;
uniform vec3 uCloudLit;
uniform vec3 uCloudDark;

varying vec3 vDir;

const float SUN_COS_OUT = ${Math.cos(SUN_RADIUS * 1.1).toFixed(7)};
const float SUN_COS_IN = ${Math.cos(SUN_RADIUS * 0.9).toFixed(7)};
const float SUN_RADIUS = ${SUN_RADIUS.toFixed(4)};
const float MOON_COS_OUT = ${Math.cos(MOON_RADIUS * 1.06).toFixed(7)};
const float MOON_COS_IN = ${Math.cos(MOON_RADIUS * 0.94).toFixed(7)};
const float MOON_RADIUS = ${MOON_RADIUS.toFixed(4)};
const float STAR_GRID = 150.0;
const float STAR_THRESHOLD = 0.958;
const float CLOUD_SOFT = 0.15; // density ramp above the coverage threshold

/* Hashes without sine (Dave Hoskins) — stable across GPUs. */
float hash12(vec2 p) {
  vec3 p3 = fract(vec3(p.xyx) * 0.1031);
  p3 += dot(p3, p3.yzx + 33.33);
  return fract((p3.x + p3.y) * p3.z);
}
float hash13(vec3 p3) {
  p3 = fract(p3 * 0.1031);
  p3 += dot(p3, p3.zyx + 31.32);
  return fract((p3.x + p3.y) * p3.z);
}
vec3 hash33(vec3 p3) {
  p3 = fract(p3 * vec3(0.1031, 0.1030, 0.0973));
  p3 += dot(p3, p3.yxz + 33.33);
  return fract((p3.xxy + p3.yxx) * p3.zyx);
}

float vnoise(vec2 p) {
  vec2 i = floor(p);
  vec2 f = fract(p);
  vec2 u = f * f * (3.0 - 2.0 * f);
  return mix(mix(hash12(i), hash12(i + vec2(1.0, 0.0)), u.x),
             mix(hash12(i + vec2(0.0, 1.0)), hash12(i + vec2(1.0, 1.0)), u.x), u.y);
}

#ifdef MILKY_WAY
float vnoise3(vec3 p) {
  vec3 i = floor(p);
  vec3 f = fract(p);
  f = f * f * (3.0 - 2.0 * f);
  return mix(
    mix(mix(hash13(i), hash13(i + vec3(1, 0, 0)), f.x), mix(hash13(i + vec3(0, 1, 0)), hash13(i + vec3(1, 1, 0)), f.x), f.y),
    mix(mix(hash13(i + vec3(0, 0, 1)), hash13(i + vec3(1, 0, 1)), f.x), mix(hash13(i + vec3(0, 1, 1)), hash13(i + vec3(1, 1, 1)), f.x), f.y),
    f.z);
}
#endif

#ifdef CLOUDS
/* Cloud density on the cloud plane (cp = horizontal position at unit height). */
float cloudField(vec2 cp) {
  float base = texture2D(uClouds, cp * 0.16 + uCloudOff.xy).r;
  float puff = texture2D(uClouds, cp * 0.47 + uCloudOff.zw).g;
  return base * 0.7 + puff * 0.3;
}
#endif

void main() {
  vec3 dir = normalize(vDir);
  float y = dir.y;
  vec3 cel = uCelestial * dir;
  // Screen-space footprint of one pixel on the star grid. Taken before any
  // branching (derivatives are undefined in divergent control flow).
  float starPx = length(fwidth(cel)) * STAR_GRID;

  vec3 col = skyBase(dir);
  // Celestial bodies sink behind the horizon.
  float above = smoothstep(-0.006, 0.012, y);

  /* Stars + Milky Way, in a frame that turns with the sun. */
  if (uStars > 0.003) {
    float starFade = uStars * smoothstep(0.0, 0.22, y);
    float band = 0.0;
    #ifdef MILKY_WAY
    float bd = dot(cel, normalize(vec3(0.38, 0.22, 0.9)));
    band = exp(-bd * bd * 22.0);
    float dust = vnoise3(cel * 9.0) * 0.55 + vnoise3(cel * 23.0) * 0.3 + vnoise3(cel * 51.0) * 0.15;
    float lane = smoothstep(0.07, 0.0, abs(bd + (dust - 0.5) * 0.08));
    col += vec3(0.016, 0.019, 0.03) * band * smoothstep(0.32, 0.8, dust) * (1.0 - lane * 0.8) * starFade;
    #endif
    vec3 sp = cel * STAR_GRID;
    vec3 cell = floor(sp);
    float h = hash13(cell);
    float threshold = STAR_THRESHOLD - band * 0.03;
    if (h > threshold) {
      float u = (h - threshold) / (1.0 - threshold);
      vec3 jitter = hash33(cell) - 0.5;
      float d = length(sp - cell - 0.5 - jitter * 0.36);
      // Intrinsic radius in grid cells; never smaller than about a pixel, and
      // dimmed by the area it was widened by, so stars neither vanish nor
      // shimmer in the low-res pixel style.
      float r0 = 0.08 + 0.1 * u;
      float r = max(r0, starPx * 0.65);
      float energy = (r0 * r0) / (r * r);
      // Scintillation is strongest low in the sky.
      float twAmp = mix(0.42, 0.15, smoothstep(0.05, 0.6, y));
      float twinkle = 1.0 - twAmp + twAmp * sin(uTime * (2.4 + 2.6 * jitter.x) + h * 91.0);
      float bright = (0.3 + 2.2 * u * u * u) * twinkle * energy;
      vec3 tint = mix(vec3(0.7, 0.8, 1.0), vec3(1.0, 0.85, 0.66), fract(h * 37.17));
      col += tint * smoothstep(r, r * 0.2, d) * bright * starFade;
    }
  }

  /* Sun: tight glare around a crisp, limb-darkened disc. */
  float mu = max(dot(dir, uSunDir), 0.0);
  col += uSunHalo * pow(mu, 2200.0) * 0.8 * above;
  float sunMask = smoothstep(SUN_COS_OUT, SUN_COS_IN, mu) * above * uSunVis;
  if (sunMask > 0.0) {
    // Added on top of the glow behind it, so the disc always reads as the
    // brightest thing in the sky, even sinking into a blazing horizon.
    float rr = clamp(acos(min(mu, 1.0)) / SUN_RADIUS, 0.0, 1.0);
    col += uSunDisc * (0.72 + 0.28 * sqrt(1.0 - rr * rr)) * sunMask;
  }

  /* Moon: soft halo, then a full disc with darker maria and limb darkening. */
  float mm = dot(dir, uMoonDir);
  float mmc = max(mm, 0.0);
  col += uMoonHalo * (pow(mmc, 500.0) * 0.45 + pow(mmc, 40.0) * 0.06) * above;
  float moonMask = smoothstep(MOON_COS_OUT, MOON_COS_IN, mm) * above * uMoonAlpha;
  if (moonMask > 0.0) {
    vec3 right = normalize(cross(vec3(0.0, 1.0, 0.0), uMoonDir));
    vec3 up = cross(uMoonDir, right);
    vec2 muv = vec2(dot(dir, right), dot(dir, up)) / MOON_RADIUS;
    float maria = vnoise(muv * 2.1 + 4.3) * 0.62 + vnoise(muv * 5.3 + 1.7) * 0.38;
    float limb = sqrt(max(1.0 - dot(muv, muv), 0.0));
    vec3 moon = uMoonDisc * mix(0.64, 1.0, smoothstep(0.36, 0.64, maria)) * (0.7 + 0.3 * limb);
    col = mix(col, moon, moonMask);
  }

  /* Clouds: a soft layer projected onto the dome. Density from the noise
     texture; light from how much cloud lies between each point and the key
     light (a few samples marched toward it across the layer). Every
     mip-mapped fetch stays outside data-dependent branches (implicit
     derivatives are undefined there); the y > 0 branch only diverges right at
     the horizon, where the clouds are already faded out. */
  #ifdef CLOUDS
  if (uCloudAmount > 0.001 && y > 0.0) {
    vec2 cp = dir.xz / (y + 0.1);
    float n = cloudField(cp);
    float density = smoothstep(uCloudCover, uCloudCover + CLOUD_SOFT, n);
    float fine = texture2D(uClouds, cp * 1.25 + uCloudOff.zw * 1.7).b;
    // High, thin cirrus streaks above everything else.
    float cirrus = texture2D(uClouds, vec2(cp.x * 0.05 + uCirrusOff, cp.y * 0.012)).a;
    cirrus = smoothstep(0.55, 0.9, cirrus) * 0.35;
    float horizonFade = smoothstep(0.0, 0.14, y);
    #ifdef CLOUD_SHADING
    vec2 toL = normalize(uLightDir.xz + vec2(1e-4)) * mix(0.9, 0.35, clamp(uLightDir.y, 0.0, 1.0));
    // A wider ramp for the light samples keeps the shading smooth inside
    // the cloud instead of mottled.
    float s1 = smoothstep(uCloudCover - 0.05, uCloudCover + 0.3, cloudField(cp + toL * 0.28));
    float s2 = smoothstep(uCloudCover - 0.05, uCloudCover + 0.3, cloudField(cp + toL * 0.7));
    float lit = exp(-(density * 0.5 + s1 * 1.0 + s2 * 0.8) * 1.5);
    #else
    float lit = clamp(1.1 - density * 0.75, 0.0, 1.0);
    #endif
    density *= 0.9 + 0.2 * fine;
    vec3 cloud = mix(uCloudDark, uCloudLit, lit);
    // Thin cloud near the sun glows (silver lining / forward scattering).
    float mu2 = mu * mu;
    float mu8 = mu2 * mu2;
    mu8 *= mu8;
    cloud += uSunHalo * (mu8 * 0.6 + pow(mu, 36.0) * 0.9) * (1.15 - density) * (0.4 + 0.6 * lit);
    // Moonlit edges at night.
    cloud += uMoonHalo * pow(mmc, 30.0) * 0.5 * (1.2 - density);
    // Far clouds dissolve into the horizon haze.
    cloud = mix(col, cloud, 0.45 + 0.55 * smoothstep(0.0, 0.3, y));
    col = mix(col, cloud, clamp(density, 0.0, 1.0) * horizonFade * uCloudAmount);
    vec3 cirrusCol = mix(uCloudLit, uCloudDark, 0.25) + uSunHalo * mu8 * 0.5;
    col = mix(col, cirrusCol, cirrus * (1.0 - density) * horizonFade * uCloudAmount);
  }
  #endif

  gl_FragColor = vec4(col, 1.0);
  #include <colorspace_fragment>
  // Static dither hides 8-bit banding in the slow night gradients. Static on
  // purpose: a moving pattern would flicker under the pixel style's
  // colour quantisation.
  gl_FragColor.rgb += (hash12(gl_FragCoord.xy) - 0.5) / 255.0;
}
`;

/* --- Temps (no per-frame allocation) --- */

const _liftA = new THREE.Vector3();
const _liftB = new THREE.Vector3();
const _basisM = new THREE.Matrix4();
const _axisX = new THREE.Vector3();
const _axisY = new THREE.Vector3();
const _axisZ = new THREE.Vector3();
const _origin = new THREE.Vector3();
const _snap = new THREE.Vector3();
const _rotM = new THREE.Matrix4();

const LABELS = [
  { until: 0.21, label: "night" },
  { until: 0.3, label: "dawn" },
  { until: 0.45, label: "morning" },
  { until: 0.57, label: "midday" },
  { until: 0.7, label: "afternoon" },
  { until: 0.81, label: "dusk" },
  { until: 1.01, label: "night" },
];

/* --- Sky --- */

export class Sky {
  /**
   * @param {THREE.Scene} scene
   * @param {object} [opts]
   * @param {number} [opts.startPhase]     day phase to start at (0 midnight .. 0.5 noon)
   * @param {number} [opts.dayLengthSec]   real seconds per in-game day
   * @param {number} [opts.viewDistance]   metres; fog far ≈ this at midday
   * @param {boolean} [opts.shadows]       sun/moon casts shadows
   * @param {number} [opts.shadowMapSize]  shadow map resolution
   * @param {"high"|"low"} [opts.detail]   sky shader detail; defaults to "high" when shadows are on
   * @param {boolean} [opts.clouds]        draw the cloud layer (default true)
   */
  constructor(scene, {
    startPhase = TIME.startPhase,
    dayLengthSec = TIME.dayLengthSec,
    viewDistance = 520,
    shadows = false,
    shadowMapSize = 2048,
    detail = shadows ? "high" : "low",
    clouds = true,
  } = {}) {
    this.scene = scene;
    this.phase = ((startPhase % 1) + 1) % 1;
    this.day = 1;
    this.paused = false;
    this.dayLengthSec = dayLengthSec;
    /** Metres. Can be changed at runtime; fog follows on the next update. */
    this.viewDistance = viewDistance;
    /** Optional hook, called with the new day number when midnight passes. */
    this.onNewDay = null;

    /** Unit vector toward the sun (below the horizon at night). */
    this.sunDirection = new THREE.Vector3();
    /** Unit vector toward the moon. */
    this.moonDirection = new THREE.Vector3();
    /** Unit vector toward whatever drives the key light (sun or moon, lifted above the horizon). */
    this.lightDirection = new THREE.Vector3(0, 1, 0);
    /** Colour of the sun itself (golden low, warm white high). */
    this.sunColor = new THREE.Color();
    /** Moonlight tint. */
    this.moonColor = MOON_LIGHT.clone();
    /** Zenith colour of the sky. */
    this.skyColor = new THREE.Color();
    /** Horizon colour — identical to scene.fog.color. */
    this.fogColor = new THREE.Color();
    /** 0 (night) .. 1 (full day). */
    this.daylight = 0;
    /** 0..1 how much of the moon is above the horizon. */
    this.moonlight = 0;

    this._key = makeKeyState();
    this._time = 0; // cosmetic clock for twinkle / cloud drift (runs while paused)
    this._focus = new THREE.Vector3();
    this._hasFocus = false;
    this._fogScale = 1;

    /* Lights */
    this.sunLight = new THREE.DirectionalLight(0xffffff, 1);
    this.sunLight.name = "sky-key-light";
    this.shadowMapSize = shadowMapSize;
    // Always configure the shadow camera, so shadows can be switched on later
    // (quality change) just by setting castShadow.
    this._setupShadows(shadowMapSize);
    this.sunLight.castShadow = !!shadows;
    this.hemiLight = new THREE.HemisphereLight(0xffffff, 0x444444, 1);
    this.hemiLight.name = "sky-hemi-light";
    scene.add(this.sunLight, this.sunLight.target, this.hemiLight);

    /* Fog */
    this.fog = new THREE.Fog(0x000000, 10, viewDistance);
    scene.fog = this.fog;
    // Only clear to our colour if nobody else claimed the background; it is
    // what shows for the split second before the dome draws (or if it can't).
    this._background = null;
    if (!scene.background) {
      this._background = new THREE.Color();
      scene.background = this._background;
    }

    /* Dome */
    const high = detail !== "low";
    this._cloudTexture = clouds ? makeCloudTexture() : null;
    this._cloudOff = new THREE.Vector4(0.37, 0.12, 0.61, 0.83);
    this._cirrusOff = 0.21;
    /** Dome uniforms — water.js mirrors the SKY_COLOR_GLSL ones every frame. */
    this.uniforms = {
      uZenith: { value: new THREE.Color() },
      uHorizon: { value: new THREE.Color() },
      uGlow: { value: new THREE.Color() },
      uGlowAmt: { value: 0 },
      uBelt: { value: new THREE.Color() },
      uSunDir: { value: new THREE.Vector3() },
      uSunHalo: { value: new THREE.Color() },
      uSunDisc: { value: new THREE.Color() },
      uSunVis: { value: 0 },
      uMoonDir: { value: new THREE.Vector3() },
      uMoonDisc: { value: MOON_DISC.clone() },
      uMoonAlpha: { value: 0 },
      uMoonHalo: { value: new THREE.Color() },
      uStars: { value: 0 },
      uCelestial: { value: new THREE.Matrix3() },
      uTime: { value: 0 },
      uLightDir: { value: new THREE.Vector3(0, 1, 0) },
      uClouds: { value: this._cloudTexture },
      uCloudOff: { value: this._cloudOff },
      uCirrusOff: { value: this._cirrusOff },
      uCloudCover: { value: 0.5 },
      uCloudAmount: { value: clouds ? 1 : 0 },
      uCloudLit: { value: new THREE.Color() },
      uCloudDark: { value: new THREE.Color() },
    };
    const defines = {};
    if (clouds) defines.CLOUDS = "";
    if (high) {
      defines.CLOUD_SHADING = "";
      defines.MILKY_WAY = "";
    }
    const material = new THREE.ShaderMaterial({
      name: "SkyDome",
      uniforms: this.uniforms,
      vertexShader: DOME_VERTEX,
      fragmentShader: DOME_FRAGMENT,
      defines,
      side: THREE.BackSide,
      depthWrite: false,
      depthTest: false,
      fog: false,
      toneMapped: false, // the horizon must equal the (un-tonemapped) fog colour exactly
    });
    this.dome = new THREE.Mesh(new THREE.SphereGeometry(DOME_RADIUS, 48, 24), material);
    this.dome.name = "sky-dome";
    this.dome.renderOrder = -1;
    this.dome.frustumCulled = false;
    this.dome.matrixAutoUpdate = false;
    this.dome.raycast = () => {}; // never a hit for camera/ground probes
    scene.add(this.dome);

    this._apply();
  }

  /* --- Public API --- */

  /**
   * Advance time and keep everything attached to the player.
   * @param {number} dt seconds
   * @param {{x:number,y:number,z:number}} [focus] point the shadow box centres on (player)
   * @param {THREE.Camera} [camera] the dome is re-centred on it; its altitude thins the fog
   */
  update(dt, focus, camera) {
    this._time = (this._time + dt) % 28800;
    if (!this.paused && this.dayLengthSec > 0) {
      this.phase += dt / this.dayLengthSec;
      while (this.phase >= 1) {
        this.phase -= 1;
        this.day += 1;
        if (this.onNewDay) this.onNewDay(this.day);
      }
    }

    // Clouds drift and slowly thicken / clear (weather, not clock — runs while
    // paused). Offsets wrap at one texture tile, which is seamless.
    const u = this.uniforms;
    u.uTime.value = this._time;
    const o = this._cloudOff;
    o.x = (o.x + dt * 0.0011) % 1;
    o.y = (o.y + dt * 0.00045) % 1;
    o.z = (o.z + dt * 0.0029) % 1;
    o.w = (o.w + dt * 0.0012) % 1;
    this._cirrusOff = (this._cirrusOff + dt * 0.0004) % 1;
    u.uCirrusOff.value = this._cirrusOff;
    u.uCloudCover.value = 0.5 + 0.05 * Math.sin(this._time * 0.0019 + 1.3) + 0.025 * Math.sin(this._time * 0.0053);

    if (camera) {
      const r = FOG_ALTITUDE_RANGE;
      this._fogScale = 1 + FOG_ALTITUDE_BOOST * smoothstep(r[0], r[1], camera.position.y);
    }

    this._apply();

    if (focus) {
      this._focus.set(focus.x, focus.y, focus.z);
      this._hasFocus = true;
    } else if (camera && !this._hasFocus) {
      this._focus.copy(camera.position);
    }
    this._placeLight(this._focus);

    if (camera) {
      this.dome.position.copy(camera.position);
      this.dome.updateMatrix();
      this.dome.updateMatrixWorld();
    }
  }

  /**
   * Jump to a time of day (0..1, wraps). Lighting updates immediately.
   * @param {number} p
   */
  setPhase(p) {
    this.phase = ((p % 1) + 1) % 1;
    this._apply();
    this._placeLight(this._focus);
  }

  /** True while it is dark enough to count as night (daylight < 0.25). */
  isNight() {
    return this.daylight < 0.25;
  }

  /** @returns {"dawn"|"morning"|"midday"|"afternoon"|"dusk"|"night"} */
  timeLabel() {
    for (const l of LABELS) if (this.phase < l.until) return l.label;
    return "night";
  }

  /** In-game 24 h clock, e.g. "06:30". */
  clockString() {
    const mins = Math.floor(this.phase * 1440) % 1440;
    const h = Math.floor(mins / 60);
    const m = mins % 60;
    return `${h < 10 ? "0" : ""}${h}:${m < 10 ? "0" : ""}${m}`;
  }

  /** Remove lights, dome and fog from the scene and free GPU resources. */
  dispose() {
    const s = this.scene;
    s.remove(this.sunLight, this.sunLight.target, this.hemiLight, this.dome);
    if (s.fog === this.fog) s.fog = null;
    if (this._background && s.background === this._background) s.background = null;
    this.sunLight.dispose();
    this.hemiLight.dispose();
    this.dome.geometry.dispose();
    this.dome.material.dispose();
    if (this._cloudTexture) this._cloudTexture.dispose();
  }

  /* --- Internals --- */

  _setupShadows(size) {
    const sh = this.sunLight.shadow;
    sh.mapSize.set(size, size);
    const cam = sh.camera;
    cam.left = -SHADOW_HALF;
    cam.right = SHADOW_HALF;
    cam.top = SHADOW_HALF;
    cam.bottom = -SHADOW_HALF;
    cam.near = 1;
    cam.far = SHADOW_DEPTH;
    // The key light passes overhead during the sun→moon hand-off; a +Z up
    // vector can never be parallel to it (|z| ≤ 0.65 while lifted y ≥ 0.12),
    // so the shadow camera never flips.
    cam.up.set(0, 0, 1);
    cam.updateProjectionMatrix();
    // Smooth terrain and knee-high juveniles: one 2048² texel is ≈ 6 cm. A
    // tiny depth bias (≈ 7 cm over the 360 m range) plus a normal offset of
    // about one texel kills acne on gentle slopes without detaching small feet
    // from their shadows (no peter-panning).
    sh.bias = -0.0002;
    sh.normalBias = 0.05 * (2048 / size);
  }

  /** Recompute colours, lights, fog and dome uniforms for the current phase. */
  _apply() {
    const K = sampleKeys(this.phase, this._key);
    const sun = sunDirAt(this.phase, this.sunDirection);
    const moon = moonDirAt(this.phase, this.moonDirection);
    const sunY = sun.y;
    const moonY = moon.y;

    this.daylight = smoothstep(-0.18, 0.3, sunY);
    this.moonlight = smoothstep(-0.04, 0.12, moonY);
    this.skyColor.copy(K.zenith);
    this.fogColor.copy(K.horizon);
    sampleSunColor(sunY, this.sunColor);

    /* Key light: sun by day, moon by night. Around the horizon crossing both
       are faint; the direction sweeps evenly between the two lifted
       directions (over the top, across ~35 real seconds at the default day
       length) while the intensity dips, so nothing ever pops. */
    const sunI = sampleCurve(SUN_INTENSITY, sunY);
    const moonI = sampleCurve(MOON_INTENSITY, moonY);
    const w = smoothstep(-0.12, 0.08, sunY);
    liftDir(sun, _liftA);
    liftDir(moon, _liftB);
    slerpDir(_liftB, _liftA, w, this.lightDirection);
    this.sunLight.intensity = lerp(moonI, sunI, w);
    this.sunLight.color.lerpColors(MOON_LIGHT, this.sunColor, w);
    // Moon shadows are softer; low sun shadows fade a little into the haze;
    // and shadows vanish entirely while the key direction swings overhead
    // during the hand-off, so they never visibly sweep across the ground.
    const swing = 4 * w * (1 - w);
    this.sunLight.shadow.intensity =
      lerp(0.6, 0.92, w) *
      lerp(0.75, 1, smoothstep(0.02, 0.2, Math.max(sunY, moonY))) *
      (1 - smoothstep(0.25, 0.85, swing));

    this.hemiLight.color.copy(K.hemiSky);
    this.hemiLight.groundColor.copy(K.hemiGround);
    this.hemiLight.intensity = K.hemi;

    /* Fog */
    const vd = this.viewDistance * this._fogScale;
    this.fog.color.copy(K.horizon);
    this.fog.near = K.near * vd;
    this.fog.far = Math.max(this.fog.near + 1, K.far * vd);
    if (this._background) this._background.copy(K.horizon);

    /* Dome uniforms */
    const u = this.uniforms;
    u.uZenith.value.copy(K.zenith);
    u.uHorizon.value.copy(K.horizon);
    u.uGlow.value.copy(K.glow);
    u.uGlowAmt.value = K.glowAmt;
    u.uBelt.value.copy(BELT_COLOR).multiplyScalar(K.glowAmt * 0.22 * (1 - smoothstep(0.05, 0.25, Math.abs(sunY))));
    u.uSunDir.value.copy(sun);
    const sunVis = smoothstep(-0.22, 0.03, sunY);
    u.uSunHalo.value.copy(this.sunColor).multiplyScalar(sunVis);
    u.uSunVis.value = smoothstep(-0.05, 0.0, sunY);
    // Disc (added over the glow; values > 1 clip): a strong tint with little
    // white reads as a deep gold sun on the horizon, a hot white one high up.
    const hot = smoothstep(0.0, 0.35, sunY);
    u.uSunDisc.value.copy(this.sunColor).multiplyScalar(lerp(0.75, 2.4, hot));
    u.uSunDisc.value.r += 0.4 * hot;
    u.uSunDisc.value.g += 0.4 * hot;
    u.uSunDisc.value.b += 0.4 * hot;
    u.uMoonDir.value.copy(moon);
    // A pale, translucent day moon; a solid bright disc at night.
    u.uMoonAlpha.value = this.moonlight * lerp(1, 0.35, this.daylight);
    u.uMoonHalo.value.copy(MOON_HALO).multiplyScalar(this.moonlight * (1 - this.daylight));
    u.uStars.value = 1 - smoothstep(0.0, 0.28, this.daylight);
    _rotM.makeRotationAxis(CELESTIAL_AXIS, -(this.phase - 0.25) * TAU);
    u.uCelestial.value.setFromMatrix4(_rotM);
    u.uLightDir.value.copy(this.lightDirection);
    u.uCloudLit.value.copy(K.cloudLit);
    u.uCloudDark.value.copy(K.cloudDark);
  }

  /**
   * Put the key light (and its shadow box) over `focus`. The box centre is
   * snapped to whole shadow-map texels in light space, so as the player walks
   * the shadow texels stay put instead of crawling and shimmering.
   */
  _placeLight(focus) {
    const light = this.sunLight;
    const dir = this.lightDirection;
    _snap.copy(focus);
    if (light.castShadow) {
      _basisM.lookAt(dir, _origin, light.shadow.camera.up);
      _basisM.extractBasis(_axisX, _axisY, _axisZ);
      const texel = (2 * SHADOW_HALF) / light.shadow.mapSize.x;
      const fx = focus.dot(_axisX);
      const fy = focus.dot(_axisY);
      _snap.addScaledVector(_axisX, Math.round(fx / texel) * texel - fx);
      _snap.addScaledVector(_axisY, Math.round(fy / texel) * texel - fy);
    }
    light.target.position.copy(_snap);
    light.position.copy(_snap).addScaledVector(dir, SHADOW_DISTANCE);
    light.target.updateMatrixWorld();
    light.updateMatrixWorld();
  }
}
