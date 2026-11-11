// The tidepool: a short 2D prologue. Drift, eat, grow through four sizes,
// pick a mutation at each, and what you ate decides the mouth you take ashore.

import { el, icon, modal } from './ui.js';
import { clamp, lerp, damp, angDiff, TAU } from './util.js';

const NEED = [8, 11, 14, 17];
const SIZE = [16, 22, 30, 40];
const TIER_NAME = ['a speck', 'a swimmer', 'a forager', 'nearly ready'];
const MUTATIONS = [
  { id: 'whip', name: 'Whiptail', icon: 'speed', text: 'A longer tail. Swim a fifth faster.' },
  { id: 'spike', name: 'Thornlet', icon: 'ram', text: 'A spur up front. Catch cells as big as you are.' },
  { id: 'gape', name: 'Wide Gape', icon: 'bite', text: 'A bigger mouth. Food from farther off.' },
  { id: 'cilia', name: 'Cilia', icon: 'sway', text: 'Fine hairs stir the water and pull food in.' },
  { id: 'wall', name: 'Thick Wall', icon: 'armor', text: 'One more bite before you dissolve.' },
  { id: 'eye', name: 'Eyespot', icon: 'sight', text: 'See more of the pool around you.' },
];
const LAND_SKIN = {
  herb: { base: '#7fb069', accent: '#35654d', belly: '#ece3b8', pattern: 'dapple' },
  carn: { base: '#c2664a', accent: '#5a2a2a', belly: '#f0d9b8', pattern: 'stripes' },
  omni: { base: '#c9a05a', accent: '#6b4a2f', belly: '#f2e6c4', pattern: 'spots' },
};

const rand = (a, b) => a + Math.random() * (b - a);

export class CellStage {
  constructor(app, o) {
    this.kind = 'cell';
    this.app = app;
    this.o = o;
    this.cv = app.cellCanvas;
    this.x = this.cv.getContext('2d');
    this.t = 0;
    this.tier = 0;
    this.xp = 0;
    this.plants = 0;
    this.meats = 0;
    this.muts = {};
    this.picking = false;
    this.over = false;
    this.zoom = 1.4;
    this.view = 900;
    this.shake = 0;
    this.p = { x: 0, y: 0, vx: 0, vy: 0, a: -Math.PI / 2, r: SIZE[0], lives: 3, maxLives: 3, hurtT: 0, dead: 0, mouth: 0 };
    this.steer = null;
    this.keys = new Set();
    this.motes = [];
    this.cells = [];
    this.pops = [];
    this.dust = [];
    for (let i = 0; i < 90; i++) this.dust.push({ x: rand(-1, 1), y: rand(-1, 1), z: rand(0.25, 1), s: rand(0.6, 2.2) });
    this.blobs = [];
    for (let i = 0; i < 9; i++) this.blobs.push({ x: rand(-1, 1), y: rand(-1, 1), r: rand(0.25, 0.6), p: rand(0, 6) });

    this.ui = el(`
      <div class="cellhud">
        <div class="cellhud__life" data-life></div>
        <div class="cellhud__top"><span class="eyebrow" data-tier></span><div class="bar"><i data-xp></i></div></div>
        <div class="cellhud__diet"><span>${icon('herb', 14)} <b data-pl>0</b></span><span>${icon('carn', 14)} <b data-mt>0</b></span></div>
        <button class="iconbtn" data-quit aria-label="Leave">${icon('close')}</button>
        <p class="cellhud__hint" data-hint></p>
      </div>`);
    app.ui.appendChild(this.ui);
    this.$ = (s) => this.ui.querySelector(s);
    this.ui.querySelector('[data-quit]').addEventListener('click', () => o.onQuit());
    this._hint(app.touch ? 'Touch and hold to swim. Eat the green, or anything smaller than you.' : 'Swim toward your cursor. Eat the green, or anything smaller than you.');
    this._hud();

    this._off = [];
    const on = (t, ev, fn) => {
      t.addEventListener(ev, fn);
      this._off.push(() => t.removeEventListener(ev, fn));
    };
    const point = (e) => {
      const r = this.cv.getBoundingClientRect();
      this.steer = { x: e.clientX - r.left - r.width / 2, y: e.clientY - r.top - r.height / 2 };
    };
    on(this.cv, 'pointerdown', (e) => {
      this.cv.setPointerCapture(e.pointerId);
      this.down = true;
      point(e);
    });
    on(this.cv, 'pointermove', (e) => {
      if (e.pointerType === 'mouse' || this.down) point(e);
    });
    const up = (e) => {
      this.down = false;
      if (e.pointerType !== 'mouse') this.steer = null;
    };
    on(this.cv, 'pointerup', up);
    on(this.cv, 'pointercancel', up);
    on(this.cv, 'pointerleave', (e) => {
      if (e.pointerType === 'mouse' && !this.down) this.steer = null;
    });
    on(window, 'keydown', (e) => this.keys.add(e.code));
    on(window, 'keyup', (e) => this.keys.delete(e.code));

    for (let i = 0; i < 40; i++) this._spawnMote(true);
    for (let i = 0; i < 6; i++) this._spawnCell('drifter', true);
  }

