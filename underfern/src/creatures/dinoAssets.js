// The dinosaurs as modelled in Blender (tools/blender/build_dinos.py): one GLB
// per species in assets/dinos/, holding LOD0, LOD1 (and the raptor's
// feathers), skinned to the game's own rig, with a baked normal map.
//
// dinoModel.js asks getDinoAsset(id) for a species' geometry and falls back
// to its procedural mesh when there is none (file missing, still loading,
// ?models=procedural). Skin weights are matched to the rig by bone name, so
// the procedural animation drives the Blender meshes unchanged.
//
// Vertex data (glTF → three): POSITION, NORMAL, TANGENT, TEXCOORD_0 (the
// normal map), COLOR_0 (fixed colours: teeth, claws, eyes …), _SKIN → aSkin
// (skin palette, pattern, accent, scale detail), _SURF → aSurf (roughness,
// eye glint, baked ambient occlusion), JOINTS_0 / WEIGHTS_0 → skinIndex /
// skinWeight. Coordinates are the game's: y up, +z toward the snout, metres.

import * as THREE from "three";

const BASE = new URL("../../assets/dinos/", import.meta.url);

/** id → { lods: [BufferGeometry, BufferGeometry], feathers, normalMap, tris } */
const _assets = new Map();
const _loading = new Map();

const GLB_MAGIC = 0x46546c67;
const CHUNK_JSON = 0x4e4f534a;
const CHUNK_BIN = 0x004e4942;
const ARRAYS = { 5120: Int8Array, 5121: Uint8Array, 5122: Int16Array, 5123: Uint16Array, 5125: Uint32Array, 5126: Float32Array };
const SIZES = { SCALAR: 1, VEC2: 2, VEC3: 3, VEC4: 4, MAT4: 16 };
const NORM = { 5120: 127, 5121: 255, 5122: 32767, 5123: 65535 };

/** Whether this page asked for the procedural models (?models=procedural). */
function procedural() {
  try {
    return new URLSearchParams(globalThis.location?.search || "").get("models") === "procedural";
  } catch {
    return false;
  }
}

/** Split a GLB into its JSON and binary chunks. */
export function parseGlb(buffer) {
  const dv = new DataView(buffer);
  if (dv.getUint32(0, true) !== GLB_MAGIC) throw new Error("[dinoAssets] not a GLB");
  let json = null;
  let bin = null;
  for (let off = 12; off + 8 <= buffer.byteLength; ) {
    const len = dv.getUint32(off, true);
    const type = dv.getUint32(off + 4, true);
    if (type === CHUNK_JSON) json = JSON.parse(new TextDecoder().decode(new Uint8Array(buffer, off + 8, len)));
    else if (type === CHUNK_BIN) bin = { buffer, offset: off + 8, length: len };
    off += 8 + len;
  }
  if (!json || !bin) throw new Error("[dinoAssets] GLB without JSON or binary chunk");
  return { json, bin };
}

/** One accessor as a typed array (normalised integers become floats). */
function accessor(glb, index) {
  const a = glb.json.accessors[index];
  const view = glb.json.bufferViews[a.bufferView];
  const Arr = ARRAYS[a.componentType];
  const n = SIZES[a.type];
  const elem = n * Arr.BYTES_PER_ELEMENT;
  const stride = view.byteStride || elem;
  const start = glb.bin.offset + (view.byteOffset || 0) + (a.byteOffset || 0);
  let out;
  if (stride === elem) out = new Arr(glb.bin.buffer.slice(start, start + a.count * elem));
  else {
    out = new Arr(a.count * n);
    const dv = new DataView(glb.bin.buffer);
    const get = { 5120: "getInt8", 5121: "getUint8", 5122: "getInt16", 5123: "getUint16", 5125: "getUint32", 5126: "getFloat32" }[a.componentType];
    for (let i = 0; i < a.count; i++) for (let k = 0; k < n; k++) out[i * n + k] = dv[get](start + i * stride + k * Arr.BYTES_PER_ELEMENT, true);
  }
  if (a.normalized && NORM[a.componentType]) {
    const f = new Float32Array(out.length);
    const s = NORM[a.componentType];
    for (let i = 0; i < out.length; i++) f[i] = Math.max(out[i] / s, -1);
    return { array: f, itemSize: n };
  }
  return { array: out, itemSize: n };
}

/** Keep `keep` of every `itemSize` components (e.g. RGBA → RGB). */
function narrow(arr, itemSize, keep) {
  if (itemSize === keep) return arr;
  const n = arr.length / itemSize;
  const out = new Float32Array(n * keep);
  for (let i = 0; i < n; i++) for (let k = 0; k < keep; k++) out[i * keep + k] = arr[i * itemSize + k];
  return out;
}

