// Sky, sun & moon light, fog and the day/night cycle.
//
// One Sky owns everything that depends on the time of day:
//   - a camera-following sky dome (one ShaderMaterial: gradient, horizon glow,
//     sun disc + halo, moon, twinkling stars, Milky Way, drifting clouds),
//   - the key DirectionalLight (the sun by day, a cool dim moon by night),
//   - a HemisphereLight for ambient fill,
//   - scene.fog, whose colour IS the dome's horizon so distant land melts into
//     the sky.
// Everything is driven by a single day phase: 0 midnight, 0.25 sunrise,
// 0.5 noon, 0.75 sunset.

import * as THREE from "three";
import { TIME } from "../config.js";
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
const SUN_RADIUS = 0.03; // radians — a touch larger than life, it reads better
const MOON_RADIUS = 0.036;

/* --- Lighting constants (r180 physical units, tuned for ACES @ exposure 1) --- */

// Key light intensity by elevation (sine of altitude). The low sun stays
// strong enough for a proper golden hour instead of fading out with the sky.
const SUN_INTENSITY = [[-0.04, 0], [0.0, 0.35], [0.05, 1.0], [0.12, 1.65], [0.25, 2.3], [0.45, 2.75], [0.85, 2.95]];
const MOON_INTENSITY = [[-0.05, 0], [0.0, 0.12], [0.1, 0.5], [0.3, 0.85], [0.7, 0.95]];
const MOON_LIGHT = new THREE.Color("#9db3e2"); // cool blue moonlight
const MOON_DISC = new THREE.Color("#eef2fa");
const MOON_HALO = new THREE.Color("#7f95c4");
const BELT_COLOR = new THREE.Color("#b58aa5"); // pink anti-twilight band ("Belt of Venus")

// Lights never shine from below the horizon: near the crossing the key
// direction is lifted to at least this elevation (sine), which also lets the
// sun→moon hand-off swing smoothly overhead instead of through the ground.
const LIGHT_MIN_Y = 0.12;

/* --- Shadows --- */

const SHADOW_HALF = 60; // metres: the ortho shadow box is ±60 m around the focus
const SHADOW_DISTANCE = 160; // light sits this far from the focus along the light dir
const SHADOW_DEPTH = 340; // near..far range of the shadow camera

/* --- Palette keyframes --- */

