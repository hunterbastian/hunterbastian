// Hunter-mode lodge: the expedition planning sheet (two weapons, kit with its
// score-multiplier cost, 1–3 quarry species, drop-off time of day) and the
// trophy room. Laid out like a survey sheet over the live island — numbered
// sections, paper-tag details, brass for what's selected — on the survival
// UI's design tokens so both modes read as one product.
//
// Keyboard: Tab / Shift+Tab cycle inside the sheet, arrow keys move within a
// group (arrows also pick a time of day), Enter begins, Esc backs out.

import { makeRng } from "../core/rng.js";
import { clamp } from "../core/math.js";
import { icon, escapeHtml, formatMass, speciesSilhouette, brandMark } from "./menu.js";
import { ensureHunterStyles, hicon, weaponGlyph, WEAPON_NAMES, SHORT_NAMES } from "./hunterHud.js";

/* --- Data --- */

/** Time-of-day choices → day phase (0 midnight, 0.25 sunrise, 0.5 noon, 0.75 sunset). */
export const HUNT_PHASES = [
  { id: "dawn", label: "Dawn", phase: 0.27, icon: "dawn", note: "Mist and long shadows. Herds drift to water." },
  { id: "day", label: "Day", phase: 0.5, icon: "sun", note: "Clear sight lines — for you and for them." },
  { id: "dusk", label: "Dusk", phase: 0.74, icon: "dusk", note: "Golden light. The predators begin to stir." },
  { id: "night", label: "Night", phase: 0.02, icon: "moon", note: "Moonlight only. The big carnivores roam." },
];

const EQUIPMENT = [
  { id: "camo", name: "Camouflage", icon: "camo", desc: "Eyes find you at 60% of the range." },
  { id: "coverScent", name: "Cover scent", icon: "sniff", desc: "Noses find you at a third of it." },
  { id: "radar", name: "Radar locator", icon: "radar", desc: "Pings quarry within 600 m." },
  { id: "lure", name: "Call device", icon: "call", desc: "Mimics your quarry's call (Q)." },
];
const EQUIPMENT_PENALTY = 0.1; // per item, mirrors HuntSession

// Mirrors hunt.js TROPHY_VALUES; pass `trophyValues` to the constructor to stay in sync.
const TROPHY_VALUE_FALLBACK = {
  dryosaurus: 10,
  camptosaurus: 16,
  gastonia: 30,
  utahraptor: 34,
  ceratosaurus: 42,
  stegosaurus: 48,
  allosaurus: 60,
  diplodocus: 75,
  brontosaurus: 72,
};

const DANGER_LABEL = ["Skittish", "Defends itself", "Dangerous", "Deadly"];
const DEFAULT_UNLOCKED = ["revolver", "shotgun", "rifle"];
const DEFAULT_LOADOUT = ["rifle", "revolver"];
const PLAN_KEY = "sauria.hunter.plan.v1";
const FOCUSABLE = 'button:not([disabled]), [href], [tabindex]:not([tabindex="-1"])';

/* --- Helpers --- */

const fmtInt = (n) => Math.round(Number(n) || 0).toLocaleString("en-US");
const fmtDist = (m) => (m < 1000 ? `${Math.round(m)} m` : `${(m / 1000).toFixed(1)} km`);
const cap = (s) => String(s || "").charAt(0).toUpperCase() + String(s || "").slice(1);

/** 0 skittish … 3 deadly, from diet, temper and bulk. */
function dangerOf(sp) {
  const agg = Number(sp?.aggression) || 0;
  const mass = Number(sp?.mass) || 0;
  if (sp?.diet === "carnivore") return agg >= 0.8 || mass >= 2000 ? 3 : 2;
  if (mass >= 4000 || (agg >= 0.3 && mass >= 1000)) return 1;
  return 0;
}

function readPlan() {
  try {
    const raw = localStorage.getItem(PLAN_KEY);
    const p = raw ? JSON.parse(raw) : null;
    return p && typeof p === "object" ? p : null;
  } catch (err) {
    return null;
  }
}

function writePlan(plan) {
  try {
    localStorage.setItem(PLAN_KEY, JSON.stringify(plan));
  } catch (err) {
    /* private mode / quota: planning still works, it just isn't remembered */
  }
}

