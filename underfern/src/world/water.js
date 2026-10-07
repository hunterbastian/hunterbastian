// Water: one plane at sea level covering the island tile three times over, so
// every lake, river and the open ocean share a single draw call.
//
// The fragment shader reads the terrain heightfield to know how deep the water
// is at each point: shallow water is clear (the lakebed shows through, with
// dancing caustics), deep water turns blue-teal, lakes and rivers are murkier
// and greener than the sea, and foam laps at every shoreline. Ripples come
// from a procedural, mip-mapped slope texture generated once at load and
// scrolled at two scales, plus gentle analytic swells on open water. The
// texture also stores the slopes' second moment, so as ripples shrink below a
// pixel (distance, or the low-res pixel style) their variance turns into a
// rougher, broader sun glint instead of aliasing — which is exactly what draws
// the long glitter path of a low sun. Fresnel reflects the sky with the same
// colour model as the dome, and far water fades into the sky's own horizon
// haze (sun glow included), so the sea meets the sky without a seam.

import * as THREE from "three";
import { makeRng } from "../core/rng.js";
import { TAU, clamp, lerp, smoothstep } from "../core/math.js";
import { SKY_COLOR_GLSL } from "./sky.js";

/* --- Tuning --- */

const PLANE_SCALE = 3; // plane edge = 3 × terrain size, so the horizon is always ocean
const OPEN_OCEAN_DEPTH = 40; // metres assumed beyond the terrain tile

// Ripple layers: world tile size (m), strength (max slope), drift (m/s).
const RIPPLE_1 = { tile: 23, strength: 0.15, drift: [0.34, 0.13] };
const RIPPLE_2 = { tile: 6.5, strength: 0.085, drift: [0.24, -0.31], angle: 0.93 };
const FOAM_TILE = 7.5; // foam lace pattern tile (m)
const CAUSTIC_TILE = 5.2; // caustic web tile (m)

// Water body colours (sRGB, converted to linear by THREE.Color).
const OCEAN_SHALLOW = new THREE.Color("#4f9c90"); // turquoise-green over sand
const OCEAN_DEEP = new THREE.Color("#0a2f40"); // dark blue-teal open water
const LAKE_SHALLOW = new THREE.Color("#5b7a4e"); // murky green, tannin-tinted
const LAKE_DEEP = new THREE.Color("#16302b"); // dark bottle green
const FOAM = new THREE.Color("#e2e9e6");

// Glint strength (display-referred). The sun saturates; the moon draws a cold path.
const SUN_GLINT = 0.016;
const MOON_GLINT = 0.0045;

/* --- Shaders --- */

const VERTEX = /* glsl */ `
#include <fog_pars_vertex>
varying vec3 vWorld;

void main() {
  vec4 world = modelMatrix * vec4(position, 1.0);
  vWorld = world.xyz;
  vec4 mvPosition = viewMatrix * world;
  gl_Position = projectionMatrix * mvPosition;
  #include <fog_vertex>
}
`;

const r2c = Math.cos(RIPPLE_2.angle).toFixed(6);
const r2s = Math.sin(RIPPLE_2.angle).toFixed(6);

