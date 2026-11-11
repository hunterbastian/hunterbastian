// The creature stage: walk the island as the thing you built, eat, make
// friends or enemies, earn helix, and carry it home to the next generation.

import * as THREE from './three.js';
import { World, SEA } from './world.js';
import { Creature } from './creature.js';
import { haloTexture } from './skin.js';
import { computeStats } from './genome.js';
import { PARTS, PART_LIST } from './parts.js';
import { creatureThumb } from './thumbs.js';
import { mergeGeo } from './geo.js';
import { Hud, emoteTexture } from './hud.js';
import { Critter, buildSpecies, locomote, pickVoice, SPECIES_COUNT, TEMPER } from './fauna.js';
import { esc, icon, toast, modal, SOCIAL, FIERCE, DIET } from './ui.js';
import { clamp, damp, angDiff, makeRng } from './util.js';

const DAY_LEN = 430; // seconds for a full day and night
const STAGES = [
  { at: 0, name: 'Hatchling' },
  { at: 40, name: 'Forager' },
  { at: 110, name: 'Wanderer' },
  { at: 200, name: 'Elder' },
  { at: 320, name: 'Firekeeper' },
];
const CD = { bite: 0.9, swipe: 0.55, ram: 3.4, social: 1.35 };

const _v = new THREE.Vector3();
const _v2 = new THREE.Vector3();
const _ray = new THREE.Raycaster();
const _ndc = new THREE.Vector2();

export class Game {
  constructor(app, o) {
    this.app = app;
    this.o = o;
    this.audio = app.audio;
    this.save = o.save;
    this.frame = 0;
    this.night = 0;
    this.paused = false;
    this.keys = new Set();
    this.pointers = new Map();
    this.critters = [];
    this.meat = [];
    this.emotes = [];
    this.later = [];
    this.hints = new Set();
    this.convo = null;
    this.packTarget = null;
    this.packT = 0;
    this.target = null;
    this.lockT = 0;
    this.cine = null;
    this.saveT = 30;
    this.clock = this.save.clock || 0.07;

    const scene = (this.scene = new THREE.Scene());
    scene.fog = new THREE.Fog('#cfe7f2', 40, 230);
    this.camera = new THREE.PerspectiveCamera(52, 1, 0.3, 2000);
    this.cam = { yaw: 0, pitch: 0.3, dist: 8, tdist: 8, focus: new THREE.Vector3(), auto: 0 };

    this.world = new World(this.save.seed, app.quality, SPECIES_COUNT);
    scene.add(this.world.group);
    this.groundFn = (x, z) => this.world.heightAt(x, z);
    for (const id of this.save.bones) {
      const b = this.world.bones[id];
      if (b) this._spendBones(b);
    }

    this._makePlayer();
    this.species = buildSpecies(this);
    this._populate();
    this._props();

    this.hud = new Hud(this);
    this.hud.setMe(this.save.genome.name, this.save.gen, creatureThumb(this.save.genome, 124));
    this.hud.actions(this.player.stance, this.player.stats);
    this._bind();

    this.cam.yaw = Math.atan2(this.player.pos.x, this.player.pos.z) + 0.85; // look inland, nest off to one side
    this.night = this.world.setTime(this.clock, scene);
    if (o.hatch) {
      this.player.c.play('hatch');
      this.audio.blip('good');
      this.later.push({ t: 1.2, fn: () => toast(this.save.gen === 1 ? `${esc(this.save.genome.name)} walks ashore.` : `Generation ${this.save.gen} hatches.`, 'big') });
    }
    this.later.push({ t: 3.4, fn: () => this.hint('move', app.touch ? 'Left stick to walk. Drag anywhere to look around.' : 'WASD to walk, drag to look. Shift runs, Space leaps.') });
    if (this.save.won) this._lightFire();
  }

  /* --------------------------------- setup ------------------------------- */

  _makePlayer() {
    const s = this.save;
    const w = this.world;
    const c = new Creature(s.genome, { seed: s.seed, ground: this.groundFn });
    const stats = c.stats;
    const stage = this.stageIndex();
    const P = (this.player = {
      c,
      pos: c.root.position,
      heading: 0,
      vel: new THREE.Vector3(),
      push: new THREE.Vector3(),
      vy: 0,
      onGround: true,
      swim: false,
      gliding: false,
      turn: 7.5,
      radius: c.radius,
      float: c.height * 0.55,
      stats,
      maxHp: stats.health + stage * 10,
      hp: 1,
      hunger: 78,
      dead: false,
      safe: 4,
      look: new THREE.Vector3(),
      walkSpeed: stats.moveSpeed,
      speedNow: 0,
      stance: 'friendly',
      cd: { social: 0, bite: 0, ram: 0, swipe: 0 },
      dash: 0,
      alive: true,
      pending: null,
      lastHit: 9,
    });
    P.hp = P.maxHp;
    P.onLand = () => this.audio.step(1, clamp(stats.mass, 0, 1));
    P.onSplash = () => this.audio.splash();
    c.onStep = () => {
      if (!P.swim) this.audio.step(0.5, clamp(stats.mass, 0, 1));
    };
    const a = Math.atan2(-w.home.x, -w.home.z);
    P.pos.set(w.home.x + Math.sin(a) * 3.6, 0, w.home.z + Math.cos(a) * 3.6);
    P.pos.y = w.heightAt(P.pos.x, P.pos.z);
    P.heading = a;
    c.heading = a;
    c.resetFeet();
    this.scene.add(c.root);
    w.addNest(w.home.x, w.home.z, s.genome.skin.base, true);
    this.home = { x: w.home.x, z: w.home.z, y: w.heightAt(w.home.x, w.home.z) };
    // no eyes, no far sight
    this.scene.fog.near = stats.sight ? 40 : 8;
    this.scene.fog.far = stats.sight ? 210 + stats.sight * 14 : 48;
  }

  _populate() {
    const s = this.save;
    // your own kind keep the home nest
    const stats = computeStats(s.genome);
    this.kin = {
      id: -1,
      role: { count: 2 },
      genome: s.genome,
      stats,
      name: s.genome.name || 'your kind',
      kit: this.player.c.kit,
      temper: 'kin',
      diet: stats.diet,
      scale: 1,
      nest: this.home,
      members: [],
      rel: 100,
      friends: 0,
      kills: 0,
      status: 'kin',
      met: true,
      need: 99,
      respawn: 40,
      voices: SOCIAL.map((v) => ({ id: v.id, w: stats[v.id] + 0.6 })),
    };
    for (const sp of [this.kin, ...this.species]) {
      const n = sp.status === 'cowed' ? Math.max(1, sp.role.count - 2) : sp.role.count;
      for (let i = 0; i < n; i++) {
        const cr = this._spawn(sp, false);
        if (sp.status === 'wild' && i < sp.friends) cr.friend = true;
      }
    }
  }

  _spawn(sp, baby) {
    const w = this.world;
    let x = sp.nest.x;
    let z = sp.nest.z;
    for (let i = 0; i < 8; i++) {
      const a = Math.random() * 6.283;
      const r = baby ? 1.2 : 3 + Math.random() * 9;
      x = sp.nest.x + Math.cos(a) * r;
      z = sp.nest.z + Math.sin(a) * r;
      if (w.heightAt(x, z) > 0.4) break;
    }
    const cr = new Critter(this, sp, x, z, { baby, hatch: baby });
    sp.members.push(cr);
    this.critters.push(cr);
    return cr;
  }

