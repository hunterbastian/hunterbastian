// In-world interface: vitals, the action bar, target card, radar, prompts,
// floating numbers and the little thought-bubbles above creatures' heads.

import * as THREE from './three.js';
import { el, esc, icon, pips, ICONS, SOCIAL, FIERCE } from './ui.js';
import { TEMPER } from './fauna.js';
import { clamp } from './util.js';

/* ------------------------------ emote bubbles ---------------------------- */

const EMOTES = {
  trill: { icon: 'trill', color: '#d8961f' },
  sway: { icon: 'sway', color: '#4f9a3c' },
  flare: { icon: 'flare', color: '#d2553a' },
  glow: { icon: 'glow', color: '#2f9cb4' },
  heart: { icon: 'heart', color: '#c2603f', fill: true },
  growl: { icon: 'swipe', color: '#a8321c' },
  alarm: { text: '!', color: '#c2603f' },
  ask: { text: '?', color: '#6a6557' },
  zzz: { text: 'z', color: '#5b6fb0' },
};
const emoteCache = {};

export function emoteTexture(kind) {
  if (emoteCache[kind]) return emoteCache[kind];
  const spec = EMOTES[kind] || EMOTES.ask;
  const c = document.createElement('canvas');
  c.width = c.height = 128;
  const x = c.getContext('2d');
  x.beginPath();
  x.arc(64, 58, 50, 0, Math.PI * 2);
  x.moveTo(50, 102);
  x.lineTo(64, 124);
  x.lineTo(78, 102);
  x.fillStyle = '#fffdf6';
  x.fill();
  x.lineWidth = 5;
  x.strokeStyle = '#26241f';
  x.beginPath();
  x.arc(64, 58, 50, 0.72, Math.PI - 0.72, true);
  x.lineTo(64, 124);
  x.closePath();
  x.stroke();
  if (spec.icon) {
    x.save();
    x.translate(64 - 34, 58 - 34);
    x.scale(68 / 24, 68 / 24);
    x.lineWidth = 2.3;
    x.lineCap = 'round';
    x.lineJoin = 'round';
    x.strokeStyle = spec.color;
    const p = new Path2D(ICONS[spec.icon]);
    if (spec.fill) {
      x.fillStyle = spec.color;
      x.fill(p);
    }
    x.stroke(p);
    x.restore();
  } else {
    x.fillStyle = spec.color;
    x.font = 'bold 72px Georgia, serif';
    x.textAlign = 'center';
    x.textBaseline = 'middle';
    x.fillText(spec.text, 64, 62);
  }
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  emoteCache[kind] = t;
  return t;
}

/* ----------------------------------- HUD --------------------------------- */

export class Hud {
  constructor(game) {
    this.game = game;
    const touch = game.app.touch;
    const root = (this.root = el(`
      <div class="hud ${touch ? 'touch' : ''}">
        <div class="vignette" data-vig></div>
        <div class="floaters" data-floaters></div>
        <div class="hud__me">
          <img class="hud__portrait" data-portrait alt="" />
          <div class="hud__vitals">
            <div class="hud__name" data-name></div>
            <div class="bar bar--health" title="Health"><i data-hp></i></div>
            <div class="bar bar--hunger" title="Hunger"><i data-hunger></i></div>
            <div class="hud__helix" title="Helix: spend it at your nest">${icon('helix', 14)}<b data-helix>0</b><div class="bar bar--evo"><i data-evo></i></div><span data-stage></span></div>
          </div>
        </div>
        <div class="hud__notes" data-notes></div>
        <div class="hud__right">
          <canvas class="radar" data-radar width="248" height="248"></canvas>
          <div class="hud__rightrow">
            <span class="hud__clock" data-clock>${icon('sun')}</span>
            <button class="iconbtn" data-menu aria-label="Menu">${icon('pause')}</button>
          </div>
        </div>
        <div class="hud__target" data-target hidden></div>
        <div class="hud__prompt" data-prompt hidden></div>
        <div class="hud__bar">
          <button class="stance" data-stance></button>
          <div class="actions" data-actions></div>
        </div>
        <div class="hud__touch">
          <div class="stick" data-stick><i></i></div>
          <button class="tbtn tbtn--use" data-use hidden>use</button>
          <button class="tbtn tbtn--jump" data-jump>${icon('jump')}</button>
        </div>
      </div>`));
    game.app.ui.appendChild(root);
    const $ = (s) => root.querySelector(s);
    this.$ = $;
    this.r = {
      hp: $('[data-hp]'), hunger: $('[data-hunger]'), helix: $('[data-helix]'), evo: $('[data-evo]'), stage: $('[data-stage]'),
      name: $('[data-name]'), portrait: $('[data-portrait]'), notes: $('[data-notes]'), radar: $('[data-radar]'), clock: $('[data-clock]'),
      target: $('[data-target]'), prompt: $('[data-prompt]'), stance: $('[data-stance]'), actions: $('[data-actions]'), vig: $('[data-vig]'),
      floaters: $('[data-floaters]'), use: $('[data-use]'), stick: $('[data-stick]'),
    };
    this.cache = {};
    this.radarT = 0;
    this.stick = { x: 0, y: 0, id: null };
    this._bind();
  }

