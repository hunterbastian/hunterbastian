// The painterly look — one set of shader hooks shared by every lit material.
//
// Underfern's art direction leans on *Breath of the Wild* (soft, luminous
// light, cool shadows, saturated blue-green aerial haze) and *Skyrim* (mist in
// the valleys, snow on the peaks, moody weather). Most of that is lighting and
// atmosphere, so it lives here, patched into the standard materials (terrain,
// caves, vegetation, rocks, dinosaurs, landmarks) through their onBeforeCompile
// hooks — no post-processing pass, so it costs the same in both render styles
// and the pixel style keeps its single low-res draw:
//
//   - Wrap lighting: the key light bleeds a little past the terminator
//     (half-Lambert-like), so forms turn softly instead of snapping to shade.
//   - Cool fill: wherever the key light is blocked (cast shadow) or turned
//     away, a blue-violet sky bounce fills in — shadows read cool and airy,
//     not black.
//   - Rim light: a thin, warm-to-sky-tinted edge on silhouettes, strongest
//     against a low sun, so dinosaurs read against the land.
//   - Grade (right after tone mapping, before the sRGB encode): gentle
//     vibrance, warm highlights / cool shadows.
//   - Atmosphere (replacing three's fog chunk): the sky's linear haze, thinned
//     with altitude so ridgelines stack as layered silhouettes, plus
//     exponential valley mist (densest low down and at dawn; banks drift with
//     a slow noise). Colours stay in three's fog space, and the haze still
//     reaches exactly the fog colour (= the sky dome's horizon) far away.
//   - Vignette: the last multiply, in screen space.
//
// Sky owns the time-of-day / weather state and writes LOOK's uniforms every
// frame; the ShaderMaterials (sky dome, water) include the same GLSL directly.

import * as THREE from "three";

/** Shared uniforms (every patched program references these same objects). */
export const LOOK = {
  // x: mist density at the base height (1/m), y: falloff height (m), z: base height (world y), w: bank contrast 0..1
  uLookMist: { value: new THREE.Vector4(0, 12, 0, 0.5) },
  // Mist colour, in three's fog space (display-referred sRGB) — set by Sky.
  uLookMistColor: { value: new THREE.Color(0.8, 0.82, 0.86) },
  // Forward-scattering glow of the mist and haze toward the sun (fog space).
  uLookMistSun: { value: new THREE.Color(0, 0, 0) },
  // xyz: unit vector toward the sun (world; below the horizon at night), w: haze thinning with altitude 0..1
  uLookSun: { value: new THREE.Vector4(0, 1, 0, 0.45) },
  // The sky's warm glow around the sun's azimuth, for the haze (fog space): rgb, amount.
  uLookHazeGlow: { value: new THREE.Vector4(0, 0, 0, 0) },
  // The blue the middle distance takes on before it melts into the horizon (fog space).
  uLookAerial: { value: new THREE.Color(0.5, 0.68, 0.84) },
  // Cool fill where the key light doesn't reach (linear radiance, ×1/π like three's lights).
  uLookFill: { value: new THREE.Color(0, 0, 0) },
  // x: vibrance, y: split-tone strength, z: contrast, w: rim strength (global)
  uLookGrade: { value: new THREE.Vector4(0.18, 1, 0.06, 1) },
  uLookShadowTint: { value: new THREE.Color(0.92, 0.96, 1.08) },
  uLookHighTint: { value: new THREE.Color(1.05, 1.0, 0.92) },
  // x: 1/width, y: 1/height (drawing buffer px), z: vignette strength, w: time (s)
  uLookScreen: { value: new THREE.Vector4(1 / 1280, 1 / 720, 0.16, 0) },
  // Wind for grass gusts: xy unit direction it blows toward, z strength 0..1, w phase (m travelled)
  uLookWind: { value: new THREE.Vector4(1, 0, 0.4, 0) },
  // The Storybook style (0 in every other style): x palette, y painted
  // distance, z soft cel bands — each 0..1. main.js sets it with the style.
  uLookStory: { value: new THREE.Vector4(0, 0, 0, 0) },
  // Its colour grade (setStoryGrade fills these from STORY_GRADES):
  // x vibrance, y extra S contrast, z desaturation, w extra vignette
  uLookSG: { value: new THREE.Vector4() },
  // Split tone: shade and light multipliers.
  uLookSGShade: { value: new THREE.Vector3(1, 1, 1) },
  uLookSGLight: { value: new THREE.Vector3(1, 1, 1) },
  // Greens nudged (added, linear) where they lie in shade and in sun.
  uLookSGGreenShade: { value: new THREE.Vector3() },
  uLookSGGreenLit: { value: new THREE.Vector3() },
  // Toe, in perceptual space: x scale, yzw lift.
  uLookSGToe: { value: new THREE.Vector4(1, 0, 0, 0) },
  // Painted distance: x pull toward the horizon colour, y desaturation; tint.
  uLookSGHaze: { value: new THREE.Vector4() },
  uLookSGHazeTint: { value: new THREE.Vector3(1, 1, 1) },
  // Sky (the Storybook pass): x desaturation, yzw added; tint.
  uLookSGSky: { value: new THREE.Vector4() },
  uLookSGSkyTint: { value: new THREE.Vector3(1, 1, 1) },
};

