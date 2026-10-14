// Underfern — browser-side unit tests for the pure-ish modules (rng, noise,
// terrain, species, wind, the touch layer of input) plus the creature /
// ecosystem simulation on a real low-resolution World. No rendering: everything
// here is plain JS, so it runs at full speed even under SwiftShader.
//
// Open tests/unit.html in a browser (served from underfern/) to see the results,
// or run `node tests/run-tests.mjs`, which reads window.__unit.

import * as THREE from "three";
import { QUALITY, WORLD } from "../src/config.js";
import { makeRng, hash, rand, randInt, pick, weightedPick } from "../src/core/rng.js";
import { createNoise2D, fbm2D, ridged2D } from "../src/core/noise.js";
import { EventBus } from "../src/core/events.js";
import { Terrain, BIOMES } from "../src/world/terrain.js";
import { SPECIES, PLAYABLE, getSpecies, growthScale, growthStage } from "../src/creatures/species.js";
import { Wind } from "../src/world/wind.js";
import { World } from "../src/world/world.js";
import { isRotated, appSize, toApp, onAppResize } from "../src/core/screen.js";
import { Input } from "../src/player/input.js";
import { ThirdPersonCamera } from "../src/player/camera.js";
import { speciesSilhouette } from "../src/ui/menu.js";

/* --- Tiny harness --------------------------------------------------------- */

const results = [];
window.__unit = { done: false, results };

class AssertionError extends Error {}

function assert(cond, msg = "assertion failed") {
  if (!cond) throw new AssertionError(msg);
}
assert.equal = (a, b, msg = "") => assert(Object.is(a, b), `${msg} expected ${fmt(b)}, got ${fmt(a)}`);
assert.near = (a, b, tol, msg = "") =>
  assert(Number.isFinite(a) && Math.abs(a - b) <= tol, `${msg} expected ${fmt(b)} ± ${tol}, got ${fmt(a)}`);
assert.range = (v, lo, hi, msg = "") =>
  assert(Number.isFinite(v) && v >= lo && v <= hi, `${msg} expected in [${lo}, ${hi}], got ${fmt(v)}`);
assert.throws = (fn, msg = "") => {
  let threw = false;
  try {
    fn();
  } catch {
    threw = true;
  }
  assert(threw, `${msg} expected to throw`);
};

function fmt(v) {
  if (typeof v === "number") return Number.isInteger(v) ? String(v) : v.toFixed(4);
  try {
    return JSON.stringify(v);
  } catch {
    return String(v);
  }
}

const queue = [];
/** Register a test. `known` = a documented, expected failure (reported, doesn't fail the run). */
function test(name, fn, { known = null } = {}) {
  queue.push({ name, fn, known });
}

async function run() {
  for (const { name, fn, known } of queue) {
    const t0 = performance.now();
    let ok = true;
    let error = null;
    try {
      await fn();
    } catch (err) {
      ok = false;
      error = err instanceof AssertionError ? err.message : `${err?.name || "Error"}: ${err?.message || err}\n${(err?.stack || "").split("\n").slice(1, 4).join("\n")}`;
    }
    const ms = Math.round(performance.now() - t0);
    const status = ok ? (known ? "unexpected-pass" : "pass") : known ? "known" : "fail";
    results.push({ name, status, ms, error, known });
    // Let the page breathe between tests (keeps the DOM log live in a real browser).
    await new Promise((r) => setTimeout(r, 0));
  }
  render();
  window.__unit.done = true;
}

function render() {
  const out = document.getElementById("out");
  if (!out) return;
  out.textContent = "";
  for (const r of results) {
    const pre = document.createElement("pre");
    const cls = r.status === "pass" ? "pass" : r.status === "known" ? "known" : "fail";
    pre.className = cls;
    pre.textContent = `${r.status.toUpperCase().padEnd(7)} ${r.name} (${r.ms} ms)${r.error ? `\n        ${r.error}` : ""}${r.known ? `\n        known: ${r.known}` : ""}`;
    out.appendChild(pre);
  }
}

/* --- core/rng.js ---------------------------------------------------------- */

test("screen: a desktop window isn't turned; the app frame is the viewport", () => {
  // tests/unit.html runs in a landscape desktop window: no rotation, toApp is
  // the identity and appSize follows the (visual) viewport.
  assert.equal(isRotated(), false, "rotated");
  const s = appSize();
  const vv = window.visualViewport;
  assert.near(s.w, vv ? vv.width : innerWidth, 0.5, "width");
  assert.near(s.h, vv ? vv.height : innerHeight, 0.5, "height");
  const p = toApp(12.5, 40);
  assert(p.x === 12.5 && p.y === 40, `toApp should be the identity, got ${fmt(p)}`);
  assert.equal(document.documentElement.classList.contains("is-rotated"), false, "html.is-rotated");
  const off = onAppResize(() => {});
  assert.equal(typeof off, "function", "onAppResize returns an unsubscribe");
  off();
});

/* --- player/input.js (touch layer) ---------------------------------------- */

test("input: Bite doubles as a look pad past the slop; Sprint latches", () => {
  // A desktop window, so toApp is the identity and client px are app px.
  const host = document.createElement("div");
  host.style.cssText = "position:fixed;inset:0";
  document.body.appendChild(host);
  const input = new Input(null, host, { touch: true });
  const ev = (el, type, id, x, y) =>
    el.dispatchEvent(new PointerEvent(type, { pointerId: id, pointerType: "touch", clientX: x, clientY: y, bubbles: true, cancelable: true }));
  const btn = (a) => host.querySelector(`.touch-btn[data-action="${a}"]`);
  const centre = (el) => {
    const r = el.getBoundingClientRect();
    return [r.x + r.width / 2, r.y + r.height / 2];
  };
  const tap = (a) => {
    const [x, y] = centre(btn(a));
    ev(btn(a), "pointerdown", 9, x, y);
    ev(btn(a), "pointerup", 9, x, y);
  };
  /** Press `a`, slide ten times by -15 px x, return the look delta (still held). */
  const slide = (a, id) => {
    const el = btn(a);
    const [x, y] = centre(el);
    ev(el, "pointerdown", id, x, y);
    for (let i = 1; i <= 10; i++) ev(el, "pointermove", id, x - 15 * i, y);
    return { ...input.consumeLook(), x, y, el };
  };
  try {
    // A held look pad keeps auto-follow off even when the thumb rests still.
    const pad = host.querySelector(".touch-zone--look");
    const [px, py] = centre(pad);
    ev(pad, "pointerdown", 1, px, py);
    assert(input.lookHeld, "a still thumb on the look pad counts as a look");
    ev(pad, "pointerup", 1, px, py);
    assert(!input.lookHeld, "lifting it ends the look");

    const bite = btn("bite");
    const [bx, by] = centre(bite);
    ev(bite, "pointerdown", 2, bx, by);
    assert(input.isDown("bite") && input.pressed("bite"), "pressing Bite bites");
    for (const [dx, dy] of [[3, -2], [-4, 3], [5, 4], [-2, -5]]) ev(bite, "pointermove", 2, bx + dx, by + dy);
    const still = input.consumeLook();
    assert(still.dx === 0 && still.dy === 0, `the wobble of a press must not turn, got ${fmt(still)}`);
    assert(!input.lookHeld, "a press that never slid isn't a look");
    for (let i = 1; i <= 10; i++) ev(bite, "pointermove", 2, bx - 15 * i, by);
    const turn = input.consumeLook();
    assert(turn.dx < -200, `sliding 150 px left should turn left, got dx ${fmt(turn.dx)}`);
    assert(input.isDown("bite") && input.lookHeld, "Bite stays held while sliding");
    ev(bite, "pointermove", 2, bx, by); // back inside the slop: still live
    assert(input.consumeLook().dx > 0, "once live, the drag stays live");
    ev(bite, "pointerup", 2, bx, by);
    assert(!input.isDown("bite") && !input.lookHeld, "lifting releases Bite and the look");
    input.endFrame();

    const sniff = slide("sniff", 3);
    assert(sniff.dx === 0 && sniff.dy === 0, `dragging Sniff must not turn, got ${fmt(sniff.dx)}`);
    ev(sniff.el, "pointerup", 3, sniff.x, sniff.y);
    input.endFrame();

    // Sprint is a latch: a tap holds it, a second tap lets go…
    tap("sprint");
    assert(input.isDown("sprint"), "tapping Sprint latches it");
    assert.equal(btn("sprint").getAttribute("aria-pressed"), "true", "Sprint lit:");
    tap("sprint");
    assert(!input.isDown("sprint"), "a second tap releases Sprint");
    assert.equal(btn("sprint").getAttribute("aria-pressed"), "false", "Sprint unlit:");
    // …and so does lifting the thumb off the stick.
    tap("sprint");
    const stick = host.querySelector(".touch-zone--move");
    const [sx, sy] = centre(stick);
    ev(stick, "pointerdown", 4, sx, sy);
    assert(input.isDown("sprint"), "the latch holds while the stick is down");
    ev(stick, "pointerup", 4, sx, sy);
    assert(!input.isDown("sprint"), "lifting the stick ends the sprint");
    assert.equal(btn("sprint").getAttribute("aria-pressed"), "false", "Sprint unlit after the stick:");
  } finally {
    input.dispose();
    host.remove();
    document.getElementById("underfern-touch-base")?.remove();
  }
});