/** Topographic contour lines (seeded, smooth) for the sheet's backdrop. */
function topoSVG(seed = 7) {
  const rng = makeRng(seed);
  let d = "";
  const hills = [
    [380, 300, 13],
    [1250, 640, 15],
    [880, 1040, 9],
    [1500, 80, 7],
  ];
  for (const [cx, cy, rings] of hills) {
    const ph = Array.from({ length: 4 }, () => rng() * Math.PI * 2);
    const amp = [0.16, 0.09, 0.05, 0.03].map((a) => a * (0.7 + rng() * 0.6));
    for (let k = 1; k <= rings; k++) {
      const r0 = k * 34;
      let path = "";
      for (let i = 0; i <= 72; i++) {
        const a = (i / 72) * Math.PI * 2;
        // Low harmonics only, so rings nest without crossing; outer rings wobble more.
        const w = 1 + (amp[0] * Math.sin(2 * a + ph[0]) + amp[1] * Math.sin(3 * a + ph[1]) + amp[2] * Math.sin(5 * a + ph[2] + k * 0.15) + amp[3] * Math.sin(7 * a + ph[3])) * (0.5 + k / rings);
        const x = cx + Math.cos(a) * r0 * w * 1.25;
        const y = cy + Math.sin(a) * r0 * w;
        path += `${i ? "L" : "M"}${x.toFixed(0)} ${y.toFixed(0)}`;
      }
      d += `<path class="${k % 5 === 0 ? "idx" : ""}" d="${path}Z"/>`;
    }
  }
  return `<svg class="hm-topo" viewBox="0 0 1600 1000" preserveAspectRatio="xMidYMid slice" aria-hidden="true" focusable="false">${d}</svg>`;
}

/* --- HunterMenu --- */

export class HunterMenu {
  /**
   * @param {HTMLElement} root UI root
   * @param {{ species?: object[], weapons?: object, trophyValues?: object, isTouch?: boolean }} opts
   *   species: huntable SpeciesDef[]; weapons: the WEAPONS map
   */
  constructor(root, { species = [], weapons = {}, trophyValues = null, isTouch = false } = {}) {
    this.root = root;
    this.species = (Array.isArray(species) ? species : []).filter((s) => s && s.id);
    this.weapons = weapons || {};
    this.weaponIds = Object.keys(this.weapons);
    this.trophyValues = trophyValues || TROPHY_VALUE_FALLBACK;
    this.isTouch = !!isTouch;
    this.open = false;

    /** Called with { weapons: [id, id], equipment: { camo, coverScent, radar, lure }, targets: id[], phase }. */
    this.onStart = () => {};
    /** Called when the player backs out to the title screen. */
    this.onBack = () => {};

    this.profile = { points: 0, unlocked: { weapons: DEFAULT_UNLOCKED.slice() }, trophies: [], hunts: 0 };
    this.plan = { weapons: DEFAULT_LOADOUT.slice(), equipment: { camo: false, coverScent: false, radar: false, lure: false }, targets: [], phase: "dawn" };
    this.view = "plan";
    this._stats = this._weaponStats();
    this._statusTimer = 0;
    this._keyboard = false;

    this._build();
    ensureHunterStyles().then(() => {
      this.el.hidden = false;
    });
    this._bind();
  }

  /* --- Public API --- */

  /**
   * Open the lodge.
   * @param {{ points?: number, unlocked?: { weapons?: string[] }, trophies?: object[], hunts?: number }} [profile]
   */
  show(profile) {
    this.profile = this._normalizeProfile(profile);
    this._restorePlan();
    this._renderProfile();
    this._renderArms();
    this._renderSelection();
    this._renderTrophies();
    this._setView("plan", false);
    this.open = true;
    this.el.classList.add("is-open");
    this.el.setAttribute("aria-hidden", "false");
    this._scroll.scrollTop = 0;
    if (document.pointerLockElement) document.exitPointerLock?.();
    // Only grab focus for keyboard users; a mouse user never sees a ring appear unasked.
    if (this._keyboard) setTimeout(() => this.el.querySelector(".hm-arm:not(.is-locked)")?.focus({ preventScroll: true }), 80);
  }

  /** Close the lodge. */
  hide() {
    this.open = false;
    this.el.classList.remove("is-open");
    this.el.setAttribute("aria-hidden", "true");
    if (this.el.contains(document.activeElement)) document.activeElement.blur();
  }

  /** Remove the DOM and listeners. */
  dispose() {
    this._ac.abort();
    this.el.remove();
  }

  /* --- Build --- */

