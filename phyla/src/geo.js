// Merge a handful of primitives into one vertex-coloured geometry, so a tree
// or a nest is a single draw call (and a single instanced mesh).

import * as THREE from './three.js';

const _m = new THREE.Matrix4();
const _n = new THREE.Matrix3();
const _q = new THREE.Quaternion();
const _e = new THREE.Euler();
const _p = new THREE.Vector3();
const _s = new THREE.Vector3();
const _v = new THREE.Vector3();
const _c = new THREE.Color();

// pieces: [{ geo, color, p?, r?, s? }]
export function mergeGeo(pieces) {
  const P = [];
  const N = [];
  const C = [];
  const I = [];
  for (const pc of pieces) {
    const geo = pc.geo;
    const p = pc.p || [0, 0, 0];
    const r = pc.r || [0, 0, 0];
    const s = pc.s === undefined ? [1, 1, 1] : typeof pc.s === 'number' ? [pc.s, pc.s, pc.s] : pc.s;
    _m.compose(_p.set(p[0], p[1], p[2]), _q.setFromEuler(_e.set(r[0], r[1], r[2])), _s.set(s[0], s[1], s[2]));
    _n.getNormalMatrix(_m);
    _c.set(pc.color || '#ffffff');
    const pos = geo.attributes.position;
    const nor = geo.attributes.normal;
    const base = P.length / 3;
    for (let i = 0; i < pos.count; i++) {
      _v.fromBufferAttribute(pos, i).applyMatrix4(_m);
      P.push(_v.x, _v.y, _v.z);
      if (pc.up) N.push(0, 1, 0);
      else {
        _v.fromBufferAttribute(nor, i).applyMatrix3(_n).normalize();
        N.push(_v.x, _v.y, _v.z);
      }
      C.push(_c.r, _c.g, _c.b);
    }
    if (geo.index) for (let i = 0; i < geo.index.count; i++) I.push(base + geo.index.getX(i));
    else for (let i = 0; i < pos.count; i++) I.push(base + i);
    geo.dispose();
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(P, 3));
  g.setAttribute('normal', new THREE.Float32BufferAttribute(N, 3));
  g.setAttribute('color', new THREE.Float32BufferAttribute(C, 3));
  g.setIndex(I);
  return g;
}

// A single upright blade (triangle) for grass, normals pointing up so it
// takes the same light as the ground beneath it.
export function bladeGeo(w, h, lean = 0) {
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute([-w / 2, 0, 0, w / 2, 0, 0, lean, h, 0], 3));
  g.setAttribute('normal', new THREE.Float32BufferAttribute([0, 1, 0, 0, 1, 0, 0, 1, 0], 3));
  g.setIndex([0, 1, 2, 2, 1, 0]); // both windings, so no back-face darkening
  return g;
}