test("rng: same seed → same sequence, values in [0, 1)", () => {
  const a = makeRng(42);
  const b = makeRng(42);
  for (let i = 0; i < 1000; i++) {
    const x = a();
    assert.equal(x, b(), `step ${i}:`);
    assert(x >= 0 && x < 1, `value out of range: ${x}`);
  }
  const c = makeRng(43);
  const d = makeRng(42);
  let same = 0;
  for (let i = 0; i < 100; i++) if (c() === d()) same++;
  assert(same < 5, "different seeds should give different sequences");
});

test("rng: helpers (rand, randInt inclusive, pick, weightedPick, hash)", () => {
  const r = makeRng(7);
  const seen = new Set();
  for (let i = 0; i < 2000; i++) {
    assert.range(rand(r, -3, 5), -3, 5, "rand");
    const k = randInt(r, 1, 4);
    assert(Number.isInteger(k) && k >= 1 && k <= 4, `randInt out of range: ${k}`);
    seen.add(k);
  }
  assert.equal(seen.size, 4, "randInt should hit both ends:");
  const arr = ["a", "b", "c"];
  for (let i = 0; i < 50; i++) assert(arr.includes(pick(r, arr)), "pick");
  const counts = { a: 0, b: 0 };
  for (let i = 0; i < 4000; i++) counts[weightedPick(r, { a: 3, b: 1 })]++;
  assert.range(counts.a / 4000, 0.68, 0.82, "weightedPick share of a (weight 3:1)");
  assert.equal(hash(1, "x"), hash(1, "x"), "hash stable:");
  assert(hash(1, "x") !== hash(1, "y"), "hash should differ for different parts");
  assert(hash(1, "x") !== hash("x", 1), "hash should depend on order");
  assert(Number.isInteger(hash("anything")) && hash("anything") >= 0, "hash is a uint32");
});

/* --- core/noise.js -------------------------------------------------------- */

test("noise: simplex / fbm / ridged ranges and determinism", () => {
  const n1 = createNoise2D(1234);
  const n2 = createNoise2D(1234);
  const n3 = createNoise2D(999);
  const r = makeRng(5);
  let min = Infinity;
  let max = -Infinity;
  let diff = 0;
  for (let i = 0; i < 5000; i++) {
    const x = (r() - 0.5) * 200;
    const y = (r() - 0.5) * 200;
    const v = n1(x, y);
    assert.equal(v, n2(x, y), "same seed:");
    assert.range(v, -1, 1, "simplex");
    if (Math.abs(v - n3(x, y)) > 1e-6) diff++;
    min = Math.min(min, v);
    max = Math.max(max, v);
    assert.range(fbm2D(n1, x * 0.05, y * 0.05), -1.05, 1.05, "fbm2D");
    assert.range(ridged2D(n1, x * 0.05, y * 0.05), 0, 1, "ridged2D");
  }
  assert(max - min > 1, `simplex should span most of [-1, 1] (got ${min.toFixed(2)}..${max.toFixed(2)})`);
  assert(diff > 4500, "a different seed should give a different field");
});

/* --- world/terrain.js ----------------------------------------------------- */

const TERRAIN_RES = 128;
let terrain = null;
const getTerrain = () =>
  (terrain ||= new Terrain({ size: WORLD.size, resolution: TERRAIN_RES, seed: WORLD.seed, seaLevel: WORLD.seaLevel, maxHeight: WORLD.maxHeight }));

test("terrain: same seed → identical heights; another seed differs", () => {
  const a = getTerrain();
  const b = new Terrain({ size: WORLD.size, resolution: TERRAIN_RES, seed: WORLD.seed, seaLevel: WORLD.seaLevel, maxHeight: WORLD.maxHeight });
  assert.equal(a.heights.length, (TERRAIN_RES + 1) ** 2, "heights length:");
  for (let i = 0; i < a.heights.length; i++) {
    if (a.heights[i] !== b.heights[i]) throw new AssertionError(`height ${i} differs: ${a.heights[i]} vs ${b.heights[i]}`);
  }
  const c = new Terrain({ size: WORLD.size, resolution: TERRAIN_RES, seed: WORLD.seed + 1, seaLevel: WORLD.seaLevel, maxHeight: WORLD.maxHeight });
  let differ = 0;
  for (let i = 0; i < a.heights.length; i++) if (Math.abs(a.heights[i] - c.heights[i]) > 0.01) differ++;
  assert(differ > a.heights.length * 0.2, "a different seed should reshape the island");
  b.dispose?.();
  c.dispose?.();
});

test("terrain: island shape, heightAt / normalAt / slopeAt / biomeAt sanity", () => {
  const t = getTerrain();
  let land = 0;
  let maxH = -Infinity;
  for (const h of t.heights) {
    assert(Number.isFinite(h), "non-finite height");
    if (h > t.seaLevel) land++;
    maxH = Math.max(maxH, h);
  }
  const landFrac = land / t.heights.length;
  assert.range(landFrac, 0.15, 0.85, "land fraction");
  assert.range(maxH, 20, t.maxHeight * 1.2, "highest peak");
  // Off the tile is deep ocean; the corners are open sea.
  assert(t.heightAt(t.half + 50, 0) < -10, "outside the tile should be deep ocean");
  assert(t.isWater(-t.half + 5, -t.half + 5) && !t.isFreshWater(-t.half + 5, -t.half + 5), "the corner is salt ocean");
  assert.equal(t.biomeAt(-t.half + 5, -t.half + 5), "ocean", "corner biome:");
  // heightAt matches the grid at vertices.
  const ix = 70;
  const iz = 61;
  const x = -t.half + ix * t.cellSize;
  const z = -t.half + iz * t.cellSize;
  assert.near(t.heightAt(x, z), t.heights[iz * (TERRAIN_RES + 1) + ix], 1e-3, "heightAt at a vertex:");
  const r = makeRng(11);
  const n = new THREE.Vector3();
  for (let i = 0; i < 400; i++) {
    const px = (r() - 0.5) * t.size * 0.9;
    const pz = (r() - 0.5) * t.size * 0.9;
    t.normalAt(px, pz, n);
    assert.near(n.length(), 1, 1e-3, "normal length:");
    assert(n.y > 0, "normals point up");
    assert.range(t.slopeAt(px, pz), 0, 1, "slope");
    const biome = t.biomeAt(px, pz);
    assert(BIOMES.includes(biome), `unknown biome ${biome}`);
    assert.equal(t.isWater(px, pz), t.heightAt(px, pz) < t.seaLevel, "isWater ⇔ below sea level:");
    assert.equal(t.waterDepthAt(px, pz), Math.max(0, t.seaLevel - t.heightAt(px, pz)), "waterDepthAt:");
    if (t.isFreshWater(px, pz)) assert(t.isWater(px, pz), "fresh water must be water");
  }
});

test("terrain: lakes/rivers are fresh water; nearestFreshWater stands on the shore", () => {
  const t = getTerrain();
  assert.range(t.lakes.length, 3, 5, "lake count (contract: 3–5)");
  assert(t.rivers.length >= 1, "at least one river");
  let freshCentres = 0;
  for (const lake of t.lakes) if (t.isFreshWater(lake.x, lake.z)) freshCentres++;
  assert(freshCentres >= Math.ceil(t.lakes.length / 2), `most lake centres should be fresh water (${freshCentres}/${t.lakes.length})`);
  const lake = t.lakes[0];
  const from = { x: lake.x + (lake.r || 30) + 60, z: lake.z };
  const w = t.nearestFreshWater(from.x, from.z, 400);
  assert(w, "nearestFreshWater found nothing within 400 m of a lake");
  assert(w.dist <= 400, "dist within maxRadius");
  assert.near(w.dist, Math.hypot(w.x - from.x, w.z - from.z), 0.01, "dist matches the point:");
  assert(t.heightAt(w.x, w.z) >= t.seaLevel - 0.5, "the drinking spot is (about) on land");
  // There is fresh water within a few cells of the shore point.
  let wet = false;
  for (let a = 0; a < 16 && !wet; a++) {
    for (const d of [2, 4, 6, 8, 12]) {
      if (t.isFreshWater(w.x + Math.sin(a * 0.39) * d, w.z + Math.cos(a * 0.39) * d)) {
        wet = true;
        break;
      }
    }
  }
  if (Number.isFinite(w.waterX)) wet ||= t.isFreshWater(w.waterX, w.waterZ);
  assert(wet, "no fresh water next to the shore point");
  assert.equal(t.nearestFreshWater(-t.half + 2, -t.half + 2, 5), null, "nothing fresh within 5 m of the ocean corner:");
});

