// Write each GLB as embedded glTF JSON (`<id>.gltf.json`, the binary chunk as a
// base64 data URI), for hosts that serve .json but not .glb. dinoAssets.js
// falls back to it when the .glb can't be read.
//
//   node tools/blender/glb-to-gltf.mjs <dir with .glb files> [outDir]

import { readdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";

const dir = path.resolve(process.argv[2] || "assets/dinos");
const out = path.resolve(process.argv[3] || dir);
for (const f of (await readdir(dir)).filter((n) => n.endsWith(".glb"))) {
  const buf = await readFile(path.join(dir, f));
  let json = null;
  let bin = null;
  for (let off = 12; off + 8 <= buf.length; ) {
    const len = buf.readUInt32LE(off);
    const type = buf.readUInt32LE(off + 4);
    if (type === 0x4e4f534a) json = JSON.parse(buf.subarray(off + 8, off + 8 + len).toString("utf8"));
    else if (type === 0x004e4942) bin = buf.subarray(off + 8, off + 8 + len);
    off += 8 + len;
  }
  json.buffers = [{ byteLength: bin.length, uri: "data:application/octet-stream;base64," + bin.toString("base64") }];
  const name = f.replace(/\.glb$/, ".gltf.json");
  await writeFile(path.join(out, name), JSON.stringify(json));
  console.log(`${name}: ${(JSON.stringify(json).length / 1024).toFixed(0)} KB`);
}