  _props() {
    // target ring
    this.ring = new THREE.Mesh(new THREE.RingGeometry(0.86, 1, 36).rotateX(-Math.PI / 2), new THREE.MeshBasicMaterial({ color: '#5e7f4a', transparent: true, opacity: 0.85, depthWrite: false }));
    this.ring.visible = false;
    this.ring.renderOrder = 2;
    this.scene.add(this.ring);
    this.meatGeo = mergeGeo([
      { geo: new THREE.SphereGeometry(0.3, 8, 6), color: '#c9584a', s: [1.2, 0.7, 0.9], p: [0, 0.18, 0] },
      { geo: new THREE.SphereGeometry(0.16, 6, 5), color: '#e58f7c', p: [0.2, 0.3, 0.05] },
      { geo: new THREE.CylinderGeometry(0.04, 0.04, 0.5, 5), color: '#efe6d0', r: [0, 0, 1.1], p: [-0.25, 0.26, 0] },
      { geo: new THREE.SphereGeometry(0.07, 6, 5), color: '#efe6d0', p: [-0.47, 0.37, 0] },
    ]);
    this.meatMat = new THREE.MeshLambertMaterial({ vertexColors: true });
  }

  /* --------------------------------- input ------------------------------- */

  _bind() {
    const cv = this.app.canvas;
    this._off = [];
    const on = (t, ev, fn, opt) => {
      t.addEventListener(ev, fn, opt);
      this._off.push(() => t.removeEventListener(ev, fn, opt));
    };
    on(window, 'keydown', (e) => {
      if (/INPUT|TEXTAREA/.test(e.target.tagName) || e.metaKey || e.ctrlKey) return;
      const k = e.code;
      if (['Tab', 'Space', 'ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight'].includes(k)) e.preventDefault();
      if (e.repeat) return;
      this.keys.add(k);
      if (k === 'Escape' || k === 'KeyP') this.paused ? this.closeMenu() : this.openMenu();
      if (this.paused || this.cine) return;
      if (k === 'Tab' || k === 'KeyQ') this.toggleStance();
      else if (k === 'KeyE' || k === 'Enter') this.interact();
      else if (k === 'KeyF') this.interact('fire');
      else if (k === 'Space') this.jump();
      else if (/^Digit[1-4]$/.test(k)) {
        const list = this.player.stance === 'friendly' ? SOCIAL : FIERCE;
        const a = list[+k.slice(5) - 1];
        if (a) this.doAction(a.id);
      }
    });
    on(window, 'keyup', (e) => this.keys.delete(e.code));
    // phones close tabs without warning: save whenever the page is hidden
    on(document, 'visibilitychange', () => {
      if (document.hidden) this.snapshot();
    });
    on(window, 'blur', () => this.keys.clear());
    on(cv, 'pointerdown', (e) => {
      cv.setPointerCapture(e.pointerId);
      this.pointers.set(e.pointerId, { x: e.clientX, y: e.clientY, sx: e.clientX, sy: e.clientY, t: performance.now() });
      if (this.pointers.size === 2) {
        const [a, b] = [...this.pointers.values()];
        this.pinch = Math.hypot(a.x - b.x, a.y - b.y);
      }
    });
    on(cv, 'pointermove', (e) => {
      const p = this.pointers.get(e.pointerId);
      if (!p) return;
      const dx = e.clientX - p.x;
      const dy = e.clientY - p.y;
      p.x = e.clientX;
      p.y = e.clientY;
      if (this.pointers.size === 2) {
        const [a, b] = [...this.pointers.values()];
        const d = Math.hypot(a.x - b.x, a.y - b.y);
        if (this.pinch) this.cam.tdist = clamp(this.cam.tdist * (this.pinch / d), 3.5, 22);
        this.pinch = d;
        return;
      }
      this.cam.yaw -= dx * 0.0062;
      this.cam.pitch = clamp(this.cam.pitch + dy * 0.0046, -0.12, 1.25);
      this.cam.auto = 2.5;
    });
    const up = (e) => {
      const p = this.pointers.get(e.pointerId);
      this.pointers.delete(e.pointerId);
      this.pinch = 0;
      if (p && Math.hypot(e.clientX - p.sx, e.clientY - p.sy) < 7 && performance.now() - p.t < 400) this._tap(e);
    };
    on(cv, 'pointerup', up);
    on(cv, 'pointercancel', up);
    on(cv, 'wheel', (e) => {
      e.preventDefault();
      this.cam.tdist = clamp(this.cam.tdist * (1 + Math.sign(e.deltaY) * 0.1), 3.5, 22);
    }, { passive: false });
  }

  // Tap a creature to lock onto it.
  _tap(e) {
    if (this.paused || this.cine) return;
    const r = this.app.canvas.getBoundingClientRect();
    _ndc.set(((e.clientX - r.left) / r.width) * 2 - 1, -((e.clientY - r.top) / r.height) * 2 + 1);
    _ray.setFromCamera(_ndc, this.camera);
    let best = null;
    let bestD = 0.9;
    for (const cr of this.critters) {
      if (!cr.alive) continue;
      _v.copy(cr.pos);
      _v.y += cr.c.height * cr.sp.scale * 0.5;
      const d = _ray.ray.distanceToPoint(_v) / (1 + cr.radius);
      if (d < bestD && _v.distanceTo(this.player.pos) < 40) {
        best = cr;
        bestD = d;
      }
    }
    if (best) {
      this.target = best;
      this.lockT = 8;
      this.audio.blip('tick');
    }
  }

  /* -------------------------------- helpers ------------------------------ */

  distToPlayer(cr) {
    return Math.hypot(cr.pos.x - this.player.pos.x, cr.pos.z - this.player.pos.z);
  }

  hint(key, text) {
    if (this.hints.has(key)) return;
    this.hints.add(key);
    toast(text, '', 5200);
  }

  floater(text, at, cls) {
    const pos = at.pos || at;
    _v.copy(pos);
    _v.y += at.c ? at.c.height * (at.sp ? at.sp.scale : 1) + 0.4 : 1.4;
    _v.project(this.camera);
    if (_v.z > 1) return;
    this.hud.floater(text, (_v.x * 0.5 + 0.5) * this.w, (-_v.y * 0.5 + 0.5) * this.h, cls);
  }

  emote(cr, kind, dur = 1.6) {
    let e = this.emotes.find((x) => x.cr === cr);
    if (!e) {
      const sp = new THREE.Sprite(new THREE.SpriteMaterial({ map: emoteTexture(kind), depthTest: false, transparent: true }));
      sp.renderOrder = 20;
      this.scene.add(sp);
      e = { cr, sp, t: 0, dur };
      this.emotes.push(e);
    }
    e.sp.material.map = emoteTexture(kind);
    e.t = 0;
    e.dur = dur;
    e.kind = kind;
  }

  stageIndex() {
    let i = 0;
    for (let k = 0; k < STAGES.length; k++) if (this.save.earned >= STAGES[k].at) i = k;
    return i;
  }

