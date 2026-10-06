// Survival-mode HUD: vitals, growth, status chips, compass, clock, context
// prompt, sniff markers, vignettes, toasts — plus the pause, help and death
// overlays.
//
// Sparse by design (The Isle keeps the screen clear): everything sits at the
// edges on soft scrims so it reads over bright fog and dark forest alike.
// update() runs every frame, so it only touches the DOM when a displayed value
// actually changes, and moves markers / the compass with transforms only.

import * as THREE from "three";
import { clamp, damp, smoothstep } from "../core/math.js";
import {
  icon,
  escapeHtml,
  STAGE_LABEL,
  stageOf,
  formatDuration,
  article,
  controlsSheetHTML,
  speciesSilhouette,
  brandMark,
} from "./menu.js";

/* --- Constants -------------------------------------------------------------- */

const PX_PER_DEG = 2.4; // compass strip scale
const CARDINALS = ["N", "NE", "E", "SE", "S", "SW", "W", "NW"];
const MARKER_POOL_MAX = 32;
const WATER_PIN_MEMORY = 90; // s the sniffed water stays on the compass
const TOAST_MAX = 4;
const TOAST_LIFE = { info: 3600, good: 4200, warn: 4800, danger: 5600 };
const TOAST_ICON = { info: "track", good: "egg", warn: "claw", danger: "bleed" };
const MARKER_ICON = { water: "drop", plant: "leaf", carcass: "bone", creature: "track" };
const MARKER_NAME = { water: "Fresh water", plant: "Plants", carcass: "Carcass", creature: "Animal" };
const MARKER_LIFT = { water: 0.5, plant: 1.1, carcass: 0.9, creature: 2.4 };
// Prompt key → touch action glyph, so "Hold E to drink" reads right on a phone.
const KEY_ACTION = { E: "interact", F: "bite", LMB: "bite", Q: "call", R: "sniff", Z: "rest", C: "crouch", M: "map", Shift: "sprint" };
const SLOW_DAMAGE = new Set(["starve", "dehydrate", "bleed", "drown"]);

const EPITAPH = {
  killed: "Something larger was hungry too.",
  starved: "The island gave too little, too late.",
  thirst: "Fresh water was always one more ridge away.",
  drowned: "The water took it quietly.",
  bled: "It kept going until there was nothing left.",
  fall: "The high country does not forgive a misstep.",
  unknown: "The island keeps what it takes.",
};

const _v = new THREE.Vector3();
const _cam = new THREE.Vector3();
const _dir = new THREE.Vector3();
// Screen boxes of markers placed this frame: x, half-width, top, bottom.
const _boxes = new Float32Array(MARKER_POOL_MAX * 4);

/* --- Helpers -------------------------------------------------------------- */

/** Compass bearing in degrees [0, 360) for a heading yaw (yaw 0 = +Z = south, north = −Z). */
const bearingOf = (yaw) => {
  const deg = ((Math.PI - yaw) * 180) / Math.PI;
  return ((deg % 360) + 360) % 360;
};
/** Does the box (centre x, half-width, top, bottom) overlap any of the first n placed markers? */
function overlapsPlaced(n, x, hw, top, bottom) {
  for (let k = 0; k < n; k++) {
    const o = k * 4;
    if (Math.abs(x - _boxes[o]) < hw + _boxes[o + 1] && top < _boxes[o + 3] && bottom > _boxes[o + 2]) return true;
  }
  return false;
}

const cardinalOf = (deg) => CARDINALS[Math.round(deg / 45) % 8];
const relDeg = (a, b) => ((((b - a) % 360) + 540) % 360) - 180;

/** Strip of ticks and cardinal letters spanning three turns (−360°…720°) so any bearing has margin. */
function compassStripSVG() {
  const w = 1080 * PX_PER_DEG;
  let s = "";
  for (let d = -360; d <= 720; d += 5) {
    const x = ((d + 360) * PX_PER_DEG).toFixed(1);
    const m = ((d % 360) + 360) % 360;
    if (m % 45 === 0) {
      const label = CARDINALS[m / 45];
      const cls = m === 0 ? "c-n" : label.length === 1 ? "c-main" : "c-sub";
      s += `<text x="${x}" y="15" class="${cls}">${label}</text>`;
    } else if (m % 15 === 0) {
      s += `<line x1="${x}" x2="${x}" y1="9" y2="17" class="c-major"/>`;
    } else {
      s += `<line x1="${x}" x2="${x}" y1="11.5" y2="15" class="c-minor"/>`;
    }
  }
  return `<svg class="compass__svg" width="${w}" height="22" viewBox="0 0 ${w} 22" aria-hidden="true" focusable="false">${s}</svg>`;
}

/** Contract cause (string, type key or { killer }) → headline + epitaph kind. */
function describeCause(cause) {
  if (cause && typeof cause === "object") {
    const k = cause.killer || cause.creature || cause.source;
    if (k?.species?.name) {
      const stage = (STAGE_LABEL[k.stage || stageOf(k.growth ?? 1)] || "").toLowerCase();
      return { title: `Killed by ${article(stage)} ${stage} ${k.species.name}`, kind: "killed" };
    }
    cause = cause.text || cause.cause || cause.type || "";
  }
  const raw = String(cause || "").trim();
  if (!raw) return { title: "Died", kind: "unknown" };
  const key = raw.toLowerCase();
  const table = [
    [/^(starve|starved|starvation|hunger)$/, "Starved", "starved"],
    [/^(dehydrate|dehydrated|dehydration|thirst)$/, "Died of thirst", "thirst"],
    [/^(drown|drowned|drowning)$/, "Drowned", "drowned"],
    [/^(bleed|bled|bleeding|bled out|blood loss)$/, "Bled out", "bled"],
    [/^(fall|fell|falling)$/, "Fell", "fall"],
    [/^(bite|tail|kick|attack|killed)$/, "Killed in a fight", "killed"],
    [/^(shot|gunshot)$/, "Shot by a hunter", "killed"],
  ];
  for (const [re, title, kind] of table) if (re.test(key)) return { title, kind };
  // Already a sentence, e.g. "Killed by an adult Allosaurus".
  const kind = /kill|bit|maul|eaten|shot/.test(key)
    ? "killed"
    : /drown/.test(key)
      ? "drowned"
      : /starv/.test(key)
        ? "starved"
        : /thirst|dehydr/.test(key)
          ? "thirst"
          : /bled|bleed/.test(key)
            ? "bled"
            : "unknown";
  return { title: raw.charAt(0).toUpperCase() + raw.slice(1), kind };
}