const FRAGMENT = /* glsl */ `
${SKY_COLOR_GLSL}
uniform sampler2D uHeight;
uniform vec4 uHeightMap;     // x: half tile size, y: 1 / cellSize, z: texels per side, w: sea level
uniform sampler2D uFresh;
uniform sampler2D uRipples;
uniform sampler2D uFoamTex;
uniform vec4 uRippleOff;     // xy: layer 1, zw: layer 2 (texture tiles, wrapped)
uniform vec4 uFoamOff;       // xy: lace, zw: caustics
uniform float uTime;
uniform vec3 uSunSpec;       // sun glint radiance (0 when the sun is down)
uniform vec3 uMoonDir;
uniform vec3 uMoonSpec;
uniform vec3 uLightDir;      // key light (sun or moon) direction
uniform vec3 uKeyLight;      // key light colour × intensity / PI  (Lambert-ready)
uniform vec3 uAmbient;       // hemisphere sky × intensity / PI
uniform float uDaylight;     // 0 night .. 1 day
uniform vec3 uOceanShallow;
uniform vec3 uOceanDeep;
uniform vec3 uLakeShallow;
uniform vec3 uLakeDeep;
uniform vec3 uFoam;

#include <fog_pars_fragment>
varying vec3 vWorld;

const float WPI = 3.14159265;
const float OCEAN_DEPTH = ${OPEN_OCEAN_DEPTH.toFixed(1)};
const mat2 ROT2 = mat2(${r2c}, ${r2s}, -${r2s}, ${r2c});   // world → layer-2 frame
const mat2 ROT2_T = mat2(${r2c}, -${r2s}, ${r2s}, ${r2c}); // layer-2 frame → world

// Slope (dh/dx, dh/dz) of one travelling sine swell.
vec2 swell(vec2 p, vec2 dir, float k, float speed, float amp) {
  return dir * (amp * k * cos(dot(p, dir) * k - uTime * speed));
}

// Smith masking for a Beckmann surface (Walter et al. rational fit).
float smithG1(float c, float m) {
  float a = c / (m * sqrt(max(1.0 - c * c, 1e-4)));
  return a < 1.6 ? (3.535 * a + 2.181 * a * a) / (1.0 + 2.276 * a + 2.577 * a * a) : 1.0;
}

// Specular reflection of a distant light (sun / moon) off a Beckmann surface
// with mean-square slope m2 — narrow sparkles up close, a broad glitter path
// far away where the ripple variance has moved into m2.
float glint(vec3 N, vec3 V, vec3 L, float m2) {
  float NdL = dot(N, L);
  if (NdL <= 0.0) return 0.0;
  vec3 H = normalize(L + V);
  float c = clamp(dot(N, H), 1e-3, 1.0);
  float c2 = c * c;
  float D = exp((c2 - 1.0) / (c2 * m2)) / (WPI * m2 * c2 * c2);
  float F = 0.02 + 0.98 * pow(1.0 - clamp(dot(V, H), 0.0, 1.0), 5.0);
  float NdV = max(dot(N, V), 0.02);
  float m = sqrt(m2);
  float G = smithG1(NdV, m) * smithG1(NdL, m);
  return D * F * G / (4.0 * NdV);
}

void main() {
  vec2 p = vWorld.xz;
  vec3 toEye = cameraPosition - vWorld;
  float dist = length(toEye);
  vec3 V = toEye / dist;

  /* Depth & water type. Sampled unconditionally (clamped), then selected. */
  float tileSize = 2.0 * uHeightMap.x;
  vec2 tileUv = (p + uHeightMap.x) / tileSize;
  float inside = step(0.0, tileUv.x) * step(tileUv.x, 1.0) * step(0.0, tileUv.y) * step(tileUv.y, 1.0);
  vec2 hUv = ((p + uHeightMap.x) * uHeightMap.y + 0.5) / uHeightMap.z;
  float ground = texture2D(uHeight, hUv).r;
  // One texel over in x and z: the bed slope turns depth into metres from the
  // shore, so foam and caustics keep their size on gentle and steep shores alike.
  float texel = 1.0 / uHeightMap.z;
  vec2 bedSlope = vec2(texture2D(uHeight, hUv + vec2(texel, 0.0)).r, texture2D(uHeight, hUv + vec2(0.0, texel)).r) - ground;
  bedSlope *= uHeightMap.y * inside;
  ground = mix(uHeightMap.w - OCEAN_DEPTH, ground, inside);
  float depth = max(uHeightMap.w - ground, 0.0);
  float shoreDist = depth / max(length(bedSlope), 0.012);
  float fresh = texture2D(uFresh, tileUv).r * inside;

  /* Surface slope: two scrolling ripple layers (mip-mapped; their variance is
     carried along for the glints) + long swells on open water. */
  vec4 t1 = texture2D(uRipples, p * ${(1 / RIPPLE_1.tile).toFixed(6)} + uRippleOff.xy);
  vec4 t2 = texture2D(uRipples, (ROT2 * p) * ${(1 / RIPPLE_2.tile).toFixed(6)} + uRippleOff.zw);
  vec2 s1 = t1.rg * 2.0 - 1.0;
  vec2 s2 = t2.rg * 2.0 - 1.0;
  float v1 = max(t1.b * 2.0 - dot(s1, s1), 0.0);
  float v2 = max(t2.b * 2.0 - dot(s2, s2), 0.0);
  float a1 = ${RIPPLE_1.strength.toFixed(4)} * mix(1.0, 0.75, fresh);
  float a2 = ${RIPPLE_2.strength.toFixed(4)};
  // Glassy right at the waterline, where there is no fetch for the wind.
  float calm = smoothstep(0.0, 0.6, depth);
  a1 *= mix(0.35, 1.0, calm);
  a2 *= mix(0.5, 1.0, calm);
  vec2 slope = s1 * a1 + ROT2_T * s2 * a2;
  float variance = v1 * a1 * a1 + v2 * a2 * a2;

  float swellAmt = smoothstep(0.5, 8.0, depth) * (1.0 - fresh);
  float swellNear = 1.0 - smoothstep(160.0, 650.0, dist);
  vec2 sw = swell(p, vec2(0.94, 0.34), 0.21, 0.92, 0.1)
          + swell(p, vec2(-0.45, 0.89), 0.47, 1.38, 0.045)
          + swell(p, vec2(0.2, -0.98), 0.83, 1.9, 0.022);
  slope += sw * swellAmt * swellNear;
  variance += 0.0012 * swellAmt * (1.0 - swellNear);
  vec3 N = normalize(vec3(-slope.x, 1.0, -slope.y));
  // Specular anti-aliasing: how much the slope changes across this pixel is
  // roughness the pixel cannot resolve. Without it, narrow glints near the
  // camera collapse into one-pixel lines at grazing angles.
  vec2 dsx = dFdx(slope);
  vec2 dsy = dFdy(slope);
  variance += min(0.5 * (dot(dsx, dsx) + dot(dsy, dsy)), 0.05);

  float NdV = clamp(dot(N, V), 0.0, 1.0);
  float F = 0.02 + 0.98 * pow(1.0 - NdV, 5.0);

  /* Water body: light scattered back out of the water column, tinted by type
     and depth, lit like the rest of the scene and tone mapped to sit with it. */
  vec3 shallowC = mix(uOceanShallow, uLakeShallow, fresh);
  vec3 deepC = mix(uOceanDeep, uLakeDeep, fresh);
  vec3 scatter = mix(shallowC, deepC, 1.0 - exp(-depth * mix(0.11, 0.2, fresh)));
  vec3 light = uAmbient + uKeyLight * (0.6 * max(uLightDir.y, 0.0) + 0.4 * max(dot(N, uLightDir), 0.0));
  // Night water reads darker and glossier than the moonlit land around it.
  vec3 body = scatter * light * mix(0.55, 1.0, uDaylight);
  // Light leaking through wave crests between the viewer and a low sun.
  float back = pow(clamp(dot(-V, uLightDir) * 0.5 + 0.5, 0.0, 1.0), 6.0);
  body += shallowC * uKeyLight * back * clamp(dot(slope, normalize(V.xz + 1e-4)) * 6.0, 0.0, 1.0) * smoothstep(1.0, 6.0, depth) * 0.6;
  #ifdef TONE_MAPPING
  body = toneMapping(body);
  #endif
  // How much of the bed shows through: light goes down and comes back up
  // along the view ray; lakes are murkier.
  float viewCos = max(V.y, 0.08);
  float path = depth * (1.0 + 1.0 / viewCos) * 0.5;
  float trans = exp(-path * mix(0.32, 0.75, fresh));

  /* Caustics on the bed of clear shallows (added light, seen through the
     water): two drifting copies of the cellular web at nearly the same scale,
     wobbled by the ripples; their minimum reads as one living caustic net. */
  vec2 wob = slope * 1.6;
  float c1 = texture2D(uRipples, p * ${(1 / CAUSTIC_TILE).toFixed(6)} + uFoamOff.zw + wob).a;
  float c2 = texture2D(uRipples, ROT2 * p * ${(1.13 / CAUSTIC_TILE).toFixed(6)} - uFoamOff.wz - wob).a;
  float caustic = min(c1, c2) * (0.35 + 0.65 * smoothstep(0.3, 0.7, t1.g * 0.5 + t2.r * 0.5));
  caustic *= smoothstep(0.05, 0.5, depth) * (1.0 - smoothstep(1.2, 4.0, depth)) * smoothstep(0.5, 3.0, shoreDist);
  caustic *= (1.0 - fresh * 0.75) * (1.0 - smoothstep(18.0, 70.0, dist)) * uDaylight;
  vec3 causticLight = uKeyLight * caustic * trans * 0.9;
  #ifdef TONE_MAPPING
  causticLight = toneMapping(causticLight);
  #endif

  /* Sky reflection (same model as the dome) and glints. */
  vec3 R = reflect(-V, N);
  vec3 sky = skyBase(R);
  float m2 = variance + 0.0009 + 0.0006; // + sun disc size² + micro-roughness
  vec3 spec = uSunSpec * glint(N, V, uSunDir, m2) + uMoonSpec * glint(N, V, uMoonDir, m2 + 0.0002);
  // Soft saturation: sparkles clip like the sun itself, the far glitter path keeps a gradient.
  spec = spec / (1.0 + max(max(spec.r, spec.g), spec.b) * 0.35);

  /* Shoreline foam: a broken lace line at the waterline plus bands of foam
     that roll in and fizzle out on the sand. Widths are in metres from the
     shore, widened (and dimmed to match) wherever they would be thinner than
     a pixel, so they never shimmer — at a distance or in the pixel style. */
  float lace = texture2D(uFoamTex, p * ${(1 / FOAM_TILE).toFixed(6)} + uFoamOff.xy + slope * 0.5).r;
  float patches = smoothstep(0.25, 0.75, t1.r * 0.6 + t2.g * 0.4);
  // Pixel footprint in metres-from-shore. shoreDist is only meaningful near
  // the shore (over a flat bed it is huge and changes fast), hence the clamp
  // and the depth gates below.
  float px = clamp(fwidth(shoreDist), 1e-4, 8.0);
  float edgeW = 0.6 + 1.5 * patches;
  float edgeWAA = max(edgeW, px * 2.0);
  float edgeT = shoreDist / edgeWAA;
  // Solid at the waterline, breaking into bubbles toward its outer edge.
  float edge = (1.0 - smoothstep(0.0, 1.0, edgeT)) * (edgeW / edgeWAA);
  edge *= smoothstep(0.25, 0.6, lace + (1.0 - edgeT) * 0.45);
  edge *= 1.0 - smoothstep(0.5, 1.0, depth);
  float ph = shoreDist * 0.8 + uTime * 0.55 + (t1.g - 0.5) * 2.0 + dot(p, vec2(0.94, 0.34)) * 0.05;
  float band = smoothstep(0.72, 0.98, sin(ph));
  // Near the real shore only: shallow shelves with a bumpy bed also have a
  // small depth / slope ratio, so depth gates the zone as well.
  float lapZone = smoothstep(7.5, 1.0, shoreDist) * (1.0 - smoothstep(0.2, 0.65, depth));
  float lap = band * lapZone * smoothstep(0.48, 0.75, lace) * (0.3 + 0.7 * patches);
  lap *= 1.0 - smoothstep(0.4, 1.3, fwidth(ph));
  // Sheltered lakes and rivers barely foam.
  lap *= 1.0 - fresh * 0.85;
  edge *= 1.0 - fresh * 0.55;
  float foam = clamp(max(edge, lap * 0.6), 0.0, 1.0);
  foam *= 1.0 - smoothstep(180.0, 450.0, dist);
  vec3 foamLit = uFoam * (uAmbient + uKeyLight * (0.35 + 0.65 * max(uLightDir.y, 0.0)));
  #ifdef TONE_MAPPING
  foamLit = toneMapping(foamLit);
  #endif

  /* Composite, premultiplied: what the water adds over the (attenuated) bed. */
  float alpha = 1.0 - (1.0 - F) * trans;
  vec3 rgb = body * (1.0 - trans) * (1.0 - F) + sky * F + spec + causticLight;
  // The last few decimetres fade out entirely (reflection too), so the
  // waterline is a soft wet edge rather than the plane's hard cut through the
  // terrain — which matters most on lakes, where there is little foam.
  float wetEdge = max(smoothstep(0.0, max(0.3, px), shoreDist), smoothstep(0.05, 0.25, depth));
  rgb *= wetEdge;
  alpha *= wetEdge;
  rgb = mix(rgb, foamLit, foam * 0.92);
  alpha = mix(alpha, 1.0, foam * 0.92);

  gl_FragColor = vec4(rgb / max(alpha, 1e-3), alpha);
  #include <colorspace_fragment>

  /* Fog toward the sky's own horizon haze for this azimuth (incl. sun glow),
     in the same colour space three.js mixes its fog in. */
  #ifdef USE_FOG
  #ifdef FOG_EXP2
  float fogFactor = 1.0 - exp(-fogDensity * fogDensity * vFogDepth * vFogDepth);
  #else
  float fogFactor = smoothstep(fogNear, fogFar, vFogDepth);
  #endif
  vec3 hazeDir = vec3(-V.x, 0.0, -V.z);
  vec3 haze = linearToOutputTexel(vec4(skyBase(hazeDir), 1.0)).rgb;
  gl_FragColor.rgb = mix(gl_FragColor.rgb, haze, fogFactor);
  gl_FragColor.a = mix(gl_FragColor.a, 1.0, fogFactor);
  #endif
  gl_FragColor.rgb *= gl_FragColor.a;
}
`;