  stageInfo() {
    const i = this.stageIndex();
    const next = STAGES[i + 1];
    if (!next) return { name: STAGES[i].name, frac: 1, i };
    return { name: STAGES[i].name, frac: (this.save.earned - STAGES[i].at) / (next.at - STAGES[i].at), i, toGo: next.at - this.save.earned, next: next.name };
  }

  gain(n, at) {
    const s = this.save;
    const before = this.stageIndex();
    s.bank += n;
    s.earned += n;
    this.audio.blip('helix');
    this.floater(`+${n} helix`, at || this.player, 'helix');
    const after = this.stageIndex();
    if (after > before) {
      const P = this.player;
      P.maxHp += 10;
      P.hp = P.maxHp;
      this.audio.blip('evolve');
      toast(`Your line grows wiser: ${STAGES[after].name}.`, 'big', 4600);
      if (after === STAGES.length - 1) this.later.push({ t: 4, fn: () => toast('Something new is possible at your nest.', '', 6000) });
    }
  }

  cooldown(id) {
    const P = this.player;
    if (P.stance === 'friendly') return clamp(P.cd.social / CD.social, 0, 1);
    return clamp(P.cd[id] / CD[id], 0, 1);
  }

  nearestBush(pos, maxD) {
    let best = null;
    let bd = maxD;
    for (const b of this.world.bushes) {
      if (b.berries <= 0) continue;
      const d = Math.hypot(b.x - pos.x, b.z - pos.z);
      if (d < bd) {
        bd = d;
        best = b;
      }
    }
    return best;
  }

  findPrey(hunter) {
    let best = null;
    let bd = 46;
    for (const cr of this.critters) {
      if (!cr.alive || cr.sp === hunter.sp || cr.sp.temper === 'predator' || cr.pack) continue;
      const d = cr.pos.distanceTo(hunter.pos);
      if (d < bd) {
        bd = d;
        best = cr;
      }
    }
    return best;
  }

  /* ------------------------------ player verbs --------------------------- */

  toggleStance() {
    const P = this.player;
    if (P.dead) return;
    P.stance = P.stance === 'friendly' ? 'fierce' : 'friendly';
    this.hud.actions(P.stance, P.stats);
    this.audio.blip('tick');
    this.ring.material.color.set(P.stance === 'friendly' ? '#5e7f4a' : '#c2603f');
    if (P.stance === 'fierce' && this.convo) this._endConvo(false);
    this.hint('stance-' + P.stance, P.stance === 'fierce' ? 'Fierce: 1 bites, 2 rams, 3 swipes. Horns and claws make them real.' : 'Friendly: 1 to 4 are your voices. Answer a creature in the voice it uses.');
  }

  jump() {
    const P = this.player;
    if (P.dead || this.cine || this.paused) return;
    if (P.onGround && !P.swim) {
      P.vy = 6.4 + P.stats.jump * 1.5;
      P.onGround = false;
      this.audio.tone(260, { dur: 0.12, to: 420, vol: 0.05 });
    }
  }

  doAction(id) {
    const P = this.player;
    if (P.dead || this.cine || this.paused) return;
    if (P.stance === 'friendly') this._social(id);
    else this._attack(id);
  }

  _social(id) {
    const P = this.player;
    if (P.cd.social > 0 || P.c.busy) return;
    P.cd.social = CD.social;
    P.c.play(id);
    this.audio.voiceFor(P.stats, id);
    const lvl = P.stats[id];
    // the pack joins in
    let chorus = 0;
    for (const cr of this.critters) {
      if (!cr.alive || this.distToPlayer(cr) > 12) continue;
      if (cr.pack || ((cr.sp.status === 'kin' || cr.sp.status === 'ally' || cr.friend) && cr.state === 'idle')) {
        if (cr.pack) chorus++;
        this.later.push({ t: 0.35 + Math.random() * 0.4, fn: () => cr.alive && !cr.c.busy && cr.c.play(id) });
      }
    }
    const cv = this.convo;
    if (cv && cv.phase === 'wait') {
      if (id === cv.expect) this._answer(true, lvl, chorus);
      else this._answer(false, lvl, chorus);
      return;
    }
    if (cv) return;
    const tg = this.target;
    if (!tg || !tg.alive || this.distToPlayer(tg) > 9) return;
    const sp = tg.sp;
    if (tg.friend || sp.status === 'ally' || sp.status === 'kin') {
      this.later.push({ t: 0.5, fn: () => tg.alive && tg.c.play('happy') });
      return;
    }
    if (!tg.canTalk()) {
      if (tg.state === 'sleep') this.hint('asleep', 'It is asleep. Come back by daylight.');
      return;
    }
    if (sp.temper === 'predator' && P.stats.social < 5 && sp.rel < 20) {
      tg.c.play('no');
      this.emote(tg, 'growl', 1.6);
      this.audio.voiceFor(sp.stats, 'growl', 0.9);
      this.hint('proud', `The ${sp.name} is not impressed. A hunter needs a bigger show: evolve stronger voices.`);
      return;
    }
    tg.set('converse', 0);
    this.convo = { cr: tg, phase: 'greet', t: 1.3, expect: null, misses: 0 };
    this.hint('convo', 'It will call to you. Answer with the same voice.');
  }

  _answer(ok, lvl, chorus) {
    const cv = this.convo;
    const cr = cv.cr;
    if (ok) {
      const easy = cr.sp.temper === 'gentle' || cr.sp.temper === 'skittish' ? 1.25 : 1;
      const gain = (lvl > 0 ? 20 + lvl * 10 : 15) * easy + chorus * 5;
      cr.bond += gain;
      this.audio.blip('good');
      this.floater(lvl > 0 ? 'in tune' : 'close enough', cr, 'good');
      cv.misses = 0;
      if (lvl === 0) this.hint('clumsy', 'You fumbled through that one. Parts that add that voice make it land harder.');
    } else {
      cr.bond = Math.max(0, cr.bond - 6);
      cv.misses++;
      this.later.push({ t: 0.6, fn: () => cr.alive && cr.c.play('no') });
      this.emote(cr, 'ask', 1.4);
      this.audio.blip('bad');
    }
    cv.phase = 'react';
    cv.t = 1.5;
    cv.expect = null;
  }

  _endConvo(won) {
    const cv = this.convo;
    if (!cv) return;
    this.convo = null;
    const cr = cv.cr;
    if (cr.alive && cr.state === 'converse') cr.set('idle', won ? 3 : 1.5);
    if (!won) return;
    const sp = cr.sp;
    cr.friend = true;
    cr.bond = 100;
    sp.friends++;
    sp.rel = Math.min(100, Math.max(sp.rel, 0) + Math.ceil(100 / sp.need));
    this.save.tally.friends++;
    cr.c.play('happy');
    this.emote(cr, 'heart', 2.4);
    this.audio.voiceFor(sp.stats, 'happy');
    this.gain(8, cr);
    if (sp.friends >= sp.need) this._ally(sp);
    else toast(`A ${esc(sp.name)} trusts you. ${sp.need - sp.friends} more and the whole nest will.`);
  }

