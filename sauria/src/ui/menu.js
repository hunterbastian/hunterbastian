// Title screen, species selection, settings and loading.
//
// The menu floats over the live attract-mode island: every layer here is a
// translucent overlay, so main keeps rendering the world behind it. Hidden
// layers are `visibility: hidden` + `inert`, so they never intercept input or
// block the canvas.
//
// This file also hosts the small shared UI kit — icons, specimen silhouettes,
// formatters, the controls cheat-sheet — that hud.js and map.js import, so the
// three UI modules speak one visual language.

import { clamp, lerp } from "../core/math.js";
import { makeRng, hash } from "../core/rng.js";

/* --- Icons ----------------------------------------------------------------- */

// 24×24 line icons drawn in currentColor (CSS sets stroke width / caps on .ico).
// Paths marked class="f" are filled instead of stroked.
const ICON_PATHS = {
  arrowRight: '<path d="M4 12h15"/><path d="M13.5 6.5 19 12l-5.5 5.5"/>',
  arrowLeft: '<path d="M20 12H5"/><path d="M10.5 6.5 5 12l5.5 5.5"/>',
  close: '<path d="M6.5 6.5l11 11M17.5 6.5l-11 11"/>',
  settings:
    '<path d="M4 7.5h9M18 7.5h2M4 16.5h2M11 16.5h9"/><circle cx="15.5" cy="7.5" r="2.4"/><circle cx="8.5" cy="16.5" r="2.4"/>',
  keyboard:
    '<rect x="2.5" y="6" width="19" height="12" rx="2.2"/><path d="M6.5 10h.01M10 10h.01M14 10h.01M17.5 10h.01M7.5 14h9"/>',
  hand:
    '<path d="M9 11.5V5.2a1.6 1.6 0 0 1 3.2 0V11"/><path d="M12.2 10.2V8.8a1.6 1.6 0 0 1 3.2 0v2.4"/>' +
    '<path d="M15.4 10.6a1.6 1.6 0 0 1 3.2 0v3.6a6.3 6.3 0 0 1-6.3 6.3h-.6a6.2 6.2 0 0 1-4.8-2.3l-2.6-3.3a1.6 1.6 0 0 1 2.4-2.1L9 14.6"/>',
  heart: '<path d="M12 20s-7.6-4.6-7.6-10.2A4.4 4.4 0 0 1 12 7.2a4.4 4.4 0 0 1 7.6 2.6C19.6 15.4 12 20 12 20z"/>',
  bolt: '<path d="M13.4 2.8 5.6 13.4h6.1l-1.1 7.8 7.8-10.7h-6.1z"/>',
  meat:
    '<path d="M9.2 15.4C6.1 12.6 6.3 7.4 9.8 5.1c3.3-2.1 8.2-.9 9.9 2.7 1.8 3.7-.4 8.3-4.4 8.9-2.1.3-3.7-.2-4.8-.8"/>' +
    '<path d="M10.5 15.9 7 19.4"/><path d="M7.6 20.9a1.5 1.5 0 1 1-1.9-1.9 1.5 1.5 0 1 1 1.9-1.9"/>',
  leaf: '<path d="M5 19.5C5 11 10.2 5 19.5 4.5 19.5 14 14 19.5 5 19.5z"/><path d="M5 19.5l8.5-8.5"/>',
  drop: '<path d="M12 3.4c3.7 4.5 6.1 7.8 6.1 10.7a6.1 6.1 0 0 1-12.2 0c0-2.9 2.4-6.2 6.1-10.7z"/>',
  bleed:
    '<path d="M9 4.2c2.9 3.5 4.8 6.1 4.8 8.4a4.8 4.8 0 0 1-9.6 0c0-2.3 1.9-4.9 4.8-8.4z"/>' +
    '<path d="M17.6 11.6c1.4 1.7 2.4 3 2.4 4.2a2.4 2.4 0 0 1-4.8 0c0-1.2 1-2.5 2.4-4.2z"/>',
  fracture:
    '<path d="M8.6 9.9 5.9 7.2a1.9 1.9 0 1 1-1.4-3 1.9 1.9 0 1 1 3-1.3"/><path d="M7.5 2.9l3 3"/>' +
    '<path d="M15.4 14.1l2.7 2.7a1.9 1.9 0 1 1 1.4 3 1.9 1.9 0 1 1-3 1.3"/><path d="M16.5 21.1l-3-3"/>' +
    '<path d="M8.6 9.9l2.3-.6-.6 2.1 2.6-.4-.7 2.4 1.9-.3 1.3 1"/>',
  moon: '<path d="M19.4 14.6A8 8 0 1 1 9.4 4.6a6.4 6.4 0 0 0 10 10z"/>',
  sun:
    '<circle cx="12" cy="12" r="4.2"/><path d="M12 2.5v2.2M12 19.3v2.2M2.5 12h2.2M19.3 12h2.2M5.3 5.3l1.6 1.6M17.1 17.1l1.6 1.6M5.3 18.7l1.6-1.6M17.1 6.9l1.6-1.6"/>',
  dawn: '<path d="M3 17.5h18M6.5 17.5a5.5 5.5 0 0 1 11 0"/><path d="M12 4.5v3M4.6 9.4l2 1.6M19.4 9.4l-2 1.6M3 21h18"/>',
  waves:
    '<path d="M2.5 9.5c1.6-1.3 3.2-1.3 4.8 0s3.2 1.3 4.7 0 3.2-1.3 4.8 0 3.1 1.3 4.7 0"/>' +
    '<path d="M2.5 15c1.6-1.3 3.2-1.3 4.8 0s3.2 1.3 4.7 0 3.2-1.3 4.8 0 3.1 1.3 4.7 0"/>',
  crouch: '<path d="M12 3.5v10.5"/><path d="M7.5 9.5 12 14l4.5-4.5"/><path d="M4.5 19h15"/>',
  rest: '<path d="M18.8 15.1A7.6 7.6 0 1 1 9.2 5.5a6.1 6.1 0 0 0 9.6 9.6z"/><path d="M14.6 3.5h4.2l-4.2 4.6h4.2"/>',
  track:
    '<path class="f" d="M12 21.3c-2.2 0-3.6-1.5-3.3-3.4.2-1.4 1.6-2.4 3.3-2.4s3.1 1 3.3 2.4c.3 1.9-1.1 3.4-3.3 3.4z"/>' +
    '<path d="M12 14.2V3.8M10.6 15 5.3 8.5M13.4 15l5.3-6.5" stroke-width="2.4"/>',
  bone:
    '<path d="M7.2 9.4a2.1 2.1 0 1 0-2.6 2.6 2.1 2.1 0 1 0 2.6 2.6h9.6a2.1 2.1 0 1 0 2.6-2.6 2.1 2.1 0 1 0-2.6-2.6z"/>',
  claw: '<path d="M5.5 4.5c2.8 3.1 4 8.3 3.4 14.5M11 3.5c2.8 3.1 4 8.3 3.4 14.5M16.5 4.5c2.8 3.1 4 8.3 3.4 14.5"/>',
  sniff:
    '<path d="M7 20.5c-1.9-2.8 1.9-4.6 0-7.6s1.9-4.8 0-7.9"/><path d="M12 20.5c-1.9-2.8 1.9-4.6 0-7.6s1.9-4.8 0-7.9"/>' +
    '<path d="M17 20.5c-1.9-2.8 1.9-4.6 0-7.6s1.9-4.8 0-7.9"/>',
  call: '<path d="M3.5 9.5v5h3.2l4.8 4V5.5l-4.8 4H3.5z"/><path d="M15 9a4.2 4.2 0 0 1 0 6"/><path d="M17.6 6.3a8 8 0 0 1 0 11.4"/>',
  bite:
    '<path d="M3 8.6C6.2 4.8 17.8 4.8 21 8.6"/><path d="M4.6 8.4l1.6 2.7 1.7-2.5 1.6 2.7 1.7-2.7 1.6 2.7 1.6-2.7 1.7 2.5 1.6-2.7"/>' +
    '<path d="M3 15.4c3.2 3.8 14.8 3.8 18 0"/><path d="M4.6 15.6l1.6-2.7 1.7 2.5 1.6-2.7 1.7 2.7 1.6-2.7 1.6 2.7 1.7-2.5 1.6 2.7"/>',
  interact:
    '<path d="M3.5 20.5c0-7.2 4.3-11.6 11-12.2 0 7.2-4.3 11.6-11 12.2z"/><path d="M3.5 20.5l6.4-6.4"/>' +
    '<path d="M17.5 2.8c1.9 2.5 3 4.3 3 5.7a3 3 0 0 1-6 0c0-1.4 1.1-3.2 3-5.7z"/>',
  sprint: '<path d="M5 5.5l6.5 6.5L5 18.5"/><path d="M12.5 5.5 19 12l-6.5 6.5"/>',
  map: '<path d="M3.5 6.6 9 4.3l6 2.4 5.5-2.3v13.4L15 20.1l-6-2.4-5.5 2.3z"/><path d="M9 4.3v13.4M15 6.7v13.4"/>',
  pause: '<path d="M8.5 5v14M15.5 5v14"/>',
  play: '<path d="M7.5 4.8v14.4L19 12z"/>',
  egg: '<path d="M12 3c3.7 0 6.6 5.7 6.6 10.3a6.6 6.6 0 0 1-13.2 0C5.4 8.7 8.3 3 12 3z"/><path d="M6.4 12.6l2.4 1.7 2.2-2.2 2.3 2.2 2.3-1.8 2.1 1"/>',
  sound: '<path d="M3.5 9.5v5h3.2l4.8 4V5.5l-4.8 4H3.5z"/><path d="M15.2 9.2a4 4 0 0 1 0 5.6M17.8 6.6a7.6 7.6 0 0 1 0 10.8"/>',
  mute: '<path d="M3.5 9.5v5h3.2l4.8 4V5.5l-4.8 4H3.5z"/><path d="M15.5 9.5l5 5M20.5 9.5l-5 5"/>',
  compass: '<circle cx="12" cy="12" r="8.8"/><path d="M14.8 9.2 13 13l-3.8 1.8L11 11z"/>',
  flag: '<path d="M5.5 21V3.8"/><path d="M5.5 4.5h11.2l-2.2 3.6 2.2 3.6H5.5"/>',
  stick: '<circle cx="12" cy="12" r="8.6"/><circle class="f" cx="13.6" cy="10.4" r="3.4"/>',
  rotate:
    '<rect x="7.5" y="2.8" width="9" height="15.4" rx="1.8"/><path d="M11 15.4h2"/><path d="M3.5 13.5a8.6 8.6 0 0 0 7 7.7"/><path d="M8.6 20l1.9 1.2-1.1 1.9"/>',
  skull:
    '<path d="M12 3.2c-4.6 0-8 3.2-8 7.5 0 2.4 1.1 4.2 2.8 5.4v2.6c0 .9.7 1.6 1.6 1.6h7.2c.9 0 1.6-.7 1.6-1.6v-2.6c1.7-1.2 2.8-3 2.8-5.4 0-4.3-3.4-7.5-8-7.5z"/>' +
    '<circle cx="9" cy="11.4" r="1.7"/><circle cx="15" cy="11.4" r="1.7"/><path d="M10.4 20.3v-2.2M13.6 20.3v-2.2"/>',
};