/* --- Procedural textures --- */

const RIPPLE_SIZE = 256;
const FOAM_SIZE = 256;
let ripplePixels = null; // generated once per page, shared by every Water
let foamPixels = null;

/**
 * Tileable Worley (cellular) distances: for a G×G grid of jittered points
 * wrapped at the edges, returns a function (u, v) → writes F1 and F2 (distances
 * to the nearest and second-nearest point, in cell units) into `out`, plus the
 * index of the nearest cell. u, v in [0, 1).
 */
function makeWorley(G, rng) {
  const ox = new Float32Array(G * G);
  const oy = new Float32Array(G * G);
  for (let i = 0; i < G * G; i++) {
    ox[i] = 0.1 + 0.8 * rng();
    oy[i] = 0.1 + 0.8 * rng();
  }
  return (u, v, out) => {
    const x = u * G;
    const y = v * G;
    const cx = Math.floor(x);
    const cy = Math.floor(y);
    let f1 = 1e9;
    let f2 = 1e9;
    let id = 0;
    for (let dy = -1; dy <= 1; dy++) {
      const ny = cy + dy;
      const wy = ny < 0 ? ny + G : ny >= G ? ny - G : ny;
      for (let dx = -1; dx <= 1; dx++) {
        const nx = cx + dx;
        const wi = wy * G + (nx < 0 ? nx + G : nx >= G ? nx - G : nx);
        const ddx = x - (nx + ox[wi]);
        const ddy = y - (ny + oy[wi]);
        const d = ddx * ddx + ddy * ddy;
        if (d < f1) {
          f2 = f1;
          f1 = d;
          id = wi;
        } else if (d < f2) {
          f2 = d;
        }
      }
    }
    out.f1 = Math.sqrt(f1);
    out.f2 = Math.sqrt(f2);
    out.id = id;
    return out;
  };
}

