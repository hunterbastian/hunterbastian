// ember — a very small game about a small light and a moth.
//
// No build step and no dependencies. Everything is drawn on one canvas at a
// fixed logical size (480 × 420) and scaled to fit the window, so all of the
// layout math below is in those logical pixels.

/* ----------------------------------------------------------------------- */
/* Constants & helpers                                                     */
/* ----------------------------------------------------------------------- */
const W = 480;
const H = 420;
const TAU = Math.PI * 2;
const STEP = 1000 / 60;

const C = {
  bg: "#0b0b0c",
  ink: "#ecebe6",
  dim: "#7a7872",
  faint: "#2c2b29",
  ember: "#ffb35c",
  core: "#fff1dc",
};
const EMBER_RGB = "255, 179, 92";
const FONT = '"IBM Plex Mono", ui-monospace, SFMono-Regular, Menlo, Consolas, monospace';
const REDUCED = window.matchMedia?.("(prefers-reduced-motion: reduce)").matches ?? false;

const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));
const lerp = (a, b, t) => a + (b - a) * t;
const rand = (lo, hi) => lo + Math.random() * (hi - lo);
const ease = (t) => 1 - Math.pow(1 - clamp(t, 0, 1), 3);

const storage = {
  get(key) {
    try { return localStorage.getItem(key); } catch { return null; }
  },
  set(key, value) {
    try { localStorage.setItem(key, value); } catch { /* private mode etc. */ }
  },
};

/* ----------------------------------------------------------------------- */
/* Canvas                                                                  */
/* ----------------------------------------------------------------------- */
const canvas = document.getElementById("game");
const ctx = canvas.getContext("2d");
const live = document.getElementById("live");

function resize() {
  const dpr = Math.min(window.devicePixelRatio || 1, 2);
  const scale = clamp(Math.min((window.innerWidth - 16) / W, (window.innerHeight - 16) / H), 0.4, 2);
  const cw = Math.round(W * scale);
  const ch = Math.round(H * scale);
  canvas.style.width = `${cw}px`;
  canvas.style.height = `${ch}px`;
  canvas.width = Math.round(cw * dpr);
  canvas.height = Math.round(ch * dpr);
}
window.addEventListener("resize", resize);
resize();

function toLogical(e) {
  const r = canvas.getBoundingClientRect();
  return { x: ((e.clientX - r.left) / r.width) * W, y: ((e.clientY - r.top) / r.height) * H };
}

// Mirror on-screen text into a live region so screen readers can follow along.
let lastSaid = "";
function say(msg) {
  if (!msg || msg === lastSaid) return;
  lastSaid = msg;
  live.textContent = msg;
}

/* ----------------------------------------------------------------------- */
/* Sound — tiny synthesized blips, created on the first key press or tap.  */
/* ----------------------------------------------------------------------- */
let audio = null;
let muted = storage.get("ember:muted") === "1";

function ensureAudio() {
  if (!audio) {
    const AC = window.AudioContext || window.webkitAudioContext;
    if (!AC) return;
    audio = new AC();
  }
  if (audio.state === "suspended") audio.resume();
}

function tone(freq, dur = 0.06, { type = "square", vol = 0.03, slide = 0, delay = 0 } = {}) {
  if (!audio || muted) return;
  const t0 = audio.currentTime + delay;
  const osc = audio.createOscillator();
  const gain = audio.createGain();
  osc.type = type;
  osc.frequency.setValueAtTime(freq, t0);
  if (slide) osc.frequency.exponentialRampToValueAtTime(Math.max(40, freq + slide), t0 + dur);
  gain.gain.setValueAtTime(0.0001, t0);
  gain.gain.exponentialRampToValueAtTime(vol, t0 + 0.006);
  gain.gain.exponentialRampToValueAtTime(0.0001, t0 + dur);
  osc.connect(gain).connect(audio.destination);
  osc.start(t0);
  osc.stop(t0 + dur + 0.02);
}

function noise(dur = 0.12, vol = 0.05) {
  if (!audio || muted) return;
  const len = Math.floor(audio.sampleRate * dur);
  const buf = audio.createBuffer(1, len, audio.sampleRate);
  const data = buf.getChannelData(0);
  for (let i = 0; i < len; i++) data[i] = (Math.random() * 2 - 1) * (1 - i / len);
  const src = audio.createBufferSource();
  const gain = audio.createGain();
  gain.gain.value = vol;
  src.buffer = buf;
  src.connect(gain).connect(audio.destination);
  src.start();
}

const chord = (notes, gap, opts) => notes.forEach((f, i) => tone(f, 0.12, { ...opts, delay: i * gap }));

const sfx = {
  narrator: () => tone(rand(300, 318), 0.035, { type: "triangle", vol: 0.06 }),
  moth: () => tone(rand(820, 1000), 0.03, { type: "sine", vol: 0.05 }),
  move: () => tone(520, 0.03, { vol: 0.015 }),
  select: () => chord([660, 990], 0.04, { vol: 0.018 }),
  back: () => tone(392, 0.05, { vol: 0.015 }),
  nope: () => tone(150, 0.14, { type: "triangle", vol: 0.06 }),
  hurt: () => { noise(0.1, 0.06); tone(190, 0.15, { vol: 0.03, slide: -110 }); },
  slash: () => tone(1500, 0.14, { type: "sawtooth", vol: 0.012, slide: -1200 }),
  hit: () => { noise(0.18, 0.08); tone(230, 0.2, { vol: 0.025, slide: -150 }); },
  heal: () => chord([523, 659, 784], 0.07, { type: "triangle", vol: 0.04 }),
  calm: () => chord([784, 988, 1175], 0.09, { type: "sine", vol: 0.035 }),
  out: () => tone(320, 0.7, { type: "triangle", vol: 0.06, slide: -250 }),
  warm: () => chord([392, 494, 587, 784], 0.14, { type: "triangle", vol: 0.04 }),
};

function toggleMute() {
  muted = !muted;
  storage.set("ember:muted", muted ? "1" : "0");
  ensureAudio();
  if (!muted) sfx.select();
  say(muted ? "sound off" : "sound on");
}

/* ----------------------------------------------------------------------- */
/* Input — keyboard, plus taps and drags for touch screens.                */
/* ----------------------------------------------------------------------- */
const KEYS = {
  ArrowUp: "up", KeyW: "up",
  ArrowDown: "down", KeyS: "down",
  ArrowLeft: "left", KeyA: "left",
  ArrowRight: "right", KeyD: "right",
  KeyZ: "confirm", Enter: "confirm", Space: "confirm",
  KeyX: "cancel", ShiftLeft: "cancel", ShiftRight: "cancel", Escape: "cancel", Backspace: "cancel",
  KeyM: "mute",
};
const held = new Set();
const pressed = new Set(); // pressed since the last tick
const taps = []; // pointer-downs since the last tick, in logical coords
const drag = { active: false, lastX: 0, lastY: 0, dx: 0, dy: 0 };

window.addEventListener("keydown", (e) => {
  if (e.metaKey || e.ctrlKey || e.altKey) return;
  const action = KEYS[e.code];
  if (!action) return;
  e.preventDefault();
  ensureAudio();
  if (!e.repeat) pressed.add(action);
  held.add(action);
});
window.addEventListener("keyup", (e) => {
  const action = KEYS[e.code];
  if (action) held.delete(action);
});
window.addEventListener("blur", () => held.clear());

canvas.addEventListener("pointerdown", (e) => {
  ensureAudio();
  const p = toLogical(e);
  taps.push(p);
  drag.active = true;
  drag.lastX = p.x;
  drag.lastY = p.y;
  canvas.setPointerCapture?.(e.pointerId);
  e.preventDefault();
});
canvas.addEventListener("pointermove", (e) => {
  if (!drag.active) return;
  const p = toLogical(e);
  drag.dx += p.x - drag.lastX;
  drag.dy += p.y - drag.lastY;
  drag.lastX = p.x;
  drag.lastY = p.y;
});
const endDrag = () => { drag.active = false; };
canvas.addEventListener("pointerup", endDrag);
canvas.addEventListener("pointercancel", endDrag);

