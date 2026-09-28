// Night sky: gradient dome, twinkling stars and a low moon.

import * as THREE from 'three';
import { rng } from '../core/math';
import { PALETTE } from '../world/palette';

export const MOON_DIR = new THREE.Vector3(0.55, 0.42, 0.72).normalize(); // south-east, low

export function buildSky() {
  const group = new THREE.Group();
  group.name = 'sky';

  const dome = new THREE.Mesh(
    new THREE.SphereGeometry(4000, 48, 24),
    new THREE.ShaderMaterial({
      side: THREE.BackSide,
      depthWrite: false,
      uniforms: {
        zenith: { value: new THREE.Color(PALETTE.skyZenith) },
        mid: { value: new THREE.Color(PALETTE.skyMid) },
        horizon: { value: new THREE.Color(PALETTE.skyHorizon) },
        aurora: { value: new THREE.Color(PALETTE.auroraGreen) },
        moonDir: { value: MOON_DIR },
        time: { value: 0 },
      },
      vertexShader: /* glsl */ `
        varying vec3 vDir;
        void main() {
          vDir = normalize(position);
          vec4 p = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
          gl_Position = p.xyww; // pin to the far plane
        }
      `,
      fragmentShader: /* glsl */ `
        uniform vec3 zenith, mid, horizon, aurora, moonDir;
        uniform float time;
        varying vec3 vDir;
        void main() {
          vec3 d = normalize(vDir);
          float h = d.y;
          vec3 col = mix(horizon, mid, smoothstep(-0.02, 0.22, h));
          col = mix(col, zenith, smoothstep(0.18, 0.85, h));
          // Faint green airglow toward the northern horizon, under the aurora.
          float north = clamp(-d.z, 0.0, 1.0);
          float band = exp(-abs(h - 0.12) * 7.0) * smoothstep(0.1, 0.9, north);
          col += aurora * band * (0.05 + 0.015 * sin(time * 0.2 + d.x * 3.0));
          // Moon halo.
          float m = max(dot(d, moonDir), 0.0);
          col += vec3(0.55, 0.65, 0.85) * (pow(m, 12.0) * 0.06 + pow(m, 90.0) * 0.12);
          if (h < 0.0) col = mix(col, horizon * 0.6, smoothstep(0.0, -0.1, h));
          gl_FragColor = vec4(col, 1.0);
        }
      `,
    }),
  );
  dome.renderOrder = -10;
  dome.frustumCulled = false;
  group.add(dome);

  // Stars.
  const r = rng(77);
  const count = 3200;
  const pos = new Float32Array(count * 3);
  const mag = new Float32Array(count);
  const tint = new Float32Array(count * 3);
  for (let i = 0; i < count; i++) {
    // Uniform on the upper hemisphere, denser toward the zenith is not needed.
    const u = r();
    const v = r() * 0.97 + 0.03;
    const theta = u * Math.PI * 2;
    const y = v;
    const rad = Math.sqrt(1 - y * y);
    pos.set([Math.cos(theta) * rad * 3600, y * 3600, Math.sin(theta) * rad * 3600], i * 3);
    mag[i] = Math.pow(r(), 5) * 2.2 + 0.6;
    const warm = r();
    tint.set(warm < 0.15 ? [1, 0.85, 0.7] : warm > 0.75 ? [0.75, 0.85, 1] : [1, 1, 1], i * 3);
  }
  const sg = new THREE.BufferGeometry();
  sg.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  sg.setAttribute('mag', new THREE.BufferAttribute(mag, 1));
  sg.setAttribute('tint', new THREE.BufferAttribute(tint, 3));
  const stars = new THREE.Points(
    sg,
    new THREE.ShaderMaterial({
      uniforms: { time: { value: 0 }, pixelRatio: { value: 1 } },
      vertexShader: /* glsl */ `
        attribute float mag;
        attribute vec3 tint;
        uniform float time;
        uniform float pixelRatio;
        varying vec3 vCol;
        void main() {
          vec4 p = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
          gl_Position = p.xyww;
          float alt = normalize(position).y;
          float tw = 0.75 + 0.25 * sin(time * (1.5 + fract(position.x * 0.137) * 3.0) + position.z);
          float fade = smoothstep(0.02, 0.25, alt);
          gl_PointSize = mag * pixelRatio * (0.8 + 0.2 * tw);
          vCol = tint * (0.35 + 0.35 * mag) * tw * fade;
        }
      `,
      fragmentShader: /* glsl */ `
        varying vec3 vCol;
        void main() {
          float d = length(gl_PointCoord - 0.5) * 2.0;
          if (d > 1.0) discard;
          gl_FragColor = vec4(vCol * smoothstep(1.0, 0.2, d), 1.0);
        }
      `,
      transparent: true,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
    }),
  );
  stars.renderOrder = -9;
  stars.frustumCulled = false;
  group.add(stars);

  // Moon: a crisp disc with a gentle phase shadow.
  const moon = new THREE.Mesh(
    new THREE.PlaneGeometry(1, 1),
    new THREE.ShaderMaterial({
      transparent: true,
      depthWrite: false,
      uniforms: {},
      vertexShader: /* glsl */ `
        varying vec2 vUv;
        void main() {
          vUv = uv;
          vec4 p = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
          gl_Position = p.xyww;
        }
      `,
      fragmentShader: /* glsl */ `
        varying vec2 vUv;
        void main() {
          vec2 p = vUv * 2.0 - 1.0;
          float d = length(p);
          float disc = smoothstep(1.0, 0.96, d);
          float phase = smoothstep(-0.2, 0.6, length(p - vec2(-0.55, 0.15)));
          vec3 col = vec3(1.0, 1.0, 1.05) * (0.3 + 0.9 * phase);
          float glow = smoothstep(2.0, 0.9, d) * 0.12;
          gl_FragColor = vec4(col * disc + vec3(0.6, 0.7, 0.9) * glow, disc + glow);
        }
      `,
    }),
  );
  moon.position.copy(MOON_DIR).multiplyScalar(3400);
  moon.scale.setScalar(150);
  moon.lookAt(0, 0, 0);
  moon.renderOrder = -8;
  moon.frustumCulled = false;
  group.add(moon);

  return {
    group,
    update(time: number, camera: THREE.Camera, pixelRatio: number) {
      group.position.copy(camera.position);
      (dome.material as THREE.ShaderMaterial).uniforms.time.value = time;
      const sm = stars.material as THREE.ShaderMaterial;
      sm.uniforms.time.value = time;
      sm.uniforms.pixelRatio.value = pixelRatio;
    },
  };
}