  _hint(text, ms = 7000) {
    const h = this.$('[data-hint]');
    h.textContent = text;
    h.style.opacity = 1;
    clearTimeout(this.hintT);
    this.hintT = setTimeout(() => (h.style.opacity = 0), ms);
  }

  _hud() {
    const p = this.p;
    this.$('[data-life]').innerHTML = Array.from({ length: p.maxLives }, (_, i) => `<i class="${i < p.lives ? '' : 'off'}"></i>`).join('');
    this.$('[data-tier]').textContent = `You are ${TIER_NAME[Math.min(this.tier, 3)]}`;
    this.$('[data-xp]').style.width = clamp((this.xp / NEED[Math.min(this.tier, 3)]) * 100, 0, 100) + '%';
    this.$('[data-pl]').textContent = this.plants;
    this.$('[data-mt]').textContent = this.meats;
  }

  /* -------------------------------- spawning ----------------------------- */

  _ring(initial) {
    const view = Math.max(this.w || 900, this.h || 700) / this.zoom;
    const p = this.p;
    // mostly stock the water ahead, so a fast swimmer never outruns the food
    const moving = !initial && Math.hypot(p.vx, p.vy) > 40;
    const a = moving && Math.random() < 0.7 ? Math.atan2(p.vy, p.vx) + rand(-1.1, 1.1) : rand(0, TAU);
    const d = initial ? rand(110, view * 0.72) : rand(view * 0.58, view * 0.9);
    return [this.p.x + Math.cos(a) * d, this.p.y + Math.sin(a) * d];
  }

  _spawnMote(initial, kind, at) {
    const [x, y] = at || this._ring(initial);
    const k = kind || (Math.random() < 0.8 ? 'plant' : 'meat');
    this.motes.push({ x, y, vx: rand(-6, 6), vy: rand(-6, 6), r: k === 'plant' ? rand(5, 8) : rand(5, 7), kind: k, ph: rand(0, 6) });
  }

  _spawnCell(kind, initial) {
    const [x, y] = this._ring(initial);
    const pr = this.p.r;
    const c = { kind, x, y, vx: 0, vy: 0, a: rand(0, TAU), ph: rand(0, 6), t: rand(0, 3), hue: 0, r: 10, hurt: 0 };
    if (kind === 'drifter') {
      c.r = pr * rand(0.55, 1.15);
      c.hue = rand(150, 200);
      c.speed = rand(30, 50);
    } else if (kind === 'spiker') {
      c.r = pr * rand(0.9, 1.3);
      c.hue = rand(270, 310);
      c.speed = 16;
    } else {
      c.r = pr * rand(1.45, 1.9);
      c.hue = rand(350, 380);
      c.speed = rand(66, 80);
    }
    this.cells.push(c);
  }

  /* -------------------------------- progress ----------------------------- */

  _eat(kind, n, x, y) {
    if (kind === 'plant') this.plants += n;
    else this.meats += n;
    this.xp += n;
    this.p.mouth = 1;
    this.pops.push({ x, y, t: 0, c: kind === 'plant' ? '#b6f08a' : '#ffb0a0' });
    this.app.audio.blip(kind === 'plant' ? 'bubble' : 'pop');
    if (this.xp >= NEED[this.tier] && !this.picking) this._levelUp();
    this._hud();
  }