const confirmed = () => pressed.has("confirm") || taps.length > 0;

/* ----------------------------------------------------------------------- */
/* Text                                                                    */
/* ----------------------------------------------------------------------- */
function setFont(size, weight = 400) {
  ctx.font = `${weight} ${size}px ${FONT}`;
}

function text(str, x, y, { size = 16, color = C.ink, align = "left", weight = 400, alpha = 1, base = "top", spacing = 0 } = {}) {
  setFont(size, weight);
  ctx.fillStyle = color;
  ctx.globalAlpha = alpha;
  ctx.textAlign = align;
  ctx.textBaseline = base;
  if (spacing && "letterSpacing" in ctx) ctx.letterSpacing = `${spacing}px`;
  ctx.fillText(str, x, y);
  if (spacing && "letterSpacing" in ctx) ctx.letterSpacing = "0px";
  ctx.globalAlpha = 1;
  ctx.textAlign = "left";
  ctx.textBaseline = "top";
}

const wrapCache = new Map();
function wrap(str, maxW) {
  const key = `${ctx.font}|${maxW}|${str}`;
  let lines = wrapCache.get(key);
  if (lines) return lines;
  lines = [];
  for (const para of str.split("\n")) {
    let line = "";
    for (const word of para.split(" ")) {
      const test = line ? `${line} ${word}` : word;
      if (line && ctx.measureText(test).width > maxW) {
        lines.push(line);
        line = word;
      } else {
        line = test;
      }
    }
    lines.push(line);
  }
  if (wrapCache.size > 500) wrapCache.clear();
  wrapCache.set(key, lines);
  return lines;
}
document.fonts?.addEventListener?.("loadingdone", () => wrapCache.clear());

// Draw `str` wrapped to `maxW`, revealing only the first `n` characters.
// Returns the number of wrapped lines the full string takes up.
function drawTyped(str, n, x, y, maxW, lh, align = "left") {
  const lines = wrap(str, maxW);
  let left = n;
  ctx.textAlign = "left";
  lines.forEach((ln, i) => {
    if (left <= 0) return;
    const lx = align === "center" ? x - ctx.measureText(ln).width / 2 : x;
    ctx.fillText(ln.slice(0, left), lx, y + i * lh);
    left -= ln.length + 1; // +1 for the space or newline the wrap swallowed
  });
  return lines.length;
}

// A typewriter for one or more lines. Confirm finishes the current line,
// then moves to the next; `onDone` fires after the last one.
class Typer {
  constructor(lines, { voice = "narrator", onDone = null, auto = 0 } = {}) {
    this.lines = Array.isArray(lines) ? lines : [lines];
    this.voice = voice;
    this.onDone = onDone;
    this.auto = auto; // ticks to wait before advancing on its own (0 = never)
    this.i = 0;
    this.n = 0;
    this.acc = 0;
    this.wait = 0;
    this.done = false;
    say(this.text);
  }
  get text() { return this.lines[this.i]; }
  get full() { return this.n >= this.text.length; }
  update() {
    if (this.done) return;
    if (this.full) {
      if (this.auto && ++this.wait >= this.auto) this.advance();
      return;
    }
    this.acc += 0.8;
    while (this.acc >= 1 && !this.full) {
      this.acc -= 1;
      const ch = this.text[this.n++];
      if (".,?!".includes(ch) && !this.full) this.acc -= 5; // let punctuation breathe
      if (ch !== " " && this.n % 2 === 1) sfx[this.voice]?.();
    }
  }
  advance() {
    if (this.done) return;
    if (!this.full) {
      this.n = this.text.length;
      return;
    }
    if (this.i < this.lines.length - 1) {
      this.i++;
      this.n = 0;
      this.acc = 0;
      this.wait = 0;
      say(this.text);
      return;
    }
    this.done = true;
    this.onDone?.();
  }
}

/* ----------------------------------------------------------------------- */
/* Game state                                                              */
/* ----------------------------------------------------------------------- */
const MENU = ["strike", "talk", "mend", "part"];
const ACTS = ["check", "dim", "hum", "hold still"];
const MENU_BOX = { x: 20, y: 186, w: 440, h: 118 };
const ARENA_CY = 240;
const HUD_Y = 338;
const OPT_Y = 386;

function loadEndings() {
  try {
    return { warm: false, cold: false, ...JSON.parse(storage.get("ember:endings") || "{}") };
  } catch {
    return { warm: false, cold: false };
  }
}

const G = {
  scene: "title",
  t: 0,
  sceneT: 0,
  fade: 0,
  shake: 0,
  hp: 20,
  maxHp: 20,
  mends: 3,
  dimmed: 0,
  moth: null,
  phase: "menu",
  menu: 0,
  act: 0,
  turn: 0,
  lastAct: null,
  dialog: null,
  bubble: null,
  box: { ...MENU_BOX },
  boxTarget: { ...MENU_BOX },
  player: { x: 240, y: ARENA_CY, inv: 0 },
  bullets: [],
  pattern: null,
  patT: 0,
  k: 1,
  ps: {}, // per-pattern scratch state
  strike: null,
  slash: null,
  floaters: [],
  particles: [],
  motes: [],
  ending: null,
  endReady: false,
  overReady: false,
  overAt: null,
  introT: 0,
  endings: loadEndings(),
};
window.ember = G; // handy for poking at from the console (and for the smoke test)

function newMoth() {
  return {
    hp: 60, max: 60, shown: 60,
    calm: 0, struck: 0, dims: 0, hums: 0,
    x: 240, y: 90, phase: 0,
    shake: 0, flash: 0, barT: 0,
    dead: false, alpha: 1,
  };
}
G.moth = newMoth();

function setScene(name) {
  G.scene = name;
  G.sceneT = 0;
}

for (let i = 0; i < 26; i++) {
  G.motes.push({ x: rand(0, W), y: rand(0, H), v: rand(0.04, 0.18), ph: rand(0, TAU), a: rand(0.1, 0.32), s: rand(0.8, 1.6) });
}

/* ----------------------------------------------------------------------- */
/* Title & intro                                                           */
/* ----------------------------------------------------------------------- */
function startTitle() {
  setScene("title");
  G.dialog = null;
  G.fade = 1;
  say("ember. a very small game. press z or tap to begin.");
}

function updateTitle() {
  if (G.sceneT > 10 && confirmed()) {
    sfx.select();
    startIntro();
  }
}

function startIntro() {
  setScene("intro");
  G.introT = 0;
  G.dialog = new Typer(
    ["the path ahead is dark.", "you are a small light.", "something is fluttering toward you."],
    { onDone: startBattle },
  );
}

function updateIntro() {
  G.dialog.update();
  if (G.dialog.i === 2) G.introT++;
  if (confirmed()) G.dialog.advance();
}

/* ----------------------------------------------------------------------- */
/* Battle                                                                  */
/* ----------------------------------------------------------------------- */
function startBattle() {
  setScene("battle");
  Object.assign(G, {
    hp: G.maxHp, mends: 3, dimmed: 0, turn: 0, menu: 0, act: 0, lastAct: null,
    moth: newMoth(), bullets: [], floaters: [], particles: [],
    bubble: null, strike: null, slash: null, pattern: null,
    box: { ...MENU_BOX }, boxTarget: { ...MENU_BOX }, fade: 1,
  });
  toMenu("a moth flutters out of the dark. it's drawn to your light.");
}

function toMenu(flavor) {
  G.phase = "menu";
  G.boxTarget = { ...MENU_BOX };
  G.dialog = new Typer(flavor);
}

function updateBattle() {
  updateMoth(G.moth);
  tweenBox();
  if (G.slash && ++G.slash.t > 26) G.slash = null;
  switch (G.phase) {
    case "menu": G.dialog?.update(); return updateMenu();
    case "talk": return updateTalk();
    case "strike": return updateStrike();
    case "result": G.dialog?.update(); return updateResult();
    case "enemy": return updateEnemy();
    case "dodge": return updateDodge();
  }
}

