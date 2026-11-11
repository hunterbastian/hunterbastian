// Phyla — entry point. Owns the renderer, the frame loop, saving, and the
// hand-offs between the title, the tidepool, the editor and the world.

import * as THREE from './three.js';
import { AudioEngine } from './audio.js';
import { Title } from './title.js';
import { Editor } from './editor.js';
import { Game } from './game.js';
import { CellStage } from './cell.js';
import { starterGenome, genomeCost, cloneGenome } from './genome.js';
import { STARTER_PARTS } from './parts.js';
import { creatureThumb } from './thumbs.js';
import { modal, esc, isTouch } from './ui.js';

const SAVE_KEY = 'phyla-save-v1';

class App {
  constructor() {
    this.canvas = document.getElementById('gl');
    this.cellCanvas = document.getElementById('cell');
    this.ui = document.getElementById('ui');
    this.fadeEl = document.getElementById('fade');
    this.params = new URLSearchParams(location.search);
    this.audio = new AudioEngine();
    this.touch = isTouch();
    this.quality = this.params.get('q') || (this.touch ? 'medium' : 'high');
    this.mode = null;
    this.save = this._load();

    const r = (this.renderer = new THREE.WebGLRenderer({ canvas: this.canvas, antialias: this.quality !== 'low', powerPreference: 'high-performance' }));
    r.toneMapping = THREE.ACESFilmicToneMapping;
    r.toneMappingExposure = 1.05;
    r.shadowMap.enabled = this.quality !== 'low';
    r.shadowMap.type = THREE.PCFSoftShadowMap;

    const unlock = () => this.audio.unlock();
    window.addEventListener('pointerdown', unlock);
    window.addEventListener('keydown', unlock);
    window.addEventListener('resize', () => this.resize());
    if (window.visualViewport) window.visualViewport.addEventListener('resize', () => this.resize());
    document.addEventListener('contextmenu', (e) => {
      if (e.target === this.canvas) e.preventDefault();
    });
    // stop iOS from scrolling / zooming the page under the game
    document.addEventListener('gesturestart', (e) => e.preventDefault());

    this.last = performance.now();
    const loop = (t) => {
      requestAnimationFrame(loop);
      const dt = Math.min((t - this.last) / 1000, 0.05);
      this.last = t;
      if (document.hidden || !this.mode) return;
      this.mode.update(dt);
      this.audio.update(dt, this.mode.night || 0);
    };
    requestAnimationFrame(loop);

    const start = this.params.get('start');
    if (start === 'land') this.beginLand();
    else if (start === 'cell') this.beginCell();
    else if (start === 'workshop') this.workshop();
    else if (start === 'world') this.newGame(starterGenome('omni'), false, true);
    else this.title(true);
  }

