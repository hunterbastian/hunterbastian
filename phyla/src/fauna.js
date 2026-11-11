// The other animals: species generated from the same genome system the
// player uses, each with a nest, a temperament and a small brain.

import * as THREE from './three.js';
import { Creature } from './creature.js';
import { makeKit } from './skin.js';
import { randomGenome, computeStats } from './genome.js';
import { SEA } from './world.js';
import { clamp, damp, angDiff, makeRng } from './util.js';

export const TEMPER = {
  gentle: 'gentle',
  skittish: 'shy',
  curious: 'curious',
  territorial: 'territorial',
  predator: 'predatory',
  kin: 'your own kind',
};

// The cast of every island. The first two nests are the ones nearest home.
const ROLES = [
  { arch: 'grazer', temper: 'gentle', count: 4, scale: 1 },
  { arch: 'critter', temper: 'skittish', count: 5, scale: 0.62 },
  { arch: 'strutter', temper: 'curious', count: 3, scale: 1 },
  { arch: 'longneck', temper: 'gentle', count: 3, scale: 1.3 },
  { arch: 'brute', temper: 'territorial', count: 3, scale: 1.2 },
  { arch: 'stalker', temper: 'predator', count: 3, scale: 1 },
  { arch: 'skulker', temper: 'predator', count: 2, scale: 1.12 },
];
export const SPECIES_COUNT = ROLES.length;

const _v = new THREE.Vector3();
const _v2 = new THREE.Vector3();

export function buildSpecies(game) {
  const { world, save } = game;
  const list = [];
  world.spots.forEach((spot, i) => {
    const role = ROLES[i % ROLES.length];
    const genome = randomGenome(save.seed * 13 + i * 101 + 7, role.arch);
    const stats = computeStats(genome);
    const saved = save.species[i] || {};
    const sp = {
      id: i,
      role,
      genome,
      stats,
      name: genome.name,
      kit: makeKit(genome.skin, save.seed + i),
      temper: role.temper,
      diet: stats.diet,
      scale: role.scale,
      nest: { x: spot.x, z: spot.z, y: world.heightAt(spot.x, spot.z) },
      members: [],
      rel: saved.rel || 0,
      friends: saved.friends || 0,
      kills: saved.kills || 0,
      status: saved.status || 'wild',
      met: !!saved.met,
      need: Math.min(3, role.count),
      respawn: 30,
      voices: ['trill', 'sway', 'flare', 'glow'].map((id) => ({ id, w: stats[id] + 0.6 })),
    };
    world.addNest(sp.nest.x, sp.nest.z, genome.skin.base, false);
    list.push(sp);
  });
  return list;
}

export function pickVoice(sp, rnd = Math.random) {
  let total = 0;
  for (const v of sp.voices) total += v.w;
  let r = rnd() * total;
  for (const v of sp.voices) {
    r -= v.w;
    if (r <= 0) return v.id;
  }
  return sp.voices[0].id;
}

// Shared locomotion: turn toward a direction, accelerate, slide off
// obstacles, follow the ground, float in water, fall when airborne.
export function locomote(e, dx, dz, speed, dt, game) {
  const world = game.world;
  const pos = e.pos;
  let tvx = 0;
  let tvz = 0;
  if (speed > 0.01 && (dx !== 0 || dz !== 0)) {
    const want = Math.atan2(dx, dz);
    const d = angDiff(e.heading, want);
    e.heading += clamp(d, -e.turn * dt, e.turn * dt);
    const sp = speed * (0.3 + 0.7 * Math.max(0, Math.cos(d))) * (e.swim ? 0.6 : 1);
    tvx = Math.sin(e.heading) * sp;
    tvz = Math.cos(e.heading) * sp;
  }
  const acc = e.onGround ? 9 : 2.5;
  e.vel.x = damp(e.vel.x, tvx, acc, dt);
  e.vel.z = damp(e.vel.z, tvz, acc, dt);
  pos.x += (e.vel.x + e.push.x) * dt;
  pos.z += (e.vel.z + e.push.z) * dt;
  e.push.multiplyScalar(Math.max(0, 1 - 6 * dt));
  world.collide(pos, e.radius * 0.7);
  // the open sea turns you back
  const far = Math.hypot(pos.x, pos.z);
  if (far > 186) {
    pos.x *= 186 / far;
    pos.z *= 186 / far;
  }
  const gy = world.heightAt(pos.x, pos.z);
  const floor = Math.max(gy, SEA - e.float);
  const wasSwim = e.swim;
  e.swim = gy < SEA - e.float + 0.02;
  if (e.swim && !wasSwim && e.onSplash) e.onSplash();
  if (e.onGround) {
    pos.y = damp(pos.y, floor, 22, dt);
    if (pos.y < floor - 0.02) pos.y = floor;
  } else {
    e.vy -= 21 * dt;
    if (e.gliding && e.vy < -1.7) e.vy = -1.7;
    pos.y += e.vy * dt;
    if (pos.y <= floor) {
      pos.y = floor;
      e.vy = 0;
      e.onGround = true;
      if (e.onLand) e.onLand();
    }
  }
  const c = e.c;
  c.heading = e.heading;
  c.vel.copy(e.vel);
  c.free = !e.onGround || e.swim;
  c.paddle = e.swim ? 1 : 0;
}