/**
 * Inline SVG icon markup.
 * @param {string} name key of ICON_PATHS
 * @param {string} [cls] extra class names
 * @returns {string}
 */
export function icon(name, cls = "") {
  return `<svg class="ico${cls ? ` ${cls}` : ""}" viewBox="0 0 24 24" aria-hidden="true" focusable="false">${ICON_PATHS[name] || ""}</svg>`;
}

/* --- Formatting -------------------------------------------------------------- */

const HTML_ESC = { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" };
/** Escape text for safe interpolation into markup. */
export const escapeHtml = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => HTML_ESC[c]);

export const STAGE_LABEL = { juvenile: "Juvenile", subadult: "Sub-adult", adult: "Adult" };

/** Growth 0..1 → contract stage id (mirrors species.growthStage). */
export function stageOf(growth) {
  if (growth >= 1) return "adult";
  return growth >= 0.4 ? "subadult" : "juvenile";
}

/** 90 → "90 kg", 2300 → "2.3 t". */
export function formatMass(kg) {
  const m = Math.max(0, Number(kg) || 0);
  if (m < 1000) return `${Math.round(m)} kg`;
  const t = m / 1000;
  return `${t >= 10 ? Math.round(t) : Math.round(t * 10) / 10} t`;
}

/** Seconds → "45 s", "14 min 32 s", "2 h 04 min". */
export function formatDuration(sec) {
  const s = Math.max(0, Math.floor(Number(sec) || 0));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const r = s % 60;
  if (h > 0) return `${h} h ${String(m).padStart(2, "0")} min`;
  if (m > 0) return `${m} min ${String(r).padStart(2, "0")} s`;
  return `${r} s`;
}

/** "a" / "an" for the next word ("an adult", "a juvenile"). */
export const article = (word) => (/^[aeiou]/i.test(String(word || "")) ? "an" : "a");

/* --- Controls cheat-sheet ---------------------------------------------------------- */

const KEYS_SURVIVAL = [
  ["Move", ["W", "A", "S", "D"]],
  ["Look", ["Mouse"], "click the island to capture it"],
  ["Sprint", ["Shift"]],
  ["Crouch", ["C"], "or hold Ctrl"],
  ["Bite · attack", ["LMB"], "or F"],
  ["Eat · drink", ["E"], "hold, head at the food"],
  ["Call", ["Q"]],
  ["Sniff", ["R"]],
  ["Rest", ["Z"]],
  ["Map", ["M"]],
  ["Zoom", ["Wheel"]],
  ["Pause", ["Esc"], "or P"],
  ["Field notes", ["H"]],
];

const TOUCH_SURVIVAL = [
  ["Move", "stick", "Thumb anywhere on the left half"],
  ["Look", "hand", "Drag across the right half"],
  ["Bite", "bite", "Large button, bottom right"],
  ["Eat · drink", "interact", "Hold near food or fresh water"],
  ["Sprint", "sprint", "Tap — lift the stick to stop"],
  ["Crouch", "crouch", "Tap to toggle"],
  ["Sniff", "sniff", "Reveals food, water, others"],
  ["Call · rest", "call", "Outer ring"],
  ["Map · pause", "map", "Top right"],
];

const KEYS_HUNTER = [
  ["Fire", ["LMB"], "or F"],
  ["Aim · scope", ["RMB"]],
  ["Reload", ["R"]],
  ["Weapons", ["1", "2"]],
  ["Binoculars", ["B"]],
  ["Lure call", ["Q"]],
  ["Call extraction", ["X"]],
];

const kbd = (k) => `<kbd class="kbd">${escapeHtml(k)}</kbd>`;

/**
 * Controls reference as markup: keyboard & mouse and touch columns, the
 * device in use first. Shared by the title screen and the in-game help.
 * @param {{ isTouch?: boolean, hunter?: boolean }} [opts] include the Hunter-mode keys
 * @returns {string}
 */
export function controlsSheetHTML({ isTouch = false, hunter = true } = {}) {
  const keyRows = (rows) =>
    rows
      .map(
        ([label, keys, note]) =>
          `<li class="ctl"><span class="ctl__label">${escapeHtml(label)}</span><span class="ctl__keys">${keys
            .map(kbd)
            .join("")}</span>${note ? `<span class="ctl__note">${escapeHtml(note)}</span>` : ""}</li>`,
      )
      .join("");
  const touchRows = TOUCH_SURVIVAL.map(
    ([label, ico, note]) =>
      `<li class="ctl"><span class="ctl__label">${escapeHtml(label)}</span><span class="ctl__keys"><span class="tglyph">${icon(
        ico,
      )}</span></span><span class="ctl__note">${escapeHtml(note)}</span></li>`,
  ).join("");
  const desktop =
    `<section class="ctl-col"><h3 class="ctl-col__title">${icon("keyboard")}Keyboard &amp; mouse</h3>` +
    `<ul class="ctl-list">${keyRows(KEYS_SURVIVAL)}</ul></section>`;
  // Hunter keys sit under the touch column so the two columns balance.
  const touch =
    `<section class="ctl-col"><h3 class="ctl-col__title">${icon("hand")}Touch</h3>` +
    `<ul class="ctl-list">${touchRows}</ul>` +
    `<p class="ctl-col__foot">Hunter mode swaps the ring for fire, aim, reload, binoculars and lure.</p>` +
    (hunter
      ? `<h4 class="ctl-col__sub">${icon("keyboard")}Hunter mode · keyboard</h4><ul class="ctl-list ctl-list--compact">${keyRows(KEYS_HUNTER)}</ul>`
      : "") +
    `</section>`;
  return `<div class="ctl-grid">${isTouch ? touch + desktop : desktop + touch}</div>`;
}

/* --- Specimen silhouettes ---------------------------------------------------------- */

// Field-guide plates: each species is a smooth loft along a spine (x 0 = tail
// tip … ~100 = snout, y up is negative, ground at 0) plus limbs and features.
// Far-side limbs are drawn dimmer for depth; a 1.8 m person stands for scale.

const f1 = (v) => String(Math.round(v * 10) / 10);

/** Closed Catmull-Rom spline through `pts` as an SVG path. */
function smoothClosed(pts) {
  const n = pts.length;
  let d = `M${f1(pts[0][0])},${f1(pts[0][1])}`;
  for (let i = 0; i < n; i++) {
    const p0 = pts[(i - 1 + n) % n];
    const p1 = pts[i];
    const p2 = pts[(i + 1) % n];
    const p3 = pts[(i + 2) % n];
    d +=
      `C${f1(p1[0] + (p2[0] - p0[0]) / 6)},${f1(p1[1] + (p2[1] - p0[1]) / 6)} ` +
      `${f1(p2[0] - (p3[0] - p1[0]) / 6)},${f1(p2[1] - (p3[1] - p1[1]) / 6)} ${f1(p2[0])},${f1(p2[1])}`;
  }
  return `<path d="${d}Z"/>`;
}

/** Body outline from spine samples [x, y, thicknessUp, thicknessDown]. */
function loft(spine) {
  const top = [];
  const bot = [];
  for (let i = 0; i < spine.length; i++) {
    const a = spine[Math.max(0, i - 1)];
    const b = spine[Math.min(spine.length - 1, i + 1)];
    const l = Math.hypot(b[0] - a[0], b[1] - a[1]) || 1;
    const nx = (b[1] - a[1]) / l;
    const ny = -(b[0] - a[0]) / l;
    const [x, y, up, dn] = spine[i];
    top.push([x + nx * up, y + ny * up]);
    bot.push([x - nx * dn, y - ny * dn]);
  }
  return smoothClosed(top.concat(bot.reverse()));
}

/** Height of the back (top outline) of a spine at x — for features riding on it. */
function backAt(spine, x) {
  for (let i = 0; i < spine.length - 1; i++) {
    const a = spine[i];
    const b = spine[i + 1];
    if (x >= a[0] && x <= b[0]) {
      const t = (x - a[0]) / (b[0] - a[0] || 1);
      return lerp(a[1] - a[2], b[1] - b[2], t);
    }
  }
  return spine[spine.length - 1][1];
}

