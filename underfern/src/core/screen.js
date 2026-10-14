// Screen frame — Underfern always plays in landscape.
//
// iOS Safari can't lock orientation (no screen.orientation.lock, the manifest's
// "orientation" is ignored) and many players keep Portrait Orientation Lock on.
// So on a touch phone whose viewport is portrait, the whole game (#app) is laid
// out at landscape size and rotated 90° clockwise into the portrait viewport:
//
//   #app { width: <viewport height>; height: <viewport width>;
//          transform-origin: 0 0; transform: translate(<viewport width>, 0) rotate(90deg) }
//
// The app's top edge lies along the phone's right edge, so the player turns the
// phone counter-clockwise to play (home indicator on the right). Turn the phone
// for real (rotation lock off) and the viewport goes landscape: rotated mode
// switches off and everything lays out normally.
//
// Everything inside #app lays out in the APP frame: CSS sizes against the #app
// query container (cqw/cqh, @container app) and safe areas come from --sa-*,
// which style.css remaps while rotated. JS that reads client coordinates or
// sizes goes through toApp() / appSize() instead of clientX / innerWidth /
// getBoundingClientRect (which return the rotated bounding box in client space).
//
// Browsers pan in SCREEN axes — Chrome won't touch-scroll a turned scroller at
// all, and only moves a horizontal slider for a horizontal-on-screen drag — so
// while rotated, native panning is off inside #app (style.css) and this module
// scrolls lists and drags sliders itself, along the app's axes (see below).
//
// URL override for testing: ?rotate=0 never rotates, ?rotate=1 rotates any
// portrait viewport (desktop included).

/** Phones only: tablets (shorter side ≥ 600 CSS px) are fine upright. */
const PHONE_MAX_SHORT_SIDE = 600;

const frame = {
  rotated: false,
  /** The app's own (landscape-oriented) size in CSS px. */
  w: 0,
  h: 0,
  /** Client-space position of the app's top-left corner. */
  ox: 0,
  oy: 0,
};

const listeners = new Set();
let started = false;
let noteShown = false;

const hasDom = typeof window !== "undefined" && typeof document !== "undefined";

function forced() {
  if (!hasDom) return null;
  try {
    const v = new URLSearchParams(location.search).get("rotate");
    return v === "0" || v === "1" ? v : null;
  } catch {
    return null;
  }
}
const FORCE = forced();

function isPhone() {
  if (FORCE === "1") return true;
  if (FORCE === "0") return false;
  const coarse = typeof matchMedia === "function" && matchMedia("(pointer: coarse)").matches;
  const sw = window.screen?.width || 0;
  const sh = window.screen?.height || 0;
  return coarse && sw > 0 && sh > 0 && Math.min(sw, sh) < PHONE_MAX_SHORT_SIDE;
}

/* --- Public API ------------------------------------------------------------- */

/** True while the app is drawn rotated 90° into a portrait viewport. */
export function isRotated() {
  return frame.rotated;
}

/**
 * The app's own size in CSS px — landscape-oriented while rotated.
 * @param {{w:number,h:number}} [out]
 * @returns {{w:number,h:number}}
 */
export function appSize(out = { w: 0, h: 0 }) {
  if (!started) refresh();
  out.w = frame.w;
  out.h = frame.h;
  return out;
}

/**
 * Client coordinates (clientX / clientY of a pointer event) → app-local
 * coordinates (x right, y down, in the app's frame). Inverse of the #app
 * transform: rotated, a client point (cx, cy) sits at x = cy - oy, y = ox - cx.
 * @param {number} clientX
 * @param {number} clientY
 * @param {{x:number,y:number}} [out]
 * @returns {{x:number,y:number}}
 */
export function toApp(clientX, clientY, out = { x: 0, y: 0 }) {
  if (frame.rotated) {
    out.x = clientY - frame.oy;
    out.y = frame.ox - clientX;
  } else {
    out.x = clientX;
    out.y = clientY;
  }
  return out;
}

