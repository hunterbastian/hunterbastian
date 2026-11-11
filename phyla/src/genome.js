// Genomes: the complete, serialisable description of a creature.
//
//   spine  ordered tail -> head, each node { y, z, r } in the creature's
//          sagittal plane (z forward, y up) with a body radius.
//   parts  { id, u, a, s } — u runs along the spine (-1 = tail tip, 0..n-1 =
//          the nodes, n = nose tip), a is the angle around the body from the
//          back (0) to the belly (PI). Off-centre parts are mirrored.
//   skin   base / accent / belly colours and a pattern.

import { PARTS } from './parts.js';
import { PATTERNS } from './skin.js';
import { clamp, hslHex, makeRng } from './util.js';

export const MAX_NODES = 12;
export const MIN_NODES = 3;
export const NODE_COST = 5;
export const FREE_NODES = 5;

export const isMirrored = (a) => a > 0.16 && a < Math.PI - 0.16;

export function cloneGenome(g) {
  return JSON.parse(JSON.stringify(g));
}

export function encodeGenome(g) {
  const slim = {
    n: g.name,
    s: g.spine.map((p) => [+p.y.toFixed(3), +p.z.toFixed(3), +p.r.toFixed(3)]),
    p: g.parts.map((p) => [p.id, +p.u.toFixed(3), +p.a.toFixed(3), +(p.s || 1).toFixed(2)]),
    k: [g.skin.base, g.skin.accent, g.skin.belly, g.skin.pattern],
  };
  return 'phyla1.' + btoa(unescape(encodeURIComponent(JSON.stringify(slim))));
}

