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

/* --- creatures/species.js ------------------------------------------------- */

const DIETS = ["carnivore", "herbivore"];
const ATTACKS = ["bite", "tail", "kick"];
const SOCIAL = ["solo", "pair", "pack", "herd"];
const CALLS = ["roar", "bellow", "honk", "chirp", "shriek", "hoot"];
const posNum = (v) => typeof v === "number" && Number.isFinite(v) && v > 0;
const str = (v) => typeof v === "string" && v.trim().length > 0;

test("species: every SpeciesDef carries the full contract with sane values", () => {
  const ids = Object.keys(SPECIES);
  assert(ids.length >= 9, `expected ≥ 9 species, got ${ids.length}`);
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
    assert.equal(getSpecies(id), s, `${at} getSpecies:`);
  }
});

test("species: PLAYABLE ids exist (brontosaurus included), NPC-only stay unplayable", () => {
  assert(PLAYABLE.length >= 7, `expected ≥ 7 playable species, got ${PLAYABLE.length}`);
  assert.equal(new Set(PLAYABLE).size, PLAYABLE.length, "no duplicates:");
  for (const id of ["dryosaurus", "utahraptor", "gastonia", "ceratosaurus", "stegosaurus", "allosaurus", "brontosaurus"]) {
    assert(PLAYABLE.includes(id), `${id} should be playable`);
  }
  for (const id of PLAYABLE) {
    assert(SPECIES[id], `PLAYABLE id ${id} missing from SPECIES`);
    assert.equal(SPECIES[id].playable, true, `${id}.playable:`);
  }
  for (const id of ["camptosaurus", "diplodocus"]) {
    assert(SPECIES[id], `NPC species ${id} missing`);
    assert.equal(SPECIES[id].playable, false, `${id}.playable:`);
    assert(!PLAYABLE.includes(id), `${id} must not be playable`);
  }
  assert(PLAYABLE.some((id) => SPECIES[id].diet === "carnivore") && PLAYABLE.some((id) => SPECIES[id].diet === "herbivore"), "both diets playable");
  assert.throws(() => getSpecies("velociraptor"), "getSpecies(unknown)");
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

test("creature: armor reduces attacks fully, ignores starvation", () => {
  const w = getWorld();
  const eco = w.ecosystem;
  const p = landSpot(5);
  const g = eco.spawn("gastonia", p.x, p.z, { growth: 1 });
  try {
    const armor = g.species.armor;
    assert(armor >= 0.5, "gastonia is armoured");
    const events = capture("damage", () => {
      assert.near(g.takeDamage(100, null, "bite"), 100 * (1 - armor), 1e-6, "bite after armor:");
      assert.near(g.takeDamage(100, null, "tail"), 100 * (1 - armor), 1e-6, "tail after armor:");
      assert.near(g.takeDamage(20, null, "starve"), 20, 1e-6, "starve ignores armor:");
    });
    assert.equal(events.length, 3, "one damage event per hit:");
    assert.near(g.health, g.maxHealth - 200 * (1 - armor) - 20, 1e-6, "health bookkeeping:");
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
