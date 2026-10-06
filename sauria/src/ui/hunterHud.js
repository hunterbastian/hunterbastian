// Hunter-mode HUD — the first-person overlay for a Carnivores-style hunt:
// crosshair, hit marker, ammo, compass with wind, health / stamina slivers,
// the stealth meter, scope and binocular overlays, radar, trophy tags,
// extraction status, damage vignette and toasts — plus the end-of-hunt
// expedition report and the death card.
//
// Visual language: field-survey instruments over a living island — brass,
// olive drab, paper trophy tags, mono rangefinder numerals — restrained, and
// built on the same design tokens as the survival UI (style.css).
//
// Performance: the DOM is built once. update() reads the game state,
// quantises it, and touches the DOM only when a value actually changes;
// everything that moves (crosshair gap, compass strip, radar blips, bar
// fills) is a transform or a single custom property.

import * as THREE from "three";
import { clamp, damp, remap } from "../core/math.js";
import { icon, escapeHtml, formatMass, formatDuration, article, speciesSilhouette } from "./menu.js";

/* --- Constants --- */

const PX_PER_DEG = 2.4; // compass strip scale (same as the survival compass)
const CARDINALS = ["N", "NE", "E", "SE", "S", "SW", "W", "NW"];
const RANGEFINDER_INTERVAL = 0.2; // s — ~5 Hz is plenty for a readout and keeps raycasts cheap
const RANGEFINDER_MAX = 1500; // m
const RADAR_RANGE = 600; // m, the HuntSession ping radius
const RADAR_FADE = 11; // s for a blip to fade to its floor (pings come every ~10 s)
const BLIP_POOL = 32;
const TOAST_LIFE = 4.2; // s
const TROPHY_LIFE = 7; // s
const MAX_TOASTS = 3;
const WIND_MS_PER_STRENGTH = 9; // fallback when wind.speed is missing
const PIP_MAX = 8;
const RING_C = 2 * Math.PI * 9; // reload ring circumference (r = 9)

/** Display names for weapon ids (fallback when the defs aren't handed in). */
export const WEAPON_NAMES = {
  revolver: ".44 Revolver",
  shotgun: "Double-Barrel 12ga",
  crossbow: "Crossbow",
  rifle: "Bolt-Action Rifle",
  sniper: ".50 Sniper Rifle",
};

/* --- Icons & glyphs --- */

// Hunter-specific 24×24 line icons, drawn like the survival set (class "ico").
const HICON_PATHS = {
  lock: '<rect x="5" y="10.5" width="14" height="10" rx="2"/><path d="M8 10.5V7.8a4 4 0 0 1 8 0v2.7"/>',
  camo:
    '<path d="M12 3.5 4.5 6.8v5.4c0 4.3 3.1 7.4 7.5 8.8 4.4-1.4 7.5-4.5 7.5-8.8V6.8z"/>' +
    '<path d="M8.4 9.6c1.6.3 2.4 1.4 2.3 3M14.6 8.4c-.4 1.8.3 3 2 3.6M9.6 15.8c1.3-.8 2.8-.8 4.1.4"/>',
  radar:
    '<circle cx="12" cy="12" r="8.6"/><circle cx="12" cy="12" r="4.4"/><path d="M12 12 18.1 5.9"/>' +
    '<circle class="f" cx="15.6" cy="14.6" r="1.4"/>',
  binoculars:
    '<circle cx="6.8" cy="15.6" r="3.9"/><circle cx="17.2" cy="15.6" r="3.9"/>' +
    '<path d="M3.9 13 5.8 5.4h3.1l1.1 7.4M20.1 13 18.2 5.4h-3.1L14 12.8M10.4 14.2h3.2"/>',
  heli:
    '<path d="M2.5 5.2h15.5M10.2 5.2v3.1"/><path d="M5.2 12.6c0-2.3 1.9-4.3 4.3-4.3h3.4c2.9 0 5.2 2.3 5.2 5.2v.6H8.1c-1.6 0-2.9-.6-2.9-1.5z"/>' +
    '<path d="M18.1 13.2h3.4V9.6M8.4 14.1v3.6M14.8 14.1v3.6M5.4 17.7h12.4"/>',
  target: '<circle cx="12" cy="12" r="7.4"/><circle cx="12" cy="12" r="2.2"/><path d="M12 2.4v4.2M12 17.4v4.2M2.4 12h4.2M17.4 12h4.2"/>',
  wind: '<path d="M3 8.4h10.6a2.6 2.6 0 1 0-2.6-2.6"/><path d="M3 12.4h15.2a3 3 0 1 1-3 3"/><path d="M3 16.4h7.4"/>',
  eye: '<path d="M2.5 12S6 5.6 12 5.6 21.5 12 21.5 12 18 18.4 12 18.4 2.5 12 2.5 12z"/><circle cx="12" cy="12" r="3"/>',
  ledger:
    '<path d="M5 4.5h11.6A2.4 2.4 0 0 1 19 6.9v12.6H7.4A2.4 2.4 0 0 1 5 17.1z"/><path d="M5 17.1a2.4 2.4 0 0 1 2.4-2.4H19M9 8.4h6"/>',
  dusk: '<path d="M3 17.5h18M6.5 17.5a5.5 5.5 0 0 1 11 0"/><path d="M12 3.5v4.8M9.7 6l2.3 2.3L14.3 6M3 21h18"/>',
  check: '<path d="M5 12.6 9.6 17 19 7.6"/>',
  reload: '<path d="M19.4 12a7.4 7.4 0 1 1-2.2-5.3"/><path d="M19.6 4.4v4.3h-4.3"/>',
  shell: '<path d="M9.6 21V9.4c0-2.6 1.1-4.6 2.4-6.1 1.3 1.5 2.4 3.5 2.4 6.1V21z"/><path d="M9.6 17.6h4.8"/>',
  arrowUp: '<path d="M12 19.5V5"/><path d="M6.5 10.5 12 5l5.5 5.5"/>',
  danger: '<path d="M12 4 21 19.5H3z"/><path d="M12 10v4.4M12 17h.01"/>',
};

/**
 * Inline SVG for a hunter icon (falls back to the survival icon set).
 * @param {string} name
 * @param {string} [cls]
 * @returns {string}
 */
export function hicon(name, cls = "") {
  const p = HICON_PATHS[name];
  if (!p) return icon(name, cls);
  return `<svg class="ico${cls ? ` ${cls}` : ""}" viewBox="0 0 24 24" aria-hidden="true" focusable="false">${p}</svg>`;
}

// Side-profile gun drawings (muzzle right) in a shared 160×40 box so the
// weapons read at true relative size. Wood parts carry class "w".
const GUN_ART = {
  revolver:
    '<path class="w" d="M61.5 20.5c-2.8 4.4-5.4 9.6-6.8 15.2l8.4 1.1c1-5 3.3-9.6 6.6-13.2z"/>' +
    '<rect x="60.5" y="11.2" width="18.5" height="11.6" rx="2.2"/>' +
    '<path d="M78 12.8h34.5v4.4H78zM78.6 17.2h21.6v2.8H78.6zM108.6 11.2h2.6v1.8h-2.6zM57.8 10.6l4.6-3 1.8 2.1-3 3.4z"/>' +
    '<path class="l" d="M65.6 22.8c.9 5.4 6.6 6.4 9.8.4"/><path class="l" d="M69.6 22.8c.5 2.4-.4 4-1.6 4.8"/>' +
    '<path class="cut" d="M63.6 14.2h12.6M63.6 17h12.6M63.6 19.8h12.6"/>',
  shotgun:
    '<path class="w" d="M4 21.4c0-2 1.2-3 3-3.1l39-1.8 9.6 1.4v5.6l-7.6 1c-3.8.5-6.6 3.4-8.8 6.6L9 33.8c-3 .3-5-.8-5-3z"/>' +
    '<path class="w" d="M71 20.8h33.6l-2.2 3.8H73.2z"/>' +
    '<rect x="53.6" y="15.2" width="17.4" height="8.6" rx="1.4"/>' +
    '<path d="M69 15h87v2.8H69zM69 18.1h85v2.6H69zM57.4 15.3l-3.2-3.6 2.2-1 3.6 3.8zM62 15.3l-3.2-3.6 2.2-1 3.6 3.8z"/>' +
    '<circle cx="154.4" cy="14.6" r="1"/><path class="l" d="M57.4 23.8c1 5 6.4 6 9.4.2"/>',
  crossbow:
    '<path class="w" d="M4 21c0-2.3 1.4-3 3.4-3.1l33.4-1.1 4 5.4-34.4 9.2C6.2 32.4 4 31 4 28.6z"/>' +
    '<path class="w" d="M43.6 20.6h8.6l-3.6 11.8h-7.8z"/>' +
    '<path d="M39.6 16.2h97v3.4h-97z"/>' +
    '<path class="l2" d="M133.6 2.6c-4.8 6.4-4.8 24.4 0 30.8"/>' +
    '<path class="l" d="M133.6 2.6 96 16.6M133.6 33.4 96 19.2"/>' +
    '<path class="l" d="M138 13.2c6 2.4 6 7.2 0 9.6"/>' +
    '<path d="M96 15h34l2.4.8-2.4.8H96zM96.4 13.8l4.4 1.2-4.4 1.2z"/>',
  rifle:
    '<path class="w" d="M4 21c0-2.6 1.4-2.8 3-2.8l33-1.2 10 2.5h8v4.3l-8 .6c-4.8.6-6.4 3-8.4 6.2L9 33.4c-3.2.4-5-.8-5-3z"/>' +
    '<path class="w" d="M58 19l54-.4v3c-12 2-30 2.2-54 2.4z"/>' +
    '<rect x="54" y="15.6" width="26.4" height="4.2" rx="1"/>' +
    '<path d="M100 17.1h56v2.3h-56z"/>' +
    '<path class="l" d="M72.4 19.6l-3.6 5"/><circle cx="68.4" cy="25.2" r="1.7"/>' +
    '<rect x="60" y="8.4" width="34" height="3.6" rx="1.6"/>' +
    '<path d="M92 8.6l6-2h6.2v7.4H98l-6-2zM53.6 7.4h7.2v5.6h-7.2zM74.2 6.2h4.2v2.4h-4.2zM64.4 12h3v3.8h-3zM85.4 12h3v3.8h-3z"/>' +
    '<path class="l" d="M60 24c1 4.8 6.4 5.8 9.4.2"/>',
  sniper:
    '<path d="M4 19.2l6-1.8 36.4-.4 9.6 2.4v4.6l-8 .4c-3.6.4-5.8 3-7.6 6.4l-30.4 1.6L6 33.2 4 31z"/>' +
    '<path class="w" d="M14 17.4h24v-3.2c-8 0-16 .8-24 3.2z"/>' +
    '<rect x="52" y="14.8" width="35" height="5.8" rx="1"/>' +
    '<path d="M70.4 20.6h8.2l-1.1 6.8h-6zM86 16.2h61v3h-61zM145.6 14.8h10.4v5.8h-10.4z"/>' +
    '<path class="cut" d="M148.6 15.6v4.2M151.4 15.6v4.2M154.2 15.6v4.2"/>' +
    '<rect x="57" y="6" width="42" height="4.6" rx="2"/>' +
    '<path d="M96 6.2l8-2.8h10.2v10H104l-8-2.6zM50.6 5h8v6.8h-8zM73.6 3.2h5v3h-5zM62.4 10.6h3.2v4.4h-3.2zM88.6 10.6h3.2v4.4h-3.2z"/>' +
    '<path class="l" d="M124 19.2l7.4 13.4M124 19.2l-3 13.8"/>' +
    '<path class="l" d="M58.4 20.6c.8 4.8 6.2 5.8 9.2.2"/>',
};