test("terrain: findSpawnPoint honours biomes / height / slope / ring and is deterministic", () => {
  const t = getTerrain();
  const opts = { biomes: ["plains", "forest"], minHeight: 1, maxSlope: 0.3 };
  const a = t.findSpawnPoint(makeRng(3), opts);
  const b = t.findSpawnPoint(makeRng(3), opts);
  assert(a && b, "no spawn point found");
  assert.equal(a.x, b.x, "deterministic x:");
  assert.equal(a.z, b.z, "deterministic z:");
  const r = makeRng(9);
  for (let i = 0; i < 20; i++) {
    const p = t.findSpawnPoint(r, opts);
    assert(p, "spawn point");
    assert(t.heightAt(p.x, p.z) - t.seaLevel >= 1, "above minHeight");
    assert(t.slopeAt(p.x, p.z) <= 0.3, "within maxSlope");
    assert(opts.biomes.includes(t.biomeAt(p.x, p.z)), `biome ${t.biomeAt(p.x, p.z)}`);
  }
  const near = { x: a.x, z: a.z, minR: 30, maxR: 90 };
  for (let i = 0; i < 10; i++) {
    const p = t.findSpawnPoint(r, { near, tries: 400 });
    if (!p) continue;
    assert.range(Math.hypot(p.x - near.x, p.z - near.z), near.minR - 1e-6, near.maxR + 1e-6, "ring distance");
  }
  assert.equal(t.findSpawnPoint(r, { biomes: ["no-such-biome"], tries: 50 }), null, "impossible filter:");
});

/* --- world/terrain.js: the massif and its caves ---------------------------- */

// A finer island for the mountain / cave checks: trails and cave floors are a
// few metres wide, which the 12.5 m cells above can only sketch.
const HI_RES = 256;
let hiTerrain = null;
const getHiTerrain = () =>
  (hiTerrain ||= new Terrain({ size: WORLD.size, resolution: HI_RES, seed: WORLD.seed, seaLevel: WORLD.seaLevel, maxHeight: WORLD.maxHeight }));

/**
 * Ground reachable on foot from the lowlands: a flood fill over a `step` m grid
 * where neighbours may differ by at most `grade` rise/run (creatures stall at
 * 1.3) and caves only count where the rock leaves `stand` metres of headroom.
 */
function walkable(t, { step = 3, grade = 1.0, stand = 2.2 } = {}) {
  const n = Math.floor(t.size / step);
  const H = new Float32Array(n * n);
  const ok = new Uint8Array(n * n);
  const reach = new Uint8Array(n * n);
  const q = new Int32Array(n * n);
  let qt = 0;
  const pos = (i) => [-t.half + ((i % n) + 0.5) * step, -t.half + (((i / n) | 0) + 0.5) * step];
  for (let i = 0; i < n * n; i++) {
    const [x, z] = pos(i);
    H[i] = t.heightAt(x, z);
    ok[i] = H[i] > t.seaLevel + 0.1 && t.clearanceAt(x, z) >= stand ? 1 : 0;
    if (ok[i] && H[i] < t.seaLevel + 8 && t.slopeAt(x, z) < 0.15) {
      reach[i] = 1;
      q[qt++] = i;
    }
  }
  const lim = grade * step;
  for (let qh = 0; qh < qt; qh++) {
    const i = q[qh];
    const x = i % n;
    for (const j of [x > 0 ? i - 1 : -1, x < n - 1 ? i + 1 : -1, i - n, i + n]) {
      if (j < 0 || j >= n * n || reach[j] || !ok[j]) continue;
      if (Math.abs(H[j] - H[i]) > lim) continue;
      reach[j] = 1;
      q[qt++] = j;
    }
  }
  return {
    reach,
    H,
    ok,
    n,
    /** Reachable within `r` metres of (x, z)? */
    at(x, z, r = 6) {
      const k = Math.ceil(r / step);
      const cx = Math.floor((x + t.half) / step);
      const cz = Math.floor((z + t.half) / step);
      for (let dz = -k; dz <= k; dz++) {
        for (let dx = -k; dx <= k; dx++) {
          const ix = cx + dx;
          const iz = cz + dz;
          if (ix >= 0 && iz >= 0 && ix < n && iz < n && reach[iz * n + ix]) return true;
        }
      }
      return false;
    },
  };
}

test("massif: horn peaks near maxHeight, 1–2 passes, lookouts high on the ridge", () => {
  const t = getHiTerrain();
  assert.range(t.peaks.length, 3, 4, "peaks");
  assert.range(t.peaks[0].h, t.maxHeight * 0.85, t.maxHeight * 1.08, "main summit height");
  for (const p of t.peaks) assert.range(p.h, 90, t.maxHeight * 1.08, "every summit stands well above the highland");
  assert.range(t.passes.length, 1, 2, "passes");
  for (const p of t.passes) {
    assert.range(p.h, 25, 110, "a pass sits well below the crest");
    assert(t.peaks.every((k) => k.h > p.h + 40), "the summits tower over the pass");
  }
  assert(t.lookouts.length >= 1, "at least one lookout");
  for (const o of t.lookouts) assert(o.h >= 70, `lookout at ${o.h.toFixed(0)} m should give a big view`);
  assert(t.routes.some((r) => r.kind === "valley") && t.trails.length === t.lookouts.length, "a valley per pass, a trail per lookout");
});

test("massif: cliffs are barriers, not everywhere — a sane slope mix with sheer faces up high", () => {
  const t = getHiTerrain();
  const n = t.resolution + 1;
  let land = 0;
  let steep = 0;
  let high = 0;
  let highSteep = 0;
  for (let iz = 1; iz < n - 1; iz++) {
    for (let ix = 1; ix < n - 1; ix++) {
      const x = -t.half + ix * t.cellSize;
      const z = -t.half + iz * t.cellSize;
      const h = t.heightAt(x, z);
      if (h < t.seaLevel + 0.5 || t.nearCave(x, z)) continue;
      land++;
      const s = t.slopeAt(x, z) > 0.39; // creatures stall about here
      if (s) steep++;
      if (h > t.seaLevel + 90) {
        high++;
        if (s) highSteep++;
      }
    }
  }
  assert.range(steep / land, 0.015, 0.15, "share of land too steep to walk");
  assert(high > 0, "there is high country");
  assert.range(highSteep / high, 0.12, 0.85, "share of the high country (>90 m) that is cliff");
});

test("massif: walkable from the lowlands to every pass, lookout and cave mouth", () => {
  const t = getHiTerrain();
  const w = walkable(t);
  let land = 0;
  let reached = 0;
  let top = -Infinity;
  for (let i = 0; i < w.n * w.n; i++) {
    if (!w.ok[i]) continue;
    land++;
    if (w.reach[i]) {
      reached++;
      top = Math.max(top, w.H[i]);
    }
  }
  assert(reached / land > 0.85, `most of the island is walkable (${(reached / land).toFixed(3)})`);
  assert(top > t.seaLevel + 100, `you can climb above 100 m (highest reached ${top.toFixed(0)} m)`);
  for (const p of t.passes) assert(w.at(p.x, p.z), `pass at ${p.x.toFixed(0)}, ${p.z.toFixed(0)} is reachable`);
  for (const o of t.lookouts) assert(w.at(o.x, o.z), `lookout at ${o.x.toFixed(0)}, ${o.z.toFixed(0)} (${o.h.toFixed(0)} m) is reachable`);
  for (const c of t.caves) {
    for (const e of c.entrances) assert(w.at(e.outsideX, e.outsideZ), `${c.kind} ${c.id}: the ground outside its mouth is reachable`);
    assert(w.at(c.deep.x, c.deep.z, 4), `${c.kind} ${c.id}: you can walk right into it`);
  }
});

test("caves: 3–6 of different sizes — dens, a tunnel with two mouths, a cavern with a skylight; same at any resolution", () => {
  const t = getHiTerrain();
  const lo = getTerrain();
  assert.range(t.caves.length, 3, 6, "cave count");
  const kinds = t.caves.map((c) => c.kind);
  assert(kinds.includes("cavern"), "a great cavern");
  assert(kinds.includes("den"), "at least one small den");
  assert(t.caves.some((c) => c.entrances.length === 2 || c.skylights.length), "some cave has two mouths or a skylight");
  const cavern = t.caves.find((c) => c.kind === "cavern");
  for (const c of t.caves) {
    if (c.kind === "den") {
      assert.range(c.height, 2.4, 3.45, "a den's mouth admits raptors, not an adult Allosaurus");
      assert(c.height < cavern.height - 2, "the cavern's mouth is far bigger than a den's");
    }
    assert(c.maxHeight >= c.height, "inside is at least as tall as the mouth");
  }
  assert(cavern.maxHeight > 10 && cavern.maxWidth > 25, "the cavern opens into a great chamber");
  // Layout is decided on the fixed coarse grid: identical caves at 128 and 256.
  assert.equal(lo.caves.length, t.caves.length, "same number of caves at another resolution:");
  for (let i = 0; i < t.caves.length; i++) {
    const a = t.caves[i];
    const b = lo.caves[i];
    assert.equal(a.kind, b.kind, "same kind:");
    for (let k = 0; k < a.entrances.length; k++) {
      assert.near(a.entrances[k].x, b.entrances[k].x, 1e-6, "same mouth x:");
      assert.near(a.entrances[k].z, b.entrances[k].z, 1e-6, "same mouth z:");
    }
    // Inside, the ground is the cave's own floor at any mesh resolution.
    assert.near(t.heightAt(a.deep.x, a.deep.z), lo.heightAt(a.deep.x, a.deep.z), 0.02, `${a.kind} ${a.id}: same floor deep inside:`);
    assert.near(t.clearanceAt(a.deep.x, a.deep.z), lo.clearanceAt(a.deep.x, a.deep.z), 0.02, `${a.kind} ${a.id}: same headroom:`);
  }
});