  _bind() {
    const g = this.game;
    const r = this.r;
    this.root.addEventListener('click', (e) => {
      const b = e.target.closest('button');
      if (!b) return;
      const d = b.dataset;
      if ('stance' in d) g.toggleStance();
      else if (d.act) g.doAction(d.act);
      else if ('menu' in d) g.openMenu();
      else if (d.do) g.interact(d.do);
      else if ('use' in d) g.interact();
      else if ('jump' in d) g.jump();
    });
    // virtual stick
    const st = r.stick;
    const knob = st.firstElementChild;
    const move = (e) => {
      const b = st.getBoundingClientRect();
      let x = (e.clientX - (b.left + b.width / 2)) / (b.width / 2);
      let y = (e.clientY - (b.top + b.height / 2)) / (b.height / 2);
      const m = Math.hypot(x, y);
      if (m > 1) {
        x /= m;
        y /= m;
      }
      this.stick.x = x;
      this.stick.y = y;
      knob.style.transform = `translate(${x * 34}px, ${y * 34}px)`;
    };
    st.addEventListener('pointerdown', (e) => {
      st.setPointerCapture(e.pointerId);
      this.stick.id = e.pointerId;
      move(e);
    });
    st.addEventListener('pointermove', (e) => {
      if (this.stick.id === e.pointerId) move(e);
    });
    const end = (e) => {
      if (this.stick.id !== e.pointerId) return;
      this.stick.id = null;
      this.stick.x = this.stick.y = 0;
      knob.style.transform = '';
    };
    st.addEventListener('pointerup', end);
    st.addEventListener('pointercancel', end);
  }

  setMe(name, gen, thumb) {
    this.r.name.innerHTML = `${esc(name)}<small>gen ${gen}</small>`;
    this.r.portrait.src = thumb;
  }

  // Rebuild the action bar for the current stance.
  actions(stance, stats) {
    const list = stance === 'friendly' ? SOCIAL : FIERCE;
    this.r.stance.dataset.s = stance;
    this.r.stance.innerHTML = `${icon(stance === 'friendly' ? 'heart' : 'swipe', 22)}<span>${stance}</span><small>tab</small>`;
    this.r.actions.innerHTML = list
      .map((a) => {
        const lvl = stats[a.id];
        const off = stance === 'fierce' && lvl === 0;
        return `<button class="act ${off ? 'off' : ''}" data-act="${a.id}" style="--c:${a.color}" title="${a.name}"><span class="key">${a.key}</span>${icon(a.id, 24)}<span>${a.name}</span>${pips(lvl, a.color)}</button>`;
      })
      .join('');
    this.acts = [...this.r.actions.children];
  }

  set(key, value, fn) {
    if (this.cache[key] === value) return;
    this.cache[key] = value;
    fn(value);
  }

  prompt(list) {
    // list: [{ id, key, label }]
    const sig = list.map((p) => p.id + p.label).join('|');
    this.set('prompt', sig, () => {
      const p = this.r.prompt;
      p.hidden = !list.length;
      p.innerHTML = list.map((it) => `<button class="btn btn--small btn--ghost" data-do="${it.id}" style="border:0;padding:0 4px;gap:8px"><span class="kbd">${it.key}</span>${it.label}</button>`).join('');
      this.r.use.hidden = !list.length;
      if (list.length) this.r.use.textContent = list[0].short || 'use';
    });
  }