/**
 * RGBA8 tileable ripple texture:
 *   RG — surface slope (dh/dx, dh/dy) from a sum of wind-aligned waves with
 *        integer wave vectors (so it tiles), normalised to [-1, 1],
 *   B  — slope second moment (sx² + sy²) / 2, which mip-maps correctly, so
 *        the shader can recover sub-pixel slope variance at any distance,
 *   A  — an irregular caustic web (Worley F2 − F1 lines whose width and
 *        brightness vary per cell).
 */
function rippleData() {
  if (ripplePixels) return ripplePixels;
  const S = RIPPLE_SIZE;
  const N = S * S;
  const rng = makeRng(0x5a0e1a);
  const sx = new Float32Array(N);
  const sy = new Float32Array(N);
  const cosA = new Float32Array(S);
  const sinA = new Float32Array(S);
  const cosB = new Float32Array(S);
  const sinB = new Float32Array(S);
  const WIND = 0.5; // radians; most energy travels roughly this way
  for (let w = 0; w < 36; w++) {
    const kMag = 2 + 20 * Math.pow(rng(), 1.35);
    const spread = rng() < 0.78 ? 1.6 : TAU;
    const ang = WIND + (rng() - 0.5) * spread;
    let kx = Math.round(Math.cos(ang) * kMag);
    const ky = Math.round(Math.sin(ang) * kMag);
    if (kx === 0 && ky === 0) kx = 2;
    const k = Math.hypot(kx, ky);
    // Height ∝ k^-1.5 → slope ∝ k^-0.5: fine ripples still carry detail.
    const amp = Math.pow(k, -1.5) * (0.6 + 0.8 * rng());
    const phase = rng() * TAU;
    // sin(a + b) separated into per-column / per-row tables: no trig per texel.
    for (let i = 0; i < S; i++) {
      const a = (TAU * kx * i) / S;
      cosA[i] = Math.cos(a);
      sinA[i] = Math.sin(a);
      const b = (TAU * ky * i) / S + phase;
      cosB[i] = Math.cos(b);
      sinB[i] = Math.sin(b);
    }
    const ax = amp * kx;
    const ay = amp * ky;
    for (let y = 0; y < S; y++) {
      const cb = cosB[y];
      const sb = sinB[y];
      const row = y * S;
      for (let x = 0; x < S; x++) {
        const c = cosA[x] * cb - sinA[x] * sb;
        sx[row + x] += ax * c;
        sy[row + x] += ay * c;
      }
    }
  }
  let peak = 1e-6;
  for (let i = 0; i < N; i++) peak = Math.max(peak, Math.abs(sx[i]), Math.abs(sy[i]));

  const G = 9;
  const worley = makeWorley(G, rng);
  const cellW = new Float32Array(G * G); // per-cell line width
  const cellB = new Float32Array(G * G); // per-cell brightness
  for (let i = 0; i < G * G; i++) {
    cellW[i] = 0.07 + 0.12 * rng();
    cellB[i] = 0.45 + 0.55 * rng();
  }
  const wv = { f1: 0, f2: 0, id: 0 };
  const data = new Uint8Array(N * 4);
  for (let y = 0; y < S; y++) {
    for (let x = 0; x < S; x++) {
      const i = y * S + x;
      const a = sx[i] / peak;
      const b = sy[i] / peak;
      // Warp the lookup by the ripple slope so the web's lines wander.
      worley(((x + 0.5) / S + a * 0.012 + 1) % 1, ((y + 0.5) / S + b * 0.012 + 1) % 1, wv);
      const web = (1 - smoothstep(0, cellW[wv.id], wv.f2 - wv.f1)) * cellB[wv.id];
      const o = i * 4;
      data[o] = Math.round((a * 0.5 + 0.5) * 255);
      data[o + 1] = Math.round((b * 0.5 + 0.5) * 255);
      data[o + 2] = Math.round(clamp((a * a + b * b) * 0.5, 0, 1) * 255);
      data[o + 3] = Math.round(web * 255);
    }
  }
  ripplePixels = data;
  return data;
}