/** Prompt text → markup with key-caps (desktop) or touch-button glyphs (phones). */
function formatPrompt(text, touch) {
  const cap = (k) =>
    touch && KEY_ACTION[k]
      ? `<span class="tglyph tglyph--sm">${icon(KEY_ACTION[k])}</span>`
      : `<kbd class="kbd">${k}</kbd>`;
  return escapeHtml(text).replace(
    /\[([A-Za-z0-9]{1,5})\]|\b(Hold|Press|Tap|Click|Use)\s+(LMB|RMB|Shift|Ctrl|Space|Esc|[A-Z])\b/g,
    (m, bracket, verb, key) => (bracket ? cap(bracket) : `${verb} ${cap(key)}`),
  );
}

const FOCUSABLE = "button:not([disabled]), [href], input:not([disabled]), [tabindex]:not([tabindex='-1'])";

function trapTab(e, container) {
  const items = [...container.querySelectorAll(FOCUSABLE)].filter((el) => el.offsetParent !== null);
  if (!items.length) return;
  const first = items[0];
  const last = items[items.length - 1];
  if (e.shiftKey && document.activeElement === first) {
    e.preventDefault();
    last.focus();
  } else if (!e.shiftKey && document.activeElement === last) {
    e.preventDefault();
    first.focus();
  }
}

/* --- Hud ----------------------------------------------------------------- */

export class Hud {
  /**
   * @param {HTMLElement} root UI root (#ui)
   * @param {{ events?: import("../core/events.js").EventBus, isTouch?: boolean }} opts
   */
  constructor(root, { events = null, isTouch = false } = {}) {
    this.root = root;
    this.isTouch = Boolean(isTouch);
    this.visible = false;

    this._player = null;
    this._speciesKey = null;
    this._unsubs = [];
    this._c = {}; // last values written to the DOM
    this._hurt = 0;
    this._lastSlowHurt = 0;
    this._low = { food: 0, water: 0 };
    this._sniffAlpha = 0;
    this._water = null; // { x, z, age } last sniffed fresh water
    this._markersShown = 0;
    this._toasts = [];
    this._pause = { open: false, onResume: null, onQuit: null, onSettings: null };
    this._death = { open: false, onRespawn: null, onMenu: null };
    this._helpOpen = false;
    this._vw = 1;
    this._vh = 1;
    this._compassW = 360;

    this._build();
    this._ac = new AbortController();
    window.addEventListener("keydown", (e) => this._onKey(e), { capture: true, signal: this._ac.signal });
    this._measure();
    if (typeof ResizeObserver === "function") {
      this._ro = new ResizeObserver(() => this._measure());
      this._ro.observe(this.root);
      this._ro.observe(this._compassWin);
    } else {
      window.addEventListener("resize", () => this._measure(), { signal: this._ac.signal });
    }
    this.bindEvents(events);
  }

  /* --- Public API --- */

  /** Show the in-play HUD (vitals, compass, …). Overlays are independent. */
  show() {
    if (this.visible) return;
    this.visible = true;
    this.el.classList.add("is-open");
    this.el.setAttribute("aria-hidden", "false");
    this._measure();
  }

  /** Hide the in-play HUD. Pause / death overlays keep their own state. */
  hide() {
    if (!this.visible) return;
    this.visible = false;
    this.el.classList.remove("is-open");
    this.el.setAttribute("aria-hidden", "true");
    if (this._helpOpen) this.toggleHelp(false);
  }

  /**
   * Re-subscribe to a (new) world's EventBus — e.g. after the world is rebuilt.
   * @param {import("../core/events.js").EventBus|null} events
   */
  bindEvents(events) {
    for (const off of this._unsubs) off();
    this._unsubs = [];
    this.events = events || null;
    if (!events?.on) return;
    const on = (name, fn) => this._unsubs.push(events.on(name, fn));
    on("damage", (e) => this._onDamage(e));
    on("death", (e) => this._onDeathEvent(e));
    on("grow", (e) => this._onGrow(e));
    on("legBreak", (e) => {
      if (e?.creature && e.creature === this._player) this.toast("Broken leg — you can't sprint until it heals", "danger", "fracture");
    });
    on("newDay", (e) => this.toast(`Day ${e?.day ?? ""} — first light`, "info", "dawn"));
    on("notify", (e) => e?.text && this.toast(e.text, e.kind || "info"));
  }

  /**
   * Per-frame refresh. Cheap: compares against cached values and only writes
   * what changed.
   * @param {number} dt seconds
   * @param {{ player?: object, controller?: object, world?: object, camera?: THREE.Camera }} state
   */
  update(dt, { player = null, controller = null, world = null, camera = null } = {}) {
    dt = clamp(Number(dt) || 0, 0, 0.1);
    const p = player || null;
    if (p !== this._player) this._setPlayer(p);
    if (this._water) this._water.age += dt;
    if (!this.visible) return;

    const cam = camera?.isCamera ? camera : camera?.camera?.isCamera ? camera.camera : null;
    if (p) this._updateVitals(p, world, dt);
    this._updateCompass(cam, p);
    this._updateClock(world?.sky);
    this._updatePrompt(controller?.prompt || null);
    this._updateMarkers(controller?.sniff, cam, p, dt);
    this._updateVignettes(p, dt);
  }

