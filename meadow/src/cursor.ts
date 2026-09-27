import * as THREE from 'three';
import { heightAt } from './terrain';

const SEGMENTS = 72;

/** Dashed ring that hugs the terrain under the pointer. */
export class Cursor {
  readonly mesh: THREE.Mesh;
  private geo: THREE.BufferGeometry;
  private radius = 0.5;
  private target = new THREE.Vector3();
  private current = new THREE.Vector3();
  private shownRadius = 0.5;
  private uniforms = { uTime: { value: 0 }, uOpacity: { value: 0 }, uActive: { value: 0 } };
  private visible = false;

  constructor() {
    this.geo = new THREE.BufferGeometry();
    const verts = (SEGMENTS + 1) * 2;
    this.geo.setAttribute('position', new THREE.BufferAttribute(new Float32Array(verts * 3), 3));
    const uv = new Float32Array(verts * 2);
    const idx: number[] = [];
    for (let i = 0; i <= SEGMENTS; i++) {
      uv.set([i / SEGMENTS, 0, i / SEGMENTS, 1], i * 4);
      if (i < SEGMENTS) {
        const a = i * 2;
        idx.push(a, a + 1, a + 2, a + 1, a + 3, a + 2);
      }
    }
    this.geo.setAttribute('uv', new THREE.BufferAttribute(uv, 2));
    this.geo.setIndex(idx);

    const mat = new THREE.ShaderMaterial({
      uniforms: this.uniforms,
      transparent: true,
      depthTest: false,
      depthWrite: false,
      side: THREE.DoubleSide,
      vertexShader: /* glsl */ `
        varying vec2 vUv;
        void main() {
          vUv = uv;
          gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
        }`,
      fragmentShader: /* glsl */ `
        uniform float uTime;
        uniform float uOpacity;
        uniform float uActive;
        varying vec2 vUv;
        void main() {
          float dash = step(0.42, fract(vUv.x * 22.0 - uTime * 0.25));
          dash = mix(dash, 1.0, uActive);
          float edge = smoothstep(0.0, 0.25, vUv.y) * smoothstep(1.0, 0.75, vUv.y);
          gl_FragColor = vec4(vec3(1.0), dash * edge * uOpacity * 0.95);
        }`,
    });
    this.mesh = new THREE.Mesh(this.geo, mat);
    this.mesh.renderOrder = 10;
    this.mesh.frustumCulled = false;
  }

  setRadius(r: number): void {
    this.radius = r;
  }

  setActive(active: boolean): void {
    this.uniforms.uActive.value = active ? 1 : 0;
  }

  moveTo(p: THREE.Vector3 | null): void {
    this.visible = !!p;
    if (p) {
      if (this.uniforms.uOpacity.value < 0.05) this.current.copy(p);
      this.target.copy(p);
    }
  }

  update(dt: number, time: number): void {
    const k = 1 - Math.exp(-dt * 22);
    this.current.lerp(this.target, k);
    this.shownRadius += (this.radius - this.shownRadius) * (1 - Math.exp(-dt * 14));
    const o = this.uniforms.uOpacity;
    o.value += ((this.visible ? 1 : 0) - o.value) * (1 - Math.exp(-dt * 12));
    this.uniforms.uTime.value = time;

    const pos = this.geo.attributes.position as THREE.BufferAttribute;
    const width = 0.07;
    for (let i = 0; i <= SEGMENTS; i++) {
      const a = (i / SEGMENTS) * Math.PI * 2;
      const c = Math.cos(a);
      const s = Math.sin(a);
      for (let j = 0; j < 2; j++) {
        const r = this.shownRadius + (j === 0 ? -width : width);
        const x = this.current.x + c * r;
        const z = this.current.z + s * r;
        pos.setXYZ(i * 2 + j, x, heightAt(x, z) + 0.06, z);
      }
    }
    pos.needsUpdate = true;
  }
}
