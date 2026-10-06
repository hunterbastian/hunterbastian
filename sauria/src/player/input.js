// Input — keyboard, mouse (pointer lock) and touch, normalised into a small
// vocabulary of actions that the controllers poll once per frame:
//   held   → isDown(action)    "sprint" | "crouch" | "interact" | "bite" | "aim"
//   edges  → pressed(action)   "bite" | "call" | "sniff" | "rest" | "map" | "pause" | "help" |
//                              "interact" | "crouch" | "reload" | "weapon1" | "weapon2" |
//                              "binoculars" | "extract" | "aim"
//   axes   → moveAxis(), consumeLook(), consumeZoom()
// On touch devices Input builds its own on-screen controls inside `uiRoot`
// (floating joystick, drag-to-look, action buttons per mode).

/* --- Bindings ------------------------------------------------------------ */

// Keys are matched by `event.code` (physical position), so WASD stays WASD on
// AZERTY / Dvorak layouts.
const MOVE_KEYS = {
  forward: ["KeyW", "ArrowUp"],
  back: ["KeyS", "ArrowDown"],
  left: ["KeyA", "ArrowLeft"],
  right: ["KeyD", "ArrowRight"],
};

/** Keys that hold an action down while pressed. */
const HELD_KEYS = {
  sprint: ["ShiftLeft", "ShiftRight"],
  // Ctrl is the *hold* crouch; C (an edge, below) toggles it.
  crouch: ["ControlLeft", "ControlRight"],
  interact: ["KeyE"],
  bite: ["KeyF"],
  aim: [],
};

/** Keys that fire one-frame edges. One key may fire several (R = sniff + reload). */
const EDGE_KEYS = {
  KeyF: ["bite"],
  KeyE: ["interact"],
  KeyC: ["crouch"],
  KeyQ: ["call"],
  KeyR: ["sniff", "reload"],
  KeyZ: ["rest"],
  KeyM: ["map"],
  Escape: ["pause"],
  KeyP: ["pause"],
  KeyH: ["help"],
  Digit1: ["weapon1"],
  Numpad1: ["weapon1"],
  Digit2: ["weapon2"],
  Numpad2: ["weapon2"],
  KeyB: ["binoculars"],
  KeyX: ["extract"],
};

// Edges that still register while `enabled` is false, so main can close the
// pause menu / map / help with the same key that opened them.
const UI_EDGES = new Set(["pause", "map", "help"]);

/** Every code the game reacts to — only these get preventDefault(). */
const GAME_CODES = new Set([
  ...Object.values(MOVE_KEYS).flat(),
  ...Object.values(HELD_KEYS).flat(),
  ...Object.keys(EDGE_KEYS),
  "Space", // never scroll the page from under the game
]);

const MOUSE_LEFT = 1;
const MOUSE_RIGHT = 2;

// Touch drags cover far fewer pixels than a mouse sweep for the same intent;
// scale them so a thumb flick across half the screen turns ~150°.
const TOUCH_LOOK_SCALE = 1.9;
const STICK_DEAD_ZONE = 0.12;
const STICK_FALLBACK_RADIUS = 60; // px, used when CSS hasn't sized the stick
// Drags shorter than this (px) on the mouse fallback count as a click.
const CLICK_SLOP = 6;
// Browsers synthesise mouse events ~300 ms after a touch; ignore them for this long.
const TOUCH_MOUSE_GUARD_MS = 900;
// Esc while pointer-locked can arrive both as a keydown and as an unlock;
// collapse them into one pause.
const PAUSE_DEDUPE_MS = 300;
// Chrome occasionally reports a locked mousemove as a jump to/from absolute
// screen coordinates (hundreds of px). Real per-event deltas stay well below.
const LOCKED_SPIKE_PX = 500;

/* --- Touch button sets ------------------------------------------------------ */