function tweenBox() {
  const b = G.box;
  const t = G.boxTarget;
  for (const k of ["x", "y", "w", "h"]) {
    b[k] = lerp(b[k], t[k], 0.2);
    if (Math.abs(b[k] - t[k]) < 0.5) b[k] = t[k];
  }
}
const boxSettled = () => ["x", "y", "w", "h"].every((k) => G.box[k] === G.boxTarget[k]);

const optionRect = (i) => ({ x: 20 + i * 110, y: OPT_Y - 20, w: 110, h: 40 });
function optionAt(p) {
  for (let i = 0; i < MENU.length; i++) {
    const r = optionRect(i);
    if (p.x >= r.x && p.x < r.x + r.w && p.y >= r.y && p.y < r.y + r.h) return i;
  }
  return -1;
}
const menuLabel = (i) => (i === 2 ? `mend, ${G.mends} left` : MENU[i]);

function updateMenu() {
  if (pressed.has("left") || pressed.has("right")) {
    G.menu = (G.menu + (pressed.has("left") ? 3 : 1)) % MENU.length;
    sfx.move();
    say(menuLabel(G.menu));
  }
  if (pressed.has("confirm")) return choose(G.menu);
  for (const p of taps) {
    const i = optionAt(p);
    if (i >= 0) {
      G.menu = i;
      return choose(i);
    }
    if (G.dialog && !G.dialog.full) G.dialog.n = G.dialog.text.length;
  }
}

function choose(i) {
  if (i === 0) {
    sfx.select();
    G.phase = "strike";
    G.strike = { x: 0, stopped: false, hold: 0, acc: 0, dmg: 0 };
    say("strike. press z or tap as the line crosses the center.");
  } else if (i === 1) {
    sfx.select();
    G.phase = "talk";
    G.act = 0;
    say(`talk. ${ACTS.join(", ")}.`);
  } else if (i === 2) {
    mend();
  } else {
    part();
  }
}

function result(lines, after = enemyTurn) {
  G.phase = "result";
  G.dialog = new Typer(lines, { onDone: after });
}

function updateResult() {
  if (confirmed()) G.dialog.advance();
}

/* --- talk ---------------------------------------------------------------- */
function actRect(i) {
  const col = i % 2;
  const row = i >> 1;
  return { x: MENU_BOX.x + 52 + col * 200, y: MENU_BOX.y + 28 + row * 40 };
}
function actAt(p) {
  for (let i = 0; i < ACTS.length; i++) {
    const r = actRect(i);
    if (p.x >= r.x - 30 && p.x < r.x + 170 && p.y >= r.y - 10 && p.y < r.y + 30) return i;
  }
  return -1;
}
function actSpent(i) {
  const m = G.moth;
  return (i === 1 && m.dims >= 2) || (i === 2 && m.hums >= 2);
}

function updateTalk() {
  if (pressed.has("cancel")) {
    sfx.back();
    G.phase = "menu";
    return;
  }
  const col = G.act % 2;
  const row = G.act >> 1;
  let next = G.act;
  if (pressed.has("left") || pressed.has("right")) next = row * 2 + (1 - col);
  if (pressed.has("up") || pressed.has("down")) next = (1 - row) * 2 + col;
  if (next !== G.act) {
    G.act = next;
    sfx.move();
    say(ACTS[G.act]);
  }
  if (pressed.has("confirm")) return doAct(G.act);
  for (const p of taps) {
    const i = actAt(p);
    if (i >= 0) {
      G.act = i;
      return doAct(i);
    }
    const o = optionAt(p);
    if (o >= 0) {
      G.menu = o;
      G.phase = "menu";
      return choose(o);
    }
  }
}

function doAct(i) {
  sfx.select();
  const m = G.moth;
  const before = m.calm;
  let lines;
  G.lastAct = ACTS[i];
  if (i === 0) {
    lines = ["dusk. a moth, a long way from home.", "it's cold out here. you're the only warm thing for miles."];
  } else if (i === 1) {
    if (m.dims < 2) {
      m.dims++;
      G.dimmed = m.dims;
      m.calm += 25;
      lines = m.dims === 1
        ? ["you dim your glow.", "the moth stops darting around quite so much."]
        : ["you dim yourself even further.", "dusk's wingbeats slow down."];
    } else {
      lines = ["you can't get any dimmer without going out."];
      G.lastAct = null;
    }
  } else if (i === 2) {
    if (m.hums < 2) {
      m.hums++;
      m.calm += 20;
      lines = m.hums === 1
        ? ["you hum something low and slow.", "the moth tilts its head."]
        : ["you hum again.", "dusk hums back. sort of."];
    } else {
      lines = ["you've run out of songs."];
      G.lastAct = null;
    }
  } else if (m.calm >= 50) {
    m.calm += 35;
    lines = ["you hold very still.", "dusk lands beside you, just for a moment."];
  } else {
    m.calm += 5;
    lines = ["you hold very still.", "dusk is too restless to come close."];
    G.lastAct = "still-fail";
  }
  m.calm = Math.min(100, m.calm);
  if (before < 100 && m.calm >= 100) {
    lines.push("dusk doesn't want to fight anymore.");
    sfx.calm();
  }
  result(lines);
}

/* --- mend & part --------------------------------------------------------- */
function mend() {
  if (G.mends <= 0) {
    sfx.nope();
    G.dialog = new Typer("you have nothing left to mend with.");
    return;
  }
  if (G.hp >= G.maxHp) {
    sfx.nope();
    G.dialog = new Typer("you're already burning bright.");
    return;
  }
  const amount = Math.min(10, G.maxHp - G.hp);
  G.hp += amount;
  G.mends--;
  G.lastAct = "mend";
  sfx.heal();
  G.floaters.push({ x: 196, y: HUD_Y - 26, text: `+${amount}`, t: 0, color: C.ember });
  const lines = [`you gather yourself and burn a little brighter. +${amount} hp.`];
  if (G.mends === 0) lines.push("that was the last of it.");
  result(lines);
}

function part() {
  sfx.select();
  if (G.moth.calm >= 100) return startEnding("warm");
  G.lastAct = "part";
  result(["you try to slip away.", "the moth follows your light."]);
}

/* --- strike -------------------------------------------------------------- */
const STRIKE_TICKS = 66;

function updateStrike() {
  const s = G.strike;
  if (!s.stopped) {
    if (pressed.has("cancel") && s.x < 0.25) {
      sfx.back();
      G.phase = "menu";
      G.strike = null;
      return;
    }
    s.x += 1 / STRIKE_TICKS;
    if (confirmed()) {
      s.stopped = true;
      s.acc = 1 - Math.abs(s.x - 0.5) * 2;
    } else if (s.x >= 1) {
      s.x = 1;
      s.stopped = true;
      s.acc = -1;
    }
    if (s.stopped) {
      if (s.acc < 0) sfx.nope();
      else {
        sfx.slash();
        G.slash = { t: 0 };
      }
    }
    return;
  }
  s.hold++;
  if (s.hold === 14 && s.acc >= 0) landStrike(s);
  if (s.hold === 56) strikeResult(s);
}

function landStrike(s) {
  const m = G.moth;
  const crit = s.acc > 0.93;
  s.dmg = crit ? 24 : Math.max(4, Math.round(4 + 16 * Math.pow(s.acc, 1.4)));
  m.hp = Math.max(0, m.hp - s.dmg);
  m.shake = 14;
  m.flash = 10;
  m.barT = 110;
  m.struck++;
  m.calm = Math.max(0, m.calm - 30);
  const { x, y } = mothPose(m);
  G.floaters.push({ x, y: y - 64, text: crit ? `${s.dmg}!` : `${s.dmg}`, t: 0, color: C.ink, size: 22 });
  sfx.hit();
  if (!REDUCED) G.shake = 4;
}