/**
 * Storybook's colour grades. The painted light, ink and brushwork stay the
 * same; the colour around them changes:
 * Dark fantasy is the game's default look.
 *   jungle  — a humid jungle film: deep emerald greens, golden-amber light over
 *             teal-green shade, a firm filmic S, wet grey-green distance.
 *   fantasy — dark fantasy: a muted, earthy palette (khaki and olive greens),
 *             gold light over cool grey-blue shade lifted into haze, a golden
 *             misty distance and a heavier vignette.
 *   picture — the bright picture book: spring greens, warm light and cool
 *             shade, an airy lift and a blue painted distance.
 */
export const STORY_GRADES = {
  jungle: {
    sg: [0.5, 0.14, 0, 0],
    shade: [0.9, 1.0, 0.98],
    light: [1.09, 1.0, 0.86],
    greenShade: [-0.006, 0.016, 0.01],
    greenLit: [0.03, 0.03, -0.012],
    toe: [0.97, 0.022, 0.03, 0.028],
    haze: [0.55, 0.4, 0, 0],
    hazeTint: [0.97, 1.02, 0.96],
    sky: [0.18, 0.02, 0.02, 0.01],
    skyTint: [1.03, 1.01, 0.95],
  },
  fantasy: {
    sg: [0.05, 0.16, 0.3, 0.12],
    shade: [0.88, 0.95, 1.06],
    light: [1.13, 1.0, 0.78],
    greenShade: [0.006, -0.008, -0.004],
    greenLit: [0.03, 0.006, -0.02],
    toe: [0.94, 0.034, 0.036, 0.044],
    haze: [0.75, 0.55, 0, 0],
    hazeTint: [1.05, 1.0, 0.88],
    sky: [0.38, 0.035, 0.028, 0.012],
    skyTint: [1.07, 1.0, 0.84],
  },
  picture: {
    sg: [0.85, 0, 0, 0],
    shade: [0.93, 0.98, 1.08],
    light: [1.06, 1.01, 0.93],
    greenShade: [0.03, 0.05, -0.012],
    greenLit: [0.03, 0.05, -0.012],
    toe: [0.94, 0.06, 0.06, 0.06],
    haze: [0, 0, 0, 0],
    hazeTint: [1, 1, 1],
    sky: [0, 0.015, 0.02, 0.035],
    skyTint: [0.93, 1.0, 1.08],
  },
};
export const STORY_GRADE_DEFAULT = "fantasy";

/** Fill the Storybook grade uniforms from one of STORY_GRADES (unknown → the default). */
export function setStoryGrade(name) {
  const g = STORY_GRADES[name] || STORY_GRADES[STORY_GRADE_DEFAULT];
  LOOK.uLookSG.value.fromArray(g.sg);
  LOOK.uLookSGShade.value.fromArray(g.shade);
  LOOK.uLookSGLight.value.fromArray(g.light);
  LOOK.uLookSGGreenShade.value.fromArray(g.greenShade);
  LOOK.uLookSGGreenLit.value.fromArray(g.greenLit);
  LOOK.uLookSGToe.value.fromArray(g.toe);
  LOOK.uLookSGHaze.value.fromArray(g.haze);
  LOOK.uLookSGHazeTint.value.fromArray(g.hazeTint);
  LOOK.uLookSGSky.value.fromArray(g.sky);
  LOOK.uLookSGSkyTint.value.fromArray(g.skyTint);
  return STORY_GRADES[name] ? name : STORY_GRADE_DEFAULT;
}
setStoryGrade(STORY_GRADE_DEFAULT);