  /**
   * Stacked toast. Repeats within a couple of seconds refresh instead of stacking.
   * @param {string} text
   * @param {"info"|"good"|"warn"|"danger"} [kind]
   * @param {string} [iconName] optional icon key (defaults per kind)
   */
  toast(text, kind = "info", iconName) {
    if (!text) return;
    if (!TOAST_LIFE[kind]) kind = "info";
    const now = performance.now();
    const dupe = this._toasts.find((t) => t.text === text && !t.leaving);
    if (dupe && now - dupe.at < 2500) {
      clearTimeout(dupe.timer);
      dupe.timer = setTimeout(() => this._dropToast(dupe), TOAST_LIFE[kind]);
      return;
    }
    const el = document.createElement("div");
    el.className = `toast toast--${kind}`;
    el.innerHTML = `<span class="toast__ico">${icon(iconName || TOAST_ICON[kind])}</span><span class="toast__text">${escapeHtml(text)}</span>`;
    this._toastBox.appendChild(el);
    const t = { el, text, at: now, leaving: false, timer: 0 };
    t.timer = setTimeout(() => this._dropToast(t), TOAST_LIFE[kind]);
    this._toasts.push(t);
    const live = this._toasts.filter((x) => !x.leaving);
    if (live.length > TOAST_MAX) this._dropToast(live[0]);
  }

  /**
   * Death screen.
   * @param {{ speciesName?: string, growth?: number, survivedSec?: number, kills?: number, cause?: any }} summary
   * @param {() => void} onRespawn "Hatch again"
   * @param {() => void} onMenu "Main menu"
   */
  showDeath(summary = {}, onRespawn = null, onMenu = null) {
    const s = summary || {};
    const growth = clamp(Number(s.growth) || 0, 0, 1);
    const stage = STAGE_LABEL[stageOf(growth)];
    const cause = describeCause(s.cause);
    const def = this._player?.species?.name === s.speciesName || !s.speciesName ? this._player?.species : null;
    const kills = Math.max(0, Number(s.kills) || 0);
    this._death = { open: true, onRespawn, onMenu };
    this._deathEl.querySelector(".death__inner").innerHTML = `
      <p class="eyebrow death__eyebrow">${brandMark("death__mark")}Field record · end of a life</p>
      ${def ? `<div class="death__fig">${speciesSilhouette(def, { human: false })}</div>` : ""}
      <p class="death__species">${escapeHtml(s.speciesName || def?.name || "Unknown")}<span> · ${stage}</span></p>
      <h2 class="death__cause" id="hud-death-title">${escapeHtml(cause.title)}</h2>
      <p class="death__epitaph">${EPITAPH[cause.kind] || EPITAPH.unknown}</p>
      <dl class="death__stats">
        <div><dt>Survived</dt><dd>${formatDuration(s.survivedSec)}</dd></div>
        <div><dt>Growth</dt><dd>${Math.round(growth * 100)}<small>%</small></dd></div>
        <div><dt>Kills</dt><dd>${kills}</dd></div>
      </dl>
      <div class="death__actions">
        <button type="button" class="btn btn--primary" data-act="respawn">${icon("egg")}<span>Hatch again</span></button>
        <button type="button" class="btn btn--ghost" data-act="menu">Main menu</button>
      </div>`;
    this._deathEl.dataset.cause = cause.kind;
    this._openOverlay(this._deathEl);
    if (this._helpOpen) this.toggleHelp(false);
    this._focusLater(this._deathEl.querySelector("[data-act='respawn']"), 900);
  }

  /** Hide the death screen. */
  hideDeath() {
    if (!this._death.open) return;
    this._death = { open: false, onRespawn: null, onMenu: null };
    this._closeOverlay(this._deathEl);
  }

  /**
   * Pause menu.
   * @param {() => void} onResume
   * @param {() => void} onQuit back to the title screen
   * @param {() => void} [onSettings] shows a Settings item when given (main → menu.showSettings())
   */
  showPause(onResume = null, onQuit = null, onSettings = null) {
    this._pause = { open: true, onResume, onQuit, onSettings };
    this._pauseEl.querySelector("[data-act='settings']").hidden = typeof onSettings !== "function";
    this._pauseNotes.textContent = this._fieldNotes();
    this._openOverlay(this._pauseEl);
    this._focusLater(this._pauseEl.querySelector("[data-act='resume']"));
  }

  /** Hide the pause menu (main calls this on resume too). */
  hidePause() {
    if (!this._pause.open) return;
    this._pause = { open: false, onResume: null, onQuit: null, onSettings: null };
    this._closeOverlay(this._pauseEl);
    if (this._pauseEl.contains(document.activeElement)) document.activeElement.blur();
  }

  /**
   * Show / hide the field-notes help panel (controls + survival tips).
   * @param {boolean} [force] open (true) or close (false); toggles when omitted
   */
  toggleHelp(force) {
    const open = typeof force === "boolean" ? force : !this._helpOpen;
    if (open === this._helpOpen) return;
    this._helpOpen = open;
    if (open) this._openOverlay(this._helpEl);
    else this._closeOverlay(this._helpEl);
  }

  /** True while the pause / death / help overlay is open. */
  get paused() {
    return this._pause.open;
  }

  /** Remove DOM, listeners and subscriptions. */
  dispose() {
    this.bindEvents(null);
    this._ac.abort();
    this._ro?.disconnect();
    for (const t of this._toasts) clearTimeout(t.timer);
    this.el.remove();
    this._layer.remove();
  }

  /* --- Construction --- */