function strikeResult(s) {
  const m = G.moth;
  G.strike = null;
  if (s.acc < 0) {
    G.lastAct = "miss";
    return result(["you swing at the dark and miss."]);
  }
  G.lastAct = "strike";
  if (m.hp <= 0) {
    m.dead = true;
    dissolveMoth();
    return result(["the moth falls.", "its dust glitters for a moment, then goes dark."], () => startEnding("cold"));
  }
  if (m.struck === 1) return result(["you strike the moth.", "it panics."]);
  if (m.hp < m.max * 0.4) return result(["you strike again.", "dusk's wings are torn."]);
  return result(["you strike the moth."]);
}

/* --- the moth's turn ----------------------------------------------------- */
function mothLine() {
  const m = G.moth;
  if (m.calm >= 100) return "...i could sleep here.";
  switch (G.lastAct) {
    case "strike": return ["!!", "why...?", "it stings..."][Math.min(m.struck, 3) - 1];
    case "miss": return "...?";
    case "dim": return m.dims === 1 ? "...where did the light go?" : "...softer now.";
    case "hum": return m.hums === 1 ? "...hm?" : "...hmmm...";
    case "hold still": return "...you're warm.";
    case "still-fail": return "no. no. too close.";
    case "part": return "wait. don't go.";
  }
  const pool = m.calm < 30
    ? ["light. light. light.", "so cold out here...", "closer. closer."]
    : m.calm < 70
      ? ["...are you a lamp?", "...you don't burn.", "i was lost..."]
      : ["...sleepy...", "...it's nice here."];
  return pool[G.turn % pool.length];
}

function flavor() {
  const m = G.moth;
  if (G.hp <= 6) return "your glow flickers.";
  if (m.hp < m.max * 0.4) return "dusk's wings are torn. it keeps flying anyway.";
  const pool = m.calm < 30
    ? ["dusk circles you, frantic.", "dust shimmers where the moth has been.", "the moth can't look away from your glow."]
    : m.calm < 70
      ? ["dusk's wingbeats slow a little.", "the moth hovers, unsure of you."]
      : ["dusk drifts lower. it looks tired.", "the moth's wings barely move now."];
  return pool[G.turn % pool.length];
}

function enemyTurn() {
  const m = G.moth;
  G.turn++;
  G.phase = "enemy";
  G.dialog = null;
  const resting = m.calm >= 100;
  if (!resting) {
    G.pattern = choosePattern();
    const p = PATTERNS[G.pattern];
    const a = { x: 240 - p.w / 2, y: ARENA_CY - p.h / 2, w: p.w, h: p.h };
    G.boxTarget = a;
    G.player = { x: a.x + a.w / 2, y: p.start === "bottom" ? a.y + a.h - 22 : a.y + a.h / 2, inv: 0 };
  }
  G.bubble = new Typer(mothLine(), {
    voice: "moth",
    auto: 80,
    onDone: () => {
      G.bubble = null;
      if (resting) toMenu("dusk is resting. it's ready to part ways.");
      else startDodge();
    },
  });
}

function updateEnemy() {
  G.bubble?.update();
  if (confirmed()) G.bubble?.advance();
}

/* --- dodging ------------------------------------------------------------- */
function intensity() {
  const m = G.moth;
  const calm = clamp(1 - m.calm / 140, 0.35, 1);
  const anger = 1 + Math.min(m.struck, 3) * 0.1;
  const ramp = lerp(0.78, 1, Math.min(G.turn - 1, 4) / 4);
  return calm * anger * ramp;
}

function startDodge() {
  G.phase = "dodge";
  G.k = intensity();
  G.patT = -1; // wait for the box to finish resizing
  G.bullets = [];
  G.ps = {};
  drag.dx = 0;
  drag.dy = 0;
  say("dodge. arrow keys or drag to move.");
}

function updateDodge() {
  const p = PATTERNS[G.pattern];
  const a = G.box;
  const pl = G.player;

  let mx = 0;
  let my = 0;
  if (held.has("left")) mx -= 1;
  if (held.has("right")) mx += 1;
  if (held.has("up")) my -= 1;
  if (held.has("down")) my += 1;
  if (mx && my) {
    mx *= Math.SQRT1_2;
    my *= Math.SQRT1_2;
  }
  const speed = held.has("cancel") ? 1.2 : 2.4; // hold x / shift to move carefully
  pl.x = clamp(pl.x + mx * speed + drag.dx, a.x + 8, a.x + a.w - 8);
  pl.y = clamp(pl.y + my * speed + drag.dy, a.y + 8, a.y + a.h - 8);
  drag.dx = 0;
  drag.dy = 0;
  if (pl.inv > 0) pl.inv--;

  if (G.patT < 0) {
    if (!boxSettled()) return;
    G.patT = 0;
  }
  const t = G.patT++;
  if (t < p.dur) p.update(t, G.boxTarget, G.k);
  updateBullets(G.boxTarget);

  if (pl.inv === 0) {
    for (const b of G.bullets) {
      if (b.fade || b.age < 6) continue;
      const r = b.r * 0.8 + 3;
      if ((b.x - pl.x) ** 2 + (b.y - pl.y) ** 2 < r * r) {
        hurt();
        break;
      }
    }
  }

  if (G.scene === "battle" && t >= p.dur) {
    for (const b of G.bullets) b.fade ||= 1;
    if (t >= p.dur + 24) {
      G.bullets = [];
      toMenu(flavor());
    }
  }
}

function hurt() {
  G.hp = Math.max(0, G.hp - (G.moth.struck >= 2 ? 4 : 3));
  G.player.inv = 50;
  sfx.hurt();
  if (!REDUCED) G.shake = 5;
  if (G.hp <= 0) gameOver();
}

function spawn(x, y, vx, vy, r = 4, extra = {}) {
  const b = { x, y, vx, vy, r, age: 0, fade: 0, kind: "dust", ...extra };
  G.bullets.push(b);
  return b;
}

function updateBullets(a) {
  for (const b of G.bullets) {
    b.age++;
    if (b.step) b.step(b);
    else {
      b.x += b.vx;
      b.y += b.vy;
    }
    if (b.sway) b.x += Math.sin(b.age * 0.06 + b.sway) * b.swayAmp;
    if (b.fade) b.fade++;
    else if (b.life && b.age > b.life) b.fade = 1;
  }
  const m = 160;
  G.bullets = G.bullets.filter((b) =>
    !b.dead && b.fade < 20 &&
    b.x > a.x - m && b.x < a.x + a.w + m && b.y > a.y - m && b.y < a.y + a.h + m);
}

// A point just outside one edge of the arena, at least `minDist` from the player.
function edgePoint(a, minDist) {
  let pt;
  for (let tries = 0; tries < 8; tries++) {
    const side = (Math.random() * 4) | 0;
    pt = side === 0 ? { x: rand(a.x, a.x + a.w), y: a.y - 10 }
      : side === 1 ? { x: a.x + a.w + 10, y: rand(a.y, a.y + a.h) }
        : side === 2 ? { x: rand(a.x, a.x + a.w), y: a.y + a.h + 10 }
          : { x: a.x - 10, y: rand(a.y, a.y + a.h) };
    if (Math.hypot(pt.x - G.player.x, pt.y - G.player.y) >= minDist) break;
  }
  return pt;
}

function homing(b) {
  const p = G.player;
  let heading = Math.atan2(b.vy, b.vx);
  let d = Math.atan2(p.y - b.y, p.x - b.x) - heading;
  d = Math.atan2(Math.sin(d), Math.cos(d));
  heading += clamp(d, -0.03, 0.03);
  b.vx = Math.cos(heading) * b.sp;
  b.vy = Math.sin(heading) * b.sp;
  b.x += b.vx;
  b.y += b.vy;
}

function ringStep(b) {
  b.rad -= b.sp;
  b.ang += b.spin;
  b.x = b.cx + Math.cos(b.ang) * b.rad;
  b.y = b.cy + Math.sin(b.ang) * b.rad;
  if (b.rad < 6) b.dead = true;
}