/**
 * Side-profile drawing of a weapon (SVG markup, class "hgun").
 * @param {string} id weapon id
 * @param {string} [cls] extra class names
 * @returns {string}
 */
export function weaponGlyph(id, cls = "") {
  const art = GUN_ART[id] || GUN_ART.rifle;
  return `<svg class="hgun${cls ? ` ${cls}` : ""}" viewBox="0 0 160 40" aria-hidden="true" focusable="false">${art}</svg>`;
}

/* --- Stylesheet --- */

let stylesPromise = null;

/**
 * Inject `hunter.css` once (resolved against document.baseURI). Resolves when it
 * has loaded (or failed — the UI then degrades to unstyled but working markup).
 * @returns {Promise<void>}
 */
export function ensureHunterStyles() {
  if (stylesPromise) return stylesPromise;
  if (typeof document === "undefined") return (stylesPromise = Promise.resolve());
  const href = new URL("hunter.css", document.baseURI).href;
  const settle = (link) =>
    new Promise((resolve) => {
      const done = () => resolve();
      link.addEventListener("load", done, { once: true });
      link.addEventListener("error", () => {
        console.warn("[hunterHud] hunter.css failed to load");
        done();
      }, { once: true });
      setTimeout(done, 2500); // never hold the UI hostage to a slow stylesheet
    });
  for (const l of document.querySelectorAll('link[rel="stylesheet"]')) {
    if (l.href === href) return (stylesPromise = l.sheet ? Promise.resolve() : settle(l));
  }
  const link = document.createElement("link");
  link.rel = "stylesheet";
  link.href = href;
  link.dataset.sauria = "hunter";
  stylesPromise = settle(link);
  document.head.appendChild(link);
  return stylesPromise;
}

/* --- Helpers --- */

/** Compass bearing in degrees [0, 360) for a heading yaw (yaw 0 = +Z = south; north = −Z). */
export const bearingOf = (yaw) => {
  const deg = ((Math.PI - yaw) * 180) / Math.PI;
  return ((deg % 360) + 360) % 360;
};
export const cardinalOf = (deg) => CARDINALS[Math.round(deg / 45) % 8];
const relDeg = (a, b) => ((((b - a) % 360) + 540) % 360) - 180;
const pad3 = (n) => String(Math.round(n) % 360).padStart(3, "0");
const fmtInt = (n) => Math.round(Number(n) || 0).toLocaleString("en-US");
const fmtDist = (m) => (m < 1000 ? `${Math.round(m)} m` : `${(m / 1000).toFixed(m < 10000 ? 1 : 0)} km`);
const fmtClock = (s) => {
  const t = Math.max(0, Math.round(s));
  return `${Math.floor(t / 60)}:${String(t % 60).padStart(2, "0")}`;
};
const NUMBER_WORDS = ["No", "One", "Two", "Three", "Four", "Five", "Six", "Seven", "Eight", "Nine", "Ten"];
const numberWord = (n) => NUMBER_WORDS[n] || fmtInt(n);

/** Rangefinder-style mass estimate: rounded so it reads as a field estimate, not a scale. */
function estimateMass(kg) {
  if (!(kg > 0)) return "—";
  if (kg < 100) return `~${Math.round(kg / 5) * 5} kg`;
  if (kg < 1000) return `~${Math.round(kg / 10) * 10} kg`;
  return `~${formatMass(Math.round(kg / 100) * 100)}`;
}

/** Current mass of a creature-like object (getter, or adult mass × scale³). */
function massOf(c) {
  const m = Number(c?.mass);
  if (Number.isFinite(m) && m > 0) return m;
  const adult = Number(c?.species?.mass) || 0;
  const s = Number(c?.scale);
  return adult * (Number.isFinite(s) ? s * s * s : 1);
}

/** A cause of death (string, killer creature, or summary fields) → headline text. */
function deathHeadline(summary, hunter) {
  const killer = summary?.killer || hunter?.lastAttacker;
  const cause = summary?.cause ?? hunter?.causeOfDeath;
  const killerName = typeof killer === "string" ? killer : killer?.species?.name || killer?.name;
  if (typeof cause === "string" && cause.trim()) {
    const c = cause.trim();
    if (/^(killed|bled|drown|fell|starv|dehydrat|died|mauled|trampled|gored)/i.test(c)) return c;
    if (/^[A-Z][a-z]+$/.test(c)) return `Killed by ${article(c)} ${c}`;
    if (!killerName) return c;
  }
  if (killerName) return `Killed by ${article(killerName)} ${killerName}`;
  return "Lost on the island";
}

const SVG_NS = "http://www.w3.org/2000/svg";
let uid = 0;

// Module-level temps: no allocation in update().
const _origin = new THREE.Vector3();
const _dir = new THREE.Vector3();

/* --- Compass strip --- */

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
  return `<svg class="hh-compass__svg" width="${w}" height="22" viewBox="0 0 ${w} 22" aria-hidden="true" focusable="false">${s}</svg>`;
}

/* --- Reticles --- */

// Drawn in a −100…100 box = the lens; thin lines use non-scaling strokes so they
// stay a crisp hairline at any lens size.
function duplexSVG() {
  return (
    `<svg class="hh-ret hh-ret--duplex" viewBox="-100 -100 200 200" aria-hidden="true" focusable="false">` +
    `<path class="hh-ret__post" d="M-100 -1.7H-30V1.7H-100zM30 -1.7H100V1.7H30zM-1.7 30H1.7V100H-1.7zM-1.7 -100H1.7V-30H-1.7z"/>` +
    `<path class="hh-ret__hair" d="M-30 0H30M0 -30V30"/>` +
    `</svg>`
  );
}

function mildotSVG() {
  let dots = "";
  for (let i = 1; i <= 5; i++) {
    const v = i * 9;
    dots += `<circle cx="${v}" cy="0" r="1.15"/><circle cx="${-v}" cy="0" r="1.15"/><circle cx="0" cy="${-v}" r="1.15"/>`;
  }
  // Ballistic holdover ticks below centre, labelled in hundreds of metres.
  let bdc = "";
  const drops = [[2, 9], [3, 17], [4, 27], [5, 39], [6, 54]];
  for (const [label, y] of drops) {
    const half = 3 + label * 0.9;
    bdc += `<path class="hh-ret__hair" d="M${-half} ${y}H${half}"/><text x="${half + 2.6}" y="${y + 1.9}">${label}</text>`;
  }
  return (
    `<svg class="hh-ret hh-ret--mildot" viewBox="-100 -100 200 200" aria-hidden="true" focusable="false">` +
    `<path class="hh-ret__post" d="M-100 -1.3H-62V1.3H-100zM62 -1.3H100V1.3H62zM-1.3 62H1.3V100H-1.3zM-1.3 -100H1.3V-62H-1.3z"/>` +
    `<path class="hh-ret__hair" d="M-62 0H62M0 -62V62"/>` +
    `<g class="hh-ret__dots">${dots}</g>` +
    `<g class="hh-ret__bdc">${bdc}</g>` +
    `<path class="hh-ret__hair hh-ret__range" d="M-58 30V44M-58 44H-44M-58 37H-52"/>` +
    `<text class="hh-ret__small" x="-58" y="27">RANGE</text>` +
    `</svg>`
  );
}

