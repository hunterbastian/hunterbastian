import * as THREE from 'three';
import { LOW_QUALITY, WORLD_SIZE } from './config';
import { fbm, rng } from './noise';
import { heightAt } from './terrain';

export interface GrassUniforms {
  uPathMask: { value: THREE.Texture };
  uWorld: { value: number };
  uTime: { value: number };
  uWind: { value: number };
}

/** One tapered, slightly curved blade, 1 unit tall. Normals point up for soft, even shading. */
function bladeGeometry(): THREE.BufferGeometry {
  const segs = 4;
  const width = 0.075;
  const positions: number[] = [];
  const colors: number[] = [];
  const normals: number[] = [];
  const indices: number[] = [];
  const base = new THREE.Color().setHex(0x16280a, THREE.SRGBColorSpace);
  const tip = new THREE.Color().setHex(0xa9bd62, THREE.SRGBColorSpace);
  const c = new THREE.Color();

  for (let i = 0; i <= segs; i++) {
    const t = i / segs;
    const w = (width / 2) * (1 - t * 0.85);
    const bend = t * t * 0.18;
    c.copy(base).lerp(tip, Math.pow(t, 0.9));
    for (const side of [-1, 1]) {
      positions.push(side * w, t, bend);
      colors.push(c.r, c.g, c.b);
      normals.push(0, 1, 0);
    }
  }
  // Tip vertex.
  positions.push(0, 1.08, 0.22);
  colors.push(tip.r, tip.g, tip.b);
  normals.push(0, 1, 0);

  for (let i = 0; i < segs; i++) {
    const a = i * 2;
    indices.push(a, a + 1, a + 2, a + 1, a + 3, a + 2);
  }
  const last = segs * 2;
  indices.push(last, last + 1, last + 2);

  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
  geo.setAttribute('color', new THREE.Float32BufferAttribute(colors, 3));
  geo.setAttribute('normal', new THREE.Float32BufferAttribute(normals, 3));
  geo.setIndex(indices);
  return geo;
}

function grassMaterial(uniforms: GrassUniforms): THREE.MeshLambertMaterial {
  const mat = new THREE.MeshLambertMaterial({ vertexColors: true, side: THREE.DoubleSide });
  mat.onBeforeCompile = (shader) => {
    Object.assign(shader.uniforms, uniforms);
    shader.vertexShader = shader.vertexShader
      .replace(
        '#include <common>',
        `#include <common>
uniform sampler2D uPathMask;
uniform float uWorld;
uniform float uTime;
uniform float uWind;`,
      )
      .replace(
        '#include <begin_vertex>',
        `#include <begin_vertex>
vec3 msRoot = instanceMatrix[3].xyz;
float msMask = texture2D(uPathMask, msRoot.xz / uWorld + 0.5).r;
// Blades shrink toward path edges and vanish on the path itself.
transformed.y *= 1.0 - smoothstep(0.18, 0.62, msMask);
// Far blades get wider so thinned-out LOD chunks still read as a lawn.
float msDist = distance(msRoot, cameraPosition);
transformed.x *= 1.0 + smoothstep(8.0, 48.0, msDist) * 2.6;`,
      )
      .replace(
        '#include <project_vertex>',
        `vec4 mvPosition = vec4(transformed, 1.0);
mvPosition = instanceMatrix * mvPosition;
{
  float h = position.y;
  float bladeH = length(instanceMatrix[1].xyz);
  vec2 w = msRoot.xz;
  float gust = sin(uTime * 1.1 + w.x * 0.21 + w.y * 0.13) * 0.55
             + sin(uTime * 2.3 + w.x * 0.77 - w.y * 0.41) * 0.25
             + sin(uTime * 4.1 + w.x * 1.9 + w.y * 1.3) * 0.12;
  float sway = (0.35 + gust) * uWind * h * h * bladeH;
  mvPosition.xz += normalize(vec2(1.0, 0.45)) * sway;
  mvPosition.y -= abs(sway) * 0.3 * h;
}
mvPosition = modelViewMatrix * mvPosition;
gl_Position = projectionMatrix * mvPosition;`,
      );
    // Double-sided blades keep their upward normal on both faces.
    shader.fragmentShader = shader.fragmentShader.replace(
      '#include <normal_fragment_begin>',
      `float faceDirection = 1.0;
vec3 normal = normalize(vNormal);
vec3 nonPerturbedNormal = normal;`,
    );
  };
  return mat;
}