// Each attack: arena size, length in ticks, and a spawner run once per tick.
// `a` is the arena rect, `k` the intensity (≈0.35 when calm … ≈1.3 when hurt).
const PATTERNS = {
  // Dust shaken loose from the moth's wings drifts down.
  dustfall: {
    w: 200, h: 140, dur: 330,
    update(t, a, k) {
      if (t % Math.max(5, Math.round(8 / k))) return;
      spawn(rand(a.x + 6, a.x + a.w - 6), a.y - 6, 0, rand(1.1, 1.8) * (0.7 + 0.3 * k), rand(3, 4.5), {
        sway: rand(0.1, TAU), swayAmp: rand(0.2, 0.7),
      });
    },
  },
  // Wingbeats push walls of dust sideways. Find the gap.
  gust: {
    w: 280, h: 120, dur: 360,
    update(t, a, k) {
      const every = Math.round(64 / Math.sqrt(k));
      if (t % every) return;
      const fromLeft = Math.round(t / every) % 2 === 0;
      const gapH = 46;
      const gapY = rand(a.y + 10, a.y + a.h - 10 - gapH);
      const vx = (fromLeft ? 1 : -1) * (1.9 + 0.9 * k);
      const x = fromLeft ? a.x - 8 : a.x + a.w + 8;
      for (let y = a.y + 6; y < a.y + a.h; y += 12) {
        if (y > gapY && y < gapY + gapH) continue;
        spawn(x, y, vx, 0, 4);
      }
    },
  },
  // Little moths, drawn to your light, curve after you.
  moths: {
    w: 220, h: 150, dur: 360,
    update(t, a, k) {
      if (t % Math.round(50 / k)) return;
      if (G.bullets.filter((b) => b.kind === "moth" && !b.fade).length >= 4) return;
      const pt = edgePoint(a, 80);
      const sp = 0.9 + 0.6 * k;
      const ang = Math.atan2(G.player.y - pt.y, G.player.x - pt.x);
      spawn(pt.x, pt.y, Math.cos(ang) * sp, Math.sin(ang) * sp, 5, { kind: "moth", life: 230, sp, step: homing });
    },
  },
  // The eye on its wing spins dust outward in three arms.
  spiral: {
    w: 160, h: 160, dur: 340, start: "bottom",
    update(t, a, k) {
      const every = Math.max(4, Math.round(7 / k));
      if (t % every) return;
      G.ps.theta = (G.ps.theta ?? rand(0, TAU)) + 0.022 * every * (t < 170 ? 1 : -1);
      const cx = a.x + a.w / 2;
      const cy = a.y + a.h / 2;
      const sp = 1.1 + 0.5 * k;
      for (let i = 0; i < 3; i++) {
        const ang = G.ps.theta + (i * TAU) / 3;
        spawn(cx + Math.cos(ang) * 8, cy + Math.sin(ang) * 8, Math.cos(ang) * sp, Math.sin(ang) * sp, 3.5);
      }
    },
  },
  // Rings of dust close in. Slip out through the gap.
  ring: {
    w: 160, h: 160, dur: 330,
    update(t, a, k) {
      if (t % Math.round(96 / Math.sqrt(k))) return;
      const cx = a.x + a.w / 2;
      const cy = a.y + a.h / 2;
      const n = 22;
      const gap = 4;
      const start = (Math.random() * n) | 0;
      const off = rand(0, TAU);
      const spin = (Math.random() < 0.5 ? -1 : 1) * 0.004 * k;
      const sp = 0.9 + 0.5 * k;
      for (let i = 0; i < n; i++) {
        if ((i - start + n) % n < gap) continue;
        spawn(cx, cy, 0, 0, 4, { cx, cy, rad: 150, ang: off + (i * TAU) / n, spin, sp, step: ringStep });
      }
    },
  },
  // A tired moth barely tries.
  drift: {
    w: 200, h: 130, dur: 270,
    update(t, a) {
      if (t % 16) return;
      const pt = edgePoint(a, 60);
      const tx = rand(a.x + 20, a.x + a.w - 20);
      const ty = rand(a.y + 20, a.y + a.h - 20);
      const ang = Math.atan2(ty - pt.y, tx - pt.x);
      const sp = rand(0.55, 0.9);
      spawn(pt.x, pt.y, Math.cos(ang) * sp, Math.sin(ang) * sp, rand(3, 4));
    },
  },
};
const ORDER = ["dustfall", "gust", "moths", "spiral", "ring"];
const choosePattern = () => (G.moth.calm >= 70 ? "drift" : ORDER[(G.turn - 1) % ORDER.length]);

/* ----------------------------------------------------------------------- */
/* Losing & endings                                                        */
/* ----------------------------------------------------------------------- */
function gameOver() {
  const { x, y } = G.player;
  setScene("over");
  G.overAt = { x, y };
  G.overReady = false;
  G.dialog = null;
  G.bubble = null;
  G.bullets = [];
  sfx.out();
  for (let i = 0; i < 46; i++) {
    const a = rand(0, TAU);
    const s = rand(0.4, 2.6);
    G.particles.push({ x, y, vx: Math.cos(a) * s, vy: Math.sin(a) * s - 0.6, g: 0.03, life: rand(50, 100), age: 0, size: rand(1.5, 3), color: C.ember });
  }
}

function updateOver() {
  if (G.sceneT === 80) {
    G.dialog = new Typer(["your light goes out.", "but embers remember how to burn."], {
      onDone: () => {
        G.overReady = true;
        say("press z or tap to rekindle.");
      },
    });
  }
  if (!G.dialog) return;
  G.dialog.update();
  if (G.overReady && confirmed()) {
    sfx.select();
    startBattle();
  } else if (confirmed()) {
    G.dialog.advance();
  }
}

function startEnding(kind) {
  setScene("end");
  G.ending = kind;
  G.endReady = false;
  G.fade = 1;
  G.bubble = null;
  G.endings[kind] = true;
  storage.set("ember:endings", JSON.stringify(G.endings));
  if (kind === "warm") sfx.warm();
  const lines = kind === "warm"
    ? ["you dim your light and step away, slowly.", "dusk folds its wings on a warm stone.", "it will sleep well tonight."]
    : ["the path is quiet now.", "it feels colder than before."];
  G.dialog = new Typer(lines, {
    onDone: () => {
      G.endReady = true;
      say(`ending: ${kind}. press z or tap to play again.`);
    },
  });
}

function updateEnd() {
  G.dialog.update();
  if (G.ending === "warm" && G.sceneT % 110 === 60) {
    G.particles.push({ x: 236, y: 98, vx: 0.25, vy: -0.35, g: 0, life: 90, age: 0, text: "z", color: C.dim });
  }
  if (G.ending === "cold" && G.sceneT % 14 === 0) {
    G.particles.push({ x: rand(60, 420), y: -4, vx: rand(-0.1, 0.1), vy: rand(0.3, 0.6), g: 0, life: 420, age: 0, size: rand(1, 2), color: C.dim });
  }
  if (G.endReady && confirmed()) {
    sfx.select();
    startTitle();
  } else if (confirmed()) {
    G.dialog.advance();
  }
}

/* ----------------------------------------------------------------------- */
/* Effects                                                                 */
/* ----------------------------------------------------------------------- */
function updateMoth(m) {
  m.phase += lerp(0.3, 0.07, m.calm / 100) * (REDUCED ? 0.6 : 1);
  if (m.shake > 0) m.shake -= 0.5;
  if (m.flash > 0) m.flash--;
  if (m.barT > 0) m.barT--;
  m.shown = lerp(m.shown, m.hp, 0.08);
  if (m.dead) m.alpha = Math.max(0, m.alpha - 0.03);
}

// Where the moth is right now: frantic moths jitter, calm ones sink and drift.
function mothPose(m) {
  const calm = m.calm / 100;
  const frantic = (1 - calm) * (REDUCED ? 0.3 : 1);
  let x = m.x + Math.sin(G.t * 0.017) * 8 * frantic + Math.sin(G.t * 0.13) * 2.5 * frantic * frantic;
  const y = m.y + Math.sin(G.t * 0.045) * 4 + calm * 8;
  if (m.shake > 0) x += Math.sin(m.shake * 2.2) * m.shake * 0.5;
  return { x, y, flap: 0.3 + 0.7 * Math.abs(Math.cos(m.phase)) };
}