/* --- HunterHud --- */

export class HunterHud {
  /**
   * @param {HTMLElement} root UI root (the HUD appends its own layers)
   * @param {{ events?: object, isTouch?: boolean, weapons?: object }} [opts]
   *   `weapons` (optional) is the WEAPONS map, for weapon names in reports.
   */
  constructor(root, { events = null, isTouch = false, weapons = null } = {}) {
    this.root = root;
    this.events = events;
    this.isTouch = !!isTouch;
    this.weaponDefs = weapons;
    this.visible = false;

    this._uid = ++uid;
    this._offs = [];
    this._hunter = null;
    this._hunt = null;
    this._vw = 1;
    this._vh = 1;
    this._compassW = 360;
    this._radarR = 60;

    // Cached display state: the DOM is written only when one of these changes.
    this._c = {
      mode: "", gap: -1, crossA: -1, dotA: -1, bearing: -1, stripX: NaN, readout: "",
      windArrow: NaN, windText: "", windWarn: null, health: -1, stamina: -1, scent: -1, noise: -1, vis: -1,
      weapon: "", mag: -1, reserve: -1, magSize: -1, reloading: null, ring: -1, hint: "", slots: "",
      switching: null, targets: "", bag: "", radarOn: null, radarN: NaN, extract: "", extractSub: "",
      extractArrow: NaN, extractDist: "", extractPin: NaN, windPin: NaN, hurt: -1, low: -1, beating: null,
      scopeRet: "", scopePower: "", bino: "", binoRange: "", lowStam: null, riding: null,
    };

    this._hurt = 0;
    this._lastHealth = null;
    this._rangeTimer = 0;
    this._rangeHit = { distance: -1, name: "", mass: "", target: false, danger: false, down: false, kind: "" };
    this._blips = [];
    for (let i = 0; i < BLIP_POOL; i++) this._blips.push({ x: 0, z: 0, species: "", on: false });
    this._blipCount = 0;
    this._radarAge = 99;
    this._radarSeen = false;
    this._toasts = [];
    this._tags = [];
    this._extraction = null; // { state, eta }
    this._etaLocal = 0;
    this._report = { open: false, onAgain: null, onMenu: null, kind: "" };

    this._build();
    ensureHunterStyles().then(() => {
      this.el.hidden = false;
      this.reportEl.hidden = false;
      this._measure();
    });

    this._ac = new AbortController();
    window.addEventListener("keydown", (e) => this._onKey(e), { capture: true, signal: this._ac.signal });
    if (typeof ResizeObserver === "function") {
      this._ro = new ResizeObserver(() => this._measure());
      this._ro.observe(this.el);
    } else {
      window.addEventListener("resize", () => this._measure(), { signal: this._ac.signal });
    }
    this._bindEvents(events);
  }

  /* --- Public API --- */

  /** Show the in-play HUD. */
  show() {
    this.visible = true;
    this.el.classList.add("is-open");
    this._measure();
  }

  /** Hide the in-play HUD (reports are independent). */
  hide() {
    this.visible = false;
    this.el.classList.remove("is-open");
  }

  /**
   * Per-frame refresh. All arguments are optional and read defensively.
   * @param {number} dt seconds
   * @param {{ hunter?: object, controller?: object, weapons?: object, hunt?: object, world?: object, camera?: THREE.Camera }} ctx
   */
  update(dt, { hunter = null, controller = null, weapons = null, hunt = null, world = null, camera = null } = {}) {
    hunter = hunter || controller?.hunter || null;
    this._hunter = hunter;
    this._hunt = hunt;
    if (!this.visible) return;
    dt = Math.min(Math.max(dt || 0, 0), 0.1);
    const c = this._c;

    // Facing: the camera is truth (it includes look pitch/yaw); fall back to the actor heading.
    let yaw = Number(hunter?.heading) || 0;
    if (camera?.matrixWorld) {
      const m = camera.matrixWorld.elements;
      if (m[8] * m[8] + m[10] * m[10] > 1e-6) yaw = Math.atan2(-m[8], -m[10]);
    }
    const bearing = bearingOf(yaw);

    const riding = !!(hunt && (hunt.riding || hunt.state === "dropoff"));
    const alive = hunter ? hunter.alive !== false : true;
    const bino = !!controller?.binoculars && !riding && alive;
    const def = weapons?.def || null;
    const scoped = !bino && !riding && !!(weapons && (weapons.scoped ?? (def?.scope > 0 && weapons.aiming > 0.9)));
    const mode = riding ? "riding" : bino ? "bino" : scoped ? "scope" : "play";
    if (mode !== c.mode) {
      c.mode = mode;
      this.el.dataset.mode = mode;
    }

    this._updateCrosshair(dt, weapons, def, camera, hunter, mode);
    this._updateCompass(bearing, world, hunt, hunter);
    this._updateVitals(dt, hunter);
    this._updateAmmo(weapons, def);
    this._updateExpedition(hunt, world);
    this._updateRadar(dt, hunt, hunter, bearing);
    this._updateExtraction(dt, hunt, hunter, world, bearing);
    if (mode === "scope") this._updateScope(weapons, def, camera);
    if (mode === "bino") this._updateBinoculars(dt, controller, weapons, hunt, camera, bearing);
    else this._rangeTimer = 0;
    this._updateToasts(dt);
  }

  /**
   * Show a toast under the compass.
   * @param {string} text
   * @param {"info"|"good"|"warn"|"danger"} [kind]
   */
  toast(text, kind = "info") {
    if (!text) return;
    const last = this._toasts[this._toasts.length - 1];
    if (last && last.text === text && last.age < 1.5) {
      last.age = 0; // re-arm a repeated message instead of stacking it
      return;
    }
    const el = document.createElement("div");
    el.className = `hh-toast hh-toast--${kind}`;
    el.setAttribute("role", kind === "danger" ? "alert" : "status");
    el.innerHTML = `<span class="hh-toast__dot"></span><span>${escapeHtml(text)}</span>`;
    this.toastsEl.appendChild(el);
    requestAnimationFrame(() => el.classList.add("is-in"));
    this._toasts.push({ el, text, age: 0, life: TOAST_LIFE });
    while (this._toasts.length > MAX_TOASTS) this._dropToast(this._toasts[0]);
  }