  _levelUp() {
    this.picking = true;
    this.app.audio.blip('good');
    const pool = MUTATIONS.filter((m) => (this.muts[m.id] || 0) < 2).sort(() => Math.random() - 0.5).slice(0, 3);
    const last = this.tier === 3;
    const m = modal(
      `<p class="eyebrow">${last ? 'One last change' : 'You are changing'}</p>
       <h2>Choose a mutation</h2>
       <div class="picks">${pool.map((mu) => `<button class="pick" data-mut="${mu.id}">${icon(mu.icon, 30)}<b>${mu.name}</b><small>${mu.text}</small></button>`).join('')}</div>`,
      { dismiss: false },
    );
    m.root.addEventListener('click', (e) => {
      const b = e.target.closest('[data-mut]');
      if (!b) return;
      const id = b.dataset.mut;
      this.muts[id] = (this.muts[id] || 0) + 1;
      if (id === 'wall') {
        this.p.maxLives++;
        this.p.lives = this.p.maxLives;
      }
      m.root.remove();
      this.app.audio.blip('unlock');
      this.xp = 0;
      this.tier++;
      this.picking = false;
      if (this.tier >= 4) this._finish();
      else {
        this._hint(this.tier === 1 ? 'Bigger things have noticed you. The red ones bite.' : this.tier === 2 ? 'What chased you is starting to look like lunch.' : 'The water is getting shallow. Almost there.');
        this._hud();
      }
    });
  }

  _finish() {
    this.over = true;
    const total = this.plants + this.meats || 1;
    const diet = this.plants / total >= 0.68 ? 'herb' : this.meats / total >= 0.58 ? 'carn' : 'omni';
    const bonus = Object.values(this.muts).reduce((a, b) => a + b, 0) * 6;
    const words = { herb: 'You grazed your way here. You will walk ashore a herbivore.', carn: 'You hunted your way here. You will walk ashore a carnivore.', omni: 'You ate whatever came. You will walk ashore an omnivore.' };
    this.app.audio.blip('evolve');
    const m = modal(
      `<p class="eyebrow">The water thins</p>
       <h2>Something in you wants the shore.</h2>
       <p>${words[diet]}</p>
       <p>Legs come next. You choose them.</p>
       <div class="row row--end"><button class="btn btn--primary" data-go>Crawl ashore</button></div>`,
      { dismiss: false },
    );
    m.root.querySelector('[data-go]').addEventListener('click', () => {
      m.root.remove();
      this.o.onDone({ diet, skin: { ...LAND_SKIN[diet] }, bonus });
    });
  }

  _hurt(fromX, fromY) {
    const p = this.p;
    if (p.hurtT > 0 || p.dead > 0) return;
    p.lives--;
    p.hurtT = 1.3;
    this.shake = 0.35;
    const a = Math.atan2(p.y - fromY, p.x - fromX);
    p.vx += Math.cos(a) * 260;
    p.vy += Math.sin(a) * 260;
    this.app.audio.hit(0.8);
    if (p.lives <= 0) {
      p.dead = 1.6;
      this.xp = Math.floor(this.xp * 0.5);
      this._hint('You came apart. The pool is patient: try again.');
    }
    this._hud();
  }

  /* ---------------------------------- frame ------------------------------ */

  resize(w, h) {
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    this.w = w;
    this.h = h;
    this.dpr = dpr;
    this.cv.width = Math.round(w * dpr);
    this.cv.height = Math.round(h * dpr);
  }

  update(dt) {
    if (!this.w) return;
    this.t += dt;
    if (!this.picking && !this.over) this._sim(dt);
    this._draw();
  }