function dissolveMoth() {
  const { x, y } = mothPose(G.moth);
  for (let i = 0; i < 120; i++) {
    const a = rand(0, TAU);
    const r = Math.sqrt(Math.random());
    G.particles.push({
      x: x + Math.cos(a) * r * 64, y: y + Math.sin(a) * r * 36,
      vx: rand(-0.25, 0.25), vy: rand(-0.7, -0.1), g: -0.002,
      life: rand(70, 160), age: 0, size: rand(1, 2.4), color: C.ink,
    });
  }
}

function updateAmbient() {
  for (const m of G.motes) {
    m.y -= m.v;
    m.x += Math.sin(G.t * 0.01 + m.ph) * 0.08;
    if (m.y < -4) {
      m.y = H + 4;
      m.x = rand(0, W);
    }
  }
  for (const p of G.particles) {
    p.age++;
    p.vy += p.g;
    p.x += p.vx;
    p.y += p.vy;
  }
  G.particles = G.particles.filter((p) => p.age < p.life);
  for (const f of G.floaters) {
    f.t++;
    if (f.t < 24) f.y -= 0.6;
  }
  G.floaters = G.floaters.filter((f) => f.t < 80);
  if (G.shake > 0) G.shake = Math.max(0, G.shake - 0.4);
  if (G.fade > 0) G.fade = Math.max(0, G.fade - 1 / 30);
}

/* ----------------------------------------------------------------------- */
/* Drawing                                                                 */
/* ----------------------------------------------------------------------- */
function diamond(x, y, size, color) {
  ctx.fillStyle = color;
  ctx.beginPath();
  ctx.moveTo(x, y - size);
  ctx.lineTo(x + size * 0.72, y);
  ctx.lineTo(x, y + size);
  ctx.lineTo(x - size * 0.72, y);
  ctx.closePath();
  ctx.fill();
}

// You: a small, flickering ember.
function drawEmber(x, y, size = 6, glow = 1, alpha = 1) {
  const flicker = REDUCED ? 1 : 0.86 + 0.14 * Math.sin(G.t * 0.23) * Math.sin(G.t * 0.071 + 1.3);
  const R = size * 7 * glow * flicker;
  if (R > 1) {
    const g = ctx.createRadialGradient(x, y, 0, x, y, R);
    g.addColorStop(0, `rgba(${EMBER_RGB}, ${0.3 * alpha})`);
    g.addColorStop(1, `rgba(${EMBER_RGB}, 0)`);
    ctx.fillStyle = g;
    ctx.fillRect(x - R, y - R, R * 2, R * 2);
  }
  ctx.globalAlpha = alpha;
  diamond(x, y, size, C.ember);
  diamond(x, y, size * 0.4, C.core);
  ctx.globalAlpha = 1;
}

// Dusk, drawn in line. `flap` squeezes the wings: 1 = open, ~0.2 = folded.
function drawMoth(x, y, { s = 1, flap = 1, alpha = 1, color = C.ink } = {}) {
  if (alpha <= 0) return;
  ctx.save();
  ctx.globalAlpha = alpha;
  ctx.translate(x, y);
  ctx.scale(s, s);
  ctx.lineWidth = 2 / Math.max(s, 0.7);
  ctx.strokeStyle = color;

  for (const side of [-1, 1]) {
    ctx.save();
    ctx.scale(side * flap, 1);
    ctx.fillStyle = C.bg;
    // hindwing
    ctx.beginPath();
    ctx.moveTo(3, 0);
    ctx.bezierCurveTo(24, 0, 46, 8, 44, 26);
    ctx.bezierCurveTo(42, 40, 22, 46, 12, 36);
    ctx.bezierCurveTo(6, 28, 3, 14, 3, 4);
    ctx.closePath();
    ctx.fill();
    ctx.stroke();
    // forewing
    ctx.beginPath();
    ctx.moveTo(3, -9);
    ctx.bezierCurveTo(18, -40, 52, -48, 66, -32);
    ctx.bezierCurveTo(74, -22, 64, -4, 50, -2);
    ctx.bezierCurveTo(32, 0, 14, 2, 3, 1);
    ctx.closePath();
    ctx.fill();
    ctx.stroke();
    // eye spot
    ctx.beginPath();
    ctx.arc(42, -22, 6, 0, TAU);
    ctx.stroke();
    ctx.fillStyle = color;
    ctx.beginPath();
    ctx.arc(42, -22, 2, 0, TAU);
    ctx.fill();
    ctx.restore();
  }

  // body
  ctx.fillStyle = C.bg;
  ctx.beginPath();
  ctx.ellipse(0, 4, 5, 20, 0, 0, TAU);
  ctx.fill();
  ctx.stroke();
  ctx.beginPath();
  for (const yy of [7, 13, 19]) {
    ctx.moveTo(-3.2, yy);
    ctx.lineTo(3.2, yy);
  }
  ctx.stroke();
  // head
  ctx.beginPath();
  ctx.arc(0, -21, 6, 0, TAU);
  ctx.fill();
  ctx.stroke();
  ctx.fillStyle = color;
  for (const ex of [-2.4, 2.4]) {
    ctx.beginPath();
    ctx.arc(ex, -21.5, 1.3, 0, TAU);
    ctx.fill();
  }
  // feathery antennae
  ctx.beginPath();
  for (const side of [-1, 1]) {
    const p0 = { x: side * 2, y: -26 };
    const p1 = { x: side * 4, y: -42 };
    const p2 = { x: side * 16, y: -48 };
    ctx.moveTo(p0.x, p0.y);
    ctx.quadraticCurveTo(p1.x, p1.y, p2.x, p2.y);
    for (const t of [0.45, 0.65, 0.85]) {
      const u = 1 - t;
      const px = u * u * p0.x + 2 * u * t * p1.x + t * t * p2.x;
      const py = u * u * p0.y + 2 * u * t * p1.y + t * t * p2.y;
      ctx.moveTo(px, py);
      ctx.lineTo(px + side * 4, py + 1.5);
    }
  }
  ctx.stroke();
  ctx.restore();
}

function drawMiniMoth(b) {
  const f = 0.45 + 0.55 * Math.abs(Math.sin(b.age * 0.35));
  ctx.save();
  ctx.translate(b.x, b.y);
  ctx.rotate(Math.atan2(b.vy, b.vx) + Math.PI / 2);
  ctx.fillStyle = C.ink;
  for (const side of [-1, 1]) {
    ctx.beginPath();
    ctx.moveTo(0, -2);
    ctx.lineTo(side * 7 * f, -5);
    ctx.lineTo(side * 5 * f, 3);
    ctx.lineTo(0, 1);
    ctx.closePath();
    ctx.fill();
  }
  ctx.restore();
}

function drawBullets() {
  for (const b of G.bullets) {
    ctx.globalAlpha = b.fade ? 1 - b.fade / 20 : Math.min(1, b.age / 8);
    if (b.kind === "moth") drawMiniMoth(b);
    else {
      ctx.fillStyle = C.ink;
      ctx.beginPath();
      ctx.arc(b.x, b.y, b.r, 0, TAU);
      ctx.fill();
    }
  }
  ctx.globalAlpha = 1;
}

function drawNext(x, y) {
  const bob = REDUCED ? 0 : Math.sin(G.t * 0.12) * 2;
  ctx.fillStyle = C.dim;
  ctx.beginPath();
  ctx.moveTo(x - 5, y - 3 + bob);
  ctx.lineTo(x + 5, y - 3 + bob);
  ctx.lineTo(x, y + 3 + bob);
  ctx.closePath();
  ctx.fill();
}

const pulse = (speed = 0.06) => (REDUCED ? 1 : 0.55 + 0.45 * Math.sin(G.t * speed));