  _ally(sp) {
    sp.status = 'ally';
    sp.rel = 100;
    this.audio.blip('ally');
    toast(`The ${esc(sp.name)} are your friends now.`, 'big', 4600);
    for (const m of sp.members) {
      if (!m.alive) continue;
      m.friend = true;
      this.later.push({ t: Math.random() * 0.8, fn: () => m.alive && (m.c.play('happy'), this.emote(m, 'heart', 2.2)) });
    }
    this.gain(30);
    this._discover(sp);
    this.hint('pack', 'Allies will walk with you. Stand near one and invite it to your pack.');
  }

  _cow(sp) {
    sp.status = 'cowed';
    sp.rel = -100;
    toast(`The ${esc(sp.name)} fear you now. They will keep their distance.`, 'big', 4600);
    this.audio.blip('unlock');
    for (const m of sp.members) {
      if (m.alive) {
        m.target = this.player;
        m.set('flee', 6);
      }
    }
    this.gain(25);
    this._discover(sp);
  }

  // Learn a new part: one this species carries if possible.
  _discover(sp) {
    const s = this.save;
    if (s.sandbox) return;
    const have = new Set(s.unlocked);
    let pool = sp ? [...new Set(sp.genome.parts.map((p) => p.id))].filter((id) => !have.has(id)) : [];
    if (!pool.length) {
      const locked = PART_LIST.filter((d) => !have.has(d.id));
      if (!locked.length) {
        this.gain(15);
        return;
      }
      const tier = Math.min(...locked.map((d) => d.tier));
      pool = locked.filter((d) => d.tier === tier).map((d) => d.id);
    }
    const rnd = makeRng(s.seed + s.unlocked.length * 131);
    const id = pool[Math.floor(rnd() * pool.length)];
    s.unlocked.push(id);
    this.later.push({ t: 1.6, fn: () => {
      this.audio.blip('unlock');
      toast(`New part discovered: <b>${esc(PARTS[id].name)}</b>. Take it home.`, 'big', 4800);
    } });
  }

  _attack(id) {
    const P = this.player;
    const lvl = P.stats[id];
    if (P.cd[id] > 0 || P.c.busy) return;
    if (lvl === 0) {
      this.hint('no-' + id, id === 'ram' ? 'You have no horns to ram with.' : id === 'swipe' ? 'You have no claws to swipe with.' : 'You have no mouth to bite with.');
      this.audio.blip('bad');
      return;
    }
    P.cd[id] = CD[id];
    P.c.play(id);
    this.audio.voiceFor(P.stats, id);
    const tg = this.target && this.target.alive ? this.target : null;
    if (tg && this.distToPlayer(tg) < 7) P.heading = Math.atan2(tg.pos.x - P.pos.x, tg.pos.z - P.pos.z);
    if (id === 'ram') {
      P.dash = 0.34;
      P.dashHit = false;
      return;
    }
    P.pending = { t: 0.17, id, lvl };
    if (this.convo) this._endConvo(false);
  }

  _strike(cr, dmg, knock) {
    const P = this.player;
    if (cr.sp.status === 'kin' || cr.pack) return;
    cr.hurt(dmg, 'player');
    this.audio.hit(0.8);
    _v.subVectors(cr.pos, P.pos).setY(0).normalize();
    cr.push.addScaledVector(_v, knock);
    this.packTarget = cr.alive ? cr : null;
    this.packT = 6;
    if (this.convo) this._endConvo(false);
  }

  hurtPlayer(dmg, from) {
    const P = this.player;
    if (P.dead || this.cine) return;
    dmg *= 1 - 0.08 * P.stats.armor;
    P.hp -= dmg;
    P.lastHit = 0;
    P.c.play('hurt');
    this.audio.hit(1);
    this.audio.voiceFor(P.stats, 'hurt');
    this.floater(Math.round(dmg), P, 'hurt');
    this.hud.flash(0.9);
    if (from && from.alive) {
      _v.subVectors(P.pos, from.pos).setY(0).normalize();
      P.push.addScaledVector(_v, 4);
      if (!this.packTarget) {
        this.packTarget = from;
        this.packT = 6;
      }
      this.hint('hurt', 'Something has its teeth in you. Run, or switch to fierce (Tab) and fight back.');
    }
    if (this.convo) this._endConvo(false);
    if (P.hp <= 0) this._die();
  }

  _die() {
    const P = this.player;
    P.dead = true;
    P.hp = 0;
    P.c.action = null;
    P.c.play('die');
    this.audio.blip('fail');
    this.later.push({ t: 2.3, fn: () => this.app.fadeEl.classList.add('on') });
    this.later.push({ t: 2.8, fn: () => this._respawn() });
  }

  _respawn() {
    const P = this.player;
    const w = this.world;
    const a = Math.random() * 6.283;
    P.pos.set(this.home.x + Math.sin(a) * 3.4, 0, this.home.z + Math.cos(a) * 3.4);
    P.pos.y = w.heightAt(P.pos.x, P.pos.z);
    P.vel.set(0, 0, 0);
    P.push.set(0, 0, 0);
    P.hp = P.maxHp;
    P.hunger = 70;
    P.dead = false;
    P.safe = 8;
    P.c.dead = false;
    P.c.action = null;
    P.c.sleepAmt = 0;
    P.c.resetFeet();
    P.c.play('hatch');
    for (const cr of this.critters) if (cr.target === P) cr.t = 0;
    this.app.fadeEl.classList.remove('on');
    toast('Another of your brood takes up the path.', 'big', 4200);
  }

  onCritterDied(cr, byPlayer) {
    const sp = cr.sp;
    if (this.target === cr) this.target = null;
    if (this.packTarget === cr) this.packTarget = null;
    if (this.convo && this.convo.cr === cr) this._endConvo(false);
    const x = cr.pos.x;
    const z = cr.pos.z;
    this.later.push({ t: 1.0, fn: () => this._dropMeat(x, z) });
    if (!byPlayer) return;
    this.save.tally.kills++;
    this.gain(6, cr);
    if (sp.status === 'kin') return;
    sp.kills++;
    if (sp.status === 'wild' && sp.kills >= Math.min(4, sp.role.count + 1)) this._cow(sp);
    else if (sp.status === 'ally') {
      sp.status = 'wild';
      sp.friends = 0;
      sp.rel = -40;
      for (const m of sp.members) m.friend = m.pack = false;
      toast(`You have betrayed the ${esc(sp.name)}.`, 'warn');
    }
  }

  onMet(sp, cr) {
    sp.met = true;
    this.gain(5, cr);
    toast(`You have found the <b>${esc(sp.name)}</b>: ${TEMPER[sp.temper]}, ${DIET[sp.diet].name.toLowerCase()}.`, '', 4400);
    this.hint('target', this.app.touch ? 'Tap a creature to focus on it.' : 'Click a creature to focus on it. 1 to 4 to speak, Tab for teeth.');
  }

  onHunted(cr) {
    this.hint('hunted', `A ${cr.sp.name} has your scent. It cannot outrun you for long.`);
  }

  _dropMeat(x, z) {
    const y = this.world.heightAt(x, z);
    if (y < SEA - 0.1) return;
    const mesh = new THREE.Mesh(this.meatGeo, this.meatMat);
    mesh.position.set(x, y, z);
    mesh.rotation.y = Math.random() * 6;
    mesh.castShadow = true;
    this.scene.add(mesh);
    this.meat.push({ x, z, y, mesh, t: 80 });
    // a hunter nearby will come and eat
    for (const cr of this.critters) {
      if (cr.alive && cr.sp.temper === 'predator' && cr.state === 'hunt' && Math.hypot(cr.pos.x - x, cr.pos.z - z) < 5) cr.set('feast', 6);
    }
  }