test("caves: clearanceAt / ceilingAt / shelterAt / groundAt inside, outside and in the rock", () => {
  const t = getHiTerrain();
  for (const c of t.caves) {
    const d = c.deep;
    assert(t.inCave(d.x, d.z) && t.nearCave(d.x, d.z), `${c.kind} ${c.id}: deep point is inside`);
    const clr = t.clearanceAt(d.x, d.z);
    assert.range(clr, c.height * 0.8, c.maxHeight + 1.5, `${c.kind} ${c.id}: headroom inside`);
    assert.near(t.ceilingAt(d.x, d.z) - t.heightAt(d.x, d.z), clr, 1e-4, "clearance = ceiling − floor:");
    assert(t.shelterAt(d.x, d.z) > 0.4, `${c.kind} ${c.id}: dark deep inside (shelter ${t.shelterAt(d.x, d.z).toFixed(2)})`);
    assert.equal(t.biomeAt(d.x, d.z), "rock", "a cave floor is bare rock:");
    // From inside the floor, from above the hillside on the roof.
    const top = t.surfaceAt(d.x, d.z);
    assert(top > t.ceilingAt(d.x, d.z), "the hillside lies above the vault");
    assert.near(t.groundAt(d.x, d.z, t.heightAt(d.x, d.z) + 1), t.heightAt(d.x, d.z), 1e-6, "groundAt from inside:");
    assert.near(t.groundAt(d.x, d.z, top + 1), top, 0.05, "groundAt from on top:");
    for (const e of c.entrances) {
      assert.equal(t.clearanceAt(e.outsideX + Math.sin(e.heading) * 4, e.outsideZ + Math.cos(e.heading) * 4), Infinity, "open sky outside a mouth:");
      assert(t.shelterAt(e.outsideX, e.outsideZ) < 0.2, "daylight at the mouth");
    }
    // Beside the vault is solid rock: no headroom at all.
    const p = c.path[Math.floor(c.path.length / 2)];
    const q = c.path[Math.floor(c.path.length / 2) + 1] || p;
    const tl = Math.hypot(q.x - p.x, q.z - p.z) || 1;
    const nx = -(q.z - p.z) / tl;
    const nz = (q.x - p.x) / tl;
    if (t.inCave(p.x, p.z)) {
      const side = c.maxWidth / 2 + 3;
      assert(t.clearanceAt(p.x + nx * side, p.z + nz * side) <= 0.2, `${c.kind} ${c.id}: rock beside the vault`);
    }
  }
  // Far from any cave everything is open.
  assert.equal(t.ceilingAt(-t.half + 30, -t.half + 30), Infinity, "open sea corner:");
  assert.equal(t.shelterAt(-t.half + 30, -t.half + 30), 0, "no shelter in the open:");
});

test("caves: findSpawnPoint and the vegetation keep out of caves", () => {
  const t = getHiTerrain();
  const r = makeRng(5);
  for (let i = 0; i < 300; i++) {
    const c = t.caves[i % t.caves.length];
    const e = c.entrances[0];
    const p = t.findSpawnPoint(r, { near: { x: e.x, z: e.z, minR: 0, maxR: 60 }, tries: 50 });
    if (p) assert(!t.nearCave(p.x, p.z), `spawn point ${p.x.toFixed(1)}, ${p.z.toFixed(1)} is in a cave`);
  }
  const w = getWorld();
  const wt = w.terrain;
  for (const p of w.vegetation.plants) assert(!wt.nearCave(p.x, p.z), `a ${p.kind} grows in a cave at ${p.x.toFixed(1)}, ${p.z.toFixed(1)}`);
  for (const c of wt.caves) {
    for (const q of c.path) {
      const cols = w.vegetation.collidersNear(q.x, q.z, 4, []);
      for (const k of cols) assert(!wt.inCave(k.x, k.z), `a ${k.kind} stands in a cave at ${k.x.toFixed(1)}, ${k.z.toFixed(1)}`);
    }
  }
});

/** Steer a creature along waypoints for `seconds` (no brain): what the player would do. */
function walkAlong(c, pts, seconds, dt = 0.05) {
  let k = 0;
  for (let s = 0; s < seconds; s += dt) {
    while (k < pts.length - 1 && Math.hypot(pts[k].x - c.position.x, pts[k].z - c.position.z) < 2.5) k++;
    const dx = pts[k].x - c.position.x;
    const dz = pts[k].z - c.position.z;
    const l = Math.hypot(dx, dz) || 1;
    c.intent.moveX = (dx / l) * 0.5;
    c.intent.moveZ = (dz / l) * 0.5;
    c.update(dt);
  }
  c.intent.moveX = c.intent.moveZ = 0;
}

/** The waypoints from just outside a cave's (first) mouth to its deepest point. */
function intoCave(c) {
  const e = c.entrances[0];
  let iDeep = 0;
  let best = Infinity;
  c.path.forEach((p, i) => {
    const d = Math.hypot(p.x - c.deep.x, p.z - c.deep.z);
    if (d < best) {
      best = d;
      iDeep = i;
    }
  });
  let iMouth = 0;
  best = Infinity;
  c.path.forEach((p, i) => {
    const d = Math.hypot(p.x - e.x, p.z - e.z);
    if (d < best) {
      best = d;
      iMouth = i;
    }
  });
  const pts = [{ x: e.outsideX, z: e.outsideZ }];
  const dir = iDeep >= iMouth ? 1 : -1;
  for (let i = iMouth; i !== iDeep + dir; i += dir) pts.push(c.path[i]);
  pts.push(c.deep);
  return pts;
}

test("caves: a raptor walks into a den; a Brontosaurus (and an adult Allosaurus) can't fit", () => {
  const w = getWorld();
  const eco = w.ecosystem;
  const t = w.terrain;
  const den = t.caves.find((c) => c.kind === "den");
  const e = den.entrances[0];
  const made = [];
  const at = (id) => {
    const c = eco.spawn(id, e.outsideX + Math.sin(e.heading) * 6, e.outsideZ + Math.cos(e.heading) * 6, { growth: 1, heading: e.heading + Math.PI });
    if (c.brain) c.brain.update = () => {}; // we steer
    made.push(c);
    return c;
  };
  try {
    const raptor = at("utahraptor");
    assert(raptor.standHeight < den.height, `an adult raptor (${raptor.standHeight.toFixed(2)} m) fits a den (${den.height.toFixed(2)} m)`);
    walkAlong(raptor, intoCave(den), 25);
    assert(t.inCave(raptor.position.x, raptor.position.z), "the raptor made it inside");
    assert(raptor.position.y < t.ceilingAt(raptor.position.x, raptor.position.z), "…and stands under the roof, on the floor");
    const sh = t.shelterAt(raptor.position.x, raptor.position.z);
    assert(sh > 0.05 && raptor._shade < 1 - 0.5 * sh, `the den darkens it (shelter ${sh.toFixed(2)}, shade ${raptor._shade.toFixed(2)}, ${Math.hypot(raptor.position.x - e.x, raptor.position.z - e.z).toFixed(1)} m in)`);
    eco.remove(raptor);
    for (const id of ["brontosaurus", "allosaurus"]) {
      const big = at(id);
      assert(big.standHeight > den.height, `${id} stands taller than the den's mouth`);
      walkAlong(big, intoCave(den), 25);
      assert(!t.inCave(big.position.x, big.position.z), `the ${id} stayed outside`);
      eco.remove(big);
    }
  } finally {
    for (const c of made) eco.remove(c);
  }
});

test("caves: the ecosystem never spawns an animal inside one", () => {
  const w = getWorld();
  const eco = w.ecosystem;
  const t = w.terrain;
  const spawned = capture("spawn", () => {
    for (const c of t.caves) {
      const e = c.entrances[0];
      const f = { x: e.x, y: 0, z: e.z };
      for (let i = 0; i < 40; i++) eco._safeSpawnAt?.(f, 0, 90, 4, null);
    }
  });
  assert(spawned.length > 0, "something spawned near the caves");
  for (const ev of spawned) {
    const p = ev.creature.position;
    assert(!t.nearCave(p.x, p.z), `a ${ev.creature.species.id} spawned in a cave at ${p.x.toFixed(1)}, ${p.z.toFixed(1)}`);
  }
  for (const ev of spawned) eco.remove(ev.creature);
});

test("camera: inside a cave it stays under the rock and never in it, whatever the orbit", () => {
  const t = getHiTerrain();
  const cam = new THREE.PerspectiveCamera(60, 16 / 9, 0.1, 2000);
  const tpc = new ThirdPersonCamera(cam, t);
  for (const c of t.caves) {
    for (const id of ["dryosaurus", "utahraptor"]) {
      const sp = getSpecies(id);
      const p = c.deep;
      const creature = {
        species: sp,
        scale: 1,
        alive: true,
        speed: 0,
        heading: 0,
        gait: "idle",
        velocity: new THREE.Vector3(),
        position: new THREE.Vector3(p.x, t.heightAt(p.x, p.z), p.z),
      };
      tpc.snap();
      for (let k = 0; k < 8; k++) {
        tpc.yaw = (k / 8) * Math.PI * 2;
        tpc.pitch = k % 2 ? 1.2 : 0.3;
        tpc.zoom = 2.2;
        for (let i = 0; i < 30; i++) tpc.update(0.05, creature);
        const q = cam.position;
        const ceil = t.ceilingAt(q.x, q.z);
        assert(ceil !== Infinity, `${c.kind} ${c.id} (${id}, yaw ${k}): camera left the cave (${q.x.toFixed(1)}, ${q.y.toFixed(1)}, ${q.z.toFixed(1)})`);
        assert(q.y < ceil - 0.2, `${c.kind} ${c.id} (${id}, yaw ${k}): camera at ${q.y.toFixed(2)} pokes into the roof (${ceil.toFixed(2)})`);
        assert(q.y > t.heightAt(q.x, q.z) + 0.15, `${c.kind} ${c.id} (${id}, yaw ${k}): camera below the floor`);
      }
    }
  }
});