/** Jointed limb as round-capped strokes, one width per segment. */
function limb(pts, widths) {
  let s = "";
  for (let i = 0; i < pts.length - 1; i++) {
    s += `<path d="M${f1(pts[i][0])},${f1(pts[i][1])}L${f1(pts[i + 1][0])},${f1(pts[i + 1][1])}" stroke-width="${f1(widths[i])}"/>`;
  }
  return s;
}

const poly = (pts) => `<path d="M${pts.map((p) => `${f1(p[0])},${f1(p[1])}`).join("L")}Z"/>`;
const eye = (x, y, r = 0.7) => `<circle class="sil-eye" cx="${f1(x)}" cy="${f1(y)}" r="${r}"/>`;

/** Muscular thigh: wide at the hip, narrowing to the knee. */
function thigh(h, k, w) {
  const l = Math.hypot(k[0] - h[0], k[1] - h[1]) || 1;
  const ux = (k[0] - h[0]) / l;
  const uy = (k[1] - h[1]) / l;
  const px = -uy;
  const py = ux;
  return smoothClosed([
    [h[0] - ux * w * 0.55, h[1] - uy * w * 0.55],
    [h[0] + px * w * 0.62, h[1] + py * w * 0.62],
    [k[0] + px * w * 0.3, k[1] + py * w * 0.3],
    [k[0] + ux * w * 0.22, k[1] + uy * w * 0.22],
    [k[0] - px * w * 0.3, k[1] - py * w * 0.3],
    [h[0] - px * w * 0.58, h[1] - py * w * 0.58],
  ]);
}

/** Digitigrade biped leg: hip → knee → ankle → toes. */
function hindLeg(hx, hy, s, w, dx = 0) {
  const h = [hx + dx, hy];
  const k = [hx + 4.5 * s + dx, hy + 11 * s];
  const a = [hx - 1 * s + dx, hy + 21.5 * s];
  const t = [hx + 3 * s + dx, -0.7];
  const toe = [hx + 7 * s + dx, -0.4];
  return thigh(h, k, w * 1.5) + limb([k, a, t, toe], [w * 0.62, w * 0.42, w * 0.3]);
}

/** Graviportal column leg for quadrupeds; `bend` pushes the knee / elbow. */
function columnLeg(hx, hy, w, bend = 0) {
  const knee = [hx + bend, hy * 0.48];
  return (
    thigh([hx, hy], knee, w * 1.35) +
    limb([knee, [hx + bend * 0.3, -0.9], [hx + bend * 0.3 + w * 0.3, -0.7]], [w * 0.82, w * 0.74])
  );
}

const PLANS = {
  dryosaurus(g) {
    g.top = 48;
    g.far += hindLeg(48, -29.5, 1.12, 4.6, -4) + limb([[65.5, -27], [66.6, -22.4], [69, -21.4]], [1.6, 1.2]);
    g.body += loft([
      [0, -27, 0.3, 0.3], [14, -29, 1.2, 1.3], [28, -30.6, 2.4, 2.9], [40, -31.2, 3.8, 5.4],
      [50, -30.8, 4.8, 10], [59, -30.4, 4.4, 10.2], [66, -31, 3.1, 5.8], [71, -35.5, 2.2, 2.8],
      [75, -40.5, 2, 2.4], [78.5, -43.4, 2.4, 2.5], [84, -43.4, 2.2, 2], [88.5, -42, 1.2, 1.2],
      [90.5, -41.6, 0.2, 0.2],
    ]);
    g.body += eye(81, -44, 0.6);
    g.near += hindLeg(52, -29.5, 1.12, 4.8) + limb([[66.5, -26.4], [68, -21.8], [70.4, -20.8]], [1.7, 1.3]);
  },
  utahraptor(g) {
    g.top = 46;
    g.far += hindLeg(48, -27, 1, 4.8, -4) + limb([[63.5, -25], [62, -19.6], [67, -17]], [2, 1.5]);
    g.body += loft([
      [0, -26.4, 0.4, 0.4], [14, -27.2, 1.2, 1.3], [28, -27.8, 2.1, 2.4], [40, -28.2, 3.3, 4.2],
      [50, -28.2, 4, 8.8], [58, -27.8, 3.6, 9], [65, -28.6, 2.7, 5.6], [70, -32.6, 2, 2.8],
      [73.5, -37.4, 1.8, 2.3], [77, -40.2, 2.1, 2.4], [83.5, -40.4, 2.2, 2.4], [90.5, -39.4, 1.4, 1.6],
      [95.5, -38.8, 0.7, 0.8], [97.5, -38.6, 0.2, 0.2],
    ]);
    // Plumage: a soft swept-back fringe along neck and back, and a feathered tail tip.
    const tufts = [[44, -31.6, 2], [49.5, -31.9, 2.3], [55, -31.6, 2.2], [60.5, -31, 2], [65.5, -31.4, 1.8], [69.6, -34.6, 1.6], [72.6, -38.6, 1.4]];
    for (const [x, y, h] of tufts) g.body += smoothClosed([[x + 1.6, y + 0.8], [x - 0.4, y - h * 0.55], [x - 2.6, y - h * 0.15], [x - 1.4, y + 0.9]]);
    g.body += smoothClosed([[12, -27.6], [4, -27.9], [-2.4, -27], [-2.2, -26], [4, -25.3], [12, -25.9]]);
    g.body += eye(84.5, -41.2, 0.6);
    // Feathered forelimb with a wing-like fringe, and the raised sickle claw.
    g.near += limb([[64, -25.5], [62.6, -20], [68, -17.4]], [2.4, 1.8]);
    g.near += smoothClosed([[62.2, -22], [60.4, -15.2], [63.4, -15.8], [65.6, -14.6], [67.6, -16.6], [63.8, -19.2]]);
    g.near += hindLeg(52, -27, 1, 5);
    g.near += '<path class="sil-line" d="M54.6,-3.4q2.6,-2.6 4,0.2" stroke-width="1.15"/>';
  },
  gastonia(g) {
    g.top = 40;
    g.far += columnLeg(46, -21, 6.2, 1.5) + columnLeg(70, -19, 4.8, -0.8);
    g.body += loft([
      [0, -14, 0.4, 0.4], [12, -16.6, 1.5, 1.6], [26, -20, 3.2, 3.6], [38, -23.6, 5.6, 6.8],
      [50, -25, 6.8, 10.2], [62, -24.2, 6.4, 10], [72, -20.8, 4.4, 6.6], [80, -16.4, 3.1, 3.6],
      [86.5, -15, 2.8, 2.9], [91.5, -14, 1.5, 1.6], [93.5, -13.8, 0.2, 0.2],
    ]);
    // Dorsal spikes and flank spines — the defining read for an armoured tank.
    const spikes = [
      [76, -21, -0.2, 4.4], [70, -26, -0.3, 6.2], [63, -29, -0.15, 6.6], [55, -30.6, 0, 6.6],
      [47, -30.5, 0.12, 6.4], [39.5, -28.6, 0.3, 5.8], [32, -25.4, 0.45, 5], [24, -22, 0.55, 4.2],
      [16, -18.6, 0.6, 3.4], [8, -15.8, 0.7, 2.6],
    ];
    for (const [x, y, lean, h] of spikes) {
      g.body += poly([[x - h * 0.32, y + 1], [x - Math.sin(lean) * h - h * 0.25, y - Math.cos(lean) * h], [x + h * 0.32, y + 1]]);
    }
    for (let i = 0; i < 5; i++) {
      const x = 42 + i * 7.5;
      g.body += poly([[x - 1.4, -15.6], [x - 5.2, -12.4], [x + 1.2, -14.4]]);
    }
    g.body += eye(88, -16.4, 0.55);
    g.near += columnLeg(50, -20, 6.6, 1.5) + columnLeg(73, -18, 5, -0.8);
  },
  ceratosaurus(g) {
    g.top = 46;
    g.far += hindLeg(45, -28, 1.04, 6, -3.5) + limb([[66.5, -25.6], [67.6, -21], [70, -20]], [1.9, 1.4]);
    // A deep, crocodile-like tail: it is the swimmer of the group.
    const spine = [
      [0, -22.5, 0.4, 0.5], [12, -24.8, 1.9, 2.3], [25, -27.2, 3.1, 4.2], [36, -29.2, 4, 6],
      [46, -29.6, 4.4, 10], [56, -28.8, 4, 11], [64, -28.4, 3.3, 7.8], [70, -31.2, 2.6, 4.3],
      [74.5, -35.8, 2.2, 2.9], [78.5, -38.2, 2.5, 3], [85, -38.4, 3.1, 3.4], [92, -37.6, 2.3, 2.7],
      [98, -36.6, 1.2, 1.3], [100, -36.4, 0.2, 0.2],
    ];
    for (let i = 0; i < 11; i++) {
      const x = 22 + i * 4.2;
      g.body += `<circle cx="${f1(x)}" cy="${f1(backAt(spine, x) + 0.1)}" r="1.1"/>`;
    }
    g.body += loft(spine);
    g.body += poly([[91.6, -39.4], [93.6, -43.6], [95.6, -39.2]]);
    g.body += poly([[81.4, -40.6], [82.8, -42.8], [84.6, -40.8]]) + eye(84, -39.6);
    g.near += hindLeg(49, -28, 1.04, 6.2) + limb([[67, -25], [68.6, -20.4], [71.4, -19.4]], [2, 1.5]);
  },
  stegosaurus(g) {
    g.top = 62;
    g.far += columnLeg(43, -40, 7.6, 2.5) + columnLeg(63, -31, 4.8, -1.2);
    // Alternating plates, tallest over the hips; drawn first so the back overlaps their roots.
    const plates = [
      [73.5, -29.2, 3], [69.5, -34.4, 4.4], [64.5, -40.2, 6.4], [58.5, -45.4, 8.4], [51.5, -48.6, 9.8],
      [44, -49.6, 10.6], [36.5, -47.4, 9.6], [29.5, -43.4, 8], [23, -38.8, 6.4], [17, -34.6, 4.8], [11.5, -31.2, 3.4],
    ];
    plates.forEach(([x, y, s], i) => {
      const tipX = x - s * (0.18 + (x - 44) * -0.004);
      g.body += smoothClosed([[x - s * 0.34, y + s * 0.25], [x - s * 0.42, y - s * 0.38], [tipX, y - s * 1.02], [x + s * 0.38, y - s * 0.42], [x + s * 0.3, y + s * 0.25]]);
      if (i % 2) g.far += smoothClosed([[x + 1.6 - s * 0.3, y + s * 0.2], [x + 1.6, y - s * 0.86], [x + 1.6 + s * 0.3, y + s * 0.2]]);
    });
    g.body += loft([
      [0, -27, 0.4, 0.4], [10, -31, 1.6, 1.8], [22, -37, 3.4, 3.8], [34, -42.5, 5, 7.4],
      [44, -45, 6, 12], [54, -43.4, 6, 13], [63, -38.6, 5, 11.4], [70, -31, 3.8, 7],
      [76, -24.5, 2.6, 3.6], [81.5, -20.6, 2.5, 2.9], [87.5, -19.6, 1.8, 2], [91.5, -19, 0.7, 0.7],
      [93, -18.8, 0.2, 0.2],
    ]);
    g.body += eye(84.5, -21.4, 0.55);
    // Thagomizer: paired spikes near the tail tip.
    g.body += poly([[5.5, -29.6], [-2, -37.8], [8, -31]]) + poly([[10, -31.4], [4.5, -40.6], [12.4, -32.6]]);
    g.far += poly([[7, -28.2], [1.2, -35.4], [9.2, -29.4]]);
    g.near += columnLeg(47, -40, 8, 2.5) + columnLeg(67, -30, 5, -1.2);
  },
  allosaurus(g) {
    g.top = 46;
    g.far += hindLeg(44, -29, 1.06, 6.2, -3.5) + limb([[66.5, -26], [68, -20.5], [71, -19.2]], [2.2, 1.6]);
    g.body += loft([
      [0, -23.5, 0.3, 0.3], [12, -25.5, 1.3, 1.5], [25, -28, 2.6, 3.2], [36, -30, 3.9, 5.6],
      [46, -30.2, 4.6, 10.2], [56, -29.4, 4.2, 11.4], [64, -29, 3.4, 8], [70, -31.4, 2.6, 4.4],
      [74.5, -35.8, 2.2, 2.9], [78.5, -38.2, 2.4, 2.9], [85, -38.2, 3, 3.4], [92, -37.2, 2.2, 2.7],
      [98, -36.2, 1.1, 1.3], [100, -36, 0.2, 0.2],
    ]);
    g.body += poly([[80.8, -40.4], [82.6, -43.6], [84.8, -40.6]]) + eye(84, -39.3);
    g.near += hindLeg(48, -29, 1.06, 6.4) + limb([[67, -25.5], [69.2, -20], [72.2, -18.8]], [2.4, 1.7]);
  },
  camptosaurus(g) {
    g.top = 40;
    g.far += columnLeg(44, -27, 6.6, 2.4) + columnLeg(64, -21, 3.4, -0.6);
    g.body += loft([
      [0, -19, 0.4, 0.4], [12, -22, 1.5, 1.8], [25, -26, 3, 3.8], [37, -29.6, 4.8, 6.8],
      [47, -30.4, 5.6, 10.6], [57, -29, 5, 11], [65, -26.6, 3.8, 6.8], [71, -27.4, 2.6, 3.4],
      [76, -30.2, 2.3, 2.7], [81, -31.8, 2.7, 2.8], [87, -31.2, 2.3, 2.2], [91.5, -30, 1.3, 1.3],
      [93.5, -29.6, 0.2, 0.2],
    ]);
    g.body += eye(84.5, -32.6, 0.55);
    g.near += columnLeg(48, -27, 7, 2.4) + columnLeg(67, -21, 3.6, -0.6);
  },
  diplodocus(g) {
    g.top = 46;
    g.far += columnLeg(36, -21, 5.2, 1.4) + columnLeg(50, -20, 4.6, -0.6);
    g.body += loft([
      [0, -10, 0.15, 0.15], [8, -12, 0.4, 0.4], [16, -15, 0.9, 0.9], [24, -19, 1.8, 1.9],
      [31, -23, 3, 3.6], [37, -25.6, 4, 6.4], [43, -25.8, 4.2, 7.4], [49, -24.6, 3.6, 6.2],
      [55, -25, 2.4, 3], [62, -28, 1.7, 2.1], [69, -32, 1.3, 1.6], [76, -36, 1.1, 1.3],
      [83, -39.4, 1, 1.2], [88, -41, 1.1, 1.2], [91.5, -41, 0.9, 0.9], [93.5, -40.4, 0.2, 0.2],
    ]);
    g.body += eye(89.6, -41.6, 0.4);
    g.near += columnLeg(39, -21, 5.6, 1.4) + columnLeg(53, -20, 4.8, -0.6);
  },
};

