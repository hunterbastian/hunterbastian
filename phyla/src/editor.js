// The creature editor: bend the spine, hang parts on it, paint it, and watch
// it stand up and walk while you work.

import * as THREE from './three.js';
import { Creature } from './creature.js';
import { PARTS, PART_LIST, CATEGORIES } from './parts.js';
import { computeStats, genomeCost, encodeGenome, decodeGenome, randomGenome, randomSkin, isMirrored, MAX_NODES, MIN_NODES, NODE_COST, FREE_NODES } from './genome.js';
import { PATTERNS } from './skin.js';
import { partThumb } from './thumbs.js';
import { el, esc, icon, pips, toast, modal, SOCIAL, FIERCE, DIET } from './ui.js';
import { clamp, damp, makeRng } from './util.js';

const SWATCHES = ['#7fb069', '#4f8a5b', '#35654d', '#c9a06c', '#d98e4a', '#c2603f', '#a8475a', '#7a4f7c', '#5b6fb0', '#4fa3b8', '#3f6e73', '#8a8f98', '#ece3b8', '#f2f0e6', '#2f3a34', '#e3b23c'];
const TABS = [{ id: 'body', name: 'Body' }, ...CATEGORIES, { id: 'skin', name: 'Skin' }];

const _ray = new THREE.Raycaster();
const _ndc = new THREE.Vector2();
const _plane = new THREE.Plane();
const _v = new THREE.Vector3();
const _v2 = new THREE.Vector3();

function handleTexture() {
  const c = document.createElement('canvas');
  c.width = c.height = 64;
  const x = c.getContext('2d');
  x.beginPath();
  x.arc(32, 32, 22, 0, Math.PI * 2);
  x.fillStyle = '#fffdf6';
  x.fill();
  x.lineWidth = 7;
  x.strokeStyle = '#26241f';
  x.stroke();
  return new THREE.CanvasTexture(c);
}

export class Editor {
  // o: { genome, budget, unlocked:Set|null, sandbox, title, doneLabel, onDone(genome), onBack }
  constructor(app, o) {
    this.app = app;
    this.o = o;
    this.genome = o.genome;
    this.budget = o.budget;
    this.sandbox = !!o.sandbox;
    this.unlocked = o.unlocked || null;
    this.tab = 'body';
    this.sel = null;
    this.drag = null;
    this.pointers = new Map();
    this.preview = 'stand';
    this.cam = { yaw: 0.75, pitch: 0.2, dist: 6.4, ty: 0.6, tyaw: 0.75, tpitch: 0.2, tdist: 6.4 };

    this._buildScene();
    this._buildUI();
    this._bind();
    this.refresh(true);
  }

  /* -------------------------------- scene ------------------------------- */