/**
 * R8 tileable foam: cellular fBm (three Worley octaves) — bubbly clusters
 * with holes, rather than a regular net. Mean ≈ 0.5.
 */
function foamData() {
  if (foamPixels) return foamPixels;
  const S = FOAM_SIZE;
  const rng = makeRng(0xf0a4);
  const octaves = [makeWorley(5, rng), makeWorley(11, rng), makeWorley(23, rng)];
  const weights = [0.5, 0.32, 0.18];
  const wv = { f1: 0, f2: 0, id: 0 };
  const raw = new Float32Array(S * S);
  let sum = 0;
  let sq = 0;
  for (let y = 0; y < S; y++) {
    for (let x = 0; x < S; x++) {
      let v = 0;
      for (let o = 0; o < 3; o++) {
        octaves[o]((x + 0.5) / S, (y + 0.5) / S, wv);
        // Bright bubble rims, dark cell centres.
        v += weights[o] * (1 - wv.f1 * 1.3 + (wv.f2 - wv.f1) * -0.6);
      }
      raw[y * S + x] = v;
      sum += v;
      sq += v * v;
    }
  }
  const n = S * S;
  const mean = sum / n;
  const sd = Math.sqrt(Math.max(sq / n - mean * mean, 1e-8));
  const data = new Uint8Array(n);
  for (let i = 0; i < n; i++) data[i] = Math.round(clamp(((raw[i] - mean) / sd) * 0.2 + 0.5, 0, 1) * 255);
  foamPixels = data;
  return data;
}