  /**
   * The end-of-hunt expedition report.
   * @param {{ result: string, trophies: object[], score: number, points: number, unlocked: Array<string|object>,
   *   duration: number, totalPoints?: number }} summary
   * @param {() => void} [onAgain] "Hunt again"
   * @param {() => void} [onMenu]  back to the lodge / title
   */
  showSummary(summary, onAgain, onMenu) {
    const s = summary || {};
    const trophies = Array.isArray(s.trophies) ? s.trophies : [];
    const result = s.result || "extracted";
    const banked = result === "extracted";
    const n = trophies.length;
    const stamp = result === "extracted" ? "Extracted" : result === "died" ? "Lost" : "Called off";
    const headline = banked
      ? n
        ? `${numberWord(n)} ${n === 1 ? "trophy" : "trophies"} brought home`
        : "Back at the lodge, empty-handed"
      : result === "died"
        ? deathHeadline(s, this._hunter)
        : "Hunt called off";
    const lede = banked
      ? n
        ? "The chopper lifts clear of the canopy. The skins are tagged, the numbers are in the ledger."
        : "Nothing bagged this time — but you walked out on your own legs. On an island like this, that counts."
      : "Trophies are only banked when you extract. This expedition's bag stays on the island.";
    const date = new Date().toLocaleDateString("en-GB", { day: "numeric", month: "short", year: "numeric" });
    const total = trophies.reduce((a, t) => a + (Number(t.score) || 0), 0);
    const score = Number.isFinite(Number(s.score)) ? Number(s.score) : total;
    const points = Number(s.points) || 0;
    const heaviest = trophies.reduce((a, t) => Math.max(a, Number(t.mass) || 0), 0);
    const longest = trophies.reduce((a, t) => Math.max(a, Number(t.distance) || 0), 0);
    const heads = trophies.filter((t) => t.headshot).length;

    const rows = trophies
      .slice()
      .sort((a, b) => (Number(b.score) || 0) - (Number(a.score) || 0))
      .map((t, i) => {
        const id = t.speciesId || "";
        return (
          `<tr>` +
          `<td class="hh-t__no">${String(i + 1).padStart(2, "0")}</td>` +
          `<td class="hh-t__sp"><span class="hh-t__sil">${speciesSilhouette(id, { human: false })}</span>` +
          `<span class="hh-t__name">${escapeHtml(t.speciesName || id || "Unknown")}${t.target ? `<em class="hh-tag hh-tag--target">Target</em>` : ""}</span></td>` +
          `<td data-label="Weight">${escapeHtml(formatMass(t.mass))}</td>` +
          `<td data-label="Shot">${escapeHtml(fmtDist(Number(t.distance) || 0))}</td>` +
          `<td data-label="Head" class="hh-t__head">${t.headshot ? `${hicon("check")}<span class="sr">Headshot</span>` : `<span aria-label="No">—</span>`}</td>` +
          `<td data-label="Arm" class="hh-t__arm">${escapeHtml(this._weaponName(t.weapon))}</td>` +
          `<td class="hh-t__score">${fmtInt(t.score)}</td>` +
          `</tr>`
        );
      })
      .join("");

    const unlocked = (Array.isArray(s.unlocked) ? s.unlocked : []).map((u) => (typeof u === "string" ? { id: u, name: this._weaponName(u) } : u));
    const unlockHTML = unlocked.length
      ? `<div class="hh-unlock">` +
        `<p class="hh-eyebrow">New in the gun rack</p>` +
        unlocked
          .map((u) => `<div class="hh-unlock__item">${weaponGlyph(u.id)}<span><b>${escapeHtml(u.name || u.id)}</b><small>Unlocked — choose it on your next expedition</small></span></div>`)
          .join("") +
        `</div>`
      : "";

    const table = n
      ? `<table class="hh-t"><caption class="sr">Trophies</caption><thead><tr><th>No.</th><th>Species</th><th>Weight</th><th>Shot</th><th>Head</th><th>Arm</th><th class="hh-t__score">Score</th></tr></thead>` +
        `<tbody>${rows}</tbody>` +
        `<tfoot><tr><td></td><td colspan="5">Expedition score${banked ? "" : " — not banked"}</td><td class="hh-t__score">${fmtInt(score)}</td></tr></tfoot></table>`
      : `<div class="hh-empty">${hicon("target")}<p>No trophies tagged on this expedition.</p></div>`;

    const html =
      `<article class="hh-sheet hh-sheet--${escapeHtml(result)}" role="dialog" aria-modal="true" aria-labelledby="hh-sum-${this._uid}">` +
      `<header class="hh-sheet__head">` +
      `<p class="hh-sheet__brand">${hicon("ledger")}<span>Sauria · Hunter's lodge</span></p>` +
      `<p class="hh-sheet__date">Expedition report · ${escapeHtml(date)}</p>` +
      `</header>` +
      `<div class="hh-sheet__title">` +
      `<span class="hh-stamp hh-stamp--${banked ? "ok" : "lost"}" aria-hidden="true">${stamp}</span>` +
      `<h2 id="hh-sum-${this._uid}">${escapeHtml(headline)}</h2>` +
      `<p class="hh-sheet__lede">${escapeHtml(lede)}</p>` +
      `</div>` +
      `<dl class="hh-facts">` +
      `<div><dt>In the field</dt><dd>${escapeHtml(formatDuration(s.duration))}</dd></div>` +
      `<div><dt>Trophies</dt><dd>${n}</dd></div>` +
      `<div><dt>Headshots</dt><dd>${heads}</dd></div>` +
      `<div><dt>Heaviest</dt><dd>${heaviest ? escapeHtml(formatMass(heaviest)) : "—"}</dd></div>` +
      `<div><dt>Longest shot</dt><dd>${longest ? escapeHtml(fmtDist(longest)) : "—"}</dd></div>` +
      `</dl>` +
      table +
      `<div class="hh-sheet__foot">` +
      `<div class="hh-points">` +
      `<p class="hh-eyebrow">Points banked</p>` +
      `<p class="hh-points__n"><span class="hh-stencil">${banked && points > 0 ? "+" : ""}${fmtInt(points)}</span><small>pts</small></p>` +
      (Number.isFinite(Number(s.totalPoints)) ? `<p class="hh-points__total">Lodge balance <b>${fmtInt(s.totalPoints)}</b> pts</p>` : "") +
      `</div>` +
      unlockHTML +
      `</div>` +
      `<div class="hh-sheet__actions">` +
      `<button type="button" class="hh-btn hh-btn--primary" data-act="again">${hicon("heli")}<span>Hunt again</span></button>` +
      `<button type="button" class="hh-btn hh-btn--ghost" data-act="menu"><span>Return to lodge</span></button>` +
      `</div>` +
      `</article>`;

    this._openReport("summary", html, onAgain, onMenu);
  }

  /**
   * The death card: the expedition is over and its trophies are lost.
   * @param {object} summary HuntSession summary (result "died"); may carry `cause` / `killer`
   * @param {() => void} [onMenu]
   */
  showDeath(summary, onMenu) {
    const s = summary || {};
    const trophies = Array.isArray(s.trophies) ? s.trophies : [];
    const killer = s.killer || this._hunter?.lastAttacker;
    const killerId = typeof killer === "object" ? killer?.species?.id : null;
    const headline = deathHeadline(s, this._hunter);
    const lost = trophies.reduce((a, t) => a + (Number(t.score) || 0), 0);
    const chips = trophies
      .map((t) => `<li><s>${escapeHtml(t.speciesName || t.speciesId || "Trophy")}</s><small>${escapeHtml(formatMass(t.mass))}</small></li>`)
      .join("");
    const html =
      `<article class="hh-death" role="alertdialog" aria-modal="true" aria-labelledby="hh-death-${this._uid}">` +
      `<p class="hh-eyebrow hh-death__eyebrow">${icon("skull")}<span>Field record · Expedition lost</span></p>` +
      (killerId ? `<div class="hh-death__sil">${speciesSilhouette(killerId, { human: true })}</div>` : "") +
      `<p class="hh-death__kicker">Your expedition ended</p>` +
      `<h2 id="hh-death-${this._uid}">${escapeHtml(headline)}</h2>` +
      `<p class="hh-death__lede">${trophies.length ? "The island keeps what you took from it." : "No one will tag this one in a ledger."}</p>` +
      `<dl class="hh-death__stats">` +
      `<div><dt>In the field</dt><dd>${escapeHtml(formatDuration(s.duration))}</dd></div>` +
      `<div><dt>Trophies lost</dt><dd>${trophies.length}</dd></div>` +
      `<div><dt>Score forfeited</dt><dd>${fmtInt(lost)}</dd></div>` +
      `</dl>` +
      (chips ? `<ul class="hh-death__lost" aria-label="Trophies lost">${chips}</ul>` : "") +
      `<div class="hh-death__actions"><button type="button" class="hh-btn hh-btn--primary" data-act="menu">${icon("arrowLeft")}<span>Return to lodge</span></button></div>` +
      `</article>`;
    this._openReport("death", html, null, onMenu);
  }

  /** Close the summary (if open). */
  hideSummary() {
    if (this._report.kind === "summary") this._closeReport();
  }

  /** Close the death card (if open). */
  hideDeath() {
    if (this._report.kind === "death") this._closeReport();
  }

  /** Remove the DOM and every listener. */
  dispose() {
    for (const off of this._offs) off();
    this._offs.length = 0;
    this._ac.abort();
    this._ro?.disconnect();
    this.el.remove();
    this.reportEl.remove();
  }

  /* --- Build --- */