  _buildScene() {
    const scene = (this.scene = new THREE.Scene());
    const bg = document.createElement('canvas');
    bg.width = 4;
    bg.height = 256;
    const bx = bg.getContext('2d');
    const gr = bx.createLinearGradient(0, 0, 0, 256);
    gr.addColorStop(0, '#cfe2e6');
    gr.addColorStop(0.55, '#ebe6d6');
    gr.addColorStop(1, '#e2d6bb');
    bx.fillStyle = gr;
    bx.fillRect(0, 0, 4, 256);
    const bt = new THREE.CanvasTexture(bg);
    bt.colorSpace = THREE.SRGBColorSpace;
    scene.background = bt;
    this.bgTex = bt;

    scene.add(new THREE.HemisphereLight('#fffaf0', '#8c8468', 1.25));
    const sun = new THREE.DirectionalLight('#fff0d2', 2.3);
    sun.position.set(4, 8, 5);
    sun.castShadow = true;
    sun.shadow.mapSize.set(1024, 1024);
    Object.assign(sun.shadow.camera, { left: -4, right: 4, top: 4, bottom: -4, near: 1, far: 24 });
    sun.shadow.bias = -0.0006;
    sun.shadow.normalBias = 0.03;
    scene.add(sun);

    // a lifted round of turf to stand on
    const stand = new THREE.Group();
    const soil = new THREE.Mesh(new THREE.CylinderGeometry(2.1, 1.7, 0.7, 44), new THREE.MeshStandardMaterial({ color: '#6c573f', roughness: 1 }));
    soil.position.y = -0.35;
    const turf = new THREE.Mesh(new THREE.CircleGeometry(2.1, 44).rotateX(-Math.PI / 2), new THREE.MeshStandardMaterial({ color: '#93b866', roughness: 1 }));
    turf.position.y = 0.002;
    turf.receiveShadow = true;
    stand.add(soil, turf);
    const rnd = makeRng(11);
    const blade = new THREE.ConeGeometry(0.018, 0.13, 3).translate(0, 0.065, 0);
    const tufts = new THREE.InstancedMesh(blade, new THREE.MeshStandardMaterial({ color: '#7da654', roughness: 1 }), 150);
    const m = new THREE.Matrix4();
    const q = new THREE.Quaternion();
    const e = new THREE.Euler();
    for (let i = 0; i < 150; i++) {
      const a = rnd() * Math.PI * 2;
      const r = 0.9 + Math.sqrt(rnd()) * 1.15;
      e.set(rnd.range(-0.3, 0.3), rnd() * 6, rnd.range(-0.3, 0.3));
      m.compose(_v.set(Math.cos(a) * r, 0, Math.sin(a) * r), q.setFromEuler(e), _v2.setScalar(rnd.range(0.6, 1.5)));
      tufts.setMatrixAt(i, m);
    }
    stand.add(tufts);
    const peb = new THREE.InstancedMesh(new THREE.DodecahedronGeometry(0.09), new THREE.MeshStandardMaterial({ color: '#a39a86', roughness: 1, flatShading: true }), 9);
    for (let i = 0; i < 9; i++) {
      const a = rnd() * Math.PI * 2;
      const r = 1.5 + rnd() * 0.5;
      e.set(rnd() * 3, rnd() * 3, 0);
      m.compose(_v.set(Math.cos(a) * r, 0.03, Math.sin(a) * r), q.setFromEuler(e), _v2.set(rnd.range(0.7, 1.6), rnd.range(0.5, 0.9), rnd.range(0.7, 1.5)));
      peb.setMatrixAt(i, m);
    }
    stand.add(peb);
    scene.add(stand);
    this.stand = stand;

    this.camera = new THREE.PerspectiveCamera(34, 1, 0.1, 80);

    this.creature = new Creature(this.genome, { seed: 7 });
    this.creature.treadmill = true;
    scene.add(this.creature.root);

    // spine handles
    this.handleTex = handleTexture();
    this.handles = [];
    this.handleGroup = new THREE.Group();
    scene.add(this.handleGroup);
    this.spineLine = new THREE.Line(new THREE.BufferGeometry(), new THREE.LineBasicMaterial({ color: 0x26241f, transparent: true, opacity: 0.55, depthTest: false }));
    this.spineLine.renderOrder = 9;
    this.spineLine.frustumCulled = false;
    this.handleGroup.add(this.spineLine);

    // selection ring
    const ring = new THREE.Mesh(new THREE.RingGeometry(0.86, 1, 40), new THREE.MeshBasicMaterial({ color: 0xc2603f, depthTest: false, transparent: true, opacity: 0.95, side: THREE.DoubleSide }));
    ring.renderOrder = 11;
    ring.visible = false;
    scene.add(ring);
    this.ring = ring;
    this.ring2 = ring.clone();
    scene.add(this.ring2);
  }

  _syncHandles() {
    const n = this.genome.spine.length;
    while (this.handles.length > n) this.handleGroup.remove(this.handles.pop());
    while (this.handles.length < n) {
      const s = new THREE.Sprite(new THREE.SpriteMaterial({ map: this.handleTex, depthTest: false }));
      s.renderOrder = 10;
      s.userData.node = this.handles.length;
      this.handles.push(s);
      this.handleGroup.add(s);
    }
    this.spineLine.geometry.dispose();
    this.spineLine.geometry = new THREE.BufferGeometry().setAttribute('position', new THREE.BufferAttribute(new Float32Array(n * 3), 3));
  }

  /* ---------------------------------- UI -------------------------------- */

  _buildUI() {
    const o = this.o;
    const root = (this.ui = el(`
      <div class="editor">
        <header class="ed-top">
          <button class="iconbtn" data-back title="Back" aria-label="Back">${icon('close')}</button>
          <div class="ed-title">
            <span class="eyebrow">${esc(o.title || 'Workshop')}</span>
            <input class="ed-name" data-name maxlength="24" spellcheck="false" aria-label="Creature name" value="${esc(this.genome.name || '')}" />
          </div>
          <div class="ed-budget" data-budget title="Helix: what your lineage has earned to spend on change"></div>
          <button class="btn btn--ghost ed-statsbtn" data-statsbtn>Notes</button>
          <button class="btn btn--primary" data-done>${esc(o.doneLabel || 'Hatch')}</button>
        </header>
        <aside class="ed-palette">
          <nav class="tabs" data-tabs>${TABS.map((t) => `<button data-tab="${t.id}">${t.name}</button>`).join('')}</nav>
          <div class="ed-cards" data-cards></div>
          <p class="ed-blurb" data-blurb></p>
        </aside>
        <aside class="ed-stats" data-stats></aside>
        <div class="ed-bottom">
          <div class="ed-sel" data-sel hidden></div>
          <div class="chips" data-preview></div>
        </div>
      </div>`));
    this.app.ui.appendChild(root);
    this.$ = (s) => root.querySelector(s);
  }