// 24×24 stroke icons drawn in currentColor so the UI can theme them.
const ICONS = {
  bite:
    '<path d="M3 8.6C6.2 4.8 17.8 4.8 21 8.6"/><path d="M4.6 8.4l1.65 2.7 1.65-2.5 1.65 2.7 1.65-2.7 1.6 2.7 1.65-2.7 1.65 2.5 1.65-2.7"/>' +
    '<path d="M3 15.4c3.2 3.8 14.8 3.8 18 0"/><path d="M4.6 15.6l1.65-2.7 1.65 2.5 1.65-2.7 1.65 2.7 1.6-2.7 1.65 2.7 1.65-2.5 1.65 2.7"/>',
  interact:
    '<path d="M3.5 20.5c0-7.2 4.3-11.6 11-12.2 0 7.2-4.3 11.6-11 12.2z"/><path d="M3.5 20.5l6.4-6.4"/>' +
    '<path d="M17.5 2.8c1.9 2.5 3 4.3 3 5.7a3 3 0 0 1-6 0c0-1.4 1.1-3.2 3-5.7z"/>',
  sprint: '<path d="M5 5.5l6.5 6.5L5 18.5"/><path d="M12.5 5.5L19 12l-6.5 6.5"/>',
  crouch: '<path d="M12 3.5v10.5"/><path d="M7.5 9.5L12 14l4.5-4.5"/><path d="M4.5 19h15"/>',
  call:
    '<path d="M3.5 9.5v5h3.2l4.8 4V5.5l-4.8 4H3.5z"/><path d="M15 9a4.2 4.2 0 0 1 0 6"/><path d="M17.6 6.3a8 8 0 0 1 0 11.4"/>',
  lure:
    '<path d="M3 10.2v3.6l9.5 4.6V5.6z"/><path d="M12.5 8.2h2.8a3.8 3.8 0 0 1 0 7.6h-2.8"/><path d="M20 9.2c.9 1.6.9 4 0 5.6"/>',
  sniff:
    '<path d="M7 20.5c-1.9-2.8 1.9-4.6 0-7.6s1.9-4.8 0-7.9"/><path d="M12 20.5c-1.9-2.8 1.9-4.6 0-7.6s1.9-4.8 0-7.9"/>' +
    '<path d="M17 20.5c-1.9-2.8 1.9-4.6 0-7.6s1.9-4.8 0-7.9"/>',
  rest: '<path d="M19.5 14.6A8 8 0 1 1 9.4 4.5a6.4 6.4 0 0 0 10.1 10.1z"/><path d="M15 3.5h3.5L15 7.5h3.5"/>',
  map:
    '<path d="M3.5 6.6L9 4.3l6 2.4 5.5-2.3v13.4L15 20.1l-6-2.4-5.5 2.3z"/><path d="M9 4.3v13.4"/><path d="M15 6.7v13.4"/>',
  pause: '<path d="M8.5 5v14"/><path d="M15.5 5v14"/>',
  fire:
    '<circle cx="12" cy="12" r="6.6"/><path d="M12 2.5v4.2M12 17.3v4.2M2.5 12h4.2M17.3 12h4.2"/>' +
    '<circle cx="12" cy="12" r="1.1" fill="currentColor" stroke="none"/>',
  aim:
    '<path d="M4 8.5V4h4.5"/><path d="M15.5 4H20v4.5"/><path d="M20 15.5V20h-4.5"/><path d="M8.5 20H4v-4.5"/>' +
    '<circle cx="12" cy="12" r="2.6"/>',
  reload: '<path d="M20 12a8 8 0 1 1-2.5-5.8"/><path d="M20.2 3.8v4.6h-4.6"/>',
  binoculars:
    '<circle cx="6.8" cy="15.6" r="3.9"/><circle cx="17.2" cy="15.6" r="3.9"/>' +
    '<path d="M4.4 12.4L6.6 5h3.2v6.8"/><path d="M19.6 12.4L17.4 5h-3.2v6.8"/><path d="M9.8 14h4.4"/>',
  extract:
    '<path d="M3 4.8h18"/><path d="M12 4.8v3.4"/><path d="M5.6 13.2c0-3 2.9-5 6.9-5s6.4 2 6.4 5-2.4 4.4-6.4 4.4-6.9-1.4-6.9-4.4z"/>' +
    '<path d="M5.6 12.6H2"/><path d="M9 17.4l-1 2.8M16 17.4l1 2.8M6 20.2h12.5"/>',
  swap: '<path d="M4 8h13"/><path d="M14 4.5L17.5 8 14 11.5"/><path d="M20 16H7"/><path d="M10 12.5L6.5 16l3.5 3.5"/>',
};

/**
 * Button layouts per mode. `slot` names a position in the thumb-reach layout
 * (see BASE_CSS): "primary" big button bottom-right, "arc0..3" an inner ring
 * around it, "outer0..2" an outer ring, "top0..2" small utility buttons.
 * `kind`: "hold" (isDown while touched), "tap" (edge only), "latch" (tap to
 * toggle a held state — sprint/aim, so two thumbs stay free for move + look).
 */
const BUTTON_SETS = {
  dino: [
    { action: "bite", slot: "primary", icon: "bite", label: "Bite", kind: "hold" },
    { action: "sprint", slot: "arc0", icon: "sprint", label: "Sprint", kind: "latch" },
    { action: "interact", slot: "arc1", icon: "interact", label: "Eat or drink", short: "Eat/Drink", kind: "hold" },
    { action: "sniff", slot: "arc2", icon: "sniff", label: "Sniff", kind: "tap" },
    { action: "crouch", slot: "arc3", icon: "crouch", label: "Crouch", kind: "tap" },
    { action: "rest", slot: "outer0", icon: "rest", label: "Rest", kind: "tap" },
    { action: "call", slot: "outer1", icon: "call", label: "Call", kind: "tap" },
    { action: "map", slot: "top1", icon: "map", label: "Map", kind: "tap" },
    { action: "pause", slot: "top0", icon: "pause", label: "Pause", kind: "tap" },
  ],
  hunter: [
    { action: "bite", slot: "primary", icon: "fire", label: "Fire", kind: "hold" },
    { action: "aim", slot: "arc0", icon: "aim", label: "Aim", kind: "latch" },
    { action: "reload", slot: "arc1", icon: "reload", label: "Reload", kind: "tap" },
    { action: "sprint", slot: "arc2", icon: "sprint", label: "Sprint", kind: "latch" },
    { action: "crouch", slot: "arc3", icon: "crouch", label: "Crouch", kind: "tap" },
    { action: "swap", slot: "outer0", icon: "swap", label: "Switch weapon", short: "Swap", kind: "tap" },
    { action: "binoculars", slot: "outer1", icon: "binoculars", label: "Binoculars", short: "Binocs", kind: "tap" },
    { action: "call", slot: "outer2", icon: "lure", label: "Lure call", short: "Lure", kind: "tap" },
    { action: "extract", slot: "top2", icon: "extract", label: "Call extraction", kind: "tap" },
    { action: "map", slot: "top1", icon: "map", label: "Map", kind: "tap" },
    { action: "pause", slot: "top0", icon: "pause", label: "Pause", kind: "tap" },
  ],
};

/*
 * Functional baseline for the touch layer. Every selector is wrapped in
 * :where() (zero specificity), so any rule in style.css overrides it — the UI
 * owns the look; this only guarantees the controls are usable and placed
 * sensibly even before / without those rules.
 */