  _build() {
    const el = document.createElement("div");
    el.className = `hud${this.isTouch ? " hud--touch" : ""}`;
    el.setAttribute("aria-hidden", "true");
    const vital = (key, label, ico) => `
      <div class="vital vital--${key}" role="meter" aria-label="${label}" aria-valuemin="0" aria-valuemax="100" aria-valuenow="100">
        <span class="vital__ico">${icon(ico)}</span>
        <span class="vital__track"><i class="vital__ghost"></i><i class="vital__fill"></i></span>
        <span class="vital__num">100</span>
      </div>`;
    const chip = (key, label, ico) => `<span class="chip chip--${key}" data-chip="${key}" hidden>${icon(ico)}<span>${label}</span></span>`;
    el.innerHTML = `
      <div class="hud__fx hud__fx--hurt" aria-hidden="true"></div>
      <div class="hud__fx hud__fx--low" aria-hidden="true"></div>
      <div class="hud__scrim hud__scrim--top" aria-hidden="true"></div>
      <div class="hud__scrim hud__scrim--bottom" aria-hidden="true"></div>
      <div class="hud__markers" aria-hidden="true"></div>
      <div class="compass" aria-hidden="true">
        <div class="compass__window">
          <div class="compass__strip">${compassStripSVG()}</div>
          <div class="compass__pins"></div>
        </div>
        <span class="compass__caret"></span>
        <span class="compass__readout">N 000°</span>
      </div>
      <div class="hud__id">
        <p class="hud__species"></p>
        <div class="growth" role="meter" aria-label="Growth" aria-valuemin="0" aria-valuemax="100" aria-valuenow="0">
          <div class="growth__row"><span class="growth__stage">Juvenile</span><span class="growth__pct">0%</span></div>
          <div class="growth__track"><i class="growth__fill"></i><i class="growth__tick" title="Sub-adult"></i></div>
        </div>
      </div>
      <div class="hud__clock" aria-hidden="true">
        <span class="clock__ico">${icon("sun")}</span>
        <span class="clock__time">--:--</span>
        <span class="clock__day">Day 1</span>
      </div>
      <div class="hud__toasts" role="status" aria-live="polite"></div>
      <div class="hud__prompt" aria-live="polite"><span class="prompt"></span></div>
      <div class="hud__status">
        <div class="chips">
          ${chip("bleeding", "Bleeding", "bleed")}${chip("leg", "Broken leg", "fracture")}${chip("resting", "Resting", "rest")}
          ${chip("swimming", "Swimming", "waves")}${chip("crouched", "Crouched", "crouch")}${chip("night", "Night", "moon")}
        </div>
        <div class="vitals">
          ${vital("health", "Health", "heart")}${vital("stamina", "Stamina", "bolt")}
          ${vital("food", "Food", "meat")}${vital("water", "Water", "drop")}
        </div>
      </div>`;
    this.el = el;
    this.root.appendChild(el);

    const $ = (s) => el.querySelector(s);
    this._fxHurt = $(".hud__fx--hurt");
    this._fxLow = $(".hud__fx--low");
    this._markerBox = $(".hud__markers");
    this._compassWin = $(".compass__window");
    this._compassStrip = $(".compass__strip");
    this._compassPins = $(".compass__pins");
    this._compassReadout = $(".compass__readout");
    this._speciesEl = $(".hud__species");
    this._growthEl = $(".growth");
    this._growthStage = $(".growth__stage");
    this._growthPct = $(".growth__pct");
    this._growthFill = $(".growth__fill");
    this._clockIco = $(".clock__ico");
    this._clockTime = $(".clock__time");
    this._clockDay = $(".clock__day");
    this._toastBox = $(".hud__toasts");
    this._promptWrap = $(".hud__prompt");
    this._prompt = $(".prompt");
    this._vitals = ["health", "stamina", "food", "water"].map((k) => {
      const v = $(`.vital--${k}`);
      return {
        key: k,
        el: v,
        ico: v.querySelector(".vital__ico"),
        fill: v.querySelector(".vital__fill"),
        ghost: v.querySelector(".vital__ghost"),
        num: v.querySelector(".vital__num"),
        value: -1,
        ghostV: 1,
        ghostShown: -1,
        hold: 0,
        n: -1,
        low: false,
        crit: false,
      };
    });
    this._chips = {};
    for (const c of el.querySelectorAll("[data-chip]")) this._chips[c.dataset.chip] = { el: c, on: false };

    // Water pin and a few threat pins on the compass.
    this._waterPin = document.createElement("span");
    this._waterPin.className = "compass__pin compass__pin--water";
    this._waterPin.innerHTML = icon("drop");
    this._compassPins.appendChild(this._waterPin);
    this._threatPins = [];
    for (let i = 0; i < 6; i++) {
      const t = document.createElement("span");
      t.className = "compass__pin compass__pin--threat";
      this._compassPins.appendChild(t);
      this._threatPins.push({ el: t, x: null, on: false });
    }
    this._waterPinState = { x: null, on: false, edge: false };
    this._markers = [];

    this._buildOverlays();
  }

