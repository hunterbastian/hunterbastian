import * as THREE from "three";

// Shared uniforms injected into every "PS1" material.
export const globalUniforms = {
  uSnapRes: { value: new THREE.Vector2(320, 180) },
  uTime: { value: 0 },
};

type Ps1Options = {
  /** Sway vertices in the wind; strength scales with local height (y). */
  wind?: number;
  /** Snap vertices to the low-res pixel grid (the classic PS1 wobble). */
  snap?: boolean;
};

const SNAP_GLSL = /* glsl */ `
  #include <project_vertex>
  {
    vec4 snapped = gl_Position;
    snapped.xyz /= snapped.w;
    vec2 grid = uSnapRes * 0.5;
    snapped.xy = floor(snapped.xy * grid + 0.5) / grid;
    snapped.xyz *= snapped.w;
    gl_Position = snapped;
  }
`;

const WIND_GLSL = /* glsl */ `
  #include <begin_vertex>
  {
    vec4 wp = modelMatrix * vec4(transformed, 1.0);
    #ifdef USE_INSTANCING
      wp = modelMatrix * instanceMatrix * vec4(transformed, 1.0);
    #endif
    float h = max(transformed.y, 0.0);
    float phase = wp.x * 0.35 + wp.z * 0.27;
    float gust = sin(uTime * 1.3 + phase) * 0.6 + sin(uTime * 2.7 + phase * 1.7) * 0.25;
    transformed.x += gust * h * uWind;
    transformed.z += cos(uTime * 1.1 + phase) * 0.4 * h * uWind;
  }
`;

/** Patch a built-in material with vertex snapping and optional wind. */
export function ps1<T extends THREE.Material>(mat: T, opts: Ps1Options = {}): T {
  const snap = opts.snap ?? true;
  const wind = opts.wind ?? 0;
  mat.onBeforeCompile = (shader) => {
    shader.uniforms.uSnapRes = globalUniforms.uSnapRes;
    shader.uniforms.uTime = globalUniforms.uTime;
    shader.uniforms.uWind = { value: wind };
    shader.vertexShader =
      "uniform vec2 uSnapRes;\nuniform float uTime;\nuniform float uWind;\n" + shader.vertexShader;
    if (wind > 0) shader.vertexShader = shader.vertexShader.replace("#include <begin_vertex>", WIND_GLSL);
    if (snap) shader.vertexShader = shader.vertexShader.replace("#include <project_vertex>", SNAP_GLSL);
  };
  mat.customProgramCacheKey = () => `ps1-${snap}-${wind}`;
  return mat;
}

/** Flat-shaded Lambert with vertex colors — the workhorse material. */
export function lambert(params: THREE.MeshLambertMaterialParameters = {}, opts: Ps1Options = {}) {
  return ps1(new THREE.MeshLambertMaterial({ flatShading: true, ...params }), opts);
}