  _build() {
    const el = document.createElement("section");
    el.className = `hm${this.isTouch ? " hm--touch" : ""}`;
    el.hidden = true;
    el.setAttribute("role", "dialog");
    el.setAttribute("aria-modal", "true");
    el.setAttribute("aria-label", "Hunter mode — the lodge");
    el.setAttribute("aria-hidden", "true");

    const quarry = this.species
      .map((sp) => {
        const danger = dangerOf(sp);
        const value = this.trophyValues[sp.id] ?? Math.round(Math.cbrt(Number(sp.mass) || 100) * 3.4);
        const diet = sp.diet === "carnivore" ? "Carnivore" : "Herbivore";
        const pips = [1, 2, 3].map((i) => `<i class="${i <= danger ? "is-on" : ""}"></i>`).join("");
        return (
          `<button type="button" class="hm-q${sp.diet === "carnivore" ? " is-carn" : ""}" data-quarry="${escapeHtml(sp.id)}" aria-pressed="false">` +
          `<span class="hm-q__check" aria-hidden="true">${hicon("check")}</span>` +
          `<span class="hm-q__sil">${speciesSilhouette(sp, { human: false })}</span>` +
          `<span class="hm-q__name">${escapeHtml(sp.name || cap(sp.id))}</span>` +
          `<span class="hm-q__meta"><span class="hm-q__diet">${diet}</span><span>${escapeHtml(formatMass(sp.mass))}</span></span>` +
          `<span class="hm-q__foot"><span class="hm-q__value" title="Base trophy value">${hicon("target")}${value}</span>` +
          `<span class="hm-q__danger" data-level="${danger}"><span class="hm-q__pips" aria-hidden="true">${pips}</span>${DANGER_LABEL[danger]}</span></span>` +
          `</button>`
        );
      })
      .join("");

    const kit = EQUIPMENT.map(
      (k) =>
        `<button type="button" class="hm-kit__item" data-kit="${k.id}" aria-pressed="false">` +
        `<span class="hm-kit__ico">${hicon(k.icon)}</span>` +
        `<span class="hm-kit__text"><span class="hm-kit__name">${k.name}</span><span class="hm-kit__desc">${k.desc}</span></span>` +
        `<span class="hm-kit__cost">−10%</span>` +
        `<span class="hm-switch" aria-hidden="true"><i></i></span>` +
        `</button>`
    ).join("");

    const time = HUNT_PHASES.map(
      (p) =>
        `<button type="button" class="hm-time__opt" role="radio" aria-checked="false" data-phase="${p.id}" tabindex="-1">` +
        `<span class="hm-time__ico">${hicon(p.icon)}</span>` +
        `<span class="hm-time__label">${p.label}</span>` +
        `<span class="hm-time__note">${p.note}</span>` +
        `</button>`
    ).join("");

    const begin = this.isTouch ? "" : `<kbd class="hh-kbd hh-kbd--dark">Enter</kbd>`;

    el.innerHTML = `
      <div class="hm__bg" aria-hidden="true">${topoSVG(20260)}</div>
      <header class="hm-top">
        <div class="hm-brand">${brandMark("hm-brand__mark")}<span class="hm-brand__name">Sauria</span><span class="hm-brand__sep"></span><em class="hm-brand__sub">Hunter's lodge</em></div>
        <div class="hm-tabs" role="tablist" aria-label="Lodge">
          <button type="button" class="hm-tab" role="tab" id="hm-tab-plan" aria-controls="hm-view-plan" data-view="plan" aria-selected="true">${icon("flag")}<span>Expedition</span></button>
          <button type="button" class="hm-tab" role="tab" id="hm-tab-trophies" aria-controls="hm-view-trophies" data-view="trophies" aria-selected="false">${hicon("ledger")}<span>Trophy room</span><span class="hm-tab__n">0</span></button>
        </div>
        <div class="hm-purse" aria-label="Lodge balance">
          <span class="hm-purse__label">Balance</span>
          <span class="hm-purse__n"><span class="hh-stencil">0</span><small>pts</small></span>
          <span class="hm-purse__hunts">0 expeditions</span>
        </div>
      </header>

      <div class="hm-scroll">
        <div class="hm-view" id="hm-view-plan" role="tabpanel" aria-labelledby="hm-tab-plan" data-view="plan">
          <div class="hm-head">
            <p class="hm-eyebrow">Hunter mode · Expedition planning</p>
            <h1 class="hm-title">Plan the expedition</h1>
            <p class="hm-lede">Two weapons, what you carry, what you're after — and the hour the chopper sets you down.</p>
          </div>

          <section class="hm-sec hm-sec--arms" aria-labelledby="hm-h-arms">
            <header class="hm-sec__head"><span class="hm-sec__no">01</span><h2 id="hm-h-arms">Arms</h2><p>${this.isTouch ? "Choose two — swap between them in the field" : "Choose two — keys 1 and 2 in the field"}</p><span class="hm-sec__count" data-count="arms">0 / 2</span></header>
            <div class="hm-arms" data-group="arms"></div>
          </section>

          <div class="hm-grid">
            <section class="hm-sec hm-sec--quarry" aria-labelledby="hm-h-quarry">
              <header class="hm-sec__head"><span class="hm-sec__no">02</span><h2 id="hm-h-quarry">Quarry</h2><p>One to three — they turn up more often and score ×1.5</p><span class="hm-sec__count" data-count="quarry">0 / 3</span></header>
              <div class="hm-quarry" data-group="quarry">${quarry}</div>
            </section>
            <section class="hm-sec hm-sec--kit" aria-labelledby="hm-h-kit">
              <header class="hm-sec__head"><span class="hm-sec__no">03</span><h2 id="hm-h-kit">Kit</h2><p>Each piece costs 10% of every score</p></header>
              <div class="hm-kit" data-group="kit">${kit}</div>
              <div class="hm-mult" aria-live="polite">
                <span class="hm-mult__label">Score multiplier</span>
                <span class="hm-mult__bar" aria-hidden="true"><i></i></span>
                <b class="hm-mult__n">×1.00</b>
              </div>
            </section>
            <section class="hm-sec hm-sec--time" aria-labelledby="hm-h-time">
              <header class="hm-sec__head"><span class="hm-sec__no">04</span><h2 id="hm-h-time">Drop-off</h2><p>Time of day on the island</p></header>
              <div class="hm-time" role="radiogroup" aria-labelledby="hm-h-time" data-group="time">${time}</div>
            </section>
          </div>
        </div>

        <div class="hm-view" id="hm-view-trophies" role="tabpanel" aria-labelledby="hm-tab-trophies" data-view="trophies" hidden>
          <div class="hm-head">
            <p class="hm-eyebrow">Hunter's lodge · Trophy room</p>
            <h1 class="hm-title">Trophy room</h1>
            <p class="hm-lede">Every trophy you flew home with, best first.</p>
          </div>
          <div class="hm-room"></div>
        </div>
      </div>

      <footer class="hm-foot">
        <button type="button" class="hh-btn hh-btn--ghost hm-back" data-act="back">${icon("arrowLeft")}<span>Back</span></button>
        <div class="hm-manifest" aria-live="polite">
          <p class="hm-manifest__label">Manifest</p>
          <p class="hm-manifest__text"></p>
        </div>
        <button type="button" class="hh-btn hh-btn--primary hm-begin" data-act="begin">${hicon("heli")}<span>Begin expedition</span>${begin}</button>
      </footer>
    `;
    this.root.appendChild(el);
    this.el = el;

    const $ = (s) => el.querySelector(s);
    this._scroll = $(".hm-scroll");
    this._armsEl = $(".hm-arms");
    this._room = $(".hm-room");
    this._purseN = $(".hm-purse__n .hh-stencil");
    this._purseHunts = $(".hm-purse__hunts");
    this._tabN = $(".hm-tab__n");
    this._countArms = $('[data-count="arms"]');
    this._countQuarry = $('[data-count="quarry"]');
    this._multN = $(".hm-mult__n");
    this._multBar = $(".hm-mult__bar i");
    this._manifest = $(".hm-manifest__text");
    this._manifestBox = $(".hm-manifest");
    this._begin = $(".hm-begin");
    this._foot = $(".hm-foot");
  }