interface Chunk {
  mesh: THREE.InstancedMesh;
  center: THREE.Vector3;
  max: number;
}

/**
 * The lawn: a grid of instanced chunks. Each chunk's instances are stored in random
 * order, so lowering `mesh.count` thins it evenly — that's our distance LOD.
 */
export class Grass {
  readonly group = new THREE.Group();
  private chunks: Chunk[] = [];

  constructor(uniforms: GrassUniforms) {
    const geo = bladeGeometry();
    const mat = grassMaterial(uniforms);
    const chunkSize = 8;
    const perChunkSide = WORLD_SIZE / chunkSize;
    const density = LOW_QUALITY ? 22 : 44; // blades per square unit
    const perChunk = Math.round(chunkSize * chunkSize * density);
    const m = new THREE.Matrix4();
    const q = new THREE.Quaternion();
    const e = new THREE.Euler();
    const s = new THREE.Vector3();
    const p = new THREE.Vector3();
    const color = new THREE.Color();
    const lush = new THREE.Color().setHex(0x5f8c34, THREE.SRGBColorSpace);
    const dry = new THREE.Color().setHex(0xa9ad62, THREE.SRGBColorSpace);
    const cool = new THREE.Color().setHex(0x4f8a4a, THREE.SRGBColorSpace);
    const random = rng(1337);

    for (let cz = 0; cz < perChunkSide; cz++) {
      for (let cx = 0; cx < perChunkSide; cx++) {
        const x0 = -WORLD_SIZE / 2 + cx * chunkSize;
        const z0 = -WORLD_SIZE / 2 + cz * chunkSize;
        const mesh = new THREE.InstancedMesh(geo, mat, perChunk);
        mesh.receiveShadow = true;
        mesh.castShadow = false;
        for (let i = 0; i < perChunk; i++) {
          const x = x0 + random() * chunkSize;
          const z = z0 + random() * chunkSize;
          p.set(x, heightAt(x, z) - 0.02, z);
          e.set((random() - 0.5) * 0.35, random() * Math.PI * 2, (random() - 0.5) * 0.35);
          q.setFromEuler(e);
          const clump = fbm(x * 0.18, z * 0.18, 2, 3);
          const h = (0.32 + random() * 0.32) * (0.7 + clump * 0.9);
          const w = 0.75 + random() * 0.5;
          s.set(w, h, w);
          m.compose(p, q, s);
          mesh.setMatrixAt(i, m);

          const patch = fbm(x * 0.05 + 40, z * 0.05, 3);
          color.copy(lush).lerp(dry, THREE.MathUtils.smoothstep(patch, 0.5, 0.8) * 0.6);
          color.lerp(cool, random() * 0.35);
          color.multiplyScalar(0.8 + random() * 0.35);
          mesh.setColorAt(i, color);
        }
        mesh.computeBoundingSphere();
        this.group.add(mesh);
        this.chunks.push({
          mesh,
          center: new THREE.Vector3(x0 + chunkSize / 2, heightAt(x0 + chunkSize / 2, z0 + chunkSize / 2), z0 + chunkSize / 2),
          max: perChunk,
        });
      }
    }
  }

  update(camera: THREE.Camera): void {
    for (const c of this.chunks) {
      const d = c.center.distanceTo(camera.position);
      const k = THREE.MathUtils.clamp(1 - (d - 14) / 46, 0.1, 1);
      c.mesh.count = Math.floor(c.max * k * k);
    }
  }
}
