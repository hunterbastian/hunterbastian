// Island map overlay (M): the terrain's shaded-relief survey plate with your
// position, heading, view cone, recent trail and sniffed markers.
//
// The relief is rendered once (terrain.mapCanvas is expensive) — lazily, or
// ahead of time in an idle callback — and only the small dynamic layer on top
// is redrawn, and only while the map is open.

import { clamp } from "../core/math.js";
import { icon } from "./menu.js";

const MAP_PX = 768; // relief resolution (shown at up to ~720 CSS px)
const GRID_M = 200; // matches the graticule terrain.mapCanvas engraves
const TRAIL_STEP = 12; // metres between breadcrumbs
const TRAIL_MAX = 360;
const VIEW_CONE = 0.55; // half-angle of the view wedge, radians
const SCALE_STEPS = [25, 50, 100, 200, 250, 500, 1000];
const COLS = "ABCDEFGHIJKLMNOP";
const CARDINALS = ["N", "NE", "E", "SE", "S", "SW", "W", "NW"];
const BIOME_NAME = {
  ocean: "Open sea",
  lake: "Fresh water",
  beach: "Beach",
  plains: "Grassland",
  forest: "Forest",
  swamp: "Swamp",
  highland: "Highland",
  rock: "Bare rock",
};
const MARKER_COLOR = {
  water: "#3f8f98",
  plant: "#6d8a3a",
  carcass: "#8c6a3c",
  creature: "#5b5446",
  threat: "#b0322a",
};

/** Field-guide compass rose (north up). */
const ROSE = `<svg class="map__rose" viewBox="-50 -50 100 100" aria-hidden="true" focusable="false">
  <circle r="30" class="rose__ring"/><circle r="36" class="rose__ring rose__ring--thin"/>
  <path class="rose__minor" d="M0-22 4-4 22 0 4 4 0 22-4 4-22 0-4-4z" transform="rotate(45)"/>
  <path class="rose__major" d="M0-34 5.5-5.5 0 0z"/><path class="rose__major rose__major--dark" d="M0-34-5.5-5.5 0 0z"/>
  <path class="rose__major rose__major--dark" d="M34 0 5.5 5.5 0 0z"/><path class="rose__major" d="M34 0 5.5-5.5 0 0z"/>
  <path class="rose__major rose__major--dark" d="M0 34-5.5 5.5 0 0z"/><path class="rose__major" d="M0 34 5.5 5.5 0 0z"/>
  <path class="rose__major rose__major--dark" d="M-34 0-5.5-5.5 0 0z"/><path class="rose__major" d="M-34 0-5.5 5.5 0 0z"/>
  <text y="-39" class="rose__n">N</text>
</svg>`;

export class MapView {
  /**
   * @param {HTMLElement} root UI root (#ui)
   * @param {object|null} terrain Terrain (needs size, mapCanvas(); heightAt/biomeAt are used when present)
   */
  constructor(root, terrain) {
    this.root = root;
    this.terrain = null;
    this._open = false;
    this._baseReady = false;
    this._trail = [];
    this._t = 0;
    this._last = { player: null, cameraYaw: null, markers: null };
    this._read = {};
    this._closedByKeyAt = -1e9;
    this._frameCss = 0;
    this._build();
    this._bind();
    this.setTerrain(terrain);
  }

  /** True while the map is showing. Assigning opens / closes it. */
  get open() {
    return this._open;
  }

  set open(v) {
    if (v) this.show();
    else this.close();
  }

  /** Open if closed, close if open. */
  toggle() {
    // Main may also see the M / Esc that just closed us (it polls Input):
    // ignore an immediate re-toggle so one key press is one action.
    if (!this._open && performance.now() - this._closedByKeyAt < 250) return;
    if (this._open) this.close();
    else this.show();
  }

  /** Open the map. */
  show() {
    if (this._open) return;
    this._ensureBase();
    this._open = true;
    this.el.removeAttribute("inert");
    this.el.setAttribute("aria-hidden", "false");
    this.el.classList.add("is-open");
    this._layout();
    this._draw();
  }

  /** Close the map. */
  close() {
    if (!this._open) return;
    this._open = false;
    this.el.classList.remove("is-open");
    this.el.setAttribute("inert", "");
    this.el.setAttribute("aria-hidden", "true");
  }

  /**
   * Point the map at a (new) terrain — e.g. after a new seed. The relief is
   * rebuilt lazily, or during idle time.
   * @param {object|null} terrain
   */
  setTerrain(terrain) {
    this.terrain = terrain || null;
    this._baseReady = false;
    this._trail.length = 0;
    this._buildGrid();
    if (!this.terrain) return;
    const idle = window.requestIdleCallback || ((fn) => setTimeout(fn, 1200));
    const t = this.terrain;
    idle(() => {
      if (this.terrain === t && !this._baseReady) this._ensureBase();
    });
  }

