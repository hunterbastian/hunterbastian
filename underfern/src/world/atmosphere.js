// Atmosphere — the small living lights and airs that make the island feel
// old and watched: fireflies and pale drifting motes at dusk and night in the
// woods (and around the old bones), shafts of light slanting through forest
// canopies and down cave skylights, cloud wisps clinging to the peaks, snow
// blowing off the summits, and glowing fungi in the caves.
//
// All cheap by construction — four draw calls, no extra passes:
//   - Motes: one Points cloud kept around the focus on a wrapping torus (each
//     mote stays put in the world until it wraps to the far side), CPU only
//     re-anchors the ones that wrapped; drifting, blinking and the soft glow
//     (a bright core in a wide halo — the "bloom") are done in the shaders.
//   - Beams: camera-facing quads, additive; forest beams follow the key
//     light's direction through the canopy around the focus, cave shafts
//     stand under each skylight. Faked light: no screen-space pass.
//   - Wisps: soft painted puffs on the peaks and plumes of spindrift on the
//     summits, alpha-blended billboards fogged like the land.
//   - Fungi: one instanced cluster mesh on the cave floors, self-lit.
// Everything fades by time of day and weather, all from the Sky.

import * as THREE from "three";
import { makeRng, rand, hash } from "../core/rng.js";
import { TAU, clamp, lerp, smoothstep } from "../core/math.js";
import { LOOK, LOOK_NOISE_GLSL } from "./look.js";

const MOTE_R = 46; // metres: half-width of the motes' wrapping square around the focus
const BEAM_R = 64;
const _c = new THREE.Color();

/* --- Motes: fireflies + drifting motes ----------------------------------------------- */

const MOTE_VERT = /* glsl */ `
attribute vec4 aMote;   // x: seed 0..1, y: kind (0 firefly, 1 pale mote), z: habitat 0..1, w: height above ground
uniform float uTime;
uniform float uFire;    // 0..1 fireflies out (dusk / night)
uniform float uPale;    // 0..1 pale motes out
uniform float uScale;   // pixels per metre at 1 m (drawing-buffer height / (2 tan(fov/2)))
uniform float uFogFar;
varying float vGlow;
varying float vKind;

void main() {
  float s = aMote.x;
  float kind = aMote.y;
  float t = uTime * (kind > 0.5 ? 0.18 : 0.45) + s * 61.0;
  vec3 p = position;
  // Lazy figure-eights; pale motes rise and sink slowly.
  p.x += sin(t * 0.9 + s * 20.0) * 1.6 + sin(t * 0.37) * 0.8;
  p.z += cos(t * 0.8 + s * 13.0) * 1.6 + cos(t * 0.29 + 1.0) * 0.8;
  p.y += aMote.w + sin(t * 1.3 + s * 7.0) * (kind > 0.5 ? 1.2 : 0.5);
  vec4 mv = viewMatrix * vec4(p, 1.0);
  gl_Position = projectionMatrix * mv;
  float d = -mv.z;
  // Fireflies blink in slow pulses; pale motes breathe.
  float blink = kind > 0.5 ? 0.55 + 0.45 * sin(t * 2.1) : smoothstep(0.35, 1.0, sin(uTime * (0.9 + s) + s * 40.0));
  float on = kind > 0.5 ? uPale : uFire;
  vGlow = on * aMote.z * blink * (1.0 - smoothstep(uFogFar * 0.12, uFogFar * 0.3, d)) * smoothstep(1.0, 3.0, d);
  vKind = kind;
  float size = kind > 0.5 ? 0.5 : 0.36; // metres across the halo
  gl_PointSize = clamp(size * uScale / max(d, 0.5), 2.0, 26.0);
  if (vGlow < 0.004) gl_Position = vec4(2.0, 2.0, 2.0, 1.0); // off screen, no fragments
}
`;

const MOTE_FRAG = /* glsl */ `
uniform vec3 uFireCol;
uniform vec3 uPaleCol;
varying float vGlow;
varying float vKind;

void main() {
  vec2 q = gl_PointCoord * 2.0 - 1.0;
  float r2 = dot(q, q);
  if (r2 > 1.0) discard;
  // A hot core in a soft halo: the glow a lens would bloom, drawn directly.
  float core = exp(-r2 * 22.0);
  float halo = exp(-r2 * 4.0) * 0.35;
  vec3 col = vKind > 0.5 ? uPaleCol : uFireCol;
  gl_FragColor = vec4(col * (core * 1.6 + halo) * vGlow, 1.0);
}
`;