  _sim(dt) {
    const p = this.p;
    const mu = this.muts;
    p.r = damp(p.r, SIZE[Math.min(this.tier, 3)], 2.5, dt);
    // the camera pulls back as you grow, but you still look bigger each time
    const onScreen = (Math.min(this.w, this.h) < 600 ? 19 : 24) + this.tier * 5.5;
    this.zoom = damp(this.zoom, onScreen / p.r / (1 + (mu.eye || 0) * 0.16), 1.6, dt);
    p.hurtT = Math.max(0, p.hurtT - dt);
    p.mouth = Math.max(0, p.mouth - dt * 3);
    this.shake = Math.max(0, this.shake - dt);

    if (p.dead > 0) {
      p.dead -= dt;
      if (p.dead <= 0) {
        p.lives = p.maxLives;
        p.hurtT = 2.5;
        this._hud();
        this.cells = this.cells.filter((c) => c.kind !== 'hunter');
      }
    } else {
      // steering
      let ax = 0;
      let ay = 0;
      const K = this.keys;
      const kx = (K.has('KeyD') || K.has('ArrowRight') ? 1 : 0) - (K.has('KeyA') || K.has('ArrowLeft') ? 1 : 0);
      const ky = (K.has('KeyS') || K.has('ArrowDown') ? 1 : 0) - (K.has('KeyW') || K.has('ArrowUp') ? 1 : 0);
      if (kx || ky) {
        const m = Math.hypot(kx, ky);
        ax = kx / m;
        ay = ky / m;
      } else if (this.steer) {
        const m = Math.hypot(this.steer.x, this.steer.y);
        if (m > p.r * this.zoom * 0.7) {
          const k = Math.min(1, m / 140);
          ax = (this.steer.x / m) * k;
          ay = (this.steer.y / m) * k;
        }
      }
      const top = (150 + p.r * 1.6) * (1 + (mu.whip || 0) * 0.2);
      p.vx = damp(p.vx, ax * top, 3.2, dt);
      p.vy = damp(p.vy, ay * top, 3.2, dt);
      p.x += p.vx * dt;
      p.y += p.vy * dt;
      const sp = Math.hypot(p.vx, p.vy);
      if (sp > 8) p.a += clamp(angDiff(p.a, Math.atan2(p.vy, p.vx)), -7 * dt, 7 * dt) * (1 + (mu.cilia || 0) * 0.4);
    }

    this.view = Math.max(this.w, this.h) / this.zoom;
    // food
    const reach = p.r * (0.95 + (mu.gape || 0) * 0.35);
    const pull = p.r * (2.2 + (mu.cilia || 0) * 2.4);
    for (let i = this.motes.length - 1; i >= 0; i--) {
      const m = this.motes[i];
      m.x += m.vx * dt;
      m.y += m.vy * dt;
      const dx = p.x - m.x;
      const dy = p.y - m.y;
      const d = Math.hypot(dx, dy);
      if (p.dead <= 0) {
        if (d < pull && (mu.cilia || mu.gape)) {
          m.x += (dx / d) * 70 * dt;
          m.y += (dy / d) * 70 * dt;
        }
        if (d < reach + m.r * 0.5) {
          this.motes.splice(i, 1);
          this._eat(m.kind, m.kind === 'meat' ? 2 : 1, m.x, m.y);
          continue;
        }
      }
      if (d > this.view * 1.25) this.motes.splice(i, 1);
    }

    // other cells
    for (let i = this.cells.length - 1; i >= 0; i--) {
      const c = this.cells[i];
      c.t -= dt;
      c.hurt = Math.max(0, c.hurt - dt);
      const dx = p.x - c.x;
      const dy = p.y - c.y;
      const d = Math.hypot(dx, dy) || 1;
      const edible = p.r > c.r * (mu.spike ? 0.98 : 1.14) && c.kind !== 'spiker';
      const bigSpiker = c.kind === 'spiker' && p.r > c.r * 1.7;
      let tx = Math.cos(c.a);
      let ty = Math.sin(c.a);
      let speed = c.speed;
      if (p.dead <= 0 && c.kind === 'hunter' && !edible && d < 420) {
        tx = dx / d;
        ty = dy / d;
        speed = c.speed + p.r;
      } else if (p.dead <= 0 && (edible || bigSpiker) && d < 190) {
        tx = -dx / d;
        ty = -dy / d;
        speed = c.speed * 1.5;
      } else if (c.t <= 0) {
        c.t = rand(1.5, 4);
        c.a += rand(-1.2, 1.2);
      }
      c.a += clamp(angDiff(c.a, Math.atan2(ty, tx)), -3 * dt, 3 * dt);
      c.vx = damp(c.vx, Math.cos(c.a) * speed, 2.5, dt);
      c.vy = damp(c.vy, Math.sin(c.a) * speed, 2.5, dt);
      c.x += c.vx * dt;
      c.y += c.vy * dt;
      if (p.dead <= 0 && d < p.r + c.r * 0.86) {
        if (edible || bigSpiker) {
          this.cells.splice(i, 1);
          for (let k = 0; k < 3; k++) this._spawnMote(false, 'meat', [c.x + rand(-c.r, c.r), c.y + rand(-c.r, c.r)]);
          this._eat('meat', 2, c.x, c.y);
          continue;
        } else if (c.kind !== 'drifter') {
          this._hurt(c.x, c.y);
          c.vx -= (dx / d) * 120;
          c.vy -= (dy / d) * 120;
        } else {
          // bump
          p.vx += (dx / d) * 40;
          p.vy += (dy / d) * 40;
          c.vx -= (dx / d) * 60;
          c.vy -= (dy / d) * 60;
        }
      }
      if (d > this.view * 1.5) this.cells.splice(i, 1);
    }

    // keep the pool stocked
    if (this.motes.length < Math.round(44 * clamp(1 / this.zoom, 1, 2.4))) this._spawnMote(false);
    const count = (k) => this.cells.filter((c) => c.kind === k).length;
    if (count('drifter') < 7) this._spawnCell('drifter');
    if (this.tier >= 1 && count('spiker') < 3) this._spawnCell('spiker');
    if (this.tier >= 1 && this.t > 25 && count('hunter') < (this.tier >= 2 ? 2 : 1)) this._spawnCell('hunter');
    for (let i = this.pops.length - 1; i >= 0; i--) {
      this.pops[i].t += dt;
      if (this.pops[i].t > 0.5) this.pops.splice(i, 1);
    }
  }