  _renderTab() {
    const cards = this.$('[data-cards]');
    this.ui.querySelectorAll('[data-tab]').forEach((b) => b.classList.toggle('on', b.dataset.tab === this.tab));
    this.$('[data-blurb]').textContent = '';
    if (this.tab === 'body') {
      const n = this.genome.spine.length;
      cards.className = 'ed-cards ed-cards--form';
      cards.innerHTML = `
        <p class="hint">Drag the beads to bend the spine. Tap a bead, then change its girth.</p>
        <label class="field"><span>Girth</span><input type="range" data-girth min="0.05" max="0.62" step="0.005" /></label>
        <div class="row">
          <button class="btn btn--small" data-addhead ${n >= MAX_NODES ? 'disabled' : ''}>${icon('plus', 14)} Neck</button>
          <button class="btn btn--small" data-addtail ${n >= MAX_NODES ? 'disabled' : ''}>${icon('plus', 14)} Tail</button>
          <button class="btn btn--small" data-delnode ${n <= MIN_NODES ? 'disabled' : ''}>${icon('minus', 14)} Bead</button>
        </div>
        <p class="hint hint--small">${n} segments. The first ${FREE_NODES} are free, each one after costs ${NODE_COST} helix.</p>
        <div class="row">
          <button class="btn btn--small btn--ghost" data-copy>Copy creature code</button>
          ${this.sandbox ? '<button class="btn btn--small btn--ghost" data-paste>Paste code</button>' : ''}
        </div>
        ${this.sandbox ? '<div class="row"><button class="btn btn--small" data-roll>Roll a stranger</button></div>' : ''}`;
      this._syncGirth();
      return;
    }
    if (this.tab === 'skin') {
      const sk = this.genome.skin;
      const row = (key, label) => `
        <div class="swrow"><span>${label}</span><div class="swatches" data-color="${key}">
          ${SWATCHES.map((c) => `<button style="background:${c}" data-sw="${c}" class="${sk[key] === c ? 'on' : ''}" aria-label="${c}"></button>`).join('')}
          <label class="swcustom" title="Custom colour"><input type="color" value="${sk[key]}" data-custom="${key}" /></label>
        </div></div>`;
      cards.className = 'ed-cards ed-cards--form';
      cards.innerHTML = `
        ${row('base', 'Hide')}${row('accent', 'Markings')}${row('belly', 'Belly')}
        <div class="swrow"><span>Pattern</span><div class="row row--wrap" data-patterns>
          ${PATTERNS.map((p) => `<button class="btn btn--small ${sk.pattern === p ? 'on' : ''}" data-pattern="${p}">${p}</button>`).join('')}
        </div></div>
        <div class="row"><button class="btn btn--small" data-shuffle>Shuffle</button></div>`;
      return;
    }
    cards.className = 'ed-cards';
    const list = PART_LIST.filter((d) => d.cat === this.tab);
    cards.innerHTML = list
      .map((d) => {
        const locked = this.unlocked && !this.unlocked.has(d.id);
        const st = Object.entries(d.stats || {}).filter(([, v]) => v > 0);
        const chips = st.map(([k, v]) => `<span class="statchip">${k} ${v}</span>`).join('');
        return `<button class="card ${locked ? 'locked' : ''}" data-part="${d.id}" ${locked ? 'aria-disabled="true"' : ''}>
          <img src="${partThumb(d)}" alt="" draggable="false" />
          <span class="card__name">${locked ? 'Undiscovered' : esc(d.name)}</span>
          <span class="card__meta">${locked ? 'Out there somewhere' : `${icon('helix', 12)} ${d.cost}${d.diet ? ' · ' + DIET[d.diet].name.toLowerCase() : ''}`}</span>
          ${locked ? '' : `<span class="card__chips">${chips}</span>`}
        </button>`;
      })
      .join('');
  }

