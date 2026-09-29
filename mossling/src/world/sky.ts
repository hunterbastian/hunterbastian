import * as THREE from "three";
import { COLORS } from "../palette";
import { mulberry32 } from "./noise";

// Late-afternoon sky: a warm haze at the horizon melting up into a dusty
// sage blue, a soft sun, and chunky clouds drifting overhead. The dither
// pass turns the gradient into lovely stippled bands.

export const SUN_DIR = new THREE.Vector3(-0.55, 0.42, -0.72).normalize();

export function createSky() {
  const group = new THREE.Group();

  const skyMat = new THREE.ShaderMaterial({
    side: THREE.BackSide,
    depthWrite: false,
    fog: false,
    uniforms: {
      uTop: { value: new THREE.Color(COLORS.skyTop) },
      uHorizon: { value: new THREE.Color(COLORS.skyHorizon) },
      uFog: { value: new THREE.Color(COLORS.fog) },
      uSun: { value: new THREE.Color(COLORS.sun) },
      uSunDir: { value: SUN_DIR },
    },
    vertexShader: /* glsl */ `
      varying vec3 vDir;
      void main() {
        vDir = normalize(position);
        vec4 p = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
        gl_Position = p.xyww;
      }
    `,
    fragmentShader: /* glsl */ `
      uniform vec3 uTop, uHorizon, uFog, uSun, uSunDir;
      varying vec3 vDir;
      void main() {
        vec3 d = normalize(vDir);
        float h = d.y;
        vec3 col = mix(uHorizon, uTop, smoothstep(0.02, 0.55, h));
        col = mix(uFog, col, smoothstep(-0.05, 0.12, h));
        float s = max(dot(d, uSunDir), 0.0);
        col = mix(col, uSun, pow(s, 18.0) * 0.55);
        col += uSun * pow(s, 4.0) * 0.12;
        col = mix(col, vec3(1.0, 0.98, 0.9), smoothstep(0.9975, 0.999, s));
        gl_FragColor = vec4(col, 1.0);
      }
    `,
  });
  const sky = new THREE.Mesh(new THREE.SphereGeometry(400, 24, 12), skyMat);
  sky.renderOrder = -1;
  sky.frustumCulled = false;
  // Keep the dome centred on whoever is looking at it.
  sky.onBeforeRender = (_r, _s, cam) => {
    sky.position.copy(cam.position);
    sky.updateMatrixWorld();
  };
  group.add(sky);

  // Clouds: clusters of squashed icosahedrons, bright on top, lilac below.
  const rand = mulberry32(99);
  const cloudGeo = new THREE.IcosahedronGeometry(1, 0);
  const cloudMat = new THREE.MeshLambertMaterial({
    color: 0xf6ecd2,
    // Strong self-light so undersides stay soft cream instead of rock-brown.
    emissive: 0xb3a88a,
    flatShading: true,
    fog: false,
  });
  const clouds: THREE.Group[] = [];
  for (let i = 0; i < 14; i++) {
    const c = new THREE.Group();
    const puffs = 3 + Math.floor(rand() * 4);
    for (let k = 0; k < puffs; k++) {
      const m = new THREE.Mesh(cloudGeo, cloudMat);
      const s = 4 + rand() * 5;
      m.position.set((k - puffs / 2) * 5 + rand() * 3, rand() * 2.5, rand() * 5 - 2.5);
      m.scale.set(s * 1.3, s * 0.6, s);
      m.rotation.set(rand(), rand() * 6, rand());
      c.add(m);
    }
    const a = rand() * Math.PI * 2;
    const r = 60 + rand() * 120;
    c.position.set(Math.cos(a) * r, 45 + rand() * 25, Math.sin(a) * r);
    c.rotation.y = rand() * 0.5;
    group.add(c);
    clouds.push(c);
  }

  return {
    group,
    update: (_t: number, dt: number) => {
      for (const c of clouds) {
        c.position.x += dt * 1.2;
        if (c.position.x > 200) c.position.x -= 400;
      }
    },
  };
}