function makeTileTexture(data, size, format) {
  const tex = new THREE.DataTexture(data, size, size, format, THREE.UnsignedByteType);
  tex.wrapS = THREE.RepeatWrapping;
  tex.wrapT = THREE.RepeatWrapping;
  tex.magFilter = THREE.LinearFilter;
  // Mip-mapped so detail averages out with distance instead of shimmering.
  tex.minFilter = THREE.LinearMipmapLinearFilter;
  tex.generateMipmaps = true;
  tex.anisotropy = 4;
  tex.colorSpace = THREE.NoColorSpace;
  tex.needsUpdate = true;
  return tex;
}

/**
 * The terrain heightfield as a linearly filterable texture. The terrain's own
 * texture is shared when it is half-float (always filterable in WebGL2);
 * a float one is copied to half-float, because float textures are not linearly
 * filterable on every GPU (notably iOS).
 */
function resolveHeightTexture(terrain) {
  const src = terrain.heightTexture;
  if (src && src.image && src.type === THREE.HalfFloatType && src.magFilter === THREE.LinearFilter) {
    return { texture: src, n: src.image.width, owned: false };
  }
  let data = null;
  let n = 0;
  if (terrain.heights instanceof Float32Array) {
    data = terrain.heights;
    n = Math.round(Math.sqrt(data.length));
  } else if (src && src.image && src.image.data instanceof Float32Array) {
    data = src.image.data;
    n = src.image.width;
  }
  if (!data || n < 2) {
    // No heightfield at all: everything is open ocean.
    n = 2;
    data = new Float32Array(4).fill((terrain.seaLevel ?? 0) - OPEN_OCEAN_DEPTH);
  }
  const half = new Uint16Array(n * n);
  for (let i = 0; i < n * n; i++) half[i] = THREE.DataUtils.toHalfFloat(data[i]);
  const tex = new THREE.DataTexture(half, n, n, THREE.RedFormat, THREE.HalfFloatType);
  tex.minFilter = THREE.LinearFilter;
  tex.magFilter = THREE.LinearFilter;
  tex.wrapS = THREE.ClampToEdgeWrapping;
  tex.wrapT = THREE.ClampToEdgeWrapping;
  tex.generateMipmaps = false;
  tex.colorSpace = THREE.NoColorSpace;
  tex.needsUpdate = true;
  return { texture: tex, n, owned: true };
}

/**
 * 0 (sea) .. 1 (lake / river) over the terrain tile, so fresh water can be
 * tinted murkier and kept free of ocean swell. Land texels take the class of
 * the nearest water (dilated) so lake shores don't fade toward "sea", and a
 * light blur softens river mouths.
 */
