// Water: one plane at sea level covering the island tile three times over, so
// every lake, river and the open ocean share a single draw call.
//
// The fragment shader reads the terrain heightfield to know how deep the water
// is at each point: shallow water is clear and green so the lakebed shows
// through, deep water turns dark blue-teal, and animated foam bands lap at
// every shoreline. Ripples are normal perturbation only (no vertex waves), so
// the plane stays a handful of triangles. Fresnel reflects the sky colours,
// the sun leaves a glittering path (the moon a cold one at night), and the
// result respects scene fog so the sea melts into the horizon.

import * as THREE from "three";
import { smoothstep } from "../core/math.js";

/* --- Tuning --- */

const PLANE_SCALE = 3; // plane edge = 3 × terrain size, so the horizon is always ocean
const OPEN_OCEAN_DEPTH = 40; // metres assumed beyond the terrain tile
const FOAM_DEPTH = 1.3; // metres of depth over which shoreline foam appears

// Water body colours (sRGB, converted to linear by THREE.Color).
const SHALLOW = new THREE.Color("#6fa592"); // clear, slightly green over sand / mud
const MID = new THREE.Color("#2c7477"); // teal
const DEEP = new THREE.Color("#0b3243"); // dark blue-teal open water
const FOAM = new THREE.Color("#eef4f0");

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

