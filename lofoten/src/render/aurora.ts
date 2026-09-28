// Slowly flowing aurora curtains: folded ribbons high over the northern
// mountains, with vertical rays, a bright lower hem and a violet fringe.

import * as THREE from 'three';
import { PALETTE } from '../world/palette';

interface CurtainSpec {
  center: [number, number, number];
  yaw: number;
  span: number;
  base: number;
  height: number;
  fold: number;
  phase: number;
  strength: number;
}

const CURTAINS: CurtainSpec[] = [
  { center: [-120, 0, -1250], yaw: 0.12, span: 2600, base: 560, height: 640, fold: 240, phase: 0, strength: 1.0 },
  { center: [520, 0, -1500], yaw: -0.35, span: 2000, base: 640, height: 700, fold: 280, phase: 2.1, strength: 0.7 },
  { center: [-760, 0, -950], yaw: 0.6, span: 1500, base: 520, height: 460, fold: 170, phase: 4.2, strength: 0.55 },
  { center: [150, 0, -2200], yaw: 0.05, span: 3400, base: 900, height: 800, fold: 360, phase: 5.3, strength: 0.4 },
];

const vertexShader = /* glsl */ `
  uniform float time;
  uniform float span;
  uniform float base;
  uniform float height;
  uniform float fold;
  uniform float phase;
  varying vec2 vUv;
  varying float vFold;
  void main() {
    vUv = uv;
    float u = uv.x;
    float t = time * 0.05;
    // Slow travelling folds along the ribbon.
    float z = sin(u * 3.1 + phase + t * 1.3) * fold
            + sin(u * 7.9 - phase * 0.7 - t * 2.1) * fold * 0.35
            + sin(u * 17.0 + t * 3.7) * fold * 0.08;
    float x = (u - 0.5) * span + sin(u * 5.0 + t * 1.7 + phase) * fold * 0.25;
    float h = height * (0.8 + 0.25 * sin(u * 4.3 + phase - t * 1.1) + 0.12 * sin(u * 11.0 + t * 2.3));
    float y = base + uv.y * h;
    // Lean the top slightly away from the viewer, like a real curtain.
    z -= uv.y * h * 0.35;
    // How edge-on this part of the fold is (brighter where it folds).
    float dz = cos(u * 3.1 + phase + t * 1.3) * 3.1 * fold + cos(u * 7.9 - phase * 0.7 - t * 2.1) * 7.9 * fold * 0.35;
    vFold = clamp(abs(dz) / (span * 1.2), 0.0, 1.0);
    vec4 world = modelMatrix * vec4(x, y, z, 1.0);
    gl_Position = projectionMatrix * viewMatrix * world;
  }
`;

const fragmentShader = /* glsl */ `
  uniform float time;
  uniform float phase;
  uniform float strength;
  uniform vec3 green;
  uniform vec3 teal;
  uniform vec3 violet;
  varying vec2 vUv;
  varying float vFold;

  float hash(float n) { return fract(sin(n) * 43758.5453); }
  float noise1(float x) {
    float i = floor(x);
    float f = fract(x);
    f = f * f * (3.0 - 2.0 * f);
    return mix(hash(i), hash(i + 1.0), f);
  }

  void main() {
    float u = vUv.x;
    float v = vUv.y;
    float t = time;
    // Vertical rays drifting sideways at different speeds.
    float rays = noise1(u * 180.0 + t * 0.35 + phase * 10.0) * 0.55
               + noise1(u * 520.0 - t * 0.9) * 0.3
               + noise1(u * 60.0 + t * 0.12) * 0.45;
    rays = pow(clamp(rays, 0.0, 1.4) / 1.4, 1.6);
    // Sharp lower hem, long soft fade upward.
    float hem = smoothstep(0.0, 0.035, v);
    float rise = exp(-v * 2.6);
    float rim = exp(-pow((v - 0.05) * 22.0, 2.0));
    // Fade out at the ends and breathe slowly along the length.
    float ends = smoothstep(0.0, 0.14, u) * smoothstep(1.0, 0.86, u);
    float breathe = 0.55 + 0.45 * sin(u * 9.0 - t * 0.21 + phase) * sin(u * 3.3 + t * 0.13);
    float pulse = 0.85 + 0.15 * sin(t * 0.5 + phase);

    vec3 col = mix(green, teal, smoothstep(0.05, 0.45, v));
    col = mix(col, violet, smoothstep(0.4, 0.95, v) * 0.85);

    float a = hem * ends * breathe * pulse * (rise * (0.25 + 0.9 * rays) + rim * 0.9);
    a *= 0.7 + vFold * 1.2;
    gl_FragColor = vec4(col * a * strength, 1.0);
          #include <colorspace_fragment>
  }
`;

export function buildAurora() {
  const group = new THREE.Group();
  group.name = 'aurora';
  const materials: THREE.ShaderMaterial[] = [];
  for (const c of CURTAINS) {
    const geom = new THREE.PlaneGeometry(1, 1, 220, 1);
    geom.translate(0.5, 0.5, 0); // positions unused; uv drives the shape
    const mat = new THREE.ShaderMaterial({
      uniforms: {
        time: { value: 0 },
        span: { value: c.span },
        base: { value: c.base },
        height: { value: c.height },
        fold: { value: c.fold },
        phase: { value: c.phase },
        strength: { value: c.strength * 0.85 },
        green: { value: new THREE.Color(PALETTE.auroraGreen) },
        teal: { value: new THREE.Color(PALETTE.auroraTeal) },
        violet: { value: new THREE.Color(PALETTE.auroraViolet) },
      },
      vertexShader,
      fragmentShader,
      transparent: true,
      depthWrite: false,
      side: THREE.DoubleSide,
      blending: THREE.AdditiveBlending,
    });
    materials.push(mat);
    const mesh = new THREE.Mesh(geom, mat);
    mesh.position.set(...c.center);
    mesh.rotation.y = c.yaw;
    mesh.frustumCulled = false;
    mesh.renderOrder = -5;
    group.add(mesh);
  }
  return {
    group,
    update(time: number) {
      for (const m of materials) m.uniforms.time.value = time;
    },
  };
}