  _build() {
    const el = document.createElement("div");
    el.className = `hh${this.isTouch ? " hh--touch" : ""}`;
    el.hidden = true; // until hunter.css is in, so nothing flashes unstyled
    el.dataset.mode = "play";
    el.setAttribute("aria-hidden", "true");
    const pool = Array.from({ length: BLIP_POOL }, () => `<i class="hh-blip"></i>`).join("");
    const pips = Array.from({ length: PIP_MAX }, () => `<i class="hh-pip"></i>`).join("");
    const reloadHint = this.isTouch ? `Tap ${hicon("reload")} to reload` : `<kbd class="hh-kbd">R</kbd> to reload`;
    const m = `hh-bm-${this._uid}`;
    const g = `hh-bg-${this._uid}`;
    el.innerHTML = `
      <div class="hh-fx hh-fx--hurt"></div>
      <div class="hh-fx hh-fx--low"></div>
      <div class="hh-scrim hh-scrim--top"></div>
      <div class="hh-scrim hh-scrim--bottom"></div>

      <div class="hh-scope">
        <div class="hh-scope__mask"><div class="hh-scope__lens"></div></div>
        <div class="hh-scope__rets">${duplexSVG()}${mildotSVG()}</div>
        <p class="hh-scope__power"></p>
      </div>

      <div class="hh-bino">
        <svg class="hh-bino__mask" width="100%" height="100%" aria-hidden="true" focusable="false">
          <defs>
            <radialGradient id="${g}"><stop offset="0.8" stop-color="#000"/><stop offset="1" stop-color="#fff"/></radialGradient>
            <mask id="${m}" maskUnits="userSpaceOnUse">
              <rect width="100%" height="100%" fill="#fff"/>
              <circle class="hh-bino__c1" fill="url(#${g})"/><circle class="hh-bino__c2" fill="url(#${g})"/>
              <circle class="hh-bino__k1" fill="#000"/><circle class="hh-bino__k2" fill="#000"/>
            </mask>
          </defs>
          <rect width="100%" height="100%" fill="#050504" mask="url(#${m})"/>
        </svg>
        <div class="hh-bino__ret"><i></i><i></i><i></i><i></i><span class="hh-bino__box"></span></div>
        <div class="hh-bino__lcd">
          <p class="hh-bino__range"><span class="hh-bino__rv">---</span><small>m</small></p>
          <p class="hh-bino__id"><span class="hh-bino__name">No target</span><span class="hh-bino__mass"></span><em class="hh-tag hh-tag--target">Target</em><em class="hh-tag hh-tag--danger">Predator</em></p>
        </div>
        <p class="hh-bino__foot"><span class="hh-bino__brg">BRG 000° N</span><span class="hh-bino__zoom">8×</span></p>
      </div>

      <div class="hh-cross"><i class="hh-cross__t hh-cross__t--u"></i><i class="hh-cross__t hh-cross__t--r"></i><i class="hh-cross__t hh-cross__t--d"></i><i class="hh-cross__t hh-cross__t--l"></i><i class="hh-cross__dot"></i></div>
      <div class="hh-hit"><i></i><i></i><i></i><i></i></div>

      <div class="hh-compass">
        <div class="hh-compass__window">
          <div class="hh-compass__strip">${compassStripSVG()}</div>
          <span class="hh-compass__pin hh-compass__pin--wind">${hicon("wind")}</span>
          <span class="hh-compass__pin hh-compass__pin--heli">${hicon("heli")}</span>
        </div>
        <span class="hh-compass__caret"></span>
        <p class="hh-compass__readout">N 000°</p>
        <p class="hh-wind">
          <svg class="hh-wind__arrow" viewBox="-12 -12 24 24" aria-hidden="true" focusable="false"><path d="M0 -9.5 5.4 4.6 0 1.6 -5.4 4.6z"/></svg>
          <span class="hh-wind__label">Wind</span><span class="hh-wind__text">0 m/s</span>
        </p>
      </div>

      <div class="hh-extract">
        <span class="hh-extract__ico">${hicon("heli")}</span>
        <div class="hh-extract__body"><p class="hh-extract__title"></p><p class="hh-extract__sub"></p></div>
        <div class="hh-extract__nav"><svg class="hh-extract__arrow" viewBox="-12 -12 24 24" aria-hidden="true" focusable="false"><path d="M0 -10 6 3 0 0 -6 3z"/></svg><b class="hh-extract__dist"></b></div>
      </div>

      <div class="hh-toasts"></div>

      <div class="hh-exp">
        <p class="hh-eyebrow">Quarry</p>
        <p class="hh-exp__targets">Anything that moves</p>
        <p class="hh-exp__bag"></p>
      </div>

      <div class="hh-radar">
        <div class="hh-radar__face">
          <div class="hh-radar__sweep"></div>
          <div class="hh-radar__blips">${pool}</div>
          <span class="hh-radar__n">N</span>
          <i class="hh-radar__me"></i>
        </div>
        <p class="hh-radar__label">Radar · ${RADAR_RANGE} m</p>
      </div>

      <div class="hh-status">
        <div class="hh-stealth">
          <p class="hh-eyebrow">Stealth</p>
          <div class="hh-gauge" data-k="scent"><span class="hh-gauge__label">Scent</span><span class="hh-gauge__bar"><i></i></span></div>
          <div class="hh-gauge" data-k="noise"><span class="hh-gauge__label">Noise</span><span class="hh-gauge__bar"><i></i></span></div>
          <div class="hh-gauge" data-k="vis"><span class="hh-gauge__label">Visibility</span><span class="hh-gauge__bar"><i></i></span></div>
        </div>
        <div class="hh-sliver hh-sliver--health">${icon("heart")}<span class="hh-sliver__bar"><i></i></span></div>
        <div class="hh-sliver hh-sliver--stamina">${icon("bolt")}<span class="hh-sliver__bar"><i></i></span></div>
      </div>

      <div class="hh-ammo">
        <p class="hh-ammo__slots"></p>
        <p class="hh-ammo__name"><span class="hh-ammo__glyph"></span><span class="hh-ammo__title"></span></p>
        <div class="hh-ammo__rounds">
          <span class="hh-pips">${pips}</span>
          <span class="hh-ammo__count"><b class="hh-ammo__mag">0</b><span class="hh-ammo__sep">/</span><span class="hh-ammo__res">0</span></span>
        </div>
        <p class="hh-ammo__hint">
          <span class="hh-ammo__reload"><svg class="hh-ring" viewBox="0 0 24 24" aria-hidden="true" focusable="false"><circle class="hh-ring__bg" cx="12" cy="12" r="9"/><circle class="hh-ring__fg" cx="12" cy="12" r="9" stroke-dasharray="${RING_C.toFixed(2)}" stroke-dashoffset="${RING_C.toFixed(2)}"/></svg>Reloading</span>
          <span class="hh-ammo__empty">${reloadHint}</span>
          <span class="hh-ammo__out">Out of ammo</span>
        </p>
      </div>

      <div class="hh-tags"></div>

      <div class="hh-ride">
        <p class="hh-eyebrow">Drop-off</p>
        <p class="hh-ride__title">Inbound to the landing zone</p>
        <p class="hh-ride__sub">Hold on — the pilot sets you down, then you're on your own.</p>
      </div>
    `;
    this.root.appendChild(el);
    this.el = el;

    const report = document.createElement("div");
    report.className = "hh-report";
    report.hidden = true;
    this.root.appendChild(report);
    this.reportEl = report;
    report.addEventListener("click", (e) => {
      const b = e.target.closest?.("[data-act]");
      if (!b) return;
      const act = b.dataset.act;
      const cb = act === "again" ? this._report.onAgain : this._report.onMenu;
      this._closeReport();
      cb?.();
    });

    const $ = (s) => el.querySelector(s);
    this.toastsEl = $(".hh-toasts");
    this.tagsEl = $(".hh-tags");
    this._fxHurt = $(".hh-fx--hurt");
    this._fxLow = $(".hh-fx--low");
    this._cross = $(".hh-cross");
    this._crossDot = $(".hh-cross__dot");
    this._hit = $(".hh-hit");
    this._compassWin = $(".hh-compass__window");
    this._strip = $(".hh-compass__strip");
    this._readout = $(".hh-compass__readout");
    this._pinWind = $(".hh-compass__pin--wind");
    this._pinHeli = $(".hh-compass__pin--heli");
    this._wind = $(".hh-wind");
    this._windArrow = $(".hh-wind__arrow");
    this._windText = $(".hh-wind__text");
    this._extract = $(".hh-extract");
    this._extractTitle = $(".hh-extract__title");
    this._extractSub = $(".hh-extract__sub");
    this._extractArrow = $(".hh-extract__arrow");
    this._extractDist = $(".hh-extract__dist");
    this._targets = $(".hh-exp__targets");
    this._bag = $(".hh-exp__bag");
    this._radar = $(".hh-radar");
    this._radarFace = $(".hh-radar__face");
    this._radarN = $(".hh-radar__n");
    this._blipEls = [...el.querySelectorAll(".hh-blip")];
    this._gauges = {
      scent: $('.hh-gauge[data-k="scent"] i'),
      noise: $('.hh-gauge[data-k="noise"] i'),
      vis: $('.hh-gauge[data-k="vis"] i'),
    };
    this._gaugeRows = {
      scent: $('.hh-gauge[data-k="scent"]'),
      noise: $('.hh-gauge[data-k="noise"]'),
      vis: $('.hh-gauge[data-k="vis"]'),
    };
    this._healthFill = $(".hh-sliver--health i");
    this._healthRow = $(".hh-sliver--health");
    this._staminaFill = $(".hh-sliver--stamina i");
    this._staminaRow = $(".hh-sliver--stamina");
    this._ammo = $(".hh-ammo");
    this._slots = $(".hh-ammo__slots");
    this._ammoGlyph = $(".hh-ammo__glyph");
    this._ammoTitle = $(".hh-ammo__title");
    this._pipEls = [...el.querySelectorAll(".hh-pip")];
    this._mag = $(".hh-ammo__mag");
    this._res = $(".hh-ammo__res");
    this._ring = $(".hh-ring__fg");
    this._scopePower = $(".hh-scope__power");
    this._scopeMask = $(".hh-scope__mask");
    this._bino = $(".hh-bino");
    this._binoC = [$(".hh-bino__c1"), $(".hh-bino__c2"), $(".hh-bino__k1"), $(".hh-bino__k2")];
    this._binoRange = $(".hh-bino__rv");
    this._binoName = $(".hh-bino__name");
    this._binoMass = $(".hh-bino__mass");
    this._binoId = $(".hh-bino__id");
    this._binoBrg = $(".hh-bino__brg");
    this._binoZoom = $(".hh-bino__zoom");
  }

  _measure() {
    const w = this.el.clientWidth || window.innerWidth || 1;
    const h = this.el.clientHeight || window.innerHeight || 1;
    this._vw = w;
    this._vh = h;
    const cw = this._compassWin?.clientWidth;
    if (cw > 0) this._compassW = cw;
    const rw = this._radarFace?.clientWidth;
    if (rw > 0) this._radarR = rw / 2;
    this._c.stripX = NaN;
    this._c.radarN = NaN;
    this._c.windPin = NaN;
    this._c.extractPin = NaN;
    this._layoutBinoculars();
  }