const FRAGMENT = /* glsl */ `
uniform sampler2D uHeight;
uniform vec4 uGrid;          // x: half size, y: 1 / cellSize, z: last grid index, w: sea level
uniform float uOceanDepth;
uniform float uTime;
uniform vec3 uSunDir;
uniform vec3 uSunSpec;       // sun colour × visibility × strength
uniform vec3 uMoonDir;
uniform vec3 uMoonSpec;
uniform vec3 uLightDir;      // key light (sun or moon) direction
uniform vec3 uKeyLight;      // key light colour × intensity / PI  (Lambert-ready)
uniform vec3 uAmbient;       // hemisphere sky × intensity / PI
uniform vec3 uSkyZenith;
uniform vec3 uSkyHorizon;
uniform vec3 uShallow;
uniform vec3 uMid;
uniform vec3 uDeep;
uniform vec3 uFoam;

#include <fog_pars_fragment>
varying vec3 vWorld;

float hash12(vec2 p) {
  vec3 p3 = fract(vec3(p.xyx) * 0.1031);
  p3 += dot(p3, p3.yzx + 33.33);
  return fract((p3.x + p3.y) * p3.z);
}

// Gradient noise returning (value, d/dx, d/dy) — analytic derivatives give
// ripple normals without extra samples.
vec3 gnoised(vec2 p) {
  vec2 i = floor(p);
  vec2 f = fract(p);
  vec2 u = f * f * f * (f * (f * 6.0 - 15.0) + 10.0);
  vec2 du = 30.0 * f * f * (f * (f - 2.0) + 1.0);
  float ra = hash12(i) * 6.2831853;
  float rb = hash12(i + vec2(1.0, 0.0)) * 6.2831853;
  float rc = hash12(i + vec2(0.0, 1.0)) * 6.2831853;
  float rd = hash12(i + vec2(1.0, 1.0)) * 6.2831853;
  vec2 ga = vec2(cos(ra), sin(ra));
  vec2 gb = vec2(cos(rb), sin(rb));
  vec2 gc = vec2(cos(rc), sin(rc));
  vec2 gd = vec2(cos(rd), sin(rd));
  float va = dot(ga, f);
  float vb = dot(gb, f - vec2(1.0, 0.0));
  float vc = dot(gc, f - vec2(0.0, 1.0));
  float vd = dot(gd, f - vec2(1.0, 1.0));
  float k = va - vb - vc + vd;
  return vec3(
    va + u.x * (vb - va) + u.y * (vc - va) + u.x * u.y * k,
    ga + u.x * (gb - ga) + u.y * (gc - ga) + u.x * u.y * (ga - gb - gc + gd) + du * (u.yx * k + vec2(vb, vc) - va)
  );
}

// Manual bilinear fetch of the heightfield: float textures are not
// filterable on every GPU, texelFetch always works.
float terrainHeight(vec2 xz) {
  vec2 g = (xz + uGrid.x) * uGrid.y;
  if (g.x < 0.0 || g.y < 0.0 || g.x > uGrid.z || g.y > uGrid.z) return uGrid.w - uOceanDepth;
  vec2 i = floor(g);
  vec2 f = g - i;
  int last = int(uGrid.z);
  ivec2 i0 = ivec2(i);
  ivec2 i1 = min(i0 + 1, ivec2(last));
  float h00 = texelFetch(uHeight, i0, 0).r;
  float h10 = texelFetch(uHeight, ivec2(i1.x, i0.y), 0).r;
  float h01 = texelFetch(uHeight, ivec2(i0.x, i1.y), 0).r;
  float h11 = texelFetch(uHeight, i1, 0).r;
  return mix(mix(h00, h10, f.x), mix(h01, h11, f.x), f.y);
}

// Slope (dh/dx, dh/dz) of one travelling sine wave.
vec2 swell(vec2 p, vec2 dir, float k, float speed, float amp) {
  return dir * (amp * k * cos(dot(p, dir) * k - uTime * speed));
}

void main() {
  vec2 p = vWorld.xz;
  vec3 toEye = cameraPosition - vWorld;
  float dist = length(toEye);
  vec3 V = toEye / dist;

  float depth = max(uGrid.w - terrainHeight(p), 0.0);

  /* Surface normal: long swells (calmer in the shallows) + wind ripples that
     fade out with distance before they can alias. */
  float swellAmt = smoothstep(0.3, 6.0, depth) * (1.0 - smoothstep(250.0, 900.0, dist));
  vec2 slope = vec2(0.0);
  slope += swell(p, vec2(0.94, 0.34), 0.28, 1.05, 0.11);
  slope += swell(p, vec2(-0.45, 0.89), 0.61, 1.6, 0.045);
  slope += swell(p, vec2(0.2, -0.98), 1.13, 2.3, 0.022);
  slope *= swellAmt;
  float rippleAmt = 1.0 - smoothstep(25.0, 220.0, dist);
  vec3 r1 = gnoised(p * 0.42 + vec2(uTime * 0.11, uTime * 0.07));
  vec3 r2 = gnoised(p * 1.05 - vec2(uTime * 0.05, -uTime * 0.17));
  slope += (r1.yz * 0.42 * 0.16 + r2.yz * 1.05 * 0.055) * rippleAmt;
  vec3 N = normalize(vec3(-slope.x, 1.0, -slope.y));

  /* Water body: depth tint, lit like the rest of the scene, then tone mapped
     so it sits with the ACES-lit terrain around it. */
  vec3 body = mix(uShallow, uMid, smoothstep(0.0, 3.2, depth));
  body = mix(body, uDeep, smoothstep(3.2, 20.0, depth));
  // Large, slow patches of colour keep big water from looking flat-filled.
  float patchN = gnoised(p * 0.012 + uTime * 0.003).x;
  body *= 0.92 + 0.16 * patchN;
  vec3 light = uAmbient + uKeyLight * max(dot(N, uLightDir), 0.0);
  vec3 bodyLit = body * light;
  // Light scattering up through wave crests facing away from the sun.
  bodyLit += uMid * uKeyLight * 0.35 * pow(max(dot(V, -uLightDir) + 0.25, 0.0), 2.0) * smoothstep(1.0, 6.0, depth) * (0.5 + slope.x * 2.0);
  #ifdef TONE_MAPPING
  bodyLit = toneMapping(bodyLit);
  #endif

  /* Fresnel sky reflection, in the same (display-referred) space as the
     un-tonemapped sky dome so far water meets the horizon seamlessly. */
  float NdV = clamp(dot(N, V), 0.0, 1.0);
  float fresnel = 0.02 + 0.98 * pow(1.0 - NdV, 5.0);
  vec3 R = reflect(-V, N);
  float ry = max(R.y, 0.0);
  vec3 sky = mix(uSkyHorizon, uSkyZenith, 1.0 - exp(-ry * 3.4));
  // Broad warm sheen toward a low sun: the reflected horizon glow.
  sky += uSunSpec * 0.06 * pow(max(dot(R, uSunDir), 0.0), 6.0);
  vec3 col = mix(bodyLit, sky, fresnel);

  /* Glints: a hot tight sparkle plus a softer glitter path. */
  vec3 Hs = normalize(uSunDir + V);
  float ns = max(dot(N, Hs), 0.0);
  col += uSunSpec * (pow(ns, 900.0) * 3.5 + pow(ns, 120.0) * 0.25);
  vec3 Hm = normalize(uMoonDir + V);
  float nm = max(dot(N, Hm), 0.0);
  col += uMoonSpec * (pow(nm, 700.0) * 2.0 + pow(nm, 90.0) * 0.18);

  /* Shoreline foam: a broken contact line plus bands rolling in to shore.
     Bands fade where they would get thinner than a pixel. */
  float foamNoise = gnoised(p * 0.21 + vec2(uTime * 0.04, -uTime * 0.03)).x * 0.5 + 0.5;
  float shore = 1.0 - smoothstep(0.0, ${FOAM_DEPTH.toFixed(2)}, depth);
  float bandsPhase = depth * 6.5 + uTime * 1.25 + foamNoise * 3.0;
  float bands = smoothstep(0.55, 0.85, sin(bandsPhase) * 0.5 + 0.5);
  float bandAA = 1.0 - smoothstep(0.5, 1.4, fwidth(bandsPhase));
  float edge = 1.0 - smoothstep(0.04, 0.3, depth + (foamNoise - 0.5) * 0.18);
  float foam = max(edge, bands * shore * shore * bandAA * (0.35 + 0.65 * foamNoise));
  foam *= 1.0 - smoothstep(200.0, 420.0, dist);
  vec3 foamLit = uFoam * (uAmbient + uKeyLight * max(uLightDir.y, 0.0));
  #ifdef TONE_MAPPING
  foamLit = toneMapping(foamLit);
  #endif
  col = mix(col, foamLit, foam * 0.9);

  /* Opacity: clear in the shallows, opaque with depth and at grazing angles. */
  float alpha = mix(0.28, 1.0, smoothstep(0.0, 4.5, depth));
  alpha = max(alpha, fresnel);
  alpha = max(alpha, foam * 0.9);
  alpha = mix(alpha, 1.0, smoothstep(120.0, 360.0, dist));

  gl_FragColor = vec4(col, alpha);
  #include <colorspace_fragment>
  #include <fog_fragment>
}
`;

