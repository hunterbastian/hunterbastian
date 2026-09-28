// Soft additive halos around windows and lamps, drawn as one point cloud.

import * as THREE from 'three';
import { GlowSpec } from '../world/context';

export function buildGlows(specs: GlowSpec[], fog: THREE.FogExp2) {
  const n = specs.length;
  const pos = new Float32Array(n * 3);
  const col = new Float32Array(n * 3);
  const size = new Float32Array(n);
  const flicker = new Float32Array(n);
  const c = new THREE.Color();
  specs.forEach((s, i) => {
    pos.set([s.x, s.y, s.z], i * 3);
    c.set(s.color);
    col.set([c.r, c.g, c.b], i * 3);
    size[i] = s.size;
    flicker[i] = s.flicker ?? 0;
  });
  const geom = new THREE.BufferGeometry();
  geom.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  geom.setAttribute('color', new THREE.BufferAttribute(col, 3));
  geom.setAttribute('size', new THREE.BufferAttribute(size, 1));
  geom.setAttribute('flicker', new THREE.BufferAttribute(flicker, 1));

  const material = new THREE.ShaderMaterial({
    uniforms: {
      time: { value: 0 },
      scale: { value: 800 },
      intensity: { value: 0.42 },
      fogDensity: { value: fog.density },
    },
    vertexShader: /* glsl */ `
      attribute float size;
      attribute float flicker;
      attribute vec3 color;
      uniform float time;
      uniform float scale;
      uniform float fogDensity;
      varying vec3 vColor;
      varying float vAlpha;
      void main() {
        vec4 mv = modelViewMatrix * vec4(position, 1.0);
        float dist = -mv.z;
        gl_Position = projectionMatrix * mv;
        gl_PointSize = clamp(size * scale / max(dist, 0.1), 1.0, 320.0);
        float f = sin(time * 6.3 + position.x * 12.9 + position.z * 7.1) * 0.5
                + sin(time * 11.7 + position.y * 31.3) * 0.5;
        float fogF = exp(-fogDensity * fogDensity * dist * dist);
        vAlpha = (1.0 - flicker * (0.5 + 0.5 * f)) * fogF;
        vColor = color;
      }
    `,
    fragmentShader: /* glsl */ `
      uniform float intensity;
      varying vec3 vColor;
      varying float vAlpha;
      void main() {
        float d = length(gl_PointCoord - 0.5) * 2.0;
        if (d > 1.0) discard;
        float halo = pow(1.0 - d, 2.4);
        float core = smoothstep(0.22, 0.0, d);
        vec3 col = vColor * (halo * intensity + core * 0.6);
        gl_FragColor = vec4(col * vAlpha, 1.0);
          #include <colorspace_fragment>
      }
    `,
    transparent: true,
    depthWrite: false,
    blending: THREE.AdditiveBlending,
  });
  const points = new THREE.Points(geom, material);
  points.name = 'glows';
  points.frustumCulled = false;
  points.renderOrder = 5;
  return points;
}