  /** Figure-eight binocular mask geometry, in pixels (re-run on resize only). */
  _layoutBinoculars() {
    const w = this._vw;
    const h = this._vh;
    // Landscape: two lenses side by side. Portrait: let them crop at the sides
    // rather than shrink to postage stamps.
    const r = w >= h ? Math.min(h * 0.47, w * 0.29) : Math.min(h * 0.4, w * 0.46);
    const off = r * 0.74;
    const cy = h / 2;
    const set = (el, cx, rr) => {
      el.setAttribute("cx", cx.toFixed(1));
      el.setAttribute("cy", cy.toFixed(1));
      el.setAttribute("r", rr.toFixed(1));
    };
    set(this._binoC[0], w / 2 - off, r);
    set(this._binoC[1], w / 2 + off, r);
    set(this._binoC[2], w / 2 - off, r * 0.8);
    set(this._binoC[3], w / 2 + off, r * 0.8);
    this._bino.style.setProperty("--bino-r", `${r.toFixed(0)}px`);
  }

  /* --- Events --- */

  _bindEvents(events) {
    if (!events || typeof events.on !== "function") return;
    const on = (name, fn) => {
      const off = events.on(name, fn);
      this._offs.push(typeof off === "function" ? off : () => events.off?.(name, fn));
    };
    const mine = (actor) => !this._hunter || !actor || actor === this._hunter;
    on("hit", (e) => {
      if (e && mine(e.shooter) && e.target !== this._hunter) this._flashHit(!!e.headshot);
    });
    on("trophy", (e) => e?.trophy && this._trophyTag(e.trophy));
    on("radar", (e) => this._onRadar(e));
    on("extraction", (e) => this._onExtraction(e));
    on("notify", (e) => e?.text && this.toast(e.text, e.kind || "info"));
    on("lure", (e) => {
      if (!e || !mine(e.shooter)) return;
      const name = typeof e.species === "string" ? e.species.charAt(0).toUpperCase() + e.species.slice(1) : "";
      this.toast(name ? `Call device — ${name} call sent` : "Call device sounded", "info");
    });
    on("dryfire", () => {
      if (!this.visible || !this._ammo.animate) return;
      this._ammo.animate([{ transform: "translateX(0)" }, { transform: "translateX(-4px)" }, { transform: "translateX(3px)" }, { transform: "translateX(0)" }], { duration: 220, easing: "ease-out" });
    });
  }

  _flashHit(head) {
    if (!this.visible) return;
    const el = this._hit;
    el.classList.toggle("is-head", head);
    if (el.animate) {
      el.getAnimations?.().forEach((a) => a.cancel());
      el.animate(
        [
          { opacity: 1, transform: "translate(-50%, -50%) scale(0.7)" },
          { opacity: 1, transform: "translate(-50%, -50%) scale(1)", offset: 0.25 },
          { opacity: 0, transform: "translate(-50%, -50%) scale(1.15)" },
        ],
        { duration: head ? 520 : 300, easing: "ease-out" }
      );
    }
  }

  _onRadar(e) {
    const list = Array.isArray(e?.blips) ? e.blips : [];
    let n = 0;
    for (const b of list) {
      if (n >= BLIP_POOL) break;
      if (!Number.isFinite(b?.x) || !Number.isFinite(b?.z)) continue;
      const slot = this._blips[n++];
      slot.x = b.x;
      slot.z = b.z;
      slot.species = b.species || "";
    }
    this._blipCount = n;
    this._radarAge = 0;
    this._radarSeen = true;
    if (this.visible && this._radarFace.animate) {
      this._radarFace.animate([{ boxShadow: "0 0 0 0 rgba(214,165,78,0.45)" }, { boxShadow: "0 0 0 14px rgba(214,165,78,0)" }], { duration: 900, easing: "ease-out" });
    }
  }

  _onExtraction(e) {
    if (!e) return;
    const state = e.state;
    if (state === "departed") {
      this._extraction = null;
      return;
    }
    this._extraction = { state, eta: Number(e.eta) || 0 };
    this._etaLocal = Number(e.eta) || 0;
    if (state === "called") this.toast("Extraction called — hold out for the chopper", "info");
    else if (state === "landed") this.toast("The helicopter is down — get under it", "good");
  }