let uid = 1;

export class Critter {
  constructor(game, sp, x, z, opts = {}) {
    this.game = game;
    this.sp = sp;
    this.id = uid++;
    this.baby = !!opts.baby;
    this.growth = this.baby ? 0.5 : 1;
    this.c = new Creature(sp.genome, { kit: sp.kit, ground: game.groundFn, scale: sp.scale * this.growth });
    this.pos = this.c.root.position;
    this.pos.set(x, game.world.heightAt(x, z), z);
    this.heading = Math.random() * 6.283;
    this.c.heading = this.heading;
    this.vel = new THREE.Vector3();
    this.push = new THREE.Vector3();
    this.vy = 0;
    this.onGround = true;
    this.swim = false;
    this.turn = 4.2;
    this.radius = this.c.radius * sp.scale;
    this.float = this.c.height * sp.scale * 0.55;
    this.maxHp = Math.round(sp.stats.health * sp.scale);
    this.hp = this.maxHp;
    this.alive = true;
    this.state = 'idle';
    this.t = 1 + Math.random() * 4;
    this.goal = new THREE.Vector3(x, 0, z);
    this.target = null;
    this.bond = 0;
    this.friend = false;
    this.pack = false;
    this.cool = Math.random() * 2;
    this.calm = 0; // seconds before it will pick another fight
    this.warn = 0;
    this.sayT = 4 + Math.random() * 14;
    this.gone = 0;
    this.c.resetFeet();
    game.scene.add(this.c.root);
    if (opts.hatch) this.c.play('hatch');
  }

  get speed() {
    return this.sp.stats.moveSpeed * Math.sqrt(this.sp.scale) * (this.baby ? 0.8 : 1);
  }

  get power() {
    const s = this.sp.stats;
    return 3 + 3.2 * Math.max(s.bite, s.ram, s.swipe);
  }

  set(state, t = 0) {
    this.state = state;
    this.t = t;
    if (state !== 'sleep') this.c.sleeping = false;
  }

  canTalk() {
    return this.alive && !this.friend && this.sp.status === 'wild' && this.state !== 'flee' && this.state !== 'fight' && this.state !== 'hunt' && this.state !== 'sleep' && !this.baby;
  }

  nestDist() {
    return Math.hypot(this.pos.x - this.sp.nest.x, this.pos.z - this.sp.nest.z);
  }

  _wanderGoal(radius) {
    const world = this.game.world;
    for (let i = 0; i < 6; i++) {
      const a = Math.random() * 6.283;
      const r = 3 + Math.random() * radius;
      const x = this.sp.nest.x + Math.cos(a) * r;
      const z = this.sp.nest.z + Math.sin(a) * r;
      if (world.heightAt(x, z) > 0.3) {
        this.goal.set(x, 0, z);
        return;
      }
    }
    this.goal.set(this.sp.nest.x, 0, this.sp.nest.z);
  }