const BASE_CSS = `
:where(.touch){position:fixed;inset:0;z-index:5;touch-action:none;user-select:none;-webkit-user-select:none;-webkit-touch-callout:none;-webkit-tap-highlight-color:transparent;color:var(--c-bone,#efe7d6);font-family:var(--font-ui,system-ui,sans-serif)}
:where(.touch *){touch-action:none;user-select:none;-webkit-user-select:none;-webkit-touch-callout:none;-webkit-tap-highlight-color:transparent}
:where(.touch-zone){position:absolute;top:0;bottom:0;pointer-events:auto}
:where(.touch-zone--move){left:0;width:50%}
:where(.touch-zone--look){right:0;width:50%}
:where(.touch-stick){position:absolute;width:128px;height:128px;margin:-64px 0 0 -64px;border-radius:50%;pointer-events:none;background:radial-gradient(circle,rgba(20,24,18,.10) 55%,rgba(20,24,18,.28));box-shadow:inset 0 0 0 1.5px rgba(239,231,214,.35);transition:opacity .25s ease}
:where(.touch-stick--idle){opacity:.45;transition:opacity .25s ease,left .3s ease,top .3s ease}
:where(.touch-stick__knob){position:absolute;left:50%;top:50%;width:56px;height:56px;margin:-28px 0 0 -28px;border-radius:50%;background:rgba(239,231,214,.82);box-shadow:0 2px 10px rgba(0,0,0,.35)}
:where(.touch-btn){pointer-events:auto;position:absolute;display:grid;place-items:center;width:58px;height:58px;padding:0;border:0;border-radius:50%;color:inherit;font:inherit;background:rgba(18,22,17,.42);box-shadow:inset 0 0 0 1.5px rgba(239,231,214,.32),0 2px 8px rgba(0,0,0,.25);-webkit-backdrop-filter:blur(6px);backdrop-filter:blur(6px);transition:transform .08s ease,background-color .15s ease}
:where(.touch-btn svg){width:44%;height:44%;margin-top:-9px;fill:none;stroke:currentColor;stroke-width:1.8;stroke-linecap:round;stroke-linejoin:round;pointer-events:none}
:where(.touch-btn__label){position:absolute;left:0;right:0;bottom:8px;font-size:8px;line-height:1;letter-spacing:.03em;text-align:center;white-space:nowrap;opacity:.8;pointer-events:none}
:where(.touch-btn[data-slot="primary"] svg),:where(.touch-btn[data-slot^="top"] svg){margin-top:0}
:where(.touch-btn--held){transform:scale(.92);background:rgba(239,231,214,.30)}
:where(.touch-btn--active){background:rgba(146,163,94,.55);box-shadow:inset 0 0 0 2px rgba(239,231,214,.7)}
:where(.touch-btn--hint){box-shadow:inset 0 0 0 2px var(--c-ochre,#d9a441),0 0 14px rgba(217,164,65,.55)}
:where(.touch-btn--cooldown){opacity:.55}
:where(.touch-btn--cooldown)::after{content:"";position:absolute;inset:0;border-radius:50%;pointer-events:none;background:conic-gradient(rgba(0,0,0,.45) calc(var(--cd,0)*360deg),transparent 0)}
:where(.touch-btn[data-slot="primary"]){right:calc(22px + env(safe-area-inset-right));bottom:calc(22px + env(safe-area-inset-bottom));width:82px;height:82px}
:where(.touch-btn[data-slot="primary"] .touch-btn__label){display:none}
:where(.touch-btn[data-slot="arc0"]){right:calc(144px + env(safe-area-inset-right));bottom:calc(34px + env(safe-area-inset-bottom))}
:where(.touch-btn[data-slot="arc1"]){right:calc(129px + env(safe-area-inset-right));bottom:calc(98px + env(safe-area-inset-bottom))}
:where(.touch-btn[data-slot="arc2"]){right:calc(88px + env(safe-area-inset-right));bottom:calc(146px + env(safe-area-inset-bottom))}
:where(.touch-btn[data-slot="arc3"]){right:calc(30px + env(safe-area-inset-right));bottom:calc(162px + env(safe-area-inset-bottom))}
:where(.touch-btn[data-slot^="outer"]){width:48px;height:48px}
:where(.touch-btn[data-slot="outer0"]){right:calc(214px + env(safe-area-inset-right));bottom:calc(108px + env(safe-area-inset-bottom))}
:where(.touch-btn[data-slot="outer1"]){right:calc(170px + env(safe-area-inset-right));bottom:calc(178px + env(safe-area-inset-bottom))}
:where(.touch-btn[data-slot="outer2"]){right:calc(106px + env(safe-area-inset-right));bottom:calc(226px + env(safe-area-inset-bottom))}
:where(.touch-btn[data-slot^="top"]){width:44px;height:44px;top:calc(14px + env(safe-area-inset-top))}
:where(.touch-btn[data-slot^="top"] .touch-btn__label){display:none}
:where(.touch-btn[data-slot="top0"]){right:calc(14px + env(safe-area-inset-right))}
:where(.touch-btn[data-slot="top1"]){right:calc(66px + env(safe-area-inset-right))}
:where(.touch-btn[data-slot="top2"]){right:calc(118px + env(safe-area-inset-right))}
@media (max-width:520px){
:where(.touch-stick){width:116px;height:116px;margin:-58px 0 0 -58px}
:where(.touch-stick__knob){width:50px;height:50px;margin:-25px 0 0 -25px}
:where(.touch-btn){width:48px;height:48px}
:where(.touch-btn[data-slot="primary"]){right:calc(16px + env(safe-area-inset-right));bottom:calc(20px + env(safe-area-inset-bottom));width:72px;height:72px}
:where(.touch-btn[data-slot="arc0"]){right:calc(130px + env(safe-area-inset-right));bottom:calc(32px + env(safe-area-inset-bottom))}
:where(.touch-btn[data-slot="arc1"]){right:calc(116px + env(safe-area-inset-right));bottom:calc(83px + env(safe-area-inset-bottom))}
:where(.touch-btn[data-slot="arc2"]){right:calc(79px + env(safe-area-inset-right));bottom:calc(120px + env(safe-area-inset-bottom))}
:where(.touch-btn[data-slot="arc3"]){right:calc(28px + env(safe-area-inset-right));bottom:calc(134px + env(safe-area-inset-bottom))}
:where(.touch-btn[data-slot^="outer"]){width:42px;height:42px}
:where(.touch-btn[data-slot="outer0"]){right:calc(144px + env(safe-area-inset-right));bottom:calc(148px + env(safe-area-inset-bottom))}
:where(.touch-btn[data-slot="outer1"]){right:calc(84px + env(safe-area-inset-right));bottom:calc(186px + env(safe-area-inset-bottom))}
:where(.touch-btn[data-slot="outer2"]){right:calc(26px + env(safe-area-inset-right));bottom:calc(206px + env(safe-area-inset-bottom))}
:where(.touch-btn__label){bottom:7px;font-size:7.5px;letter-spacing:.02em}
}
`;