  _buildOverlays() {
    const layer = document.createElement("div");
    layer.className = "hud-layer";
    layer.innerHTML = `
      <div class="ovl ovl--pause" role="dialog" aria-modal="true" aria-labelledby="hud-pause-title">
        <div class="pause">
          <p class="eyebrow pause__eyebrow">${icon("pause")}Paused</p>
          <h2 class="pause__title" id="hud-pause-title">The island holds its breath.</h2>
          <p class="pause__notes"></p>
          <nav class="pause__menu" aria-label="Pause menu">
            <button type="button" class="pause__item pause__item--primary" data-act="resume"><span>Resume</span>${this.isTouch ? "" : '<kbd class="kbd">Esc</kbd>'}</button>
            <button type="button" class="pause__item" data-act="settings"><span>Settings</span></button>
            <button type="button" class="pause__item" data-act="help"><span>Field notes &amp; controls</span>${this.isTouch ? "" : '<kbd class="kbd">H</kbd>'}</button>
            <button type="button" class="pause__item pause__item--quiet" data-act="quit"><span>Quit to title</span><small>Progress is saved</small></button>
          </nav>
        </div>
      </div>
      <div class="ovl ovl--help" role="dialog" aria-modal="false" aria-labelledby="hud-help-title">
        <aside class="help">
          <header class="help__head">
            <div><p class="eyebrow">Field notes</p><h2 class="help__title" id="hud-help-title">How to stay alive</h2></div>
            <button type="button" class="icon-btn" data-act="close-help" aria-label="Close field notes">${icon("close")}</button>
          </header>
          <div class="help__body">
            <ol class="tips">
              <li><b>Drink fresh water.</b> Lakes and rivers only — the sea is salt and makes it worse.</li>
              <li><b>Growth needs both.</b> Keep food and water above a quarter or you stop growing.</li>
              <li><b>Sniff often.</b> It reveals food, fresh water and whoever is near — red means danger.</li>
              <li><b>Crouch in cover.</b> Forests and night hide you; open plains and sprinting don't.</li>
              <li><b>Rest to heal.</b> Lying down mends wounds and slows bleeding — but you are exposed.</li>
            </ol>
            ${controlsSheetHTML({ isTouch: this.isTouch, hunter: false })}
          </div>
        </aside>
      </div>
      <div class="ovl ovl--death" role="alertdialog" aria-modal="true" aria-labelledby="hud-death-title">
        <div class="death__veil" aria-hidden="true"></div>
        <div class="death__inner"></div>
      </div>`;
    this.root.appendChild(layer);
    this._layer = layer;
    this._pauseEl = layer.querySelector(".ovl--pause");
    this._pauseNotes = layer.querySelector(".pause__notes");
    this._helpEl = layer.querySelector(".ovl--help");
    this._deathEl = layer.querySelector(".ovl--death");
    for (const o of [this._pauseEl, this._helpEl, this._deathEl]) this._closeOverlay(o);

    layer.addEventListener("click", (e) => {
      const t = e.target.closest("[data-act]");
      if (!t) return;
      const act = t.dataset.act;
      if (act === "resume") this._resume();
      else if (act === "quit") this._call(this._pause.onQuit);
      else if (act === "settings") this._call(this._pause.onSettings);
      else if (act === "help") this.toggleHelp(true);
      else if (act === "close-help") this.toggleHelp(false);
      else if (act === "respawn") this._call(this._death.onRespawn);
      else if (act === "menu") this._call(this._death.onMenu);
    });
  }

  /* --- Per-frame pieces --- */

  _setPlayer(p) {
    this._player = p;
    this._low = { food: 0, water: 0 };
    const sp = p?.species;
    const key = sp ? `${sp.id}|${sp.diet}` : null;
    if (key === this._speciesKey) return;
    this._speciesKey = key;
    this._speciesEl.textContent = sp?.name || "";
    // Carnivores eat meat, herbivores browse: the food icon follows the diet.
    const food = this._vitals[2];
    food.ico.innerHTML = icon(sp?.diet === "herbivore" ? "leaf" : "meat");
    food.el.setAttribute("aria-label", sp?.diet === "herbivore" ? "Food (plants)" : "Food (meat)");
  }

  _updateVitals(p, world, dt) {
    const maxH = Math.max(1, Number(p.maxHealth) || 100);
    const hf = clamp((Number(p.health) || 0) / maxH, 0, 1);
    const food = clamp((Number(p.food) || 0) / 100, 0, 1);
    const water = clamp((Number(p.water) || 0) / 100, 0, 1);
    this._setVital(this._vitals[0], hf, dt, 0.3, 0.15);
    this._setVital(this._vitals[1], clamp((Number(p.stamina) || 0) / 100, 0, 1), dt, 0.2, 0.06);
    this._setVital(this._vitals[2], food, dt, 0.25, 0.1);
    this._setVital(this._vitals[3], water, dt, 0.25, 0.1);

    const bleeding = (Number(p.bleeding) || 0) > 0.01;
    const c = this._c;
    if (bleeding !== c.bleeding) {
      c.bleeding = bleeding;
      this._vitals[0].el.classList.toggle("is-bleeding", bleeding);
    }

    // Growth: stage, percent and a fill with a tick at the sub-adult threshold.
    const g = clamp(Number(p.growth) || 0, 0, 1);
    const gq = Math.round(g * 1000);
    if (gq !== c.growth) {
      c.growth = gq;
      this._growthFill.style.transform = `scaleX(${(gq / 1000).toFixed(3)})`;
      const pct = Math.floor(g * 100);
      if (pct !== c.growthPct) {
        c.growthPct = pct;
        this._growthPct.textContent = `${pct}%`;
        this._growthEl.setAttribute("aria-valuenow", String(pct));
      }
    }
    const stage = p.stage || stageOf(g);
    if (stage !== c.stage) {
      c.stage = stage;
      this._growthStage.textContent = STAGE_LABEL[stage] || stage;
      this._growthEl.dataset.stage = stage;
    }

    // Status chips.
    this._chip("bleeding", bleeding);
    this._chip("leg", (Number(p.legBroken) || 0) > 0);
    this._chip("resting", Boolean(p.resting));
    this._chip("swimming", Boolean(p.swimming));
    this._chip("crouched", Boolean(p.crouching) && !p.resting);
    const sky = world?.sky;
    this._chip("night", Boolean(sky && (typeof sky.isNight === "function" ? sky.isNight() : sky.daylight < 0.25)));

    // Low food / water warnings, once per threshold crossing.
    const herb = p.species?.diet === "herbivore";
    this._lowCheck("food", food, herb ? "Hungry — browse ferns, cycads, horsetails" : "Hungry — find a carcass or something weaker", herb ? "Starving — eat now" : "Starving — you need meat now", herb ? "leaf" : "meat");
    this._lowCheck("water", water, "Thirsty — find a lake or river", "Dehydrating — drink now", "drop");
  }

  _setVital(v, val, dt, lowT, critT) {
    if (Math.abs(val - v.value) > 0.0005) {
      v.value = val;
      v.fill.style.transform = `scaleX(${val.toFixed(4)})`;
    }
    // The ghost bar trails sudden losses so a bite reads as a chunk, then catches up.
    if (val >= v.ghostV) {
      v.ghostV = val;
      v.hold = 0;
    } else {
      v.hold += dt;
      if (v.hold > 0.5) v.ghostV = damp(v.ghostV, val, 4, dt);
    }
    if (Math.abs(v.ghostV - v.ghostShown) > 0.002) {
      v.ghostShown = v.ghostV;
      v.ghost.style.transform = `scaleX(${v.ghostV.toFixed(4)})`;
    }
    const low = val < lowT;
    const crit = val < critT;
    if (low !== v.low) {
      v.low = low;
      v.el.classList.toggle("is-low", low);
    }
    if (crit !== v.crit) {
      v.crit = crit;
      v.el.classList.toggle("is-critical", crit);
    }
    const n = Math.round(val * 100);
    if (n !== v.n) {
      v.n = n;
      v.num.textContent = String(n);
      v.el.setAttribute("aria-valuenow", String(n));
    }
  }