  _spendBones(b) {
    b.found = true;
    if (b.glint) b.glint.visible = false;
    if (b.mesh) b.mesh.scale.setScalar(0.8);
  }

  /* ------------------------------ interactions --------------------------- */

  // What can be done right here? First entry is bound to E / the use button.
  _prompts() {
    const P = this.player;
    const out = [];
    if (P.dead || this.cine) return out;
    const k = this.app.touch ? 'tap' : 'E';
    const dHome = Math.hypot(P.pos.x - this.home.x, P.pos.z - this.home.z);
    if (dHome < 5) {
      out.push({ id: 'evolve', key: k, label: this.save.sandbox ? 'Reshape yourself' : `Evolve <small>(${this.save.bank} helix)</small>`, short: 'evolve' });
      if (this.stageIndex() === STAGES.length - 1 && !this.save.won) out.push({ id: 'fire', key: this.app.touch ? 'tap' : 'F', label: 'Light the first fire', short: 'fire' });
    }
    for (const b of this.world.bones) {
      if (!b.found && Math.hypot(P.pos.x - b.x, P.pos.z - b.z) < 3) out.push({ id: 'bones', key: k, label: 'Dig up the old bones', short: 'dig', ref: b });
    }
    const diet = P.stats.diet;
    for (const m of this.meat) {
      if (Math.hypot(P.pos.x - m.x, P.pos.z - m.z) < 2.4 + P.radius) {
        out.push(diet === 'herb' ? { id: 'cant', key: '–', label: 'Meat. You cannot stomach it.' } : { id: 'meat', key: k, label: 'Eat', short: 'eat', ref: m });
        break;
      }
    }
    const b = this.nearestBush(P.pos, 2.5 + P.radius);
    if (b) out.push(diet === 'carn' ? { id: 'cant', key: '–', label: 'Berries. Your teeth are for meat.' } : { id: 'berry', key: k, label: 'Eat berries', short: 'eat', ref: b });
    const tg = this.target;
    if (tg && tg.alive && !tg.baby && (tg.sp.status === 'ally' || tg.sp.status === 'kin') && this.distToPlayer(tg) < 6) {
      const size = this.critters.filter((c) => c.pack).length;
      if (tg.pack) out.push({ id: 'dismiss', key: k, label: 'Send it home', short: 'bye', ref: tg });
      else if (size < 3) out.push({ id: 'invite', key: k, label: 'Invite to your pack', short: 'pack', ref: tg });
    }
    // only the first real prompt answers to E; the rest are there to click
    let first = true;
    for (const p of out) {
      if (p.id === 'cant' || p.id === 'fire') continue;
      if (!first) p.key = this.app.touch ? 'tap' : 'click';
      first = false;
    }
    return out;
  }

  interact(which) {
    if (this.paused || this.cine) return;
    const P = this.player;
    const list = this._prompts().filter((p) => p.id !== 'cant');
    const it = which ? list.find((p) => p.id === which) : list.find((p) => p.id !== 'fire');
    if (!it) return;
    switch (it.id) {
      case 'evolve':
        this.snapshot();
        this.o.onEvolve();
        break;
      case 'fire':
        this._finale();
        break;
      case 'bones':
        this._spendBones(it.ref);
        this.save.bones.push(it.ref.id);
        P.c.play('eat');
        this.audio.blip('good');
        this.gain(12);
        this._discover(null);
        break;
      case 'meat':
      case 'berry': {
        if (P.c.busy) return;
        if (it.id === 'meat') {
          this.scene.remove(it.ref.mesh);
          this.meat.splice(this.meat.indexOf(it.ref), 1);
          P.hunger = Math.min(100, P.hunger + 46);
        } else {
          if (!this.world.eatBerry(it.ref)) return;
          P.hunger = Math.min(100, P.hunger + 26);
        }
        P.hp = Math.min(P.maxHp, P.hp + 8);
        P.c.play('eat');
        this.audio.eat();
        this.save.tally.meals++;
        if (this.save.tally.meals <= 12) this.gain(2);
        break;
      }
      case 'invite': {
        const cr = it.ref;
        cr.pack = true;
        cr.slot = this.critters.filter((c) => c.pack).length - 1;
        cr.set('follow', 0);
        cr.c.play('happy');
        this.emote(cr, 'heart', 1.6);
        this.audio.voiceFor(cr.sp.stats, 'happy');
        toast(`A ${esc(cr.sp.name)} joins your pack.`);
        break;
      }
      case 'dismiss':
        it.ref.pack = false;
        it.ref._wanderGoal(8);
        it.ref.set('return', 40);
        break;
      default:
        break;
    }
  }

  /* ---------------------------------- menu ------------------------------- */

  openMenu() {
    if (this.paused || this.cine) return;
    this.paused = true;
    this.keys.clear();
    const s = this.save;
    const touch = this.app.touch;
    const guide = this.species
      .filter((sp) => sp.met)
      .map((sp) => `<figure><img src="${creatureThumb(sp.genome, 150)}" alt="" /><figcaption><b>${esc(sp.name)}</b><small>${sp.status === 'ally' ? 'allies' : sp.status === 'cowed' ? 'afraid of you' : TEMPER[sp.temper]}</small></figcaption></figure>`)
      .join('');
    const keys = touch
      ? '<span class="kbd">stick</span><span>walk; push to the edge to run</span><span class="kbd">drag</span><span>look around, pinch to zoom</span><span class="kbd">tap</span><span>focus on a creature</span>'
      : '<span class="kbd">WASD</span><span>walk</span><span class="kbd">Shift</span><span>run</span><span class="kbd">Space</span><span>leap (hold to glide, with wings)</span><span class="kbd">Tab</span><span>friendly / fierce</span><span class="kbd">1-4</span><span>voices, or attacks</span><span class="kbd">E</span><span>eat, dig, evolve, invite</span><span class="kbd">drag</span><span>look; scroll to zoom; click a creature to focus</span>';
    this.menu = modal(
      `<p class="eyebrow">Generation ${s.gen} · ${this.stageInfo().name}</p>
       <h2>${esc(s.genome.name)}</h2>
       <p>${s.tally.friends} befriended, ${s.tally.kills} bested, ${s.unlocked.length} of ${PART_LIST.length} parts known.</p>
       ${guide ? `<p class="eyebrow">Neighbours met</p><div class="lineage">${guide}</div>` : ''}
       <div class="keys">${keys}</div>
       <div class="menu">
         <button class="btn btn--primary" data-close>Keep going</button>
         <button class="btn" data-m="lineage">Lineage</button>
         <button class="btn" data-m="sound">${icon(this.audio.muted ? 'mute' : 'sound', 16)} Sound ${this.audio.muted ? 'off' : 'on'}</button>
         <button class="btn btn--ghost" data-m="quit">Save and leave</button>
       </div>`,
      { wide: !!guide, onClose: () => (this.paused = false) },
    );
    this.menu.root.addEventListener('click', (e) => {
      const b = e.target.closest('[data-m]');
      if (!b) return;
      if (b.dataset.m === 'lineage') this.app.showLineage(s);
      else if (b.dataset.m === 'sound') {
        this.audio.setMuted(!this.audio.muted);
        b.innerHTML = `${icon(this.audio.muted ? 'mute' : 'sound', 16)} Sound ${this.audio.muted ? 'off' : 'on'}`;
      } else if (b.dataset.m === 'quit') {
        this.snapshot();
        this.menu.root.remove();
        this.o.onQuit();
      }
    });
  }