/**
 * Call `fn({ w, h, rotated })` whenever the app frame changes size or
 * orientation (also dispatched on window as the "app-resize" event).
 * @returns {() => void} unsubscribe
 */
export function onAppResize(fn) {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

/**
 * Ask the browser to lock landscape where that's possible (Android Chrome in
 * fullscreen / an installed web app). Call inside a start gesture; failures
 * (iOS, desktop, not fullscreen) are expected and ignored.
 */
export function tryLockLandscape() {
  if (!hasDom || !isPhone()) return;
  try {
    const r = window.screen?.orientation?.lock?.("landscape");
    if (r && typeof r.catch === "function") r.catch(() => {});
  } catch {
    /* unsupported */
  }
}

/** Re-measure the viewport and update the app frame (cheap; idempotent). */
export function refresh() {
  if (!hasDom) return frame;
  started = true;
  const vv = window.visualViewport;
  const vw = Math.max(1, vv ? vv.width : window.innerWidth || 1);
  const vh = Math.max(1, vv ? vv.height : window.innerHeight || 1);
  const rotated = vh > vw && isPhone();
  // #app is position: fixed at the layout viewport's origin; while rotated it
  // is translated to the visual viewport's top-RIGHT corner before turning.
  const ox = rotated ? (vv ? vv.offsetLeft : 0) + vw : 0;
  const oy = rotated ? (vv ? vv.offsetTop : 0) : 0;
  const w = rotated ? vh : vw;
  const h = rotated ? vw : vh;
  const changed = rotated !== frame.rotated || w !== frame.w || h !== frame.h || ox !== frame.ox || oy !== frame.oy;
  if (!changed) return frame;
  const flipped = rotated !== frame.rotated;
  frame.rotated = rotated;
  frame.w = w;
  frame.h = h;
  frame.ox = ox;
  frame.oy = oy;

  const html = document.documentElement;
  html.classList.toggle("is-rotated", rotated);
  html.style.setProperty("--app-w", `${w}px`);
  html.style.setProperty("--app-h", `${h}px`);
  html.style.setProperty("--app-x", `${ox}px`);
  html.style.setProperty("--app-y", `${oy}px`);
  if (flipped) showTurnNote(rotated);

  const detail = { w, h, rotated };
  for (const fn of listeners) {
    try {
      fn(detail);
    } catch (err) {
      console.error("[screen] app-resize listener threw", err);
    }
  }
  window.dispatchEvent(new CustomEvent("app-resize", { detail }));
  return frame;
}

/* --- The "turn your phone" note ------------------------------------------------ */

/**
 * The first time rotated mode switches on, show the short note in index.html
 * (#turn-note). It's laid out in the app frame, so it reads correctly once the
 * phone is turned, never takes taps, and bows out by itself (CSS animation).
 */
function showTurnNote(on) {
  const el = document.getElementById("turn-note");
  if (!el) return;
  if (!on) {
    el.classList.remove("is-on"); // the player turned the phone for real
    return;
  }
  if (noteShown) return;
  noteShown = true;
  el.classList.add("is-on");
  el.addEventListener("animationend", (e) => e.animationName === "turn-note-out" && el.classList.remove("is-on"));
}

/* --- Sliders while rotated ----------------------------------------------------------- */

// While rotated, touch drags on <input type=range> are driven from the finger's
// position in the app frame; mouse, keyboard and the unrotated layout keep the
// native behaviour.
const RANGE_THUMB = 20; // px — the .range thumb in style.css; native travel is inset by half of it
const rangePt = { x: 0, y: 0 };

function isRange(el) {
  return !!el && el.tagName === "INPUT" && el.type === "range" && !el.disabled;
}

/** Set a turned slider from a client point. @returns {boolean} changed */
function setRangeFrom(el, clientX, clientY) {
  // Turned exactly 90°, the client rect is still the slider's own box with the
  // sides swapped: its app-frame left edge is the rect's top.
  const r = el.getBoundingClientRect();
  const pt = toApp(clientX, clientY, rangePt);
  const left = r.top - frame.oy;
  const width = r.height;
  const half = Math.min(RANGE_THUMB / 2, width / 2);
  const f = Math.min(1, Math.max(0, (pt.x - left - half) / Math.max(1, width - 2 * half)));
  const min = el.min === "" ? 0 : Number(el.min);
  const max = el.max === "" ? 100 : Number(el.max);
  const before = el.value;
  el.value = String(min + f * (max - min)); // the input snaps it to its step
  if (el.value === before) return false;
  el.dispatchEvent(new Event("input", { bubbles: true }));
  return true;
}

function bindRotatedRanges() {
  let drag = null; // { el, id, changed }
  const end = (e) => {
    if (!drag || e.pointerId !== drag.id) return;
    if (drag.changed) drag.el.dispatchEvent(new Event("change", { bubbles: true }));
    drag = null;
  };
  // Cancelling touchstart keeps the browser's own slider handling (and any
  // pan) out of it; pointer events still arrive.
  document.addEventListener("touchstart", (e) => frame.rotated && isRange(e.target) && e.cancelable && e.preventDefault(), {
    capture: true,
    passive: false,
  });
  document.addEventListener(
    "pointerdown",
    (e) => {
      if (!frame.rotated || e.pointerType === "mouse" || drag || !isRange(e.target)) return;
      const el = e.target;
      drag = { el, id: e.pointerId, changed: false };
      try {
        el.setPointerCapture(e.pointerId);
      } catch {
        /* best-effort */
      }
      drag.changed = setRangeFrom(el, e.clientX, e.clientY);
    },
    true,
  );
  document.addEventListener(
    "pointermove",
    (e) => {
      if (!drag || e.pointerId !== drag.id) return;
      if (setRangeFrom(drag.el, e.clientX, e.clientY)) drag.changed = true;
    },
    true,
  );
  document.addEventListener("pointerup", end, true);
  document.addEventListener("pointercancel", end, true);
}

/* --- Scrolling while rotated ---------------------------------------------------------- */

// While rotated, a touch drag over a scroll container in #app scrolls it from
// here, along the app's axes: the first 8 px of travel pick the axis (so a
// carousel inside a vertical sheet takes sideways drags and the sheet the
// rest), the content tracks the finger, and on release a short fling settles
// on the container's own snap points. The game's thumb controls (.touch) and
// sliders are left alone; a drag never also counts as a tap.
const DRAG_SLOP = 8; // px of travel before a touch is a scroll, not a tap
const FLING_MS = 260; // a release at v px/ms carries on for about v × this
const scrollPt = { x: 0, y: 0 };

function canScroll(el, axis) {
  const cs = getComputedStyle(el);
  const overflow = axis === "x" ? cs.overflowX : cs.overflowY;
  if (overflow !== "auto" && overflow !== "scroll") return false;
  return axis === "x" ? el.scrollWidth > el.clientWidth + 1 : el.scrollHeight > el.clientHeight + 1;
}

function bindRotatedScrolling() {
  let drag = null; // { id, target, x, y, el, axis, start, origin, pos, t, v, snap }
  let noClickUntil = 0;

  document.addEventListener(
    "pointerdown",
    (e) => {
      if (!frame.rotated || e.pointerType === "mouse" || !e.isPrimary || drag) return;
      const t = e.target;
      const app = document.getElementById("app");
      if (!t || !t.closest || !app?.contains(t) || isRange(t) || t.closest(".touch")) return;
      const pt = toApp(e.clientX, e.clientY, scrollPt);
      drag = { id: e.pointerId, target: t, x: pt.x, y: pt.y, el: null };
    },
    true,
  );

  document.addEventListener(
    "pointermove",
    (e) => {
      if (!drag || e.pointerId !== drag.id) return;
      const pt = toApp(e.clientX, e.clientY, scrollPt);
      if (!drag.el) {
        const dx = pt.x - drag.x;
        const dy = pt.y - drag.y;
        if (Math.hypot(dx, dy) < DRAG_SLOP) return;
        const axis = Math.abs(dx) >= Math.abs(dy) ? "x" : "y";
        let el = drag.target;
        while (el && el.id !== "app" && el !== document.body && !canScroll(el, axis)) el = el.parentElement;
        if (!el || el.id === "app" || el === document.body) {
          drag = null; // nothing scrolls that way: let the touch be
          return;
        }
        drag.el = el;
        drag.axis = axis;
        drag.start = axis === "x" ? el.scrollLeft : el.scrollTop;
        drag.origin = axis === "x" ? pt.x : pt.y;
        drag.pos = drag.origin;
        drag.t = e.timeStamp;
        drag.v = 0;
        // Free movement under the finger; the snap comes back on release.
        drag.snap = el.style.scrollSnapType;
        el.style.scrollSnapType = "none";
      }
      const pos = drag.axis === "x" ? pt.x : pt.y;
      const to = drag.start - (pos - drag.origin);
      if (drag.axis === "x") drag.el.scrollLeft = to;
      else drag.el.scrollTop = to;
      const dt = Math.max(1, e.timeStamp - drag.t);
      drag.v += ((pos - drag.pos) / dt - drag.v) * 0.5; // px/ms, lightly smoothed
      drag.pos = pos;
      drag.t = e.timeStamp;
    },
    true,
  );

  const end = (e) => {
    if (!drag || e.pointerId !== drag.id) return;
    const { el, axis, v, snap, t } = drag;
    drag = null;
    if (!el) return;
    noClickUntil = performance.now() + 350; // the lift that ends a drag isn't a tap
    el.style.scrollSnapType = snap;
    const reduce = typeof matchMedia === "function" && matchMedia("(prefers-reduced-motion: reduce)").matches;
    // A finger that stopped before lifting doesn't fling.
    const fling = e.type === "pointerup" && e.timeStamp - t < 80 ? -v * FLING_MS : 0;
    const key = axis === "x" ? "left" : "top";
    const now = axis === "x" ? el.scrollLeft : el.scrollTop;
    // Scrolling to the destination (even "here") lets the browser settle it
    // on a snap point, if the container has them.
    el.scrollTo({ [key]: now + fling, behavior: reduce || !fling ? "auto" : "smooth" });
  };
  document.addEventListener("pointerup", end, true);
  document.addEventListener("pointercancel", end, true);
  document.addEventListener(
    "click",
    (e) => {
      if (performance.now() >= noClickUntil) return;
      e.preventDefault();
      e.stopPropagation();
    },
    true,
  );
}

/* --- Wiring -------------------------------------------------------------------- */

if (hasDom) {
  const update = () => refresh();
  // iOS reports stale sizes right after a rotation; look again once it settles.
  const settle = () => {
    refresh();
    for (const ms of [120, 350, 700]) setTimeout(update, ms);
  };
  window.addEventListener("resize", update);
  window.addEventListener("orientationchange", settle);
  window.visualViewport?.addEventListener("resize", update);
  window.visualViewport?.addEventListener("scroll", update);
  window.screen?.orientation?.addEventListener?.("change", settle);
  if (typeof matchMedia === "function") {
    matchMedia("(orientation: portrait)").addEventListener?.("change", settle);
    // A mouse plugged into a phone (or unplugged) flips pointer: coarse.
    matchMedia("(pointer: coarse)").addEventListener?.("change", update);
  }
  bindRotatedRanges();
  bindRotatedScrolling();
  if (document.readyState === "loading") {
    refresh(); // <html> exists already; the note gets shown once the body has parsed
    document.addEventListener("DOMContentLoaded", () => frame.rotated && showTurnNote(true), { once: true });
  } else {
    refresh();
  }
}