  /**
   * Record the trail every frame; redraw the dynamic layer only while open.
   * @param {number} dt
   * @param {{ player?: object, cameraYaw?: number, markers?: object[] }} state
   */
  update(dt, { player = null, cameraYaw = null, markers = null } = {}) {
    this._t += clamp(Number(dt) || 0, 0, 0.1);
    this._last.player = player;
    this._last.cameraYaw = cameraYaw;
    this._last.markers = markers;
    const pos = player?.position;
    if (pos && Number.isFinite(pos.x)) {
      const tr = this._trail;
      const tail = tr[tr.length - 1];
      if (!tail || Math.hypot(pos.x - tail.x, pos.z - tail.z) > TRAIL_STEP) {
        // Long jumps (respawn / teleport) start a new trail instead of a streak across the map.
        if (tail && Math.hypot(pos.x - tail.x, pos.z - tail.z) > TRAIL_STEP * 12) tr.length = 0;
        tr.push({ x: pos.x, z: pos.z });
        if (tr.length > TRAIL_MAX) tr.shift();
      }
    }
    if (!this._open) return;
    this._draw();
    this._updateReadout(player);
  }

  /** Clear the breadcrumb trail (new life). */
  clearTrail() {
    this._trail.length = 0;
  }

  /** Remove DOM and listeners. */
  dispose() {
    this._ac.abort();
    this._ro?.disconnect();
    this.el.remove();
  }

  /* --- Construction --- */

  _build() {
    const el = document.createElement("div");
    el.className = "map";
    el.setAttribute("role", "dialog");
    el.setAttribute("aria-modal", "false");
    el.setAttribute("aria-label", "Map of the island");
    el.innerHTML = `
      <div class="map__backdrop" aria-hidden="true"></div>
      <div class="map__sheet">
        <div class="map__frame">
          <canvas class="map__base" aria-hidden="true"></canvas>
          <canvas class="map__dyn" aria-hidden="true"></canvas>
          <div class="map__grid" aria-hidden="true"></div>
          ${ROSE}
          <div class="map__scale" aria-hidden="true"><span class="map__scale-bar"><i></i><i></i></span><span class="map__scale-label">200 m</span></div>
          <p class="map__empty">Surveying…</p>
        </div>
        <aside class="map__side">
          <header class="map__head">
            <p class="eyebrow">Pl. II · Survey of the island</p>
            <h2 class="map__title">The Island</h2>
          </header>
          <dl class="map__readout">
            <div><dt>Position</dt><dd data-r="pos">—</dd></div>
            <div><dt>Grid</dt><dd data-r="grid">—</dd></div>
            <div><dt>Heading</dt><dd data-r="hdg">—</dd></div>
            <div><dt>Elevation</dt><dd data-r="elev">—</dd></div>
            <div class="map__readout-wide"><dt>Terrain</dt><dd data-r="biome">—</dd></div>
          </dl>
          <ul class="map__legend">
            <li><span class="lg lg--you"></span>You &amp; your view</li>
            <li><span class="lg lg--trail"></span>Your trail</li>
            <li><span class="lg lg--dot" style="--c:${MARKER_COLOR.water}"></span>Sniffed fresh water</li>
            <li><span class="lg lg--dot" style="--c:${MARKER_COLOR.plant}"></span>Food</li>
            <li><span class="lg lg--dot" style="--c:${MARKER_COLOR.threat}"></span>Threat</li>
            <li><span class="lg lg--sw lg--fresh"></span>Lakes &amp; rivers — drinkable</li>
            <li><span class="lg lg--sw lg--sea"></span>Sea — salt</li>
          </ul>
          <p class="map__hint"><span class="map__hint-keys"><kbd class="kbd">M</kbd> or <kbd class="kbd">Esc</kbd> to close</span><span class="map__hint-touch">Tap anywhere to close</span></p>
        </aside>
        <button type="button" class="icon-btn map__close" aria-label="Close map">${icon("close")}</button>
      </div>`;
    this.el = el;
    this.root.appendChild(el);
    el.setAttribute("inert", "");
    el.setAttribute("aria-hidden", "true");
    this._frame = el.querySelector(".map__frame");
    this._base = el.querySelector(".map__base");
    this._dyn = el.querySelector(".map__dyn");
    this._ctx = this._dyn.getContext("2d");
    this._gridEl = el.querySelector(".map__grid");
    this._scaleBar = el.querySelector(".map__scale-bar");
    this._scaleLabel = el.querySelector(".map__scale-label");
    this._empty = el.querySelector(".map__empty");
    this._r = {};
    for (const dd of el.querySelectorAll("[data-r]")) this._r[dd.dataset.r] = dd;
  }