export function decodeGenome(code) {
  try {
    const raw = code.trim().replace(/^phyla1\./, '');
    const o = JSON.parse(decodeURIComponent(escape(atob(raw))));
    const g = {
      name: String(o.n || 'Visitor').slice(0, 28),
      spine: o.s.slice(0, MAX_NODES).map((a) => ({ y: +a[0], z: +a[1], r: clamp(+a[2], 0.05, 0.8) })),
      parts: o.p.filter((a) => PARTS[a[0]]).slice(0, 40).map((a) => ({ id: a[0], u: +a[1], a: +a[2], s: clamp(+a[3] || 1, 0.5, 2) })),
      skin: { base: o.k[0], accent: o.k[1], belly: o.k[2], pattern: PATTERNS.includes(o.k[3]) ? o.k[3] : 'plain' },
    };
    if (g.spine.length < MIN_NODES || g.spine.some((p) => !isFinite(p.y + p.z + p.r))) return null;
    if (![g.skin.base, g.skin.accent, g.skin.belly].every((c) => /^#[0-9a-f]{6}$/i.test(c))) return null;
    return g;
  } catch {
    return null;
  }
}

/* --------------------------------- stats -------------------------------- */

const CAP = 5;

export function genomeCost(g) {
  let cost = Math.max(0, g.spine.length - FREE_NODES) * NODE_COST;
  for (const p of g.parts) cost += PARTS[p.id] ? PARTS[p.id].cost : 0;
  return cost;
}

export function computeStats(g) {
  const st = {
    bite: 0, ram: 0, swipe: 0,
    trill: 0, sway: 0, flare: 0, glow: 0,
    speed: 0, jump: 0, glide: 0, armor: 0, sight: 0, sense: 0,
    health: 0, legPairs: 0, arms: 0, mouths: 0, diet: 'none',
  };
  let mass = 0;
  let length = 0;
  for (let i = 0; i < g.spine.length - 1; i++) {
    const a = g.spine[i];
    const b = g.spine[i + 1];
    const d = Math.hypot(b.y - a.y, b.z - a.z);
    const r = (a.r + b.r) / 2;
    mass += Math.PI * r * r * d;
    length += d;
  }
  let legSpeed = 0;
  let herb = false;
  let carn = false;
  let bonusHealth = 0;
  for (const p of g.parts) {
    const d = PARTS[p.id];
    if (!d) continue;
    const s = d.stats || {};
    if (d.cat === 'leg') {
      st.legPairs += 1;
      legSpeed = Math.max(legSpeed, s.speed || 0);
    } else if (d.cat === 'arm') st.arms += 1;
    else if (d.cat === 'mouth') {
      st.mouths += 1;
      if (d.diet === 'herb') herb = true;
      else if (d.diet === 'carn') carn = true;
      else herb = carn = true;
      st.bite = Math.max(st.bite, s.bite || 0);
    }
    for (const k of ['ram', 'swipe', 'trill', 'sway', 'flare', 'glow', 'jump', 'glide', 'armor', 'sight', 'sense']) st[k] += s[k] || 0;
    bonusHealth += s.health || 0;
  }
  for (const k of ['ram', 'swipe', 'trill', 'sway', 'flare', 'glow', 'armor', 'sense']) st[k] = Math.min(st[k], CAP);
  st.diet = herb && carn ? 'omni' : herb ? 'herb' : carn ? 'carn' : 'none';
  st.mass = mass;
  st.length = length;
  st.speed = legSpeed;
  // metres per second on land
  st.moveSpeed = st.legPairs ? 2.7 + legSpeed * 1.05 - clamp(mass - 0.5, 0, 2.5) * 0.35 : 2.1;
  st.health = Math.round(34 + 70 * Math.pow(mass, 0.75) + bonusHealth);
  st.social = st.trill + st.sway + st.flare + st.glow;
  st.fierce = st.bite + st.ram + st.swipe;
  st.pitch = clamp(210 / Math.pow(Math.max(mass, 0.03), 0.36), 90, 900);
  return st;
}

/* ------------------------------- starters ------------------------------- */

const MOUTH_FOR = { herb: 'nibbler', carn: 'gnasher', omni: 'snuffler' };

export function starterGenome(diet = 'omni', skin) {
  return {
    name: 'Hatchling',
    spine: [
      { y: 0.3, z: -0.62, r: 0.08 },
      { y: 0.34, z: -0.3, r: 0.19 },
      { y: 0.36, z: 0.0, r: 0.24 },
      { y: 0.4, z: 0.3, r: 0.2 },
      { y: 0.5, z: 0.56, r: 0.2 },
    ],
    parts: [
      { id: MOUTH_FOR[diet] || 'snuffler', u: 4.82, a: Math.PI, s: 1 },
      { id: 'beadeye', u: 4.36, a: 0.78, s: 1 },
      { id: 'stumper', u: 1.2, a: 2.3, s: 1 },
      { id: 'stumper', u: 2.9, a: 2.3, s: 1 },
    ],
    skin: skin || { base: '#7fb069', accent: '#35654d', belly: '#ece3b8', pattern: 'dapple' },
  };
}

/* --------------------------- random creatures --------------------------- */

// Walk a list of { len, ang (degrees of pitch), r } segments from the tail.
function spineFrom(r0, segs) {
  let y = 0;
  let z = 0;
  const nodes = [{ y, z, r: r0 }];
  for (const s of segs) {
    const a = (s.ang * Math.PI) / 180;
    z += Math.cos(a) * s.len;
    y += Math.sin(a) * s.len;
    nodes.push({ y, z, r: s.r });
  }
  const zMid = (nodes[0].z + nodes[nodes.length - 1].z) / 2;
  const yMin = Math.min(...nodes.map((n) => n.y - n.r));
  for (const n of nodes) {
    n.z -= zMid;
    n.y -= yMin;
  }
  return nodes;
}

export function randomSkin(rnd, mood = 'any') {
  const h = rnd.range(0, 360);
  const warm = mood === 'fierce';
  const hue = warm ? rnd.pick([rnd.range(-20, 45), rnd.range(250, 320)]) : h;
  const base = hslHex(hue, rnd.range(34, 62), rnd.range(44, 62));
  const accent = hslHex(hue + rnd.pick([-150, -40, -25, 25, 40, 150, 180]), rnd.range(40, 75), rnd.range(22, 40));
  const belly = hslHex(hue + rnd.range(-25, 25), rnd.range(25, 50), rnd.range(76, 88));
  return { base, accent, belly, pattern: rnd.pick(PATTERNS) };
}

export const ARCHETYPES = ['grazer', 'critter', 'strutter', 'brute', 'stalker', 'longneck', 'serpent', 'skulker'];

export function randomGenome(seed, arch) {
  const rnd = makeRng(seed);
  arch = arch || rnd.pick(ARCHETYPES);
  const parts = [];
  let spine;
  let diet = 'herb';
  const add = (id, u, a, s = 1) => parts.push({ id, u, a, s });
  const j = (v, d) => v + rnd.range(-d, d);

  if (arch === 'grazer' || arch === 'brute' || arch === 'stalker' || arch === 'longneck') {
    const fat = arch === 'brute' ? 1.32 : arch === 'stalker' ? 0.9 : 1;
    const neckN = arch === 'longneck' ? rnd.int(3, 4) : rnd.int(1, 2);
    const neckAng = arch === 'longneck' ? rnd.range(58, 78) : arch === 'stalker' ? rnd.range(10, 30) : rnd.range(28, 58);
    const segs = [];
    const tailN = rnd.int(1, 3);
    for (let i = 0; i < tailN; i++) segs.push({ len: j(0.3, 0.05), ang: j(i === 0 ? 14 : 4, 10), r: (0.09 + i * 0.05) * fat });
    segs[tailN - 1].r = 0.2 * fat;
    segs.push({ len: j(0.36, 0.05), ang: j(0, 6), r: j(0.27, 0.03) * fat });
    segs.push({ len: j(0.36, 0.05), ang: j(4, 6), r: j(0.25, 0.03) * fat });
    for (let i = 0; i < neckN; i++) segs.push({ len: j(0.28, 0.04), ang: neckAng - i * 4, r: (0.17 - i * 0.012) * fat });
    segs.push({ len: j(0.26, 0.03), ang: j(arch === 'longneck' ? 5 : -5, 12), r: j(0.185, 0.02) * (arch === 'brute' ? 1.2 : 1) });
    spine = spineFrom(0.05 * fat, segs);
    const n = spine.length;
    const torso0 = tailN; // node index where the torso starts
    const legId = arch === 'brute' ? 'stumper' : arch === 'stalker' ? rnd.pick(['sprinter', 'talon', 'strider']) : rnd.pick(['strider', 'strider', 'stumper', 'sprinter']);
    const legS = arch === 'brute' ? 1.25 : arch === 'longneck' ? 1.3 : j(1.05, 0.12);
    add(legId, torso0 + 0.1, 2.35, legS);
    add(legId, torso0 + 1.9, 2.35, legS);
    diet = arch === 'stalker' ? 'carn' : arch === 'brute' ? rnd.pick(['herb', 'omni']) : 'herb';
    add(diet === 'carn' ? rnd.pick(['gnasher', 'shearjaw']) : diet === 'omni' ? rnd.pick(['snuffler', 'cragbeak']) : rnd.pick(['nibbler', 'nibbler', 'fluter']), n - 0.18, Math.PI, arch === 'brute' ? 1.2 : 1);
    add(arch === 'stalker' ? 'sliteye' : rnd.pick(['beadeye', 'mooneye', 'beadeye']), n - 0.66, j(0.8, 0.1), 1);
    if (arch === 'brute') {
      add(rnd.pick(['longhorn', 'nubhorn']), n - 0.9, 0.55, 1.3);
      if (rnd.chance(0.6)) for (let u = torso0; u <= torso0 + 2; u += 1) add('shellplate', u + 0.4, 0, 1.15);
      else for (let u = torso0; u <= torso0 + 2.2; u += 0.7) add('backspike', u, 0, 1.2);
    } else if (arch === 'stalker') {
      for (let u = torso0 - 0.5; u <= torso0 + 2.4; u += 0.6) add('backspike', u, 0, j(0.9, 0.2));
      if (rnd.chance(0.5)) add('nubhorn', n - 0.95, 0.5, 1);
    } else {
      const f = rnd.pick(['sailfin', 'crest', 'tuft', 'glowspot', 'none']);
      if (f === 'sailfin') add('sailfin', torso0 + 1, 0, j(1.2, 0.2));
      if (f === 'crest') add('crest', n - 1.1, 0, 1.1);
      if (f === 'tuft') { add('tuft', n - 0.9, 0, 1.2); add('tuft', -0.8, 0, 1.3); }
      if (f === 'glowspot') for (let u = torso0; u <= torso0 + 2; u += 0.66) add('glowspot', u, 1.1, 1);
      if (rnd.chance(0.4)) add('tailfan', -0.86, 0, 1.1);
      if (rnd.chance(0.35)) add('whisker', n - 0.4, Math.PI, 1);
    }
  } else if (arch === 'strutter' || arch === 'skulker') {
    // upright bipeds
    const lean = arch === 'skulker' ? 38 : rnd.range(58, 74);
    spine = spineFrom(0.05, [
      { len: 0.3, ang: j(-4, 8), r: 0.1 },
      { len: 0.3, ang: j(8, 6), r: 0.21 },
      { len: 0.3, ang: lean * 0.6, r: j(0.24, 0.02) },
      { len: 0.3, ang: lean, r: j(0.2, 0.02) },
      { len: 0.26, ang: lean + 8, r: 0.13 },
      { len: 0.25, ang: j(12, 10), r: j(0.185, 0.02) },
    ]);
    const n = spine.length;
    diet = arch === 'skulker' ? 'carn' : rnd.pick(['herb', 'omni']);
    add(arch === 'skulker' ? rnd.pick(['talon', 'sprinter']) : rnd.pick(['strider', 'sprinter', 'springer']), 2.1, 2.3, j(1.2, 0.1));
    add(arch === 'skulker' ? 'raker' : rnd.pick(['nubarm', 'beckoner']), 3.9, 1.7, 1);
    add(diet === 'carn' ? 'gnasher' : diet === 'omni' ? 'cragbeak' : rnd.pick(['nibbler', 'fluter']), n - 0.18, Math.PI, 1);
    add(arch === 'skulker' ? 'sliteye' : rnd.pick(['mooneye', 'stalkeye', 'beadeye']), n - 0.6, j(0.75, 0.1), 1);
    if (arch === 'strutter') {
      add('crest', n - 1.05, 0, j(1.2, 0.2));
      add('tailfan', -0.85, 0, j(1.25, 0.2));
    } else {
      for (let u = 0.4; u <= 3.4; u += 0.75) add('backspike', u, 0, 0.9);
      if (rnd.chance(0.5)) add('lantern', n - 0.9, 0, 1);
    }
  } else if (arch === 'serpent') {
    const segs = [];
    const cnt = rnd.int(8, 10);
    for (let i = 0; i < cnt; i++) {
      const s = i / (cnt - 1);
      segs.push({ len: 0.27, ang: i > cnt - 3 ? 26 : j(0, 5), r: 0.07 + Math.sin(Math.min(s * 1.25, 1) * Math.PI) * 0.1 + (i === cnt - 1 ? 0.06 : 0) });
    }
    spine = spineFrom(0.035, segs);
    const n = spine.length;
    diet = rnd.pick(['carn', 'omni']);
    add(diet === 'carn' ? 'gnasher' : 'snuffler', n - 0.18, Math.PI, 0.9);
    add('sliteye', n - 0.6, 0.8, 0.9);
    for (let u = 1; u < n - 2; u += 1.3) add(rnd.chance(0.5) ? 'glowspot' : 'backspike', u, rnd.chance(0.5) ? 0 : 0.9, 0.9);
    if (rnd.chance(0.5)) add('sailfin', n * 0.5, 0, 0.9);
  } else {
    // critter: small, many-legged, big-eyed
    spine = spineFrom(0.06, [
      { len: 0.24, ang: j(6, 8), r: 0.15 },
      { len: 0.26, ang: j(0, 6), r: j(0.2, 0.02) },
      { len: 0.24, ang: j(8, 8), r: 0.17 },
      { len: 0.22, ang: j(16, 10), r: j(0.18, 0.02) },
    ]);
    const n = spine.length;
    diet = rnd.pick(['herb', 'herb', 'omni']);
    const legId = rnd.pick(['skitter', 'skitter', 'strider', 'springer']);
    if (legId === 'skitter') {
      add('skitter', 0.9, 1.75, 0.62);
      add('skitter', 1.7, 1.75, 0.66);
      add('skitter', 2.5, 1.75, 0.62);
    } else {
      add(legId, 0.9, 2.3, 0.75);
      add(legId, 2.5, 2.3, 0.75);
    }
    add(diet === 'omni' ? 'snuffler' : 'nibbler', n - 0.18, Math.PI, 0.85);
    add(rnd.pick(['mooneye', 'stalkeye', 'mooneye']), n - 0.62, j(0.7, 0.1), 1.05);
    add('whisker', n - 0.35, Math.PI, 1);
    if (rnd.chance(0.5)) add('glowspot', 1.5, 0.9, 1.1);
    if (rnd.chance(0.5)) add('tuft', -0.8, 0, 1.2);
  }

  const fierce = diet === 'carn';
  const g = { name: '', spine, parts, skin: randomSkin(rnd, fierce ? 'fierce' : 'any') };
  g.name = speciesName(rnd, g);
  g.arch = arch;
  return g;
}

const ADJ = ['Dappled', 'Russet', 'Ember', 'Moss', 'Pale', 'Greater', 'Lesser', 'Marsh', 'Dusk', 'Ochre', 'Velvet', 'Brindle', 'Hollow', 'Fern', 'Tawny', 'Mottled', 'Copper', 'Sooty', 'Gilded', 'Quiet', 'Salt', 'Bramble'];
const NOUN = {
  horn: ['Thornbrow', 'Ramhead', 'Hornback'],
  armor: ['Shellback', 'Thornback', 'Plateback'],
  glow: ['Lanternback', 'Glimmer', 'Emberling'],
  social: ['Whistler', 'Piper', 'Dancer', 'Strutter'],
  carn: ['Prowler', 'Gnasher', 'Lurker', 'Stalker'],
  fast: ['Loper', 'Darter', 'Strider'],
  slow: ['Trundler', 'Browser', 'Mumbler', 'Wader'],
  none: ['Slider', 'Creeper', 'Wriggler'],
};

export function speciesName(rnd, g) {
  const st = computeStats(g);
  let pool = NOUN.slow;
  if (!st.legPairs) pool = NOUN.none;
  else if (st.diet === 'carn') pool = NOUN.carn;
  else if (st.ram >= 2) pool = NOUN.horn;
  else if (st.armor >= 2) pool = NOUN.armor;
  else if (st.glow >= 2) pool = NOUN.glow;
  else if (st.social >= 4) pool = NOUN.social;
  else if (st.speed >= 3) pool = NOUN.fast;
  return rnd.pick(ADJ) + ' ' + rnd.pick(pool);
}