  _chip(key, on) {
    const c = this._chips[key];
    if (!c || c.on === on) return;
    c.on = on;
    c.el.hidden = !on;
  }

  _lowCheck(key, val, warn, danger, ico) {
    const st = this._low[key];
    if (val > 0.35) {
      this._low[key] = 0;
    } else if (val < 0.1 && st < 2) {
      this._low[key] = 2;
      this.toast(danger, "danger", ico);
    } else if (val < 0.25 && st < 1) {
      this._low[key] = 1;
      this.toast(warn, "warn", ico);
    }
  }

  _updateCompass(cam, p) {
    let yaw = null;
    if (cam) {
      cam.getWorldDirection(_dir);
      if (_dir.x * _dir.x + _dir.z * _dir.z > 1e-6) yaw = Math.atan2(_dir.x, _dir.z);
    }
    if (yaw === null && p) yaw = Number(p.heading) || 0;
    if (yaw === null) return;
    const b = bearingOf(yaw);
    const c = this._c;
    const bq = Math.round(b * 10) / 10;
    if (bq !== c.bearing) {
      c.bearing = bq;
      const x = -(bq + 360) * PX_PER_DEG + this._compassW / 2;
      this._compassStrip.style.transform = `translate3d(${x.toFixed(1)}px,0,0)`;
      const deg = Math.round(bq) % 360;
      if (deg !== c.bearingDeg) {
        c.bearingDeg = deg;
        this._compassReadout.textContent = `${cardinalOf(deg)} ${String(deg).padStart(3, "0")}°`;
      }
    }

    // Remembered water pin (fades after a while) and live threat pins.
    const w = this._water;
    const wOn = Boolean(w && p && w.age < WATER_PIN_MEMORY);
    let wx = null;
    let wEdge = false;
    if (wOn) {
      const rel = relDeg(b, bearingOf(Math.atan2(w.x - p.position.x, w.z - p.position.z)));
      // Clamp inside the opaque middle of the masked compass window.
      const half = this._compassW / 2 - 56;
      wx = clamp(rel * PX_PER_DEG, -half, half);
      wEdge = Math.abs(rel * PX_PER_DEG) > half;
      wx = Math.round(wx + this._compassW / 2);
    }
    const ws = this._waterPinState;
    if (wOn !== ws.on) {
      ws.on = wOn;
      this._waterPin.classList.toggle("is-on", wOn);
    }
    if (wOn && wx !== ws.x) {
      ws.x = wx;
      this._waterPin.style.transform = `translate3d(${wx}px,0,0)`;
    }
    if (wOn && wEdge !== ws.edge) {
      ws.edge = wEdge;
      this._waterPin.classList.toggle("is-edge", wEdge);
    }
    if (wOn) {
      const fade = 1 - smoothstep(WATER_PIN_MEMORY - 15, WATER_PIN_MEMORY, w.age);
      const fq = Math.round(fade * 20) / 20;
      if (fq !== ws.fade) {
        ws.fade = fq;
        this._waterPin.style.opacity = String(fq);
      }
    }
  }

  _setThreatPins(list, b, p) {
    let n = 0;
    if (p && list) {
      const half = this._compassW / 2 - 56;
      for (let i = 0; i < list.length && n < this._threatPins.length; i++) {
        const m = list[i];
        if (m.kind !== "creature" || !m.threat) continue;
        const rel = relDeg(b, bearingOf(Math.atan2(m.x - p.position.x, m.z - p.position.z)));
        const pin = this._threatPins[n++];
        const x = Math.round(clamp(rel * PX_PER_DEG, -half, half) + this._compassW / 2);
        if (!pin.on) {
          pin.on = true;
          pin.el.classList.add("is-on");
        }
        if (x !== pin.x) {
          pin.x = x;
          pin.el.style.transform = `translate3d(${x}px,0,0)`;
        }
      }
    }
    for (let i = n; i < this._threatPins.length; i++) {
      const pin = this._threatPins[i];
      if (pin.on) {
        pin.on = false;
        pin.el.classList.remove("is-on");
      }
    }
  }

  _updateClock(sky) {
    if (!sky) return;
    const c = this._c;
    const time = typeof sky.clockString === "function" ? sky.clockString() : "";
    if (time !== c.time) {
      c.time = time;
      this._clockTime.textContent = time;
    }
    const day = sky.day ?? 1;
    if (day !== c.day) {
      c.day = day;
      this._clockDay.textContent = `Day ${day}`;
    }
    const label = typeof sky.timeLabel === "function" ? sky.timeLabel() : "";
    const night = typeof sky.isNight === "function" ? sky.isNight() : sky.daylight < 0.25;
    const phase = night ? "night" : label === "dawn" || label === "dusk" ? "twilight" : "day";
    if (phase !== c.phase) {
      c.phase = phase;
      this._clockIco.innerHTML = icon(phase === "night" ? "moon" : phase === "twilight" ? "dawn" : "sun");
      this._clockIco.parentElement.dataset.phase = phase;
    }
  }

  _updatePrompt(text) {
    const c = this._c;
    if (text === c.prompt) return;
    c.prompt = text;
    // Keep the old text while fading out, so it doesn't blank mid-transition.
    if (text) this._prompt.innerHTML = formatPrompt(text, this.isTouch);
    this._promptWrap.classList.toggle("is-on", Boolean(text));
  }