  closeMenu() {
    if (this.menu) this.menu.close();
    this.menu = null;
  }

  // Write live state back into the save.
  snapshot() {
    const s = this.save;
    s.clock = this.clock % 1;
    for (const sp of this.species) s.species[sp.id] = { rel: Math.round(sp.rel), friends: sp.friends, kills: sp.kills, status: sp.status, met: sp.met };
    this.app.persist();
  }

  /* --------------------------------- finale ------------------------------ */

  _lightFire() {
    if (this.fire) return;
    const g = new THREE.Group();
    const logs = new THREE.Mesh(
      mergeGeo([
        { geo: new THREE.CylinderGeometry(0.09, 0.1, 1.1, 6), color: '#5c4633', r: [0, 0, 1.25], p: [0, 0.14, 0] },
        { geo: new THREE.CylinderGeometry(0.09, 0.1, 1.1, 6), color: '#6a5039', r: [1.25, 0, 0], p: [0, 0.14, 0] },
        { geo: new THREE.CylinderGeometry(0.08, 0.09, 1.0, 6), color: '#4f3c2c', r: [0.9, 0.8, 0.9], p: [0, 0.2, 0] },
      ]),
      new THREE.MeshLambertMaterial({ vertexColors: true }),
    );
    const flame = new THREE.Mesh(new THREE.ConeGeometry(0.34, 1.0, 7).translate(0, 0.62, 0), new THREE.MeshBasicMaterial({ color: '#ffb347', transparent: true, opacity: 0.92 }));
    const core = new THREE.Mesh(new THREE.ConeGeometry(0.18, 0.62, 6).translate(0, 0.48, 0), new THREE.MeshBasicMaterial({ color: '#fff2b0' }));
    const halo = new THREE.Sprite(new THREE.SpriteMaterial({ map: haloTexture(), color: '#ffb060', transparent: true, opacity: 0.7, depthWrite: false, blending: THREE.AdditiveBlending }));
    halo.scale.setScalar(5);
    halo.position.y = 0.7;
    const light = new THREE.PointLight('#ff9a3c', 30, 26, 1.6);
    light.position.y = 1.2;
    g.add(logs, flame, core, halo, light);
    const a = Math.atan2(-this.home.x, -this.home.z) + 0.9;
    g.position.set(this.home.x + Math.sin(a) * 4.2, 0, this.home.z + Math.cos(a) * 4.2);
    g.position.y = this.world.heightAt(g.position.x, g.position.z);
    this.scene.add(g);
    this.fire = { g, flame, core, light, halo };
  }

  _finale() {
    const s = this.save;
    this.cine = { t: 0, done: false };
    this.hud.root.style.opacity = 0;
    this.clock = 0.705; // dusk, sliding into night
    this._lightFire();
    this.audio.blip('evolve');
    const f = this.fire.g.position;
    // everyone who loves you gathers
    let i = 0;
    for (const cr of this.critters) {
      if (!cr.alive || !(cr.pack || cr.sp.status === 'kin')) continue;
      const a = (i++ / 5) * 6.283 + 1;
      cr.pack = false;
      cr.goal.set(f.x + Math.sin(a) * 3.2, 0, f.z + Math.cos(a) * 3.2);
      cr.set('return', 20);
    }
    s.won = true;
    this.snapshot();
  }

  _cine(dt) {
    const c = this.cine;
    c.t += dt;
    const f = this.fire.g.position;
    const P = this.player;
    // walk the player to the fire, then sit
    const dx = f.x - P.pos.x;
    const dz = f.z - P.pos.z;
    const d = Math.hypot(dx, dz);
    locomote(P, dx, dz, d > 3 ? P.walkSpeed * 0.6 : 0, dt, this);
    if (d <= 3) P.heading += clamp(angDiff(P.heading, Math.atan2(dx, dz)), -3 * dt, 3 * dt);
    P.c.look = _v.set(f.x, f.y + 0.6, f.z);
    P.c.update(dt);
    const a = c.t * 0.16 + 1;
    this.camera.position.set(f.x + Math.sin(a) * 11, f.y + 3.2 + Math.sin(c.t * 0.2) * 0.5, f.z + Math.cos(a) * 11);
    this.camera.lookAt(f.x, f.y + 1, f.z);
    if (c.t > 2 && !c.sang) {
      c.sang = true;
      P.c.play('trill');
      this.audio.voiceFor(P.stats, 'trill');
    }
    if (c.t > 8.5 && !c.done) {
      c.done = true;
      const s = this.save;
      const m = modal(
        `<p class="eyebrow">Generation ${s.gen}</p>
         <h2>Fire.</h2>
         <p>It began as a speck in a tidepool. ${s.gen === 1 ? 'One generation' : s.gen + ' generations'} later, ${esc(s.genome.name)} keeps the dark away, with ${s.tally.friends} friends made and ${s.tally.kills} rivals bested along the way.</p>
         <p>The island is still yours to wander, and the nest is still there when you want to change.</p>
         <div class="menu"><button class="btn btn--primary" data-m="lineage">See your lineage</button><button class="btn" data-close>Keep wandering</button></div>`,
        { dismiss: false, onClose: () => {
          this.cine = null;
          this.hud.root.style.opacity = 1;
        } },
      );
      m.root.querySelector('[data-m]').addEventListener('click', () => this.app.showLineage(s, 'From the tidepool to the fire'));
    }
  }

  /* --------------------------------- frame ------------------------------- */

  resize(w, h) {
    this.w = w;
    this.h = h;
    this.camera.aspect = w / h;
    this.camera.fov = w < h ? 62 : 52;
    this.camera.updateProjectionMatrix();
  }

  update(dt) {
    if (this.paused) {
      this.app.renderer.render(this.scene, this.camera);
      return;
    }
    this.frame++;
    const P = this.player;
    const w = this.world;

    this.clock += dt / DAY_LEN;
    this.night = w.setTime(this.clock, this.scene);

    for (let i = this.later.length - 1; i >= 0; i--) {
      const l = this.later[i];
      l.t -= dt;
      if (l.t <= 0) {
        this.later.splice(i, 1);
        l.fn();
      }
    }

    if (this.cine) this._cine(dt);
    else this._player(dt);
    this._critters(dt);
    this._convo(dt);
    this._things(dt);
    if (!this.cine) this._camera(dt);
    w.update(dt, P.pos, this.camera.position);
    if (this.fire) {
      const k = 1 + Math.sin(this.clock * 9000) * 0.12 + Math.sin(this.frame * 0.37) * 0.08;
      this.fire.flame.scale.set(k, 1 + (k - 1) * 2.2, k);
      this.fire.core.scale.set(1, 2 - k, 1);
      this.fire.light.intensity = 26 * k;
      this.fire.halo.material.opacity = 0.35 + this.night * 0.4;
    }

    this._hud(dt);
    this.saveT -= dt;
    if (this.saveT <= 0) {
      this.saveT = 30;
      this.snapshot();
    }
    this.app.renderer.render(this.scene, this.camera);
  }

