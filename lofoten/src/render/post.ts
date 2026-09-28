// Post-processing: render → tone map / sRGB → subtle ordered (Bayer) dither
// with a cold shadow lift and soft vignette.

import * as THREE from 'three';
import { EffectComposer } from 'three/addons/postprocessing/EffectComposer.js';
import { OutputPass } from 'three/addons/postprocessing/OutputPass.js';
import { RenderPass } from 'three/addons/postprocessing/RenderPass.js';
import { ShaderPass } from 'three/addons/postprocessing/ShaderPass.js';

export const DitherShader = {
  name: 'OrderedDither',
  uniforms: {
    tDiffuse: { value: null },
    levels: { value: 30 },
    strength: { value: 1 },
    cell: { value: 1 },
    lift: { value: new THREE.Color(0.012, 0.02, 0.045) },
    vignette: { value: 0.35 },
  },
  vertexShader: /* glsl */ `
    varying vec2 vUv;
    void main() {
      vUv = uv;
      gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
    }
  `,
  fragmentShader: /* glsl */ `
    uniform sampler2D tDiffuse;
    uniform float levels;
    uniform float strength;
    uniform float cell;
    uniform vec3 lift;
    uniform float vignette;
    varying vec2 vUv;

    // Compact recursive Bayer matrix (values in [0, 1)).
    float bayer2(vec2 a) { a = floor(a); return fract(dot(a, vec2(0.5, a.y * 0.75))); }
    float bayer4(vec2 a) { return bayer2(0.5 * a) * 0.25 + bayer2(a); }
    float bayer8(vec2 a) { return bayer4(0.5 * a) * 0.25 + bayer2(a); }

    void main() {
      vec3 c = texture2D(tDiffuse, vUv).rgb;
      // Cold lift so the darkest shadows stay readable midnight blue, not black.
      c = c + lift * (1.0 - c);
      // Vignette.
      vec2 q = vUv - 0.5;
      c *= 1.0 - vignette * smoothstep(0.25, 0.85, dot(q, q) * 2.2);
      // Ordered dither + quantize.
      float b = bayer8(floor(gl_FragCoord.xy / cell)) - 0.5;
      vec3 d = floor(c * levels + 0.5 + b) / levels;
      c = mix(c, d, strength);
      gl_FragColor = vec4(c, 1.0);
    }
  `,
};

export function buildPost(renderer: THREE.WebGLRenderer, scene: THREE.Scene, camera: THREE.Camera) {
  const size = renderer.getDrawingBufferSize(new THREE.Vector2());
  const target = new THREE.WebGLRenderTarget(size.x, size.y, { type: THREE.HalfFloatType, samples: 4 });
  const composer = new EffectComposer(renderer, target);
  composer.addPass(new RenderPass(scene, camera));
  composer.addPass(new OutputPass());
  const dither = new ShaderPass(DitherShader);
  composer.addPass(dither);
  return { composer, dither };
}