// Centered lines that pile up as they're read: earlier ones fade to grey.
function drawStack(d, y0, { size = 15, lh = 24, maxW = 420 } = {}) {
  if (!d) return y0;
  setFont(size);
  let y = y0;
  for (let j = 0; j <= d.i; j++) {
    const str = d.lines[j];
    ctx.fillStyle = j < d.i ? C.dim : C.ink;
    const rows = drawTyped(str, j < d.i ? str.length : d.n, W / 2, y, maxW, lh, "center");
    y += rows * lh + 6;
  }
  return y;
}

function drawTitle() {
  text("ember", W / 2, 116, { size: 46, weight: 500, align: "center", spacing: 6 });
  drawEmber(W / 2, 196, 7, 1.5);
  text("a very small game", W / 2, 242, { size: 13, color: C.dim, align: "center" });
  text("press z or tap to begin", W / 2, 304, { size: 14, align: "center", alpha: pulse() });

  const e = G.endings;
  if (e.warm || e.cold) {
    setFont(11);
    const items = [["warm", e.warm, C.ember], ["cold", e.cold, C.ink]];
    let x = W / 2 - 62;
    for (const [label, found, color] of items) {
      ctx.strokeStyle = found ? color : C.dim;
      ctx.fillStyle = color;
      ctx.lineWidth = 1.2;
      ctx.beginPath();
      ctx.arc(x, 352, 3.5, 0, TAU);
      if (found) ctx.fill();
      else ctx.stroke();
      text(label, x + 10, 352, { size: 11, color: C.dim, base: "middle" });
      x += 74;
    }
  }
  text("arrows move · z confirm · x back · m sound", W / 2, 392, { size: 11, color: C.dim, align: "center" });
}

function drawIntro() {
  drawEmber(W / 2, 214, 6, 1.3);
  if (G.introT > 0) {
    const t = ease(G.introT / 140);
    drawMoth(W / 2 + Math.sin(G.t * 0.05) * 30 * (1 - t), lerp(-40, 90, t), {
      s: lerp(0.35, 0.6, t), flap: 0.3 + 0.7 * Math.abs(Math.cos(G.t * 0.3)), alpha: t,
    });
  }
  drawStack(G.dialog, 260);
  if (G.dialog?.full) drawNext(W - 28, H - 28);
}

function drawBattle() {
  const m = G.moth;
  const pose = mothPose(m);
  const flashing = m.flash > 0 && (m.flash >> 1) % 2 === 0;
  drawMoth(pose.x, pose.y, { flap: pose.flap, alpha: m.alpha, color: flashing ? C.ember : C.ink });

  if (G.slash) {
    const t = G.slash.t;
    const grow = clamp(t / 8, 0, 1);
    ctx.globalAlpha = t < 10 ? 1 : 1 - (t - 10) / 16;
    ctx.strokeStyle = C.ember;
    ctx.lineWidth = 3;
    ctx.beginPath();
    ctx.moveTo(pose.x + 56, pose.y - 50);
    ctx.lineTo(pose.x + 56 - 112 * grow, pose.y - 50 + 100 * grow);
    ctx.stroke();
    ctx.globalAlpha = 1;
  }

  const inArena = G.phase === "enemy" || G.phase === "dodge";
  if (m.barT > 0) {
    const a = Math.min(1, m.barT / 20);
    ctx.globalAlpha = a;
    ctx.fillStyle = C.faint;
    ctx.fillRect(190, 166, 100, 4);
    ctx.fillStyle = C.ink;
    ctx.fillRect(190, 166, 100 * (m.shown / m.max), 4);
    ctx.globalAlpha = 1;
  } else if (!inArena && !m.dead) {
    text("dusk", 240, 160, { size: 12, color: m.calm >= 100 ? C.ember : C.dim, align: "center", spacing: 3 });
  }

  drawBox();
  drawHud();
  drawOptions();
  drawBubble();
}

function drawBox() {
  const b = G.box;
  ctx.fillStyle = C.bg;
  ctx.fillRect(b.x, b.y, b.w, b.h);
  ctx.save();
  ctx.beginPath();
  ctx.rect(b.x + 1, b.y + 1, b.w - 2, b.h - 2);
  ctx.clip();
  if (G.phase === "menu" || G.phase === "result") {
    const d = G.dialog;
    if (d) {
      setFont(16);
      ctx.fillStyle = C.ink;
      drawTyped(d.text, d.n, b.x + 22, b.y + 20, MENU_BOX.w - 44, 25);
      if (G.phase === "result" && d.full) drawNext(b.x + b.w - 22, b.y + b.h - 18);
    }
  } else if (G.phase === "talk") {
    drawActs(b);
  } else if (G.phase === "strike") {
    drawStrike(b);
  } else {
    drawArena();
  }
  ctx.restore();
  ctx.strokeStyle = C.ink;
  ctx.lineWidth = 2;
  ctx.strokeRect(b.x, b.y, b.w, b.h);
}

function drawActs(b) {
  ACTS.forEach((label, i) => {
    const r = actRect(i);
    const sel = G.act === i;
    if (sel) diamond(r.x - 18, r.y + 9, 5, C.ember);
    text(label, r.x, r.y, { size: 16, color: sel ? C.ink : C.dim, alpha: actSpent(i) ? 0.45 : 1 });
  });
  text("x back", b.x + b.w - 16, b.y + b.h - 22, { size: 11, color: C.dim, align: "right" });
}

function drawStrike(b) {
  const s = G.strike;
  if (!s) return;
  const x0 = b.x + 40;
  const x1 = b.x + b.w - 40;
  const cy = b.y + b.h / 2 + 10;
  text("strike as the line crosses the center", b.x + b.w / 2, b.y + 16, { size: 12, color: C.dim, align: "center" });
  ctx.lineWidth = 2;
  ctx.strokeStyle = C.faint;
  ctx.beginPath();
  ctx.moveTo(x0, cy);
  ctx.lineTo(x1, cy);
  ctx.stroke();
  for (let i = 0; i <= 10; i++) {
    const x = lerp(x0, x1, i / 10);
    const h = i === 5 ? 26 : 8;
    ctx.strokeStyle = i === 5 ? C.ember : C.dim;
    ctx.beginPath();
    ctx.moveTo(x, cy - h / 2);
    ctx.lineTo(x, cy + h / 2);
    ctx.stroke();
  }
  const cx = lerp(x0, x1, s.x);
  const flash = s.stopped && (s.hold >> 2) % 2 === 0;
  ctx.strokeStyle = flash ? C.ember : C.ink;
  ctx.lineWidth = 3;
  ctx.beginPath();
  ctx.moveTo(cx, cy - 22);
  ctx.lineTo(cx, cy + 22);
  ctx.stroke();
}

function drawArena() {
  if (G.phase === "dodge" && G.pattern === "spiral" && G.patT >= 0) {
    const a = G.boxTarget;
    const cx = a.x + a.w / 2;
    const cy = a.y + a.h / 2;
    ctx.strokeStyle = C.dim;
    ctx.lineWidth = 1.5;
    ctx.beginPath();
    ctx.arc(cx, cy, 7 + Math.sin(G.t * 0.2), 0, TAU);
    ctx.stroke();
    ctx.fillStyle = C.dim;
    ctx.beginPath();
    ctx.arc(cx, cy, 2, 0, TAU);
    ctx.fill();
  }
  drawBullets();
  const p = G.player;
  const blink = p.inv > 0 && (p.inv >> 2) % 2 === 0;
  if (!blink) drawEmber(p.x, p.y, 6, 1 - G.dimmed * 0.22);
}

function drawHud() {
  text("ember", 20, HUD_Y, { size: 14, base: "middle" });
  text("hp", 92, HUD_Y, { size: 11, color: C.dim, base: "middle" });
  const bx = 116;
  const bw = 96;
  ctx.fillStyle = C.faint;
  ctx.fillRect(bx, HUD_Y - 4, bw, 8);
  ctx.fillStyle = G.hp <= 6 ? C.ember : C.ink;
  ctx.fillRect(bx, HUD_Y - 4, (bw * G.hp) / G.maxHp, 8);
  text(`${G.hp} / ${G.maxHp}`, bx + bw + 12, HUD_Y, { size: 13, base: "middle" });
}