/* --- GLSL ------------------------------------------------------------------ */

/** Uniform declarations (both stages may include them). */
export const LOOK_PARS = /* glsl */ `
uniform vec4 uLookMist;
uniform vec3 uLookMistColor;
uniform vec3 uLookMistSun;
uniform vec4 uLookSun;
uniform vec4 uLookHazeGlow;
uniform vec3 uLookAerial;
uniform vec3 uLookFill;
uniform vec4 uLookGrade;
uniform vec3 uLookShadowTint;
uniform vec3 uLookHighTint;
uniform vec4 uLookScreen;
uniform vec4 uLookWind;
uniform vec4 uLookStory;
uniform vec4 uLookSG;
uniform vec3 uLookSGShade;
uniform vec3 uLookSGLight;
uniform vec3 uLookSGGreenShade;
uniform vec3 uLookSGGreenLit;
uniform vec4 uLookSGToe;
uniform vec4 uLookSGHaze;
uniform vec3 uLookSGHazeTint;
`;

/**
 * Value noise and the wind gust field (either stage; needs uLookWind). Gusts
 * are broad bands across the wind, warped by noise, rolling downwind — the
 * terrain's turf and the grass blades both read them, so a gust sweeping a
 * field lightens the ground texture and bends the blades together.
 */
export const LOOK_NOISE_GLSL = /* glsl */ `
float lookHash(vec2 p) {
  vec3 p3 = fract(vec3(p.xyx) * 0.1031);
  p3 += dot(p3, p3.yzx + 33.33);
  return fract((p3.x + p3.y) * p3.z);
}
float lookNoise(vec2 p) {
  vec2 i = floor(p);
  vec2 f = fract(p);
  vec2 u = f * f * (3.0 - 2.0 * f);
  return mix(mix(lookHash(i), lookHash(i + vec2(1.0, 0.0)), u.x), mix(lookHash(i + vec2(0.0, 1.0)), lookHash(i + vec2(1.0, 1.0)), u.x), u.y);
}
// 0 calm … ~1 in the heart of a gust at full wind strength.
float lookGust(vec2 p) {
  float along = dot(p, uLookWind.xy) - uLookWind.w;
  float warp = lookNoise(p * 0.012 + 7.3) * 3.0 + lookNoise(p * 0.031 - 2.1) * 1.2;
  float band = smoothstep(0.2, 1.0, sin(along * 0.07 + warp));
  return band * (0.45 + 0.55 * lookNoise(p * 0.02 - uLookWind.xy * uLookWind.w * 0.02)) * (0.35 + 0.65 * uLookWind.z);
}
`;

/**
 * Atmosphere + finish helpers (fragment). `lookAtmosphere` takes the colour in
 * fog space (after three's colourspace step), the fragment's world position,
 * the camera, three's linear fog factor and the fog colour, and returns the
 * hazed colour; `lookFinish` applies the vignette.
 */