  _bind() {
    this._ac = new AbortController();
    const sig = { signal: this._ac.signal };
    this.el.addEventListener("click", (e) => this._onClick(e), sig);
    this.el.addEventListener("keydown", (e) => this._onGroupKey(e), sig);
    window.addEventListener("keydown", (e) => {
      if (e.key === "Tab" || e.key.startsWith("Arrow")) this._keyboard = true;
      if (this.open) this._onKey(e);
    }, { capture: true, signal: this._ac.signal });
    window.addEventListener("pointerdown", () => (this._keyboard = false), { capture: true, signal: this._ac.signal });
  }

  /* --- Rendering --- */

  _weaponStats() {
    const defs = this.weaponIds.map((id) => this.weapons[id]).filter(Boolean);
    const dmg = (d) => (Number(d.damage) || 0) * Math.max(1, Number(d.pellets) || 1);
    // Sustained rate: a magazine, then a reload — honest for single-shot weapons.
    const rate = (d) => {
      const mag = Math.max(1, Number(d.magazine) || 1);
      return mag / (mag * (Number(d.fireInterval) || 1) + (Number(d.reloadTime) || 0));
    };
    const max = (f) => Math.max(1e-6, ...defs.map(f));
    return {
      dmg,
      rate,
      maxDmg: max(dmg),
      maxRange: max((d) => Number(d.range) || 0),
      maxRate: max(rate),
      maxNoise: max((d) => Number(d.loudness) || 0),
    };
  }