/** Standing person, `h` units tall, feet on the baseline — the field-guide scale figure. */
function scaleFigure(x, h) {
  const u = h / 10;
  return (
    `<circle cx="${f1(x)}" cy="${f1(-h + u * 0.75)}" r="${f1(u * 0.72)}"/>` +
    limb([[x, -h + u * 1.9], [x, -h + u * 5.4]], [u * 1.7]) +
    limb([[x - u * 0.45, -h + u * 5.2], [x - u * 0.6, -0.4]], [u * 0.8]) +
    limb([[x + u * 0.45, -h + u * 5.2], [x + u * 0.6, -0.4]], [u * 0.8]) +
    limb([[x - u * 0.6, -h + u * 2.2], [x - u * 0.95, -h + u * 5.4]], [u * 0.55]) +
    limb([[x + u * 0.6, -h + u * 2.2], [x + u * 0.95, -h + u * 5.4]], [u * 0.55])
  );
}

/** Pick a body plan for an id we have no bespoke drawing for. */
function fallbackPlan(def) {
  if (def?.diet === "carnivore") return (def.mass || 0) < 700 ? "utahraptor" : "allosaurus";
  if ((def?.mass || 0) > 8000) return "diplodocus";
  return (def?.mass || 0) > 400 ? "camptosaurus" : "dryosaurus";
}

/**
 * Field-guide silhouette of a species, with an optional 1.8 m person for scale.
 * @param {object|string} species SpeciesDef or id
 * @param {{ human?: boolean }} [opts]
 * @returns {string} SVG markup (class "sil"; style via .sil-body / .sil-far / .sil-human / .sil-ground / .sil-eye)
 */
export function speciesSilhouette(species, { human = true } = {}) {
  const def = typeof species === "string" ? { id: species } : species || {};
  const plan = PLANS[def.id] || PLANS[fallbackPlan(def)];
  const g = { far: "", body: "", near: "", top: 48 };
  plan(g);
  const length = Math.max(0.5, Number(def.length) || 6);
  const hu = human ? (1.8 / length) * 100 : 0;
  const hx = -6 - hu * 0.12;
  const minX = human ? Math.min(-6, hx - hu * 0.2) - 2 : -6;
  const top = Math.max(g.top, hu + 3);
  return (
    `<svg class="sil" viewBox="${f1(minX)} ${f1(-top)} ${f1(104 - minX)} ${f1(top + 2)}" preserveAspectRatio="xMidYMax meet" aria-hidden="true" focusable="false">` +
    `<g class="sil-far">${g.far}</g><g class="sil-body">${g.body}${g.near}</g>` +
    (human ? `<g class="sil-human">${scaleFigure(hx, hu)}</g>` : "") +
    `<path class="sil-ground" d="M${f1(minX)},0.5H104"/></svg>`
  );
}

/* --- Settings ------------------------------------------------------------------------ */

/** Default player settings (see Menu#settings). */
export const DEFAULT_SETTINGS = Object.freeze({ style: "detailed", quality: "auto", muted: false, sensitivity: 1 });

/** Coerce anything into a valid settings object. */
export function normalizeSettings(s = {}) {
  const src = s && typeof s === "object" ? s : {};
  const sens = Number(src.sensitivity);
  return {
    style: src.style === "pixel" ? "pixel" : "detailed",
    quality: ["auto", "high", "low"].includes(src.quality) ? src.quality : "auto",
    muted: Boolean(src.muted),
    sensitivity: Number.isFinite(sens) ? clamp(Math.round(sens * 100) / 100, 0.5, 2) : 1,
  };
}

/* --- Procedural art: style previews & loading contours ------------------------------- */

// 4×4 Bayer matrix for the ordered dither in the "pixel" preview.
const BAYER4 = [0, 8, 2, 10, 12, 4, 14, 6, 3, 11, 1, 9, 15, 7, 13, 5];

/**
 * A tiny dusk landscape — sky, sun, ridges, conifers, mist, a grazing
 * sauropod — painted into `canvas` at its own resolution. The pixel preview
 * paints the very same scene at a fraction of the size, then quantises it with
 * an ordered dither: exactly what the "pixel" render style does to the island.
 */