class Motes {
  constructor(terrain, landmarks, count) {
    this.terrain = terrain;
    this.count = count;
    this.fossils = (landmarks?.sites || []).filter((s) => s.fossil);
    const rng = makeRng(hash("underfern-atmosphere", "motes", terrain.seed ?? 1));
    this.base = new Float32Array(count * 2); // torus offsets
    this.cell = new Int32Array(count * 2).fill(-999999); // which wrap the anchor was computed for
    const pos = new Float32Array(count * 3);
    const mote = new Float32Array(count * 4);
    for (let i = 0; i < count; i++) {
      this.base[i * 2] = rng() * MOTE_R * 2;
      this.base[i * 2 + 1] = rng() * MOTE_R * 2;
      mote[i * 4] = rng();
      mote[i * 4 + 1] = rng() < 0.3 ? 1 : 0;
      mote[i * 4 + 3] = mote[i * 4 + 1] > 0.5 ? rand(rng, 1.5, 5) : rand(rng, 0.3, 2.2);
    }
    const geo = new THREE.BufferGeometry();
    this.pos = new THREE.BufferAttribute(pos, 3);
    this.mote = new THREE.BufferAttribute(mote, 4);
    this.pos.setUsage(THREE.DynamicDrawUsage);
    this.mote.setUsage(THREE.DynamicDrawUsage);
    geo.setAttribute("position", this.pos);
    geo.setAttribute("aMote", this.mote);
    geo.boundingSphere = new THREE.Sphere(new THREE.Vector3(), 1e6);
    this.uniforms = {
      uTime: { value: 0 },
      uFire: { value: 0 },
      uPale: { value: 0 },
      uScale: { value: 400 },
      uFogFar: { value: 500 },
      // Display-referred (no tone mapping): a warm firefly green, a cold pale mote.
      uFireCol: { value: new THREE.Color("#e6ff84").convertLinearToSRGB() },
      uPaleCol: { value: new THREE.Color("#bfe4ff").convertLinearToSRGB() },
    };
    const mat = new THREE.ShaderMaterial({
      name: "Motes",
      uniforms: this.uniforms,
      vertexShader: MOTE_VERT,
      fragmentShader: MOTE_FRAG,
      transparent: true,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
      toneMapped: false,
    });
    this.points = new THREE.Points(geo, mat);
    this.points.name = "atmosphere-motes";
    this.points.frustumCulled = false;
    this.points.renderOrder = 2;
  }

  /** Habitat: fireflies in forests (wettest best) and pale motes there and around fossils. */
  _habitat(x, z, kind) {
    const T = this.terrain;
    if (T.inCave?.(x, z) || T.heightAt(x, z) < (T.seaLevel ?? 0) + 0.2) return 0;
    let near = 0;
    for (const s of this.fossils) near = Math.max(near, 1 - smoothstep(s.r, s.r + 45, Math.hypot(x - s.x, z - s.z)));
    const b = T.biomeAt(x, z);
    const wet = T.moistureAt ? T.moistureAt(x, z) : 0.5;
    if (kind > 0.5) return Math.max(near, b === "forest" ? 0.7 : 0);
    if (b === "forest") return 0.55 + 0.45 * smoothstep(0.5, 0.8, wet);
    return Math.max(near * 0.6, b === "plains" ? 0.25 * smoothstep(0.6, 0.85, wet) : 0);
  }