function makeFreshTexture(terrain) {
  const S = 256;
  const data = new Uint8Array(S * S);
  const canQuery = typeof terrain.isFreshWater === "function" && typeof terrain.isWater === "function";
  if (canQuery && terrain.size > 0) {
    const half = terrain.size / 2;
    let cur = new Float32Array(S * S);
    for (let y = 0; y < S; y++) {
      const z = -half + ((y + 0.5) / S) * terrain.size;
      for (let x = 0; x < S; x++) {
        const wx = -half + ((x + 0.5) / S) * terrain.size;
        cur[y * S + x] = terrain.isWater(wx, z) ? (terrain.isFreshWater(wx, z) ? 1 : 0) : -1;
      }
    }
    let next = new Float32Array(S * S);
    for (let pass = 0; pass < 6; pass++) {
      for (let y = 0; y < S; y++) {
        for (let x = 0; x < S; x++) {
          const i = y * S + x;
          let v = cur[i];
          if (v < 0) {
            let sum = 0;
            let cnt = 0;
            if (x > 0 && cur[i - 1] >= 0) { sum += cur[i - 1]; cnt++; }
            if (x < S - 1 && cur[i + 1] >= 0) { sum += cur[i + 1]; cnt++; }
            if (y > 0 && cur[i - S] >= 0) { sum += cur[i - S]; cnt++; }
            if (y < S - 1 && cur[i + S] >= 0) { sum += cur[i + S]; cnt++; }
            if (cnt) v = sum / cnt;
          }
          next[i] = v;
        }
      }
      const t = cur;
      cur = next;
      next = t;
    }
    for (let y = 0; y < S; y++) {
      for (let x = 0; x < S; x++) {
        let sum = 0;
        let cnt = 0;
        for (let dy = -1; dy <= 1; dy++) {
          for (let dx = -1; dx <= 1; dx++) {
            const xx = x + dx;
            const yy = y + dy;
            if (xx < 0 || yy < 0 || xx >= S || yy >= S) continue;
            sum += Math.max(cur[yy * S + xx], 0);
            cnt++;
          }
        }
        data[y * S + x] = Math.round((sum / cnt) * 255);
      }
    }
  }
  const tex = new THREE.DataTexture(data, S, S, THREE.RedFormat, THREE.UnsignedByteType);
  tex.minFilter = THREE.LinearFilter;
  tex.magFilter = THREE.LinearFilter;
  tex.wrapS = THREE.ClampToEdgeWrapping;
  tex.wrapT = THREE.ClampToEdgeWrapping;
  tex.generateMipmaps = false;
  tex.colorSpace = THREE.NoColorSpace;
  tex.needsUpdate = true;
  return tex;
}

/* --- Water --- */

// Names of the SKY_COLOR_GLSL uniforms mirrored from the Sky every frame.
const SKY_UNIFORMS = ["uZenith", "uHorizon", "uGlow", "uGlowAmt", "uBelt", "uSunDir", "uSunHalo"];

export class Water {
  /**
   * @param {object} terrain  a Terrain (reads heightTexture/heights, size, seaLevel,
   *                          and isWater/isFreshWater when present)
   */
  constructor(terrain) {
    const size = terrain.size;
    const seaLevel = terrain.seaLevel ?? 0;
    this.terrain = terrain;
    this.time = 0;

    const height = resolveHeightTexture(terrain);
    this._height = height;
    this._fresh = makeFreshTexture(terrain);
    this._ripples = makeTileTexture(rippleData(), RIPPLE_SIZE, THREE.RGBAFormat);
    this._foamTex = makeTileTexture(foamData(), FOAM_SIZE, THREE.RedFormat);
    this._rippleOff = new THREE.Vector4(0.13, 0.71, 0.42, 0.27);
    this._foamOff = new THREE.Vector4(0.5, 0.2, 0.8, 0.6);
    const cellSize = size / (height.n - 1);

    this.uniforms = THREE.UniformsUtils.merge([
      THREE.UniformsLib.fog,
      {
        uZenith: { value: new THREE.Color("#4b83be") },
        uHorizon: { value: new THREE.Color("#bfd1da") },
        uGlow: { value: new THREE.Color() },
        uGlowAmt: { value: 0 },
        uBelt: { value: new THREE.Color() },
        uSunDir: { value: new THREE.Vector3(0, 1, 0) },
        uSunHalo: { value: new THREE.Color() },
        uHeight: { value: null },
        uHeightMap: { value: new THREE.Vector4(size / 2, 1 / cellSize, height.n, seaLevel) },
        uFresh: { value: null },
        uRipples: { value: null },
        uFoamTex: { value: null },
        uRippleOff: { value: null },
        uFoamOff: { value: null },
        uTime: { value: 0 },
        uSunSpec: { value: new THREE.Color() },
        uMoonDir: { value: new THREE.Vector3(0, -1, 0) },
        uMoonSpec: { value: new THREE.Color() },
        uLightDir: { value: new THREE.Vector3(0, 1, 0) },
        uKeyLight: { value: new THREE.Color(0.8, 0.8, 0.8) },
        uAmbient: { value: new THREE.Color(0.25, 0.25, 0.25) },
        uDaylight: { value: 1 },
        uOceanShallow: { value: OCEAN_SHALLOW.clone() },
        uOceanDeep: { value: OCEAN_DEEP.clone() },
        uLakeShallow: { value: LAKE_SHALLOW.clone() },
        uLakeDeep: { value: LAKE_DEEP.clone() },
        uFoam: { value: FOAM.clone() },
      },
    ]);
    // merge() clones uniform values; textures and our live vectors are shared.
    this.uniforms.uHeight.value = height.texture;
    this.uniforms.uFresh.value = this._fresh;
    this.uniforms.uRipples.value = this._ripples;
    this.uniforms.uFoamTex.value = this._foamTex;
    this.uniforms.uRippleOff.value = this._rippleOff;
    this.uniforms.uFoamOff.value = this._foamOff;

    this.material = new THREE.ShaderMaterial({
      name: "Water",
      uniforms: this.uniforms,
      vertexShader: VERTEX,
      fragmentShader: FRAGMENT,
      transparent: true,
      // The shader outputs premultiplied colour, so reflections, glints and
      // caustics add light even where the water itself is nearly clear.
      premultipliedAlpha: true,
      depthWrite: true,
      fog: true,
    });

    const geo = new THREE.PlaneGeometry(size * PLANE_SCALE, size * PLANE_SCALE, 8, 8);
    geo.rotateX(-Math.PI / 2);
    this.mesh = new THREE.Mesh(geo, this.material);
    this.mesh.name = "water";
    // First among transparent objects: the plane's centre is far from most
    // things, so distance sorting could draw it over spray, dust or particles
    // that sit above the surface.
    this.mesh.renderOrder = -1;
    this.mesh.position.y = seaLevel;
    this.mesh.matrixAutoUpdate = false;
    this.mesh.updateMatrix();
  }

