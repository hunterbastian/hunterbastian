// Dump each species' rig, landmarks and procedural reference mesh to JSON for
// the Blender build (build_dinos.py). Runs in plain Node: the bare "three"
// import resolves to the vendored copy.
//
//   node tools/blender/export-reference.mjs <outDir> [speciesId …]

import { register } from "node:module";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const THREE_URL = pathToFileURL(path.join(ROOT, "vendor/three/three.module.min.js")).href;
register(
  "data:text/javascript," +
    encodeURIComponent(`export async function resolve(s, c, next) { return s === "three" ? { url: ${JSON.stringify(THREE_URL)}, shortCircuit: true } : next(s, c); }`)
);

const { exportDinoReference } = await import(pathToFileURL(path.join(ROOT, "src/creatures/dinoModel.js")).href);
const { PLAYABLE } = await import(pathToFileURL(path.join(ROOT, "src/creatures/species.js")).href);

const out = path.resolve(process.argv[2] || "tools/blender/ref");
const ids = process.argv.slice(3).length ? process.argv.slice(3) : PLAYABLE;
await mkdir(out, { recursive: true });
for (const id of ids) {
  const ref = exportDinoReference(id);
  await writeFile(path.join(out, id + ".json"), JSON.stringify(ref));
  const tris = ref.lod.map((m) => m.index.length / 3);
  console.log(`${id}: ${ref.bones.length} bones, reference ${tris.join(" / ")} tris, parts ${ref.lod[0].parts.map((p) => p.name).join(" ")}`);
}