  _player(dt) {
    const P = this.player;
    const hud = this.hud;
    P.safe -= dt;
    P.lastHit += dt;
    for (const k in P.cd) P.cd[k] = Math.max(0, P.cd[k] - dt);

    let mx = 0;
    let mz = 0;
    let speed = 0;
    if (!P.dead) {
      const K = this.keys;
      let ix = (K.has('KeyD') || K.has('ArrowRight') ? 1 : 0) - (K.has('KeyA') || K.has('ArrowLeft') ? 1 : 0);
      let iy = (K.has('KeyW') || K.has('ArrowUp') ? 1 : 0) - (K.has('KeyS') || K.has('ArrowDown') ? 1 : 0);
      let mag = Math.min(1, Math.hypot(ix, iy));
      let run = K.has('ShiftLeft') || K.has('ShiftRight');
      if (hud.stick.id !== null) {
        ix = hud.stick.x;
        iy = -hud.stick.y;
        mag = Math.min(1, Math.hypot(ix, iy));
        run = mag > 0.93;
      }
      if (mag > 0.08) {
        const yaw = this.cam.yaw;
        const fx = -Math.sin(yaw);
        const fz = -Math.cos(yaw);
        mx = fx * iy + Math.cos(yaw) * ix;
        mz = fz * iy - Math.sin(yaw) * ix;
        speed = P.walkSpeed * (run ? 1.45 : 1) * (P.hunger <= 0 ? 0.8 : 1) * Math.max(mag, 0.35);
        if (this.convo && this.distToPlayer(this.convo.cr) > 11) this._endConvo(false);
      }
      P.gliding = P.stats.glide > 0 && !P.onGround && K.has('Space');
      // hunger
      const drain = (run && speed > 0 ? 0.9 : 0.36) * dt;
      P.hunger = Math.max(0, P.hunger - drain);
      if (P.hunger <= 0) {
        P.hp -= 1.4 * dt;
        this.hint('starving', 'You are starving. Find food, your compass marks it in red.');
        if (P.hp <= 0) this._die();
      } else if (P.hunger > 40 && P.lastHit > 6 && P.hp < P.maxHp) P.hp = Math.min(P.maxHp, P.hp + (Math.hypot(P.pos.x - this.home.x, P.pos.z - this.home.z) < 7 ? 6 : 1.2) * dt);
      if (P.hunger < 25) this.hint('hungry', 'Your belly is nearly empty.');
    }

    // ram: a short committed charge
    if (P.dash > 0) {
      P.dash -= dt;
      mx = Math.sin(P.heading);
      mz = Math.cos(P.heading);
      speed = 13;
      if (!P.dashHit) {
        for (const cr of this.critters) {
          if (!cr.alive || cr.sp.status === 'kin' || cr.pack) continue;
          if (cr.pos.distanceTo(P.pos) < P.radius + cr.radius + 0.5) {
            P.dashHit = true;
            P.dash = 0;
            this._strike(cr, 5 + P.stats.ram * 7, 10);
            break;
          }
        }
      }
    }
    if (P.pending) {
      P.pending.t -= dt;
      if (P.pending.t <= 0) {
        const { id, lvl } = P.pending;
        P.pending = null;
        const tg = this.target;
        if (tg && tg.alive) {
          const range = P.radius + tg.radius + (id === 'bite' ? 1.0 : 1.3);
          const ang = Math.abs(angDiff(P.heading, Math.atan2(tg.pos.x - P.pos.x, tg.pos.z - P.pos.z)));
          if (this.distToPlayer(tg) < range && ang < 1.3) this._strike(tg, id === 'bite' ? 7 + lvl * 6 : 4 + lvl * 4.2, id === 'bite' ? 3 : 2);
        }
      }
    }

    locomote(P, mx, mz, speed, dt, this);
    if (Math.hypot(P.pos.x, P.pos.z) > 184) this.hint('sea', 'The open sea turns you back. This island is the whole world, for now.');
    P.speedNow = Math.hypot(P.vel.x, P.vel.z);
    P.c.headPos(P.look);
    const tg = this.target;
    P.c.look = tg && tg.alive && this.distToPlayer(tg) < 12 ? _v.copy(tg.pos).setY(tg.pos.y + tg.c.height * tg.sp.scale * 0.8) : null;
    P.c.update(dt);
    if (this.packT > 0) {
      this.packT -= dt;
      if (this.packT <= 0) this.packTarget = null;
    }
    const vig = +hud.r.vig.style.opacity || 0;
    if (vig > 0) hud.flash(Math.max(0, vig - dt * 1.8));
  }

  _critters(dt) {
    const P = this.player;
    const list = this.critters;
    for (let i = list.length - 1; i >= 0; i--) {
      const cr = list[i];
      const d = this.distToPlayer(cr);
      const lod = d < 62 ? 0 : d < 120 ? 1 : 2;
      cr.c.root.visible = lod < 2;
      cr.update(dt, lod);
      if (cr.gone) {
        cr.dispose();
        list.splice(i, 1);
        const m = cr.sp.members;
        m.splice(m.indexOf(cr), 1);
      }
    }
    // keep bodies from overlapping
    for (let i = 0; i < list.length; i++) {
      const a = list[i];
      if (!a.alive) continue;
      for (let j = i + 1; j < list.length; j++) {
        const b = list[j];
        if (!b.alive) continue;
        const dx = b.pos.x - a.pos.x;
        const dz = b.pos.z - a.pos.z;
        const min = (a.radius + b.radius) * 0.8;
        const d2 = dx * dx + dz * dz;
        if (d2 < min * min && d2 > 1e-6) {
          const d = Math.sqrt(d2);
          const k = ((min - d) / d) * 0.5;
          a.pos.x -= dx * k;
          a.pos.z -= dz * k;
          b.pos.x += dx * k;
          b.pos.z += dz * k;
        }
      }
      const dx = a.pos.x - P.pos.x;
      const dz = a.pos.z - P.pos.z;
      const min = (a.radius + P.radius) * 0.8;
      const d2 = dx * dx + dz * dz;
      if (d2 < min * min && d2 > 1e-6 && !P.dead) {
        const d = Math.sqrt(d2);
        const k = (min - d) / d;
        a.pos.x += dx * k * 0.7;
        a.pos.z += dz * k * 0.7;
        P.pos.x -= dx * k * 0.3;
        P.pos.z -= dz * k * 0.3;
      }
    }
    // nests raise new young
    for (const sp of [this.kin, ...this.species]) {
      const alive = sp.members.filter((m) => m.alive).length;
      const want = sp.status === 'cowed' ? Math.max(1, sp.role.count - 2) : sp.role.count;
      if (alive >= want) continue;
      sp.respawn -= dt;
      if (sp.respawn <= 0) {
        sp.respawn = 45;
        const baby = this._spawn(sp, true);
        if (sp.status === 'ally') baby.friend = true;
      }
    }
  }

