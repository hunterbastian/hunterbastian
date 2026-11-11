// Title screen: an endless parade of procedurally generated strangers.

import * as THREE from './three.js';
import { Creature } from './creature.js';
import { randomGenome } from './genome.js';
import { el, icon } from './ui.js';

export class Title {
  // o: { hasSave, onContinue, onTidepool, onLand, onWorkshop, onLineage }
  constructor(app, o) {
    this.app = app;
    this.o = o;
    const scene = (this.scene = new THREE.Scene());
    const bg = document.createElement('canvas');
    bg.width = 4;
    bg.height = 256;
    const x = bg.getContext('2d');
    const g = x.createLinearGradient(0, 0, 0, 256);
    g.addColorStop(0, '#7fb5c9');
    g.addColorStop(0.5, '#cfe5dc');
    g.addColorStop(0.72, '#f3e6c4');
    g.addColorStop(1, '#f3e6c4');
    x.fillStyle = g;
    x.fillRect(0, 0, 4, 256);
    this.bg = new THREE.CanvasTexture(bg);
    this.bg.colorSpace = THREE.SRGBColorSpace;
    scene.background = this.bg;
    scene.fog = new THREE.Fog('#e6e4c8', 16, 60);
    scene.add(new THREE.HemisphereLight('#fffaf0', '#7d8a5c', 1.3));
    const sun = new THREE.DirectionalLight('#ffe9c4', 2.4);
    sun.position.set(-6, 7, 6);
    scene.add(sun);
    const ground = new THREE.Mesh(new THREE.PlaneGeometry(200, 200).rotateX(-Math.PI / 2), new THREE.MeshStandardMaterial({ color: '#9cc06c', roughness: 1 }));
    scene.add(ground);
    const hillMat = new THREE.MeshStandardMaterial({ color: '#8db565', roughness: 1 });
    for (const [px, pz, r] of [[-16, -26, 14], [8, -34, 18], [30, -24, 12]]) {
      const h = new THREE.Mesh(new THREE.SphereGeometry(r, 24, 12), hillMat);
      h.position.set(px, -r * 0.62, pz);
      scene.add(h);
    }
    const trunkMat = new THREE.MeshStandardMaterial({ color: '#d3c4a3', roughness: 1 });
    const capMat = new THREE.MeshStandardMaterial({ color: '#e07a5f', roughness: 1, flatShading: true });
    const leafMat = new THREE.MeshStandardMaterial({ color: '#5fa052', roughness: 1, flatShading: true });
    for (const [px, pz, s, kind] of [[-7, -7, 1.2, 0], [5.5, -9, 1.5, 0], [11, -6, 1, 1], [-2.5, -12, 1.3, 1], [15, -13, 1.6, 0], [-13, -10, 1.1, 1]]) {
      const t = new THREE.Group();
      if (kind === 0) {
        t.add(new THREE.Mesh(new THREE.CylinderGeometry(0.09, 0.17, 4.2, 5).translate(0, 2.1, 0), trunkMat));
        t.add(new THREE.Mesh(new THREE.ConeGeometry(2.05, 0.75, 9).translate(0, 4.4, 0), capMat));
      } else {
        t.add(new THREE.Mesh(new THREE.CylinderGeometry(0.16, 0.27, 2.3, 6).translate(0, 1.15, 0), trunkMat));
        t.add(new THREE.Mesh(new THREE.IcosahedronGeometry(1.4, 1).translate(0, 3.1, 0), leafMat));
        t.add(new THREE.Mesh(new THREE.IcosahedronGeometry(1.0, 1).translate(0.9, 2.5, 0.3), leafMat));
      }
      t.position.set(px, 0, pz);
      t.scale.setScalar(s);
      scene.add(t);
    }
    this.camera = new THREE.PerspectiveCamera(30, 1, 0.1, 200);
    this.camera.position.set(0.5, 1.7, 12.5);
    this.camera.lookAt(0.5, 1.0, 0);

    this.walkers = [];
    this.seed = (Math.random() * 1e9) | 0;
    this.t = 0;
    for (let i = 0; i < 6; i++) this._spawn(-9 + i * 3.6, false);

    const ui = (this.ui = el(`
      <div class="title">
        <div class="title__card">
          <p class="eyebrow">an evolution sandbox</p>
          <h1 class="wordmark">Phyla</h1>
          <p class="title__lede">Begin as a speck in a tidepool. Crawl out. Shape a body, find your kind, and decide who you will be to everything else that lives here.</p>
          <div class="title__actions">
            ${o.hasSave ? '<button class="btn btn--primary" data-a="continue">Continue your lineage</button>' : ''}
            <button class="btn ${o.hasSave ? '' : 'btn--primary'}" data-a="tidepool">Begin in the tidepool</button>
            <button class="btn" data-a="land">Start on land</button>
            <button class="btn btn--ghost" data-a="workshop">Creature workshop</button>
            ${o.hasSave ? '<button class="btn btn--ghost" data-a="lineage">Lineage</button>' : ''}
          </div>
          <p class="title__foot">An original game, made as a love letter to the creature games we grew up with and the ones we only ever saw in demos.</p>
        </div>
        <button class="iconbtn title__sound" data-a="sound" aria-label="Toggle sound">${icon(app.audio.muted ? 'mute' : 'sound')}</button>
      </div>`));
    app.ui.appendChild(ui);
    ui.addEventListener('click', (e) => {
      const b = e.target.closest('[data-a]');
      if (!b) return;
      app.audio.unlock();
      app.audio.blip('tick');
      const a = b.dataset.a;
      if (a === 'sound') {
        app.audio.setMuted(!app.audio.muted);
        b.innerHTML = icon(app.audio.muted ? 'mute' : 'sound');
      } else if (a === 'continue') o.onContinue();
      else if (a === 'tidepool') o.onTidepool();
      else if (a === 'land') o.onLand();
      else if (a === 'workshop') o.onWorkshop();
      else if (a === 'lineage') o.onLineage();
    });
  }

  _spawn(x, hatch) {
    const g = randomGenome(this.seed++);
    const c = new Creature(g, { seed: this.seed });
    c.heading = Math.PI / 2;
    c.root.position.set(x, 0, (Math.random() - 0.5) * 2.4);
    const sp = c.stats.moveSpeed * 0.36;
    c.vel.set(sp, 0, 0);
    c.resetFeet();
    if (hatch) c.play('hatch');
    this.scene.add(c.root);
    this.walkers.push({ c, drift: sp });
  }

  resize(w, h) {
    this.camera.aspect = w / h;
    const narrow = w < 760;
    this.camera.fov = narrow ? 44 : 30;
    if (narrow) this.camera.setViewOffset(w, h, 0, h * 0.24, w, h);
    else this.camera.setViewOffset(w, h, -w * 0.17, 0, w, h);
    this.camera.updateProjectionMatrix();
  }

  update(dt) {
    this.t += dt;
    for (let i = this.walkers.length - 1; i >= 0; i--) {
      const w = this.walkers[i];
      w.c.root.position.x += w.drift * dt;
      w.c.update(dt);
      if (w.c.root.position.x > 13) {
        w.c.dispose();
        this.walkers.splice(i, 1);
        this._spawn(-13, false);
      }
    }
    this.app.renderer.render(this.scene, this.camera);
  }

  dispose() {
    this.ui.remove();
    for (const w of this.walkers) w.c.dispose();
    this.bg.dispose();
    this.scene.traverse((o) => {
      if (o.geometry) o.geometry.dispose();
      if (o.material && o.material.dispose) o.material.dispose();
    });
  }
}