const STYLE_ID = "sauria-touch-base";

/* --- Helpers ----------------------------------------------------------------- */

/** True for elements that should keep their keys (typing in a settings field). */
function isFormControl(el) {
  if (!el || el.nodeType !== 1) return false;
  if (el.isContentEditable) return true;
  const tag = el.tagName;
  if (tag === "TEXTAREA" || tag === "SELECT") return true;
  if (tag !== "INPUT") return false;
  // Checkboxes / ranges / buttons don't type, so game keys can pass through.
  const type = (el.type || "text").toLowerCase();
  return !["checkbox", "radio", "range", "button", "submit", "reset", "color"].includes(type);
}

function detectTouch() {
  if (typeof window === "undefined") return false;
  const mq = (q) => (typeof window.matchMedia === "function" ? window.matchMedia(q).matches : false);
  if (mq("(pointer: coarse)")) return true;
  // A touchscreen without any fine pointer (some Android tablets report
  // pointer:fine wrongly but expose touch events). Laptops with a touchscreen
  // *and* a trackpad keep the desktop controls.
  const hasTouchEvents = "ontouchstart" in window || (navigator.maxTouchPoints || 0) > 0;
  return hasTouchEvents && !mq("(any-pointer: fine)");
}

/* --- Input ---------------------------------------------------------------- */

export class Input {
  /**
   * @param {HTMLCanvasElement} canvas  the game canvas (pointer-lock target, mouse surface)
   * @param {HTMLElement} uiRoot        container for the touch controls
   * @param {{ touch?: boolean }} [opts] force touch controls on/off (default: auto-detect)
   */
  constructor(canvas, uiRoot, { touch } = {}) {
    this.canvas = canvas;
    this.uiRoot = uiRoot;
    /** Touch controls are shown (coarse pointer / touch-only device). */
    this.isTouch = typeof touch === "boolean" ? touch : detectTouch();
    /** True while the document's pointer lock is on our canvas. */
    this.pointerLocked = false;
    /** "dino" | "hunter" — selects the touch button set. */
    this.mode = "dino";
    /**
     * Called (synchronously, inside the event) on user gestures that grant
     * user activation — keydown, mousedown, pointerup, touchend, click — so
     * main can start/resume the AudioContext (iOS needs this). Called on every
     * such gesture until it returns something other than `false`.
     * @type {null | ((event: Event) => any)}
     */
    this.onFirstGesture = null;
    /** True once any activating gesture happened (if the hook was set late). */
    this.hasGesture = false;

    this._enabled = true;
    this._keys = new Set();
    this._edges = new Set();
    this._mouse = 0;
    this._lookX = 0;
    this._lookY = 0;
    this._zoom = 0;
    this._axis = { x: 0, y: 0 };
    this._lookOut = { dx: 0, dy: 0 };
    this._gestureDone = false;
    this._skipLockedMoves = 0;
    this._lockSupported = !!(canvas && canvas.requestPointerLock);
    this._lockFailed = false;
    this._expectUnlock = false;
    this._lastTouchTime = -1e9;
    this._lastPauseTime = -1e9;
    // Mouse drag-to-look fallback when pointer lock is unavailable.
    this._drag = { active: false, button: -1, x: 0, y: 0, moved: 0, acts: false };
    this._lastWeapon = "weapon1";

    // Touch state.
    this._touchCount = Object.create(null); // action → pointers holding it
    this._btnPointers = new Map(); // pointerId → { action, el }
    this._latch = { sprint: false, aim: false };
    this._stick = { id: -1, cx: 0, cy: 0, x: 0, y: 0, radius: STICK_FALLBACK_RADIUS };
    this._look = { id: -1, x: 0, y: 0 };
    this._rootLeft = 0;
    this._rootTop = 0;
    this._buttons = new Map(); // action → { el, active, hint, cd }
    this.touchRoot = null;

    this._ac = typeof AbortController === "function" ? new AbortController() : null;
    this._bind();
    if (this.isTouch && uiRoot) this._buildTouch();
  }

  /* --- Public API ----------------------------------------------------------- */

  /** False while menus are open: game input is ignored and the touch layer hidden. */
  get enabled() {
    return this._enabled;
  }

  set enabled(on) {
    on = !!on;
    if (on === this._enabled) return;
    this._enabled = on;
    this._releaseAll();
    // Stale edges from the menu (e.g. the Esc that closed it) must not leak into play.
    this._edges.clear();
    if (!on) this.exitPointerLock();
    if (this.touchRoot) this.touchRoot.style.display = on ? "" : "none";
  }

  /**
   * Desired planar movement from WASD/arrows and the touch stick.
   * x = right, y = forward, length ≤ 1. Returns a shared object — read it, don't keep it.
   * @returns {{ x: number, y: number }}
   */
  moveAxis() {
    const out = this._axis;
    out.x = 0;
    out.y = 0;
    if (!this._enabled) return out;
    let x = (this._anyKey(MOVE_KEYS.right) ? 1 : 0) - (this._anyKey(MOVE_KEYS.left) ? 1 : 0);
    let y = (this._anyKey(MOVE_KEYS.forward) ? 1 : 0) - (this._anyKey(MOVE_KEYS.back) ? 1 : 0);
    x += this._stick.x;
    y += this._stick.y;
    const len = Math.hypot(x, y);
    if (len > 1) {
      x /= len;
      y /= len;
    }
    out.x = x;
    out.y = y;
    return out;
  }

  /**
   * Is a held action currently down? "sprint" | "crouch" (Ctrl hold) |
   * "interact" | "bite" | "aim". Touch latches (sprint/aim) count as held.
   * @param {string} action
   */
  isDown(action) {
    if (!this._enabled) return false;
    const keys = HELD_KEYS[action];
    if (keys && this._anyKey(keys)) return true;
    // Mouse bits are only set while the mouse drives gameplay (see _onMouseDown).
    if (action === "bite" && this._mouse & MOUSE_LEFT) return true;
    if (action === "aim" && this._mouse & MOUSE_RIGHT) return true;
    if (this._touchCount[action] > 0) return true;
    return this._latch[action] === true;
  }