  // Take damage. `from` is a Critter, or the string 'player'.
  hurt(dmg, from) {
    if (!this.alive) return;
    const game = this.game;
    dmg *= 1 - 0.08 * this.sp.stats.armor;
    this.hp -= dmg;
    this.c.play('hurt');
    this.c.sleeping = false;
    const fromPlayer = from === 'player' || (from && from.pack);
    const dist = game.distToPlayer(this);
    game.audio.voiceFor(this.sp.stats, 'hurt', clamp(1.2 - dist / 40, 0, 1));
    if (fromPlayer) {
      game.floater(Math.round(dmg), this, 'dmg');
      this.friend = false;
      this.bond = 0;
      if (this.sp.status !== 'kin') this.sp.rel = Math.max(-100, this.sp.rel - 12);
    }
    if (this.hp <= 0) {
      this.die(fromPlayer);
      return;
    }
    const attacker = from === 'player' ? game.player : from;
    if (this.pack) {
      // a pack member stands its ground beside you
      if (attacker !== game.player) {
        this.target = attacker;
        this.set('fight', 10);
      }
      return;
    }
    const timid = this.sp.temper === 'gentle' || this.sp.temper === 'skittish' || this.baby || this.sp.status === 'cowed';
    for (const m of this.sp.members) {
      if (!m.alive || m.pack) continue;
      if (m !== this && m.pos.distanceTo(this.pos) > 20) continue;
      if (timid || (this.sp.temper === 'curious' && m.hp < m.maxHp * 0.5)) {
        m.target = attacker;
        m.set('flee', 5 + Math.random() * 3);
      } else if (m.state !== 'fight') {
        m.target = attacker;
        m.set('fight', 14);
      }
    }
  }

  die(byPlayer) {
    const game = this.game;
    this.alive = false;
    this.pack = false;
    this.hp = 0;
    this.c.action = null;
    this.c.play('die');
    this.c.dead = false;
    this.state = 'dead';
    this.t = 5;
    game.onCritterDied(this, byPlayer);
  }

  _attack(dt) {
    const game = this.game;
    const tg = this.target;
    const tp = tg.pos;
    const range = this.radius + tg.radius + 0.75;
    const d = Math.hypot(tp.x - this.pos.x, tp.z - this.pos.z);
    if (d < range && this.cool <= 0 && !this.c.busy) {
      this.cool = 1.25 + Math.random() * 0.5;
      this.c.play('bite');
      game.audio.voiceFor(this.sp.stats, 'bite', clamp(1.2 - game.distToPlayer(this) / 30, 0, 1));
      this.strike = 0.2;
    }
    if (this.strike > 0) {
      this.strike -= dt;
      if (this.strike <= 0 && d < range + 0.6) {
        if (tg === game.player) game.hurtPlayer(this.power * this.sp.scale, this);
        else if (tg.alive) tg.hurt(this.power * this.sp.scale, this);
      }
    }
    return d;
  }