function paintVista(canvas, pixel) {
  const ctx = canvas.getContext("2d");
  if (!ctx) return;
  const w = canvas.width;
  const h = canvas.height;
  const sky = ctx.createLinearGradient(0, 0, 0, h * 0.7);
  sky.addColorStop(0, "#26323d");
  sky.addColorStop(0.5, "#6f6d5d");
  sky.addColorStop(0.86, "#d7a660");
  sky.addColorStop(1, "#e6bd78");
  ctx.fillStyle = sky;
  ctx.fillRect(0, 0, w, h);

  const sx = w * 0.7;
  const sy = h * 0.5;
  const glow = ctx.createRadialGradient(sx, sy, 0, sx, sy, h * 0.55);
  glow.addColorStop(0, "rgba(255,226,160,0.95)");
  glow.addColorStop(0.12, "rgba(255,214,140,0.65)");
  glow.addColorStop(1, "rgba(255,200,120,0)");
  ctx.fillStyle = glow;
  ctx.fillRect(0, 0, w, h);
  ctx.fillStyle = "#fff1cf";
  ctx.beginPath();
  ctx.arc(sx, sy, h * 0.06, 0, Math.PI * 2);
  ctx.fill();

  const rng = makeRng(hash("vista", 7));
  const ridge = (base, amp, color, freq, trees = 0) => {
    const ph = rng() * 10;
    ctx.fillStyle = color;
    ctx.beginPath();
    ctx.moveTo(0, h);
    const ys = [];
    for (let i = 0; i <= 48; i++) {
      const x = (i / 48) * w;
      const t = i / 48;
      const y = h * (base - amp * (0.55 * Math.sin(t * freq + ph) + 0.3 * Math.sin(t * freq * 2.3 + ph * 1.7) + 0.15 * Math.sin(t * freq * 5.1)));
      ys.push(y);
      ctx.lineTo(x, y);
    }
    ctx.lineTo(w, h);
    ctx.fill();
    // Conifer spires along the crest, sized to the canvas so both versions match.
    for (let i = 0; i < trees; i++) {
      const t = rng();
      const x = t * w;
      const y = ys[Math.round(t * 48)] + h * 0.01;
      const th = h * (0.05 + rng() * 0.07);
      const tw = th * 0.32;
      ctx.beginPath();
      ctx.moveTo(x - tw, y);
      ctx.lineTo(x, y - th);
      ctx.lineTo(x + tw, y);
      ctx.fill();
    }
  };
  ridge(0.56, 0.1, "#717683", 7);
  ridge(0.66, 0.08, "#4b5444", 9, 26);
  const mist = ctx.createLinearGradient(0, h * 0.56, 0, h * 0.8);
  mist.addColorStop(0, "rgba(232,214,180,0)");
  mist.addColorStop(0.5, "rgba(232,214,180,0.35)");
  mist.addColorStop(1, "rgba(232,214,180,0)");
  ctx.fillStyle = mist;
  ctx.fillRect(0, h * 0.5, w, h * 0.35);
  ridge(0.8, 0.06, "#2c3426", 5, 9);

  // A distant sauropod on the middle ground.
  const k = h / 100;
  const bx = w * 0.3;
  const by = h * 0.76;
  ctx.fillStyle = "#2f3529";
  ctx.beginPath();
  ctx.ellipse(bx, by - 7 * k, 9 * k, 4.2 * k, 0, 0, Math.PI * 2);
  ctx.fill();
  ctx.lineCap = "round";
  ctx.strokeStyle = "#2f3529";
  ctx.lineWidth = 2.2 * k;
  ctx.beginPath();
  ctx.moveTo(bx + 7 * k, by - 9 * k);
  ctx.quadraticCurveTo(bx + 14 * k, by - 18 * k, bx + 19 * k, by - 21 * k);
  ctx.moveTo(bx - 8 * k, by - 7 * k);
  ctx.quadraticCurveTo(bx - 16 * k, by - 4 * k, bx - 24 * k, by - 3 * k);
  for (const dx of [-5, -2, 4, 7]) {
    ctx.moveTo(bx + dx * k, by - 6 * k);
    ctx.lineTo(bx + dx * k, by);
  }
  ctx.stroke();

  const fg = ctx.createLinearGradient(0, h * 0.82, 0, h);
  fg.addColorStop(0, "#1d2219");
  fg.addColorStop(1, "#11140f");
  ctx.fillStyle = fg;
  ctx.fillRect(0, h * 0.88, w, h * 0.12);

  if (!pixel) return;
  // Ordered dither + gentle quantisation, like the pixel render pass.
  const img = ctx.getImageData(0, 0, w, h);
  const d = img.data;
  const levels = 12;
  const step = 255 / (levels - 1);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const o = (y * w + x) * 4;
      // Half-strength threshold: visible banding with a light, even texture.
      const t = (BAYER4[(y & 3) * 4 + (x & 3)] / 16 - 0.5) * step * 0.55;
      for (let c = 0; c < 3; c++) d[o + c] = Math.round(clamp(d[o + c] + t, 0, 255) / step) * step;
    }
  }
  ctx.putImageData(img, 0, 0);
}

/**
 * Topographic contours for the loading veil (pure SVG, seeded): the island is
 * "being surveyed" while it generates. Traced with marching squares from one
 * height field, so — like a real survey — no two contour lines ever cross.
 */
function contourSVG(seed) {
  const rng = makeRng(seed);
  const W = 1000;
  const H = 600;
  const STEP = 12;
  const nx = Math.ceil(W / STEP) + 1;
  const ny = Math.ceil(H / STEP) + 1;
  // A massif of a few soft, elongated peaks over a gently rolling ground.
  const peaks = [];
  for (let i = 0; i < 5; i++) {
    const rot = rng() * Math.PI;
    peaks.push({ x: 180 + rng() * 680, y: 90 + rng() * 420, r: 80 + rng() * 150, amp: 0.45 + rng() * 0.6, c: Math.cos(rot), s: Math.sin(rot) });
  }
  const ph = [rng() * 6.28, rng() * 6.28, rng() * 6.28];
  const f = new Float32Array(nx * ny);
  let max = 0;
  for (let j = 0; j < ny; j++) {
    for (let i = 0; i < nx; i++) {
      const x = i * STEP;
      const y = j * STEP;
      let h = 0.05 * Math.sin(x * 0.011 + ph[0]) * Math.cos(y * 0.013 + ph[1]) + 0.035 * Math.sin((x + y) * 0.019 + ph[2]);
      for (const p of peaks) {
        const dx = x - p.x;
        const dy = y - p.y;
        const u = (dx * p.c + dy * p.s) / (p.r * 1.6);
        const v = (dy * p.c - dx * p.s) / p.r;
        h += p.amp * Math.exp(-(u * u + v * v));
      }
      f[j * nx + i] = h;
      max = Math.max(max, h);
    }
  }
  const at = (a, b, L) => (L - a) / (b - a || 1e-6);
  let paths = "";
  let level = 0;
  for (let L = 0.06; L < max; L += 0.07, level++) {
    let d = "";
    const seg = (p, q) => {
      d += `M${p[0].toFixed(1)} ${p[1].toFixed(1)}L${q[0].toFixed(1)} ${q[1].toFixed(1)}`;
    };
    for (let j = 0; j < ny - 1; j++) {
      for (let i = 0; i < nx - 1; i++) {
        const a = f[j * nx + i]; // top-left
        const b = f[j * nx + i + 1]; // top-right
        const c = f[(j + 1) * nx + i + 1]; // bottom-right
        const e = f[(j + 1) * nx + i]; // bottom-left
        const A = a >= L;
        const B = b >= L;
        const C = c >= L;
        const E = e >= L;
        if (A === B && B === C && C === E) continue;
        const x0 = i * STEP;
        const y0 = j * STEP;
        const top = A !== B ? [x0 + at(a, b, L) * STEP, y0] : null;
        const right = B !== C ? [x0 + STEP, y0 + at(b, c, L) * STEP] : null;
        const bottom = E !== C ? [x0 + at(e, c, L) * STEP, y0 + STEP] : null;
        const left = A !== E ? [x0, y0 + at(a, e, L) * STEP] : null;
        if (top && right && bottom && left) {
          // Saddle: the centre decides which corners the high ground joins.
          if (A === (a + b + c + e) / 4 >= L) {
            seg(top, right);
            seg(left, bottom);
          } else {
            seg(top, left);
            seg(right, bottom);
          }
        } else {
          const pts = [top, right, bottom, left].filter(Boolean);
          seg(pts[0], pts[1]);
        }
      }
    }
    if (d) paths += `<path${level % 5 === 4 ? ' class="idx"' : ""} d="${d}"/>`;
  }
  return `<svg class="contours" viewBox="0 0 ${W} ${H}" preserveAspectRatio="xMidYMid slice" aria-hidden="true" focusable="false">${paths}</svg>`;
}

/* --- Species stats -------------------------------------------------------------------- */

const SWIM_WORDS = ["Sinks", "Poor", "Fair", "Good", "Superb"];

/** Card stats normalised across the playable list so bars compare species fairly. */
function computeStats(list) {
  const raw = list.map((s) => ({
    size: Math.log(Math.max(1, Number(s.mass) || 1)),
    speed: Number(s.speed?.sprint) || 0,
    bite: Number(s.bite) || 0,
    tough: (Number(s.health) || 0) * (1 + (Number(s.armor) || 0)),
  }));
  const range = {};
  for (const k of ["size", "speed", "bite", "tough"]) {
    const vals = raw.map((r) => r[k]);
    range[k] = [Math.min(...vals), Math.max(...vals)];
  }
  // Floor of 0.12 so the weakest species still shows a visible sliver.
  const norm = (k, v) => {
    const [lo, hi] = range[k];
    return hi > lo ? 0.12 + 0.88 * ((v - lo) / (hi - lo)) : 0.6;
  };
  return list.map((s, i) => {
    const swim = clamp(Number(s.swim) || 0, 0, 1);
    return [
      { key: "Size", v: norm("size", raw[i].size), label: formatMass(s.mass) },
      { key: "Speed", v: norm("speed", raw[i].speed), label: `${Math.round(raw[i].speed * 3.6)} km/h` },
      { key: "Bite", v: norm("bite", raw[i].bite), label: String(Math.round(raw[i].bite)) },
      { key: "Toughness", v: norm("tough", raw[i].tough), label: String(Math.round(raw[i].tough)) },
      { key: "Swim", v: Math.max(0.06, swim), label: SWIM_WORDS[Math.min(4, Math.round(swim * 4))] },
    ];
  });
}