/* --- creatures/species.js ------------------------------------------------- */

const DIETS = ["carnivore", "herbivore"];
const ATTACKS = ["bite", "tail", "kick"];
const SOCIAL = ["solo", "pair", "pack", "herd"];
const CALLS = ["roar", "bellow", "honk", "chirp", "shriek", "hoot", "rumble", "rattle"];
const posNum = (v) => typeof v === "number" && Number.isFinite(v) && v > 0;
const str = (v) => typeof v === "string" && v.trim().length > 0;

test("species: every SpeciesDef carries the full contract with sane values", () => {
  const ids = Object.keys(SPECIES);
  assert(ids.length >= 10, `expected ≥ 10 species, got ${ids.length}`);
  for (const id of ids) {
    const s = SPECIES[id];
    const at = `[${id}]`;
    assert.equal(s.id, id, `${at} id key:`);
    for (const f of ["name", "tagline", "description", "era"]) assert(str(s[f]), `${at} ${f} missing`);
    assert(DIETS.includes(s.diet), `${at} diet ${s.diet}`);
    assert(typeof s.playable === "boolean", `${at} playable must be boolean`);
    for (const f of ["length", "height", "mass", "health", "bite", "biteCooldown", "biteRange", "turnRate", "growthMinutes", "perception"]) {
      assert(posNum(s[f]), `${at} ${f} must be > 0 (got ${s[f]})`);
    }
    assert(s.height < s.length, `${at} hip height should be below length`);
    assert(ATTACKS.includes(s.attack), `${at} attack ${s.attack}`);
    assert.range(s.armor, 0, 0.7, `${at} armor`);
    assert(typeof s.bleed === "number" && s.bleed >= 0, `${at} bleed`);
    const sp = s.speed || {};
    for (const g of ["walk", "trot", "sprint", "crouch", "swim"]) assert(posNum(sp[g]), `${at} speed.${g}`);
    assert(sp.walk < sp.trot && sp.trot < sp.sprint, `${at} walk < trot < sprint`);
    assert(sp.crouch <= sp.trot, `${at} crouch should be slow`);
    assert(posNum(s.stamina?.regen) && posNum(s.stamina?.sprintDrain), `${at} stamina.regen / sprintDrain`);
    assert(posNum(s.metabolism?.hunger) && posNum(s.metabolism?.thirst), `${at} metabolism.hunger / thirst`);
    assert(s.juvenileScale > 0 && s.juvenileScale < 1, `${at} juvenileScale in (0, 1)`);
    assert.range(s.swim, 0, 1, `${at} swim`);
    assert(SOCIAL.includes(s.social), `${at} social ${s.social}`);
    const gs = s.groupSize;
    assert(Array.isArray(gs) && gs.length === 2 && gs[0] >= 1 && gs[0] <= gs[1], `${at} groupSize ${fmt(gs)}`);
    assert.range(s.aggression, 0, 1, `${at} aggression`);
    assert(typeof s.spawnWeight === "number" && s.spawnWeight >= 0, `${at} spawnWeight`);
    assert(Array.isArray(s.biomes) && s.biomes.length > 0, `${at} biomes`);
    for (const b of s.biomes) assert(BIOMES.includes(b), `${at} unknown biome ${b}`);
    assert(CALLS.includes(s.call?.kind), `${at} call.kind ${s.call?.kind}`);
    assert(posNum(s.call.pitch) && posNum(s.call.duration), `${at} call pitch / duration`);
    assert(s.colors && typeof s.colors === "object", `${at} colors`);
    assert(s.body && typeof s.body === "object", `${at} body`);
    // Optional knobs, when present.
    if (s.pierce != null) assert.range(s.pierce, 0, 1, `${at} pierce`);
    if (s.attackStamina != null) assert(posNum(s.attackStamina), `${at} attackStamina`);
    if (s.juvenileSpeed != null) assert.range(s.juvenileSpeed, 0.5, 1.5, `${at} juvenileSpeed`);
    if (s.smell != null) assert.range(s.smell, 0.25, 3, `${at} smell`);
    if (s.swimDepth != null) assert.range(s.swimDepth, 0.3, 1.3, `${at} swimDepth`);
    if (s.waterAffinity != null) assert.range(s.waterAffinity, 0, 1, `${at} waterAffinity`);
    if (s.pairChance != null) assert.range(s.pairChance, 0, 1, `${at} pairChance`);
    if (s.maxAlive != null) assert(Number.isInteger(s.maxAlive) && s.maxAlive >= 1, `${at} maxAlive ${s.maxAlive}`);
    assert.equal(getSpecies(id), s, `${at} getSpecies:`);
  }
});

test("species: PLAYABLE ids exist (brontosaurus included), NPC-only stay unplayable", () => {
  assert(PLAYABLE.length >= 8, `expected ≥ 8 playable species, got ${PLAYABLE.length}`);
  assert.equal(new Set(PLAYABLE).size, PLAYABLE.length, "no duplicates:");
  for (const id of ["dryosaurus", "utahraptor", "ceratosaurus", "stegosaurus", "allosaurus", "brontosaurus", "tyrannosaurus", "spinosaurus"]) {
    assert(PLAYABLE.includes(id), `${id} should be playable`);
  }
  for (const id of PLAYABLE) {
    assert(SPECIES[id], `PLAYABLE id ${id} missing from SPECIES`);
    assert.equal(SPECIES[id].playable, true, `${id}.playable:`);
  }
  // …and the other way round: a def marked playable must be on the menu.
  for (const s of Object.values(SPECIES)) if (s.playable) assert(PLAYABLE.includes(s.id), `${s.id} is playable but missing from PLAYABLE`);
  assert(!SPECIES.gastonia && !PLAYABLE.includes("gastonia"), "Gastonia has left the island");
  for (const id of ["camptosaurus", "diplodocus"]) {
    assert(SPECIES[id], `NPC species ${id} missing`);
    assert.equal(SPECIES[id].playable, false, `${id}.playable:`);
    assert(!PLAYABLE.includes(id), `${id} must not be playable`);
  }
  assert(PLAYABLE.some((id) => SPECIES[id].diet === "carnivore") && PLAYABLE.some((id) => SPECIES[id].diet === "herbivore"), "both diets playable");
  assert.throws(() => getSpecies("velociraptor"), "getSpecies(unknown)");
});

test("species: the apex newcomers — Tyrannosaurus and Spinosaurus — are rare, solitary and true to type", () => {
  const rex = SPECIES.tyrannosaurus;
  const spino = SPECIES.spinosaurus;
  const allo = SPECIES.allosaurus;
  for (const s of [rex, spino]) {
    const at = `[${s.id}]`;
    assert.equal(s.diet, "carnivore", `${at} diet:`);
    assert.equal(s.social, "solo", `${at} social:`);
    assert(/Cretaceous/.test(s.era), `${at} era should name its age: ${s.era}`);
    assert(s.spawnWeight > 0 && s.spawnWeight < allo.spawnWeight, `${at} rarer than Allosaurus (${s.spawnWeight})`);
    assert(s.maxAlive >= 1 && s.maxAlive <= 2, `${at} maxAlive ${s.maxAlive}`);
    assert(s.mass > allo.mass * 1.8, `${at} big enough that a grown Allosaurus gives way`);
    assert(s.length > allo.length, `${at} longer than Allosaurus`);
    assert(s.body.plan === "biped" && s.body.arms && s.body.hind, `${at} a biped body with arms`);
  }
  assert.equal(rex.name, "Tyrannosaurus rex", "T. rex name:");
  assert.equal(spino.name, "Spinosaurus", "Spinosaurus name:");
  // T. rex: the hardest bite, armour-crushing, the keenest nose; a slow, tiring sprinter.
  for (const s of Object.values(SPECIES)) if (s !== rex) assert(rex.bite > s.bite, `T. rex should out-bite ${s.id}`);
  assert(rex.pierce > 0 && rex.smell > 1, "T. rex pierces armour and smells far");
  assert(rex.speed.sprint < allo.speed.sprint && rex.turnRate < allo.turnRate, "T. rex is slower and clumsier than Allosaurus");
  assert(rex.juvenileSpeed > 1, "young tyrannosaurs are the fast ones");
  assert.equal(rex.call.kind, "rumble", "T. rex call:");
  // Spinosaurus: the longest hunter, the best swimmer, a water's-edge ambusher.
  for (const s of Object.values(SPECIES)) {
    if (s !== spino) assert(spino.swim >= s.swim && spino.speed.swim >= s.speed.swim, `Spinosaurus should out-swim ${s.id}`);
    if (s !== spino && s.diet === "carnivore") assert(spino.length > s.length, `Spinosaurus should be longer than ${s.id}`);
  }
  assert(spino.waterAffinity > 0.5 && spino.biomes.includes("swamp") && spino.biomes.includes("beach"), "Spinosaurus keeps to the water");
  assert(spino.height < allo.height, "Spinosaurus stands lower at the hip than Allosaurus");
  assert(spino.body.features?.sail, "Spinosaurus carries its sail");
  assert.equal(spino.call.kind, "rattle", "Spinosaurus call:");
});