  update(dt, focus, sky, time) {
    const u = this.uniforms;
    u.uTime.value = time;
    const night = 1 - smoothstep(0.08, 0.42, sky.daylight);
    const dusk = sky.phase > 0.5 ? smoothstep(0.71, 0.78, sky.phase) : 1 - smoothstep(0.22, 0.27, sky.phase);
    const grey = sky._wx ? sky._wx.grey : 0;
    u.uFire.value = night * dusk * (1 - 0.6 * grey) * (1 - (sky.shelter || 0));
    u.uPale.value = Math.max(night, 0.35 * smoothstep(0.2, 0.6, sky.weather?.aurora || 0)) * (1 - (sky.shelter || 0));
    if (u.uFire.value < 0.003 && u.uPale.value < 0.003) {
      this.points.visible = false;
      return;
    }
    this.points.visible = true;
    const fx = focus.x;
    const fz = focus.z;
    const P = this.pos.array;
    const M = this.mote.array;
    const D = MOTE_R * 2;
    let lo = this.count;
    let hi = -1;
    for (let i = 0; i < this.count; i++) {
      // The wrap cell this mote is in; re-anchor only when it changes.
      const ox = this.base[i * 2] - fx + MOTE_R;
      const oz = this.base[i * 2 + 1] - fz + MOTE_R;
      const kx = Math.floor(ox / D);
      const kz = Math.floor(oz / D);
      if (kx === this.cell[i * 2] && kz === this.cell[i * 2 + 1]) continue;
      this.cell[i * 2] = kx;
      this.cell[i * 2 + 1] = kz;
      const x = fx - MOTE_R + (ox - kx * D);
      const z = fz - MOTE_R + (oz - kz * D);
      P[i * 3] = x;
      P[i * 3 + 1] = this.terrain.heightAt(x, z);
      P[i * 3 + 2] = z;
      M[i * 4 + 2] = this._habitat(x, z, M[i * 4 + 1]);
      lo = Math.min(lo, i);
      hi = Math.max(hi, i);
    }
    if (hi >= 0) {
      this.pos.clearUpdateRanges();
      this.pos.addUpdateRange(lo * 3, (hi - lo + 1) * 3);
      this.pos.needsUpdate = true;
      this.mote.clearUpdateRanges();
      this.mote.addUpdateRange(lo * 4, (hi - lo + 1) * 4);
      this.mote.needsUpdate = true;
    }
  }
}

/* --- Beams: god rays through the canopy, shafts under cave skylights ------------------ */

const BEAM_VERT = /* glsl */ `
attribute vec4 aBeam;    // xyz: top of the beam (world), w: seed
attribute vec4 aShape;   // x: width (m), y: length (m), z: mode (0 key-light aligned, 1 straight down), w: strength
uniform vec3 uLightDir;  // unit, toward the key light
uniform float uTime;
varying vec2 vUv;
varying float vFade;
varying float vSeed;

void main() {
  // Canopy rays lean toward the light but steeper than it (a painter's
  // diagonal): a low sun's true direction would lay them nearly flat and, as
  // you look toward it, end-on — invisible just when they should show most.
  vec3 axis = aShape.z > 0.5 ? vec3(0.0, -1.0, 0.0) : -normalize(vec3(uLightDir.x * 0.55, max(uLightDir.y, 0.5) + 0.35, uLightDir.z * 0.55));
  float len = aShape.y;
  vec3 top = aBeam.xyz;
  vec3 mid = top + axis * len * 0.5;
  vec3 toCam = normalize(cameraPosition - mid);
  vec3 side = normalize(cross(axis, toCam) + vec3(1e-4, 0.0, 0.0));
  // Slow sway of the beams as the canopy moves.
  float sway = sin(uTime * 0.21 + aBeam.w * 30.0) * 0.6 * (1.0 - aShape.z);
  vec3 p = top + axis * (position.y * len) + side * (position.x * aShape.x + sway * position.y);
  vUv = vec2(position.x, position.y);
  vSeed = aBeam.w;
  vec4 mv = viewMatrix * vec4(p, 1.0);
  gl_Position = projectionMatrix * mv;
  // Fade out when close (no walls of light in your face) and with distance.
  float d = -mv.z;
  vFade = aShape.w * smoothstep(3.0, 12.0, d) * (1.0 - smoothstep(55.0, 95.0, d));
  // Seen end-on (looking along the beam) a quad has no width: fade it.
  vFade *= smoothstep(0.05, 0.35, length(cross(axis, toCam)));
  // Dust scatters forward: canopy rays glow most when you look toward the
  // light (cave shafts are seen from the side, in the dark: left as they are).
  float fwd = max(dot(-toCam, normalize(uLightDir)), 0.0);
  vFade *= mix(0.4 + 1.2 * fwd * fwd, 1.0, aShape.z);
}
`;