/* --- Focus helpers ---------------------------------------------------------------------- */

const FOCUSABLE = 'button:not([disabled]), [href], input:not([disabled]), [tabindex]:not([tabindex="-1"])';

/** Keep Tab / Shift+Tab inside `container` (modal dialogs). */
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

// Last input modality (set by Menu#_bind). Screens only grab focus for
// keyboard users, so a mouse user never sees a focus ring appear on its own.
let keyboardUser = false;

const isTouchDevice = () =>
  typeof matchMedia === "function" && matchMedia("(pointer: coarse)").matches && !matchMedia("(any-pointer: fine)").matches;


let uid = 0;

/* --- Menu ------------------------------------------------------------------------------- */

export class Menu {
  /**
   * @param {HTMLElement} root UI root (#ui); the menu appends its own layers
   * @param {{ species?: object[], isTouch?: boolean }} opts playable SpeciesDefs in menu order
   */
  constructor(root, { species = [], isTouch } = {}) {
    this.root = root;
    this.species = (species || []).filter(Boolean);
    this.isTouch = typeof isTouch === "boolean" ? isTouch : isTouchDevice();

    /** Called with the chosen species id ("Hatch"). */
    this.onStart = () => {};
    /** Called when the player resumes their saved life. */
    this.onContinue = () => {};
    /** [hunter] Called from the title screen's Hunter entry; main opens HunterMenu. */
    this.onHunter = () => {};
    /** Called with a fresh copy of the settings after every change. */
    this.onSettingsChange = () => {};
    /** Called when the settings panel closes (e.g. to return focus to pause). */
    this.onSettingsClose = () => {};

    this._settings = normalizeSettings(DEFAULT_SETTINGS);
    this._save = null;
    this._screen = "title";
    this._selected = 0;
    this._visible = false;
    this._loading = false;
    this._loadingOnly = false;
    this._loadTimer = 0;
    this._returnFocus = null;
    this._scrollLockUntil = 0;
    this._scrollRaf = 0;
    this._id = `sauria-menu-${++uid}`;

    this._build();
    this._bind();
    // A screen must be active even before show(): setLoading() may reveal the
    // menu first, and the progress bar lives on the title screen.
    this._setScreen("title", false);
  }

  /* --- Public API --- */

  /** True while the title / species screen is showing. */
  get visible() {
    return this._visible;
  }

  /**
   * Current player settings: { style, quality, muted, sensitivity }.
   * Assigning normalises the value and refreshes the panel.
   */
  get settings() {
    return this._settings;
  }

  set settings(value) {
    this._settings = normalizeSettings(value);
    this._syncSettingsForm();
  }

  /**
   * Show the title screen.
   * @param {{ save?: { speciesId, speciesName, growth, day } | null }} [opts]
   */
  show({ save = null } = {}) {
    this._save = save && save.speciesId ? save : null;
    this._renderContinue();
    this._setScreen("title", false);
    this._visible = true;
    this._loadingOnly = false;
    this.el.classList.remove("is-loading-only");
    this._open(this.el);
    if (!this._loading && keyboardUser) this._focusLater(this._primaryAction());
  }

  /** Hide every menu layer; the island is left unobstructed. */
  hide() {
    this._visible = false;
    this._loadingOnly = false;
    this._close(this.el);
    this.el.classList.remove("is-loading-only");
    this._closeLayer(this.controlsLayer, false);
    if (this.settingsLayer.classList.contains("is-open")) this.hideSettings();
  }

  /**
   * Loading state before the world is ready. Shows the menu in a reduced
   * "surveying" state if it isn't already visible; at progress ≥ 1 the veil
   * lifts to reveal the island and the actions appear.
   * @param {number} progress 0..1
   * @param {string} [label] what is being built ("Raising the island")
   */
  setLoading(progress, label) {
    const p = clamp(Number(progress) || 0, 0, 1);
    clearTimeout(this._loadTimer);
    this._loadFill.style.transform = `scaleX(${p.toFixed(3)})`;
    this._loadPct.textContent = `${Math.round(p * 100)}%`;
    this._loadBar.setAttribute("aria-valuenow", String(Math.round(p * 100)));
    if (label) this._loadLabel.textContent = label;
    if (p < 1) {
      if (!this._loading) {
        this._loading = true;
        this.el.classList.add("is-loading");
        this._setActionsEnabled(false);
      }
      if (!this._visible && !this._loadingOnly) {
        this._loadingOnly = true;
        this.el.classList.add("is-loading-only");
        this._open(this.el);
      }
      return;
    }
    if (!this._loading) return;
    if (!label) this._loadLabel.textContent = "The island is ready";
    // Let the bar visibly complete before the veil lifts.
    this._loadTimer = setTimeout(() => {
      this._loading = false;
      this.el.classList.remove("is-loading");
      this._setActionsEnabled(true);
      if (this._loadingOnly && !this._visible) {
        this._loadingOnly = false;
        this.el.classList.remove("is-loading-only");
        this._close(this.el);
      } else if (this._visible && keyboardUser) {
        this._focusLater(this._primaryAction());
      }
    }, 420);
  }

  /** Open the settings panel (from the title screen or the pause menu). */
  showSettings() {
    this._syncSettingsForm();
    this._openLayer(this.settingsLayer);
  }

  /** Close the settings panel and return focus to whatever opened it. */
  hideSettings() {
    if (!this.settingsLayer.classList.contains("is-open")) return;
    this._closeLayer(this.settingsLayer);
    this.onSettingsClose();
  }

  /** Open the controls cheat-sheet. */
  showControls() {
    this._openLayer(this.controlsLayer);
  }

  /** Remove the menu's DOM and listeners. */
  dispose() {
    this._ac.abort();
    clearTimeout(this._loadTimer);
    cancelAnimationFrame(this._scrollRaf);
    this.el.remove();
    this.settingsLayer.remove();
    this.controlsLayer.remove();
  }

  /* --- Construction --- */

  _build() {
    const id = this._id;
    const el = document.createElement("section");
    el.className = "menu";
    el.setAttribute("aria-label", "Sauria — main menu");
    el.innerHTML = `
      <div class="menu__veil" aria-hidden="true">${contourSVG(hash("contours", 2026))}</div>
      <div class="menu__scrim" aria-hidden="true"></div>
      <header class="menu__bar">
        <div class="brand">
          <svg class="brand__mark" viewBox="0 0 64 64" aria-hidden="true" focusable="false">${TRACK_MARK}</svg>
          <span class="brand__name">Sauria</span>
          <span class="brand__sub">A field guide to staying alive</span>
        </div>
        <nav class="menu__tools" aria-label="Menu tools">
          <button type="button" class="tool" data-act="controls">${icon("keyboard")}<span>Controls</span></button>
          <button type="button" class="tool" data-act="settings">${icon("settings")}<span>Settings</span></button>
        </nav>
      </header>

      <div class="screen screen--title" data-screen="title">
        <p class="eyebrow title__eyebrow">Late Jurassic · Utah · 150 million years ago</p>
        <h1 class="wordmark">Sauria</h1>
        <p class="tagline">Hatch small. Stay hidden. Grow into something the island fears.</p>
        <div class="loading" role="progressbar" aria-label="Preparing the island" aria-valuemin="0" aria-valuemax="100" aria-valuenow="0">
          <div class="loading__track"><div class="loading__fill"></div></div>
          <p class="loading__meta"><span class="loading__label">Surveying the island</span><span class="loading__pct">0%</span></p>
        </div>
        <div class="title__actions">
          <div class="continue" hidden></div>
          <button type="button" class="mode mode--survival" data-act="survival">
            <span class="mode__num" aria-hidden="true">I</span>
            <span class="mode__body"><span class="mode__name">Survival</span><span class="mode__desc">Live as a dinosaur — feed, hide, fight, grow up.</span></span>
            <span class="mode__go" aria-hidden="true">${icon("arrowRight")}</span>
          </button>
          <button type="button" class="mode mode--hunter" data-act="hunter">
            <span class="mode__num" aria-hidden="true">II</span>
            <span class="mode__body"><span class="mode__name">Hunter</span><span class="mode__desc">A Carnivores-style expedition — stalk, shoot, extract.</span></span>
            <span class="mode__go" aria-hidden="true">${icon("arrowRight")}</span>
          </button>
        </div>
      </div>

      <div class="screen screen--species" data-screen="species">
        <header class="species__head">
          <button type="button" class="back" data-act="back" aria-label="Back to the title screen">${icon("arrowLeft")}<span>Back</span></button>
          <div class="species__titles">
            <p class="eyebrow">Survival · choose a species</p>
            <h2 class="species__title" id="${id}-sp-title">Who will you be?</h2>
          </div>
          <p class="species__intro">Six animals of the Morrison and Cedar Mountain formations. You start as a hatchling — the island decides the rest.</p>
        </header>
        <div class="species__list" role="listbox" aria-labelledby="${id}-sp-title" aria-orientation="horizontal"></div>
        <footer class="species__foot">
          <div class="species__detail" aria-live="polite">
            <p class="species__detail-name"></p>
            <p class="species__detail-desc"></p>
          </div>
          <button type="button" class="btn btn--primary hatch" data-act="hatch">
            ${icon("egg")}<span class="hatch__text">Hatch</span><kbd class="kbd kbd--on-light hatch__kbd">Enter</kbd>
          </button>
        </footer>
      </div>

      <footer class="menu__foot">
        <p class="plate"><span class="plate__no">Pl. I</span> The island at the edge of the Morrison floodplain, from the air.</p>
      </footer>`;

    this.el = el;
    this.root.appendChild(el);
    this._close(el);

    this._loadBar = el.querySelector(".loading");
    this._loadFill = el.querySelector(".loading__fill");
    this._loadPct = el.querySelector(".loading__pct");
    this._loadLabel = el.querySelector(".loading__label");
    this._continue = el.querySelector(".continue");
    this._list = el.querySelector(".species__list");
    this._detailName = el.querySelector(".species__detail-name");
    this._detailDesc = el.querySelector(".species__detail-desc");
    this._hatchBtn = el.querySelector(".hatch");
    this._hatchText = el.querySelector(".hatch__text");
    if (this.isTouch) el.querySelector(".hatch__kbd").remove();

    this._buildCards();
    this._buildSettings();
    this._buildControls();
  }