export const LOOK_ATMOS_GLSL = /* glsl */ `
${LOOK_NOISE_GLSL}

// Exponential height mist between the eye and a point: the closed-form
// integral of density a·exp(-(y - base)/H) along the ray (patchy in xz).
float lookMistAmount(vec3 eye, vec3 wp) {
  if (uLookMist.x <= 0.0) return 0.0;
  vec3 rd = wp - eye;
  float dist = length(rd);
  float b = 1.0 / max(uLookMist.y, 0.5);
  float dy = rd.y;
  float k = abs(dy * b) > 1e-3 ? (1.0 - exp(-b * dy)) / (b * dy) : 1.0;
  float ey = max(eye.y - uLookMist.z, -40.0);
  // Banks: slow, broad noise drifting with the wind.
  vec2 q = wp.xz * 0.0065 + uLookWind.xy * uLookScreen.w * 0.004;
  float bank = mix(1.0, 0.25 + 1.5 * lookNoise(q) * lookNoise(q * 2.7 + 3.1), uLookMist.w);
  return 1.0 - exp(-uLookMist.x * bank * exp(-b * ey) * dist * k);
}

vec3 lookAtmosphere(vec3 col, vec3 wp, vec3 eye, float linFog, vec3 fogCol) {
  vec3 v = normalize(wp - eye);
  float sunward = max(dot(v, uLookSun.xyz), 0.0);
  float glow = sunward * sunward;
  glow *= glow;
  // Mist first (it lies close), lit from behind when you look toward the sun.
  float mist = lookMistAmount(eye, wp);
  col = mix(col, uLookMistColor + uLookMistSun * glow, mist);
  // Then the sky's haze — warmer toward the sun's azimuth, as the dome's
  // horizon is. Two-tone aerial perspective: the middle distance goes blue
  // first, the far distance pales into the horizon (exactly its colour once
  // linFog reaches 1).
  vec2 hv = normalize(v.xz + 1e-5);
  vec2 hs = normalize(uLookSun.xz + 1e-5);
  float az = dot(hv, hs) * 0.5 + 0.5;
  vec3 horizon = mix(fogCol, uLookHazeGlow.rgb, az * az * az * uLookHazeGlow.a);
  vec3 haze = mix(uLookAerial, horizon, smoothstep(0.15, 0.95, linFog));
  // Storybook: past ~140 m the land sinks into the grade's haze in layers,
  // well before the far haze, so ridges stack like cut paper — the aerial
  // blue, pulled toward the horizon colour, dulled and tinted by the grade.
  if (uLookStory.y > 0.0) {
    float sd = length(wp - eye);
    float sa = 1.0 - exp(-max(sd - 140.0, 0.0) / 650.0);
    float sl = dot(col, vec3(0.2126, 0.7152, 0.0722));
    vec3 wet = mix(uLookAerial, fogCol, uLookSGHaze.x);
    wet = mix(wet, vec3(dot(wet, vec3(0.2126, 0.7152, 0.0722))), uLookSGHaze.y) * uLookSGHazeTint;
    col = mix(col, wet * (0.84 + 0.3 * sl), sa * 0.55 * uLookStory.y);
  }
  return mix(col, haze, linFog);
}

// The haze thins with altitude: high ground sees through less of it, so the
// ridges and peaks stand out in layers. (Sea-level things — the horizon
// itself — are unaffected, so far water still meets the sky exactly.)
float lookHazeDepth(float depth, float worldY) {
  return depth * (1.0 - uLookSun.w * clamp((worldY - uLookMist.z) / 170.0, 0.0, 1.0));
}

vec3 lookFinish(vec3 col) {
  vec2 uv = gl_FragCoord.xy * uLookScreen.xy - 0.5;
  float vig = 1.0 - (uLookScreen.z + uLookSG.w * uLookStory.x) * smoothstep(0.18, 0.62, dot(uv, uv) * 1.6);
  return col * vig;
}
`;

/* --- Material patching ------------------------------------------------------ */

const VERT_PARS = /* glsl */ `
varying vec3 vLookWorld;
`;

// After fog_vertex: world position of the vertex (instancing / skinning applied).
const VERT_MAIN = /* glsl */ `
{
  vec4 lookW = vec4( transformed, 1.0 );
  #ifdef USE_BATCHING
    lookW = batchingMatrix * lookW;
  #endif
  #ifdef USE_INSTANCING
    lookW = instanceMatrix * lookW;
  #endif
  vLookWorld = ( modelMatrix * lookW ).xyz;
}
`;

const FRAG_PARS = /* glsl */ `
varying vec3 vLookWorld;
// How much key light reached this fragment (the directional shadow), for the cool fill.
float lookShadow = 1.0;
`;

/** Tone mapping, then the grade (linear, display-referred, before the sRGB encode). */
const FRAG_GRADE = /* glsl */ `
#if defined( TONE_MAPPING )
  gl_FragColor.rgb = toneMapping( gl_FragColor.rgb );
  gl_FragColor.rgb = lookGrade( gl_FragColor.rgb );
#endif
`;