  _renderArms() {
    const S = this._stats;
    const pts = this.profile.points;
    const unlocked = this.profile.unlocked.weapons;
    this._armsEl.innerHTML = this.weaponIds
      .map((id, i) => {
        const d = this.weapons[id] || {};
        const locked = !unlocked.includes(id);
        const need = Number(d.unlockPoints) || 0;
        const dmg = S.dmg(d);
        const bars = [
          ["Damage", Math.pow(dmg / S.maxDmg, 0.75), d.pellets > 1 ? `${d.damage}×${d.pellets}` : fmtInt(dmg), ""],
          ["Range", Math.sqrt((Number(d.range) || 0) / S.maxRange), `${fmtInt(d.range)} m`, ""],
          ["Fire rate", S.rate(d) / S.maxRate, `${Math.round(S.rate(d) * 60)}/min`, ""],
          ["Noise", (Number(d.loudness) || 0) / S.maxNoise, `${fmtInt(d.loudness)} m`, (Number(d.loudness) || 0) / S.maxNoise > 0.6 ? " is-loud" : (Number(d.loudness) || 0) / S.maxNoise < 0.15 ? " is-quiet" : ""],
        ]
          .map(
            ([label, v, text, cls]) =>
              `<span class="hm-stat${cls}"><span class="hm-stat__label">${label}</span><span class="hm-stat__bar"><i style="transform:scaleX(${clamp(v, 0.04, 1).toFixed(3)})"></i></span><span class="hm-stat__v">${escapeHtml(text)}</span></span>`
          )
          .join("");
        const meta = [`Mag ${d.magazine ?? "—"}`, d.scope > 0 ? `${d.scope}×` : null, d.pellets > 1 ? `${d.pellets} pellets` : null, d.projectile > 0 ? "Bolt drop" : null]
          .filter(Boolean)
          .join(" · ");
        const lock = locked
          ? `<span class="hm-arm__lock">${hicon("lock")}<span><b>${fmtInt(need)} pts</b> to unlock<small>${need > pts ? `${fmtInt(need - pts)} to go` : "Bank a hunt to claim"}</small></span>` +
            `<span class="hm-arm__progress" aria-hidden="true"><i style="transform:scaleX(${clamp(pts / Math.max(1, need), 0, 1).toFixed(3)})"></i></span></span>`
          : "";
        return (
          `<button type="button" class="hm-arm${locked ? " is-locked" : ""}" data-arm="${escapeHtml(id)}" aria-pressed="false"${locked ? ` aria-disabled="true"` : ""} aria-label="${escapeHtml(d.name || id)}${locked ? `, locked — ${fmtInt(need)} points` : ""}">` +
          `<span class="hm-arm__top"><span class="hm-arm__no">W·${String(i + 1).padStart(2, "0")}<span class="hm-arm__meta">${escapeHtml(meta)}</span></span><span class="hm-arm__slot" aria-hidden="true"></span></span>` +
          `<span class="hm-arm__art">${weaponGlyph(id)}</span>` +
          `<span class="hm-arm__name">${escapeHtml(d.name || WEAPON_NAMES[id] || id)}</span>` +
          `<span class="hm-arm__desc">${escapeHtml(d.description || "")}</span>` +
          `<span class="hm-arm__stats">${bars}</span>` +
          lock +
          `</button>`
        );
      })
      .join("");
  }

  _renderProfile() {
    const p = this.profile;
    this._purseN.textContent = fmtInt(p.points);
    this._purseHunts.textContent = `${fmtInt(p.hunts)} expedition${p.hunts === 1 ? "" : "s"}`;
    this._tabN.textContent = fmtInt(p.trophies.length);
  }