  _buildCards() {
    const stats = computeStats(this.species);
    this._list.innerHTML = this.species
      .map((s, i) => {
        const diet = s.diet === "carnivore" ? "carnivore" : s.diet === "herbivore" ? "herbivore" : "omnivore";
        const bars = stats[i]
          .map(
            (st) =>
              `<div class="stat"><dt>${st.key}</dt><dd><span class="stat__bar"><i style="transform:scaleX(${st.v.toFixed(3)})"></i></span><span class="stat__val">${escapeHtml(st.label)}</span></dd></div>`,
          )
          .join("");
        return `
        <div class="sp-card" role="option" id="${this._id}-sp-${i}" tabindex="-1" aria-selected="false" data-index="${i}" data-diet="${diet}">
          <div class="sp-card__head"><span class="sp-card__no">No. ${String(i + 1).padStart(2, "0")}</span><span class="diet diet--${diet}">${diet}</span></div>
          <div class="sp-card__fig">${speciesSilhouette(s)}<span class="sp-card__len">${escapeHtml(f1(Number(s.length) || 0))} m</span></div>
          <h3 class="sp-card__name">${escapeHtml(s.name || s.id)}</h3>
          <p class="sp-card__era">${escapeHtml(s.era || "")}</p>
          <p class="sp-card__tag">${escapeHtml(s.tagline || "")}</p>
          <p class="sp-card__desc">${escapeHtml(s.description || "")}</p>
          <dl class="stats">${bars}</dl>
        </div>`;
      })
      .join("");
    this._cards = [...this._list.querySelectorAll(".sp-card")];
    this._select(Math.min(this._selected, Math.max(0, this._cards.length - 1)), { scroll: false });
  }

  _buildSettings() {
    const id = this._id;
    const layer = document.createElement("div");
    layer.className = "layer layer--settings";
    layer.innerHTML = `
      <div class="layer__backdrop" data-act="close-settings"></div>
      <section class="sheet sheet--settings" role="dialog" aria-modal="true" aria-labelledby="${id}-set-title">
        <header class="sheet__head">
          <div><p class="eyebrow">Field kit</p><h2 class="sheet__title" id="${id}-set-title">Settings</h2></div>
          <button type="button" class="icon-btn" data-act="close-settings" aria-label="Close settings">${icon("close")}</button>
        </header>
        <div class="sheet__body">
          <fieldset class="field">
            <legend class="field__label">Graphics style</legend>
            <div class="style-pick">
              <label class="style-opt">
                <input type="radio" name="${id}-style" value="detailed" />
                <span class="style-opt__img"><canvas width="336" height="176" aria-hidden="true"></canvas></span>
                <span class="style-opt__name">Detailed</span>
                <span class="style-opt__desc">Full resolution — soft light, drifting mist, fine surface detail.</span>
              </label>
              <label class="style-opt">
                <input type="radio" name="${id}-style" value="pixel" />
                <span class="style-opt__img style-opt__img--pixel"><canvas width="64" height="34" aria-hidden="true"></canvas></span>
                <span class="style-opt__name">Pixel <em>retro</em></span>
                <span class="style-opt__desc">Low-res render, crisp nearest-neighbour upscale — a '98 expedition.</span>
              </label>
            </div>
          </fieldset>
          <fieldset class="field">
            <legend class="field__label">Quality</legend>
            <div class="segmented">
              <label><input type="radio" name="${id}-quality" value="auto" /><span>Auto</span></label>
              <label><input type="radio" name="${id}-quality" value="high" /><span>High</span></label>
              <label><input type="radio" name="${id}-quality" value="low" /><span>Low</span></label>
            </div>
            <p class="field__hint" data-hint="quality"></p>
          </fieldset>
          <div class="field field--row">
            <div><span class="field__label" id="${id}-snd">Sound</span><p class="field__hint">Wind, wildlife, footsteps and calls.</p></div>
            <button type="button" class="switch" role="switch" aria-checked="true" aria-labelledby="${id}-snd" data-act="sound">
              <span class="switch__track"><span class="switch__thumb"></span></span>
              <span class="switch__state">On</span>
            </button>
          </div>
          <div class="field">
            <div class="field__row"><label class="field__label" for="${id}-sens">Look sensitivity</label><output class="field__value" for="${id}-sens">1.00×</output></div>
            <input class="range" id="${id}-sens" type="range" min="0.5" max="2" step="0.05" value="1" />
            <div class="range__scale" aria-hidden="true"><span>Slow</span><span>1×</span><span>Fast</span></div>
          </div>
        </div>
        <footer class="sheet__foot">
          <p class="sheet__note">Saved on this device.</p>
          <button type="button" class="btn btn--primary" data-act="close-settings">Done</button>
        </footer>
      </section>`;
    this.root.appendChild(layer);
    this.settingsLayer = layer;
    this._close(layer);
    this._sensInput = layer.querySelector(".range");
    this._sensOut = layer.querySelector(".field__value");
    this._soundBtn = layer.querySelector(".switch");
    this._qualityHint = layer.querySelector('[data-hint="quality"]');
    const [detailed, pixel] = layer.querySelectorAll(".style-opt canvas");
    paintVista(detailed, false);
    paintVista(pixel, true);
    this._syncSettingsForm();
  }

  _buildControls() {
    const id = this._id;
    const layer = document.createElement("div");
    layer.className = "layer layer--controls";
    layer.innerHTML = `
      <div class="layer__backdrop" data-act="close-controls"></div>
      <section class="sheet sheet--wide" role="dialog" aria-modal="true" aria-labelledby="${id}-ctl-title">
        <header class="sheet__head">
          <div><p class="eyebrow">Field notes</p><h2 class="sheet__title" id="${id}-ctl-title">Controls</h2></div>
          <button type="button" class="icon-btn" data-act="close-controls" aria-label="Close controls">${icon("close")}</button>
        </header>
        <div class="sheet__body">${controlsSheetHTML({ isTouch: this.isTouch })}</div>
      </section>`;
    this.root.appendChild(layer);
    this.controlsLayer = layer;
    this._close(layer);
  }

  /* --- Events --- */

  _bind() {
    this._ac = new AbortController();
    const sig = { signal: this._ac.signal };

    const onClick = (e) => {
      const t = e.target.closest("[data-act]");
      if (!t) return;
      switch (t.dataset.act) {
        case "survival":
          this._setScreen("species", true);
          break;
        case "hunter":
          this.onHunter();
          break;
        case "continue":
          this.onContinue();
          break;
        case "back":
          this._setScreen("title", true);
          break;
        case "hatch":
          this._hatch();
          break;
        case "settings":
          this.showSettings();
          break;
        case "controls":
          this.showControls();
          break;
        case "close-settings":
          this.hideSettings();
          break;
        case "close-controls":
          this._closeLayer(this.controlsLayer);
          break;
        case "sound":
          this._change({ muted: !this._settings.muted });
          break;
      }
    };
    for (const el of [this.el, this.settingsLayer, this.controlsLayer]) el.addEventListener("click", onClick, sig);

    // Species cards: click selects, double-click hatches.
    this._list.addEventListener(
      "click",
      (e) => {
        const card = e.target.closest(".sp-card");
        if (card) this._select(Number(card.dataset.index), { focus: true });
      },
      sig,
    );
    this._list.addEventListener(
      "dblclick",
      (e) => {
        if (e.target.closest(".sp-card")) this._hatch();
      },
      sig,
    );
    this._list.addEventListener("keydown", (e) => this._onListKey(e), sig);
    // Phones: the carousel's centred card is the selection.
    this._list.addEventListener(
      "scroll",
      () => {
        if (this._scrollRaf) return;
        this._scrollRaf = requestAnimationFrame(() => {
          this._scrollRaf = 0;
          this._selectFromScroll();
        });
      },
      { passive: true, signal: this._ac.signal },
    );

    // Settings form.
    this.settingsLayer.addEventListener(
      "change",
      (e) => {
        const t = e.target;
        if (t.name === `${this._id}-style`) this._change({ style: t.value });
        else if (t.name === `${this._id}-quality`) this._change({ quality: t.value });
      },
      sig,
    );
    this._sensInput.addEventListener("input", () => this._change({ sensitivity: Number(this._sensInput.value) }), sig);

    // Capture phase so Esc/Enter here never also reach the game's Input.
    window.addEventListener("keydown", (e) => this._onKey(e), { capture: true, signal: this._ac.signal });
    const modality = { capture: true, passive: true, signal: this._ac.signal };
    window.addEventListener(
      "keydown",
      (e) => {
        if (/^(Tab|Enter|Arrow)/.test(String(e.key || ""))) keyboardUser = true;
      },
      modality,
    );
    window.addEventListener("pointerdown", () => (keyboardUser = false), modality);
  }