/* --- Helpers --- */

/**
 * A NearestFilter float copy of the terrain heights. The terrain's own
 * texture is LinearFilter, which makes it incomplete (reads as zero) on GPUs
 * without OES_texture_float_linear; we filter manually, so nearest is all we
 * need and it works everywhere.
 */
function makeHeightTexture(terrain) {
  const src = terrain.heightTexture;
  let data = null;
  let w = 0;
  if (src && src.image && src.image.data instanceof Float32Array && src.format === THREE.RedFormat) {
    data = src.image.data;
    w = src.image.width;
  } else if (terrain.heights instanceof Float32Array) {
    data = terrain.heights;
    w = Math.round(Math.sqrt(data.length));
  }
  if (!data || w < 2) {
    // No heightfield at all: treat everything as open ocean.
    data = new Float32Array([-OPEN_OCEAN_DEPTH, -OPEN_OCEAN_DEPTH, -OPEN_OCEAN_DEPTH, -OPEN_OCEAN_DEPTH]);
    w = 2;
  }
  const tex = new THREE.DataTexture(data, w, w, THREE.RedFormat, THREE.FloatType);
  tex.minFilter = THREE.NearestFilter;
  tex.magFilter = THREE.NearestFilter;
  tex.wrapS = THREE.ClampToEdgeWrapping;
  tex.wrapT = THREE.ClampToEdgeWrapping;
  tex.generateMipmaps = false;
  tex.needsUpdate = true;
  return tex;
}

/* --- Water --- */