/**
 * One skinned mesh node as a BufferGeometry in the game's vertex layout.
 * @param {object} glb parsed GLB
 * @param {object} node glTF node with a mesh and a skin
 * @param {Int32Array} jointToBone skin joint index → game bone index
 * @param {{ flipV?: boolean }} opts flipV: read uv back in the game's (not glTF's) convention
 */
function nodeGeometry(glb, node, jointToBone, { flipV = false } = {}) {
  const mesh = glb.json.meshes[node.mesh];
  if (mesh.primitives.length !== 1) throw new Error(`[dinoAssets] ${node.name}: expected one primitive, got ${mesh.primitives.length}`);
  const prim = mesh.primitives[0];
  const at = prim.attributes;
  const g = new THREE.BufferGeometry();
  const take = (key) => (at[key] !== undefined ? accessor(glb, at[key]) : null);
  const pos = take("POSITION");
  const count = pos.array.length / 3;
  g.setAttribute("position", new THREE.BufferAttribute(pos.array, 3));
  const nrm = take("NORMAL");
  if (nrm) g.setAttribute("normal", new THREE.BufferAttribute(nrm.array, 3));
  else g.computeVertexNormals();
  const tan = take("TANGENT");
  if (tan) g.setAttribute("tangent", new THREE.BufferAttribute(tan.array, 4));
  const uv = take("TEXCOORD_0");
  if (uv) {
    if (flipV) for (let i = 1; i < uv.array.length; i += 2) uv.array[i] = 1 - uv.array[i];
    g.setAttribute("uv", new THREE.BufferAttribute(uv.array, 2));
  }
  const col = take("COLOR_0");
  g.setAttribute("color", new THREE.BufferAttribute(col ? narrow(col.array, col.itemSize, 3) : new Float32Array(count * 3).fill(1), 3));
  const sk = take("_SKIN");
  g.setAttribute("aSkin", new THREE.BufferAttribute(sk ? narrow(sk.array, sk.itemSize, 4) : new Float32Array(count * 4).fill(1), 4));
  const sf = take("_SURF");
  let surf = sf ? sf.array : null;
  if (!surf || sf.itemSize !== 3) {
    surf = new Float32Array(count * 3);
    for (let i = 0; i < count; i++) {
      surf[i * 3] = sf ? sf.array[i * sf.itemSize] : 0.78;
      surf[i * 3 + 1] = sf && sf.itemSize > 1 ? sf.array[i * sf.itemSize + 1] : 0;
      surf[i * 3 + 2] = 1;
    }
  }
  g.setAttribute("aSurf", new THREE.BufferAttribute(surf, 3));
  const J = take("JOINTS_0");
  const W = take("WEIGHTS_0");
  const ji = new Uint16Array(count * 4);
  const jw = new Float32Array(count * 4);
  for (let i = 0; i < count * 4; i++) {
    const b = J ? jointToBone[J.array[i]] : 0;
    ji[i] = b >= 0 ? b : 0;
    jw[i] = W && b >= 0 ? W.array[i] : 0;
  }
  // Renormalise (a dropped joint would leave the vertex short).
  for (let i = 0; i < count; i++) {
    const s = jw[i * 4] + jw[i * 4 + 1] + jw[i * 4 + 2] + jw[i * 4 + 3];
    if (s > 1e-6) for (let k = 0; k < 4; k++) jw[i * 4 + k] /= s;
    else jw[i * 4] = 1;
  }
  g.setAttribute("skinIndex", new THREE.Uint16BufferAttribute(ji, 4));
  g.setAttribute("skinWeight", new THREE.BufferAttribute(jw, 4));
  const idx = accessor(glb, prim.indices).array;
  g.setIndex(new THREE.BufferAttribute(idx instanceof Uint32Array || idx instanceof Uint16Array ? idx : Uint32Array.from(idx), 1));
  g.computeBoundingSphere();
  g.userData.material = prim.material;
  return g;
}