test("menu: every species has its own field-guide plate (none borrows another's drawing)", () => {
  // A species without a PLANS entry falls back to another species' drawing, so
  // the plates (without their length-dependent scale bars) must all differ.
  const seen = new Map();
  for (const def of Object.values(SPECIES)) {
    const svg = speciesSilhouette(def, { scale: false });
    assert(/^<svg class="sil"/.test(svg) && svg.includes("sil-body"), `[${def.id}] silhouette markup`);
    assert(!seen.has(svg), `[${def.id}] draws the same plate as ${seen.get(svg)} — add a PLANS entry in menu.js`);
    seen.set(svg, def.id);
  }
});

test("species: growthScale is monotonic juvenileScale → 1; growthStage boundaries", () => {
  for (const s of Object.values(SPECIES)) {
    assert.near(growthScale(s, 0), s.juvenileScale, 1e-9, `[${s.id}] scale at 0:`);
    assert.near(growthScale(s, 1), 1, 1e-9, `[${s.id}] scale at 1:`);
    let prev = -Infinity;
    for (let g = 0; g <= 1.0001; g += 0.02) {
      const v = growthScale(s, g);
      assert(v >= prev - 1e-12, `[${s.id}] growthScale not monotonic at ${g.toFixed(2)}`);
      prev = v;
    }
    assert.near(growthScale(s, -1), s.juvenileScale, 1e-9, `[${s.id}] clamps below 0:`);
    assert.near(growthScale(s, 2), 1, 1e-9, `[${s.id}] clamps above 1:`);
  }
  assert.equal(growthStage(0), "juvenile");
  assert.equal(growthStage(0.399), "juvenile");
  assert.equal(growthStage(0.4), "subadult");
  assert.equal(growthStage(0.999), "subadult");
  assert.equal(growthStage(1), "adult");
});

/* --- world/wind.js -------------------------------------------------------- */

test("wind: scentFactor ≈1.6 downwind, ≈1 crosswind, ≈0.15 upwind, ≈0.8 in still air", () => {
  const w = new Wind(77);
  w.strength = 1;
  w.yaw = 0;
  w.vector.set(0, 0, 1); // blowing toward +Z
  // from the source at the origin to a receiver 100 m away
  assert.near(w.scentFactor(0, 0, 0, 100), 1.6, 0.02, "straight downwind:");
  assert.near(w.scentFactor(0, 0, 100, 0), 1.0, 0.02, "crosswind:");
  assert.near(w.scentFactor(0, 0, 0, -100), 0.15, 0.02, "straight upwind:");
  const diag = w.scentFactor(0, 0, 70, 70);
  assert(diag > 1 && diag < 1.6, `quartering downwind between cross and down (got ${diag})`);
  w.strength = 0.02;
  for (const [x, z] of [[0, 100], [100, 0], [0, -100]]) assert.near(w.scentFactor(0, 0, x, z), 0.8, 0.02, "still air:");
});

test("wind: deterministic per seed; strength stays in [0, 1], vector stays unit", () => {
  const a = new Wind(5);
  const b = new Wind(5);
  for (let i = 0; i < 12000; i++) {
    a.update(0.05);
    b.update(0.05);
    if (i % 200 === 0) {
      assert.range(a.strength, 0, 1, "strength");
      assert.near(a.vector.length(), 1, 1e-6, "vector length:");
      assert.near(a.vector.x, Math.sin(a.yaw), 1e-6, "vector.x = sin(yaw):");
    }
  }
  assert.equal(a.yaw, b.yaw, "same seed yaw:");
  assert.equal(a.strength, b.strength, "same seed strength:");
});

/* --- core/events.js ------------------------------------------------------- */

test("events: on / emit / unsubscribe", () => {
  const bus = new EventBus();
  const got = [];
  const off = bus.on("x", (p) => got.push(p.v));
  bus.emit("x", { v: 1 });
  bus.emit("y", { v: 99 });
  off();
  bus.emit("x", { v: 2 });
  assert.equal(got.join(","), "1", "received:");
});

/* --- Simulation on a real (low-resolution) World -------------------------- */

let world = null;
function getWorld() {
  if (world) return world;
  const scene = new THREE.Scene();
  const camera = new THREE.PerspectiveCamera(60, 1, 0.1, 2000);
  const quality = { ...QUALITY.low, terrainResolution: TERRAIN_RES, vegetationDensity: 0.15, grass: false, npcScale: 0.2, shadows: false };
  world = new World({ scene, camera, renderer: null, seed: WORLD.seed, quality, startPhase: 0.4 });
  world.sky.paused = true;
  return world;
}

/** A dry, gentle spot for test creatures. */
function landSpot(seed = 1) {
  const w = getWorld();
  const p = w.terrain.findSpawnPoint(makeRng(seed), { biomes: ["plains", "forest"], minHeight: 2, maxSlope: 0.15 });
  assert(p, "no land spot found");
  return p;
}

/** Collect events of `name` while fn runs. */
function capture(name, fn) {
  const got = [];
  const off = getWorld().events.on(name, (e) => got.push(e));
  try {
    fn();
  } finally {
    off();
  }
  return got;
}

function step(c, seconds, dt = 0.05) {
  const n = Math.round(seconds / dt);
  for (let i = 0; i < n; i++) c.update(dt);
}

test("world: builds at low resolution with terrain, sky, water, vegetation, wind, ecosystem", () => {
  const w = getWorld();
  for (const k of ["terrain", "sky", "water", "vegetation", "wind", "ecosystem", "events"]) assert(w[k], `world.${k} missing`);
  assert.equal(w.terrain.resolution, TERRAIN_RES, "terrain resolution:");
  assert(w.vegetation.plants.length > 0, "vegetation has food plants");
  const p = landSpot(2);
  const plant = w.vegetation.nearestPlant(p.x, p.z, 400);
  assert(plant && plant.maxFood > 0, "a food plant within 400 m of a plains spot");
  const before = plant.food;
  const removed = w.vegetation.eatPlant(plant, 5);
  assert.near(removed, Math.min(5, before), 1e-9, "eatPlant removes what it can:");
  assert.near(plant.food, before - removed, 1e-9, "plant food decreases:");
});

test("creature: metabolism drains food/water at the species rate (NPCs ×0.35)", () => {
  const w = getWorld();
  const eco = w.ecosystem;
  const p = landSpot(3);
  const sp = getSpecies("utahraptor");
  const player = eco.spawn(sp.id, p.x, p.z, { growth: 0.5, isPlayer: true });
  const npc = eco.spawn(sp.id, p.x + 6, p.z, { growth: 0.5 });
  try {
    for (const c of [player, npc]) {
      c.food = 80;
      c.water = 80;
      c.resting = false;
    }
    step(player, 60);
    step(npc, 60);
    assert(!player.swimming && !npc.swimming, "test creatures should stand on land");
    assert.near(80 - player.food, sp.metabolism.hunger, sp.metabolism.hunger * 0.15, "player food drained in 1 min:");
    assert.near(80 - player.water, sp.metabolism.thirst, sp.metabolism.thirst * 0.15, "player water drained in 1 min:");
    assert.near(80 - npc.food, sp.metabolism.hunger * 0.35, sp.metabolism.hunger * 0.1, "NPC food drained in 1 min:");
  } finally {
    eco.clearPlayer();
    eco.remove(player);
    eco.remove(npc);
  }
});

test("creature: starvation damages ~1% maxHealth/s; growth advances when fed", () => {
  const w = getWorld();
  const eco = w.ecosystem;
  const p = landSpot(4);
  const c = eco.spawn("dryosaurus", p.x, p.z, { growth: 0.2, isPlayer: true });
  try {
    c.food = 0;
    c.water = 100;
    const hp0 = c.health;
    const events = capture("damage", () => step(c, 10));
    assert.near(hp0 - c.health, c.maxHealth * 0.1, c.maxHealth * 0.02, "health lost to 10 s of starvation:");
    assert(events.some((e) => e.target === c && e.type === "starve"), "a 'starve' damage event fired");
    assert(c.growth <= 0.2 + 1e-9, "no growth while starving");
    c.food = 100;
    c.water = 100;
    const g0 = c.growth;
    step(c, 30);
    const expected = 30 / (c.species.growthMinutes * 60);
    assert.near(c.growth - g0, expected, expected * 0.1, "growth over 30 s fed:");
  } finally {
    eco.clearPlayer();
    eco.remove(c);
  }
});