  _convo(dt) {
    const cv = this.convo;
    if (!cv) return;
    const cr = cv.cr;
    if (!cr.alive || cr.state !== 'converse') {
      this._endConvo(false);
      return;
    }
    cv.t -= dt;
    if (cv.phase === 'greet' && cv.t <= 0) cv.phase = 'ask';
    if (cv.phase === 'ask') {
      cv.expect = pickVoice(cr.sp);
      cr.c.play(cv.expect);
      this.audio.voiceFor(cr.sp.stats, cv.expect);
      this.emote(cr, cv.expect, 4.2);
      cv.phase = 'wait';
      cv.t = 4.4;
    } else if (cv.phase === 'wait' && cv.t <= 0) {
      cr.bond = Math.max(0, cr.bond - 4);
      cv.misses++;
      this.emote(cr, 'ask', 1.2);
      cv.phase = 'react';
      cv.t = 1.1;
      cv.expect = null;
    } else if (cv.phase === 'react' && cv.t <= 0) {
      if (cr.bond >= 100) this._endConvo(true);
      else if (cv.misses >= 3) {
        toast(`The ${esc(cr.sp.name)} loses interest.`);
        this._endConvo(false);
      } else cv.phase = 'ask';
    }
  }

  _things(dt) {
    for (let i = this.meat.length - 1; i >= 0; i--) {
      const m = this.meat[i];
      m.t -= dt;
      if (m.t <= 0) {
        this.scene.remove(m.mesh);
        this.meat.splice(i, 1);
      }
    }
    for (let i = this.emotes.length - 1; i >= 0; i--) {
      const e = this.emotes[i];
      e.t += dt;
      if (e.t >= e.dur || !e.cr.alive) {
        this.scene.remove(e.sp);
        e.sp.material.dispose();
        this.emotes.splice(i, 1);
        continue;
      }
      e.cr.c.headPos(_v);
      const s = e.cr.sp.scale;
      const pop = Math.min(1, e.t * 7) * Math.min(1, (e.dur - e.t) * 5);
      e.sp.position.set(_v.x, _v.y + 0.75 * s + 0.35, _v.z);
      e.sp.scale.setScalar((0.9 + Math.sin(e.t * 6) * 0.05) * pop * clamp(this.camera.position.distanceTo(_v) * 0.085, 0.75, 2.2));
    }
  }

  _camera(dt) {
    const P = this.player;
    const cam = this.cam;
    const K = this.keys;
    // lazily swing behind the player when nobody is steering the camera
    cam.auto -= dt;
    if (cam.auto <= 0 && P.speedNow > 1 && this.pointers.size === 0) {
      const want = P.heading + Math.PI;
      const d = angDiff(cam.yaw, want);
      if (Math.abs(d) < 2.4) cam.yaw += d * Math.min(1, dt * 0.9);
    }
    if (K.has('BracketLeft')) cam.yaw += dt * 1.8;
    if (K.has('BracketRight')) cam.yaw -= dt * 1.8;
    cam.dist = damp(cam.dist, cam.tdist, 8, dt);
    const h = P.c.height;
    _v.set(P.pos.x, P.pos.y + h * 0.85 + 0.25, P.pos.z);
    cam.focus.x = damp(cam.focus.x, _v.x, 14, dt);
    cam.focus.y = damp(cam.focus.y, _v.y, 7, dt);
    cam.focus.z = damp(cam.focus.z, _v.z, 14, dt);
    if (cam.focus.distanceTo(_v) > 12) cam.focus.copy(_v);
    const dist = cam.dist * (0.75 + h * 0.3);
    const cp = Math.cos(cam.pitch);
    const c = this.camera;
    c.position.set(cam.focus.x + Math.sin(cam.yaw) * cp * dist, cam.focus.y + Math.sin(cam.pitch) * dist, cam.focus.z + Math.cos(cam.yaw) * cp * dist);
    const floor = Math.max(this.world.heightAt(c.position.x, c.position.z), SEA) + 0.5;
    if (c.position.y < floor) c.position.y = floor;
    c.lookAt(cam.focus);
  }

  _hud(dt) {
    const P = this.player;
    const hud = this.hud;
    // auto-target: nearest thing roughly ahead, unless the player picked one
    this.lockT -= dt;
    const cur = this.target;
    if (cur && (!cur.alive || this.distToPlayer(cur) > 26)) this.target = null;
    if ((this.lockT <= 0 || !this.target) && !this.convo) {
      const fx = -Math.sin(this.cam.yaw);
      const fz = -Math.cos(this.cam.yaw);
      let best = null;
      let bs = 15;
      for (const cr of this.critters) {
        if (!cr.alive) continue;
        const dx = cr.pos.x - P.pos.x;
        const dz = cr.pos.z - P.pos.z;
        const d = Math.hypot(dx, dz);
        if (d > 15) continue;
        const ahead = (dx * fx + dz * fz) / (d || 1);
        let score = d * (1.6 - ahead * 0.6);
        if (cr === cur) score *= 0.7;
        if (cr.sp.status === 'kin' && !cr.pack) score *= 1.5;
        if (score < bs) {
          bs = score;
          best = cr;
        }
      }
      this.target = best;
    }
    const tg = this.target;
    this.ring.visible = !!tg;
    if (tg) {
      const r = tg.radius * 1.5 + 0.3;
      this.ring.position.set(tg.pos.x, Math.max(this.world.heightAt(tg.pos.x, tg.pos.z), SEA) + 0.08, tg.pos.z);
      this.ring.scale.setScalar(r * (1 + Math.sin(this.frame * 0.1) * 0.04));
    }
    hud.target(tg, this.convo, P.stance);
    hud.prompt(this._prompts());
    hud.notes(this._notes());
    hud.update(dt);
  }

  _notes() {
    const s = this.save;
    const P = this.player;
    if (s.won) return [];
    const out = [];
    const food = P.stats.diet === 'carn' ? 'Hunt, and eat what you bring down' : P.stats.diet === 'herb' ? 'Find berries to eat' : 'Find something to eat';
    if (s.tally.meals === 0) out.push({ text: food });
    const met = this.species.filter((sp) => sp.met).length;
    if (met === 0) out.push({ text: 'Find your neighbours' });
    const settled = this.species.filter((sp) => sp.status !== 'wild').length;
    if (met > 0 && settled === 0) out.push({ text: 'Befriend a nest in its own voice, or drive it off' });
    const st = this.stageInfo();
    if (s.bank >= 20 && !s.sandbox) out.push({ text: `Go home and evolve: ${s.bank} helix to spend` });
    else if (settled > 0 && st.toGo) out.push({ text: `${st.toGo} helix to become a ${st.next}` });
    if (st.i === STAGES.length - 1) out.push({ text: 'Go home. Light the first fire.' });
    else if (settled > 0 && this.world.bones.some((b) => !b.found)) out.push({ text: 'Old bones hide new parts' });
    return out.slice(0, 3);
  }

  dispose() {
    for (const off of this._off) off();
    if (this.menu) this.menu.root.remove();
    this.hud.dispose();
    for (const cr of this.critters) cr.dispose();
    for (const sp of this.species) sp.kit.dispose();
    this.player.c.dispose();
    for (const e of this.emotes) e.sp.material.dispose();
    this.meatGeo.dispose();
    this.meatMat.dispose();
    this.world.dispose();
  }
}