  _onKey(e) {
    const settingsOpen = this.settingsLayer.classList.contains("is-open");
    const controlsOpen = this.controlsLayer.classList.contains("is-open");
    if (settingsOpen || controlsOpen) {
      const layer = settingsOpen ? this.settingsLayer : this.controlsLayer;
      if (e.key === "Escape") {
        e.preventDefault();
        e.stopPropagation();
        if (settingsOpen) this.hideSettings();
        else this._closeLayer(this.controlsLayer);
      } else if (e.key === "Tab") {
        trapTab(e, layer);
      }
      return;
    }
    if (!this._visible || this._loading) return;
    if (this._screen === "species") {
      if (e.key === "Escape" || (e.key === "Backspace" && !/INPUT|TEXTAREA/.test(e.target.tagName))) {
        e.preventDefault();
        e.stopPropagation();
        this._setScreen("title", true);
      } else if (e.key === "Enter" && !e.target.closest?.("button")) {
        e.preventDefault();
        e.stopPropagation();
        this._hatch();
      }
    }
  }

  _onListKey(e) {
    const n = this._cards.length;
    if (!n) return;
    let i = this._selected;
    switch (e.key) {
      case "ArrowRight":
      case "ArrowDown":
        i = (i + 1) % n;
        break;
      case "ArrowLeft":
      case "ArrowUp":
        i = (i - 1 + n) % n;
        break;
      case "Home":
        i = 0;
        break;
      case "End":
        i = n - 1;
        break;
      case " ":
        e.preventDefault();
        return;
      default:
        return;
    }
    e.preventDefault();
    this._select(i, { focus: true });
  }

  /* --- Screens --- */

  _setScreen(name, focus) {
    this._screen = name;
    this.el.dataset.screen = name;
    for (const s of this.el.querySelectorAll(".screen")) {
      const on = s.dataset.screen === name;
      s.classList.toggle("is-active", on);
      s.toggleAttribute("inert", !on);
      s.setAttribute("aria-hidden", on ? "false" : "true");
    }
    if (!focus) return;
    if (name === "species") {
      this._select(this._selected, { focus: true, instant: true });
    } else {
      this._focusLater(this.el.querySelector(".mode--survival"));
    }
  }

  _primaryAction() {
    if (this._screen === "species") return this._cards[this._selected];
    return this._save ? this._continue.querySelector("button") : this.el.querySelector(".mode--survival");
  }

  _setActionsEnabled(on) {
    for (const b of this.el.querySelectorAll(".title__actions button, .menu__tools button")) b.disabled = !on;
  }

  _renderContinue() {
    const s = this._save;
    this.el.classList.toggle("has-save", Boolean(s));
    if (!s) {
      this._continue.hidden = true;
      this._continue.innerHTML = "";
      return;
    }
    const def = this.species.find((d) => d.id === s.speciesId) || { id: s.speciesId };
    const growth = clamp(Number(s.growth) || 0, 0, 1);
    const stage = STAGE_LABEL[stageOf(growth)];
    const name = s.speciesName || def.name || s.speciesId;
    this._continue.innerHTML = `
      <button type="button" class="continue__btn" data-act="continue">
        <span class="continue__fig">${speciesSilhouette(def, { human: false })}</span>
        <span class="continue__text">
          <span class="eyebrow">Continue your life</span>
          <span class="continue__name">${escapeHtml(name)}</span>
          <span class="continue__meta">${stage} · ${Math.round(growth * 100)}% grown${s.day ? ` · Day ${escapeHtml(s.day)}` : ""}</span>
        </span>
        <span class="continue__go" aria-hidden="true">${icon("arrowRight")}</span>
      </button>`;
    this._continue.hidden = false;
    const survival = this.el.querySelector(".mode--survival .mode__desc");
    survival.textContent = "Start a new life — your saved one will be lost.";
  }

  /* --- Species selection --- */

  _select(i, { focus = false, scroll = true, instant = false } = {}) {
    const n = this._cards?.length || 0;
    if (!n) {
      this._hatchBtn.disabled = true;
      return;
    }
    i = clamp(i | 0, 0, n - 1);
    this._selected = i;
    this._cards.forEach((c, j) => {
      const on = j === i;
      c.setAttribute("aria-selected", on ? "true" : "false");
      c.tabIndex = on ? 0 : -1;
      c.classList.toggle("is-selected", on);
    });
    const s = this.species[i];
    this._detailName.textContent = s.name || s.id;
    this._detailDesc.textContent = s.description || s.tagline || "";
    this._hatchText.innerHTML = `Hatch <em>${escapeHtml(s.name || s.id)}</em>`;
    this._hatchBtn.disabled = false;
    const card = this._cards[i];
    if (scroll && this._list.scrollWidth > this._list.clientWidth + 4) {
      this._scrollLockUntil = performance.now() + 700;
      const reduce = typeof matchMedia === "function" && matchMedia("(prefers-reduced-motion: reduce)").matches;
      const left = card.offsetLeft - (this._list.clientWidth - card.offsetWidth) / 2;
      this._list.scrollTo({ left, behavior: instant || reduce ? "auto" : "smooth" });
    }
    if (focus) card.focus({ preventScroll: true });
  }

  _selectFromScroll() {
    const list = this._list;
    if (performance.now() < this._scrollLockUntil || list.scrollWidth <= list.clientWidth + 4) return;
    const mid = list.scrollLeft + list.clientWidth / 2;
    let best = this._selected;
    let bestD = Infinity;
    this._cards.forEach((c, i) => {
      const d = Math.abs(c.offsetLeft + c.offsetWidth / 2 - mid);
      if (d < bestD) {
        bestD = d;
        best = i;
      }
    });
    if (best !== this._selected) this._select(best, { scroll: false });
  }

  _hatch() {
    const s = this.species[this._selected];
    if (!s || this._loading) return;
    this.onStart(s.id);
  }

  /* --- Settings form --- */

  _change(patch) {
    this._settings = normalizeSettings({ ...this._settings, ...patch });
    this._syncSettingsForm();
    this.onSettingsChange({ ...this._settings });
  }

  _syncSettingsForm() {
    const layer = this.settingsLayer;
    if (!layer) return;
    const s = this._settings;
    for (const r of layer.querySelectorAll(`input[name="${this._id}-style"]`)) r.checked = r.value === s.style;
    for (const r of layer.querySelectorAll(`input[name="${this._id}-quality"]`)) r.checked = r.value === s.quality;
    this._qualityHint.textContent =
      s.quality === "auto"
        ? "Auto picks High on desktops, Low on phones and small screens."
        : s.quality === "high"
          ? "Shadows, grass and denser forests. Best on a laptop or desktop."
          : "Lighter forests, no shadows — smooth on phones.";
    this._soundBtn.setAttribute("aria-checked", s.muted ? "false" : "true");
    this._soundBtn.querySelector(".switch__state").textContent = s.muted ? "Off" : "On";
    if (Number(this._sensInput.value) !== s.sensitivity) this._sensInput.value = String(s.sensitivity);
    this._sensOut.textContent = `${s.sensitivity.toFixed(2)}×`;
    this._sensInput.style.setProperty("--fill", `${((s.sensitivity - 0.5) / 1.5) * 100}%`);
  }

  /* --- Layers & focus --- */

  _open(el) {
    el.removeAttribute("inert");
    el.setAttribute("aria-hidden", "false");
    // Next frame, so the opacity transition runs from the hidden state.
    requestAnimationFrame(() => el.classList.add("is-open"));
    el.classList.add("is-mounted");
  }

  _close(el) {
    el.classList.remove("is-open");
    el.setAttribute("inert", "");
    el.setAttribute("aria-hidden", "true");
  }

  _openLayer(layer) {
    if (layer.classList.contains("is-open")) return;
    const active = document.activeElement;
    this._returnFocus = active && active !== document.body ? active : null;
    this._open(layer);
    this._focusLater(layer.querySelector("input:checked") || layer.querySelector(".icon-btn"));
  }

  _closeLayer(layer, restore = true) {
    if (!layer.classList.contains("is-open")) return;
    this._close(layer);
    if (restore && this._returnFocus?.isConnected) this._returnFocus.focus({ preventScroll: true });
    this._returnFocus = null;
  }

  _focusLater(el) {
    if (!el) return;
    requestAnimationFrame(() => requestAnimationFrame(() => el.focus({ preventScroll: true })));
  }
}

// Brand mark (same track as icon.svg), inlined so it inherits currentColor.
const TRACK_MARK =
  '<g transform="translate(32 39.6) scale(1.1)" fill="currentColor">' +
  '<path transform="translate(-2.6 0.4) rotate(-37)" d="M-3.7 1C-4-5.5-3.3-12.3-1.7-17.5-1.2-19.2-.6-20.7 0-22.2c.6 1.5 1.2 3 1.7 4.7C3.3-12.3 4-5.5 3.7 1z"/>' +
  '<path transform="translate(2.6 0.4) rotate(37)" d="M-3.7 1C-4-5.5-3.3-12.3-1.7-17.5-1.2-19.2-.6-20.7 0-22.2c.6 1.5 1.2 3 1.7 4.7C3.3-12.3 4-5.5 3.7 1z"/>' +
  '<path transform="translate(0 -1.6) scale(1.04 1.2)" d="M-3.7 1C-4-5.5-3.3-12.3-1.7-17.5-1.2-19.2-.6-20.7 0-22.2c.6 1.5 1.2 3 1.7 4.7C3.3-12.3 4-5.5 3.7 1z"/>' +
  '<path d="M-5.6 1.2C-6.3 6.3-3.6 11.2 0 11.2s6.3-4.9 5.6-10C5-2.2 2.7-3.4 0-3.4S-5-2.2-5.6 1.2z"/></g>';

/** The brand mark as standalone SVG markup (used by the loading veil and HUD). */
export const brandMark = (cls = "brand__mark") =>
  `<svg class="${cls}" viewBox="0 0 64 64" aria-hidden="true" focusable="false">${TRACK_MARK}</svg>`;