const BEAM_FRAG = /* glsl */ `
uniform vec3 uColor;
uniform float uTime;
varying vec2 vUv;
varying float vFade;
varying float vSeed;
${LOOK_NOISE_GLSL.replace(/float lookGust[\s\S]*$/, "")}

void main() {
  float across = 1.0 - smoothstep(0.15, 0.5, abs(vUv.x));
  float along = smoothstep(0.0, 0.18, vUv.y) * (1.0 - smoothstep(0.55, 1.0, vUv.y));
  // Dusty, flickering light: streaks along the beam that drift slowly.
  float dust = 0.6 + 0.4 * lookNoise(vec2(vUv.x * 5.0 + vSeed * 40.0, vUv.y * 2.0 - uTime * 0.05));
  float a = across * across * along * dust * vFade;
  gl_FragColor = vec4(uColor * a, 1.0);
}
`;

class Beams {
  constructor(terrain, count) {
    this.terrain = terrain;
    this.count = count;
    const rng = makeRng(hash("underfern-atmosphere", "beams", terrain.seed ?? 1));
    // Cave skylight shafts are fixed instances after the forest ones.
    const shafts = [];
    for (const c of terrain.caves || []) {
      for (const s of c.skylights || []) {
        const top = terrain.ceilingAt ? terrain.ceilingAt(s.x, s.z) : NaN;
        const floor = terrain.heightAt(s.x, s.z);
        if (!Number.isFinite(top) || top <= floor + 1) continue;
        shafts.push({ x: s.x, z: s.z, top: top + 2, len: top + 2 - floor, w: s.r * 1.6 });
      }
    }
    this.shafts = shafts;
    const n = count + shafts.length;
    this.n = n;
    this.base = new Float32Array(count * 2);
    this.cell = new Int32Array(count * 2).fill(-999999);
    this.height = new Float32Array(count);
    this.forest = new Uint8Array(count);
    const beam = new Float32Array(n * 4);
    const shape = new Float32Array(n * 4);
    for (let i = 0; i < count; i++) {
      this.base[i * 2] = rng() * BEAM_R * 2;
      this.base[i * 2 + 1] = rng() * BEAM_R * 2;
      beam[i * 4 + 3] = rng();
      shape[i * 4] = rand(rng, 1.6, 4.2);
      this.height[i] = rand(rng, 11, 17); // the shaft starts under the crowns
    }
    shafts.forEach((s, k) => {
      const i = count + k;
      beam.set([s.x, s.top, s.z, rng()], i * 4);
      shape.set([s.w, s.len, 1, 1], i * 4);
    });
    const geo = new THREE.InstancedBufferGeometry();
    const quad = new THREE.PlaneGeometry(1, 1, 1, 1);
    quad.translate(0, 0.5, 0); // x across −0.5..0.5, y along 0..1
    geo.index = quad.index;
    geo.setAttribute("position", quad.attributes.position);
    this.aBeam = new THREE.InstancedBufferAttribute(beam, 4);
    this.aShape = new THREE.InstancedBufferAttribute(shape, 4);
    this.aBeam.setUsage(THREE.DynamicDrawUsage);
    this.aShape.setUsage(THREE.DynamicDrawUsage);
    geo.setAttribute("aBeam", this.aBeam);
    geo.setAttribute("aShape", this.aShape);
    geo.instanceCount = n;
    geo.boundingSphere = new THREE.Sphere(new THREE.Vector3(), 1e6);
    this.uniforms = {
      uLightDir: { value: new THREE.Vector3(0, 1, 0) },
      uTime: { value: 0 },
      uColor: { value: new THREE.Color() },
    };
    const mat = new THREE.ShaderMaterial({
      name: "Beams",
      uniforms: this.uniforms,
      vertexShader: BEAM_VERT,
      fragmentShader: BEAM_FRAG,
      transparent: true,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
      side: THREE.DoubleSide,
      toneMapped: false,
    });
    this.mesh = new THREE.Mesh(geo, mat);
    this.mesh.name = "atmosphere-beams";
    this.mesh.frustumCulled = false;
    this.mesh.renderOrder = 3;
    this._strength = 0;
    this._shaft = 0;
  }