function drawOptions() {
  const active = G.phase === "menu" || G.phase === "talk";
  MENU.forEach((label, i) => {
    const r = optionRect(i);
    const cx = r.x + r.w / 2;
    const sel = active && G.menu === i;
    const ready = i === 3 && G.moth.calm >= 100;
    const color = ready ? C.ember : sel ? C.ink : C.dim;
    const alpha = active ? 1 : 0.4;
    setFont(16, sel ? 500 : 400);
    const tw = ctx.measureText(label).width;
    text(label, cx, OPT_Y, { size: 16, weight: sel ? 500 : 400, color, align: "center", base: "middle", alpha });
    if (i === 2) text(String(G.mends), cx + tw / 2 + 4, OPT_Y - 6, { size: 10, color: C.dim, base: "middle", alpha });
    if (sel) {
      ctx.globalAlpha = alpha;
      diamond(cx - tw / 2 - 14, OPT_Y, 5, C.ember);
      ctx.globalAlpha = 1;
    }
  });
}

function drawBubble() {
  const d = G.bubble;
  if (!d) return;
  setFont(14);
  const lines = wrap(d.text, 116);
  const bx = 332;
  const by = 40;
  const bw = 136;
  const bh = 20 + lines.length * 20;
  ctx.fillStyle = C.bg;
  ctx.strokeStyle = C.ink;
  ctx.lineWidth = 2;
  ctx.beginPath();
  ctx.moveTo(bx, by);
  ctx.lineTo(bx + bw, by);
  ctx.lineTo(bx + bw, by + bh);
  ctx.lineTo(bx, by + bh);
  ctx.lineTo(bx, by + 30);
  ctx.lineTo(bx - 12, by + 23);
  ctx.lineTo(bx, by + 16);
  ctx.closePath();
  ctx.fill();
  ctx.stroke();
  ctx.fillStyle = C.ink;
  drawTyped(d.text, d.n, bx + 11, by + 11, 116, 20);
}

function drawOver() {
  if (G.sceneT < 30 && G.overAt) drawEmber(G.overAt.x, G.overAt.y, 6, 1, 1 - G.sceneT / 30);
  const y = drawStack(G.dialog, 180);
  if (G.overReady) text("z to rekindle", W / 2, y + 40, { size: 13, color: C.ember, align: "center", alpha: pulse() });
}

function drawEnd() {
  const t = G.sceneT;
  if (G.ending === "warm") {
    // a stone, a sleeping moth, and you, wandering off
    ctx.strokeStyle = C.ink;
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.moveTo(150, 152);
    ctx.lineTo(196, 152);
    ctx.ellipse(220, 152, 24, 12, 0, Math.PI, 0);
    ctx.lineTo(290, 152);
    ctx.stroke();
    drawMoth(220, 118, { s: 0.62, flap: 0.22 + 0.04 * Math.sin(t * 0.03) });
    const ex = 270 + Math.min(t, 600) * 0.22;
    drawEmber(ex, 132 + Math.sin(t * 0.05) * 3, 5, 0.9, clamp(1 - (ex - 330) / 70, 0, 1));
  } else {
    drawEmber(W / 2, 130, 5, 0.6, 0.75);
  }
  const y = drawStack(G.dialog, 200);
  if (G.endReady) {
    text(`— ${G.ending} —`, W / 2, y + 26, { size: 14, color: G.ending === "warm" ? C.ember : C.dim, align: "center", spacing: 2 });
    text("z to play again", W / 2, y + 62, { size: 12, color: C.dim, align: "center", alpha: pulse() });
  }
}

function drawParticles() {
  for (const p of G.particles) {
    ctx.globalAlpha = 1 - p.age / p.life;
    if (p.text) {
      text(p.text, p.x, p.y, { size: 11, color: p.color, alpha: 1 - p.age / p.life });
    } else {
      ctx.fillStyle = p.color;
      ctx.fillRect(p.x - p.size / 2, p.y - p.size / 2, p.size, p.size);
    }
  }
  ctx.globalAlpha = 1;
}

function drawFloaters() {
  for (const f of G.floaters) {
    const a = f.t < 50 ? 1 : 1 - (f.t - 50) / 30;
    text(f.text, f.x, f.y, { size: f.size ?? 14, weight: 500, color: f.color, align: "center", alpha: a });
  }
}

function drawMuteIcon() {
  const x = W - 30;
  const y = 18;
  ctx.globalAlpha = 0.7;
  ctx.fillStyle = C.dim;
  ctx.strokeStyle = C.dim;
  ctx.lineWidth = 1.5;
  ctx.beginPath();
  ctx.moveTo(x, y - 2.5);
  ctx.lineTo(x + 3, y - 2.5);
  ctx.lineTo(x + 7, y - 6);
  ctx.lineTo(x + 7, y + 6);
  ctx.lineTo(x + 3, y + 2.5);
  ctx.lineTo(x, y + 2.5);
  ctx.closePath();
  ctx.fill();
  ctx.beginPath();
  if (muted) {
    ctx.moveTo(x + 10, y - 3);
    ctx.lineTo(x + 16, y + 3);
    ctx.moveTo(x + 16, y - 3);
    ctx.lineTo(x + 10, y + 3);
  } else {
    ctx.arc(x + 8, y, 4.5, -0.8, 0.8);
    ctx.moveTo(x + 8 + 8 * Math.cos(-0.8), y + 8 * Math.sin(-0.8));
    ctx.arc(x + 8, y, 8, -0.8, 0.8);
  }
  ctx.stroke();
  ctx.globalAlpha = 1;
}

function draw() {
  ctx.setTransform(canvas.width / W, 0, 0, canvas.height / H, 0, 0);
  ctx.fillStyle = C.bg;
  ctx.fillRect(0, 0, W, H);
  ctx.textBaseline = "top";
  ctx.lineJoin = "round";
  ctx.lineCap = "round";

  ctx.save();
  if (G.shake > 0) ctx.translate(rand(-1, 1) * G.shake, rand(-1, 1) * G.shake);

  for (const m of G.motes) {
    ctx.globalAlpha = m.a;
    ctx.fillStyle = C.dim;
    ctx.fillRect(m.x, m.y, m.s, m.s);
  }
  ctx.globalAlpha = 1;

  switch (G.scene) {
    case "title": drawTitle(); break;
    case "intro": drawIntro(); break;
    case "battle": drawBattle(); break;
    case "over": drawOver(); break;
    case "end": drawEnd(); break;
  }
  drawParticles();
  drawFloaters();
  ctx.restore();

  if (G.fade > 0) {
    ctx.globalAlpha = G.fade;
    ctx.fillStyle = C.bg;
    ctx.fillRect(0, 0, W, H);
    ctx.globalAlpha = 1;
  }
  drawMuteIcon();
}

/* ----------------------------------------------------------------------- */
/* Loop                                                                    */
/* ----------------------------------------------------------------------- */
function update() {
  G.t++;
  G.sceneT++;
  if (pressed.has("mute")) toggleMute();
  for (let i = taps.length - 1; i >= 0; i--) {
    if (taps[i].x > W - 44 && taps[i].y < 40) {
      toggleMute();
      taps.splice(i, 1);
    }
  }
  updateAmbient();
  switch (G.scene) {
    case "title": updateTitle(); break;
    case "intro": updateIntro(); break;
    case "battle": updateBattle(); break;
    case "over": updateOver(); break;
    case "end": updateEnd(); break;
  }
}

let last = performance.now();
let acc = 0;
function frame(now) {
  acc += Math.min(100, now - last);
  last = now;
  while (acc >= STEP) {
    update();
    acc -= STEP;
    pressed.clear();
    taps.length = 0;
  }
  draw();
  requestAnimationFrame(frame);
}

document.addEventListener("visibilitychange", () => {
  held.clear();
  last = performance.now();
});

// Give the web font a moment so the first frames don't measure the fallback.
await Promise.race([document.fonts?.load(`16px ${FONT}`), new Promise((r) => setTimeout(r, 1200))]).catch(() => {});
wrapCache.clear();
startTitle();
requestAnimationFrame(frame);