  _renderStats() {
    const st = computeStats(this.genome);
    const cost = genomeCost(this.genome);
    const diet = DIET[st.diet];
    const row = (list) => list.map((a) => `<div class="statrow"><span style="color:${a.color}">${icon(a.id, 16)}</span><span>${a.name}</span>${pips(st[a.id], a.color)}</div>`).join('');
    const extra = [['armor', 'Armor', st.armor], ['sight', 'Sight', st.sight], ['sense', 'Scent', st.sense], ['jump', 'Leap', st.jump], ['glide', 'Glide', st.glide]]
      .filter((x) => x[2] > 0)
      .map((x) => `<span class="statchip">${icon(x[0], 12)} ${x[1]} ${x[2]}</span>`)
      .join('');
    this.$('[data-stats]').innerHTML = `
      <h3 class="eyebrow">Field notes</h3>
      <div class="diet diet--${st.diet}">${icon(diet.icon, 18)}<div><b>${diet.name}</b><small>${diet.note}</small></div></div>
      <div class="vitals"><span>${icon('heart', 14)} ${st.health}</span><span>${icon('speed', 14)} ${st.moveSpeed.toFixed(1)} m/s</span></div>
      <h4>Among friends</h4>${row(SOCIAL)}
      <h4>In a fight</h4>${row(FIERCE)}
      ${extra ? `<div class="card__chips">${extra}</div>` : ''}`;
    const over = cost > this.budget;
    this.$('[data-budget]').innerHTML = `${icon('helix', 16)} <b class="${over ? 'over' : ''}">${cost}</b>${isFinite(this.budget) ? `<span>/ ${this.budget}</span>` : '<span>free build</span>'}`;
    this.$('[data-done]').disabled = over;

    const chips = [{ id: 'stand', name: 'Stand' }, { id: 'walk', name: 'Walk' }, { id: 'run', name: 'Run' }];
    const acts = [...SOCIAL.filter((a) => st[a.id] > 0), ...FIERCE.filter((a) => st[a.id] > 0)];
    this.$('[data-preview]').innerHTML =
      chips.map((c) => `<button class="chip ${this.preview === c.id ? 'on' : ''}" data-gait="${c.id}">${c.name}</button>`).join('') +
      '<span class="chips__sep"></span>' +
      acts.map((a) => `<button class="chip" data-act="${a.id}" style="--c:${a.color}">${icon(a.id, 14)} ${a.name}</button>`).join('');
    this.stats = st;
  }

  _renderSel() {
    const box = this.$('[data-sel]');
    if (!this.sel || this.sel.type !== 'part') {
      box.hidden = true;
      return;
    }
    const g = this.sel.g;
    const d = PARTS[g.id];
    box.hidden = false;
    box.innerHTML = `
      <img src="${partThumb(d)}" alt="" />
      <div class="ed-sel__name"><b>${esc(d.name)}</b><small>${isMirrored(g.a) ? 'mirrored pair' : 'on the midline'}</small></div>
      <label class="field field--inline"><span>Size</span><input type="range" data-size min="0.5" max="2" step="0.01" value="${g.s || 1}" /></label>
      <button class="iconbtn iconbtn--danger" data-remove title="Remove (Delete)" aria-label="Remove part">${icon('trash')}</button>`;
  }

  _syncGirth() {
    const inp = this.$('[data-girth]');
    if (!inp) return;
    const has = this.sel && this.sel.type === 'node';
    inp.disabled = !has;
    if (has) inp.value = this.genome.spine[this.sel.i].r;
  }

  // Full refresh after a structural change.
  refresh(rebuild) {
    if (rebuild) {
      this.creature.build();
      this._syncHandles();
    } else this.creature.restDirty = true;
    this._renderTab();
    this._renderStats();
    this._renderSel();
  }

  /* ------------------------------- editing ------------------------------ */

  _spot(def) {
    const n = this.genome.spine.length;
    const parts = this.genome.parts;
    const taken = (u, a, tol = 0.3) => parts.some((p) => Math.abs(p.u - u) < tol && Math.abs(p.a - a) < 0.4);
    const first = (cands) => cands.find((c) => !taken(c[0], c[1])) || [cands[0][0] + (Math.random() - 0.5) * 0.6, cands[0][1]];
    const L = n - 1;
    switch (def.cat) {
      case 'mouth': return first([[n - 0.18, Math.PI], [n - 0.55, Math.PI], [n - 0.5, 1.6]]);
      case 'eye': return first([[n - 0.64, 0.78], [n - 0.45, 0.4], [n - 0.8, 1.3], [n - 0.4, 0]]);
      case 'leg': return first([[L * 0.3, 2.3], [L * 0.72, 2.3], [L * 0.5, 2.3], [L * 0.12, 2.3], [L * 0.9, 2.3]]);
      case 'arm': return first([[L * 0.8, 1.7], [L * 0.6, 1.7], [L * 0.4, 1.7]]);
      default: break;
    }
    switch (def.id) {
      case 'nubhorn':
      case 'longhorn': return first([[n - 0.9, 0.5], [n - 0.7, 0], [n - 1.1, 0.9]]);
      case 'lantern': return first([[n - 0.95, 0], [L * 0.5, 0]]);
      case 'tailfan': return first([[-0.86, 0], [0.3, 0]]);
      case 'tuft': return first([[n - 0.95, 0], [-0.8, 0], [L * 0.5, 0]]);
      case 'whisker': return first([[n - 0.42, Math.PI], [n - 0.6, 0]]);
      case 'glowspot': return first([[L * 0.5, 1.1], [L * 0.3, 1.1], [L * 0.7, 1.1], [L * 0.5, 0]]);
      case 'wingfin': return first([[L * 0.62, 1.15], [L * 0.4, 1.15]]);
      case 'crest': return first([[n - 1.05, 0], [L * 0.5, 0]]);
      default: return first([[L * 0.5, 0], [L * 0.3, 0], [L * 0.7, 0], [L * 0.15, 0], [L * 0.85, 0]]);
    }
  }