  update(dt, focus, sky, time) {
    const u = this.uniforms;
    u.uTime.value = time;
    u.uLightDir.value.copy(sky.lightDirection);
    // Strongest with a low sun (long slanting rays) and in mist; gone under
    // overcast; faint blue moonbeams on clear nights.
    const W = sky._wx || { grey: 0, mistDay: 0, pale: 0 };
    const sunY = sky.sunDirection.y;
    const day = smoothstep(-0.02, 0.1, sunY);
    const low = 1 - 0.55 * smoothstep(0.25, 0.7, sunY);
    const moon = (1 - day) * (sky.moonlight || 0) * 0.35;
    const k = (day * low + moon) * (1 - 0.85 * W.grey) * (1 + 0.6 * W.mistDay);
    u.uColor.value.copy(sky.sunLight.color).convertLinearToSRGB().multiplyScalar(0.3);
    const forestK = k * (1 - 0.7 * (sky.shelter || 0));
    const shaftK = smoothstep(0.0, 0.3, sky.daylight) * (1 - 0.7 * W.grey);
    const fx = focus.x;
    const fz = focus.z;
    const B = this.aBeam.array;
    const S = this.aShape.array;
    const D = BEAM_R * 2;
    let changed = false;
    for (let i = 0; i < this.count; i++) {
      const ox = this.base[i * 2] - fx + BEAM_R;
      const oz = this.base[i * 2 + 1] - fz + BEAM_R;
      const kx = Math.floor(ox / D);
      const kz = Math.floor(oz / D);
      if (kx === this.cell[i * 2] && kz === this.cell[i * 2 + 1]) continue;
      this.cell[i * 2] = kx;
      this.cell[i * 2 + 1] = kz;
      const x = fx - BEAM_R + (ox - kx * D);
      const z = fz - BEAM_R + (oz - kz * D);
      const T = this.terrain;
      // Only under a closed canopy: deep in the forest, not at its edge or by
      // open water, where a shaft would hang against the bare sky.
      let forest = T.biomeAt(x, z) === "forest" && !T.nearCave?.(x, z) && !T.nearestFreshWater?.(x, z, 18);
      for (let k = 0; k < 4 && forest; k++) forest = T.biomeAt(x + (k === 0 ? 12 : k === 1 ? -12 : 0), z + (k === 2 ? 12 : k === 3 ? -12 : 0)) === "forest";
      const g = T.heightAt(x, z);
      B[i * 4] = x;
      B[i * 4 + 1] = g + this.height[i];
      B[i * 4 + 2] = z;
      S[i * 4 + 1] = this.height[i] * 1.6;
      this.forest[i] = forest ? 1 : 0;
      changed = true;
    }
    // Strength per instance: forest beams by the light and their habitat,
    // cave shafts by the day alone (they are seen from inside, in the dark).
    for (let i = 0; i < this.count; i++) S[i * 4 + 3] = forestK * this.forest[i];
    for (let k = 0; k < this.shafts.length; k++) S[(this.count + k) * 4 + 3] = shaftK;
    if (changed) this.aBeam.needsUpdate = true;
    this.aShape.needsUpdate = true;
    this.mesh.visible = forestK + (this.shafts.length ? shaftK : 0) > 0.003;
  }
}

/* --- Wisps: cloud on the peaks, spindrift off the summits ---------------------------- */

const WISP_VERT = /* glsl */ `
attribute vec4 aWisp;   // xyz: anchor (world), w: seed
attribute vec4 aForm;   // x: size (m), y: kind (0 cloud puff, 1 spindrift), z: stretch, w: drift (m)
uniform float uTime;
uniform vec4 uLookWind;
varying vec2 vUv;
varying float vKind;
varying float vSeed;
varying float vLife;
#include <fog_pars_vertex>

void main() {
  vec3 c = aWisp.xyz;
  float kind = aForm.y;
  vec2 wd = normalize(uLookWind.xy + 1e-4);
  // Spindrift streams downwind off the summit and fades; puffs breathe and creep.
  float life = fract(uTime * (kind > 0.5 ? 0.11 : 0.012) + aWisp.w * 7.0);
  vLife = life;
  c.xz += wd * aForm.w * (kind > 0.5 ? life : sin(life * 6.2832) * 0.5);
  c.y += kind > 0.5 ? -life * aForm.w * 0.25 : sin(uTime * 0.05 + aWisp.w * 9.0) * 2.0;
  vec4 mv = viewMatrix * vec4(c, 1.0);
  // Billboard in view space; spindrift is stretched along the wind's screen direction.
  vec2 corner = position.xy * aForm.x;
  if (kind > 0.5) {
    vec2 sd = normalize((viewMatrix * vec4(wd.x, -0.15, wd.y, 0.0)).xy + 1e-4);
    corner = sd * position.x * aForm.x * aForm.z + vec2(-sd.y, sd.x) * position.y * aForm.x;
  }
  mv.xy += corner;
  gl_Position = projectionMatrix * mv;
  vec4 mvPosition = mv;
  #include <fog_vertex>
  vUv = position.xy;
  vKind = kind;
  vSeed = aWisp.w;
}
`;