  resize() {
    const w = window.innerWidth;
    const h = window.innerHeight;
    const cap = this.quality === 'high' ? 2 : this.quality === 'medium' ? 1.6 : 1;
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, cap));
    this.renderer.setSize(w, h, false);
    if (this.mode && this.mode.resize) this.mode.resize(w, h);
  }

  // Swap modes behind a short fade.
  go(make, instant) {
    const swap = () => {
      if (this.mode) this.mode.dispose();
      this.mode = null;
      this.mode = make();
      document.body.dataset.mode = this.mode.kind || '3d';
      this.resize();
      this.fadeEl.classList.remove('on');
    };
    if (instant) swap();
    else {
      this.fadeEl.classList.add('on');
      setTimeout(swap, 380);
    }
  }

  /* -------------------------------- saving ------------------------------- */

  _load() {
    try {
      const s = JSON.parse(localStorage.getItem(SAVE_KEY) || 'null');
      return s && s.v === 1 && s.genome ? s : null;
    } catch {
      return null;
    }
  }

  persist() {
    if (!this.save || this.save.sandbox) return;
    try {
      localStorage.setItem(SAVE_KEY, JSON.stringify(this.save));
    } catch {
      /* private mode or full: keep playing without a save */
    }
  }

  /* --------------------------------- flows -------------------------------- */

  title(instant) {
    this.audio.setAmbience('none');
    this.go(
      () =>
        new Title(this, {
          hasSave: !!this._load(),
          onContinue: () => {
            this.save = this._load();
            this.toWorld(false);
          },
          onTidepool: () => this.beginCell(),
          onLand: () => this.beginLand(),
          onWorkshop: () => this.workshop(),
          onLineage: () => this.showLineage(this._load()),
        }),
      instant,
    );
  }

  beginCell() {
    this.audio.setAmbience('cell');
    this.go(() => new CellStage(this, { onDone: (res) => this.beginLand(res), onQuit: () => this.title() }));
  }

  // First editor: shape the body that walks ashore.
  beginLand(res = {}) {
    this.audio.setAmbience('none');
    const genome = starterGenome(res.diet || 'omni', res.skin);
    const budget = genomeCost(genome) + 70 + (res.bonus || 0);
    this.go(
      () =>
        new Editor(this, {
          genome,
          budget,
          unlocked: new Set(STARTER_PARTS),
          title: 'Generation 1 · the first to walk',
          doneLabel: 'Walk ashore',
          onBack: () => this.title(),
          onDone: (g) => this.newGame(g, false, false, budget - genomeCost(g)),
        }),
    );
  }

  workshop() {
    this.audio.setAmbience('none');
    const genome = starterGenome('omni');
    genome.name = 'Sketch';
    this.go(
      () =>
        new Editor(this, {
          genome,
          budget: Infinity,
          sandbox: true,
          title: 'Workshop · every part, no cost',
          doneLabel: 'Set it loose',
          onBack: () => this.title(),
          onDone: (g) => this.newGame(g, true),
        }),
    );
  }

  newGame(genome, sandbox, instant, bank = 0) {
    this.save = {
      v: 1,
      seed: (Math.random() * 2 ** 31) | 0,
      gen: 1,
      genome: cloneGenome(genome),
      bank,
      earned: 0,
      unlocked: [...STARTER_PARTS],
      lineage: [],
      species: {},
      bones: [],
      clock: 0.07,
      sandbox: !!sandbox,
      won: false,
      tally: { friends: 0, kills: 0, meals: 0 },
    };
    if (this.params.get('seed')) this.save.seed = +this.params.get('seed');
    this.persist();
    this.toWorld(true, instant);
  }

  toWorld(hatch, instant) {
    this.audio.setAmbience('world');
    this.go(
      () =>
        new Game(this, {
          save: this.save,
          hatch,
          onEvolve: () => this.evolve(),
          onQuit: () => this.title(),
        }),
      instant,
    );
  }

  // Back at the nest: spend helix on the next generation.
  evolve() {
    const s = this.save;
    this.persist();
    this.audio.setAmbience('none');
    const next = cloneGenome(s.genome);
    const budget = s.sandbox ? Infinity : s.bank + genomeCost(s.genome);
    this.go(
      () =>
        new Editor(this, {
          genome: next,
          budget,
          sandbox: s.sandbox,
          unlocked: s.sandbox ? null : new Set(s.unlocked),
          title: `Generation ${s.gen + 1} · what comes next`,
          doneLabel: 'Hatch',
          onBack: () => this.toWorld(false),
          onDone: (g) => {
            s.lineage.push(s.genome);
            if (s.lineage.length > 40) s.lineage.shift();
            s.genome = cloneGenome(g);
            if (!s.sandbox) s.bank = budget - genomeCost(g);
            s.gen += 1;
            this.persist();
            this.audio.blip('evolve');
            this.toWorld(true);
          },
        }),
    );
  }

  showLineage(save, heading) {
    const s = save || this.save;
    if (!s) return;
    const all = [...s.lineage, s.genome];
    const first = s.gen - all.length + 1;
    const figs = all
      .map((g, i) => `<figure><img src="${creatureThumb(g, 180)}" alt="" /><figcaption><b>${esc(g.name || 'Unnamed')}</b><small>generation ${first + i}</small></figcaption></figure>`)
      .join('');
    modal(
      `<p class="eyebrow">${esc(heading || 'Lineage')}</p>
       <h2>${all.length === 1 ? 'One generation so far' : `${s.gen} generations`}</h2>
       <div class="lineage">${figs}</div>
       <div class="row row--end"><button class="btn btn--primary" data-close>Close</button></div>`,
      { wide: true },
    );
  }
}

window.phyla = new App();