async function imageTexture(glb, imageIndex) {
  const img = glb.json.images[imageIndex];
  const view = glb.json.bufferViews[img.bufferView];
  const start = glb.bin.offset + (view.byteOffset || 0);
  const blob = new Blob([new Uint8Array(glb.bin.buffer, start, view.byteLength)], { type: img.mimeType || "image/webp" });
  let source;
  if (typeof createImageBitmap === "function") {
    source = await createImageBitmap(blob, { premultiplyAlpha: "none", colorSpaceConversion: "none" });
  } else {
    const url = URL.createObjectURL(blob);
    source = await new Promise((res, rej) => {
      const im = new Image();
      im.onload = () => res(im);
      im.onerror = rej;
      im.src = url;
    });
    URL.revokeObjectURL(url);
  }
  const tex = new THREE.Texture(source);
  tex.flipY = false; // glTF's uv convention
  tex.colorSpace = THREE.NoColorSpace;
  tex.wrapS = tex.wrapT = THREE.ClampToEdgeWrapping;
  tex.minFilter = THREE.LinearMipmapLinearFilter;
  tex.magFilter = THREE.LinearFilter;
  tex.generateMipmaps = true;
  tex.anisotropy = 4;
  tex.name = img.name || "dino-normal";
  tex.needsUpdate = true;
  return tex;
}

/**
 * Turn a parsed GLB into the game's geometry for one species.
 * @param {object} glb parsed GLB
 * @param {string[]} boneNames the species' rig, in the game's bone order
 */
export async function assetFromGlb(glb, boneNames) {
  const nodes = glb.json.nodes;
  const byName = (name) => nodes.find((n) => n.name === name && n.mesh !== undefined);
  const lod0 = byName("lod0");
  const lod1 = byName("lod1");
  if (!lod0 || !lod1) throw new Error("[dinoAssets] GLB without lod0 / lod1 meshes");
  const skin = glb.json.skins[lod0.skin];
  const boneIndex = new Map(boneNames.map((n, i) => [n, i]));
  const jointToBone = Int32Array.from(skin.joints, (j) => (boneIndex.has(nodes[j].name) ? boneIndex.get(nodes[j].name) : -1));
  const missing = skin.joints.filter((j, k) => jointToBone[k] < 0).map((j) => nodes[j].name);
  if (missing.length) console.warn(`[dinoAssets] bones not on the rig: ${missing.join(", ")}`);
  const g0 = nodeGeometry(glb, lod0, jointToBone);
  const g1 = nodeGeometry(glb, lod1, jointToBone);
  const fnode = byName("feathers");
  const feathers = fnode ? nodeGeometry(glb, fnode, jointToBone, { flipV: true }) : null;
  let normalMap = null;
  const mat = glb.json.materials?.[g0.userData.material];
  const texIndex = mat?.normalTexture?.index;
  if (texIndex !== undefined) {
    const t = glb.json.textures[texIndex];
    const src = t.source ?? t.extensions?.EXT_texture_webp?.source;
    if (src !== undefined) normalMap = await imageTexture(glb, src);
  }
  const tris = (g) => (g ? g.index.count / 3 : 0);
  return { lods: [g0, g1], feathers, normalMap, tris: [tris(g0) + tris(feathers), tris(g1) + tris(feathers)], jointsMissing: missing };
}

/**
 * Load the Blender models for these species (once each; failures fall back
 * to the procedural meshes and are reported, not thrown).
 * @param {string[]} ids species ids
 * @param {(id: string) => string[]} boneNamesOf the species' rig bone names, in order
 * @param {{ base?: URL|string }} [opts]
 * @returns {Promise<{ loaded: string[], failed: string[] }>}
 */
export async function loadDinoAssets(ids, boneNamesOf, { base = BASE } = {}) {
  const loaded = [];
  const failed = [];
  if (procedural()) return { loaded, failed: ids.slice() };
  await Promise.all(
    ids.map(async (id) => {
      if (_assets.get(id)) return loaded.push(id);
      if (!_loading.has(id)) {
        _loading.set(
          id,
          (async () => {
            const res = await fetch(new URL(id + ".glb", base));
            if (!res.ok) throw new Error(`${res.status} ${res.statusText}`);
            const asset = await assetFromGlb(parseGlb(await res.arrayBuffer()), boneNamesOf(id));
            _assets.set(id, asset);
            return asset;
          })()
        );
      }
      try {
        await _loading.get(id);
        loaded.push(id);
      } catch (err) {
        _loading.delete(id);
        failed.push(id);
        console.warn(`[dinoAssets] ${id}: using the procedural model (${err?.message || err})`);
      }
    })
  );
  return { loaded, failed };
}

/** The loaded Blender model of a species, or null (use the procedural mesh). */
export function getDinoAsset(id) {
  return _assets.get(id) || null;
}

/** Forget the loaded models (tests: compare against the procedural meshes). */
export function clearDinoAssets() {
  _assets.clear();
  _loading.clear();
}