  addPart(id) {
    const def = PARTS[id];
    if (!def) return;
    if (this.unlocked && !this.unlocked.has(id)) {
      toast('Not discovered yet. Meet more of the world.', 'warn');
      return;
    }
    if (genomeCost(this.genome) + def.cost > this.budget) {
      toast(`Not enough helix for ${def.name}.`, 'warn');
      this.$('[data-budget]').classList.remove('shake');
      void this.$('[data-budget]').offsetWidth;
      this.$('[data-budget]').classList.add('shake');
      return;
    }
    if (this.genome.parts.length >= 36) {
      toast('That is a lot of creature. Remove something first.', 'warn');
      return;
    }
    const [u, a] = this._spot(def);
    const g = { id, u, a, s: 1 };
    this.genome.parts.push(g);
    this.sel = { type: 'part', g };
    this.app.audio.blip('place');
    this.refresh(true);
  }

  removeSelected() {
    if (!this.sel || this.sel.type !== 'part') return;
    const i = this.genome.parts.indexOf(this.sel.g);
    if (i >= 0) this.genome.parts.splice(i, 1);
    this.sel = null;
    this.app.audio.blip('remove');
    this.refresh(true);
  }

  _addNode(atHead) {
    const sp = this.genome.spine;
    const n = sp.length;
    if (n >= MAX_NODES) return;
    if (atHead) {
      const a = sp[n - 2];
      const b = sp[n - 1];
      const d = Math.hypot(b.y - a.y, b.z - a.z) || 1;
      for (const p of this.genome.parts) if (p.u > n - 1) p.u += 1;
      sp.push({ y: b.y + ((b.y - a.y) / d) * 0.28, z: b.z + ((b.z - a.z) / d) * 0.28, r: b.r });
      b.r *= 0.85;
      this.sel = { type: 'node', i: n };
    } else {
      const a = sp[0];
      const b = sp[1];
      const d = Math.hypot(b.y - a.y, b.z - a.z) || 1;
      for (const p of this.genome.parts) if (p.u >= 0) p.u += 1;
      sp.unshift({ y: a.y - ((b.y - a.y) / d) * 0.28, z: a.z - ((b.z - a.z) / d) * 0.28, r: a.r * 0.7 });
      this.sel = { type: 'node', i: 0 };
    }
    this._settle();
    this.refresh(true);
    this.fit(true);
  }

  _delNode() {
    const sp = this.genome.spine;
    if (sp.length <= MIN_NODES) return;
    const i = this.sel && this.sel.type === 'node' ? this.sel.i : sp.length - 1;
    sp.splice(i, 1);
    for (const p of this.genome.parts) {
      if (p.u > i) p.u -= 1;
      p.u = clamp(p.u, -1, sp.length);
    }
    this.sel = null;
    this._settle();
    this.refresh(true);
  }

  // Keep the spine centred and its numbers tidy after an edit.
  _settle() {
    const sp = this.genome.spine;
    const zMid = (Math.min(...sp.map((p) => p.z)) + Math.max(...sp.map((p) => p.z))) / 2;
    const yMin = Math.min(...sp.map((p) => p.y - p.r));
    for (const p of sp) {
      p.z -= zMid;
      p.y -= yMin;
    }
  }

  /* -------------------------------- input ------------------------------- */