  _renderSelection() {
    const plan = this.plan;
    for (const b of this.el.querySelectorAll("[data-arm]")) {
      const slot = plan.weapons.indexOf(b.dataset.arm);
      b.setAttribute("aria-pressed", String(slot >= 0));
      b.classList.toggle("is-on", slot >= 0);
      b.querySelector(".hm-arm__slot").textContent = slot >= 0 ? (slot === 0 ? "1 · Primary" : "2 · Sidearm") : "";
    }
    for (const b of this.el.querySelectorAll("[data-quarry]")) {
      const on = plan.targets.includes(b.dataset.quarry);
      b.setAttribute("aria-pressed", String(on));
      b.classList.toggle("is-on", on);
    }
    for (const b of this.el.querySelectorAll("[data-kit]")) {
      const on = !!plan.equipment[b.dataset.kit];
      b.setAttribute("aria-pressed", String(on));
      b.classList.toggle("is-on", on);
    }
    for (const b of this.el.querySelectorAll("[data-phase]")) {
      const on = b.dataset.phase === plan.phase;
      b.setAttribute("aria-checked", String(on));
      b.tabIndex = on ? 0 : -1;
      b.classList.toggle("is-on", on);
    }
    this._countArms.textContent = `${plan.weapons.length} / 2`;
    this._countArms.classList.toggle("is-done", plan.weapons.length === 2);
    this._countQuarry.textContent = `${plan.targets.length} / 3`;
    this._countQuarry.classList.toggle("is-done", plan.targets.length > 0);

    const mult = this._multiplier();
    this._multN.textContent = `×${mult.toFixed(2)}`;
    this._multBar.style.transform = `scaleX(${mult.toFixed(2)})`;
    this._multN.classList.toggle("is-cut", mult < 1);

    if (this._statusTimer <= 0) this._renderManifest();
    this._begin.disabled = !this._ready();
  }

  _renderManifest() {
    const plan = this.plan;
    const w = plan.weapons.map((id) => SHORT_NAMES[id] || this.weapons[id]?.name || id);
    const t = plan.targets.map((id) => this.species.find((s) => s.id === id)?.name || cap(id));
    const ph = HUNT_PHASES.find((p) => p.id === plan.phase);
    let text;
    let warn = false;
    if (plan.weapons.length < 2) {
      text = plan.weapons.length ? "Choose a second weapon — a sidearm for when it gets close." : "Choose two weapons to carry.";
      warn = true;
    } else if (!plan.targets.length) {
      text = "Choose at least one quarry species.";
      warn = true;
    } else {
      text = `${w.join(" + ")} · ${t.join(", ")} · ${ph?.label || "Dawn"} · ×${this._multiplier().toFixed(2)}`;
    }
    this._manifest.textContent = text;
    this._manifestBox.classList.toggle("is-warn", warn);
  }

  /** Brief status line in the manifest slot (locked weapon, too many targets…). */
  _status(text) {
    this._manifest.textContent = text;
    this._manifestBox.classList.add("is-warn");
    clearTimeout(this._statusT);
    this._statusTimer = 1;
    this._statusT = setTimeout(() => {
      this._statusTimer = 0;
      this._renderManifest();
    }, 2600);
  }

  _renderTrophies() {
    const list = this.profile.trophies.slice().sort((a, b) => (Number(b.score) || 0) - (Number(a.score) || 0));
    if (!list.length) {
      this._room.innerHTML =
        `<div class="hm-empty">` +
        `<div class="hm-empty__plaque" aria-hidden="true">${speciesSilhouette("allosaurus", { human: false })}</div>` +
        `<p class="hm-empty__title">The walls are bare</p>` +
        `<p class="hm-empty__text">Every animal you bring home on an extraction is mounted here — species, weight, the length of the shot. Trophies die with you, so call the chopper before your luck runs out.</p>` +
        `<button type="button" class="hh-btn hh-btn--ghost" data-view="plan">${icon("flag")}<span>Plan an expedition</span></button>` +
        `</div>`;
      return;
    }
    const best = list[0];
    const heaviest = list.reduce((a, t) => (Number(t.mass) > Number(a.mass) ? t : a), list[0]);
    const longest = list.reduce((a, t) => Math.max(a, Number(t.distance) || 0), 0);
    const heads = list.filter((t) => t.headshot).length;
    const date = (t) => {
      const d = t.date ? new Date(t.date) : null;
      return d && !Number.isNaN(d.getTime()) ? d.toLocaleDateString("en-GB", { day: "numeric", month: "short", year: "numeric" }) : "";
    };
    const rows = list
      .map((t, i) => {
        const id = t.speciesId || "";
        return (
          `<li class="hm-ledger__row${i === 0 ? " is-best" : ""}">` +
          `<span class="hm-ledger__rank">${String(i + 1).padStart(2, "0")}</span>` +
          `<span class="hm-ledger__sil">${speciesSilhouette(id, { human: false })}</span>` +
          `<span class="hm-ledger__sp"><b>${escapeHtml(t.speciesName || cap(id))}</b><small>${escapeHtml([date(t), t.clock].filter(Boolean).join(" · "))}${t.target ? `<em class="hh-tag hh-tag--target">Target</em>` : ""}</small></span>` +
          `<span class="hm-ledger__c" data-label="Weight">${escapeHtml(formatMass(t.mass))}</span>` +
          `<span class="hm-ledger__c" data-label="Shot">${escapeHtml(fmtDist(Number(t.distance) || 0))}</span>` +
          `<span class="hm-ledger__c hm-ledger__head" data-label="Head">${t.headshot ? hicon("check") : "—"}</span>` +
          `<span class="hm-ledger__c hm-ledger__arm" data-label="Arm">${escapeHtml(SHORT_NAMES[t.weapon] || this.weapons[t.weapon]?.name || "—")}</span>` +
          `<span class="hm-ledger__score"><b>${fmtInt(t.score)}</b><small>pts</small></span>` +
          `</li>`
        );
      })
      .join("");
    this._room.innerHTML =
      `<dl class="hm-records">` +
      `<div><dt>Trophies</dt><dd>${fmtInt(list.length)}</dd></div>` +
      `<div><dt>Best</dt><dd>${fmtInt(best.score)}<small>${escapeHtml(best.speciesName || "")}</small></dd></div>` +
      `<div><dt>Heaviest</dt><dd>${escapeHtml(formatMass(heaviest.mass))}<small>${escapeHtml(heaviest.speciesName || "")}</small></dd></div>` +
      `<div><dt>Longest shot</dt><dd>${escapeHtml(fmtDist(longest))}</dd></div>` +
      `<div><dt>Headshots</dt><dd>${fmtInt(heads)}<small>of ${fmtInt(list.length)}</small></dd></div>` +
      `</dl>` +
      `<div class="hm-ledger__head-row" aria-hidden="true"><span>No.</span><span></span><span>Species</span><span>Weight</span><span>Shot</span><span>Head</span><span>Arm</span><span>Score</span></div>` +
      `<ol class="hm-ledger" aria-label="Trophies, best first">${rows}</ol>`;
  }

