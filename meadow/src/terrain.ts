import * as THREE from 'three';
import { WORLD_SIZE } from './config';
import { fbm, glslNoise } from './noise';

const HILL_CENTER = { x: -4, z: -26 };

/** Height of the ground at a world XZ position. Pure function — used by everything. */
export function heightAt(x: number, z: number): number {
  const dx = x - HILL_CENTER.x;
  const dz = z - HILL_CENTER.z;
  const hill = 11 * Math.exp(-(dx * dx + dz * dz) / (2 * 20 * 20));
  const roll = (fbm(x * 0.035 + 11.3, z * 0.035 - 4.1, 4) - 0.5) * 4.2;
  const small = (fbm(x * 0.16, z * 0.16, 2, 7) - 0.5) * 0.35;
  return hill + roll + small;
}

export interface TerrainUniforms {
  uPathMask: { value: THREE.Texture };
  uWorld: { value: number };
}

export function createTerrain(uniforms: TerrainUniforms): THREE.Mesh {
  const segments = 240;
  const geo = new THREE.PlaneGeometry(WORLD_SIZE, WORLD_SIZE, segments, segments);
  geo.rotateX(-Math.PI / 2);
  const pos = geo.attributes.position as THREE.BufferAttribute;
  for (let i = 0; i < pos.count; i++) {
    pos.setY(i, heightAt(pos.getX(i), pos.getZ(i)));
  }
  geo.computeVertexNormals();

  const mat = new THREE.MeshLambertMaterial({ color: 0xffffff });
  mat.onBeforeCompile = (shader) => {
    Object.assign(shader.uniforms, uniforms);
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', '#include <common>\nvarying vec3 vMsWorld;')
      .replace(
        '#include <begin_vertex>',
        '#include <begin_vertex>\nvMsWorld = (modelMatrix * vec4(transformed, 1.0)).xyz;',
      );
    shader.fragmentShader = shader.fragmentShader
      .replace(
        '#include <common>',
        `#include <common>
varying vec3 vMsWorld;
uniform sampler2D uPathMask;
uniform float uWorld;
${glslNoise}`,
      )
      .replace(
        '#include <color_fragment>',
        `#include <color_fragment>
{
  vec2 p = vMsWorld.xz;
  float m = texture2D(uPathMask, p / uWorld + 0.5).r;
  float n = msNoise(p * 0.9);
  float n2 = msNoise(p * 7.0);
  float n3 = msNoise(p * 21.0);
  // Ground beneath the grass: deep, slightly mottled green.
  vec3 ground = mix(vec3(0.035, 0.07, 0.018), vec3(0.07, 0.11, 0.025), n);
  // Packed dirt with little pebbles.
  vec3 dirt = mix(vec3(0.20, 0.13, 0.07), vec3(0.33, 0.23, 0.13), n2);
  float pebble = smoothstep(0.72, 0.8, n3) * smoothstep(0.3, 0.8, m);
  dirt = mix(dirt, vec3(0.42, 0.33, 0.22), pebble);
  float edge = smoothstep(0.28, 0.55, m + (n2 - 0.5) * 0.22);
  // Darken the trampled rim where grass meets path.
  float rim = edge * (1.0 - smoothstep(0.55, 0.85, m));
  dirt *= 1.0 - rim * 0.35;
  diffuseColor.rgb = mix(ground, dirt, edge);
}`,
      );
  };

  const mesh = new THREE.Mesh(geo, mat);
  mesh.receiveShadow = true;
  mesh.name = 'terrain';
  return mesh;
}

/** Cheap analytic ray/terrain intersection by marching the height function. */
export function raycastTerrain(ray: THREE.Ray, maxDist = 220): THREE.Vector3 | null {
  const p = new THREE.Vector3();
  let prevT = 0;
  let step = 0.35;
  for (let t = 0; t < maxDist; t += step) {
    ray.at(t, p);
    if (p.y <= heightAt(p.x, p.z)) {
      // Binary refine between prevT and t.
      let lo = prevT;
      let hi = t;
      for (let i = 0; i < 18; i++) {
        const mid = (lo + hi) / 2;
        ray.at(mid, p);
        if (p.y <= heightAt(p.x, p.z)) hi = mid;
        else lo = mid;
      }
      ray.at(hi, p);
      const half = WORLD_SIZE / 2;
      if (Math.abs(p.x) > half || Math.abs(p.z) > half) return null;
      return p;
    }
    prevT = t;
    step = Math.min(1.2, 0.35 + t * 0.01);
  }
  return null;
}