  _bind() {
    const cv = this.app.canvas;
    const ui = this.ui;
    this._on = [];
    const on = (t, ev, fn, opt) => {
      t.addEventListener(ev, fn, opt);
      this._on.push(() => t.removeEventListener(ev, fn, opt));
    };
    on(cv, 'pointerdown', (e) => this._down(e));
    on(cv, 'pointermove', (e) => this._move(e));
    on(cv, 'pointerup', (e) => this._up(e));
    on(cv, 'pointercancel', (e) => this._up(e));
    on(cv, 'wheel', (e) => {
      e.preventDefault();
      this.cam.tdist = clamp(this.cam.tdist * (1 + Math.sign(e.deltaY) * 0.1), 2.2, 14);
    }, { passive: false });
    on(window, 'keydown', (e) => {
      if (/INPUT|TEXTAREA/.test(e.target.tagName)) return;
      if (e.key === 'Delete' || e.key === 'Backspace') this.removeSelected();
      if (e.key === 'Escape') {
        this.sel = null;
        this._renderSel();
        this._syncGirth();
      }
    });

    on(ui, 'click', (e) => {
      const b = e.target.closest('button');
      if (!b) return;
      const d = b.dataset;
      const audio = this.app.audio;
      if (d.tab) {
        this.tab = d.tab;
        if (this.tab !== 'body' && this.sel && this.sel.type === 'node') this.sel = null;
        audio.blip('tick');
        this._renderTab();
      } else if (d.part) this.addPart(d.part);
      else if ('addhead' in d) this._addNode(true);
      else if ('addtail' in d) this._addNode(false);
      else if ('delnode' in d) this._delNode();
      else if ('remove' in d) this.removeSelected();
      else if (d.gait) {
        this.preview = d.gait;
        this._renderStats();
      } else if (d.act) {
        this.creature.play(d.act);
        audio.voiceFor(this.creature.stats, d.act);
      } else if (d.sw) this._setColor(b.parentElement.dataset.color, d.sw);
      else if (d.pattern) {
        this.genome.skin.pattern = d.pattern;
        this._repaint();
      } else if ('shuffle' in d) {
        Object.assign(this.genome.skin, randomSkin(makeRng((Math.random() * 1e9) | 0)));
        this._repaint();
      } else if ('copy' in d) this._copy();
      else if ('paste' in d) this._paste();
      else if ('roll' in d) {
        const g = randomGenome((Math.random() * 1e9) | 0);
        this._replace(g);
      } else if ('done' in d) this._done();
      else if ('back' in d) this.o.onBack && this.o.onBack();
      else if ('statsbtn' in d) this.ui.classList.toggle('show-stats');
    });
    on(ui, 'input', (e) => {
      const t = e.target;
      if ('girth' in t.dataset && this.sel && this.sel.type === 'node') {
        this.genome.spine[this.sel.i].r = +t.value;
        this.creature.restDirty = true;
        this._renderStats();
      } else if ('size' in t.dataset && this.sel && this.sel.type === 'part') {
        this.sel.g.s = +t.value;
        this.creature.restDirty = true;
      } else if (t.dataset.custom) this._setColor(t.dataset.custom, t.value);
      else if ('name' in t.dataset) this.genome.name = t.value.slice(0, 24);
    });
    on(ui, 'pointerover', (e) => {
      const c = e.target.closest('[data-part]');
      if (!c) return;
      const d = PARTS[c.dataset.part];
      const locked = this.unlocked && !this.unlocked.has(d.id);
      this.$('[data-blurb]').textContent = locked ? 'Befriend or best other species, and dig up old bones, to discover new parts.' : `${d.name}. ${d.blurb}`;
    });
  }

  _setColor(key, hex) {
    this.genome.skin[key] = hex;
    this._repaint();
  }

  _repaint() {
    this.creature.kit.repaint(this.genome.skin);
    this.creature.build();
    this._syncHandles();
    this._renderTab();
  }

  _replace(g) {
    this.genome.spine = g.spine;
    this.genome.parts = g.parts;
    this.genome.skin = g.skin;
    this.genome.name = g.name;
    this.$('[data-name]').value = g.name;
    this.sel = null;
    this.creature.kit.repaint(this.genome.skin);
    this.refresh(true);
    this.fit();
  }

  _copy() {
    const code = encodeGenome(this.genome);
    const show = () => this._codeDialog('Copy this creature code', code, false);
    if (navigator.clipboard && navigator.clipboard.writeText) navigator.clipboard.writeText(code).then(() => toast('Creature code copied. Share it with anyone.'), show);
    else show();
  }

  _paste() {
    this._codeDialog('Paste a creature code', '', true);
  }

  // In-page dialog for creature codes (system prompts are not always allowed).
  _codeDialog(title, value, editable) {
    const m = modal(
      `<h2>${title}</h2>
       <textarea class="codebox" id="creature-code" spellcheck="false" autocapitalize="off" ${editable ? 'placeholder="phyla1…"' : 'readonly'}>${esc(value)}</textarea>
       <div class="row row--end">${editable ? '<button class="btn" data-close>Cancel</button><button class="btn btn--primary" data-ok>Hatch it</button>' : '<button class="btn btn--primary" data-close>Done</button>'}</div>`,
    );
    const ta = m.root.querySelector('textarea');
    ta.focus();
    if (!editable) ta.select();
    const ok = m.root.querySelector('[data-ok]');
    if (ok) {
      ok.addEventListener('click', () => {
        const g = decodeGenome(ta.value);
        if (!g) toast('That code did not hatch into anything.', 'warn');
        else {
          m.close();
          this._replace(g);
        }
      });
    }
  }

  _done() {
    const st = computeStats(this.genome);
    if (!st.mouths) {
      toast('It needs a mouth, or it will never eat.', 'warn');
      this.tab = 'mouth';
      this._renderTab();
      return;
    }
    if (genomeCost(this.genome) > this.budget) return;
    if (!this.genome.name.trim()) this.genome.name = 'Unnamed';
    this._settle();
    this.o.onDone(this.genome);
  }

  _setRay(e) {
    const r = this.app.canvas.getBoundingClientRect();
    _ndc.set(((e.clientX - r.left) / r.width) * 2 - 1, -((e.clientY - r.top) / r.height) * 2 + 1);
    _ray.setFromCamera(_ndc, this.camera);
  }

