// Walks the routes that matter and fails if any of them breaks:
// up the bluff trail, across the bridge, up the islet stair, out of the plunge
// pool, down the creek to the cove, and into a cliff face (which must stop you).
// Run from this folder: node walk-test.mjs  (plain Node, no browser needed)
import { buildWorld } from "./src/world.js";
import { Player } from "./src/player.js";

const world = buildWorld();
const relief = world.terrain.relief;
const dt = 1 / 60;
const yawTo = (p, x, z) => Math.atan2(x - p.x, -(z - p.z));

function walk(start, waypoints, seconds) {
  const p = new Player(world, { x: start[0], z: start[1], yaw: 0, pitch: 0 });
  let i = 0, maxY = -Infinity;
  for (let t = 0; t < seconds && i < waypoints.length; t += dt) {
    const [x, z] = waypoints[i];
    if (Math.hypot(p.x - x, p.z - z) < 1.2) {
      i++;
      continue;
    }
    p.yaw = yawTo(p, x, z);
    p.update(dt, { moveX: 0, moveY: 1, run: false, jump: false, lookX: 0, lookY: 0 }, true);
    maxY = Math.max(maxY, p.y);
  }
  return { reached: i === waypoints.length, y: p.y, maxY };
}

const trail = relief.trail.filter((_, k) => k % 3 === 0).map((q) => [q.x, q.z]);
const pool = relief.pool;
const checks = [
  ["start to the tree", walk([12.4, 20.6], [[3, 3]], 30), (r) => r.reached],
  ["up the bluff trail", walk(trail[0], trail, 200), (r) => r.reached && r.y > 30],
  ["the cliff face stops you", walk([48, 30], [[48, 62]], 20), (r) => !r.reached && r.maxY < 10],
  ["across the bridge", walk([21.5, 28], [[20.6, 33], [19.4, 40], [18.5, 46]], 30), (r) => r.reached && r.maxY > 4],
  ["up the islet stair", walk([-36, -2], [[-41, -6.3], [-46.5, -10.9], [-48.3, -12.4]], 40), (r) => r.reached && r.y > 5],
  ["out of the plunge pool", walk([pool[0] + 2, pool[1] - 2], [[pool[0] + 4.5, pool[1] - 0.8], [pool[0] + 14, pool[1] - 7.5], trail[0]], 40), (r) => r.reached],
  ["down the creek to the cove", walk(pool, [[22, 37], [14, 35.5], [5, 35], [5, 31.5]], 40), (r) => r.reached],
];

let failed = 0;
for (const [name, result, ok] of checks) {
  const pass = ok(result);
  if (!pass) failed++;
  console.log(`${pass ? "ok  " : "FAIL"} ${name} (ended at y=${result.y.toFixed(1)}, highest ${result.maxY.toFixed(1)})`);
}
process.exit(failed ? 1 : 0);