  _updateMarkers(sniff, cam, p, dt) {
    const list = sniff && Array.isArray(sniff.markers) ? sniff.markers : null;
    const active = Boolean(list && list.length && (sniff.active || (sniff.timeLeft ?? 0) > 0));
    // Fade in on a fresh sniff; fade out over the last second and a half.
    const target = active ? clamp((sniff.timeLeft ?? 2) / 1.5, 0, 1) : 0;
    this._sniffAlpha = target > this._sniffAlpha ? damp(this._sniffAlpha, target, 10, dt) : target;
    if (active) {
      const water = list.find((m) => m.kind === "water");
      if (water) this._water = { x: water.x, z: water.z, age: 0 };
    }
    this._setThreatPins(active ? list : null, this._c.bearing ?? 0, p);

    let used = 0;
    if (active && cam && this._sniffAlpha > 0.01) {
      cam.updateMatrixWorld();
      const W = this._vw;
      const H = this._vh;
      const margin = Math.min(64, W * 0.08);
      for (let i = 0; i < list.length && used < MARKER_POOL_MAX; i++) {
        const m = list[i];
        if (!Number.isFinite(m.x) || !Number.isFinite(m.z)) continue;
        const mk = this._marker(used++);
        const kind = MARKER_ICON[m.kind] ? m.kind : "creature";
        _v.set(m.x, (Number(m.y) || 0) + (MARKER_LIFT[kind] || 1), m.z);
        _cam.copy(_v).applyMatrix4(cam.matrixWorldInverse);
        const behind = _cam.z > -0.2;
        _v.project(cam);
        let sx;
        let sy;
        let edge = false;
        let ang = 0;
        if (!behind && Math.abs(_v.x) <= 0.92 && Math.abs(_v.y) <= 0.88) {
          sx = (_v.x * 0.5 + 0.5) * W;
          sy = (-_v.y * 0.5 + 0.5) * H;
        } else {
          // Off-screen: pin to an inset frame along the direction to the target.
          edge = true;
          let dx = _cam.x;
          let dy = _cam.y;
          if (behind && Math.abs(dx) < 1e-3) dx = 1e-3;
          if (behind) dy = Math.min(dy, 0); // targets behind you read best along the bottom
          const len = Math.hypot(dx, dy) || 1;
          dx /= len;
          dy /= len;
          const t = Math.min((W / 2 - margin) / Math.max(1e-4, Math.abs(dx)), (H / 2 - margin) / Math.max(1e-4, Math.abs(dy)));
          sx = W / 2 + dx * t;
          sy = H / 2 - dy * t;
          ang = Math.atan2(-dy, dx);
        }
        // Declutter (herds and kills cluster): slide a pin sideways off another
        // pin, then set its label below, above or — last resort — drop it.
        for (let tries = 0; tries < 4 && overlapsPlaced(used - 1, sx, 16, sy - 16, sy + 16); tries++) sx += 34;
        let lab = 0;
        if (overlapsPlaced(used - 1, sx, 46, sy + 17, sy + 48)) lab = overlapsPlaced(used - 1, sx, 46, sy - 48, sy - 17) ? 2 : 1;
        const o = (used - 1) * 4;
        _boxes[o] = sx;
        _boxes[o + 1] = lab === 2 ? 16 : 46;
        _boxes[o + 2] = lab === 1 ? sy - 48 : sy - 16;
        _boxes[o + 3] = lab === 0 ? sy + 48 : sy + 16;
        const d = p?.position ? Math.hypot(m.x - p.position.x, m.z - p.position.z) : cam.position.distanceTo(_v.set(m.x, m.y || 0, m.z));
        const alpha = this._sniffAlpha * (1 - smoothstep(110, 160, d) * 0.45);
        this._placeMarker(mk, m, kind, sx, sy, edge, ang, d, alpha, lab);
      }
    }
    for (let i = used; i < this._markersShown; i++) {
      const mk = this._markers[i];
      if (mk.on) {
        mk.on = false;
        mk.el.classList.remove("is-on");
      }
    }
    this._markersShown = used;
  }

  _marker(i) {
    let mk = this._markers[i];
    if (mk) return mk;
    const el = document.createElement("div");
    el.className = "mk";
    el.innerHTML = '<i class="mk__arrow"></i><span class="mk__pin"></span><span class="mk__label"><span class="mk__name"></span><span class="mk__dist"></span></span>';
    this._markerBox.appendChild(el);
    mk = {
      el,
      pin: el.querySelector(".mk__pin"),
      arrow: el.querySelector(".mk__arrow"),
      name: el.querySelector(".mk__name"),
      dist: el.querySelector(".mk__dist"),
      on: false,
      kind: "",
      threat: null,
      edge: null,
      label: "",
      d: -1,
      x: 0,
      y: 0,
      a: -1,
      ang: null,
      lab: 0,
    };
    this._markers[i] = mk;
    return mk;
  }

  _placeMarker(mk, m, kind, sx, sy, edge, ang, d, alpha, lab) {
    if (!mk.on) {
      mk.on = true;
      mk.el.classList.add("is-on");
    }
    if (kind !== mk.kind) {
      mk.el.classList.remove(`mk--${mk.kind}`);
      mk.el.classList.add(`mk--${kind}`);
      mk.kind = kind;
      mk.pin.innerHTML = icon(MARKER_ICON[kind]);
    }
    const threat = Boolean(m.threat);
    if (threat !== mk.threat) {
      mk.threat = threat;
      mk.el.classList.toggle("mk--threat", threat);
      if (kind === "creature") mk.pin.innerHTML = icon(threat ? "claw" : "track");
    }
    if (edge !== mk.edge) {
      mk.edge = edge;
      mk.el.classList.toggle("mk--edge", edge);
    }
    if (lab !== mk.lab) {
      mk.lab = lab;
      mk.el.classList.toggle("mk--above", lab === 1);
      mk.el.classList.toggle("mk--nolabel", lab === 2);
    }
    const label = m.label || MARKER_NAME[kind];
    if (label !== mk.label) {
      mk.label = label;
      mk.name.textContent = label;
    }
    const dq = d < 100 ? Math.round(d) : Math.round(d / 5) * 5;
    if (dq !== mk.d) {
      mk.d = dq;
      mk.dist.textContent = `${dq} m`;
    }
    const x = Math.round(sx);
    const y = Math.round(sy);
    if (x !== mk.x || y !== mk.y) {
      mk.x = x;
      mk.y = y;
      mk.el.style.transform = `translate3d(${x}px,${y}px,0)`;
    }
    if (edge) {
      const aq = Math.round(ang * 50) / 50;
      if (aq !== mk.ang) {
        mk.ang = aq;
        mk.arrow.style.transform = `rotate(${aq}rad)`;
      }
    }
    const a = Math.round(alpha * 40) / 40;
    if (a !== mk.a) {
      mk.a = a;
      mk.el.style.opacity = String(a);
    }
  }