  update(dt, lod) {
    const game = this.game;
    const P = game.player;
    const sp = this.sp;
    const c = this.c;
    this.cool -= dt;
    this.calm -= dt;
    this.t -= dt;

    if (this.state === 'dead') {
      if (this.t < 2.2) this.pos.y -= dt * 0.35;
      if (lod < 2) c.update(dt);
      if (this.t <= 0) this.gone = 1;
      return;
    }

    if (this.baby) {
      this.growth = Math.min(1, this.growth + dt / 150);
      c.setScale(sp.scale * this.growth);
      if (this.growth >= 1) {
        this.baby = false;
        this.radius = c.radius * sp.scale;
      }
    }

    const dxp = P.pos.x - this.pos.x;
    const dzp = P.pos.z - this.pos.z;
    const dP = Math.hypot(dxp, dzp);
    const night = game.world.night > 0.72;
    const wild = sp.status === 'wild';
    const busy = this.state === 'flee' || this.state === 'fight' || this.state === 'hunt' || this.state === 'converse' || this.state === 'follow' || this.state === 'feast';
    let mx = 0;
    let mz = 0;
    let spd = 0;

    // first sight of the player
    if (!sp.met && dP < 15 && sp.status !== 'kin') game.onMet(sp, this);

    /* ---- reactions to the player ---- */
    if (!busy && !P.dead) {
      if (sp.status === 'cowed' && dP < 13) {
        this.target = P;
        this.set('flee', 4);
      } else if (wild && !this.friend) {
        if (sp.temper === 'skittish' && dP < 7.5 && P.speedNow > P.walkSpeed * 1.15 && sp.rel < 30) {
          this.target = P;
          this.set('flee', 3.5);
          game.emote(this, 'alarm', 1.2);
        } else if (sp.temper === 'predator' && this.calm <= 0 && dP < (night ? 24 : 16) && sp.rel < 35 && !(P.safe > 0)) {
          this.target = P;
          this.set('fight', 11);
          game.emote(this, 'alarm', 1.4);
          game.audio.voiceFor(sp.stats, 'growl', clamp(1.3 - dP / 26, 0, 1));
          game.onHunted(this);
        } else if (sp.temper === 'territorial' && sp.rel < 30 && this.calm <= 0) {
          const nd = Math.hypot(P.pos.x - sp.nest.x, P.pos.z - sp.nest.z);
          if (nd < 10 && dP < 13) {
            this.warn += dt;
            if (this.warn > 0.2 && this.warn - dt <= 0.2) {
              c.play('flare');
              game.emote(this, 'alarm', 2);
              game.audio.voiceFor(sp.stats, 'growl', clamp(1.3 - dP / 22, 0, 1));
              game.hint('territory', `The ${sp.name} is warning you off its nest.`);
            }
            if (this.warn > 4.5 && nd < 8) {
              this.target = P;
              this.set('fight', 9);
            }
          } else this.warn = Math.max(0, this.warn - dt * 0.5);
        }
      }
    }

    /* ---- state machine ---- */
    switch (this.state) {
      case 'idle': {
        c.look = dP < 11 ? P.look : null;
        if (this.t <= 0) {
          if (night && sp.temper !== 'predator') {
            if (this.nestDist() > 7) {
              this._wanderGoal(3);
              this.set('wander', 30);
            } else {
              this.set('sleep', 6 + Math.random() * 6);
              c.sleeping = true;
            }
          } else if (sp.temper === 'predator' && this.calm <= 0 && Math.random() < (night ? 0.3 : 0.12)) {
            const prey = game.findPrey(this);
            if (prey) {
              this.target = prey;
              this.set('hunt', 12);
              break;
            }
            this._wanderGoal(26);
            this.set('wander', 20);
          } else if (sp.diet !== 'carn' && Math.random() < 0.4) {
            const b = game.nearestBush(this.pos, 34);
            if (b) {
              this.goal.set(b.x + (Math.random() - 0.5) * 2.4, 0, b.z + (Math.random() - 0.5) * 2.4);
              this.set('graze', 22);
            } else {
              this._wanderGoal(18);
              this.set('wander', 20);
            }
          } else {
            this._wanderGoal(sp.temper === 'predator' ? 30 : this.baby ? 7 : 18);
            this.set('wander', 20);
          }
        }
        break;
      }
      case 'wander':
      case 'graze':
      case 'return': {
        c.look = null;
        mx = this.goal.x - this.pos.x;
        mz = this.goal.z - this.pos.z;
        const d = Math.hypot(mx, mz);
        spd = this.speed * (this.state === 'return' ? 0.7 : 0.42);
        if (d < 1.3 || this.t <= 0) {
          spd = 0;
          if (this.state === 'graze' && d < 2) {
            c.play('eat');
            if (lod === 0 && dP < 25) game.audio.eat();
            this.set('idle', 2.2 + Math.random() * 2);
          } else this.set('idle', 1.5 + Math.random() * 4.5);
        }
        break;
      }
      case 'sleep': {
        c.sleeping = true;
        c.look = null;
        if (!night && this.t <= 0) this.set('idle', 1);
        else if (this.t <= 0) {
          this.t = 5 + Math.random() * 5;
          if (lod === 0 && dP < 30) game.emote(this, 'zzz', 2.4);
        }
        if (dP < 3.2 && P.speedNow > P.walkSpeed * 1.2 && !this.friend && sp.status === 'wild') {
          this.set('idle', 1.5);
          game.emote(this, 'alarm', 1);
        }
        break;
      }
      case 'flee': {
        const tg = this.target || P;
        mx = this.pos.x - tg.pos.x;
        mz = this.pos.z - tg.pos.z;
        const d = Math.hypot(mx, mz);
        // do not run into the sea
        if (game.world.heightAt(this.pos.x + (mx / (d || 1)) * 6, this.pos.z + (mz / (d || 1)) * 6) < 0.2) {
          const tx = -mz;
          mz = mx;
          mx = tx;
        }
        spd = this.speed * 1.08;
        c.look = null;
        if (this.t <= 0 || d > 30) {
          this._wanderGoal(8);
          this.set('return', 30);
        }
        break;
      }
      case 'fight':
      case 'hunt': {
        const tg = this.target;
        const gone = !tg || (tg === P ? P.dead : !tg.alive);
        if (gone || this.t <= 0) {
          this.calm = 16 + Math.random() * 14;
          this._wanderGoal(8);
          this.set('return', 30);
          break;
        }
        c.look = tg.look || tg.pos;
        mx = tg.pos.x - this.pos.x;
        mz = tg.pos.z - this.pos.z;
        const d = this._attack(dt);
        const reach = this.radius + tg.radius + 0.45;
        // never quite as fast as a sprinting player
        const top = tg === P ? Math.min(this.speed, P.walkSpeed * 0.96 + 0.55) : this.speed;
        spd = d > reach ? top : 0;
        if (d > 38 || (this.pack && tg !== P && game.distToPlayer(this) > 30)) this.t = 0;
        if (this.state === 'hunt' && !tg.alive) this.t = 0;
        if (!this.pack && tg === P && sp.temper === 'territorial' && this.nestDist() > 34) this.t = 0;
        if (spd === 0) {
          // keep facing the target while biting
          const want = Math.atan2(mx, mz);
          this.heading += clamp(angDiff(this.heading, want), -6 * dt, 6 * dt);
        }
        break;
      }
      case 'feast': {
        c.look = null;
        if (!c.busy) c.play('eat');
        if (this.t <= 0) {
          this.calm = 50 + Math.random() * 40;
          this._wanderGoal(8);
          this.set('return', 40);
        }
        break;
      }
      case 'converse': {
        c.look = P.look;
        const want = Math.atan2(dxp, dzp);
        this.heading += clamp(angDiff(this.heading, want), -4 * dt, 4 * dt);
        break;
      }
      case 'follow': {
        // pack member: keep a loose slot behind the player
        c.look = dP < 8 ? P.look : null;
        const slot = this.slot || 0;
        const a = P.heading + Math.PI + (slot - 1) * 0.7;
        _v.set(P.pos.x + Math.sin(a) * (2.6 + slot * 0.5), 0, P.pos.z + Math.cos(a) * (2.6 + slot * 0.5));
        mx = _v.x - this.pos.x;
        mz = _v.z - this.pos.z;
        const d = Math.hypot(mx, mz);
        spd = d > 1.4 ? Math.min(this.speed * 1.5, P.speedNow * 1.05 + (d - 1.4) * 1.6) : 0;
        if (d > 70) {
          this.pos.set(_v.x, game.world.heightAt(_v.x, _v.z), _v.z);
          c.resetFeet();
        }
        if (game.packTarget && game.packTarget.alive && game.packTarget !== this) {
          this.target = game.packTarget;
          this.set('fight', 10);
        }
        break;
      }
      default:
        break;
    }

    if (this.pack && this.state !== 'follow' && this.state !== 'fight') this.set('follow', 0);
    if (this.pack && this.state === 'fight' && this.t <= 0) this.set('follow', 0);

    locomote(this, mx, mz, spd, dt, game);

    // idle chatter
    this.sayT -= dt;
    if (this.sayT <= 0) {
      this.sayT = 9 + Math.random() * 22;
      if (lod === 0 && dP < 34 && this.state !== 'sleep' && this.state !== 'converse') game.audio.voiceFor(sp.stats, 'call', clamp(0.9 - dP / 40, 0, 0.7));
    }

    if (lod === 0) c.update(dt);
    else if (lod === 1 && (game.frame + this.id) % 2 === 0) c.update(dt * 2);
    else if (lod === 2) c.root.rotation.y = this.heading;
  }

  dispose() {
    this.c.dispose();
  }
}

// Deterministic picks for rewards, so a save always yields the same gifts.
export function rewardRng(seed, n) {
  return makeRng(seed * 31 + n * 977);
}

export { _v2 as scratch };
