// Dark fjord water: a planar reflection (three's Reflector) sampled through
// gently animated ripple normals, so lights and aurora smear into streaks.

import * as THREE from 'three';
import { Reflector } from 'three/addons/objects/Reflector.js';
import { PALETTE } from '../world/palette';
import { MOON_DIR } from './sky';

const WaterShader = {
  name: 'FjordWater',
  uniforms: {
    color: { value: null },
    tDiffuse: { value: null },
    textureMatrix: { value: null },
    time: { value: 0 },
    waterColor: { value: new THREE.Color(PALETTE.water) },
    shallowColor: { value: new THREE.Color(PALETTE.waterShallow) },
    fogColor: { value: new THREE.Color(PALETTE.fog) },
    fogDensity: { value: 0.001 },
    moonDir: { value: MOON_DIR },
    distortion: { value: 0.022 },
  },
  vertexShader: /* glsl */ `
    uniform mat4 textureMatrix;
    varying vec4 vUv;
    varying vec3 vWorld;
    #include <common>
    #include <logdepthbuf_pars_vertex>
    void main() {
      vUv = textureMatrix * vec4(position, 1.0);
      vWorld = (modelMatrix * vec4(position, 1.0)).xyz;
      gl_Position = projectionMatrix * viewMatrix * vec4(vWorld, 1.0);
      #include <logdepthbuf_vertex>
    }
  `,
  fragmentShader: /* glsl */ `
    uniform sampler2D tDiffuse;
    uniform vec3 color;
    uniform float time;
    uniform vec3 waterColor;
    uniform vec3 shallowColor;
    uniform vec3 fogColor;
    uniform float fogDensity;
    uniform vec3 moonDir;
    uniform float distortion;
    varying vec4 vUv;
    varying vec3 vWorld;
    #include <logdepthbuf_pars_fragment>

    vec2 wave(vec2 p, vec2 dir, float freq, float speed, float amp) {
      float ph = dot(p, dir) * freq + time * speed;
      return dir * (freq * amp * cos(ph));
    }

    void main() {
      #include <logdepthbuf_fragment>
      vec2 p = vWorld.xz;
      vec2 g = vec2(0.0);
      g += wave(p, normalize(vec2(0.8, 0.6)), 0.21, 0.9, 0.05);
      g += wave(p, normalize(vec2(-0.5, 0.86)), 0.33, 1.3, 0.035);
      g += wave(p, normalize(vec2(0.2, -0.98)), 0.57, 1.7, 0.02);
      g += wave(p, normalize(vec2(-0.93, -0.35)), 0.91, 2.3, 0.012);
      g += wave(p, normalize(vec2(0.62, -0.78)), 1.73, 3.1, 0.006);
      g += wave(p, normalize(vec2(-0.1, 0.99)), 2.9, 3.9, 0.003);

      vec3 toCam = cameraPosition - vWorld;
      float dist = length(toCam);
      vec3 V = toCam / dist;
      // Ripples calm down with distance so the far fjord stays mirror-like.
      float calm = 1.0 / (1.0 + dist * 0.012);
      vec3 N = normalize(vec3(-g.x * calm, 1.0, -g.y * calm));

      float fres = 0.02 + 0.98 * pow(1.0 - max(dot(N, V), 0.0), 5.0);

      vec4 uv = vUv;
      // Stretch distortion vertically so lights become streaks.
      uv.xy += vec2(N.x * 0.6, N.z * 1.6) * distortion * uv.w * (0.4 + 0.6 * calm);
      vec3 refl = texture2DProj(tDiffuse, uv).rgb;

      vec3 base = mix(waterColor, shallowColor, 0.25 + 0.25 * N.x);
      vec3 col = mix(base, refl * 0.9, clamp(0.5 + fres * 0.6, 0.0, 1.0));
      // Faint sky sheen on ripple faces tilted toward the viewer keeps the
      // surface readable even where the reflection is dark.
      float sheen = clamp(dot(N.xz, normalize(V.xz + 1e-4)) * 6.0, 0.0, 1.0) * calm;
      col += vec3(0.03, 0.06, 0.1) * sheen;

      // Moon glitter.
      vec3 R = reflect(-V, N);
      float spec = pow(max(dot(R, moonDir), 0.0), 350.0);
      col += vec3(0.7, 0.8, 1.0) * spec * 0.6;

      float fogF = 1.0 - exp(-fogDensity * fogDensity * dist * dist);
      col = mix(col, fogColor, fogF);

      gl_FragColor = vec4(col, 1.0);
      #include <tonemapping_fragment>
      #include <colorspace_fragment>
    }
  `,
};

export function buildWater(width: number, height: number, fog: THREE.FogExp2) {
  const geom = new THREE.PlaneGeometry(9000, 9000);
  const water = new Reflector(geom, {
    shader: WaterShader,
    textureWidth: width,
    textureHeight: height,
    clipBias: 0.002,
    color: 0xffffff,
    multisample: 0,
  });
  water.rotation.x = -Math.PI / 2;
  water.position.y = 0;
  water.name = 'water';
  const mat = water.material as THREE.ShaderMaterial;
  mat.uniforms.fogDensity.value = fog.density;
  (mat.uniforms.fogColor.value as THREE.Color).copy(fog.color);
  return {
    mesh: water,
    update(time: number) {
      mat.uniforms.time.value = time;
    },
    resize(w: number, h: number) {
      water.getRenderTarget().setSize(w, h);
    },
  };
}