  _pickPart() {
    const c = this.creature;
    const objs = [...c.surf.map((s) => s.obj), ...c.limbs.map((l) => l.end)];
    const hits = _ray.intersectObjects(objs, true);
    const bodyHit = _ray.intersectObject(c.mesh, false)[0];
    let best = null;
    let bestD = Infinity;
    for (const h of hits) {
      if (h.object.isSprite) continue;
      let o = h.object;
      while (o && !o.userData.part) o = o.parent;
      if (o) {
        best = o.userData.part;
        bestD = h.distance;
        break;
      }
    }
    if (bodyHit && bodyHit.distance < bestD - 0.02) {
      const info = c.hitInfo(bodyHit);
      if (info.limb) return { g: info.limb.g };
      return best && bodyHit.distance > bestD - 0.12 ? { g: best } : { body: true };
    }
    return best ? { g: best } : null;
  }

  _down(e) {
    this.app.canvas.setPointerCapture(e.pointerId);
    this.pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
    if (this.pointers.size === 2) {
      const [a, b] = [...this.pointers.values()];
      this.pinch = Math.hypot(a.x - b.x, a.y - b.y);
      this.drag = null;
      return;
    }
    this._setRay(e);
    this.moved = 0;
    this.drag = { type: 'orbit', x: e.clientX, y: e.clientY };
    if (this.tab === 'body') {
      const hit = _ray.intersectObjects(this.handles, false)[0];
      if (hit) {
        const i = hit.object.userData.node;
        this.sel = { type: 'node', i };
        const ex = this.creature.ex[i + 1];
        const inv = this.creature.M.clone().invert();
        this.camera.getWorldDirection(_v);
        _plane.setFromNormalAndCoplanarPoint(_v, _v2.set(ex.x, ex.y, ex.z));
        _ray.ray.intersectPlane(_plane, _v);
        const start = _v.clone().setX(0).applyMatrix4(inv);
        this.drag = { type: 'node', i, inv, start, y0: this.genome.spine[i].y, z0: this.genome.spine[i].z, plane: _plane.clone() };
        this._syncGirth();
        this._renderSel();
        return;
      }
    }
    const pick = this._pickPart();
    if (pick && pick.g) {
      this.sel = { type: 'part', g: pick.g };
      this.drag = { type: 'part', g: pick.g };
      this._renderSel();
    }
  }

  _move(e) {
    const p = this.pointers.get(e.pointerId);
    if (!p) return;
    const dx = e.clientX - p.x;
    const dy = e.clientY - p.y;
    p.x = e.clientX;
    p.y = e.clientY;
    this.moved += Math.abs(dx) + Math.abs(dy);
    if (this.pointers.size === 2) {
      const [a, b] = [...this.pointers.values()];
      const d = Math.hypot(a.x - b.x, a.y - b.y);
      if (this.pinch) this.cam.tdist = clamp(this.cam.tdist * (this.pinch / d), 2.2, 12);
      this.pinch = d;
      return;
    }
    const drag = this.drag;
    if (!drag) return;
    if (drag.type === 'orbit') {
      this.cam.tyaw -= dx * 0.008;
      this.cam.tpitch = clamp(this.cam.tpitch + dy * 0.006, -0.25, 1.2);
      return;
    }
    this._setRay(e);
    if (drag.type === 'node') {
      if (!_ray.ray.intersectPlane(drag.plane, _v)) return;
      _v.setX(0).applyMatrix4(drag.inv);
      const sp = this.genome.spine;
      const nd = sp[drag.i];
      let y = drag.y0 + (_v.y - drag.start.y);
      let z = drag.z0 + (_v.z - drag.start.z);
      for (let pass = 0; pass < 2; pass++) {
        for (const j of [drag.i - 1, drag.i + 1]) {
          const o = sp[j];
          if (!o) continue;
          const ddy = y - o.y;
          const ddz = z - o.z;
          const d = Math.hypot(ddy, ddz) || 1e-4;
          const want = clamp(d, 0.16, 0.72);
          y = o.y + (ddy / d) * want;
          z = o.z + (ddz / d) * want;
        }
      }
      nd.y = clamp(y, -1.5, 4);
      nd.z = clamp(z, -4, 4);
      this.creature.restDirty = true;
    } else if (drag.type === 'part') {
      if (this.moved < 6) return;
      const hits = _ray.intersectObject(this.creature.mesh, false);
      for (const h of hits) {
        const info = this.creature.hitInfo(h);
        if (info.limb) continue;
        let a = Math.abs(info.a);
        if (a < 0.16) a = 0;
        if (a > Math.PI - 0.16) a = Math.PI;
        const was = isMirrored(drag.g.a);
        drag.g.u = clamp(info.u, -1, this.genome.spine.length);
        drag.g.a = a;
        if (was !== isMirrored(a)) {
          this.creature.build();
          this._renderSel();
        } else this.creature.restDirty = true;
        break;
      }
    }
  }