  /**
   * Animate the surface and pull the current light & sky colours from the Sky.
   * @param {number} dt seconds
   * @param {import("./sky.js").Sky} [sky]
   */
  update(dt, sky) {
    // Wrap well before float precision in the shader starts to matter.
    this.time = (this.time + dt) % 28800;
    const u = this.uniforms;
    u.uTime.value = this.time;

    // Texture offsets wrap at one tile, which is seamless.
    const r = this._rippleOff;
    r.x = (r.x + (dt * RIPPLE_1.drift[0]) / RIPPLE_1.tile) % 1;
    r.y = (r.y + (dt * RIPPLE_1.drift[1]) / RIPPLE_1.tile) % 1;
    r.z = (r.z + (dt * RIPPLE_2.drift[0]) / RIPPLE_2.tile + 1) % 1;
    r.w = (r.w + (dt * RIPPLE_2.drift[1]) / RIPPLE_2.tile + 1) % 1;
    const f = this._foamOff;
    f.x = (f.x + (dt * 0.05) / FOAM_TILE) % 1;
    f.y = (f.y + (dt * 0.032) / FOAM_TILE) % 1;
    f.z = (f.z + (dt * -0.07) / CAUSTIC_TILE + 1) % 1;
    f.w = (f.w + (dt * 0.045) / CAUSTIC_TILE) % 1;

    if (!sky) return;

    /* Sky colour model: mirror the dome so reflections and haze match it. */
    if (sky.uniforms) {
      for (const name of SKY_UNIFORMS) {
        const src = sky.uniforms[name];
        if (!src) continue;
        if (typeof src.value === "number") u[name].value = src.value;
        else u[name].value.copy(src.value);
      }
    } else {
      u.uZenith.value.copy(sky.skyColor);
      u.uHorizon.value.copy(sky.fogColor);
      u.uGlowAmt.value = 0;
      u.uSunDir.value.copy(sky.sunDirection);
      u.uSunHalo.value.setRGB(0, 0, 0);
    }

    /* Glints: the sun while its disc is up (golden and softer when low), the
       moon's cold path at night. */
    const sunY = sky.sunDirection.y;
    const daylight = sky.daylight ?? 1;
    u.uDaylight.value = daylight;
    const sunUp = smoothstep(-0.015, 0.03, sunY);
    u.uSunSpec.value.copy(sky.sunColor).multiplyScalar(SUN_GLINT * sunUp * lerp(0.55, 1, smoothstep(0, 0.35, sunY)));
    if (sky.moonDirection) {
      u.uMoonDir.value.copy(sky.moonDirection);
      const moonUp = sky.moonlight ?? smoothstep(-0.04, 0.12, sky.moonDirection.y);
      u.uMoonSpec.value.copy(sky.moonColor ?? sky.sunLight.color).multiplyScalar(MOON_GLINT * moonUp * (1 - daylight));
    } else {
      u.uMoonDir.value.copy(sky.sunDirection).negate();
      u.uMoonSpec.value.setRGB(0, 0, 0);
    }

    /* Scene lighting for the water body and foam. */
    u.uLightDir.value.copy(sky.lightDirection ?? sky.sunDirection);
    const key = sky.sunLight;
    if (key) u.uKeyLight.value.copy(key.color).multiplyScalar(key.intensity / Math.PI);
    const hemi = sky.hemiLight;
    if (hemi) u.uAmbient.value.copy(hemi.color).multiplyScalar(hemi.intensity / Math.PI);
  }

  /** Free GPU resources (the mesh is removed from its parent too). */
  dispose() {
    this.mesh.removeFromParent();
    this.mesh.geometry.dispose();
    this.material.dispose();
    this._ripples.dispose();
    this._foamTex.dispose();
    this._fresh.dispose();
    if (this._height.owned) this._height.texture.dispose();
  }
}