test("creature: armor reduces attacks (less what a crushing bite pierces), ignores starvation", () => {
  const w = getWorld();
  const eco = w.ecosystem;
  const p = landSpot(5);
  const g = eco.spawn("stegosaurus", p.x, p.z, { growth: 1 });
  try {
    const armor = g.species.armor;
    assert(armor >= 0.25, "stegosaurus is armoured");
    const events = capture("damage", () => {
      assert.near(g.takeDamage(100, null, "bite"), 100 * (1 - armor), 1e-6, "bite after armor:");
      assert.near(g.takeDamage(100, null, "tail"), 100 * (1 - armor), 1e-6, "tail after armor:");
      assert.near(g.takeDamage(20, null, "starve"), 20, 1e-6, "starve ignores armor:");
      assert.near(g.takeDamage(100, null, "bite", 0.5), 100 * (1 - armor * 0.5), 1e-6, "a bite that pierces half the armour:");
    });
    assert.equal(events.length, 4, "one damage event per hit:");
    assert.near(g.health, g.maxHealth - 200 * (1 - armor) - 20 - 100 * (1 - armor * 0.5), 1e-6, "health bookkeeping:");
    assert.equal(g.takeDamage(-5, null, "bite"), 0, "negative damage is ignored:");
    const hp = g.health;
    g.heal(1e9);
    assert(g.health > hp && g.health <= g.maxHealth, "heal clamps to maxHealth");
  } finally {
    eco.remove(g);
  }
});

test("creature + ecosystem: death credits the killer and leaves a carcass that is eaten and rots away", () => {
  const w = getWorld();
  const eco = w.ecosystem;
  const cap = eco.npcCap;
  eco.npcCap = 0; // keep the population out of this test
  const p = landSpot(6);
  const killer = eco.spawn("allosaurus", p.x + 8, p.z, { growth: 1 });
  const prey = eco.spawn("dryosaurus", p.x, p.z, { growth: 1 });
  try {
    const deaths = capture("death", () => prey.takeDamage(1e6, killer, "bite"));
    assert.equal(prey.alive, false, "prey dead:");
    assert.equal(deaths.length, 1, "one death event:");
    assert.equal(deaths[0].killer, killer, "death event names the killer:");
    assert.equal(killer.kills, 1, "killer credited:");
    assert(/Allosaurus/.test(prey.causeOfDeath), `cause of death names the killer (${prey.causeOfDeath})`);
    assert.equal(prey.takeDamage(10, killer, "bite"), 0, "the dead take no damage:");

    const focus = new THREE.Vector3(p.x, 0, p.z);
    eco.update(0.05, focus);
    assert(!eco.creatures.includes(prey), "dead creature leaves the living list");
    const k = eco.carcasses.find((c) => c.creature === prey);
    assert(k, "a carcass was created");
    assert.near(k.meat, prey.mass * 0.5, 1e-6, "carcass meat = mass × 0.5:");
    assert.equal(eco.nearestCarcass(p.x, p.z, 15), k, "nearestCarcass finds it:");
    assert.equal(eco.nearestCarcass(p.x + 500, p.z, 15), null, "nothing far away:");
    assert.near(eco.eatCarcass(k, 5), 5, 1e-9, "eatCarcass removes 5 kg:");
    assert.near(eco.eatCarcass(k, 1e6), k.maxMeat - 5, 1e-6, "eatCarcass removes at most what is left:");
    eco.update(0.05, focus);
    assert(k.fading > 0, "a stripped carcass starts to fade");
    assert.equal(eco.nearestCarcass(p.x, p.z, 15), null, "a fading carcass is no longer food:");
    for (let i = 0; i < 120 && eco.carcasses.includes(k); i++) eco.update(0.05, focus);
    assert(!eco.carcasses.includes(k), "the spent carcass is removed after fading");
  } finally {
    eco.remove(killer);
    eco.npcCap = cap;
  }
});

test("ecosystem: rare apex species never exceed maxAlive in the wild (a player of the kind doesn't count)", () => {
  const w = getWorld();
  const eco = w.ecosystem;
  const cap = eco.npcCap;
  eco.npcCap = 200; // room for predators, whatever the test world holds
  const p = landSpot(9);
  const spawned = [];
  const wild = (id) => eco.creatures.filter((c) => c.species.id === id && !c.isPlayer);
  const picks = (biome, id, n = 300) => {
    let k = 0;
    for (let i = 0; i < n; i++) if (eco._pickSpecies(biome, Infinity, "carnivore")?.id === id) k++;
    return k;
  };
  try {
    for (const id of ["spinosaurus", "tyrannosaurus"]) for (const c of wild(id)) eco.remove(c);
    assert(picks("swamp", "spinosaurus") > 0, "a Spinosaurus can turn up when none is about");
    assert(picks("forest", "tyrannosaurus") > 0, "a T. rex can turn up when none is about");
    const me = eco.spawn("spinosaurus", p.x, p.z, { growth: 0, isPlayer: true });
    spawned.push(me);
    assert(picks("swamp", "spinosaurus") > 0, "the player's own kind doesn't use up the wild one");
    spawned.push(eco.spawn("spinosaurus", p.x + 40, p.z, { growth: 1 }));
    assert.equal(picks("swamp", "spinosaurus"), 0, "with one Spinosaurus about, no second:");
    spawned.push(eco.spawn("tyrannosaurus", p.x - 40, p.z, { growth: 1 }));
    assert(picks("forest", "tyrannosaurus") > 0, "T. rex allows a second");
    spawned.push(eco.spawn("tyrannosaurus", p.x - 40, p.z + 40, { growth: 1 }));
    assert.equal(picks("forest", "tyrannosaurus"), 0, "with two T. rex about, no third:");
  } finally {
    eco.clearPlayer();
    for (const c of spawned) eco.remove(c);
    eco.npcCap = cap;
  }
});

test("ai: a Spinosaurus backs away from a big herbivore that turns on it; a T. rex fights back", () => {
  const w = getWorld();
  const eco = w.ecosystem;
  const p = landSpot(11);
  const made = [];
  const at = (id, dx, dz, still = false) => {
    const c = eco.spawn(id, p.x + dx, p.z + dz, { growth: 1 });
    if (still) c.brain = null; // a sparring partner that stays put
    made.push(c);
    return c;
  };
  // One blow from `foe`, then a moment for `c` to think it over.
  const struck = (c, foe) => {
    c.takeDamage(30, foe, "tail");
    for (let i = 0; i < 4; i++) c.brain.update(0.05);
    return { state: c.brain.state, target: c.brain.target };
  };
  try {
    const bronto = at("brontosaurus", 0, 14, true);
    const campto = at("camptosaurus", -40, 0, true);
    let r = struck(at("spinosaurus", 0, 0), bronto);
    assert.equal(r.state, "flee", "Spinosaurus struck by a Brontosaurus:");
    r = struck(at("spinosaurus", -40, 10), campto);
    assert(r.state === "hunt" && r.target === campto, `Spinosaurus should turn on a Camptosaurus that strikes it, got ${r.state}`);
    r = struck(at("tyrannosaurus", 30, 0), bronto);
    assert(r.state === "hunt" && r.target === bronto, `T. rex should fight back against a Brontosaurus, got ${r.state}`);
  } finally {
    for (const c of made) eco.remove(c);
  }
});

test("ecosystem: herd and pack hatchlings join their own kind (an NPC adult leads); loners hatch alone", () => {
  const w = getWorld();
  const eco = w.ecosystem;
  const p = landSpot(13);
  const made = [];
  try {
    for (const id of ["dryosaurus", "utahraptor"]) {
      const me = eco.spawn(id, p.x, p.z, { growth: 0, isPlayer: true });
      const ev = capture("groupJoined", () => eco.formPlayerGroup(me));
      const g = me.group;
      assert(g && g.members.includes(me), `${id}: the hatchling belongs to a group`);
      const mates = g.members.filter((m) => m !== me);
      made.push(...mates);
      assert(mates.length >= 2 && mates.every((m) => m.species.id === id && m.brain), `${id}: two or more NPC mates of its kind, got ${mates.length}`);
      assert(g.leader && !g.leader.isPlayer && g.leader.growth === 1, `${id}: an adult NPC leads`);
      assert(ev.length === 1 && ev[0].formed && ev[0].group === g && !ev[0].resumed, `${id}: one groupJoined (formed)`);
      const far = Math.max(...mates.map((m) => Math.hypot(m.position.x - me.position.x, m.position.z - me.position.z)));
      assert(far < 60, `${id}: mates gather close by (farthest ${fmt(far)} m)`);
      eco.clearPlayer();
    }
    const allo = eco.spawn("allosaurus", p.x, p.z, { growth: 0, isPlayer: true });
    assert.equal(eco.formPlayerGroup(allo), null, "an Allosaurus hatches alone:");
    assert(!allo.group, "no group for a loner");
  } finally {
    eco.clearPlayer();
    for (const c of made) eco.remove(c);
  }
});