  _blob(x, cx, cy, r, ph, wob = 0.07) {
    x.beginPath();
    const n = 14;
    for (let i = 0; i <= n; i++) {
      const a = (i / n) * TAU;
      const rr = r * (1 + Math.sin(a * 3 + ph) * wob + Math.sin(a * 5 - ph * 1.3) * wob * 0.6);
      const px = cx + Math.cos(a) * rr;
      const py = cy + Math.sin(a) * rr;
      if (i === 0) x.moveTo(px, py);
      else x.lineTo(px, py);
    }
    x.closePath();
  }

  _tail(x, r, len, t, width) {
    x.beginPath();
    x.moveTo(-r * 0.9, 0);
    for (let i = 1; i <= 10; i++) {
      const u = i / 10;
      x.lineTo(-r * 0.9 - u * len, Math.sin(t * 9 - u * 5) * r * 0.32 * u);
    }
    x.lineWidth = width;
    x.lineCap = 'round';
    x.stroke();
  }

  _draw() {
    const x = this.x;
    const { w, h, dpr, t } = this;
    const p = this.p;
    x.setTransform(dpr, 0, 0, dpr, 0, 0);
    // water
    const g = x.createLinearGradient(0, 0, 0, h);
    const shallow = this.tier / 4;
    g.addColorStop(0, `rgb(${Math.round(lerp(16, 60, shallow))},${Math.round(lerp(92, 150, shallow))},${Math.round(lerp(110, 150, shallow))})`);
    g.addColorStop(1, `rgb(${Math.round(lerp(5, 22, shallow))},${Math.round(lerp(36, 78, shallow))},${Math.round(lerp(52, 88, shallow))})`);
    x.fillStyle = g;
    x.fillRect(0, 0, w, h);
    // slow caustic light
    x.globalCompositeOperation = 'lighter';
    for (const b of this.blobs) {
      const bx = ((((b.x * w - p.x * 0.12 + Math.sin(t * 0.13 + b.p) * 40) % w) + w) % w);
      const by = ((((b.y * h - p.y * 0.12 + Math.cos(t * 0.11 + b.p) * 30) % h) + h) % h);
      const r = b.r * Math.min(w, h) * 0.6;
      const rg = x.createRadialGradient(bx, by, 0, bx, by, r);
      rg.addColorStop(0, 'rgba(140,230,220,0.085)');
      rg.addColorStop(1, 'rgba(140,230,220,0)');
      x.fillStyle = rg;
      x.fillRect(bx - r, by - r, r * 2, r * 2);
    }
    x.globalCompositeOperation = 'source-over';
    // drifting silt with parallax
    x.fillStyle = 'rgba(210,245,240,0.35)';
    for (const d of this.dust) {
      const px = ((((d.x * w - p.x * d.z * 0.6) % w) + w) % w);
      const py = ((((d.y * h - p.y * d.z * 0.6 + t * 6 * d.z) % h) + h) % h);
      x.globalAlpha = 0.25 + d.z * 0.4;
      x.fillRect(px, py, d.s, d.s);
    }
    x.globalAlpha = 1;

    const sh = this.shake > 0 ? (Math.random() - 0.5) * 14 * this.shake : 0;
    x.translate(w / 2 + sh, h / 2 + sh);
    x.scale(this.zoom, this.zoom);
    x.translate(-p.x, -p.y);

    for (const m of this.motes) {
      if (m.kind === 'plant') {
        x.fillStyle = '#7fd66a';
        for (let k = 0; k < 3; k++) {
          const a = m.ph + k * 2.1 + t * 0.4;
          x.beginPath();
          x.arc(m.x + Math.cos(a) * m.r * 0.45, m.y + Math.sin(a) * m.r * 0.45, m.r * 0.62, 0, TAU);
          x.fill();
        }
        x.fillStyle = '#d9ffb8';
        x.beginPath();
        x.arc(m.x, m.y, m.r * 0.3, 0, TAU);
        x.fill();
      } else {
        x.fillStyle = '#f08f84';
        this._blob(x, m.x, m.y, m.r, m.ph + t, 0.16);
        x.fill();
        x.fillStyle = '#ffd3c7';
        x.beginPath();
        x.arc(m.x - m.r * 0.2, m.y - m.r * 0.2, m.r * 0.3, 0, TAU);
        x.fill();
      }
    }

    for (const c of this.cells) {
      x.save();
      x.translate(c.x, c.y);
      x.rotate(c.a);
      const edible = p.r > c.r * (this.muts.spike ? 0.98 : 1.14) && c.kind !== 'spiker';
      x.strokeStyle = `hsla(${c.hue},60%,72%,0.7)`;
      this._tail(x, c.r, c.r * 1.3, t + c.ph, c.r * 0.12);
      if (c.kind === 'spiker') {
        x.fillStyle = `hsl(${c.hue},45%,78%)`;
        for (let k = 0; k < 9; k++) {
          const a = (k / 9) * TAU + Math.sin(t + c.ph) * 0.1;
          x.beginPath();
          x.moveTo(Math.cos(a - 0.14) * c.r * 0.9, Math.sin(a - 0.14) * c.r * 0.9);
          x.lineTo(Math.cos(a) * c.r * 1.38, Math.sin(a) * c.r * 1.38);
          x.lineTo(Math.cos(a + 0.14) * c.r * 0.9, Math.sin(a + 0.14) * c.r * 0.9);
          x.fill();
        }
      }
      x.fillStyle = `hsla(${c.hue},${c.kind === 'hunter' ? 62 : 48}%,${c.kind === 'hunter' ? 52 : 58}%,0.78)`;
      this._blob(x, 0, 0, c.r, t * 2 + c.ph);
      x.fill();
      x.lineWidth = c.r * 0.09;
      x.strokeStyle = `hsla(${c.hue},70%,82%,0.9)`;
      x.stroke();
      x.fillStyle = `hsla(${c.hue},50%,30%,0.5)`;
      x.beginPath();
      x.arc(-c.r * 0.15, c.r * 0.1, c.r * 0.34, 0, TAU);
      x.fill();
      // eye
      const ex = c.r * 0.45;
      x.fillStyle = '#f4fffb';
      x.beginPath();
      x.arc(ex, 0, c.r * (c.kind === 'hunter' ? 0.26 : 0.22), 0, TAU);
      x.fill();
      x.fillStyle = '#10222a';
      x.beginPath();
      x.arc(ex + c.r * 0.07, 0, c.r * 0.11, 0, TAU);
      x.fill();
      if (c.kind === 'hunter' && !edible) {
        x.fillStyle = '#fff3ee';
        for (const s of [-1, 1]) {
          x.beginPath();
          x.moveTo(c.r * 0.82, s * c.r * 0.34);
          x.lineTo(c.r * 1.16, s * c.r * 0.14);
          x.lineTo(c.r * 0.9, s * c.r * 0.08);
          x.fill();
        }
      }
      x.restore();
    }

    // the player
    if (p.dead <= 0) {
      const mu = this.muts;
      const total = this.plants + this.meats || 1;
      const hue = lerp(165, 18, clamp((this.meats / total - 0.2) / 0.6, 0, 1));
      x.save();
      x.translate(p.x, p.y);
      x.rotate(p.a);
      if (p.hurtT > 0 && Math.sin(t * 30) > 0) x.globalAlpha = 0.45;
      x.strokeStyle = `hsla(${hue},70%,80%,0.85)`;
      const sp = Math.hypot(p.vx, p.vy);
      this._tail(x, p.r, p.r * (1.5 + (mu.whip || 0) * 0.7), t * (0.6 + sp / 120), p.r * 0.13);
      if (mu.whip > 1) {
        x.save();
        x.rotate(0.25);
        this._tail(x, p.r, p.r * 1.4, t * (0.6 + sp / 120) + 1, p.r * 0.09);
        x.restore();
      }
      if (mu.cilia) {
        x.lineWidth = p.r * 0.05;
        for (let k = 0; k < 16; k++) {
          const a = (k / 16) * TAU;
          const wv = Math.sin(t * 8 + k) * 0.2;
          x.beginPath();
          x.moveTo(Math.cos(a) * p.r, Math.sin(a) * p.r);
          x.lineTo(Math.cos(a + wv) * p.r * 1.22, Math.sin(a + wv) * p.r * 1.22);
          x.stroke();
        }
      }
      if (mu.spike) {
        x.fillStyle = '#fff6e4';
        x.beginPath();
        x.moveTo(p.r * 0.85, -p.r * 0.2);
        x.lineTo(p.r * (1.5 + mu.spike * 0.15), 0);
        x.lineTo(p.r * 0.85, p.r * 0.2);
        x.fill();
      }
      const rg = x.createRadialGradient(-p.r * 0.2, -p.r * 0.2, p.r * 0.1, 0, 0, p.r);
      rg.addColorStop(0, `hsla(${hue},70%,74%,0.95)`);
      rg.addColorStop(1, `hsla(${hue},58%,48%,0.86)`);
      x.fillStyle = rg;
      this._blob(x, 0, 0, p.r, t * 2.4, 0.05 + Math.min(sp / 2500, 0.05));
      x.fill();
      x.lineWidth = p.r * (0.09 + (mu.wall || 0) * 0.07);
      x.strokeStyle = `hsla(${hue},85%,88%,0.95)`;
      x.stroke();
      x.fillStyle = `hsla(${hue},50%,26%,0.55)`;
      x.beginPath();
      x.arc(-p.r * 0.25, p.r * 0.12, p.r * 0.3, 0, TAU);
      x.fill();
      // mouth
      const open = 0.25 + p.mouth * 0.5 + (mu.gape || 0) * 0.12;
      x.fillStyle = '#16303a';
      x.beginPath();
      x.moveTo(p.r * 0.55, 0);
      x.arc(p.r * 0.55, 0, p.r * 0.5, -open, open);
      x.fill();
      // eyes
      const eyes = mu.eye ? [-0.5, 0, 0.5] : [-0.42, 0.42];
      for (const ey of eyes) {
        const er = p.r * (ey === 0 ? 0.15 : 0.2);
        const exx = p.r * (ey === 0 ? 0.05 : 0.28);
        x.fillStyle = '#f6fffc';
        x.beginPath();
        x.arc(exx, ey * p.r, er, 0, TAU);
        x.fill();
        x.fillStyle = '#0d1c22';
        x.beginPath();
        x.arc(exx + er * 0.35, ey * p.r, er * 0.5, 0, TAU);
        x.fill();
      }
      x.restore();
    }

    for (const o of this.pops) {
      const k = o.t / 0.5;
      x.strokeStyle = o.c;
      x.globalAlpha = 1 - k;
      x.lineWidth = 2.5;
      x.beginPath();
      x.arc(o.x, o.y, 6 + k * 26, 0, TAU);
      x.stroke();
    }
    x.globalAlpha = 1;

    // vignette
    x.setTransform(dpr, 0, 0, dpr, 0, 0);
    const vg = x.createRadialGradient(w / 2, h / 2, Math.min(w, h) * 0.3, w / 2, h / 2, Math.max(w, h) * 0.75);
    vg.addColorStop(0, 'rgba(0,10,16,0)');
    vg.addColorStop(1, 'rgba(0,10,16,0.55)');
    x.fillStyle = vg;
    x.fillRect(0, 0, w, h);
  }

  dispose() {
    for (const off of this._off) off();
    clearTimeout(this.hintT);
    this.ui.remove();
    document.querySelectorAll('.modal').forEach((m) => m.remove());
    this.x.setTransform(1, 0, 0, 1, 0, 0);
    this.x.clearRect(0, 0, this.cv.width, this.cv.height);
  }
}