  _bind() {
    this._ac = new AbortController();
    const sig = { signal: this._ac.signal };
    // Tap / click anywhere closes — there is nothing to interact with on the plate.
    this.el.addEventListener("click", () => this.close(), sig);
    window.addEventListener(
      "keydown",
      (e) => {
        if (!this._open || e.defaultPrevented) return;
        if (e.code === "KeyM" || e.code === "Escape") {
          // Swallow so Input doesn't also turn this into "map" / "pause".
          e.preventDefault();
          e.stopImmediatePropagation();
          if (e.repeat) return;
          this._closedByKeyAt = performance.now();
          this.close();
        }
      },
      { capture: true, signal: this._ac.signal },
    );
    if (typeof ResizeObserver === "function") {
      this._ro = new ResizeObserver(() => this._open && this._layout());
      this._ro.observe(this._frame);
    }
    window.addEventListener("resize", () => this._open && this._layout(), sig);
  }

  /** Column letters / row numbers for the 200 m graticule. */
  _buildGrid() {
    const size = this.terrain?.size || 1600;
    const n = clamp(Math.round(size / GRID_M), 1, COLS.length);
    let html = "";
    for (let i = 0; i < n; i++) {
      const c = ((i + 0.5) / n) * 100;
      html += `<span class="map__col" style="left:${c.toFixed(3)}%">${COLS[i]}</span>`;
      html += `<span class="map__row" style="top:${c.toFixed(3)}%">${i + 1}</span>`;
    }
    this._gridEl.innerHTML = html;
  }

  _ensureBase() {
    if (this._baseReady || !this.terrain || typeof this.terrain.mapCanvas !== "function") return;
    const src = this.terrain.mapCanvas(MAP_PX);
    this._base.width = src.width;
    this._base.height = src.height;
    this._base.getContext("2d").drawImage(src, 0, 0);
    this._baseReady = true;
    this.el.classList.add("has-base");
  }

  _layout() {
    const css = this._frame.clientWidth;
    if (!css) return;
    const dpr = Math.min(2, window.devicePixelRatio || 1);
    const px = Math.round(css * dpr);
    if (this._dyn.width !== px) {
      this._dyn.width = px;
      this._dyn.height = px;
    }
    if (css !== this._frameCss) {
      this._frameCss = css;
      // Scale bar: the longest "nice" distance that stays under ~140 px.
      const size = this.terrain?.size || 1600;
      const mPerPx = size / css;
      let best = SCALE_STEPS[0];
      for (const d of SCALE_STEPS) if (d / mPerPx <= 140) best = d;
      this._scaleBar.style.width = `${(best / mPerPx).toFixed(1)}px`;
      this._scaleLabel.textContent = best >= 1000 ? `${best / 1000} km` : `${best} m`;
    }
    this._draw();
  }

  /* --- Drawing --- */