export const LOOK_GRADE_GLSL = /* glsl */ `
vec3 lookGrade(vec3 c) {
  c = max(c, 0.0);
  float l = dot(c, vec3(0.2126, 0.7152, 0.0722));
  // Vibrance: lift muted colours more than already saturated ones.
  float sat = max(c.r, max(c.g, c.b)) - min(c.r, min(c.g, c.b));
  c = max(mix(vec3(l), c, 1.0 + uLookGrade.x * (1.0 - sat)), 0.0);
  // Split tone in a perceptual lightness: cool shadows, warm highlights.
  float pl = sqrt(l);
  vec3 tint = mix(uLookShadowTint, uLookHighTint, smoothstep(0.18, 0.78, pl));
  c *= mix(vec3(1.0), tint, uLookGrade.y);
  // Storybook: its colour grade (STORY_GRADES) — vibrance and desaturation,
  // greens nudged in shade and in sun, then a split tone.
  if (uLookStory.x > 0.0) {
    float sl = dot(c, vec3(0.2126, 0.7152, 0.0722));
    float ss = max(c.r, max(c.g, c.b)) - min(c.r, min(c.g, c.b));
    c = max(mix(vec3(sl), c, 1.0 + uLookStory.x * (uLookSG.x * (1.0 - ss) - uLookSG.z)), 0.0);
    float green = smoothstep(0.0, 0.05, c.g - max(c.r, c.b)) * smoothstep(0.0, 0.05, sl);
    float lit = smoothstep(0.08, 0.45, sl);
    c += uLookStory.x * green * mix(uLookSGGreenShade, uLookSGGreenLit, lit);
    vec3 st = mix(uLookSGShade, uLookSGLight, smoothstep(0.12, 0.72, sqrt(sl)));
    c = max(c * mix(vec3(1.0), st, uLookStory.x), 0.0); // (the S below takes a square root)
  }
  // A soft S around mid grey.
  vec3 s = sqrt(c);
  s = s + uLookGrade.z * (s - 0.5) * (1.0 - abs(2.0 * s - 1.0));
  // Storybook: the grade's own S and toe (shadows lifted into its tint).
  s = mix(s, s + uLookSG.y * (s - 0.5) * (1.0 - abs(2.0 * s - 1.0)), uLookStory.x);
  s = mix(s, s * uLookSGToe.x + uLookSGToe.yzw, uLookStory.x);
  return s * s;
}
`;

/** Fog replacement: three's linear haze factor, then lookAtmosphere + vignette. */
const FRAG_FOG = /* glsl */ `
#ifdef USE_FOG
  float lookDepth = lookHazeDepth( vFogDepth, vLookWorld.y );
  #ifdef FOG_EXP2
    float lookLin = 1.0 - exp( - fogDensity * fogDensity * lookDepth * lookDepth );
  #else
    float lookLin = smoothstep( fogNear, fogFar, lookDepth );
  #endif
  gl_FragColor.rgb = lookAtmosphere( gl_FragColor.rgb, vLookWorld, cameraPosition, lookLin, fogColor );
#endif
gl_FragColor.rgb = lookFinish( gl_FragColor.rgb );
`;

/**
 * Patch a MeshStandardMaterial shader (inside its onBeforeCompile, after the
 * material's own replacements).
 * @param {object} shader the onBeforeCompile shader
 * @param {{ wrap?: number, rim?: number, fill?: number }} [o]
 *   wrap: how far (0..1) the key light wraps past the terminator; rim: rim
 *   strength (0 off); fill: cool shadow-fill strength.
 */