const WISP_FRAG = /* glsl */ `
uniform vec3 uLit;
uniform vec3 uShade;
uniform float uAmount;
uniform float uTime;
varying vec2 vUv;
varying float vKind;
varying float vSeed;
varying float vLife;
#include <fog_pars_fragment>
${LOOK_NOISE_GLSL.replace(/float lookGust[\s\S]*$/, "")}

void main() {
  vec2 q = vUv * 2.0;
  float r = length(q);
  float n = lookNoise(q * 2.2 + vSeed * 31.0 + uTime * 0.02) * 0.6 + lookNoise(q * 5.0 - vSeed * 17.0) * 0.4;
  float a = smoothstep(1.0, 0.25, r + (n - 0.5) * 0.7);
  vec3 col = mix(uShade, uLit, clamp(0.35 + q.y * 0.4 + n * 0.4, 0.0, 1.0));
  if (vKind > 0.5) {
    a *= 0.55 * sin(vLife * 3.1416);
    col = mix(uLit, vec3(1.0), 0.25);
  } else {
    a *= 0.7;
  }
  a *= uAmount;
  if (a < 0.01) discard;
  gl_FragColor = vec4(col, a);
  #include <colorspace_fragment>
  #include <fog_fragment>
}
`;

class Wisps {
  constructor(terrain, rngSeed) {
    const rng = makeRng(hash("underfern-atmosphere", "wisps", rngSeed));
    const items = [];
    for (const p of terrain.peaks || []) {
      const h = p.h + (terrain.seaLevel ?? 0);
      // A few soft puffs hanging off the summit's shoulders.
      const puffs = p.main ? 6 : 4;
      for (let k = 0; k < puffs; k++) {
        const a = rng() * TAU;
        const d = rand(rng, 12, 38);
        items.push([p.x + Math.cos(a) * d, h - rand(rng, 8, 30), p.z + Math.sin(a) * d, rng(), rand(rng, 14, 26), 0, 1, rand(rng, 8, 20)]);
      }
      // Spindrift: plumes streaming off the summit.
      const plumes = p.main ? 5 : 3;
      for (let k = 0; k < plumes; k++) {
        items.push([p.x + rand(rng, -4, 4), h - rand(rng, 0, 6), p.z + rand(rng, -4, 4), rng(), rand(rng, 4, 7), 1, rand(rng, 2.5, 4), rand(rng, 40, 70)]);
      }
    }
    const n = items.length;
    const wisp = new Float32Array(n * 4);
    const form = new Float32Array(n * 4);
    items.forEach((it, i) => {
      wisp.set(it.slice(0, 4), i * 4);
      form.set(it.slice(4, 8), i * 4);
    });
    const geo = new THREE.InstancedBufferGeometry();
    const quad = new THREE.PlaneGeometry(1, 1);
    geo.index = quad.index;
    geo.setAttribute("position", quad.attributes.position);
    geo.setAttribute("aWisp", new THREE.InstancedBufferAttribute(wisp, 4));
    geo.setAttribute("aForm", new THREE.InstancedBufferAttribute(form, 4));
    geo.instanceCount = n;
    geo.boundingSphere = new THREE.Sphere(new THREE.Vector3(), 1e6);
    this.uniforms = THREE.UniformsUtils.merge([
      THREE.UniformsLib.fog,
      {
        uTime: { value: 0 },
        uLit: { value: new THREE.Color() },
        uShade: { value: new THREE.Color() },
        uAmount: { value: 1 },
      },
    ]);
    this.uniforms.uLookWind = LOOK.uLookWind;
    const mat = new THREE.ShaderMaterial({
      name: "Wisps",
      uniforms: this.uniforms,
      vertexShader: WISP_VERT,
      fragmentShader: WISP_FRAG,
      transparent: true,
      depthWrite: false,
      fog: true,
      toneMapped: false,
    });
    this.mesh = new THREE.Mesh(geo, mat);
    this.mesh.name = "atmosphere-wisps";
    this.mesh.frustumCulled = false;
    this.mesh.renderOrder = 1;
    this.mesh.visible = n > 0;
  }