  /**
   * Was the action pressed since the last endFrame()? Key repeat is ignored.
   * @param {string} action
   */
  pressed(action) {
    return this._edges.has(action);
  }

  /**
   * Look delta in pixels since the last call (pointer-locked mouse, the
   * mouse drag fallback, or a touch drag on the right half). Shared object.
   * @returns {{ dx: number, dy: number }}
   */
  consumeLook() {
    const out = this._lookOut;
    out.dx = this._lookX;
    out.dy = this._lookY;
    this._lookX = 0;
    this._lookY = 0;
    return out;
  }

  /** Accumulated wheel delta (≈100 per notch, + = zoom out) since the last call. */
  consumeZoom() {
    const z = this._zoom;
    this._zoom = 0;
    return z;
  }

  /** Lock the mouse to the canvas. Must run inside a user gesture (click/key). */
  requestPointerLock() {
    if (this.isTouch || !this._enabled || !this._lockSupported || this.pointerLocked) return;
    try {
      const r = this.canvas.requestPointerLock();
      // Chrome returns a promise that rejects if the user just pressed Esc
      // (~1 s cooldown) — swallow it; the next click retries.
      if (r && typeof r.catch === "function") r.catch(() => (this._lockFailed = true));
    } catch {
      this._lockFailed = true;
    }
  }

  /** Release pointer lock without it being treated as a pause request. */
  exitPointerLock() {
    if (typeof document === "undefined" || document.pointerLockElement !== this.canvas) return;
    this._expectUnlock = true;
    document.exitPointerLock?.();
  }

  /** Clear the one-frame edge state. Call once at the end of every frame. */
  endFrame() {
    this._edges.clear();
  }

  /**
   * [hunter] Swap the touch button set: "dino" (survival) or "hunter".
   * @param {"dino"|"hunter"} mode
   */
  setMode(mode) {
    const next = mode === "hunter" ? "hunter" : "dino";
    if (next === this.mode) return;
    this.mode = next;
    this._latch.sprint = false;
    this._latch.aim = false;
    if (this.touchRoot) this._buildButtons();
  }

  /**
   * Visual "on" state of a touch button (e.g. crouch toggled, resting).
   * No-op on desktop. Touches the DOM only when the state changes.
   */
  setActive(action, on) {
    const b = this._buttons.get(action);
    if (!b || b.active === !!on) return;
    b.active = !!on;
    b.el.classList.toggle("touch-btn--active", b.active);
    b.el.setAttribute("aria-pressed", b.active ? "true" : "false");
  }

  /** Highlight a touch button as contextually useful (food in reach → Eat/Drink glows). */
  setHint(action, on) {
    const b = this._buttons.get(action);
    if (!b || b.hint === !!on) return;
    b.hint = !!on;
    b.el.classList.toggle("touch-btn--hint", b.hint);
  }

  /**
   * Cooldown overlay on a touch button: 0 = ready … 1 = just used.
   * Exposed to CSS as `--cd` plus the `touch-btn--cooldown` class.
   */
  setCooldown(action, frac) {
    const b = this._buttons.get(action);
    if (!b) return;
    const q = Math.max(0, Math.min(1, Math.ceil(frac * 50) / 50));
    if (q === b.cd) return;
    b.cd = q;
    b.el.style.setProperty("--cd", String(q));
    b.el.classList.toggle("touch-btn--cooldown", q > 0);
  }

  /** Remove every listener and the touch DOM. */
  dispose() {
    this._ac?.abort();
    this.exitPointerLock();
    this.touchRoot?.remove();
    this.touchRoot = null;
    this._buttons.clear();
  }

  /* --- Desktop listeners ------------------------------------------------------ */

  _bind() {
    if (typeof window === "undefined") return;
    const opts = (extra = {}) => (this._ac ? { ...extra, signal: this._ac.signal } : extra);
    const canvas = this.canvas;

    window.addEventListener("keydown", (e) => this._onKeyDown(e), opts());
    window.addEventListener("keyup", (e) => this._onKeyUp(e), opts());
    window.addEventListener("blur", () => this._releaseAll(), opts());
    document.addEventListener("visibilitychange", () => document.hidden && this._releaseAll(), opts());

    // Gestures that grant user activation (audio unlock lives in main).
    const gesture = (e) => this._gesture(e);
    for (const type of ["keydown", "mousedown", "pointerup", "touchend", "click"]) {
      window.addEventListener(type, gesture, opts({ capture: true }));
    }

    const noteTouch = (e) => {
      if (e.pointerType && e.pointerType !== "mouse") this._lastTouchTime = performance.now();
    };
    window.addEventListener("pointerdown", noteTouch, opts({ capture: true }));
    window.addEventListener("pointerup", noteTouch, opts({ capture: true }));
    window.addEventListener("mousedown", (e) => this._onMouseDown(e), opts());
    window.addEventListener("mouseup", (e) => this._onMouseUp(e), opts());
    window.addEventListener("mousemove", (e) => this._onMouseMove(e), opts());
    window.addEventListener("wheel", (e) => this._onWheel(e), opts({ passive: false }));

    if (canvas) {
      canvas.addEventListener("contextmenu", (e) => e.preventDefault(), opts());
      // Never let the canvas pan / zoom the page on touch.
      canvas.style.touchAction = "none";
      canvas.addEventListener("touchmove", (e) => e.preventDefault(), opts({ passive: false }));
      canvas.addEventListener("dblclick", (e) => e.preventDefault(), opts());
    }

    document.addEventListener("pointerlockchange", () => this._onLockChange(), opts());
    document.addEventListener("pointerlockerror", () => (this._lockFailed = true), opts());

    // iOS Safari pinch-zoom gestures (non-standard events) — block them while playing.
    for (const type of ["gesturestart", "gesturechange", "gestureend"]) {
      document.addEventListener(type, (e) => this._enabled && e.preventDefault(), opts({ passive: false }));
    }
    // A rotated phone fires pointercancel inconsistently; reset the touch state.
    // Plain resizes (toolbars sliding) only move the idle stick back into view.
    const rotate = () => this._resetTouch();
    window.addEventListener("orientationchange", rotate, opts());
    screen.orientation?.addEventListener?.("change", rotate, opts());
    window.addEventListener("resize", () => this._stick.id === -1 && this._placeStickAtRest(), opts());
  }