  /* --- State --- */

  _normalizeProfile(p) {
    const src = p && typeof p === "object" ? p : {};
    const listed = Array.isArray(src.unlocked?.weapons) ? src.unlocked.weapons : [];
    const points = Math.max(0, Number(src.points) || 0);
    // A weapon is usable when the profile lists it, it's a starter, or it costs nothing.
    const unlocked = this.weaponIds.filter((id) => listed.includes(id) || DEFAULT_UNLOCKED.includes(id) || !(Number(this.weapons[id]?.unlockPoints) > 0));
    return {
      points,
      unlocked: { weapons: unlocked },
      trophies: Array.isArray(src.trophies) ? src.trophies.filter((t) => t && typeof t === "object") : [],
      hunts: Math.max(0, Number(src.hunts) || 0),
    };
  }

  _restorePlan() {
    const saved = readPlan() || {};
    const unlocked = this.profile.unlocked.weapons;
    const ids = this.species.map((s) => s.id);
    let weapons = (Array.isArray(saved.weapons) ? saved.weapons : this.plan.weapons).filter((id, i, a) => unlocked.includes(id) && a.indexOf(id) === i).slice(0, 2);
    for (const id of DEFAULT_LOADOUT.concat(unlocked)) {
      if (weapons.length >= 2) break;
      if (unlocked.includes(id) && !weapons.includes(id)) weapons.push(id);
    }
    let targets = (Array.isArray(saved.targets) ? saved.targets : this.plan.targets).filter((id, i, a) => ids.includes(id) && a.indexOf(id) === i).slice(0, 3);
    if (!targets.length && ids.length) targets = [ids.includes("camptosaurus") ? "camptosaurus" : ids[0]];
    const eq = saved.equipment && typeof saved.equipment === "object" ? saved.equipment : this.plan.equipment;
    const phase = HUNT_PHASES.some((p) => p.id === saved.phase) ? saved.phase : this.plan.phase;
    this.plan = {
      weapons,
      targets,
      equipment: { camo: !!eq.camo, coverScent: !!eq.coverScent, radar: !!eq.radar, lure: !!eq.lure },
      phase,
    };
  }

  _multiplier() {
    const n = EQUIPMENT.reduce((a, k) => a + (this.plan.equipment[k.id] ? 1 : 0), 0);
    return Math.max(0, 1 - EQUIPMENT_PENALTY * n);
  }

  _ready() {
    return this.plan.weapons.length === 2 && this.plan.targets.length >= 1 && this.plan.targets.length <= 3;
  }

  _setView(view, focus = true) {
    this.view = view;
    for (const t of this.el.querySelectorAll(".hm-tab")) {
      const on = t.dataset.view === view;
      t.setAttribute("aria-selected", String(on));
      t.tabIndex = on ? 0 : -1;
    }
    for (const v of this.el.querySelectorAll(".hm-view")) v.hidden = v.dataset.view !== view;
    this.el.dataset.view = view;
    this._scroll.scrollTop = 0;
    if (focus && this._keyboard) this.el.querySelector(`.hm-tab[data-view="${view}"]`)?.focus({ preventScroll: true });
  }