  update(dt, sky, time) {
    const u = this.uniforms;
    u.uTime.value = time;
    const su = sky.uniforms;
    u.uLit.value.copy(su.uCloudLit.value);
    u.uShade.value.copy(su.uCloudDark.value);
    const W = sky._wx || { grey: 0, mistDay: 0 };
    // More cloud clings to the peaks in grey weather; a little always.
    u.uAmount.value = (0.55 + 0.45 * Math.max(W.grey, W.mistDay)) * (1 - 0.7 * (sky.shelter || 0));
  }
}

/* --- Cave fungi ------------------------------------------------------------------------- */

const FUNGUS_VERT = /* glsl */ `
attribute vec4 aFungus; // xyz: base (world), w: seed
uniform float uTime;
varying float vH;
varying float vSeed;
#include <fog_pars_vertex>
void main() {
  float s = 0.6 + 0.8 * fract(aFungus.w * 13.7);
  float ang = aFungus.w * 6.2832;
  vec3 p = position * s;
  p.xz = mat2(cos(ang), -sin(ang), sin(ang), cos(ang)) * p.xz;
  vec4 mvPosition = viewMatrix * vec4(aFungus.xyz + p, 1.0);
  gl_Position = projectionMatrix * mvPosition;
  vH = position.y;
  vSeed = aFungus.w;
  #include <fog_vertex>
}
`;
const FUNGUS_FRAG = /* glsl */ `
uniform vec3 uGlowA;
uniform vec3 uGlowB;
uniform float uTime;
varying float vH;
varying float vSeed;
#include <fog_pars_fragment>
void main() {
  float pulse = 0.75 + 0.25 * sin(uTime * (0.6 + vSeed) + vSeed * 40.0);
  vec3 col = mix(uGlowA, uGlowB, fract(vSeed * 7.3)) * (0.35 + 0.9 * smoothstep(0.05, 0.3, vH)) * pulse;
  gl_FragColor = vec4(col, 1.0);
  #include <fog_fragment>
}
`;