// Authored in sRGB hex (picked by eye) and converted to linear once at load.
// `horizon` doubles as the fog colour. `near`/`far` are fog distances as a
// fraction of viewDistance. `glow` is the warm band hugging the horizon around
// the sun; `hemi*` drive the HemisphereLight; `cloud*` shade the clouds.
const RAW_KEYS = [
  { p: 0.0, zenith: "#04070f", horizon: "#121c30", glow: "#1b2540", glowAmt: 0, hemiSky: "#3a4f78", hemiGround: "#10141c", hemi: 1.5, cloudLit: "#161d2e", cloudDark: "#06080f", near: 0.04, far: 0.72 },
  { p: 0.17, zenith: "#050812", horizon: "#141e33", glow: "#1d2744", glowAmt: 0, hemiSky: "#3a4f78", hemiGround: "#10141c", hemi: 1.45, cloudLit: "#171e2f", cloudDark: "#070910", near: 0.04, far: 0.7 },
  { p: 0.21, zenith: "#0c1328", horizon: "#2a2c48", glow: "#6a4a6a", glowAmt: 0.35, hemiSky: "#424e74", hemiGround: "#141419", hemi: 1.3, cloudLit: "#34344f", cloudDark: "#10131f", near: 0.02, far: 0.6 },
  { p: 0.235, zenith: "#1f2c55", horizon: "#806a7c", glow: "#d98a78", glowAmt: 0.7, hemiSky: "#6c6e8c", hemiGround: "#2a2420", hemi: 1.05, cloudLit: "#b48092", cloudDark: "#3c3a55", near: 0.0, far: 0.46 },
  { p: 0.255, zenith: "#3d5a8e", horizon: "#d6a289", glow: "#ffa060", glowAmt: 1.0, hemiSky: "#b0a4a8", hemiGround: "#4a3a2c", hemi: 1.15, cloudLit: "#ffc29a", cloudDark: "#6a5a70", near: 0.0, far: 0.42 },
  { p: 0.285, zenith: "#5884bb", horizon: "#e8c9a6", glow: "#ffc68a", glowAmt: 0.6, hemiSky: "#c4c8cc", hemiGround: "#5a4a36", hemi: 1.3, cloudLit: "#fff0dc", cloudDark: "#8e8e9e", near: 0.02, far: 0.52 },
  { p: 0.34, zenith: "#5791cb", horizon: "#cfd9d6", glow: "#ffe6c0", glowAmt: 0.2, hemiSky: "#b6cce0", hemiGround: "#5c5440", hemi: 1.45, cloudLit: "#ffffff", cloudDark: "#a3b0c2", near: 0.07, far: 0.78 },
  { p: 0.42, zenith: "#4c88c8", horizon: "#c2d4de", glow: "#fff2d8", glowAmt: 0.06, hemiSky: "#b0c8e2", hemiGround: "#5e5844", hemi: 1.55, cloudLit: "#ffffff", cloudDark: "#a8b6c8", near: 0.12, far: 0.95 },
  { p: 0.5, zenith: "#4a86c7", horizon: "#c0d3de", glow: "#fff4e0", glowAmt: 0.04, hemiSky: "#b0c8e2", hemiGround: "#605a46", hemi: 1.55, cloudLit: "#ffffff", cloudDark: "#a8b6c8", near: 0.13, far: 1.0 },
  { p: 0.6, zenith: "#4c86c4", horizon: "#c6d5da", glow: "#fff0d4", glowAmt: 0.06, hemiSky: "#b4c8de", hemiGround: "#625a44", hemi: 1.55, cloudLit: "#ffffff", cloudDark: "#aab4c4", near: 0.12, far: 0.95 },
  { p: 0.68, zenith: "#5279ad", horizon: "#dcd0b4", glow: "#ffcc8a", glowAmt: 0.3, hemiSky: "#c4c4c4", hemiGround: "#62523c", hemi: 1.4, cloudLit: "#fff0d6", cloudDark: "#9c98a4", near: 0.1, far: 0.88 },
  { p: 0.725, zenith: "#3e5688", horizon: "#e4ae84", glow: "#ffa058", glowAmt: 0.75, hemiSky: "#c0a8a0", hemiGround: "#523e2e", hemi: 1.2, cloudLit: "#ffb27a", cloudDark: "#6c5a6c", near: 0.06, far: 0.76 },
  { p: 0.75, zenith: "#2a3868", horizon: "#c97e66", glow: "#ff7440", glowAmt: 1.0, hemiSky: "#9a8094", hemiGround: "#3a2c28", hemi: 1.1, cloudLit: "#ff9a6a", cloudDark: "#4e3e58", near: 0.04, far: 0.7 },
  { p: 0.77, zenith: "#18214a", horizon: "#6e4c62", glow: "#d0566a", glowAmt: 0.6, hemiSky: "#605c80", hemiGround: "#1e1a1e", hemi: 1.0, cloudLit: "#8a5068", cloudDark: "#2a2438", near: 0.04, far: 0.68 },
  { p: 0.795, zenith: "#0c1330", horizon: "#2a3050", glow: "#5a3e62", glowAmt: 0.25, hemiSky: "#425078", hemiGround: "#12141a", hemi: 1.35, cloudLit: "#30324e", cloudDark: "#10131f", near: 0.04, far: 0.68 },
  { p: 0.84, zenith: "#060a16", horizon: "#141e33", glow: "#1d2744", glowAmt: 0, hemiSky: "#3a4f78", hemiGround: "#10141c", hemi: 1.5, cloudLit: "#171e2f", cloudDark: "#070910", near: 0.04, far: 0.72 },
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
uniform vec3 uZenith;
uniform vec3 uHorizon;
uniform vec3 uGlow;
uniform float uGlowAmt;
uniform vec3 uBelt;
uniform vec3 uSunDir;
uniform vec3 uSunDisc;
uniform vec3 uSunHalo;
uniform vec3 uMoonDir;
uniform vec3 uMoonDisc;
uniform float uMoonAlpha;
uniform vec3 uMoonHalo;
uniform float uStars;
uniform mat3 uCelestial;
uniform float uTime;
uniform vec3 uLightDir;
uniform vec2 uCloudOffset;
uniform float uCloudCover;
uniform float uCloudAmount;
uniform vec3 uCloudLit;
uniform vec3 uCloudDark;

varying vec3 vDir;

const float SUN_COS_OUT = ${Math.cos(SUN_RADIUS * 1.12).toFixed(7)};
const float SUN_COS_IN = ${Math.cos(SUN_RADIUS * 0.88).toFixed(7)};
const float MOON_COS_OUT = ${Math.cos(MOON_RADIUS * 1.06).toFixed(7)};
const float MOON_COS_IN = ${Math.cos(MOON_RADIUS * 0.94).toFixed(7)};
const float MOON_RADIUS = ${MOON_RADIUS.toFixed(4)};
const float STAR_GRID = 150.0;
const float STAR_THRESHOLD = 0.955;

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

#if CLOUD_OCTAVES > 0
float fbm(vec2 p) {
  float sum = 0.0;
  float amp = 0.5;
  for (int i = 0; i < CLOUD_OCTAVES; i++) {
    sum += amp * vnoise(p);
    p = p * 2.07 + vec2(17.3, 9.1);
    amp *= 0.5;
  }
  return sum;
}
#endif

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

void main() {
  vec3 dir = normalize(vDir);
  float y = dir.y;
  float yc = max(y, 0.0);
  // Everything celestial sinks behind the horizon over a couple of degrees.
  float aboveHorizon = smoothstep(-0.02, 0.015, y);

  /* Base gradient: a hazy band at the horizon (= fog colour) up to the zenith. */
  vec3 col = mix(uHorizon, uZenith, 1.0 - exp(-yc * 3.4));

  /* Sunrise / sunset glow hugging the horizon around the sun's azimuth, and
     the faint pink band on the opposite side. */
  float sunFlat = length(uSunDir.xz);
  float az = sunFlat > 1e-4 ? dot(normalize(dir.xz + vec2(1e-5)), uSunDir.xz / sunFlat) : 0.0;
  float hug = exp(-yc * 5.5) * smoothstep(-0.05, 0.02, y);
  float glow = pow(az * 0.5 + 0.5, 3.0) * hug * uGlowAmt;
  col = mix(col, uGlow, clamp(glow, 0.0, 1.0));
  col += uBelt * pow(0.5 - az * 0.5, 2.0) * exp(-abs(y - 0.07) * 13.0);

  /* Stars + Milky Way, in a frame that turns with the sun. */
  vec3 cel = uCelestial * dir;
  if (uStars > 0.003) {
    float starFade = uStars * smoothstep(0.0, 0.22, y);
    float band = 0.0;
    #ifdef MILKY_WAY
    float bd = dot(cel, normalize(vec3(0.38, 0.22, 0.9)));
    band = exp(-bd * bd * 20.0);
    float dust = vnoise3(cel * 4.5) * 0.6 + vnoise3(cel * 11.0) * 0.4;
    float lane = smoothstep(0.08, 0.0, abs(bd + (dust - 0.5) * 0.12));
    col += vec3(0.05, 0.06, 0.095) * band * smoothstep(0.3, 0.85, dust) * (1.0 - lane * 0.85) * starFade;
    #endif
    vec3 sp = cel * STAR_GRID;
    vec3 cell = floor(sp);
    float h = hash13(cell);
    float threshold = STAR_THRESHOLD - band * 0.035;
    if (h > threshold) {
      float u = (h - threshold) / (1.0 - threshold);
      vec3 jitter = hash33(cell) - 0.5;
      float d = length(sp - cell - 0.5 - jitter * 0.46);
      float radius = 0.13 + 0.14 * u;
      float twinkle = 0.62 + 0.38 * sin(uTime * (1.1 + 2.6 * jitter.x + 1.3) + h * 91.0);
      float bright = (0.25 + 1.6 * u * u * u) * twinkle;
      vec3 tint = mix(vec3(0.72, 0.82, 1.0), vec3(1.0, 0.86, 0.68), fract(h * 37.17));
      col += tint * smoothstep(radius, radius * 0.25, d) * bright * starFade;
    }
  }

  /* Sun: wide warm halo, tight glare and a crisp disc. */
  float mu = max(dot(dir, uSunDir), 0.0);
  float mu2 = mu * mu;
  float mu8 = mu2 * mu2;
  mu8 *= mu8;
  col += uSunHalo * (mu8 * 0.16 + pow(mu, 90.0) * 0.4 + pow(mu, 2200.0) * 0.7) * smoothstep(-0.12, 0.02, y);
  col = mix(col, uSunDisc, smoothstep(SUN_COS_OUT, SUN_COS_IN, mu) * aboveHorizon);

  /* Moon: soft halo, then a full disc with darker maria and limb darkening. */
  float mm = dot(dir, uMoonDir);
  col += uMoonHalo * (pow(max(mm, 0.0), 500.0) * 0.5 + pow(max(mm, 0.0), 40.0) * 0.07) * aboveHorizon;
  float moonMask = smoothstep(MOON_COS_OUT, MOON_COS_IN, mm) * aboveHorizon * uMoonAlpha;
  if (moonMask > 0.0) {
    vec3 right = normalize(cross(vec3(0.0, 1.0, 0.0), uMoonDir));
    vec3 up = cross(uMoonDir, right);
    vec2 muv = vec2(dot(dir, right), dot(dir, up)) / MOON_RADIUS;
    float maria = vnoise(muv * 2.1 + 4.3) * 0.65 + vnoise(muv * 5.3 + 1.7) * 0.35;
    float limb = sqrt(max(1.0 - dot(muv, muv), 0.0));
    vec3 moon = uMoonDisc * mix(0.66, 1.0, smoothstep(0.38, 0.62, maria)) * (0.72 + 0.28 * limb);
    col = mix(col, moon, moonMask);
  }

  /* Clouds: a planar fBm layer projected onto the dome, lit from the key
     light by comparing density with a sample nudged toward it. */
  #if CLOUD_OCTAVES > 0
  if (uCloudAmount > 0.001 && y > 0.0) {
    vec2 cp = dir.xz / (y + 0.14) * 1.9 + uCloudOffset;
    float n = fbm(cp);
    float cover = smoothstep(uCloudCover, uCloudCover + 0.22, n);
    if (cover > 0.001) {
      #ifdef CLOUD_SHADING
      vec2 toLight = normalize(uLightDir.xz + vec2(1e-4)) * (0.2 + 0.25 * (1.0 - abs(uLightDir.y)));
      float n2 = fbm(cp + toLight);
      float lit = clamp(0.6 + (n - n2) * 3.2 - (cover - 0.5) * 0.25, 0.0, 1.0);
      #else
      float lit = clamp(1.15 - cover * 0.7, 0.0, 1.0);
      #endif
      vec3 cloud = mix(uCloudDark, uCloudLit, lit);
      // Thin cloud near the sun lights up (silver lining).
      cloud += uSunHalo * (mu8 * 0.5 + pow(mu, 40.0) * 0.6) * (1.2 - cover);
      // Far clouds dissolve into the horizon haze.
      cloud = mix(uHorizon, cloud, 0.35 + 0.65 * smoothstep(0.0, 0.3, y));
      col = mix(col, cloud, cover * smoothstep(0.0, 0.12, y) * uCloudAmount);
    }
  }
  #endif

  /* Below the horizon the dome is pure fog, matching fully fogged land/sea. */
  col = mix(uHorizon, col, smoothstep(-0.03, 0.0, y));

  gl_FragColor = vec4(col, 1.0);
  #include <colorspace_fragment>
  // Dither: hides 8-bit banding in the slow night gradients.
  gl_FragColor.rgb += (hash12(gl_FragCoord.xy + fract(uTime) * 61.0) - 0.5) / 255.0;
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

    /* Lights */
    this.sunLight = new THREE.DirectionalLight(0xffffff, 1);
    this.sunLight.name = "sky-key-light";
    this.sunLight.castShadow = !!shadows;
    this.shadowMapSize = shadowMapSize;
    if (shadows) this._setupShadows(shadowMapSize);
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
    this.uniforms = {
      uZenith: { value: new THREE.Color() },
      uHorizon: { value: new THREE.Color() },
      uGlow: { value: new THREE.Color() },
      uGlowAmt: { value: 0 },
      uBelt: { value: new THREE.Color() },
      uSunDir: { value: new THREE.Vector3() },
      uSunDisc: { value: new THREE.Color() },
      uSunHalo: { value: new THREE.Color() },
      uMoonDir: { value: new THREE.Vector3() },
      uMoonDisc: { value: MOON_DISC.clone() },
      uMoonAlpha: { value: 0 },
      uMoonHalo: { value: new THREE.Color() },
      uStars: { value: 0 },
      uCelestial: { value: new THREE.Matrix3() },
      uTime: { value: 0 },
      uLightDir: { value: new THREE.Vector3(0, 1, 0) },
      uCloudOffset: { value: new THREE.Vector2(37.2, 11.8) },
      uCloudCover: { value: 0.5 },
      uCloudAmount: { value: clouds ? 1 : 0 },
      uCloudLit: { value: new THREE.Color() },
      uCloudDark: { value: new THREE.Color() },
    };
    const defines = { CLOUD_OCTAVES: clouds ? (high ? 5 : 3) : 0 };
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
    this.dome = new THREE.Mesh(new THREE.SphereGeometry(DOME_RADIUS, 32, 16), material);
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
   * @param {THREE.Camera} [camera] the dome is re-centred on it
   */
  update(dt, focus, camera) {
    this._time = (this._time + dt) % 28800;
    if (!this.paused && this.dayLengthSec > 0) {
      this.phase += dt / this.dayLengthSec;
      while (this.phase >= 1) {
        this.phase -= 1;
        this.day += 1;
      }
    }

    // Clouds drift and slowly thicken / clear (weather, not clock — runs while paused).
    const u = this.uniforms;
    u.uTime.value = this._time;
    u.uCloudOffset.value.x = (u.uCloudOffset.value.x + dt * 0.0042) % 1000;
    u.uCloudOffset.value.y = (u.uCloudOffset.value.y + dt * 0.0017) % 1000;
    u.uCloudCover.value = 0.48 + 0.06 * Math.sin(this._time * 0.0021 + 1.3) + 0.03 * Math.sin(this._time * 0.0057);

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
    // 5 m flat-shaded terrain cells and knee-high juveniles: a small depth
    // bias (≈ 0.07 m over the 340 m range) plus a normal offset about one
    // shadow texel wide kills acne on slopes without detaching small feet.
    sh.bias = -0.0002;
    sh.normalBias = 0.045;
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
       are faint; the direction blends between the two lifted directions
       (swinging overhead) while the intensity dips, so nothing ever pops. */
    const sunI = sampleCurve(SUN_INTENSITY, sunY);
    const moonI = sampleCurve(MOON_INTENSITY, moonY);
    const w = smoothstep(-0.09, 0.05, sunY);
    liftDir(sun, _liftA);
    liftDir(moon, _liftB);
    this.lightDirection.lerpVectors(_liftB, _liftA, w).normalize();
    this.sunLight.intensity = lerp(moonI, sunI, w);
    this.sunLight.color.lerpColors(MOON_LIGHT, this.sunColor, w);
    // Moon shadows are softer; low sun shadows fade a little into the haze.
    this.sunLight.shadow.intensity = lerp(0.6, 0.92, w) * lerp(0.75, 1, smoothstep(0.02, 0.2, Math.max(sunY, moonY)));

    this.hemiLight.color.copy(K.hemiSky);
    this.hemiLight.groundColor.copy(K.hemiGround);
    this.hemiLight.intensity = K.hemi;

    /* Fog */
    this.fog.color.copy(K.horizon);
    this.fog.near = K.near * this.viewDistance;
    this.fog.far = Math.max(this.fog.near + 1, K.far * this.viewDistance);
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
    // Disc: values > 1 clip, so a strong tint plus a little white reads as a
    // hot pale-gold core at the horizon and plain white high in the sky.
    const high = smoothstep(0.0, 0.3, sunY);
    u.uSunDisc.value.copy(this.sunColor).multiplyScalar(lerp(1.6, 2.4, high));
    u.uSunDisc.value.r += lerp(0.1, 0.3, high);
    u.uSunDisc.value.g += lerp(0.1, 0.3, high);
    u.uSunDisc.value.b += lerp(0.1, 0.3, high);
    u.uMoonDir.value.copy(moon);
    // A pale, translucent day moon; a solid bright disc at night.
    u.uMoonAlpha.value = this.moonlight * lerp(1, 0.4, this.daylight);
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