  target(cr, convo, stance) {
    const t = this.r.target;
    this.set('hasTarget', !!cr, (v) => this.root.classList.toggle('has-target', v));
    if (!cr) {
      this.set('tg', '', () => (t.hidden = true));
      return;
    }
    const sp = cr.sp;
    const rel = Math.round(sp.rel);
    const mood = sp.status === 'kin' ? 'your own kind' : sp.status === 'ally' ? 'ally' : sp.status === 'cowed' ? 'afraid of you' : cr.friend ? 'friend' : TEMPER[sp.temper];
    const talk = convo && convo.cr === cr;
    const sig = [cr.id, rel, mood, Math.round(cr.hp), Math.round(cr.bond), talk ? convo.expect + Math.ceil(convo.t * 4) : '', stance, cr.pack].join(',');
    this.set('tg', sig, () => {
      t.hidden = false;
      let body = '';
      if (talk) {
        const ex = SOCIAL.find((s) => s.id === convo.expect);
        body = `<div class="barlabel"><span>bond</span><span>${ex ? `answer with <b style="color:${ex.color}">${ex.name}</b>` : 'listening…'}</span></div>
          <div class="bar bar--rel"><i style="width:${clamp(cr.bond, 0, 100)}%"></i></div>`;
      } else if (stance === 'fierce' || cr.hp < cr.maxHp) {
        body = `<div class="barlabel"><span>health</span><span>${Math.max(0, Math.round(cr.hp))} / ${cr.maxHp}</span></div><div class="bar bar--thp"><i style="width:${clamp((cr.hp / cr.maxHp) * 100, 0, 100)}%"></i></div>`;
      } else if (sp.status === 'wild') {
        body = `<div class="barlabel"><span>${rel < 0 ? 'wary' : 'trust'}</span><span>${sp.friends} / ${sp.need} befriended</span></div>
          <div class="bar bar--rel ${rel < 0 ? 'neg' : ''}"><i style="width:${Math.abs(rel)}%"></i></div>`;
      }
      t.innerHTML = `<b>${esc(sp.name)}${cr.baby ? ' <small>young</small>' : ''}</b><small>${mood} · ${sp.diet === 'carn' ? 'carnivore' : sp.diet === 'herb' ? 'herbivore' : 'omnivore'}${cr.pack ? ' · in your pack' : ''}</small>${body}`;
    });
  }

  notes(lines) {
    const sig = lines.map((l) => l.text + l.done).join('|');
    this.set('notes', sig, () => {
      this.r.notes.hidden = !lines.length;
      this.r.notes.innerHTML = `<span class="eyebrow">Field notes</span><ul>${lines.map((l) => `<li class="${l.done ? 'done' : ''}">${l.text}</li>`).join('')}</ul>`;
    });
  }

  floater(text, x, y, cls = '') {
    const f = el(`<span class="floater ${cls}" style="left:${x}px;top:${y}px">${text}</span>`);
    this.r.floaters.appendChild(f);
    setTimeout(() => f.remove(), 1150);
  }

  flash(amount) {
    this.r.vig.style.opacity = amount;
  }

  update(dt) {
    const g = this.game;
    const P = g.player;
    const s = g.save;
    this.set('hp', Math.round((P.hp / P.maxHp) * 100), (v) => (this.r.hp.style.width = clamp(v, 0, 100) + '%'));
    this.set('hunger', Math.round(P.hunger), (v) => (this.r.hunger.style.width = clamp(v, 0, 100) + '%'));
    this.set('helix', s.sandbox ? '∞' : s.bank, (v) => (this.r.helix.textContent = v));
    const st = g.stageInfo();
    this.set('evo', Math.round(st.frac * 100), (v) => (this.r.evo.style.width = v + '%'));
    this.set('stage', st.name, (v) => (this.r.stage.textContent = v));
    this.set('clock', g.world.night > 0.5, (n) => (this.r.clock.innerHTML = icon(n ? 'moon' : 'sun')));
    // cooldown sweeps and conversation cue
    if (this.acts) {
      for (const b of this.acts) {
        const id = b.dataset.act;
        const cd = g.cooldown(id);
        b.style.setProperty('--cd', cd.toFixed(2));
        b.classList.toggle('cue', !!(g.convo && g.convo.expect === id && g.convo.phase === 'wait'));
      }
    }
    this.radarT -= dt;
    if (this.radarT <= 0) {
      this.radarT = 0.1;
      this._radar();
    }
  }