  _gesture(e) {
    this.hasGesture = true;
    if (this._gestureDone || typeof this.onFirstGesture !== "function") return;
    // A mousedown counts on desktop; on touch wait for pointerup/touchend,
    // which are the events iOS treats as activation.
    if (e.type === "pointerup" && e.pointerType === "mouse") return;
    if (e.type === "keydown" && e.key === "Escape") return; // Esc never grants activation
    let result;
    try {
      result = this.onFirstGesture(e);
    } catch (err) {
      console.error("[input] onFirstGesture threw", err);
    }
    if (result !== false) this._gestureDone = true;
  }

  _onKeyDown(e) {
    if (e.metaKey) return; // Cmd shortcuts belong to the browser / OS
    if (isFormControl(e.target)) return;
    const code = e.code;
    const isGame = GAME_CODES.has(code);
    if (!this._enabled) {
      // Menus open: only the UI toggles register, and the page keeps its keys.
      if (!e.repeat) this._edgesFor(code, true);
      return;
    }
    if (isGame) e.preventDefault();
    this._keys.add(code);
    if (!e.repeat) this._edgesFor(code, false);
  }

  _onKeyUp(e) {
    // macOS swallows keyups for keys released while Cmd was down.
    if (e.key === "Meta") {
      this._keys.clear();
      return;
    }
    this._keys.delete(e.code);
    if (this._enabled && GAME_CODES.has(e.code) && !isFormControl(e.target)) e.preventDefault();
  }

  _edgesFor(code, uiOnly) {
    const list = EDGE_KEYS[code];
    if (!list) return;
    for (const a of list) {
      if (uiOnly && !UI_EDGES.has(a)) continue;
      if (a === "pause") this._pauseEdge();
      else this._edges.add(a);
      if (a === "weapon1" || a === "weapon2") this._lastWeapon = a;
    }
  }

  _pauseEdge() {
    const now = performance.now();
    if (now - this._lastPauseTime < PAUSE_DEDUPE_MS) return;
    this._lastPauseTime = now;
    this._edges.add("pause");
  }

  /** Mouse events over the game surface (canvas or the bare UI root) are ours. */
  _isGameSurface(target) {
    return target === this.canvas || (this.uiRoot && target === this.uiRoot) || this.pointerLocked;
  }

  /** Mouse events synthesised from a recent touch are noise, not a mouse. */
  _isCompatMouse() {
    return performance.now() - this._lastTouchTime < TOUCH_MOUSE_GUARD_MS;
  }

  _onMouseDown(e) {
    if (!this._enabled || this._isCompatMouse() || !this._isGameSurface(e.target)) return;
    // Back/forward thumb buttons would navigate away mid-hunt.
    if (e.button === 3 || e.button === 4) {
      e.preventDefault();
      return;
    }
    if (this.pointerLocked) {
      if (e.button === 0) this._pressMouse(MOUSE_LEFT, "bite");
      else if (e.button === 2) this._pressMouse(MOUSE_RIGHT, "aim");
      return;
    }
    // Not locked: this click (re)captures the mouse. Chrome refuses a lock
    // for ~1 s after Esc, so every click retries. Until a lock lands, a drag
    // looks around; once a lock attempt has failed (or locking is impossible,
    // e.g. iPad / sandboxed iframe) clicks also act: LMB click = bite, RMB = aim.
    const canLock = this._lockSupported && !this.isTouch;
    const acts = !canLock || this._lockFailed;
    if (canLock) this.requestPointerLock();
    e.preventDefault(); // a drag-look must not start a text selection across the HUD
    const d = this._drag;
    d.active = true;
    d.button = e.button;
    d.x = e.clientX;
    d.y = e.clientY;
    d.moved = 0;
    d.acts = acts;
    if (acts && e.button === 2) this._pressMouse(MOUSE_RIGHT, "aim");
  }

  _pressMouse(bit, action) {
    this._mouse |= bit;
    this._edges.add(action);
  }

  _onMouseUp(e) {
    if (e.button === 3 || e.button === 4) {
      if (this._enabled) e.preventDefault();
      return;
    }
    const d = this._drag;
    if (d.active && e.button === d.button) {
      if (d.acts && e.button === 0 && d.moved < CLICK_SLOP && this._enabled) this._edges.add("bite");
      d.active = false;
    }
    if (e.button === 0) this._mouse &= ~MOUSE_LEFT;
    else if (e.button === 2) this._mouse &= ~MOUSE_RIGHT;
  }

  _onMouseMove(e) {
    if (!this._enabled) return;
    if (this.pointerLocked) {
      // The first event after locking can carry a huge bogus jump (Chrome).
      if (this._skipLockedMoves > 0) {
        this._skipLockedMoves--;
        return;
      }
      const mx = e.movementX || 0;
      const my = e.movementY || 0;
      if (Math.abs(mx) > LOCKED_SPIKE_PX || Math.abs(my) > LOCKED_SPIKE_PX) return;
      this._lookX += mx;
      this._lookY += my;
      return;
    }
    const d = this._drag;
    if (!d.active || this._isCompatMouse()) return;
    const dx = e.clientX - d.x;
    const dy = e.clientY - d.y;
    d.x = e.clientX;
    d.y = e.clientY;
    d.moved += Math.abs(dx) + Math.abs(dy);
    this._lookX += dx;
    this._lookY += dy;
  }

  _onWheel(e) {
    if (!this._enabled || !this._isGameSurface(e.target)) return;
    e.preventDefault();
    // Normalise line / page deltas (Firefox) to pixels.
    const scale = e.deltaMode === 1 ? 16 : e.deltaMode === 2 ? 100 : 1;
    // Trackpads stream many tiny deltas; clamp single events so one flick
    // can't slam the zoom from end to end.
    this._zoom += Math.max(-240, Math.min(240, e.deltaY * scale));
  }