  _start() {
    if (!this._ready()) {
      this._renderManifest();
      this._nudge(this._manifestBox);
      return;
    }
    const plan = this.plan;
    writePlan(plan);
    const phase = HUNT_PHASES.find((p) => p.id === plan.phase)?.phase ?? 0.27;
    this.onStart({
      weapons: plan.weapons.slice(0, 2),
      equipment: { ...plan.equipment },
      targets: plan.targets.slice(0, 3),
      phase,
    });
  }

  _nudge(el) {
    if (!el?.animate || matchMedia?.("(prefers-reduced-motion: reduce)").matches) return;
    el.animate([{ transform: "translateX(0)" }, { transform: "translateX(-5px)" }, { transform: "translateX(4px)" }, { transform: "translateX(-2px)" }, { transform: "translateX(0)" }], { duration: 320, easing: "ease-out" });
  }

  /* --- Input --- */

  _onClick(e) {
    const t = e.target.closest?.("button");
    if (!t || !this.el.contains(t)) return;
    if (t.dataset.view) return this._setView(t.dataset.view);
    if (t.dataset.act === "back") return this.onBack();
    if (t.dataset.act === "begin") return this._start();
    const plan = this.plan;
    if (t.dataset.arm) {
      const id = t.dataset.arm;
      if (t.classList.contains("is-locked")) {
        const need = Number(this.weapons[id]?.unlockPoints) || 0;
        this._status(`${this.weapons[id]?.name || cap(id)} unlocks at ${fmtInt(need)} points — ${fmtInt(Math.max(0, need - this.profile.points))} to go.`);
        this._nudge(t);
        return;
      }
      const i = plan.weapons.indexOf(id);
      if (i >= 0) plan.weapons.splice(i, 1);
      else if (plan.weapons.length < 2) plan.weapons.push(id);
      else plan.weapons[1] = id; // keep the primary, swap the sidearm
    } else if (t.dataset.quarry) {
      const id = t.dataset.quarry;
      const i = plan.targets.indexOf(id);
      if (i >= 0) plan.targets.splice(i, 1);
      else if (plan.targets.length < 3) plan.targets.push(id);
      else {
        this._status("Three quarry species at most — drop one first.");
        this._nudge(this._countQuarry);
        return;
      }
    } else if (t.dataset.kit) {
      plan.equipment[t.dataset.kit] = !plan.equipment[t.dataset.kit];
    } else if (t.dataset.phase) {
      plan.phase = t.dataset.phase;
    } else {
      return;
    }
    this._renderSelection();
  }

  _onKey(e) {
    if (e.key === "Escape") {
      e.preventDefault();
      e.stopPropagation();
      if (this.view !== "plan") this._setView("plan");
      else this.onBack();
      return;
    }
    if (e.key === "Tab") {
      const items = [...this.el.querySelectorAll(FOCUSABLE)].filter((el) => el.offsetParent !== null);
      if (!items.length) return;
      const first = items[0];
      const last = items[items.length - 1];
      if (!this.el.contains(document.activeElement)) {
        e.preventDefault();
        (e.shiftKey ? last : first).focus();
      } else if (e.shiftKey && document.activeElement === first) {
        e.preventDefault();
        last.focus();
      } else if (!e.shiftKey && document.activeElement === last) {
        e.preventDefault();
        first.focus();
      }
      return;
    }
    if (e.key === "Enter" && this.view === "plan") {
      const a = document.activeElement;
      // Enter on a focused control activates that control; anywhere else it begins.
      if (!a || a === document.body || !this.el.contains(a) || a === this._scroll) {
        e.preventDefault();
        this._start();
      }
    }
  }

  /** Arrow keys move within a group; in the time-of-day radio group they also select. */
  _onGroupKey(e) {
    const dir = { ArrowLeft: -1, ArrowUp: -1, ArrowRight: 1, ArrowDown: 1 }[e.key];
    if (!dir) return;
    const btn = e.target.closest?.("button");
    const group = btn?.closest?.("[data-group], .hm-tabs");
    if (!group) return;
    const items = [...group.querySelectorAll("button")].filter((b) => b.offsetParent !== null);
    const i = items.indexOf(btn);
    if (i < 0) return;
    e.preventDefault();
    const next = items[(i + dir + items.length) % items.length];
    next.focus();
    if (group.dataset.group === "time") {
      this.plan.phase = next.dataset.phase;
      this._renderSelection();
    } else if (group.classList.contains("hm-tabs")) {
      this._setView(next.dataset.view);
    }
  }
}