/** A cluster of five small caps on stems (shared by every instance). */
function fungusGeometry() {
  const parts = [];
  const rng = makeRng(4242);
  for (let k = 0; k < 5; k++) {
    const a = (k / 5) * TAU + rng();
    const d = k ? rand(rng, 0.12, 0.3) : 0;
    const h = rand(rng, 0.12, 0.32);
    const r = rand(rng, 0.06, 0.13);
    const stem = new THREE.CylinderGeometry(r * 0.22, r * 0.3, h, 5, 1, true);
    stem.translate(Math.cos(a) * d, h / 2, Math.sin(a) * d);
    const cap = new THREE.SphereGeometry(r, 7, 4, 0, TAU, 0, Math.PI / 2);
    cap.scale(1, 0.55, 1);
    cap.translate(Math.cos(a) * d, h, Math.sin(a) * d);
    parts.push(stem.toNonIndexed(), cap.toNonIndexed());
  }
  let count = 0;
  for (const p of parts) count += p.attributes.position.count;
  const pos = new Float32Array(count * 3);
  let o = 0;
  for (const p of parts) {
    pos.set(p.attributes.position.array, o);
    o += p.attributes.position.array.length;
    p.dispose();
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute("position", new THREE.BufferAttribute(pos, 3));
  return g;
}

class Fungi {
  constructor(terrain, seed) {
    const rng = makeRng(hash("underfern-atmosphere", "fungi", seed));
    const T = terrain;
    const items = [];
    for (const c of T.caves || []) {
      const want = c.kind === "cavern" ? 26 : c.kind === "tunnel" ? 18 : 10;
      let tries = 0;
      let made = 0;
      while (made < want && tries++ < want * 30) {
        const p = c.path[Math.floor(rng() * c.path.length)];
        const x = p.x + rand(rng, -4, 4);
        const z = p.z + rand(rng, -4, 4);
        if (!T.inCave(x, z) || T.shelterAt(x, z) < 0.35) continue;
        const clr = T.clearanceAt(x, z);
        if (!(clr > 1.2)) continue;
        // Huddle in clumps of three or four.
        const n = 1 + Math.floor(rng() * 3);
        for (let k = 0; k < n; k++) {
          const xx = x + rand(rng, -0.7, 0.7);
          const zz = z + rand(rng, -0.7, 0.7);
          if (!T.inCave(xx, zz)) continue;
          items.push(xx, T.heightAt(xx, zz) - 0.02, zz, rng());
          made++;
        }
      }
    }
    this.count = items.length / 4;
    const geo = new THREE.InstancedBufferGeometry();
    const base = fungusGeometry();
    geo.setAttribute("position", base.attributes.position);
    geo.setAttribute("aFungus", new THREE.InstancedBufferAttribute(new Float32Array(items), 4));
    geo.instanceCount = this.count;
    geo.boundingSphere = new THREE.Sphere(new THREE.Vector3(), 1e6);
    this.uniforms = THREE.UniformsUtils.merge([
      THREE.UniformsLib.fog,
      {
        uTime: { value: 0 },
        uGlowA: { value: new THREE.Color("#5ff0d0").convertLinearToSRGB().multiplyScalar(1) },
        uGlowB: { value: new THREE.Color("#8ab8ff").convertLinearToSRGB() },
      },
    ]);
    const mat = new THREE.ShaderMaterial({
      name: "CaveFungi",
      uniforms: this.uniforms,
      vertexShader: FUNGUS_VERT,
      fragmentShader: FUNGUS_FRAG,
      fog: true,
      toneMapped: false,
    });
    this.mesh = new THREE.Mesh(geo, mat);
    this.mesh.name = "atmosphere-fungi";
    this.mesh.frustumCulled = false;
    this.mesh.visible = this.count > 0;
    this._near = 0;
  }

  update(time, camera, terrain) {
    this.uniforms.uTime.value = time;
    // Only worth drawing when the camera is in or near a cave.
    if (!this.count || !camera) return;
    const p = camera.position;
    this.mesh.visible = !!terrain.nearCave?.(p.x, p.z) || (terrain.shelterAt?.(p.x, p.z) || 0) > 0.02;
  }
}

/* --- Atmosphere ------------------------------------------------------------------------ */

export class Atmosphere {
  /**
   * @param {object} terrain Terrain
   * @param {{ seed?: number, landmarks?: object, low?: boolean }} [opts]
   */
  constructor(terrain, { seed = 1, landmarks = null, low = false } = {}) {
    this.terrain = terrain;
    this.time = 0;
    this.group = new THREE.Group();
    this.group.name = "atmosphere";
    this.motes = new Motes(terrain, landmarks, low ? 260 : 520);
    this.beams = new Beams(terrain, low ? 24 : 48);
    this.wisps = new Wisps(terrain, seed);
    this.fungi = new Fungi(terrain, seed);
    this.group.add(this.wisps.mesh, this.beams.mesh, this.motes.points, this.fungi.mesh);
    this.stats = { motes: this.motes.count, beams: this.beams.n, wisps: this.wisps.mesh.geometry.instanceCount, fungi: this.fungi.count };
  }

  /**
   * @param {number} dt
   * @param {{x:number,z:number}} focus
   * @param {import("./sky.js").Sky} sky
   * @param {THREE.PerspectiveCamera} camera
   * @param {number} bufferHeight drawing-buffer height in pixels (for mote sizes)
   */
  update(dt, focus, sky, camera, bufferHeight) {
    this.time = (this.time + dt) % 28800;
    const t = this.time;
    if (camera) {
      const scale = bufferHeight / (2 * Math.tan((camera.fov * Math.PI) / 360));
      this.motes.uniforms.uScale.value = scale;
    }
    this.motes.uniforms.uFogFar.value = sky.fog ? sky.fog.far : 500;
    this.motes.update(dt, focus, sky, t);
    this.beams.update(dt, focus, sky, t);
    this.wisps.update(dt, sky, t);
    this.fungi.update(t, camera, this.terrain);
  }

  dispose() {
    for (const o of [this.motes.points, this.beams.mesh, this.wisps.mesh, this.fungi.mesh]) {
      o.geometry.dispose();
      o.material.dispose();
    }
    this.group.removeFromParent();
  }
}