  _onKey(e) {
    if (!this._report.open) return;
    if (e.key === "Tab") {
      // Keep focus inside the report while it is modal.
      const items = [...this.reportEl.querySelectorAll("button")];
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
  }

  /* --- Per-frame sections --- */

  _updateCrosshair(dt, weapons, def, camera, hunter, mode) {
    const c = this._c;
    // Spread is a cone half-angle in radians → pixels at the current vertical FOV.
    const fov = ((Number(camera?.fov) || 70) * Math.PI) / 180;
    const spread = Number(weapons?.spread);
    const s = Number.isFinite(spread) ? spread : Number(def?.spread) || 0.02;
    const gap = clamp((Math.tan(s) / Math.tan(fov / 2)) * (this._vh / 2), 3, 120);
    const gq = Math.round(gap * 2) / 2;
    if (gq !== c.gap) {
      c.gap = gq;
      this._cross.style.setProperty("--g", `${gq}px`);
    }
    let a = 1;
    let dotA = 0.95;
    if (mode !== "play" || hunter?.alive === false) {
      a = 0;
      dotA = 0;
    } else {
      const aim = clamp(Number(weapons?.aiming) || 0, 0, 1);
      const sprint = hunter?.gait === "sprint" ? 1 : 0;
      const busy = weapons?.reloading || weapons?.switching ? 0.35 : 1;
      a = (1 - aim) * (1 - sprint) * busy;
      dotA = (1 - aim * 0.65) * (1 - sprint) * busy;
    }
    const aq = Math.round(a * 20) / 20;
    if (aq !== c.crossA) {
      c.crossA = aq;
      this._cross.style.setProperty("--a", aq);
    }
    const dq = Math.round(dotA * 20) / 20;
    if (dq !== c.dotA) {
      c.dotA = dq;
      this._crossDot.style.opacity = dq;
    }
  }

  _updateCompass(bearing, world, hunt, hunter) {
    const c = this._c;
    const bq = Math.round(bearing * 4) / 4;
    if (bq !== c.bearing) {
      c.bearing = bq;
      const x = -(bq + 360) * PX_PER_DEG + this._compassW / 2;
      this._strip.style.transform = `translate3d(${x.toFixed(1)}px,0,0)`;
      const text = `${cardinalOf(bearing)} ${pad3(bearing)}°`;
      if (text !== c.readout) {
        c.readout = text;
        this._readout.textContent = text;
      }
    }

    // Wind: arrow shows where the air (and your scent) is going, relative to your view.
    const wind = world?.wind;
    if (wind && Number.isFinite(wind.yaw)) {
      const toward = bearingOf(wind.yaw);
      const from = (toward + 180) % 360;
      const ms = Number.isFinite(wind.speed) ? wind.speed : (Number(wind.strength) || 0) * WIND_MS_PER_STRENGTH;
      const rel = Math.round(relDeg(bearing, toward) / 2) * 2;
      if (rel !== c.windArrow) {
        c.windArrow = rel;
        this._windArrow.style.transform = `rotate(${rel}deg)`;
      }
      const calm = ms < 0.8;
      const text = calm ? "Calm" : `${Math.round(ms)} m/s ${cardinalOf(from)}`;
      if (text !== c.windText) {
        c.windText = text;
        this._windText.textContent = text;
        this._wind.classList.toggle("is-calm", calm);
      }
      // Wind at your back carries your scent ahead of you — toward whatever you're stalking.
      const warn = !calm && Math.abs(rel) < 50;
      if (warn !== c.windWarn) {
        c.windWarn = warn;
        this._wind.classList.toggle("is-warn", warn);
      }
      this._placePin(this._pinWind, calm ? null : relDeg(bearing, from), "windPin");
    } else {
      if (c.windText !== "—") {
        c.windText = "—";
        this._windText.textContent = "—";
      }
      this._placePin(this._pinWind, null, "windPin");
    }

    // Helicopter pin while an extraction is under way.
    const ex = this._extractionState(hunt);
    let heliRel = null;
    if (ex && hunter?.position) {
      const t = this._extractionTarget(hunt, world);
      if (t) {
        const dx = t.x - hunter.position.x;
        const dz = t.z - hunter.position.z;
        if (dx * dx + dz * dz > 1) heliRel = relDeg(bearing, bearingOf(Math.atan2(dx, dz)));
      }
    }
    this._placePin(this._pinHeli, heliRel, "extractPin");
  }

  _placePin(el, rel, key) {
    const c = this._c;
    if (rel === null) {
      if (c[key] !== null) {
        c[key] = null;
        el.classList.remove("is-on");
      }
      return;
    }
    const half = this._compassW / 2 - 12;
    const x = Math.round(clamp(rel * PX_PER_DEG, -half, half) + this._compassW / 2);
    if (x !== c[key]) {
      if (c[key] === null || Number.isNaN(c[key])) el.classList.add("is-on");
      c[key] = x;
      el.style.transform = `translate3d(${x}px,0,0)`;
      el.classList.toggle("is-edge", Math.abs(rel * PX_PER_DEG) > half);
    }
  }

  _updateVitals(dt, hunter) {
    const c = this._c;
    if (!hunter) return;
    const max = Number(hunter.maxHealth) || 100;
    const hp = clamp((Number(hunter.health) || 0) / max, 0, 1);
    const hq = Math.round(hp * 200) / 200;
    if (hq !== c.health) {
      c.health = hq;
      this._healthFill.style.transform = `scaleX(${hq})`;
      this._healthRow.classList.toggle("is-low", hq < 0.3);
    }
    const st = clamp((Number(hunter.stamina) || 0) / 100, 0, 1);
    const sq = Math.round(st * 200) / 200;
    if (sq !== c.stamina) {
      c.stamina = sq;
      this._staminaFill.style.transform = `scaleX(${sq})`;
    }
    const lowStam = sq < 0.2;
    if (lowStam !== c.lowStam) {
      c.lowStam = lowStam;
      this._staminaRow.classList.toggle("is-low", lowStam);
    }

    // Stealth signals (0..1), quantised to the ten gauge segments' worth of change.
    this._gauge("scent", hunter.scent);
    this._gauge("noise", hunter.noise);
    this._gauge("vis", hunter.visibility);

    // Damage flash: driven by health drops so every damage source counts once.
    const health = Number(hunter.health) || 0;
    if (this._lastHealth !== null && health < this._lastHealth - 0.01) {
      this._hurt = Math.min(1, this._hurt + 0.35 + ((this._lastHealth - health) / max) * 3);
    }
    this._lastHealth = health;
    this._hurt = Math.max(0, this._hurt - dt * 1.6);
    const hurtQ = Math.round(this._hurt * 40) / 40;
    if (hurtQ !== c.hurt) {
      c.hurt = hurtQ;
      this._fxHurt.style.opacity = hurtQ;
    }
    const low = hunter.alive === false ? 0 : Math.round(remap(hp, 0.38, 0.08, 0, 1) * 40) / 40;
    if (low !== c.low) {
      c.low = low;
      this._fxLow.style.opacity = low;
    }
    const beating = low > 0.25;
    if (beating !== c.beating) {
      c.beating = beating;
      this._fxLow.classList.toggle("is-beating", beating);
    }
  }

  _gauge(key, value) {
    const v = clamp(Number(value) || 0, 0, 1);
    const q = Math.round(v * 50) / 50;
    const ck = key === "vis" ? "vis" : key;
    if (q === this._c[ck]) return;
    this._c[ck] = q;
    this._gauges[key].style.transform = `scaleX(${q})`;
    const row = this._gaugeRows[key];
    row.classList.toggle("is-mid", q >= 0.45 && q < 0.75);
    row.classList.toggle("is-high", q >= 0.75);
  }

  _updateAmmo(weapons, def) {
    const c = this._c;
    if (!weapons) return;
    const id = weapons.current || def?.id || "";
    const am = weapons.ammo?.[id] || { mag: 0, reserve: 0 };
    const magSize = clamp(Math.round(Number(def?.magazine) || Number(am.mag) || 1), 1, PIP_MAX);
    if (id !== c.weapon) {
      c.weapon = id;
      c.mag = -1;
      c.magSize = -1;
      this._ammo.dataset.kind = id;
      this._ammoGlyph.innerHTML = weaponGlyph(id);
      this._ammoTitle.textContent = def?.name || WEAPON_NAMES[id] || id;
    }
    // Slot tabs ("1 Rifle  2 Revolver") — only rebuilt when the loadout or selection changes.
    const loadout = Array.isArray(weapons.loadout) ? weapons.loadout : [];
    const slotsKey = `${loadout.join(",")}|${id}`;
    if (slotsKey !== c.slots) {
      c.slots = slotsKey;
      this._slots.innerHTML = loadout
        .map((w, i) => {
          const short = (WEAPON_NAMES[w] || w).replace(/^\.\d+\s|^Double-Barrel\s|^Bolt-Action\s|\sRifle$/g, "");
          return `<span class="hh-slot${w === id ? " is-on" : ""}"><kbd class="hh-kbd">${i + 1}</kbd>${escapeHtml(short || w)}</span>`;
        })
        .join("");
    }
    const mag = Math.max(0, Math.round(Number(am.mag) || 0));
    const reserve = Math.max(0, Math.round(Number(am.reserve) || 0));
    if (magSize !== c.magSize) {
      c.magSize = magSize;
      for (let i = 0; i < PIP_MAX; i++) this._pipEls[i].hidden = i >= magSize;
      c.mag = -1;
    }
    if (mag !== c.mag) {
      c.mag = mag;
      for (let i = 0; i < magSize; i++) this._pipEls[i].classList.toggle("is-spent", i >= mag);
      this._mag.textContent = mag;
    }
    if (reserve !== c.reserve) {
      c.reserve = reserve;
      this._res.textContent = reserve;
    }
    const reloading = !!weapons.reloading;
    const hint = reloading ? "reload" : mag === 0 ? (reserve > 0 ? "empty" : "out") : "";
    if (hint !== c.hint) {
      c.hint = hint;
      this._ammo.dataset.hint = hint;
    }
    if (reloading) {
      const p = clamp(Number(weapons.reloadProgress) || 0, 0, 1);
      const pq = Math.round(p * 100) / 100;
      if (pq !== c.ring) {
        c.ring = pq;
        this._ring.style.strokeDashoffset = (RING_C * (1 - pq)).toFixed(2);
      }
    } else if (c.ring !== -1) {
      c.ring = -1;
      this._ring.style.strokeDashoffset = RING_C.toFixed(2);
    }
    const switching = !!weapons.switching;
    if (switching !== c.switching) {
      c.switching = switching;
      this._ammo.classList.toggle("is-switching", switching);
    }
  }

  _updateExpedition(hunt, world) {
    const c = this._c;
    if (!hunt) return;
    const targets = Array.isArray(hunt.targets) ? hunt.targets : [];
    const key = targets.join(",");
    if (key !== c.targets) {
      c.targets = key;
      const names = targets.map((t) => {
        const sp = world?.ecosystem?.creatures?.find?.((cr) => cr?.species?.id === t)?.species;
        return sp?.name || t.charAt(0).toUpperCase() + t.slice(1);
      });
      this._targets.textContent = names.length ? names.join(" · ") : "Anything that moves";
    }
    const n = Array.isArray(hunt.trophies) ? hunt.trophies.length : 0;
    const clock = typeof world?.sky?.clockString === "function" ? world.sky.clockString() : "";
    const bag = `${clock}|${n}|${Math.round(Number(hunt.score) || 0)}`;
    if (bag !== c.bag) {
      c.bag = bag;
      this._bag.innerHTML =
        (clock ? `<span>${escapeHtml(clock)}</span><i></i>` : "") +
        `<span>Bag <b>${n}</b></span><i></i><span><b>${fmtInt(hunt.score)}</b> pts</span>`;
    }
  }

  _updateRadar(dt, hunt, hunter, bearing) {
    const c = this._c;
    const on = !!(hunt?.equipment?.radar || this._radarSeen);
    if (on !== c.radarOn) {
      c.radarOn = on;
      this._radar.classList.toggle("is-on", on);
    }
    if (!on || !hunter?.position) return;
    this._radarAge += dt;

    const nRel = Math.round(relDeg(bearing, 0));
    if (nRel !== c.radarN) {
      c.radarN = nRel;
      const R = this._radarR - 9;
      const a = (nRel * Math.PI) / 180;
      this._radarN.style.transform = `translate3d(${(Math.sin(a) * R).toFixed(1)}px,${(-Math.cos(a) * R).toFixed(1)}px,0)`;
    }

    // Blips are world positions from the last ping, drawn relative to where you
    // stand and face now (screen-up = forward).
    const yaw = ((Math.PI - (bearing * Math.PI) / 180) + Math.PI * 4) % (Math.PI * 2);
    const sin = Math.sin(yaw);
    const cos = Math.cos(yaw);
    const px = hunter.position.x;
    const pz = hunter.position.z;
    const R = this._radarR - 4;
    const k = R / RADAR_RANGE;
    const fade = clamp(1 - this._radarAge / RADAR_FADE, 0.18, 1);
    for (let i = 0; i < BLIP_POOL; i++) {
      const el = this._blipEls[i];
      const b = this._blips[i];
      if (i >= this._blipCount) {
        if (b.on) {
          b.on = false;
          el.style.opacity = 0;
        }
        continue;
      }
      const dx = b.x - px;
      const dz = b.z - pz;
      let sx = (-dx * cos + dz * sin) * k;
      let sy = -(dx * sin + dz * cos) * k;
      const d = Math.hypot(sx, sy);
      if (d > R) {
        sx *= R / d;
        sy *= R / d;
      }
      el.style.transform = `translate3d(${sx.toFixed(1)}px,${sy.toFixed(1)}px,0)`;
      el.style.opacity = fade.toFixed(2);
      b.on = true;
    }
  }

  _extractionState(hunt) {
    const ex = hunt?.extraction || this._extraction;
    if (!ex || ex.state === "departed") return null;
    if (hunt && hunt.state === "ended") return null;
    return ex;
  }

  _extractionTarget(hunt, world) {
    const h = world?.helicopter || hunt?.helicopter;
    if (h?.active && h.position) return h.position;
    const ex = hunt?.extraction;
    if (ex && Number.isFinite(ex.x) && Number.isFinite(ex.z)) return ex;
    return null;
  }

  _updateExtraction(dt, hunt, hunter, world, bearing) {
    const c = this._c;
    const ex = this._extractionState(hunt);
    const state = ex ? ex.state : "";
    if (state !== c.extract) {
      c.extract = state;
      this._extract.dataset.state = state;
      this._extract.classList.toggle("is-on", !!state);
      this._extractTitle.textContent =
        state === "called" ? "Extraction called" : state === "inbound" ? "Helicopter inbound" : state === "landed" ? "Get under the helicopter" : "";
      c.extractSub = "";
      c.extractDist = "";
    }
    if (!ex) return;

    // ETA: count down locally between the (integer) updates the session publishes.
    const eta = Number(ex.eta);
    if (Number.isFinite(eta) && Math.abs(eta - this._etaLocal) > 1.5) this._etaLocal = eta;
    this._etaLocal = Math.max(0, this._etaLocal - dt);
    const sub =
      state === "landed"
        ? "Walk under the rotor to board"
        : this._etaLocal > 0.5
          ? `ETA ${fmtClock(this._etaLocal)}`
          : state === "called"
            ? "Scrambling…"
            : "On final approach";
    if (sub !== c.extractSub) {
      c.extractSub = sub;
      this._extractSub.textContent = sub;
    }

    const t = this._extractionTarget(hunt, world);
    if (!t || !hunter?.position) return;
    const dx = t.x - hunter.position.x;
    const dz = t.z - hunter.position.z;
    const d = Math.hypot(dx, dz);
    const rel = Math.round(relDeg(bearing, bearingOf(Math.atan2(dx, dz))) / 2) * 2;
    if (rel !== c.extractArrow) {
      c.extractArrow = rel;
      this._extractArrow.style.transform = `rotate(${rel}deg)`;
    }
    const dist = d < 8 ? "Here" : fmtDist(d);
    if (dist !== c.extractDist) {
      c.extractDist = dist;
      this._extractDist.textContent = dist;
    }
  }

  _updateScope(weapons, def, camera) {
    const c = this._c;
    const ret = def?.reticle || (def?.scope >= 5 ? "mildot" : "duplex");
    if (ret !== c.scopeRet) {
      c.scopeRet = ret;
      this.el.dataset.reticle = ret;
    }
    const power = def?.scope > 0 ? `${def.scope}×` : "";
    if (power !== c.scopePower) {
      c.scopePower = power;
      this._scopePower.textContent = power;
    }
    // Eye-relief parallax: the lens shadow drifts with the rifle's sway while the
    // reticle (and the point of aim) stays centred.
    const fov = ((Number(camera?.fov) || 30) * Math.PI) / 180;
    const k = (this._vh / 2 / Math.tan(fov / 2)) * 0.6;
    const sx = clamp((Number(weapons?.sway?.x) || 0) * k, -24, 24);
    const sy = clamp((Number(weapons?.sway?.y) || 0) * k, -24, 24);
    this._scopeMask.style.transform = `translate3d(${sx.toFixed(1)}px,${sy.toFixed(1)}px,0)`;
  }

  _updateBinoculars(dt, controller, weapons, hunt, camera, bearing) {
    const c = this._c;
    const zoom = Number(controller?.zoom);
    const mag = zoom > 0 && zoom < 1 ? `${Math.round(1 / zoom)}×` : "8×";
    const brg = `BRG ${pad3(bearing)}° ${cardinalOf(bearing)}`;
    const foot = `${brg}|${mag}`;
    if (foot !== c.bino) {
      c.bino = foot;
      this._binoBrg.textContent = brg;
      this._binoZoom.textContent = mag;
    }

    this._rangeTimer -= dt;
    if (this._rangeTimer > 0) return;
    this._rangeTimer = RANGEFINDER_INTERVAL;
    const r = this._rangeHit;
    r.distance = -1;
    r.name = "";
    r.mass = "";
    r.target = false;
    r.danger = false;
    r.down = false;
    r.kind = "";
    if (camera?.matrixWorld && typeof weapons?.raycast === "function") {
      const m = camera.matrixWorld.elements;
      _origin.set(m[12], m[13], m[14]);
      _dir.set(-m[8], -m[9], -m[10]).normalize();
      let hit = null;
      try {
        hit = weapons.raycast(_origin, _dir, RANGEFINDER_MAX);
      } catch (err) {
        hit = null;
      }
      if (hit && Number.isFinite(hit.distance)) {
        r.distance = hit.distance;
        if (hit.creature) {
          const sp = hit.creature.species || {};
          r.name = sp.name || "Unknown";
          r.mass = estimateMass(massOf(hit.creature));
          r.target = Array.isArray(hunt?.targets) && hunt.targets.includes(sp.id);
          r.danger = sp.diet === "carnivore";
          r.down = hit.creature.alive === false;
          r.kind = "creature";
        } else {
          r.kind = hit.water ? "water" : hit.tree ? "tree" : "terrain";
          r.name = hit.water ? "Water" : hit.tree ? "Tree" : "Ground";
        }
      }
    }
    const range = r.distance >= 0 ? (r.distance < 1000 ? String(Math.round(r.distance)) : (r.distance / 1000).toFixed(2)) : "---";
    if (range !== c.binoRange) {
      c.binoRange = range;
      this._binoRange.textContent = range;
      this._binoRange.nextElementSibling.textContent = r.distance >= 1000 ? "km" : "m";
    }
    const id = `${r.kind}|${r.name}|${r.mass}|${r.target}|${r.danger}|${r.down}`;
    if (id !== this._binoIdKey) {
      this._binoIdKey = id;
      this._binoName.textContent = r.kind ? (r.down ? `${r.name} · down` : r.name) : "No target";
      this._binoMass.textContent = r.mass;
      this._binoId.classList.toggle("is-creature", r.kind === "creature");
      this._binoId.classList.toggle("is-target", r.target);
      this._binoId.classList.toggle("is-danger", r.danger && !r.down);
    }
  }

  /* --- Toasts & trophy tags --- */

  _updateToasts(dt) {
    for (let i = this._toasts.length - 1; i >= 0; i--) {
      const t = this._toasts[i];
      t.age += dt;
      if (t.age > t.life) this._dropToast(t);
    }
    for (let i = this._tags.length - 1; i >= 0; i--) {
      const t = this._tags[i];
      t.age += dt;
      if (t.age > TROPHY_LIFE) this._dropTag(t);
    }
  }

  _dropToast(t) {
    const i = this._toasts.indexOf(t);
    if (i >= 0) this._toasts.splice(i, 1);
    t.el.classList.remove("is-in");
    t.el.classList.add("is-out");
    setTimeout(() => t.el.remove(), 450);
  }

  _dropTag(t) {
    const i = this._tags.indexOf(t);
    if (i >= 0) this._tags.splice(i, 1);
    t.el.classList.remove("is-in");
    t.el.classList.add("is-out");
    setTimeout(() => t.el.remove(), 600);
  }

  _trophyTag(t) {
    const id = t.speciesId || "";
    const n = Array.isArray(this._hunt?.trophies) ? this._hunt.trophies.length : this._tags.length + 1;
    const el = document.createElement("div");
    el.className = `hh-trophy${t.target ? " is-target" : ""}${t.headshot ? " is-head" : ""}`;
    el.setAttribute("role", "status");
    el.innerHTML =
      `<span class="hh-trophy__eyelet" aria-hidden="true"></span>` +
      `<p class="hh-trophy__no">Trophy No. ${String(n).padStart(2, "0")}</p>` +
      `<div class="hh-trophy__sil">${speciesSilhouette(id, { human: false })}</div>` +
      `<p class="hh-trophy__name">${escapeHtml(t.speciesName || id)}</p>` +
      `<p class="hh-trophy__meta"><span>${escapeHtml(formatMass(t.mass))}</span><span>${escapeHtml(fmtDist(Number(t.distance) || 0))}</span>${t.headshot ? "<span>Headshot</span>" : ""}</p>` +
      `<p class="hh-trophy__score"><b>+${fmtInt(t.score)}</b> pts${t.target ? `<em class="hh-tag hh-tag--target">Target</em>` : ""}</p>`;
    this.tagsEl.prepend(el);
    requestAnimationFrame(() => el.classList.add("is-in"));
    this._tags.push({ el, age: 0 });
    while (this._tags.length > 2) this._dropTag(this._tags[0]);
  }

  /* --- Reports --- */

  _openReport(kind, html, onAgain, onMenu) {
    this._report = { open: true, onAgain: onAgain || null, onMenu: onMenu || null, kind };
    this.reportEl.innerHTML = `<div class="hh-report__scrim"></div><div class="hh-report__scroll">${html}</div>`;
    this.reportEl.dataset.kind = kind;
    this.reportEl.classList.add("is-open");
    // Menus need the cursor back.
    if (document.pointerLockElement) document.exitPointerLock?.();
    const primary = this.reportEl.querySelector(".hh-btn--primary");
    setTimeout(() => primary?.focus({ preventScroll: true }), 60);
  }

  _closeReport() {
    this._report.open = false;
    this._report.kind = "";
    this.reportEl.classList.remove("is-open");
    const el = this.reportEl;
    setTimeout(() => {
      if (!this._report.open) el.innerHTML = "";
    }, 500);
  }

  _weaponName(id) {
    if (!id) return "—";
    return this.weaponDefs?.[id]?.name || WEAPON_NAMES[id] || String(id);
  }
}