  _draw() {
    const ctx = this._ctx;
    const S = this._dyn.width;
    if (!ctx || !S) return;
    ctx.clearRect(0, 0, S, S);
    const size = this.terrain?.size || 1600;
    const half = size / 2;
    const k = S / size; // canvas px per metre
    const u = S / 720; // stroke unit, so the drawing scales with the plate
    const mx = (x) => (x + half) * k;
    const mz = (z) => (z + half) * k;
    const { player, cameraYaw, markers } = this._last;

    // Trail: a fine dotted line of where you've been, fading with age.
    const tr = this._trail;
    if (tr.length > 1) {
      ctx.lineCap = "round";
      ctx.lineWidth = 1.6 * u;
      ctx.setLineDash([0.1, 5 * u]);
      for (let i = 1; i < tr.length; i++) {
        ctx.strokeStyle = `rgba(52, 40, 28, ${(0.15 + 0.6 * (i / tr.length)).toFixed(3)})`;
        ctx.beginPath();
        ctx.moveTo(mx(tr[i - 1].x), mz(tr[i - 1].z));
        ctx.lineTo(mx(tr[i].x), mz(tr[i].z));
        ctx.stroke();
      }
      ctx.setLineDash([]);
    }

    // Sniffed markers: coloured dots with an ink ring; threats pulse.
    if (Array.isArray(markers)) {
      const pulse = 0.5 + 0.5 * Math.sin(this._t * 5);
      for (const m of markers) {
        if (!Number.isFinite(m?.x) || !Number.isFinite(m?.z)) continue;
        const x = mx(m.x);
        const y = mz(m.z);
        const threat = m.kind === "creature" && m.threat;
        const col = threat ? MARKER_COLOR.threat : MARKER_COLOR[m.kind] || MARKER_COLOR.creature;
        if (threat) {
          ctx.strokeStyle = `rgba(176, 50, 42, ${(0.55 * (1 - pulse)).toFixed(3)})`;
          ctx.lineWidth = 1.5 * u;
          ctx.beginPath();
          ctx.arc(x, y, (6 + pulse * 9) * u, 0, Math.PI * 2);
          ctx.stroke();
        }
        ctx.fillStyle = col;
        ctx.strokeStyle = "rgba(244, 238, 222, 0.95)";
        ctx.lineWidth = 1.6 * u;
        ctx.beginPath();
        ctx.arc(x, y, (m.kind === "water" ? 5 : 4.2) * u, 0, Math.PI * 2);
        ctx.fill();
        ctx.stroke();
      }
    }

    const pos = player?.position;
    if (!pos || !Number.isFinite(pos.x)) return;
    const px = mx(pos.x);
    const py = mz(pos.z);

    // View cone along the camera: canvas +y is world +Z, so a yaw maps to (sin, cos).
    if (Number.isFinite(cameraYaw)) {
      const r = 120 * u;
      const g = ctx.createRadialGradient(px, py, 0, px, py, r);
      g.addColorStop(0, "rgba(40, 30, 18, 0.32)");
      g.addColorStop(1, "rgba(40, 30, 18, 0)");
      ctx.fillStyle = g;
      ctx.beginPath();
      ctx.moveTo(px, py);
      const a0 = Math.atan2(Math.cos(cameraYaw), Math.sin(cameraYaw));
      ctx.arc(px, py, r, a0 - VIEW_CONE, a0 + VIEW_CONE);
      ctx.closePath();
      ctx.fill();
    }

    // Soft breathing ring so you find yourself at a glance.
    const breath = 0.5 + 0.5 * Math.sin(this._t * 2.4);
    ctx.strokeStyle = `rgba(150, 46, 30, ${(0.22 + 0.25 * breath).toFixed(3)})`;
    ctx.lineWidth = 1.5 * u;
    ctx.beginPath();
    ctx.arc(px, py, (13 + breath * 4) * u, 0, Math.PI * 2);
    ctx.stroke();

    // Heading arrow: a slim chevron in rust with a paper outline.
    const yaw = Number(player.heading) || 0;
    const fx = Math.sin(yaw);
    const fy = Math.cos(yaw);
    const rx = -fy;
    const ry = fx;
    const L = 11 * u;
    const W = 7 * u;
    ctx.beginPath();
    ctx.moveTo(px + fx * L, py + fy * L);
    ctx.lineTo(px - fx * L * 0.7 + rx * W, py - fy * L * 0.7 + ry * W);
    ctx.lineTo(px - fx * L * 0.25, py - fy * L * 0.25);
    ctx.lineTo(px - fx * L * 0.7 - rx * W, py - fy * L * 0.7 - ry * W);
    ctx.closePath();
    ctx.lineJoin = "round";
    ctx.lineWidth = 3.2 * u;
    ctx.strokeStyle = "rgba(244, 238, 222, 0.95)";
    ctx.stroke();
    ctx.fillStyle = "#a63a22";
    ctx.fill();
  }

  _updateReadout(player) {
    const pos = player?.position;
    const r = this._read;
    const set = (key, text) => {
      if (r[key] === text) return;
      r[key] = text;
      this._r[key].textContent = text;
    };
    this._empty.hidden = this._baseReady;
    if (!pos || !Number.isFinite(pos.x)) return;
    const n = -pos.z; // north is −Z
    set("pos", `${Math.abs(Math.round(n))} m ${n >= 0 ? "N" : "S"} · ${Math.abs(Math.round(pos.x))} m ${pos.x >= 0 ? "E" : "W"}`);
    const size = this.terrain?.size || 1600;
    const half = size / 2;
    const cells = Math.round(size / GRID_M);
    const col = clamp(Math.floor((pos.x + half) / GRID_M), 0, cells - 1);
    const row = clamp(Math.floor((pos.z + half) / GRID_M), 0, cells - 1);
    set("grid", `${COLS[col]}${row + 1}`);
    const yaw = Number(player.heading) || 0;
    const deg = Math.round(((((Math.PI - yaw) * 180) / Math.PI) % 360 + 360) % 360) % 360;
    set("hdg", `${CARDINALS[Math.round(deg / 45) % 8]} ${String(deg).padStart(3, "0")}°`);
    const t = this.terrain;
    if (t && typeof t.heightAt === "function") {
      const h = t.heightAt(pos.x, pos.z) - (t.seaLevel || 0);
      set("elev", h < 0 ? `${Math.round(-h * 10) / 10} m deep` : `${Math.round(h)} m`);
    }
    if (t && typeof t.biomeAt === "function") set("biome", BIOME_NAME[t.biomeAt(pos.x, pos.z)] || "—");
  }
}