  _onLockChange() {
    const locked = typeof document !== "undefined" && document.pointerLockElement === this.canvas;
    if (locked === this.pointerLocked) return;
    this.pointerLocked = locked;
    if (locked) {
      this._lockFailed = false;
      this._skipLockedMoves = 1;
      return;
    }
    this._mouse = 0;
    this._drag.active = false;
    // Esc while locked is eaten by the browser to release the mouse (it
    // usually never reaches keydown). An unexpected unlock while playing
    // therefore means "pause" — one press, like every desktop game.
    if (this._enabled && !this._expectUnlock) this._pauseEdge();
    this._expectUnlock = false;
  }

  _anyKey(codes) {
    for (let i = 0; i < codes.length; i++) if (this._keys.has(codes[i])) return true;
    return false;
  }

  /** Drop every held input (focus loss, menus) so nothing stays stuck down. */
  _releaseAll() {
    this._keys.clear();
    this._mouse = 0;
    this._drag.active = false;
    this._lookX = 0;
    this._lookY = 0;
    this._zoom = 0;
    this._resetTouch(true);
  }

  /* --- Touch controls ----------------------------------------------------------- */

  _buildTouch() {
    if (typeof document === "undefined") return;
    if (!document.getElementById(STYLE_ID)) {
      const style = document.createElement("style");
      style.id = STYLE_ID;
      style.textContent = BASE_CSS;
      // Prepend so style.css (loaded in <head> already, or later) wins ties.
      document.head.prepend(style);
    }

    const root = document.createElement("div");
    root.className = "touch";
    root.dataset.mode = this.mode;
    // Functional, not cosmetic: without these iOS would pan/zoom/select.
    root.style.touchAction = "none";
    root.style.webkitUserSelect = "none";
    root.style.userSelect = "none";

    const move = document.createElement("div");
    move.className = "touch-zone touch-zone--move";
    const look = document.createElement("div");
    look.className = "touch-zone touch-zone--look";

    const stick = document.createElement("div");
    stick.className = "touch-stick touch-stick--idle";
    stick.setAttribute("aria-hidden", "true");
    const knob = document.createElement("div");
    knob.className = "touch-stick__knob";
    stick.appendChild(knob);

    root.append(move, look, stick);
    this.uiRoot.appendChild(root);
    this.touchRoot = root;
    this._zoneMove = move;
    this._zoneLook = look;
    this._stickEl = stick;
    this._knobEl = knob;
    this._placeStickAtRest();
    this._buildButtons();
    if (!this._enabled) root.style.display = "none";

    const opts = (extra = {}) => (this._ac ? { ...extra, signal: this._ac.signal } : extra);
    move.addEventListener("pointerdown", (e) => this._stickDown(e), opts());
    move.addEventListener("pointermove", (e) => this._stickMove(e), opts());
    for (const t of ["pointerup", "pointercancel", "lostpointercapture"]) {
      move.addEventListener(t, (e) => this._stickUp(e), opts());
    }
    look.addEventListener("pointerdown", (e) => this._lookDown(e), opts());
    look.addEventListener("pointermove", (e) => this._lookMove(e), opts());
    for (const t of ["pointerup", "pointercancel", "lostpointercapture"]) {
      look.addEventListener(t, (e) => this._lookUp(e), opts());
    }
    // iOS: no page bounce, no double-tap zoom, no long-press callout/selection.
    root.addEventListener("touchstart", (e) => e.cancelable && e.preventDefault(), opts({ passive: false }));
    root.addEventListener("touchmove", (e) => e.cancelable && e.preventDefault(), opts({ passive: false }));
    root.addEventListener("dblclick", (e) => e.preventDefault(), opts());
    root.addEventListener("contextmenu", (e) => e.preventDefault(), opts());
    root.addEventListener("selectstart", (e) => e.preventDefault(), opts());
  }

  _buildButtons() {
    const root = this.touchRoot;
    for (const b of this._buttons.values()) b.el.remove();
    this._buttons.clear();
    this._releaseButtons();
    root.dataset.mode = this.mode;
    const opts = this._ac ? { signal: this._ac.signal } : undefined;
    for (const def of BUTTON_SETS[this.mode]) {
      const el = document.createElement("button");
      el.type = "button";
      el.className = "touch-btn";
      el.dataset.action = def.action;
      el.dataset.slot = def.slot;
      el.dataset.kind = def.kind;
      el.setAttribute("aria-label", def.label);
      if (def.kind === "latch" || def.action === "crouch" || def.action === "rest") el.setAttribute("aria-pressed", "false");
      el.innerHTML =
        `<svg viewBox="0 0 24 24" aria-hidden="true" focusable="false">${ICONS[def.icon]}</svg>` +
        `<span class="touch-btn__label" aria-hidden="true">${def.short || def.label}</span>`;
      el.addEventListener("pointerdown", (e) => this._btnDown(e, def, el), opts);
      for (const t of ["pointerup", "pointercancel", "lostpointercapture"]) {
        el.addEventListener(t, (e) => this._btnUp(e), opts);
      }
      // Keyboard / switch-access activation still works (Enter/Space on a focused button).
      el.addEventListener("click", (e) => {
        if (e.detail === 0) this._tapAction(def);
      }, opts);
      root.appendChild(el);
      this._buttons.set(def.action, { el, active: false, hint: false, cd: 0 });
    }
  }

  _btnDown(e, def, el) {
    if (!this._enabled) return;
    e.preventDefault();
    e.stopPropagation();
    try {
      el.setPointerCapture(e.pointerId);
    } catch {
      /* capture is best-effort (synthetic events can't be captured) */
    }
    if (this._btnPointers.has(e.pointerId)) return;
    this._btnPointers.set(e.pointerId, { action: def.action, el, kind: def.kind });
    el.classList.add("touch-btn--held");
    if (def.kind === "hold") this._touchCount[def.action] = (this._touchCount[def.action] || 0) + 1;
    this._tapAction(def);
  }