  _radar() {
    const g = this.game;
    const cv = this.r.radar;
    const x = cv.getContext('2d');
    const W = cv.width;
    const R = W / 2;
    const P = g.player;
    const range = 70 + P.stats.sense * 18 + P.stats.sight * 4;
    const yaw = g.cam.yaw;
    const fx = -Math.sin(yaw);
    const fz = -Math.cos(yaw);
    const rx = Math.cos(yaw);
    const rz = -Math.sin(yaw);
    x.clearRect(0, 0, W, W);
    x.save();
    x.translate(R, R);
    x.strokeStyle = 'rgba(38,36,31,0.14)';
    x.lineWidth = 2;
    for (const k of [0.33, 0.66]) {
      x.beginPath();
      x.arc(0, 0, R * k, 0, Math.PI * 2);
      x.stroke();
    }
    const plot = (wx, wz, pin) => {
      const dx = wx - P.pos.x;
      const dz = wz - P.pos.z;
      let px = ((dx * rx + dz * rz) / range) * (R - 10);
      let py = (-(dx * fx + dz * fz) / range) * (R - 10);
      const m = Math.hypot(px, py);
      if (m > R - 12) {
        if (!pin) return null;
        px *= (R - 12) / m;
        py *= (R - 12) / m;
      }
      return [px, py];
    };
    const dot = (p, r, color) => {
      if (!p) return;
      x.beginPath();
      x.arc(p[0], p[1], r, 0, Math.PI * 2);
      x.fillStyle = color;
      x.fill();
    };
    const diet = P.stats.diet;
    if (diet !== 'carn') for (const b of g.world.bushes) if (b.berries > 0) dot(plot(b.x, b.z), 4, '#e8503a');
    for (const m of g.meat) dot(plot(m.x, m.z), 5, '#b5482f');
    for (const b of g.world.bones) {
      if (b.found) continue;
      const p = plot(b.x, b.z, P.stats.sense > 0);
      if (!p) continue;
      x.fillStyle = '#26241f';
      x.fillRect(p[0] - 5, p[1] - 5, 10, 10);
      x.fillStyle = '#fffdf6';
      x.fillRect(p[0] - 3, p[1] - 3, 6, 6);
    }
    for (const sp of g.species) {
      if (!sp.met) continue;
      const p = plot(sp.nest.x, sp.nest.z, false);
      if (!p) continue;
      x.strokeStyle = sp.status === 'ally' ? '#5e7f4a' : sp.status === 'cowed' ? '#8a8f98' : sp.temper === 'predator' || sp.rel < -20 ? '#c2603f' : '#6a6557';
      x.lineWidth = 4;
      x.beginPath();
      x.arc(p[0], p[1], 9, 0, Math.PI * 2);
      x.stroke();
    }
    for (const cr of g.critters) {
      if (!cr.alive) continue;
      const sp = cr.sp;
      const hostile = cr.state === 'fight' && cr.target === P;
      const col = cr.pack ? '#3f8fd6' : sp.status === 'kin' || sp.status === 'ally' || cr.friend ? '#5e7f4a' : hostile ? '#c2603f' : '#6a6557';
      dot(plot(cr.pos.x, cr.pos.z), hostile ? 6 : 4.5, col);
    }
    // home, always pinned to the rim
    const h = plot(g.world.home.x, g.world.home.z, true);
    if (h) {
      x.save();
      x.translate(h[0], h[1]);
      x.fillStyle = '#26241f';
      x.beginPath();
      x.arc(0, 0, 13, 0, Math.PI * 2);
      x.fill();
      x.scale(0.8, 0.8);
      x.translate(-12, -12);
      x.strokeStyle = '#fff0c0';
      x.lineWidth = 2.2;
      x.lineCap = 'round';
      x.stroke(new Path2D(ICONS.nest));
      x.restore();
    }
    // the player, pointing where the body faces
    const rel = P.heading - (yaw + Math.PI);
    x.rotate(-rel);
    x.fillStyle = '#26241f';
    x.beginPath();
    x.moveTo(0, -11);
    x.lineTo(8, 9);
    x.lineTo(0, 4);
    x.lineTo(-8, 9);
    x.closePath();
    x.fill();
    x.restore();
  }

  dispose() {
    this.root.remove();
  }
}