  _up(e) {
    this.pointers.delete(e.pointerId);
    this.pinch = 0;
    const drag = this.drag;
    this.drag = null;
    if (!drag) return;
    if (drag.type === 'node') {
      this._settle();
      this.creature._computeStance();
      this.fit(true);
      this._renderStats();
    } else if (drag.type === 'part') this._renderStats();
    else if (drag.type === 'orbit' && this.moved < 5 && this.sel) {
      this.sel = null;
      this._renderSel();
      this._syncGirth();
    }
  }

  /* ------------------------------- frame -------------------------------- */

  resize(w, h) {
    this.w = w;
    this.h = h;
    this.camera.aspect = w / h;
    // keep the creature centred in the space the panels leave free
    const narrow = w < 760;
    if (narrow) this.camera.setViewOffset(w, h, 0, h * 0.17, w, h);
    else this.camera.setViewOffset(w, h, -(w > 1100 ? 40 : 110), 10, w, h);
    this.camera.updateProjectionMatrix();
    if (!this.fitted) this.fit();
  }

  // Pull the camera back far enough to see the whole creature. With
  // growOnly it never zooms in, so it does not fight the player's own zoom.
  fit(growOnly) {
    const c = this.creature;
    const narrow = this.w < 760;
    const t = Math.tan((this.camera.fov * Math.PI) / 360);
    const tall = (c.height + 0.5) / (2 * t * (narrow ? 0.4 : 0.56));
    const wide = (c.halfLen * 2 + 0.9) / (2 * t * (this.w / this.h) * (narrow ? 0.8 : 0.42));
    const need = clamp(Math.max(tall, wide, 4.6), 3, 14);
    this.cam.tdist = growOnly ? Math.max(this.cam.tdist, Math.min(need, 14)) : need;
    this.fitted = true;
  }

  update(dt) {
    const c = this.creature;
    const cam = this.cam;
    const sp = c.stats.moveSpeed;
    const v = this.preview === 'walk' ? sp * 0.45 : this.preview === 'run' ? sp : 0;
    c.vel.set(0, 0, v);
    c.update(dt);

    cam.yaw = damp(cam.yaw, cam.tyaw, 12, dt);
    cam.pitch = damp(cam.pitch, cam.tpitch, 12, dt);
    cam.dist = damp(cam.dist, cam.tdist, 10, dt);
    cam.ty = damp(cam.ty, c.height * 0.52, 4, dt);
    const cp = Math.cos(cam.pitch);
    this.camera.position.set(Math.sin(cam.yaw) * cp * cam.dist, cam.ty + Math.sin(cam.pitch) * cam.dist, Math.cos(cam.yaw) * cp * cam.dist);
    this.camera.lookAt(0, cam.ty, 0);

    // handles follow the animated spine
    const showH = this.tab === 'body';
    this.handleGroup.visible = showH;
    if (showH) {
      const pos = this.spineLine.geometry.attributes.position;
      const size = clamp(cam.dist * (this.app.touch ? 0.038 : 0.032), 0.09, 0.34); // a little bigger for fingers
      for (let i = 0; i < this.handles.length; i++) {
        const e = c.ex[i + 1];
        const hd = this.handles[i];
        hd.position.set(e.x, e.y, e.z);
        const on = this.sel && this.sel.type === 'node' && this.sel.i === i;
        hd.scale.setScalar(on ? size * 1.45 : size);
        hd.material.color.set(on ? 0xf0a07a : 0xffffff);
        pos.setXYZ(i, e.x, e.y, e.z);
      }
      pos.needsUpdate = true;
    }

    // selection rings
    const ring = this.ring;
    const ring2 = this.ring2;
    ring.visible = ring2.visible = false;
    if (this.sel && this.sel.type === 'part') {
      const g = this.sel.g;
      const objs = [];
      for (const s of c.surf) if (s.g === g) objs.push(s.obj);
      for (const l of c.limbs) if (l.g === g) objs.push(l.end);
      const pulse = 1 + Math.sin(performance.now() * 0.006) * 0.06;
      [ring, ring2].forEach((r, k) => {
        const o = objs[k];
        if (!o) return;
        r.visible = true;
        r.position.copy(o.position);
        r.quaternion.copy(this.camera.quaternion);
        r.scale.setScalar(clamp(0.2 * (g.s || 1), 0.14, 0.42) * pulse);
      });
    }
    this.app.renderer.render(this.scene, this.camera);
  }

  dispose() {
    for (const off of this._on) off();
    this.ui.remove();
    this.creature.dispose();
    this.bgTex.dispose();
    this.handleTex.dispose();
    this.scene.traverse((o) => {
      if (o.geometry) o.geometry.dispose();
      if (o.material && o.material.dispose) o.material.dispose();
    });
  }
}