export class Water {
  /**
   * @param {object} terrain  a Terrain (reads heightTexture/heights, size, seaLevel)
   */
  constructor(terrain) {
    const size = terrain.size;
    const seaLevel = terrain.seaLevel ?? 0;
    this.terrain = terrain;
    this.time = 0;
    this._heightTexture = makeHeightTexture(terrain);
    const gridW = this._heightTexture.image.width;
    const cellSize = size / (gridW - 1);

    this.uniforms = THREE.UniformsUtils.merge([
      THREE.UniformsLib.fog,
      {
        uHeight: { value: null },
        uGrid: { value: new THREE.Vector4(size / 2, 1 / cellSize, gridW - 1, seaLevel) },
        uOceanDepth: { value: OPEN_OCEAN_DEPTH },
        uTime: { value: 0 },
        uSunDir: { value: new THREE.Vector3(0, 1, 0) },
        uSunSpec: { value: new THREE.Color() },
        uMoonDir: { value: new THREE.Vector3(0, -1, 0) },
        uMoonSpec: { value: new THREE.Color() },
        uLightDir: { value: new THREE.Vector3(0, 1, 0) },
        uKeyLight: { value: new THREE.Color() },
        uAmbient: { value: new THREE.Color(0.2, 0.2, 0.2) },
        uSkyZenith: { value: new THREE.Color() },
        uSkyHorizon: { value: new THREE.Color() },
        uShallow: { value: SHALLOW.clone() },
        uMid: { value: MID.clone() },
        uDeep: { value: DEEP.clone() },
        uFoam: { value: FOAM.clone() },
      },
    ]);
    // merge() clones uniform values; textures must be shared, not cloned.
    this.uniforms.uHeight.value = this._heightTexture;

    this.material = new THREE.ShaderMaterial({
      name: "Water",
      uniforms: this.uniforms,
      vertexShader: VERTEX,
      fragmentShader: FRAGMENT,
      transparent: true,
      depthWrite: true,
      fog: true,
    });

    const geo = new THREE.PlaneGeometry(size * PLANE_SCALE, size * PLANE_SCALE, 8, 8);
    geo.rotateX(-Math.PI / 2);
    this.mesh = new THREE.Mesh(geo, this.material);
    this.mesh.name = "water";
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
    if (!sky) return;

    const sunY = sky.sunDirection.y;
    const daylight = sky.daylight ?? 1;
    u.uSunDir.value.copy(sky.sunDirection);
    // Glints only while the disc is up; a bit hotter when the sun is low and
    // golden (the long glitter path of sunrise/sunset).
    const sunUp = smoothstep(-0.02, 0.06, sunY);
    u.uSunSpec.value.copy(sky.sunColor).multiplyScalar(sunUp * (1.4 + 0.6 * (1 - smoothstep(0, 0.4, sunY))));

    if (sky.moonDirection) {
      u.uMoonDir.value.copy(sky.moonDirection);
      const moonUp = sky.moonlight ?? smoothstep(-0.04, 0.12, sky.moonDirection.y);
      u.uMoonSpec.value.copy(sky.moonColor ?? sky.sunLight.color).multiplyScalar(moonUp * (1 - daylight) * 0.9);
    } else {
      u.uMoonDir.value.copy(sky.sunDirection).negate();
      u.uMoonSpec.value.setRGB(0, 0, 0);
    }

    u.uLightDir.value.copy(sky.lightDirection ?? sky.sunDirection);
    const key = sky.sunLight;
    u.uKeyLight.value.copy(key.color).multiplyScalar(key.intensity / Math.PI);
    const hemi = sky.hemiLight;
    u.uAmbient.value.copy(hemi.color).multiplyScalar(hemi.intensity / Math.PI);
    u.uSkyZenith.value.copy(sky.skyColor);
    u.uSkyHorizon.value.copy(sky.fogColor);
  }

  /** Free GPU resources (the mesh is removed from its parent too). */
  dispose() {
    this.mesh.removeFromParent();
    this.mesh.geometry.dispose();
    this.material.dispose();
    this._heightTexture.dispose();
  }
}