test("ecosystem: a player who strays loses its herd; calling near one joins it", () => {
  const w = getWorld();
  const eco = w.ecosystem;
  const p = landSpot(14);
  let mates = [];
  try {
    const me = eco.spawn("stegosaurus", p.x, p.z, { growth: 0.3, isPlayer: true });
    eco.formPlayerGroup(me);
    const g = me.group;
    mates = g.members.filter((m) => m !== me);
    me.position.x += 200; // well clear of every mate
    const stray = capture("groupStray", () => eco._updatePlayerGroup(0.5));
    assert(stray.length === 1 && me.group === g, "drifting away warns once and keeps the membership");
    const left = capture("groupLeft", () => {
      for (let i = 0; i < 60; i++) eco._updatePlayerGroup(0.5);
    });
    assert(left.length === 1 && left[0].reason === "strayed" && !me.group, "after a while away the herd is lost");
    assert(!g.members.includes(me) && g.leader && !g.leader.isPlayer, "the herd carries on under its leader");
    me.position.x -= 200;
    const joined = capture("groupJoined", () => w.events.emit("call", { creature: me, x: me.position.x, z: me.position.z }));
    assert(joined.length === 1 && me.group === g && !joined[0].formed, "a call near the herd joins it");
    const quiet = capture("groupJoined", () => w.events.emit("call", { creature: me, x: me.position.x, z: me.position.z }));
    assert.equal(quiet.length, 0, "calling again changes nothing:");
  } finally {
    eco.clearPlayer();
    for (const c of mates) eco.remove(c);
  }
});

test("ai: the herd defends its player, its leader waits and comes back when called; a pack runs down the player's quarry", () => {
  const w = getWorld();
  const eco = w.ecosystem;
  const p = landSpot(15);
  const made = [];
  const think = (list, n = 10) => {
    for (let i = 0; i < n; i++) for (const c of list) c.brain && c.brain.update(0.05);
  };
  try {
    // A Stegosaurus herd wades in when its hatchling is bitten.
    const me = eco.spawn("stegosaurus", p.x, p.z, { growth: 0.2, isPlayer: true });
    eco.formPlayerGroup(me);
    const herd = me.group.members.filter((m) => m !== me);
    made.push(...herd);
    for (const m of herd) Object.assign(m, { food: 100, water: 100 });
    const allo = eco.spawn("allosaurus", me.position.x + 6, me.position.z, { growth: 1 });
    allo.brain = null; // stands still for the test
    made.push(allo);
    me.takeDamage(5, allo, "bite");
    think(herd);
    assert(herd.some((m) => m.brain.state === "attack" && m.brain.target === allo), "an adult of the herd turns on whoever bit the hatchling");
    eco.remove(allo);

    // The leader holds while the player is far behind, and walks back after a call.
    // (Brains run on world time, which only moves in World.update: let the scare pass.)
    w.time += 30;
    const L = me.group.leader;
    for (const m of herd) Object.assign(m.brain, { state: "idle", target: null, mode: "", _threat: null, _attacker: null });
    me.position.x = L.position.x + 110;
    me.position.z = L.position.z;
    think([L], 12);
    assert(L.brain.state === "idle" && L.brain.mode === "wait", `the leader waits for a straggling player, got ${L.brain.state}/${L.brain.mode}`);
    w.events.emit("call", { creature: me, x: me.position.x, z: me.position.z });
    think([L], 12);
    assert(L.brain.state === "wander" && L.brain.mode === "regroup", `after a call the leader heads back, got ${L.brain.state}/${L.brain.mode}`);
    eco.clearPlayer();

    // A Utahraptor pack follows its player's lead.
    const raptor = eco.spawn("utahraptor", p.x + 60, p.z, { growth: 0.6, isPlayer: true });
    eco.formPlayerGroup(raptor);
    const pack = raptor.group.members.filter((m) => m !== raptor);
    made.push(...pack);
    // Sated and lazy: none will start a hunt of its own (see _wantsHunt), so any
    // hunt below is the one the player named.
    for (const m of pack) {
      Object.assign(m, { food: 100, water: 100 });
      m.brain._tiredUntil = w.time + 1e6;
    }
    const quarry = eco.spawn("camptosaurus", raptor.position.x + 14, raptor.position.z, { growth: 1 });
    quarry.brain = null;
    made.push(quarry);
    think(pack, 4);
    assert(!pack.some((m) => m.brain.target === quarry), "a full pack leaves the Camptosaurus alone at first");
    quarry.takeDamage(8, raptor, "bite");
    think(pack);
    assert(pack.some((m) => m.brain.state === "hunt" && m.brain.target === quarry), "once the player bites, the pack hunts its quarry, hungry or not");
  } finally {
    eco.clearPlayer();
    for (const c of made) eco.remove(c);
  }
});

test("ecosystem + ai: a full-grown player leads its herd; the herd follows it and rests with it", () => {
  const w = getWorld();
  const eco = w.ecosystem;
  const p = landSpot(16);
  let made = [];
  try {
    const me = eco.spawn("dryosaurus", p.x, p.z, { growth: 0.5, isPlayer: true });
    eco.formPlayerGroup(me);
    const g = me.group;
    made = g.members.filter((m) => m !== me);
    assert(g.leader !== me, "a sub-adult follows");
    me.growth = 1;
    const lead = capture("groupLead", () => {
      eco._updatePlayerGroup(0.1);
      eco._updatePlayerGroup(0.1);
    });
    assert(g.leader === me && lead.length === 1, "full grown, the player takes the lead (announced once)");
    w.time += 30;
    for (const m of made) {
      Object.assign(m, { food: 100, water: 100 });
      Object.assign(m.brain, { state: "idle", target: null, mode: "", _threat: null, _attacker: null });
    }
    // The player walks off: the herd follows.
    me.position.x += 30;
    me.speed = 3;
    me.heading = Math.PI / 2;
    for (let i = 0; i < 10; i++) for (const m of made) m.brain.update(0.05);
    const following = made.filter((m) => m.brain.state === "follow" && m.brain.target === me).length;
    assert(following >= Math.ceil(made.length / 2), `most of the herd follows its leader (${following}/${made.length})`);
    // The player lies down: the herd settles round it.
    me.speed = 0;
    me.resting = true;
    for (const m of made) m.position.set(me.position.x + (m.position.x - p.x) * 0.2, m.position.y, me.position.z + (m.position.z - p.z) * 0.2);
    for (let i = 0; i < 10; i++) for (const m of made) m.brain.update(0.05);
    const resting = made.filter((m) => m.brain.state === "rest").length;
    assert(resting >= Math.ceil(made.length / 2), `most of the herd rests by its resting leader (${resting}/${made.length})`);
  } finally {
    eco.clearPlayer();
    for (const c of made) eco.remove(c);
  }
});

test("ai: herds keep a daily round — water at dawn, plains by day, the forest edge at evening — once a day", () => {
  const w = getWorld();
  const eco = w.ecosystem;
  const p = landSpot(17);
  const phase0 = w.sky.phase;
  const day0 = w.sky.day;
  const herd = eco.spawnGroup("stegosaurus", p.x, p.z, 3, { growth: 1 });
  const L = herd.find((m) => m.group.leader === m);
  const b = L.brain;
  // One fresh decision for the leader at the given time of day.
  const decide = (phase) => {
    w.sky.setPhase(phase);
    w.time += 30;
    Object.assign(b, { state: "idle", target: null, mode: "", _threat: null, _attacker: null, _activityUntil: 0 });
    L.food = 100;
    for (let i = 0; i < 8; i++) b.update(0.05);
    return { state: b.state, mode: b.mode, dest: { ...b._destPt } };
  };
  try {
    L.water = 70;
    let r = decide(0.26);
    assert.equal(r.state, "drink", "at dawn the leader takes the herd to drink:");
    L.water = 100;
    r = decide(0.45);
    assert(r.state === "wander" && r.mode === "route", `by day it sets off for open ground, got ${r.state}/${r.mode}`);
    r = decide(0.46);
    assert(!(r.state === "wander" && r.mode === "route"), "each leg is set off on only once a day");
    r = decide(0.7);
    assert(r.state === "wander" && r.mode === "route", `at evening it heads for the forest edge, got ${r.state}/${r.mode}`);
    // Route news reaches a player travelling with the herd, and only then.
    w.sky.day += 1;
    L.water = 70;
    const quiet = capture("herdRoute", () => decide(0.26));
    assert(b.state === "drink" && quiet.length === 0, "a new day's dawn drink, unannounced without the player");
    const me = eco.spawn("stegosaurus", L.position.x + 8, L.position.z, { growth: 0.3, isPlayer: true });
    eco.joinGroup(me, L.group);
    w.sky.day += 1;
    L.water = 70;
    const news = capture("herdRoute", () => decide(0.26));
    assert(news.length === 1 && news[0].leg === "water" && news[0].group === me.group, "with the player in the herd, the dawn leg is announced once");
  } finally {
    eco.clearPlayer();
    w.sky.setPhase(phase0);
    w.sky.day = day0;
    for (const c of herd) eco.remove(c);
  }
});

test("ecosystem: query finds the living within a radius", () => {
  const w = getWorld();
  const eco = w.ecosystem;
  const p = landSpot(7);
  const a = eco.spawn("camptosaurus", p.x, p.z, { growth: 1 });
  const b = eco.spawn("camptosaurus", p.x + 30, p.z, { growth: 1 });
  try {
    const near = eco.query(p.x, p.z, 10);
    assert(near.includes(a) && !near.includes(b), "query radius 10 m");
    const wide = eco.query(p.x, p.z, 40, (c) => c.species.id === "camptosaurus");
    assert(wide.includes(a) && wide.includes(b), "query radius 40 m with a filter");
  } finally {
    eco.remove(a);
    eco.remove(b);
  }
});

run().catch((err) => {
  results.push({ name: "harness", status: "fail", ms: 0, error: String(err?.stack || err) });
  window.__unit.done = true;
});