  _updateVignettes(p, dt) {
    const c = this._c;
    this._hurt = Math.max(0, this._hurt - dt * (0.9 + this._hurt * 1.6));
    const flash = Math.max(this._hurt, clamp(Number(p?.hurt) || 0, 0, 1) * 0.5);
    const hq = Math.round(flash * 50) / 50;
    if (hq !== c.hurt) {
      c.hurt = hq;
      this._fxHurt.style.opacity = String(hq);
    }
    let low = 0;
    if (p && p.alive !== false) {
      const hf = clamp((Number(p.health) || 0) / Math.max(1, Number(p.maxHealth) || 100), 0, 1);
      low = 1 - smoothstep(0.1, 0.38, hf);
    }
    const lq = Math.round(low * 40) / 40;
    if (lq !== c.low) {
      c.low = lq;
      this._fxLow.style.opacity = String(lq);
      this._fxLow.classList.toggle("is-beating", lq > 0.45);
    }
  }

  /* --- Events --- */

  _onDamage(e) {
    if (!e || !e.target || e.target !== this._player) return;
    const maxH = Math.max(1, Number(e.target.maxHealth) || 100);
    const amount = Math.max(0, Number(e.amount) || 0);
    if (SLOW_DAMAGE.has(e.type)) {
      // Starving / bleeding tick constantly — a slow throb, not a strobe.
      const now = performance.now();
      if (now - this._lastSlowHurt < 1600) return;
      this._lastSlowHurt = now;
      this._hurt = Math.min(1, this._hurt + 0.2);
      return;
    }
    this._hurt = Math.min(1, this._hurt + 0.35 + (amount / maxH) * 2.5);
  }

  _onDeathEvent(e) {
    const p = this._player;
    if (!e || !p || e.creature === p || e.killer !== p) return;
    const v = e.creature;
    const name = v?.species?.name || "animal";
    const stage = (STAGE_LABEL[v?.stage || stageOf(v?.growth ?? 1)] || "").toLowerCase();
    this.toast(`Killed ${article(stage)} ${stage} ${name}`, "good", "claw");
  }

  _onGrow(e) {
    if (!e || e.creature !== this._player) return;
    const name = this._player?.species?.name || "";
    if (e.stage === "adult") this.toast(`Fully grown — an adult ${name}`, "good", "egg");
    else if (e.stage === "subadult") this.toast("Sub-adult — stronger, and harder to ignore", "good", "egg");
  }

  _onKey(e) {
    if (e.defaultPrevented) return;
    // A menu dialog (settings over the pause screen) owns the keyboard while open.
    if (this.root.querySelector(".layer.is-open")) return;
    const swallow = () => {
      e.preventDefault();
      e.stopImmediatePropagation();
    };
    if (this._helpOpen && (e.code === "Escape" || e.code === "KeyH")) {
      swallow();
      if (!e.repeat) this.toggleHelp(false);
      return;
    }
    if (this._pause.open) {
      if (e.code === "Escape" || e.code === "KeyP") {
        swallow();
        if (!e.repeat) this._resume();
      } else if (e.code === "KeyH") {
        swallow();
        if (!e.repeat) this.toggleHelp(true);
      } else if (e.key === "Tab") {
        trapTab(e, this._pauseEl);
      }
      return;
    }
    if (this._death.open && e.key === "Tab") trapTab(e, this._deathEl);
  }

  /* --- Overlay plumbing --- */

  _resume() {
    const fn = this._pause.onResume;
    this.hidePause();
    this._call(fn);
  }

  _call(fn) {
    if (typeof fn === "function") fn();
  }

  _openOverlay(el) {
    el.removeAttribute("inert");
    el.setAttribute("aria-hidden", "false");
    requestAnimationFrame(() => el.classList.add("is-open"));
  }

  _closeOverlay(el) {
    el.classList.remove("is-open");
    el.setAttribute("inert", "");
    el.setAttribute("aria-hidden", "true");
  }

  _focusLater(el, delay = 0) {
    if (!el) return;
    setTimeout(() => requestAnimationFrame(() => el.isConnected && el.focus({ preventScroll: true })), delay);
  }

  _dropToast(t) {
    if (t.leaving) return;
    t.leaving = true;
    clearTimeout(t.timer);
    t.el.classList.add("is-leaving");
    setTimeout(() => {
      t.el.remove();
      const i = this._toasts.indexOf(t);
      if (i >= 0) this._toasts.splice(i, 1);
    }, 420);
  }

  /** One-line field notes for the pause screen: species, stage, day, time. */
  _fieldNotes() {
    const p = this._player;
    const bits = [];
    if (p?.species?.name) {
      const g = clamp(Number(p.growth) || 0, 0, 1);
      bits.push(`${p.species.name} · ${STAGE_LABEL[p.stage || stageOf(g)]}, ${Math.floor(g * 100)}% grown`);
    }
    if (this._c.day) bits.push(`Day ${this._c.day}${this._c.time ? `, ${this._c.time}` : ""}`);
    return bits.join("  ·  ");
  }

  _measure() {
    const r = this.root.getBoundingClientRect();
    this._vw = Math.max(1, r.width || window.innerWidth || 1);
    this._vh = Math.max(1, r.height || window.innerHeight || 1);
    const cw = this._compassWin.clientWidth;
    if (cw > 0 && cw !== this._compassW) {
      this._compassW = cw;
      this._c.bearing = null; // re-centre the strip at the new width
    }
  }
}