export function patchLook(shader, { wrap = 0.45, rim = 0, fill = 1 } = {}) {
  Object.assign(shader.uniforms, LOOK);
  const defs = `#define LOOK_WRAP ${wrap.toFixed(3)}\n#define LOOK_RIM ${rim.toFixed(3)}\n#define LOOK_RIM_ON ${rim > 0 ? 1 : 0}\n#define LOOK_FILL ${fill.toFixed(3)}\n`;
  shader.vertexShader = shader.vertexShader
    .replace("#include <common>", `#include <common>\n${VERT_PARS}`)
    .replace("#include <fog_vertex>", `#include <fog_vertex>\n${VERT_MAIN}`);
  const lightsPars = THREE.ShaderChunk.lights_physical_pars_fragment.replace(
    "reflectedLight.directDiffuse += irradiance * BRDF_Lambert( material.diffuseColor );",
    /* glsl */ `{
		// Wrap the key light softly past the terminator (energy roughly kept),
		// and fill what it misses with the cool sky bounce.
		float lookNL = dot( geometryNormal, directLight.direction );
		float lookWrapNL = saturate( ( lookNL + LOOK_WRAP ) / ( 1.0 + LOOK_WRAP ) );
		// Storybook: the light falls in three soft bands, as a painter would lay it.
		float lookBandT = lookWrapNL * 3.0;
		float lookBand = ( floor( lookBandT ) + smoothstep( 0.3, 0.7, fract( lookBandT ) ) ) / 3.0;
		lookWrapNL = mix( lookWrapNL, lookBand, uLookStory.z );
		reflectedLight.directDiffuse += lookWrapNL * ( 1.0 - 0.3 * LOOK_WRAP ) * directLight.color * BRDF_Lambert( material.diffuseColor );
		reflectedLight.directDiffuse += ( 1.0 - lookWrapNL * lookShadow ) * LOOK_FILL * uLookFill * BRDF_Lambert( material.diffuseColor );
	}`,
  );
  const lightsBegin = THREE.ShaderChunk.lights_fragment_begin.replace(
    "directLight.color *= ( directLight.visible && receiveShadow ) ? getShadow( directionalShadowMap[ i ], directionalLightShadow.shadowMapSize, directionalLightShadow.shadowIntensity, directionalLightShadow.shadowBias, directionalLightShadow.shadowRadius, vDirectionalShadowCoord[ i ] ) : 1.0;",
    "lookShadow = ( directLight.visible && receiveShadow ) ? getShadow( directionalShadowMap[ i ], directionalLightShadow.shadowMapSize, directionalLightShadow.shadowIntensity, directionalLightShadow.shadowBias, directionalLightShadow.shadowRadius, vDirectionalShadowCoord[ i ] ) : 1.0;\n\t\tdirectLight.color *= lookShadow;",
  );
  const rimGlsl = /* glsl */ `
#if LOOK_RIM_ON == 1 && NUM_DIR_LIGHTS > 0
{
  // Rim: a thin edge of light on silhouettes — the key light's colour when it
  // is behind the subject, the sky's otherwise — tinted by the surface.
  vec3 lookV = geometryViewDir;
  float lookEdge = 1.0 - saturate( dot( normal, lookV ) );
  lookEdge *= lookEdge;
  lookEdge *= lookEdge;
  float lookBack = saturate( dot( -lookV, directionalLights[ 0 ].direction ) );
  vec3 lookRimC = directionalLights[ 0 ].color * ( 0.04 + 0.6 * lookBack * lookBack ) * lookShadow;
  #if NUM_HEMI_LIGHTS > 0
    lookRimC += hemisphereLights[ 0 ].skyColor * 0.1;
  #endif
  outgoingLight += lookEdge * lookRimC * ( 0.35 + 0.65 * diffuseColor.rgb ) * LOOK_RIM * uLookGrade.w;
}
#endif
`;
  shader.fragmentShader = shader.fragmentShader
    .replace("#include <common>", `#include <common>\n${defs}${LOOK_PARS}${FRAG_PARS}${LOOK_GRADE_GLSL}${LOOK_ATMOS_GLSL}`)
    .replace("#include <lights_physical_pars_fragment>", lightsPars)
    .replace("#include <lights_fragment_begin>", lightsBegin)
    .replace("#include <opaque_fragment>", `${rimGlsl}\n#include <opaque_fragment>`)
    .replace("#include <tonemapping_fragment>", FRAG_GRADE)
    .replace("#include <fog_fragment>", FRAG_FOG);
}

/**
 * Keep the vignette's screen size current (drawing-buffer pixels).
 * @param {number} w
 * @param {number} h
 */
export function setLookScreen(w, h) {
  const s = LOOK.uLookScreen.value;
  s.x = 1 / Math.max(1, w);
  s.y = 1 / Math.max(1, h);
}