  _tapAction(def) {
    if (!this._enabled) return;
    const a = def.action;
    if (def.kind === "latch") {
      this._latch[a] = !this._latch[a];
      this.setActive(a, this._latch[a]);
      if (a === "aim") this._edges.add("aim");
      return;
    }
    if (a === "swap") {
      // The hunter controller listens for weapon1 / weapon2; alternate them.
      const next = this._lastWeapon === "weapon1" ? "weapon2" : "weapon1";
      this._lastWeapon = next;
      this._edges.add(next);
      this._edges.add("swap");
      return;
    }
    this._edges.add(a);
    if (a === "sniff") this._edges.add("reload"); // mirrors the R key
  }

  _btnUp(e) {
    const rec = this._btnPointers.get(e.pointerId);
    if (!rec) return;
    this._btnPointers.delete(e.pointerId);
    rec.el.classList.remove("touch-btn--held");
    if (rec.kind === "hold") this._touchCount[rec.action] = Math.max(0, (this._touchCount[rec.action] || 0) - 1);
  }

  _releaseButtons() {
    for (const rec of this._btnPointers.values()) rec.el.classList.remove("touch-btn--held");
    this._btnPointers.clear();
    for (const k in this._touchCount) this._touchCount[k] = 0;
  }

  /** Measure the stick radius from CSS so the knob travel matches the art. */
  _stickRadius() {
    const w = this._stickEl?.offsetWidth || 0;
    return w > 20 ? w / 2 : STICK_FALLBACK_RADIUS;
  }

  _placeStickAtRest() {
    if (!this._stickEl || !this.touchRoot) return;
    const r = this._stickRadius();
    const h = this.touchRoot.clientHeight || window.innerHeight || 600;
    // Resting spot hints where the thumb goes; it jumps to the thumb on touch.
    this._stickEl.style.left = `${Math.round(r + 34)}px`;
    this._stickEl.style.top = `${Math.round(h - r - 40)}px`;
    this._knobEl.style.transform = "";
  }

  _stickDown(e) {
    if (!this._enabled || this._stick.id !== -1) return;
    e.preventDefault();
    try {
      e.currentTarget.setPointerCapture(e.pointerId);
    } catch {
      /* best-effort */
    }
    // The layer can't move mid-drag, so measure it once per touch.
    const rect = this.touchRoot.getBoundingClientRect();
    this._rootLeft = rect.left;
    this._rootTop = rect.top;
    const s = this._stick;
    s.radius = this._stickRadius();
    s.id = e.pointerId;
    // Keep the whole base on screen even for a thumb at the very edge.
    s.cx = Math.max(s.radius, Math.min(rect.width - s.radius, e.clientX - rect.left));
    s.cy = Math.max(s.radius, Math.min(rect.height - s.radius, e.clientY - rect.top));
    s.x = 0;
    s.y = 0;
    this._stickEl.classList.remove("touch-stick--idle");
    this._stickEl.classList.add("touch-stick--active");
    this._stickEl.style.left = `${s.cx}px`;
    this._stickEl.style.top = `${s.cy}px`;
    this._stickMove(e);
  }

  _stickMove(e) {
    const s = this._stick;
    if (e.pointerId !== s.id) return;
    const px = e.clientX - this._rootLeft;
    const py = e.clientY - this._rootTop;
    let dx = px - s.cx;
    let dy = py - s.cy;
    let len = Math.hypot(dx, dy);
    if (len > s.radius) {
      // Floating stick: drag the base along so reversing is instant.
      const over = len - s.radius;
      s.cx += (dx / len) * over;
      s.cy += (dy / len) * over;
      this._stickEl.style.left = `${s.cx}px`;
      this._stickEl.style.top = `${s.cy}px`;
      dx = px - s.cx;
      dy = py - s.cy;
      len = s.radius;
    }
    this._knobEl.style.transform = `translate(${dx.toFixed(1)}px, ${dy.toFixed(1)}px)`;
    const mag = len / s.radius;
    if (mag < STICK_DEAD_ZONE) {
      s.x = 0;
      s.y = 0;
      return;
    }
    // Re-map past the dead zone so small deflections still give a slow walk.
    const k = (mag - STICK_DEAD_ZONE) / (1 - STICK_DEAD_ZONE) / mag;
    s.x = (dx / s.radius) * k;
    s.y = (-dy / s.radius) * k;
  }

  _stickUp(e) {
    if (e.pointerId !== this._stick.id) return;
    this._releaseStick();
  }

  _releaseStick() {
    const s = this._stick;
    s.id = -1;
    s.x = 0;
    s.y = 0;
    // Letting go of the stick ends a sprint latch (tap-to-sprint, release to stop).
    if (this._latch.sprint) {
      this._latch.sprint = false;
      this.setActive("sprint", false);
    }
    if (this._stickEl) {
      this._stickEl.classList.remove("touch-stick--active");
      this._stickEl.classList.add("touch-stick--idle");
      this._placeStickAtRest();
    }
  }

  _lookDown(e) {
    if (!this._enabled || this._look.id !== -1) return;
    e.preventDefault();
    try {
      e.currentTarget.setPointerCapture(e.pointerId);
    } catch {
      /* best-effort */
    }
    this._look.id = e.pointerId;
    this._look.x = e.clientX;
    this._look.y = e.clientY;
  }

  _lookMove(e) {
    const l = this._look;
    if (e.pointerId !== l.id || !this._enabled) return;
    this._lookX += (e.clientX - l.x) * TOUCH_LOOK_SCALE;
    this._lookY += (e.clientY - l.y) * TOUCH_LOOK_SCALE;
    l.x = e.clientX;
    l.y = e.clientY;
  }

  _lookUp(e) {
    if (e.pointerId === this._look.id) this._look.id = -1;
  }

  /** Release stick, look and buttons (orientation change, menus, focus loss). */
  _resetTouch(all = false) {
    if (!this.touchRoot) return;
    this._releaseStick();
    this._look.id = -1;
    this._releaseButtons();
    if (all) {
      this._latch.sprint = false;
      this._latch.aim = false;
      this.setActive("sprint", false);
      this.setActive("aim", false);
    }
  }
}
