// Underfern — procedural sound engine (AUDIO).
//
// Every sound is synthesised with the Web Audio API at runtime; there are no
// sample files. The graph is built once in start():
//
//   one-shot voices ─► sfxBus ─┐
//   ambient beds    ─► ambBus ─► duck ─┤
//   stingers/pings  ─► uiBus  ─┼─► master (mute) ─► compressor ─► limiter ─► trim ─► out
//   sends ─► reverb (generated impulse) ─┤
//         ─► hill-echo delay network ────┘
//
// Per frame, update() only moves AudioParams and fires one-shots from time
// accumulators. One-shot sounds are short-lived "voices" under a hard cap; each
// disconnects all of its nodes when its last source ends. Before start() — or
// without Web Audio at all — every method is a silent no-op.

import { clamp, lerp, smoothstep, damp, TAU } from "../core/math.js";
import { makeRng, hash } from "../core/rng.js";

/* --- Tuning ------------------------------------------------------------ */

const MAX_VOICES = 16; // concurrent one-shot voices (beds don't count)
const HEAR_RANGE = 400; // m — spatial one-shots fade out completely by here
const SOUND_SPEED = 343; // m/s — far impacts arrive late, as they do outdoors
const CONTROL_DT = 1 / 15; // s — bed levels / spatial follow / probes run at this rate
const MASTER_LEVEL = 0.9;
const MIN_GAIN = 0.0001; // exponential ramps can't reach 0
const LOOKAHEAD = 0.012; // s — schedule a hair ahead so ramps never start in the past
const PROBE_RADII = [8, 20, 40, 70, 110, 160, 230]; // m — rings sampled around the listener
const PROBE_POINTS = 12;

// Pitch contours (fraction of the call, multiplier of the base pitch).
const SHAPE_ROAR = [[0, 0.82], [0.2, 1.12], [0.6, 0.98], [1, 0.7]];
const SHAPE_BELLOW = [[0, 0.92], [0.3, 1.04], [0.75, 1], [1, 0.86]];
const SHAPE_SHRIEK = [[0, 0.75], [0.3, 1.55], [0.6, 1.2], [1, 0.7]];
const SHAPE_RUMBLE = [[0, 0.86], [0.18, 1.06], [0.7, 0.98], [1, 0.78]];
const SHAPE_RATTLE = [[0, 0.94], [0.25, 1.06], [0.7, 0.9], [1, 0.74]];
const SHAPE_DYING = [[0, 1], [0.25, 1.04], [1, 0.5]];

// Output trims so every call kind lands at a similar loudness (measured offline).
const CALL_LEVEL = { roar: 0.85, bellow: 1.0, honk: 2.4, chirp: 0.6, shriek: 1.25, hoot: 0.95, rumble: 1.0, rattle: 1.15 };

// Bird repertoire: a handful of fixed "songs" so the same birds are heard
// repeating themselves, as real ones do.
const SONGS = ["whistle", "trill", "twoTone", "warble", "coo", "chip", "whistle", "trill", "twoTone"].map((type, i) => ({
  type,
  seed: hash("sauria-bird", i),
  level: { whistle: 0.5, trill: 0.32, twoTone: 0.45, warble: 0.36, coo: 0.6, chip: 0.38 }[type],
}));
const SEABIRD = { type: "kraa", seed: hash("sauria-kraa"), level: 0.42 };
const RATIOS = [1, 1.122, 1.26, 1.335, 1.5, 0.89, 0.75];
const GLIDES = [1, 1.15, 0.87, 1.3, 0.92];

/* --- Small helpers ------------------------------------------------------- */

let nanBlocked = 0; // diagnostics: non-finite values refused before they reach an AudioParam

const num = (v, fallback = 0) => (typeof v === "number" && Number.isFinite(v) ? v : fallback);
const rnd = (lo, hi) => lo + Math.random() * (hi - lo); // cosmetic jitter only — never world state
const anyOf = (arr) => arr[Math.floor(Math.random() * arr.length)];
const hz = (f) => (Number.isFinite(f) ? clamp(f, 0.01, 20000) : 440);

/** 0 (a few kg) .. 1 (a sauropod), on a log scale — how "big" a sound should be. */
const massWeight = (kg) => clamp((Math.log10(Math.max(1, kg)) - 0.5) / 3.8, 0, 1);

/** setTargetAtTime that refuses non-finite values (one NaN would break the param). */
function glide(param, value, t, tc) {
  if (!param) return;
  if (!Number.isFinite(value) || !Number.isFinite(t)) {
    nanBlocked++;
    return;
  }
  param.setTargetAtTime(value, t, Math.max(0.005, tc));
}

/** glide(), skipped when the target barely moved — keeps bed automation sparse. */
function glideIf(param, value, t, tc) {
  if (!param) return;
  const last = param.__sauriaTarget;
  if (last !== undefined && Math.abs(last - value) <= 1e-4 + Math.abs(value) * 0.015) return;
  param.__sauriaTarget = value;
  glide(param, value, t, tc);
}

/** Linear attack to `peak`, exponential decay to silence. Returns the end time. */
function pluck(param, t, attack, peak, decay) {
  const p = Number.isFinite(peak) ? Math.max(MIN_GAIN * 2, peak) : MIN_GAIN * 2;
  param.setValueAtTime(MIN_GAIN, t);
  param.linearRampToValueAtTime(p, t + attack);
  param.exponentialRampToValueAtTime(MIN_GAIN, t + attack + decay);
  return t + attack + decay;
}

/** Attack, hold, exponential release. Returns the end time. */
function swell(param, t, attack, peak, hold, release) {
  const p = Number.isFinite(peak) ? Math.max(MIN_GAIN * 2, peak) : MIN_GAIN * 2;
  param.setValueAtTime(MIN_GAIN, t);
  param.linearRampToValueAtTime(p, t + attack);
  param.setValueAtTime(p, t + attack + hold);
  param.exponentialRampToValueAtTime(MIN_GAIN, t + attack + hold + release);
  return t + attack + hold + release;
}

/** Exponential frequency sweep. */
function sweep(param, t, from, to, dur) {
  param.setValueAtTime(hz(from), t);
  param.exponentialRampToValueAtTime(hz(to), t + Math.max(0.005, dur));
}

/** Piecewise exponential pitch contour over a call of length d. */
function contour(param, t, f, d, shape) {
  param.setValueAtTime(hz(f * shape[0][1]), t);
  for (let i = 1; i < shape.length; i++) param.exponentialRampToValueAtTime(hz(f * shape[i][1]), t + d * shape[i][0]);
}

/* --- Generated buffers & curves ------------------------------------------ */

/** Looping noise, RMS-normalised so colours sit at the same loudness. */
function noiseBuffer(ctx, seconds, channels, color) {
  const len = Math.max(64, Math.floor(seconds * ctx.sampleRate));
  const buf = ctx.createBuffer(channels, len, ctx.sampleRate);
  for (let ch = 0; ch < channels; ch++) {
    const d = buf.getChannelData(ch);
    let b0 = 0;
    let b1 = 0;
    let b2 = 0;
    let br = 0;
    for (let i = 0; i < len; i++) {
      const w = Math.random() * 2 - 1;
      if (color === "pink") {
        // Paul Kellet's economy pink filter.
        b0 = 0.99765 * b0 + w * 0.099046;
        b1 = 0.963 * b1 + w * 0.2965164;
        b2 = 0.57 * b2 + w * 1.0526913;
        d[i] = b0 + b1 + b2 + w * 0.1848;
      } else if (color === "brown") {
        br = (br + 0.02 * w) / 1.02;
        d[i] = br;
      } else d[i] = w;
    }
    // Remove drift so the loop point is seamless (matters for brown noise), centre, normalise.
    const step = (d[len - 1] - d[0]) / (len - 1);
    let mean = 0;
    for (let i = 0; i < len; i++) {
      d[i] -= step * i;
      mean += d[i];
    }
    mean /= len;
    let sq = 0;
    for (let i = 0; i < len; i++) {
      d[i] -= mean;
      sq += d[i] * d[i];
    }
    const k = 0.3 / Math.max(1e-6, Math.sqrt(sq / len));
    for (let i = 0; i < len; i++) d[i] *= k;
  }
  return buf;
}

/** Sparse crackle grains — the raw material of crunches, twigs and chewing. */
function crackleBuffer(ctx, seconds = 1.5) {
  const len = Math.floor(seconds * ctx.sampleRate);
  const buf = ctx.createBuffer(1, len, ctx.sampleRate);
  const d = buf.getChannelData(0);
  const decay = Math.exp(-1 / (0.0012 * ctx.sampleRate));
  let env = 0;
  let sq = 0;
  for (let i = 0; i < len; i++) {
    if (Math.random() < 0.0026) env = 0.3 + Math.random() * 0.7;
    d[i] = (Math.random() * 2 - 1) * env;
    env *= decay;
    sq += d[i] * d[i];
  }
  const k = 0.3 / Math.max(1e-6, Math.sqrt(sq / len));
  for (let i = 0; i < len; i++) d[i] *= k;
  return buf;
}

/** Outdoor reverb: a few early reflections, then a tail whose highs die first (air, foliage). */
function impulseResponse(ctx, seconds = 2.4) {
  const rate = ctx.sampleRate;
  const len = Math.floor(seconds * rate);
  const pre = Math.floor(0.012 * rate);
  const buf = ctx.createBuffer(2, len, rate);
  for (let ch = 0; ch < 2; ch++) {
    const d = buf.getChannelData(ch);
    let lp = 0;
    for (let i = pre; i < len; i++) {
      const x = (i - pre) / (len - pre);
      lp += lerp(0.85, 0.05, Math.sqrt(x)) * (Math.random() * 2 - 1 - lp);
      d[i] = lp * Math.pow(1 - x, 2.2) * Math.exp(-3.2 * x);
    }
    const taps = ch ? [0.019, 0.031, 0.047, 0.071] : [0.015, 0.027, 0.043, 0.064];
    for (let k = 0; k < taps.length; k++) {
      const i = Math.floor(taps[k] * rate);
      if (i < len) d[i] += (ch ? -0.55 : 0.55) / (k + 1);
    }
  }
  return buf;
}

/** tanh soft clip — adds density/grit without hard clipping. */
function softClipCurve(drive, n = 1024) {
  const c = new Float32Array(n);
  const k = Math.tanh(drive);
  for (let i = 0; i < n; i++) c[i] = Math.tanh(drive * ((i / (n - 1)) * 2 - 1)) / k;
  return c;
}

/**
 * Band-limited pulse for amplitude modulation (cricket chirps).
 * Returns the wave plus the base/depth that map its range onto gain 0..1:
 * `gain.value = base; lfo → depth → gain.gain`.
 */
function pulseWave(ctx, duty, harmonics = 14) {
  const real = new Float32Array(harmonics + 1);
  const imag = new Float32Array(harmonics + 1);
  for (let n = 1; n <= harmonics; n++) {
    const s = (Math.PI * n) / (harmonics + 1);
    real[n] = ((2 / (n * Math.PI)) * Math.sin(n * Math.PI * duty) * Math.sin(s)) / s; // Lanczos σ tames ringing
  }
  let lo = Infinity;
  let hi = -Infinity;
  for (let k = 0; k < 512; k++) {
    const ph = (k / 512) * TAU;
    let s = 0;
    for (let n = 1; n <= harmonics; n++) s += real[n] * Math.cos(n * ph);
    lo = Math.min(lo, s);
    hi = Math.max(hi, s);
  }
  const peak = Math.max(Math.abs(lo), Math.abs(hi)) || 1;
  lo /= peak; // the browser normalises the wave to a peak of 1
  hi /= peak;
  return { wave: ctx.createPeriodicWave(real, imag), base: -lo / (hi - lo), depth: 1 / (hi - lo) };
}

/** Notes of one bird phrase. Deterministic per song seed, so songs repeat recognisably. */
function songNotes(type, rng) {
  const notes = [];
  const out = { wave: "sine", notes, am: 0, fm: 0, fmDepth: 0, bp: 0, length: 0 };
  let t = 0;
  const push = (dur, f0, f1, g = 1, attack = 0.012) => {
    notes.push({ t, dur, f0, f1, g, attack });
    t += dur;
  };
  switch (type) {
    case "trill": {
      const f0 = 3200 + rng() * 1800;
      push(0.45 + rng() * 0.6, f0, f0 * (0.8 + rng() * 0.15), 1, 0.04);
      out.am = 22 + rng() * 16;
      break;
    }
    case "twoTone": {
      const b = 2700 + rng() * 900;
      push(0.15, b, b * 1.06);
      t += 0.05;
      push(0.24, b * 0.84, b * 0.66, 0.85);
      break;
    }
    case "warble": {
      const f0 = 2300 + rng() * 900;
      push(0.6 + rng() * 0.5, f0, f0 * (1.05 + rng() * 0.1), 1, 0.05);
      out.fm = 40 + rng() * 50;
      out.fmDepth = 220 + rng() * 320;
      break;
    }
    case "coo": {
      const f = 430 + rng() * 220;
      push(0.26, f, f * 0.96, 0.8, 0.05);
      t += 0.12;
      push(0.2, f * 1.02, f, 0.7, 0.04);
      t += 0.05;
      push(0.45, f, f * 0.9, 0.9, 0.06);
      break;
    }
    case "chip": {
      const f = 4200 + rng() * 1600;
      const n = 5 + Math.floor(rng() * 6);
      const gap = 1 / (8 + rng() * 5);
      for (let i = 0; i < n; i++) {
        push(0.03, f, f * 0.78, 0.8, 0.003);
        t += gap - 0.03;
      }
      break;
    }
    case "kraa": {
      // A distant pterosaur-ish coastal cry: raspy, falling.
      out.wave = "sawtooth";
      out.bp = 1500;
      const f = 900 + rng() * 400;
      const n = 1 + Math.floor(rng() * 3);
      for (let i = 0; i < n; i++) {
        push(0.28 + rng() * 0.12, f * 1.1, f * 0.72, 1, 0.02);
        t += 0.12 + rng() * 0.1;
      }
      out.fm = 28 + rng() * 12;
      out.fmDepth = 60;
      break;
    }
    default: {
      // "whistle": a short melodic phrase of glides.
      const base = 2000 + rng() * 1800;
      const n = 3 + Math.floor(rng() * 4);
      for (let i = 0; i < n; i++) {
        const f0 = base * RATIOS[Math.floor(rng() * RATIOS.length)];
        push(0.07 + rng() * 0.14, f0, f0 * GLIDES[Math.floor(rng() * GLIDES.length)], 0.6 + rng() * 0.4);
        t += 0.03 + rng() * 0.08;
      }
    }
  }
  out.length = t;
  return out;
}

/* --- Voice ---------------------------------------------------------------- */

/**
 * One short-lived sound: owns its nodes, disconnects them all when the last
 * source ends, and can be stolen (quick fade) when the voice cap is reached.
 */
class Voice {
  constructor(engine, priority) {
    this.engine = engine;
    this.ctx = engine.ctx;
    this.priority = priority;
    this.nodes = [];
    this.sources = [];
    this.pending = 0;
    this.end = 0;
    this.born = engine.ctx.currentTime;
    this.done = false;
    this.killed = false;
    this.follow = null; // creature whose position a spatial voice tracks
    this.chain = null; // { lp, pan, g, send, ref } for spatial voices
    this._onEnded = () => {
      if (--this.pending <= 0) this.release();
    };
    this.out = this.gain(1);
  }

  _add(node) {
    this.nodes.push(node);
    this.engine.stats.nodes++;
    this.engine.stats.created++;
    return node;
  }

  gain(value = 1, dest = null) {
    const g = this._add(this.ctx.createGain());
    g.gain.value = Number.isFinite(value) ? value : 0;
    if (dest) g.connect(dest);
    return g;
  }

  filter(type, freq, q = 0.707, dest = null) {
    const f = this._add(this.ctx.createBiquadFilter());
    f.type = type;
    f.frequency.value = hz(freq);
    f.Q.value = q;
    if (dest) f.connect(dest);
    return f;
  }

  shaper(curve, dest = null) {
    const s = this._add(this.ctx.createWaveShaper());
    s.curve = curve;
    s.oversample = "2x";
    if (dest) s.connect(dest);
    return s;
  }

  panner(dest = null) {
    const p = this._add(this.engine._makePanner());
    if (dest) p.connect(dest);
    return p;
  }

  osc(type, freq, t0, t1, dest = null) {
    const o = this.ctx.createOscillator();
    o.type = type;
    o.frequency.value = hz(freq);
    if (dest) o.connect(dest);
    return this._source(o, t0, t1, 0);
  }

  noise(buffer, t0, t1, dest = null, rate = 1) {
    const s = this.ctx.createBufferSource();
    s.buffer = buffer;
    s.playbackRate.value = rate;
    if (dest) s.connect(dest);
    // Stopping a *looping* buffer source clicks in Chrome even behind a closed
    // envelope, so play a random non-looping slice (the shared buffers are long
    // enough for every one-shot); loop only as a fallback.
    const spare = buffer.duration - ((t1 - t0) * rate + 0.06);
    if (spare <= 0) s.loop = true;
    return this._source(s, t0, t1, spare > 0 ? Math.random() * spare : 0);
  }

  _source(node, t0, t1, offset) {
    this._add(node);
    this.sources.push(node);
    this.pending++;
    node.onended = this._onEnded;
    const stop = Math.max(t1, t0 + 0.01);
    if (offset > 0) node.start(t0, offset);
    else node.start(t0);
    node.stop(stop);
    if (stop > this.end) this.end = stop;
    return node;
  }

  /** Steal: fast fade and early stop (the normal onended path then releases). */
  kill(t) {
    if (this.done || this.killed) return;
    this.killed = true;
    const g = this.out.gain;
    g.cancelScheduledValues(t);
    g.setValueAtTime(g.value, t);
    g.linearRampToValueAtTime(0, t + 0.03);
    for (const s of this.sources) {
      try {
        s.stop(t + 0.04);
      } catch {
        /* already stopped */
      }
    }
    this.end = Math.min(this.end, t + 0.04);
  }

  release() {
    if (this.done) return;
    this.done = true;
    for (const n of this.nodes) {
      if (n.onended) n.onended = null;
      try {
        n.disconnect();
      } catch {
        /* already disconnected */
      }
    }
    this.engine.stats.nodes -= this.nodes.length;
    this.nodes.length = 0;
    this.sources.length = 0;
    this.follow = null;
    this.chain = null;
    this.engine._dropVoice(this);
  }
}

/* --- Engine --------------------------------------------------------------- */

export class AudioEngine {
  /**
   * Subscribes to the world event bus right away; handlers stay silent until start().
   * @param {import("../core/events.js").EventBus | null} events world.events
   * @param {{ context?: BaseAudioContext | null }} [opts] inject a context (e.g. an
   *   OfflineAudioContext for tests); otherwise start() creates a real AudioContext.
   */
  constructor(events, { context = null } = {}) {
    this.events = events || null;
    /** True while output is muted (setMuted). */
    this.muted = false;
    /** @type {BaseAudioContext | null} */
    this.ctx = null;
    this.started = false;
    this.failed = false;
    /** Live counters for debugging/tests. */
    this.stats = { voices: 0, active: 0, peakActive: 0, peakVoices: 0, nodes: 0, created: 0, persistent: 0, dropped: 0, stolen: 0, nanBlocked: 0, errors: 0, played: {} };

    this._injected = context;
    this._offline = false;
    this._hidden = false;
    this._persist = [];
    this.voices = [];
    this._S = { gain: 0, pan: 0, cutoff: 20000, wet: 0, dist: 0 }; // scratch for _spatial
    this._surf = { kind: "grass", depth: 0 };
    this.L = { x: 0, y: 0, z: 0, fx: 0, fz: -1, rx: 1, rz: 0, ok: false };
    this.env = { ocean: 600, lake: 600, oceanDx: 0, oceanDz: 1, lakeDx: 0, lakeDz: 1, forest: 0.3, swamp: 0, agl: 2, alt: 0, oceanNear: 0, lakeNear: 0 };
    this._probe = { ring: 0, ocean: Infinity, lake: Infinity, ox: 0, oz: 0, lx: 0, lz: 0, forest: 0, swamp: 0, n: 0, targets: null };
    this._player = null;

    // Accumulators / state machines driven by update().
    this._ctl = 0;
    this._gust = 0.4;
    this._gustTarget = 0.4;
    this._gustT = 0;
    this._cicada = 0.5;
    this._insectT = 0;
    this._day = 0.7;
    this._birdRate = 0;
    this._frogRate = 0;
    this._plipRate = 0;
    this._birdT = 1;
    this._frogT = 2;
    this._plipT = 3;
    this._waveT = 0;
    this._lapT = 0;
    this._stepPhase = 0.6;
    this._swimPhase = 0.5;
    this._chewT = 0;
    this._chewN = 0;
    this._lapDrinkT = 0;
    this._lapN = 0;
    this._eatKind = null;
    this._panting = false;
    this._breathT = 0;
    this._beatT = 0;
    this._lastHurt = -Infinity;
    this._lastGurgle = -Infinity;
    this._dawnPending = false;
    this._npcSteps = new WeakMap();

    this._unsub = [];
    this.setEvents(events);
  }

  /**
   * (Re)bind to an event bus — e.g. when the engine is created at boot (to be
   * unlocked by the first gesture) before the World and its bus exist.
   * @param {import("../core/events.js").EventBus | null} events
   */
  setEvents(events) {
    for (const off of this._unsub) off();
    this._unsub.length = 0;
    this.events = events || null;
    if (events && typeof events.on === "function") this._subscribe(events);
  }

  /* --- Lifecycle ---------------------------------------------------------- */

  /**
   * Create (first call) or resume the AudioContext. Call from a user gesture —
   * iOS only unlocks audio inside one. Idempotent; never throws.
   * @returns {boolean} true when an audio graph exists
   */
  start() {
    if (this.failed) return false;
    if (this.ctx) {
      this._applyRunState();
      return true;
    }
    try {
      let ctx = this._injected;
      if (!ctx) {
        const AC = globalThis.AudioContext || globalThis.webkitAudioContext;
        if (!AC) {
          this.failed = true;
          return false;
        }
        try {
          ctx = new AC({ latencyHint: "interactive" });
        } catch {
          ctx = new AC();
        }
      }
      this.ctx = ctx;
      this._offline = typeof ctx.startRendering === "function";
      this._build();
      this.started = true;
      if (!this._offline) {
        this._unlock();
        this._installLifecycle();
        this._applyRunState();
      }
      return true;
    } catch (err) {
      console.warn("[audio] Web Audio unavailable — running silent.", err);
      this._teardown();
      this.failed = true;
      return false;
    }
  }

  /**
   * Mute/unmute with a short ramp. While muted (or the tab is hidden) the
   * context is suspended so the beds cost no CPU/battery.
   * @param {boolean} muted
   */
  setMuted(muted) {
    this.muted = !!muted;
    const ctx = this.ctx;
    if (!ctx || !this.master) return;
    const t = ctx.currentTime;
    const g = this.master.gain;
    g.cancelScheduledValues(t);
    g.setValueAtTime(g.value, t);
    g.setTargetAtTime(this.muted ? 0 : MASTER_LEVEL, t, 0.08);
    this._applyRunState();
  }

  /** Stop everything, drop listeners and close the context. */
  dispose() {
    this.setEvents(null);
    this._teardown();
  }

  _teardown() {
    this._lifecycleOff?.();
    this._lifecycleOff = null;
    clearTimeout(this._suspendTimer);
    for (const v of this.voices.slice()) v.release();
    for (const n of this._persist) {
      try {
        if (typeof n.stop === "function") n.stop();
      } catch {
        /* never started */
      }
      try {
        n.disconnect();
      } catch {
        /* already gone */
      }
    }
    this._persist.length = 0;
    this.stats.persistent = 0;
    const ctx = this.ctx;
    if (ctx && !this._offline && !this._injected && ctx.state !== "closed") ctx.close().catch(() => {});
    this.ctx = null;
    this.master = null;
    this.started = false;
  }

  /** iOS only starts output after a sound is played inside the unlocking gesture. */
  _unlock() {
    const ctx = this.ctx;
    const s = ctx.createBufferSource();
    s.buffer = ctx.createBuffer(1, 1, ctx.sampleRate);
    s.connect(ctx.destination);
    s.onended = () => s.disconnect();
    s.start(0);
  }

  _installLifecycle() {
    if (typeof window === "undefined" || typeof document === "undefined") return;
    const onVisibility = () => {
      this._hidden = document.visibilityState === "hidden";
      this._applyRunState();
    };
    const onShow = () => {
      this._hidden = false;
      this._applyRunState();
    };
    // iOS can leave the context "interrupted" (calls, Siri, lock screen) and only
    // lets it resume inside a later gesture.
    const onGesture = () => {
      if (this.ctx && this.ctx.state !== "running") this._applyRunState();
    };
    document.addEventListener("visibilitychange", onVisibility);
    window.addEventListener("pageshow", onShow);
    const opts = { passive: true, capture: true };
    for (const ev of ["pointerdown", "touchend", "keydown"]) window.addEventListener(ev, onGesture, opts);
    this.ctx.onstatechange = () => {
      const st = this.ctx?.state;
      if ((st === "suspended" || st === "interrupted") && !this._hidden && !this.muted) {
        clearTimeout(this._retryTimer);
        this._retryTimer = setTimeout(() => this._applyRunState(), 400);
      }
    };
    this._lifecycleOff = () => {
      document.removeEventListener("visibilitychange", onVisibility);
      window.removeEventListener("pageshow", onShow);
      for (const ev of ["pointerdown", "touchend", "keydown"]) window.removeEventListener(ev, onGesture, opts);
      clearTimeout(this._retryTimer);
      if (this.ctx) this.ctx.onstatechange = null;
    };
  }

  /** Resume when wanted (visible & unmuted), otherwise suspend after the fade. */
  _applyRunState() {
    const ctx = this.ctx;
    if (!ctx || this._offline || ctx.state === "closed") return;
    clearTimeout(this._suspendTimer);
    const want = !this._hidden && !this.muted;
    if (want) {
      if (ctx.state !== "running") ctx.resume().catch(() => {});
    } else if (ctx.state === "running") {
      this._suspendTimer = setTimeout(
        () => {
          if ((this._hidden || this.muted) && this.ctx && this.ctx.state === "running") this.ctx.suspend().catch(() => {});
        },
        this._hidden ? 0 : 450,
      );
    }
  }

  _canPlay() {
    return !!this.master && !this.muted && (this._offline || this.ctx.state === "running");
  }

  /* --- Graph -------------------------------------------------------------- */

  _p(node) {
    this._persist.push(node);
    this.stats.persistent++;
    return node;
  }

  _g(value, dest = null) {
    const g = this._p(this.ctx.createGain());
    g.gain.value = value;
    if (dest) g.connect(dest);
    return g;
  }

  _f(type, freq, q, dest = null) {
    const f = this._p(this.ctx.createBiquadFilter());
    f.type = type;
    f.frequency.value = freq;
    f.Q.value = q;
    if (dest) f.connect(dest);
    return f;
  }

  _loop(buffer, dest, rate = 1) {
    const s = this._p(this.ctx.createBufferSource());
    s.buffer = buffer;
    s.loop = true;
    s.playbackRate.value = rate;
    s.connect(dest);
    s.start(0, Math.random() * buffer.duration * 0.9);
    return s;
  }

  _lfo(type, freq, dest) {
    const o = this._p(this.ctx.createOscillator());
    o.type = type;
    o.frequency.value = freq;
    if (dest) o.connect(dest);
    o.start();
    return o;
  }

  /** Pulse-train amplitude modulation of `target` (a GainNode) at `freq`. */
  _pulseAm(pw, freq, target) {
    const lfo = this._p(this.ctx.createOscillator());
    lfo.setPeriodicWave(pw.wave);
    lfo.frequency.value = freq;
    const depth = this._g(pw.depth);
    target.gain.value = pw.base;
    lfo.connect(depth);
    depth.connect(target.gain);
    lfo.start();
    return lfo;
  }

  _makePanner() {
    // StereoPannerNode is missing on very old Safari; a plain gain keeps the graph intact.
    return this.ctx.createStereoPanner ? this.ctx.createStereoPanner() : this.ctx.createGain();
  }

  _build() {
    const ctx = this.ctx;

    // Master: mute gain → gentle bus compression → brickwall-ish limiter → trim.
    this.master = this._g(this.muted ? 0 : MASTER_LEVEL);
    const comp = this._p(ctx.createDynamicsCompressor());
    comp.threshold.value = -20;
    comp.knee.value = 10;
    comp.ratio.value = 3.5;
    comp.attack.value = 0.004;
    comp.release.value = 0.25;
    const limiter = this._p(ctx.createDynamicsCompressor());
    limiter.threshold.value = -3;
    limiter.knee.value = 0;
    limiter.ratio.value = 20;
    limiter.attack.value = 0.0015;
    limiter.release.value = 0.12;
    const trim = this._g(0.8, ctx.destination);
    this.master.connect(comp);
    comp.connect(limiter);
    limiter.connect(trim);

    this.sfxBus = this._g(1, this.master);
    this.uiBus = this._g(0.75, this.master);
    this.ambDuck = this._g(1, this.master);
    this.ambBus = this._g(1, this.ambDuck);

    this.buf = {
      white: noiseBuffer(ctx, 4, 1, "white"),
      pink: noiseBuffer(ctx, 6, 2, "pink"),
      brown: noiseBuffer(ctx, 6, 2, "brown"),
      crackle: crackleBuffer(ctx),
    };
    this.curve = softClipCurve(2.4);
    this.pulse = { cricket: pulseWave(ctx, 0.42), group: pulseWave(ctx, 0.34) };

    // Shared reverb send.
    this.reverbIn = this._g(1);
    const conv = this._p(ctx.createConvolver());
    conv.buffer = impulseResponse(ctx, 2.4);
    this.reverbIn.connect(conv);
    conv.connect(this._g(0.5, this.master));

    this._buildEcho();
    this._buildBeds();

    // Pin channel counts on everything shared. Otherwise a voice's stereo noise
    // stopping changes the mixed channel count downstream, and Chrome reallocates
    // delay lines / compressor look-ahead — an audible click on every tail.
    const pin = (node, n) => {
      node.channelCount = n;
      node.channelCountMode = "explicit";
      node.channelInterpretation = "speakers";
    };
    for (const n of [this.master, this.sfxBus, this.uiBus, this.ambBus, this.ambDuck, this.reverbIn]) pin(n, 2);
    pin(this.echoIn, 1);
  }

  /**
   * Hill echo: two cross-fed delay lines with lowpass in the loop, panned apart,
   * plus a long single "far ridge" tap. Each pass comes back duller and softer,
   * which reads as a roar rolling around the valleys.
   */
  _buildEcho() {
    const ctx = this.ctx;
    this.echoIn = this._g(1);
    const out = this._g(0.55, this.master);
    out.connect(this._g(0.65, this.reverbIn)); // smear the repeats so they roll rather than slap
    const hp = this._f("highpass", 140, 0.7);
    this.echoIn.connect(hp);
    const mk = (time) => {
      const d = this._p(ctx.createDelay(2.5));
      d.delayTime.value = time;
      return d;
    };
    // Mutually prime-ish times so the repeats never settle into a rhythm.
    const dA = mk(0.53);
    const dB = mk(0.83);
    const dC = mk(1.31);
    const lpA = this._f("lowpass", 1400, 0.6);
    const lpB = this._f("lowpass", 1000, 0.6);
    const lpC = this._f("lowpass", 800, 0.6);
    const fbA = this._g(0.44);
    const fbB = this._g(0.44);
    const panA = this._makePanner();
    const panB = this._makePanner();
    this._p(panA);
    this._p(panB);
    if (panA.pan) panA.pan.value = -0.6;
    if (panB.pan) panB.pan.value = 0.55;
    hp.connect(dA);
    hp.connect(dB);
    hp.connect(dC);
    dA.connect(lpA);
    lpA.connect(fbA);
    fbA.connect(dB);
    lpA.connect(panA);
    panA.connect(out);
    dB.connect(lpB);
    lpB.connect(fbB);
    fbB.connect(dA);
    lpB.connect(panB);
    panB.connect(out);
    dC.connect(lpC);
    lpC.connect(this._g(0.45, out));
  }

  /** Continuous ambient layers. Built once; update() only moves their levels. */
  _buildBeds() {
    const amb = this.ambBus;
    const b = this.buf;

    // Wind: stereo pink noise through a gust-steered band, a thin whistle and leaf rustle.
    const wind = (this.wind = {});
    wind.gain = this._g(0, amb);
    wind.lp = this._f("lowpass", 1400, 0.5, wind.gain);
    wind.bp = this._f("bandpass", 380, 0.55, wind.lp);
    this._loop(b.pink, wind.bp);
    wind.wpan = this._p(this._makePanner());
    wind.wpan.connect(amb);
    wind.whistle = this._g(0, wind.wpan);
    wind.wbp = this._f("bandpass", 900, 9, wind.whistle);
    this._loop(b.white, wind.wbp);
    wind.leaves = this._g(0, amb);
    wind.flutter = this._g(0.7, wind.leaves);
    const lhp = this._f("highpass", 2400, 0.5, wind.flutter);
    this._loop(b.pink, lhp, 1.07);
    wind.flutterDepth = this._g(0.2);
    wind.flutterDepth.connect(wind.flutter.gain);
    this._lfo("sine", 5.3, wind.flutterDepth);
    this._lfo("sine", 8.1, wind.flutterDepth);

    // Surf: low swash + foam hiss, shaped per wave by scheduled automation.
    const surf = (this.surf = {});
    surf.pan = this._p(this._makePanner());
    surf.pan.connect(amb);
    surf.level = this._g(0, surf.pan);
    surf.shape = this._g(0.3, surf.level);
    surf.lp = this._f("lowpass", 600, 0.6, surf.shape);
    this._loop(b.pink, surf.lp, 0.93);
    surf.hiss = this._g(0.05, surf.level);
    this._loop(b.white, this._f("highpass", 1800, 0.6, surf.hiss));

    // Lake lapping: band-limited noise with little scheduled lap bumps.
    const lake = (this.lake = {});
    lake.pan = this._p(this._makePanner());
    lake.pan.connect(amb);
    lake.level = this._g(0, lake.pan);
    lake.shape = this._g(0.1, lake.level);
    lake.bp = this._f("bandpass", 600, 1.3, lake.shape);
    this._loop(b.pink, lake.bp, 1.1);

    // Night insects: two cricket pulse trains (chirp groups) and a cicada-ish buzz.
    const ins = (this.insects = {});
    ins.level = this._g(0, amb);
    ins.crickets = [];
    const crickets = [
      { f: 4350, rate: 31, group: 2.2, pan: -0.55 },
      { f: 3870, rate: 27, group: 1.65, pan: 0.6 },
    ];
    for (const c of crickets) {
      const pan = this._p(this._makePanner());
      if (pan.pan) pan.pan.value = c.pan;
      pan.connect(ins.level);
      const am2 = this._g(1, pan);
      const am1 = this._g(1, am2);
      const carrier = this._lfo("sine", c.f, am1);
      const fast = this._pulseAm(this.pulse.cricket, c.rate, am1);
      const group = this._pulseAm(this.pulse.group, c.group, am2);
      ins.crickets.push({ carrier, fast, group, c });
    }
    ins.cicada = this._g(0, ins.level);
    const cam = this._g(0.5, ins.cicada);
    const cicadaDepth = this._g(0.5);
    cicadaDepth.connect(cam.gain);
    this._lfo("sawtooth", 52, cicadaDepth);
    this._loop(b.white, this._f("bandpass", 5800, 5, cam));

    // The player's own body: panting and a low-health heartbeat (centred, dry).
    const br = (this.breath = {});
    br.shape = this._g(0, this.sfxBus);
    br.bp = this._f("bandpass", 900, 1.3, br.shape);
    this._loop(b.white, br.bp);
    const hb = (this.heart = {});
    hb.shape = this._g(0, this.sfxBus);
    const hlp = this._f("lowpass", 190, 0.8, hb.shape);
    hb.osc = this._lfo("triangle", 52, hlp);
  }

  /* --- Events ------------------------------------------------------------- */

  _subscribe(events) {
    const on = (name, fn) => {
      const handler = (e) => {
        if (!this._canPlay()) return;
        try {
          fn.call(this, e || {});
        } catch (err) {
          this.stats.errors++;
          if (this.stats.errors < 4) console.warn(`[audio] "${name}" sound failed`, err);
        }
      };
      const off = events.on(name, handler);
      this._unsub.push(typeof off === "function" ? off : () => events.off?.(name, handler));
    };
    on("call", this._onCall);
    on("attack", this._onAttack);
    on("damage", this._onDamage);
    on("death", this._onDeath);
    on("eat", this._onEat);
    on("grow", this._onGrow);
    on("newDay", this._onNewDay);
    on("sniff", this._onSniff);
    on("legBreak", this._onLegBreak);
  }

  _count(name) {
    this.stats.played[name] = (this.stats.played[name] || 0) + 1;
  }

  _isPlayer(c) {
    return !!c && (c === this._player || c.isPlayer === true);
  }

  _onCall(e) {
    const c = e.creature;
    const call = c?.species?.call;
    if (!call) return;
    const own = this._isPlayer(c);
    const scale = clamp(num(c.scale, 1), 0.1, 2);
    // Per-individual timbre offset, so a herd doesn't sound like one animal copied.
    const voiceJitter = 1 + ((hash(c.id ?? 0) % 1000) / 1000 - 0.5) * 0.1;
    const f = (num(call.pitch, 200) / Math.sqrt(scale)) * voiceJitter * rnd(0.97, 1.03);
    const d = num(call.duration, 1) * (0.75 + 0.25 * scale);
    const w = massWeight(num(c.mass, num(c.species.mass, 500)));
    const pos = c.position;
    const x = num(pos?.x, num(e.x, this.L.x));
    const z = num(pos?.z, num(e.z, this.L.z));
    const y = num(pos?.y, 0) + num(c.species.height, 1.5) * scale;
    this._playCall(call.kind, f, d, w, { own, x, y, z, follow: own ? null : c, level: 1 });
  }

  _onAttack(e) {
    const a = e.attacker;
    if (!a?.position) return;
    const own = this._isPlayer(a);
    const w = massWeight(num(a.mass, 300));
    const kind = e.kind === "tail" || e.kind === "kick" ? e.kind : "bite";
    let v;
    if (own) {
      v = this._voice(0.75);
      if (!v) return;
      this._routeDirect(v, this.sfxBus, 0.08);
      v.out.gain.value = 0.85;
    } else {
      v = this._spatialVoice(a.position.x, a.position.y + 1, a.position.z, 10 + 25 * w, a, 0.85);
      if (!v) return;
    }
    const t = this.ctx.currentTime + LOOKAHEAD;
    this._whoosh(v, t, kind, w);
    if (e.target) {
      const tc = t + (kind === "bite" ? 0.1 : 0.14);
      if (kind === "bite") {
        this._snap(v, tc, w);
        this._crunch(v, tc + 0.02, w, 0.7);
        this._thud(v, tc, w, 0.55);
      } else this._thud(v, tc, Math.min(1, w * 1.1), 1);
    }
    this._count("attack");
  }

  _onDamage(e) {
    if (!this._isPlayer(e.target)) return;
    const type = e.type;
    // Slow attrition is conveyed by breathing/heartbeat, not per-tick hits.
    if (type === "starve" || type === "dehydrate" || type === "bleed") return;
    const now = this.ctx.currentTime;
    const p = e.target;
    const w = massWeight(num(p.mass, 300));
    if (type === "drown") {
      if (now - this._lastGurgle < 1.1) return;
      this._lastGurgle = now;
      this._gurgle(w);
      return;
    }
    if (now - this._lastHurt < 0.22) return;
    this._lastHurt = now;
    const frac = clamp(num(e.amount, 10) / Math.max(1, num(p.maxHealth, 100)), 0, 1);
    const v = this._voice(0.9);
    if (!v) return;
    this._routeDirect(v, this.sfxBus, 0.06);
    v.out.gain.value = lerp(0.55, 1, Math.sqrt(frac));
    const t = now + LOOKAHEAD;
    this._thud(v, t, Math.max(0.35, w), 1.5);
    this._grunt(v, t + 0.02, p, w);
    this._duck(0.25 + frac);
    this._count("damage");
  }

  _onDeath(e) {
    const c = e.creature;
    if (!c) return;
    const own = this._isPlayer(c);
    const w = massWeight(num(c.mass, 300));
    const pos = c.position;
    if (own) {
      this._deathDrone();
      this._breathStop();
    }
    // A last weak cry from dinosaurs (pitch falls away).
    const call = c.species?.call;
    if (call) {
      const scale = clamp(num(c.scale, 1), 0.1, 2);
      const f = (num(call.pitch, 200) / Math.sqrt(scale)) * 0.88;
      const y = num(pos?.y, 0) + num(c.species.height, 1.5) * scale * 0.6;
      this._playCall(call.kind, f, num(call.duration, 1) * 0.55, w, { own, x: num(pos?.x, this.L.x), y, z: num(pos?.z, this.L.z), follow: null, level: 0.55, dying: true });
    }
    // The body hitting the ground, then settling.
    let v;
    let t = this.ctx.currentTime + LOOKAHEAD;
    if (own || !pos) {
      v = this._voice(0.8);
      if (!v) return;
      this._routeDirect(v, this.sfxBus, 0.15);
    } else {
      v = this._spatialVoice(pos.x, pos.y, pos.z, 12 + 30 * w, null, 0.7);
      if (!v) return;
      t += Math.min(0.8, this._S.dist / SOUND_SPEED);
    }
    const fall = lerp(0.25, 0.7, w);
    this._thud(v, t + fall, w, 1.1);
    this._rumble(v, t + fall, w, 0.9);
    this._rustle(v, t + fall * 0.8, 0.5);
    this._thud(v, t + fall + lerp(0.15, 0.35, w), w * 0.8, 0.45);
    this._count("death");
  }

  _onEat(e) {
    if (this._isPlayer(e.creature)) this._eatKind = e.kind === "plant" ? "plant" : "meat";
  }

  _onGrow(e) {
    if (!this._isPlayer(e.creature)) return;
    this._chime(e.stage === "adult");
    this._count("grow");
  }

  _onNewDay() {
    this._dawnPending = true; // played once the light actually comes up (see _dawnCheck)
  }

  _onSniff(e) {
    const c = e.creature;
    if (c && !this._isPlayer(c)) return;
    const w = massWeight(num(c?.mass, 300));
    const v = this._voice(0.6);
    if (!v) return;
    this._routeDirect(v, this.sfxBus, 0.06);
    const t = this.ctx.currentTime + LOOKAHEAD;
    const f = lerp(2400, 800, w);
    const g = v.gain(0, v.out);
    const bp = v.filter("bandpass", f, 1.4, g);
    const sniffs = [[0, 0.1, 0.7], [0.16, 0.1, 0.8], [0.32, 0.11, 0.8], [0.58, 0.42, 0.95]];
    v.noise(this.buf.white, t, t + 1.05, bp);
    g.gain.setValueAtTime(MIN_GAIN, t);
    for (const [s, len, peak] of sniffs) {
      const ts = t + s;
      sweep(bp.frequency, ts, f * 0.8, f * 1.3, len);
      g.gain.setValueAtTime(MIN_GAIN, ts);
      g.gain.linearRampToValueAtTime(peak, ts + len * 0.4);
      g.gain.exponentialRampToValueAtTime(MIN_GAIN, ts + len);
    }
    this._count("sniff");
  }

  _onLegBreak(e) {
    if (!this._isPlayer(e.creature)) return;
    const p = e.creature;
    const w = massWeight(num(p.mass, 300));
    const v = this._voice(0.9);
    if (!v) return;
    this._routeDirect(v, this.sfxBus, 0.1);
    const t = this.ctx.currentTime + LOOKAHEAD;
    const sg = v.gain(0, v.out);
    v.noise(this.buf.white, t, t + 0.06, v.filter("bandpass", 3000, 4, sg));
    pluck(sg.gain, t, 0.0005, 0.8, 0.025);
    this._crunch(v, t + 0.005, 0.3, 1);
    this._thud(v, t, w, 0.5);
    this._grunt(v, t + 0.06, p, w);
    this._count("legBreak");
  }

  /* --- Voices & routing ------------------------------------------------------ */

  /**
   * Allocate a voice, or null when the cap is full of louder sounds. When full,
   * the quietest (weighted by how much of it is left) is stolen.
   */
  _voice(priority) {
    if (!this.master) return null;
    const now = this.ctx.currentTime;
    let active = 0;
    let weakest = null;
    let weakestScore = Infinity;
    for (const v of this.voices) {
      if (v.killed) continue;
      active++;
      const left = v.end > 0 ? clamp((v.end - now) / 0.5, 0.2, 1) : 1;
      const score = v.priority * left;
      if (score < weakestScore) {
        weakestScore = score;
        weakest = v;
      }
    }
    if (active >= MAX_VOICES) {
      if (!weakest || weakestScore >= priority) {
        this.stats.dropped++;
        return null;
      }
      weakest.kill(now);
      this.stats.stolen++;
      active--;
    }
    const v = new Voice(this, priority);
    this.voices.push(v);
    if (this.voices.length > this.stats.peakVoices) this.stats.peakVoices = this.voices.length;
    if (active + 1 > this.stats.peakActive) this.stats.peakActive = active + 1;
    return v;
  }

  _dropVoice(v) {
    const i = this.voices.indexOf(v);
    if (i >= 0) this.voices.splice(i, 1);
  }

  _routeDirect(v, bus, wet = 0, echo = 0) {
    v.out.connect(bus);
    if (wet > 0) v.out.connect(v.gain(wet, this.reverbIn));
    if (echo > 0) v.out.connect(v.gain(echo, this.echoIn));
  }

  /**
   * Distance gain, stereo pan, air-absorption cutoff and reverb send for a point
   * relative to the listener, written into this._S.
   */
  _spatial(x, y, z, ref) {
    const L = this.L;
    const S = this._S;
    const dx = x - L.x;
    const dy = y - L.y;
    const dz = z - L.z;
    const d = Math.sqrt(dx * dx + dy * dy + dz * dz);
    const h = Math.sqrt(dx * dx + dz * dz) || 1;
    const side = (dx * L.rx + dz * L.rz) / h;
    const front = (dx * L.fx + dz * L.fz) / h;
    const fade = 1 - smoothstep(HEAR_RANGE * 0.6, HEAR_RANGE, d);
    S.dist = d;
    S.gain = Math.pow(ref / Math.max(ref, d), 0.9) * fade;
    S.pan = clamp(side * 0.85 * smoothstep(0.5, 4, h), -1, 1);
    // Air eats the highs with distance; the head shadows sounds from behind a little.
    S.cutoff = clamp(20000 * Math.exp(-d / 85), 650, 20000) * (front < 0 ? 1 + 0.35 * front : 1);
    S.wet = lerp(0.08, 0.55, smoothstep(10, 260, d));
    return S;
  }

  /** A voice placed in the world (follows `follow.position` while it plays). */
  _spatialVoice(x, y, z, ref, follow, importance) {
    const S = this._spatial(x, y, z, ref);
    if (S.gain < 0.003) return null;
    const v = this._voice(S.gain * importance);
    if (!v) return null;
    v.out.channelCount = 1; // a point source: mono into the panner
    v.out.channelCountMode = "explicit";
    const lp = v.filter("lowpass", S.cutoff, 0.6);
    const pan = v.panner();
    const g = v.gain(S.gain, this.sfxBus);
    const send = v.gain(S.wet, this.reverbIn);
    v.out.connect(lp);
    lp.connect(pan);
    pan.connect(g);
    g.connect(send);
    if (pan.pan) pan.pan.value = S.pan;
    v.chain = { lp, pan, g, send, ref };
    v.follow = follow && follow.position ? follow : null;
    return v;
  }

  /** A voice for ambient critters: placed by pan/distance only (not world positions). */
  _ambientVoice(priority, pan, dist, wet) {
    const v = this._voice(priority);
    if (!v) return null;
    v.out.channelCount = 1;
    v.out.channelCountMode = "explicit";
    const lp = v.filter("lowpass", clamp(20000 * Math.exp(-dist / 70), 1500, 20000), 0.5);
    const pn = v.panner();
    const g = v.gain(clamp(Math.pow(10 / Math.max(10, dist), 0.8), 0, 1), this.ambBus);
    g.connect(v.gain(wet, this.reverbIn));
    v.out.connect(lp);
    lp.connect(pn);
    pn.connect(g);
    if (pn.pan) pn.pan.value = clamp(pan, -1, 1);
    return v;
  }

  _updateSpatialVoices(now) {
    for (const v of this.voices) {
      const c = v.follow;
      if (!c || !v.chain || v.done) continue;
      const p = c.position;
      if (!p || !Number.isFinite(p.x) || !Number.isFinite(p.z)) continue;
      const S = this._spatial(p.x, num(p.y, this.L.y) + 1.5, p.z, v.chain.ref);
      glide(v.chain.g.gain, S.gain, now, 0.08);
      glide(v.chain.pan.pan, S.pan, now, 0.08);
      glide(v.chain.lp.frequency, S.cutoff, now, 0.1);
      glide(v.chain.send.gain, S.wet, now, 0.2);
    }
  }

  /** Briefly pull the ambience down under a loud sound. */
  _duck(amount) {
    const g = this.ambDuck.gain;
    const t = this.ctx.currentTime;
    g.cancelScheduledValues(t);
    g.setValueAtTime(g.value, t);
    g.setTargetAtTime(clamp(1 - amount, 0.2, 1), t, 0.012);
    g.setTargetAtTime(1, t + 0.3, 1.1);
  }

  /** Failsafe for voices whose sources never reported onended (e.g. context closed). */
  _reap(now) {
    for (let i = this.voices.length - 1; i >= 0; i--) {
      const v = this.voices[i];
      if (now > Math.max(v.end, v.born) + 2) v.release();
    }
  }

  /* --- Per-frame update ------------------------------------------------------- */

  /**
   * Per-frame: listener pose, polled player sounds, ambience scheduling; at
   * CONTROL_DT also bed levels, environment probes and spatial follow.
   * Cheap: AudioParam ramps only; no node churn for continuous sounds.
   * @param {number} dt seconds
   * @param {{ listener?: object, player?: object|null, world?: object|null }} state
   */
  update(dt, { listener = null, player = null, world = null } = {}) {
    const ctx = this.ctx;
    if (!ctx || !this.master) return;
    if (!this._offline && ctx.state !== "running") return;
    dt = clamp(num(dt, 0), 0, 0.1);
    this._player = player || null;
    this._readListener(listener, player);
    const now = ctx.currentTime;

    if (!this.muted) {
      this._pollPlayer(dt, player, world?.terrain, now);
      this._pollNpcSteps(dt, world);
      this._scheduleAmbience(dt, now);
    }
    this._ctl -= dt;
    if (this._ctl <= 0) {
      this._ctl = Math.max(this._ctl + CONTROL_DT, 0.001);
      this._probeEnvironment(world?.terrain);
      this._updateBeds(world, now);
      this._updateSpatialVoices(now);
      this._dawnCheck(world?.sky);
    }
    this._reap(now);
    let active = 0;
    for (const v of this.voices) if (!v.killed) active++;
    this.stats.voices = this.voices.length; // includes stolen voices still fading out (≤ 40 ms)
    this.stats.active = active;
    this.stats.nanBlocked = nanBlocked;
  }

  _readListener(listener, player) {
    const L = this.L;
    const e = listener?.matrixWorld?.elements;
    if (e && Number.isFinite(e[12]) && Number.isFinite(e[14])) {
      L.x = e[12];
      L.y = e[13];
      L.z = e[14];
      // Cameras look down their local -Z.
      const fx = -e[8];
      const fz = -e[10];
      const h = Math.sqrt(fx * fx + fz * fz);
      if (h > 1e-4) {
        L.fx = fx / h;
        L.fz = fz / h;
      }
      L.ok = true;
    } else if (player?.position) {
      L.x = num(player.position.x);
      L.y = num(player.position.y) + 2;
      L.z = num(player.position.z);
      const yaw = num(player.heading, 0);
      L.fx = Math.sin(yaw);
      L.fz = Math.cos(yaw);
      L.ok = true;
    }
    // Right-hand side on the ground plane (forward × up).
    L.rx = -L.fz;
    L.rz = L.fx;
  }

  /**
   * Sample one ring of points around the listener per control tick (a full
   * sweep every ~0.5 s): nearest ocean / fresh water (+ direction), forest and
   * swamp cover, height above ground.
   */
  _probeEnvironment(terrain) {
    const env = this.env;
    if (!terrain || typeof terrain.biomeAt !== "function") {
      env.ocean = damp(env.ocean, 600, 1, CONTROL_DT);
      env.lake = damp(env.lake, 600, 1, CONTROL_DT);
      env.oceanNear = smoothstep(240, 20, env.ocean);
      env.lakeNear = smoothstep(160, 10, env.lake);
      return;
    }
    const L = this.L;
    const pr = this._probe;
    const r = PROBE_RADII[pr.ring];
    const a0 = pr.ring * 0.37; // rotate each ring so the rays interleave
    let ocean = 0;
    let lake = 0;
    let ox = 0;
    let oz = 0;
    let lx = 0;
    let lz = 0;
    for (let k = 0; k < PROBE_POINTS; k++) {
      const a = a0 + (k * TAU) / PROBE_POINTS;
      const dx = Math.sin(a);
      const dz = Math.cos(a);
      const bio = terrain.biomeAt(L.x + dx * r, L.z + dz * r);
      if (bio === "ocean") {
        ocean++;
        ox += dx;
        oz += dz;
      } else if (bio === "lake") {
        lake++;
        lx += dx;
        lz += dz;
      } else if (pr.ring < 4) {
        if (bio === "forest") pr.forest++;
        else if (bio === "swamp") pr.swamp++;
      }
    }
    if (pr.ring < 4) pr.n += PROBE_POINTS;
    if (ocean && pr.ocean === Infinity) {
      pr.ocean = r * (1 - (0.4 * ocean) / PROBE_POINTS);
      pr.ox = ox;
      pr.oz = oz;
    }
    if (lake && pr.lake === Infinity) {
      pr.lake = r * (1 - (0.4 * lake) / PROBE_POINTS);
      pr.lx = lx;
      pr.lz = lz;
    }
    pr.ring++;
    if (pr.ring >= PROBE_RADII.length) {
      const here = terrain.biomeAt(L.x, L.z);
      const t = pr.targets || (pr.targets = {});
      t.ocean = here === "ocean" ? 0 : Math.min(pr.ocean, 600);
      t.lake = here === "lake" ? 0 : Math.min(pr.lake, 600);
      t.forest = pr.n ? pr.forest / pr.n : 0;
      t.swamp = pr.n ? pr.swamp / pr.n : 0;
      if (pr.ox || pr.oz) {
        const h = Math.hypot(pr.ox, pr.oz);
        env.oceanDx = pr.ox / h;
        env.oceanDz = pr.oz / h;
      }
      if (pr.lx || pr.lz) {
        const h = Math.hypot(pr.lx, pr.lz);
        env.lakeDx = pr.lx / h;
        env.lakeDz = pr.lz / h;
      }
      pr.ring = 0;
      pr.ocean = pr.lake = Infinity;
      pr.ox = pr.oz = pr.lx = pr.lz = 0;
      pr.forest = pr.swamp = pr.n = 0;
    }
    const tg = pr.targets;
    if (tg) {
      env.ocean = damp(env.ocean, tg.ocean, 1.2, CONTROL_DT);
      env.lake = damp(env.lake, tg.lake, 1.2, CONTROL_DT);
      env.forest = damp(env.forest, tg.forest, 0.8, CONTROL_DT);
      env.swamp = damp(env.swamp, tg.swamp, 0.8, CONTROL_DT);
    }
    const ground = num(terrain.heightAt?.(L.x, L.z), 0);
    const maxH = num(terrain.maxHeight, 140) || 140;
    env.agl = Math.max(0, L.y - Math.max(ground, num(terrain.seaLevel, 0)));
    env.alt = clamp(ground / maxH, 0, 1);
    env.oceanNear = smoothstep(240, 20, env.ocean);
    env.lakeNear = smoothstep(160, 10, env.lake);
  }

  _updateBeds(world, now) {
    const env = this.env;
    const L = this.L;
    const sky = world?.sky;
    const day = clamp(num(sky?.daylight, 0.7), 0, 1);
    const night = 1 - smoothstep(0.08, 0.5, day);
    this._day = day;
    // Critters live near the ground: fade them when the camera flies high (title flyover).
    const grounded = 1 - smoothstep(25, 90, env.agl);
    const lift = smoothstep(10, 120, env.agl);

    // Gusts: an eased random walk, nudged by the world wind if there is one.
    this._gustT -= CONTROL_DT;
    if (this._gustT <= 0) {
      this._gustT = rnd(1.5, 5);
      const r = Math.random();
      this._gustTarget = r * r * 0.8 + 0.15;
    }
    this._gust = damp(this._gust, this._gustTarget, 0.9, CONTROL_DT);
    const windStrength = world?.wind ? clamp(num(world.wind.strength, 0.5), 0, 1) : 0.5;
    const gust = this._gust;
    const exposure = clamp(0.3 + env.alt * 0.55 + lift * 0.5 + (1 - env.forest) * 0.12 + env.oceanNear * 0.15, 0, 1.3);
    const windLevel = (0.35 + 0.65 * windStrength) * (0.4 + 0.6 * gust) * exposure;
    const w = this.wind;
    glideIf(w.gain.gain, 0.05 + 0.32 * windLevel, now, 0.3);
    glideIf(w.bp.frequency, 220 + 520 * gust + 260 * env.alt, now, 0.45);
    glideIf(w.whistle.gain, 0.05 * smoothstep(0.3, 0.85, windLevel) * (0.35 + env.alt + lift), now, 0.35);
    glideIf(w.wbp.frequency, 620 + 700 * gust + 380 * env.alt, now, 0.6);
    glideIf(w.wpan.pan, Math.sin(now * 0.07) * 0.5, now, 0.5);
    const leaves = env.forest * grounded * (0.3 + 0.7 * gust) * (0.4 + 0.6 * windStrength);
    glideIf(w.leaves.gain, 0.06 * leaves, now, 0.3);
    glideIf(w.flutterDepth.gain, 0.12 + 0.2 * gust, now, 0.4);

    // Water beds, panned toward where the probes found water.
    glideIf(this.surf.level.gain, 0.42 * env.oceanNear * (0.6 + 0.4 * grounded), now, 0.5);
    glideIf(this.surf.pan.pan, 0.8 * clamp(env.oceanDx * L.rx + env.oceanDz * L.rz, -1, 1) * smoothstep(5, 40, env.ocean), now, 0.3);
    glideIf(this.lake.level.gain, 0.3 * env.lakeNear * grounded, now, 0.5);
    glideIf(this.lake.pan.pan, 0.75 * clamp(env.lakeDx * L.rx + env.lakeDz * L.rz, -1, 1) * smoothstep(3, 25, env.lake), now, 0.3);

    // Insects: night chorus, thinner by the open sea.
    const insects = night * grounded * (0.55 + 0.45 * (1 - env.oceanNear));
    glideIf(this.insects.level.gain, 0.085 * insects, now, 1.2);
    this._insectT -= CONTROL_DT;
    if (this._insectT <= 0) {
      // Slow drift (and Dolbear's law: crickets chirp faster when it's warmer — earlier in the night).
      this._insectT = rnd(1.5, 3.5);
      this._cicada = clamp(this._cicada + rnd(-0.35, 0.35), 0.1, 1);
      const warm = lerp(1.12, 0.85, night);
      for (const c of this.insects.crickets) {
        glide(c.group.frequency, c.c.group * warm * rnd(0.95, 1.05), now, 0.8);
        glide(c.carrier.frequency, c.c.f * rnd(0.985, 1.015), now, 0.8);
      }
      glide(this.insects.cicada.gain, 0.55 * this._cicada * (0.4 + 0.6 * smoothstep(0.02, 0.35, day)), now, 1.2);
    }

    // Rates for the scheduled critters.
    const phase = num(sky?.phase, 0.4);
    const dawn = 1 + 1.3 * clamp(1 - Math.abs(phase - 0.285) / 0.06, 0, 1);
    this._birdRate = Math.pow(smoothstep(0.15, 0.7, day), 1.4) * grounded * (0.3 + 0.7 * env.forest) * dawn * (1 - 0.45 * env.oceanNear) * 0.5;
    this._frogRate = (0.2 + 0.8 * night) * grounded * Math.max(env.lakeNear, env.swamp * 1.5) * 0.85;
    this._plipRate = env.lakeNear * grounded * 0.45;
  }

  _scheduleAmbience(dt, now) {
    this._birdT -= dt;
    if (this._birdT <= 0) {
      const r = this._birdRate;
      this._birdT = r > 0.01 ? rnd(0.4, 1.6) / r : 1.5;
      if (r > 0.01) {
        const coastal = this.env.oceanNear > 0.35 && Math.random() < 0.3;
        this._bird(coastal ? SEABIRD : anyOf(SONGS));
      }
    }

    this._frogT -= dt;
    if (this._frogT <= 0) {
      const r = this._frogRate;
      this._frogT = r > 0.01 ? rnd(0.3, 1.7) / r : 2;
      if (r > 0.01) {
        this._frog();
        if (Math.random() < 0.35) this._frogT = Math.min(this._frogT, rnd(0.15, 0.45)); // an answer
      }
    }

    this._plipT -= dt;
    if (this._plipT <= 0) {
      const r = this._plipRate;
      this._plipT = r > 0.01 ? rnd(0.5, 1.5) / r : 3;
      if (r > 0.01) this._plip();
    }

    // Surf: each wave is one scheduled swell → crash → wash on the continuous bed.
    this._waveT -= dt;
    if (this._waveT <= 0) {
      const period = rnd(6.5, 10.5);
      this._waveT = period;
      if (this.env.oceanNear > 0.01) this._wave(now + LOOKAHEAD, period);
    }
    this._lapT -= dt;
    if (this._lapT <= 0) {
      this._lapT = rnd(0.22, 0.8);
      if (this.env.lakeNear > 0.01) this._lap(now + LOOKAHEAD);
    }
  }

  _wave(t, period) {
    const s = this.surf;
    const crash = t + period * rnd(0.5, 0.6);
    const sg = s.shape.gain;
    sg.cancelScheduledValues(t);
    sg.setTargetAtTime(rnd(0.3, 0.45), t, period * 0.15);
    sg.setTargetAtTime(rnd(0.85, 1.1), crash - 0.4, 0.3);
    sg.setTargetAtTime(0.22, crash + 0.5, period * 0.12);
    const lf = s.lp.frequency;
    lf.cancelScheduledValues(t);
    lf.setTargetAtTime(480, t, 0.8);
    lf.setTargetAtTime(rnd(1100, 1500), crash - 0.2, 0.25);
    lf.setTargetAtTime(520, crash + 0.6, 0.9);
    const hg = s.hiss.gain;
    hg.cancelScheduledValues(t);
    hg.setTargetAtTime(0.03, t, 0.5);
    hg.setTargetAtTime(rnd(0.35, 0.5), crash, 0.1);
    hg.setTargetAtTime(0.02, crash + 0.35, period * 0.13);
  }

  _lap(t) {
    const k = this.lake;
    glide(k.bp.frequency, rnd(350, 1100), t, 0.02);
    glide(k.shape.gain, rnd(0.45, 1), t, 0.03);
    glide(k.shape.gain, 0.08, t + rnd(0.06, 0.12), rnd(0.08, 0.2));
  }

  _bird(song) {
    const ph = songNotes(song.type, makeRng(song.seed));
    if (!ph.notes.length) return;
    const v = this._ambientVoice(0.05 + 0.12 * song.level, rnd(-0.9, 0.9), rnd(14, 75), 0.35);
    if (!v) return;
    v.out.gain.value = song.level;
    const t = this.ctx.currentTime + LOOKAHEAD + rnd(0, 0.04);
    const tempo = rnd(0.94, 1.06);
    const end = t + ph.length * tempo + 0.06;
    const amp = v.gain(0);
    if (ph.bp) amp.connect(v.filter("bandpass", ph.bp, 1.4, v.gain(2.2, v.out)));
    else amp.connect(v.out);
    let am = amp;
    if (ph.am) {
      am = v.gain(0.5, amp);
      const depth = v.gain(0.5, am.gain);
      v.osc("sine", ph.am, t, end, depth);
    }
    const o = v.osc(ph.wave, ph.notes[0].f0, t, end, am);
    if (ph.fm) {
      const depth = v.gain(ph.fmDepth, o.frequency);
      v.osc("sine", ph.fm, t, end, depth);
    }
    amp.gain.setValueAtTime(MIN_GAIN, t);
    for (const n of ph.notes) {
      const tn = t + n.t * tempo;
      const len = n.dur * tempo;
      sweep(o.frequency, tn, n.f0, n.f1, len);
      amp.gain.setValueAtTime(MIN_GAIN, tn);
      amp.gain.linearRampToValueAtTime(n.g, tn + Math.min(n.attack, len * 0.4));
      amp.gain.exponentialRampToValueAtTime(MIN_GAIN, tn + len);
    }
    this._count("bird");
  }

  _frog() {
    const env = this.env;
    const r = Math.random();
    const type = env.swamp > 0.25 && r < 0.35 ? "bull" : r > 0.72 ? "peep" : "ribbit";
    const towardLake = clamp(env.lakeDx * this.L.rx + env.lakeDz * this.L.rz, -1, 1) * 0.6;
    const v = this._ambientVoice(0.06, towardLake + rnd(-0.5, 0.5), rnd(8, 45), 0.25);
    if (!v) return;
    const t = this.ctx.currentTime + LOOKAHEAD;
    const amp = v.gain(0, v.out);
    if (type === "bull") {
      // Bullfrog "rumm": a low buzzy tone pulsed ~16 Hz.
      const f = rnd(80, 115);
      const len = rnd(0.45, 0.7);
      v.out.gain.value = 0.9;
      const lp = v.filter("lowpass", 520, 1.5, amp);
      const pulse = v.gain(0.5, lp);
      v.osc("sawtooth", f, t, t + len + 0.05, pulse);
      v.osc("sine", rnd(14, 19), t, t + len + 0.05, v.gain(0.5, pulse.gain));
      swell(amp.gain, t, 0.05, 0.9, len - 0.2, 0.15);
    } else if (type === "peep") {
      v.out.gain.value = 0.25;
      const o = v.osc("sine", 2600, t, t + 0.45, amp);
      amp.gain.setValueAtTime(MIN_GAIN, t);
      for (const s of [0, 0.26]) {
        sweep(o.frequency, t + s, rnd(2450, 2650), rnd(3000, 3200), 0.09);
        amp.gain.setValueAtTime(MIN_GAIN, t + s);
        amp.gain.linearRampToValueAtTime(1, t + s + 0.01);
        amp.gain.exponentialRampToValueAtTime(MIN_GAIN, t + s + 0.1);
      }
    } else {
      // "Ribbit": two or three nasal pulses.
      const f = rnd(260, 420);
      const n = Math.random() < 0.5 ? 2 : 3;
      v.out.gain.value = 0.55;
      const mix = v.gain(1);
      mix.connect(v.filter("bandpass", f * 2.8, 6, v.gain(2.2, amp)));
      mix.connect(v.filter("bandpass", f * 5.5, 8, v.gain(0.9, amp)));
      const o = v.osc("sawtooth", f, t, t + n * 0.085 + 0.05, mix);
      amp.gain.setValueAtTime(MIN_GAIN, t);
      for (let i = 0; i < n; i++) {
        const ti = t + i * 0.085;
        sweep(o.frequency, ti, f * 0.9, f * 1.05, 0.05);
        amp.gain.setValueAtTime(MIN_GAIN, ti);
        amp.gain.linearRampToValueAtTime(1, ti + 0.008);
        amp.gain.exponentialRampToValueAtTime(MIN_GAIN, ti + 0.055);
      }
    }
    this._count("frog");
  }

  /** A single water drop near the shore: the classic rising "plip". */
  _plip() {
    const env = this.env;
    const pan = clamp(env.lakeDx * this.L.rx + env.lakeDz * this.L.rz, -1, 1) * 0.6 + rnd(-0.3, 0.3);
    const v = this._ambientVoice(0.03, pan, rnd(6, 30), 0.2);
    if (!v) return;
    v.out.gain.value = 0.22;
    const t = this.ctx.currentTime + LOOKAHEAD;
    const g = v.gain(0, v.out);
    const o = v.osc("sine", 700, t, t + 0.1, g);
    const f = rnd(550, 900);
    sweep(o.frequency, t, f, f * rnd(1.8, 2.4), 0.04);
    pluck(g.gain, t, 0.002, 1, 0.07);
  }

  _dawnCheck(sky) {
    if (!this._dawnPending) return;
    const phase = num(sky?.phase, NaN);
    if (Number.isFinite(phase) && phase < 0.2) return; // fired at midnight: wait for first light
    this._dawnPending = false;
    if (Number.isFinite(phase) && phase > 0.45) return; // missed the morning — skip
    if (!this.muted) this._dawnSwell();
  }

  /* --- Player polling ----------------------------------------------------------- */

  _pollPlayer(dt, p, terrain, now) {
    if (!p || p.alive === false || !p.position) {
      this._breathStop();
      return;
    }
    const sp = p.species || {};
    const w = massWeight(num(p.mass, num(sp.mass, 85)));
    const speed = num(p.speed, 0);
    const gait = p.gait;

    // Footfalls / swim strokes, paced by distance travelled.
    if (p.swimming) {
      const swimSpeed = Math.max(0.5, num(sp.speed?.swim, 1.5));
      if (speed > 0.25) {
        this._swimPhase += dt * lerp(0.8, 1.9, clamp(speed / swimSpeed, 0, 1)) * lerp(1.2, 0.7, w);
        if (this._swimPhase >= 1) {
          this._swimPhase -= 1;
          this._splash(w, 0.8);
        }
      }
      this._stepPhase = 0.6;
    } else if (speed > 0.2) {
      const h = num(sp.height, 1.2) * clamp(num(p.scale, 1), 0.05, 2);
      let stride = h * (gait === "sprint" ? 1.45 : gait === "trot" ? 1.1 : 0.8);
      stride = Math.max(stride, speed * 0.14); // never more than ~7 footfalls a second
      this._stepPhase += (speed * dt) / stride;
      if (this._stepPhase >= 1) {
        this._stepPhase -= Math.floor(this._stepPhase);
        const loud = (gait === "sprint" ? 1 : gait === "trot" ? 0.8 : 0.6) * (p.crouching ? 0.5 : 1);
        this._footstep(p.position, w, loud, terrain, true, sp.body?.plan === "quadruped");
      }
    } else this._stepPhase = Math.min(this._stepPhase, 0.6); // first step after a stop lands promptly

    // Eating / drinking loops.
    if (p.eating) {
      this._chewT -= dt;
      if (this._chewT <= 0) {
        this._chewT = rnd(0.17, 0.34) * lerp(0.8, 1.5, w);
        const kind = this._eatKind || (p.species?.diet === "herbivore" ? "plant" : "meat");
        if (++this._chewN % 7 === 0) this._gulp(w);
        else this._chew(kind, w);
      }
    } else this._chewT = 0.05;
    if (p.drinking) {
      this._lapDrinkT -= dt;
      if (this._lapDrinkT <= 0) {
        this._lapDrinkT = rnd(0.3, 0.42) * lerp(0.8, 1.6, w);
        if (++this._lapN % 5 === 0) this._gulp(w);
        else this._drinkLap(w);
      }
    } else this._lapDrinkT = 0.05;

    // Panting below ~22% stamina (hysteresis so it doesn't flicker).
    const stamina = num(p.stamina, 100);
    if (!this._panting && stamina < 22) this._panting = true;
    else if (this._panting && stamina > 45) this._panting = false;
    if (this._panting) {
      this._breathT -= dt;
      if (this._breathT <= 0) {
        const tired = clamp(1 - stamina / 45, 0, 1);
        const period = lerp(1.5, 0.72, tired) * lerp(0.75, 1.5, w);
        this._breathT = period;
        this._breath(now + LOOKAHEAD, period, tired, w);
      }
    }

    // Heartbeat below 30% health — faster and louder as it drops.
    const frac = num(p.health, 1) / Math.max(1, num(p.maxHealth, 100));
    if (frac > 0 && frac < 0.3) {
      this._beatT -= dt;
      if (this._beatT <= 0) {
        const danger = 1 - frac / 0.3;
        this._beatT = 60 / lerp(66, 122, danger);
        this._heartbeat(now + LOOKAHEAD, danger);
      }
    } else this._beatT = 0;
  }

  /** Heavy dinosaurs near the listener: feel them coming before you see them. */
  _pollNpcSteps(dt, world) {
    const list = world?.ecosystem?.creatures;
    if (!Array.isArray(list)) return;
    const L = this.L;
    for (let i = 0; i < list.length; i++) {
      const c = list[i];
      if (!c || c === this._player || c.isPlayer || c.alive === false || !c.position) continue;
      const mass = num(c.mass, 0);
      if (mass < 350 || c.swimming) continue;
      const dx = c.position.x - L.x;
      const dz = c.position.z - L.z;
      if (dx * dx + dz * dz > 8100) continue; // 90 m
      const speed = num(c.speed, 0);
      if (speed < 0.3) continue;
      const sp = c.species || {};
      const h = num(sp.height, 1.5) * clamp(num(c.scale, 1), 0.05, 2);
      const stride = Math.max(h * (c.gait === "sprint" ? 1.45 : c.gait === "trot" ? 1.1 : 0.8), speed * 0.14);
      let ph = this._npcSteps.get(c);
      if (ph === undefined) ph = Math.random();
      ph += (speed * dt) / stride;
      if (ph >= 1) {
        ph -= Math.floor(ph);
        const loud = c.gait === "sprint" ? 1 : c.gait === "trot" ? 0.8 : 0.6;
        this._footstep(c.position, massWeight(mass), loud, world.terrain, false, sp.body?.plan === "quadruped");
      }
      this._npcSteps.set(c, ph);
    }
  }

  /** What's underfoot at (x, z): grass | forest | rock | sand | mud | water. */
  _surface(terrain, x, z) {
    const s = this._surf;
    s.kind = "grass";
    s.depth = 0;
    if (!terrain) return s;
    const depth = num(terrain.waterDepthAt?.(x, z), 0);
    if (depth > 0.06) {
      s.kind = "water";
      s.depth = depth;
      return s;
    }
    const b = typeof terrain.biomeAt === "function" ? terrain.biomeAt(x, z) : "plains";
    if (b === "rock") s.kind = "rock";
    else if (b === "highland") s.kind = num(terrain.slopeAt?.(x, z), 0) > 0.28 ? "rock" : "grass";
    else if (b === "beach") s.kind = "sand";
    else if (b === "swamp") s.kind = "mud";
    else if (b === "forest") s.kind = "forest";
    return s;
  }

  _footstep(pos, w, loud, terrain, own, quad) {
    const surf = this._surface(terrain, pos.x, pos.z);
    let v;
    if (own) {
      v = this._voice(0.4 + 0.25 * w);
      if (!v) return;
      this._routeDirect(v, this.sfxBus, 0.04 + 0.1 * w);
      v.out.gain.value = loud * lerp(0.45, 1, w);
    } else {
      v = this._spatialVoice(pos.x, pos.y, pos.z, 6 + 22 * w, null, 0.45);
      if (!v) return;
      v.out.gain.value = loud;
    }
    const t = this.ctx.currentTime + LOOKAHEAD;
    this._stepLayers(v, t, w, surf);
    // Quadrupeds: hind then lighter fore footfall.
    if (quad) this._stepLayers(v, t + lerp(0.07, 0.15, w), w * 0.85, surf, 0.6);
    this._count("step");
  }

  _stepLayers(v, t, w, surf, k = 1) {
    // Impact thud — pitch and length scale with weight.
    const thudHz = lerp(240, 38, w);
    const thudLen = lerp(0.04, 0.42, w);
    const thudAmp = lerp(0.08, 0.9, Math.pow(w, 1.2)) * k;
    const tg = v.gain(0, v.out);
    const o = v.osc("sine", thudHz, t, t + thudLen + 0.05, tg);
    sweep(o.frequency, t, thudHz * 1.35, thudHz * 0.62, thudLen);
    pluck(tg.gain, t, 0.004, thudAmp, thudLen);
    if (w > 0.5) {
      // An overtone so heavy steps still read on small speakers.
      const og = v.gain(0, v.out);
      v.osc("triangle", thudHz * 2.6, t, t + thudLen * 0.6 + 0.05, og);
      pluck(og.gain, t, 0.004, thudAmp * 0.25, thudLen * 0.6);
    }
    // Surface texture.
    const ng = v.gain(0, v.out);
    const kind = surf.kind;
    if (kind === "water") {
      const bp = v.filter("bandpass", 2400, 1.1, ng);
      const len = lerp(0.16, 0.42, w) * clamp(0.6 + surf.depth, 0.6, 1.4);
      v.noise(this.buf.white, t, t + len + 0.05, bp);
      sweep(bp.frequency, t, 2600, 650, len);
      pluck(ng.gain, t, 0.006, 0.55 * k, len);
      const pg = v.gain(0, v.out);
      v.noise(this.buf.pink, t, t + 0.3, v.filter("lowpass", 450, 0.8, pg));
      pluck(pg.gain, t + 0.01, 0.01, 0.4 * k, 0.22);
    } else if (kind === "rock") {
      const bp = v.filter("bandpass", lerp(3800, 1600, w), 2.5, ng);
      v.noise(this.buf.white, t, t + 0.1, bp);
      pluck(ng.gain, t, 0.001, 0.55 * k, 0.045);
    } else if (kind === "sand") {
      v.noise(this.buf.white, t, t + 0.2, v.filter("highpass", 2600, 0.6, ng));
      pluck(ng.gain, t, 0.012, 0.28 * k, lerp(0.1, 0.18, w));
    } else if (kind === "mud") {
      const lp = v.filter("lowpass", 1300, 2.5, ng);
      v.noise(this.buf.pink, t, t + 0.25, lp);
      sweep(lp.frequency, t, 1300, 280, 0.18);
      pluck(ng.gain, t, 0.01, 0.6 * k, lerp(0.14, 0.24, w));
    } else if (kind === "forest") {
      v.noise(this.buf.crackle, t, t + 0.18, v.filter("bandpass", lerp(2800, 1500, w), 0.8, ng));
      pluck(ng.gain, t, 0.004, 0.55 * k, lerp(0.08, 0.14, w));
      const lg = v.gain(0, v.out);
      v.noise(this.buf.white, t, t + 0.15, v.filter("highpass", 3800, 0.6, lg));
      pluck(lg.gain, t, 0.01, 0.12 * k, 0.1);
    } else {
      v.noise(this.buf.white, t, t + 0.2, v.filter("bandpass", lerp(3200, 1400, w), 0.9, ng));
      pluck(ng.gain, t, 0.006, lerp(0.3, 0.45, w) * k, lerp(0.07, 0.16, w));
    }
    // Heavy animals: a sub rumble you feel through the ground.
    if (w > 0.55) this._rumble(v, t, w, k);
  }

  _splash(w, k) {
    const v = this._voice(0.45);
    if (!v) return;
    this._routeDirect(v, this.sfxBus, 0.08);
    v.out.gain.value = k;
    const t = this.ctx.currentTime + LOOKAHEAD;
    const len = lerp(0.22, 0.5, w);
    const ng = v.gain(0, v.out);
    const bp = v.filter("bandpass", 1800, 0.9, ng);
    v.noise(this.buf.white, t, t + len + 0.05, bp);
    sweep(bp.frequency, t, 2200, 550, len);
    pluck(ng.gain, t, 0.01, 0.5, len);
    const pg = v.gain(0, v.out);
    v.noise(this.buf.pink, t, t + 0.4, v.filter("lowpass", 480, 0.8, pg));
    pluck(pg.gain, t, 0.015, 0.45, 0.3);
    // A couple of bubbles.
    const bg = v.gain(0, v.out);
    const o = v.osc("sine", 600, t + 0.08, t + 0.3, bg);
    sweep(o.frequency, t + 0.08, rnd(450, 650), rnd(1000, 1300), 0.05);
    sweep(o.frequency, t + 0.18, rnd(500, 700), rnd(1100, 1500), 0.04);
    pluck(bg.gain, t + 0.08, 0.002, 0.08, 0.06);
    bg.gain.setValueAtTime(MIN_GAIN, t + 0.18);
    bg.gain.linearRampToValueAtTime(0.06, t + 0.182);
    bg.gain.exponentialRampToValueAtTime(MIN_GAIN, t + 0.24);
    this._count("splash");
  }

  _chew(kind, w) {
    const v = this._voice(0.35);
    if (!v) return;
    this._routeDirect(v, this.sfxBus, 0.04);
    v.out.gain.value = lerp(0.45, 0.8, w);
    const t = this.ctx.currentTime + LOOKAHEAD;
    if (kind === "meat") {
      // Wet tearing plus a gristly squelch.
      const len = rnd(0.12, 0.22);
      const tg = v.gain(0, v.out);
      const bp = v.filter("bandpass", lerp(1300, 600, w), 1.6, tg);
      v.noise(this.buf.pink, t, t + len + 0.05, bp);
      sweep(bp.frequency, t, lerp(1300, 600, w), lerp(650, 280, w), len);
      pluck(tg.gain, t, 0.015, 0.75, len);
      const sg = v.gain(0, v.out);
      v.noise(this.buf.crackle, t, t + 0.12, v.filter("lowpass", 1100, 0.8, sg));
      pluck(sg.gain, t + 0.02, 0.004, 0.55, 0.08);
    } else {
      // Fibrous crunch and a leafy rustle.
      const cg = v.gain(0, v.out);
      v.noise(this.buf.crackle, t, t + 0.18, v.filter("bandpass", lerp(3200, 1600, w), 0.8, cg));
      pluck(cg.gain, t, 0.003, 0.8, rnd(0.07, 0.13));
      const lg = v.gain(0, v.out);
      v.noise(this.buf.white, t, t + 0.15, v.filter("highpass", 4500, 0.6, lg));
      pluck(lg.gain, t, 0.01, 0.18, 0.1);
    }
    this._count("chew");
  }

  _drinkLap(w) {
    const v = this._voice(0.35);
    if (!v) return;
    this._routeDirect(v, this.sfxBus, 0.06);
    v.out.gain.value = lerp(0.5, 0.85, w);
    const t = this.ctx.currentTime + LOOKAHEAD;
    const tg = v.gain(0, v.out);
    const bp = v.filter("bandpass", 600, 4, tg);
    v.noise(this.buf.white, t, t + 0.1, bp);
    sweep(bp.frequency, t, lerp(700, 400, w), lerp(1700, 900, w), 0.06);
    pluck(tg.gain, t, 0.003, 0.6, 0.06);
    const pg = v.gain(0, v.out);
    const o = v.osc("sine", 800, t + 0.03, t + 0.12, pg);
    const f = lerp(1100, 500, w) * rnd(0.9, 1.1);
    sweep(o.frequency, t + 0.03, f, f * 1.9, 0.035);
    pluck(pg.gain, t + 0.03, 0.002, 0.3, 0.05);
    this._count("lap");
  }

  _gulp(w) {
    const v = this._voice(0.35);
    if (!v) return;
    this._routeDirect(v, this.sfxBus, 0.03);
    v.out.gain.value = lerp(0.5, 0.9, w);
    const t = this.ctx.currentTime + LOOKAHEAD;
    const g = v.gain(0, v.out);
    const o = v.osc("sine", 200, t, t + 0.2, g);
    sweep(o.frequency, t, lerp(240, 120, w), lerp(110, 60, w), 0.13);
    pluck(g.gain, t, 0.01, 0.7, 0.14);
    const ng = v.gain(0, v.out);
    v.noise(this.buf.pink, t, t + 0.2, v.filter("lowpass", 420, 1, ng));
    pluck(ng.gain, t, 0.01, 0.3, 0.12);
  }

  _breath(t, period, tired, w) {
    const b = this.breath;
    const f = lerp(1500, 360, w);
    const inLen = period * 0.38;
    const outLen = period * 0.5;
    const peak = lerp(0.3, 0.8, tired) * lerp(0.8, 1.2, w);
    const g = b.shape.gain;
    g.cancelScheduledValues(t);
    g.setValueAtTime(MIN_GAIN, t);
    g.linearRampToValueAtTime(peak * 0.55, t + inLen * 0.6);
    g.exponentialRampToValueAtTime(MIN_GAIN, t + inLen);
    g.linearRampToValueAtTime(peak, t + inLen + outLen * 0.25);
    g.exponentialRampToValueAtTime(MIN_GAIN, t + inLen + outLen);
    const bf = b.bp.frequency;
    bf.cancelScheduledValues(t);
    bf.setValueAtTime(f * 0.8, t);
    bf.linearRampToValueAtTime(f * 1.15, t + inLen);
    bf.linearRampToValueAtTime(f, t + inLen + outLen);
  }

  _breathStop() {
    if (!this._panting || !this.breath) return;
    this._panting = false;
    const g = this.breath.shape.gain;
    const t = this.ctx.currentTime;
    g.cancelScheduledValues(t);
    g.setValueAtTime(g.value, t);
    g.setTargetAtTime(0, t, 0.1);
  }

  _heartbeat(t, danger) {
    const h = this.heart;
    const g = h.shape.gain;
    const f = h.osc.frequency;
    const peak = lerp(0.28, 0.62, danger);
    // lub
    g.setValueAtTime(MIN_GAIN, t);
    g.linearRampToValueAtTime(peak, t + 0.012);
    g.exponentialRampToValueAtTime(MIN_GAIN, t + 0.13);
    f.setValueAtTime(72, t);
    f.exponentialRampToValueAtTime(46, t + 0.1);
    // dub
    const t2 = t + 0.26;
    g.setValueAtTime(MIN_GAIN, t2);
    g.linearRampToValueAtTime(peak * 0.7, t2 + 0.012);
    g.exponentialRampToValueAtTime(MIN_GAIN, t2 + 0.12);
    f.setValueAtTime(64, t2);
    f.exponentialRampToValueAtTime(44, t2 + 0.09);
  }

  /* --- Call synthesis ------------------------------------------------------------- */

  /**
   * Play a species call. `f` base pitch (already scaled for size), `d` seconds,
   * `w` size weight 0..1. Own calls are loud and centred; others are placed in
   * the world.
   */
  _playCall(kind, f, d, w, o) {
    const synth = this._callSynth(kind);
    f = clamp(num(f, 200), 25, 4000);
    d = clamp(num(d, 1), 0.15, 5);
    let v;
    if (o.own) {
      v = this._voice(0.95);
      if (!v) return;
      this._routeDirect(v, this.sfxBus, 0.18, w > 0.6 ? 0.12 : 0);
      v.out.gain.value = 0.85 * o.level;
    } else {
      v = this._spatialVoice(o.x, o.y, o.z, 6 + 28 * w, o.follow, 0.9 * o.level);
      if (!v) return;
      v.out.gain.value = o.level;
      if (w > 0.6) v.out.connect(v.gain(0.1 * this._S.gain, this.echoIn)); // big calls roll off the hills
    }
    const t = this.ctx.currentTime + LOOKAHEAD;
    const level = v.gain(CALL_LEVEL[kind] ?? 0.8, v.out);
    synth.call(this, v, level, t, f, d, w, !!o.dying);
    this._count(`call:${kind}`);
  }

  _callSynth(kind) {
    switch (kind) {
      case "roar":
        return this._roar;
      case "bellow":
        return this._bellow;
      case "honk":
        return this._honk;
      case "chirp":
        return this._chirp;
      case "shriek":
        return this._shriek;
      case "rumble":
        return this._rumbleCall; // (_rumble is the footfall sub)
      case "rattle":
        return this._rattle;
      default:
        return this._hoot;
    }
  }

  /** Roar: detuned saws + breath noise, growl tremolo, saturation, formant bands, pitch rise-then-drop. */
  _roar(v, dest, t, f, d, w, dying) {
    const end = t + d;
    const shape = dying ? SHAPE_DYING : SHAPE_ROAR;
    const mix = v.gain(0.9, dest);
    const sh = v.shaper(this.curve);
    const mouth = v.filter("lowpass", 700, 0.8, v.gain(0.55, mix));
    sh.connect(mouth);
    const formants = [
      [clamp(f * 3.4, 180, 900), 2.2, 0.9],
      [lerp(1250, 650, w), 3, 0.6],
      [lerp(2600, 1500, w), 4, 0.3],
    ];
    for (const [ff, q, g] of formants) sh.connect(v.filter("bandpass", ff, q, v.gain(g, mix)));
    sweep(mouth.frequency, t, lerp(900, 450, w), lerp(3200, 1800, w), d * 0.25);
    mouth.frequency.exponentialRampToValueAtTime(lerp(900, 420, w), end);
    const amp = v.gain(0, sh);
    const trem = v.gain(0.7, amp);
    v.osc("sine", lerp(28, 15, w) * rnd(0.9, 1.1), t, end + 0.05, v.gain(0.3, trem.gain));
    const pre = v.gain(0.42, trem);
    for (const k of [1, 1.009, 0.991]) contour(v.osc("sawtooth", f * k, t, end + 0.05, pre).frequency, t, f * k, d, shape);
    contour(v.osc("sine", f * 0.5, t, end + 0.05, v.gain(0.9, pre)).frequency, t, f * 0.5, d, shape);
    v.noise(this.buf.pink, t, end + 0.05, v.filter("bandpass", lerp(1400, 800, w), 0.7, v.gain(0.9, pre)));
    amp.gain.setValueAtTime(MIN_GAIN, t);
    amp.gain.linearRampToValueAtTime(1, t + d * 0.12);
    amp.gain.setValueAtTime(1, t + d * 0.5);
    amp.gain.exponentialRampToValueAtTime(0.3, t + d * 0.88);
    amp.gain.linearRampToValueAtTime(0, end);
  }

  /** Bellow: deep sustained tones with vibrato; upper harmonics keep it audible on small speakers. */
  _bellow(v, dest, t, f, d, w, dying) {
    const end = t + d;
    const shape = dying ? SHAPE_DYING : SHAPE_BELLOW;
    const amp = v.gain(0, dest);
    const lp = v.filter("lowpass", Math.max(320, f * 5), 1.1, amp);
    const form = v.filter("bandpass", lerp(650, 330, w), 4, v.gain(0.7, amp));
    const mix = v.gain(0.4);
    mix.connect(lp);
    mix.connect(form);
    const vib = v.gain(22);
    v.osc("sine", rnd(3.8, 5), t, end + 0.05, vib);
    const parts = [["sawtooth", 1, 0.8], ["triangle", 1.004, 0.7], ["sine", 2, 0.35], ["sine", 3, 0.2]];
    if (f * 0.5 >= 28) parts.push(["sine", 0.5, 0.7]);
    for (const [type, k, g] of parts) {
      const o = v.osc(type, f * k, t, end + 0.05, v.gain(g, mix));
      contour(o.frequency, t, f * k, d, shape);
      vib.connect(o.detune);
    }
    v.noise(this.buf.pink, t, end + 0.05, v.filter("lowpass", 500, 0.7, v.gain(0.14, amp)));
    sweep(lp.frequency, t, Math.max(250, f * 3), Math.max(420, f * 7), d * 0.4);
    lp.frequency.exponentialRampToValueAtTime(Math.max(250, f * 3), end);
    amp.gain.setValueAtTime(MIN_GAIN, t);
    amp.gain.linearRampToValueAtTime(1, t + d * 0.28);
    amp.gain.setValueAtTime(1, t + d * 0.62);
    amp.gain.exponentialRampToValueAtTime(MIN_GAIN, end);
  }

  /** Honk: nasal resonant bursts (saw + square through narrow formants). */
  _honk(v, dest, t, f, d, w, dying) {
    const n = d < 0.55 ? 2 : 3;
    const slot = d / n;
    const len = slot * 0.74;
    const end = t + d;
    const amp = v.gain(0, dest);
    const mix = v.gain(0.5);
    mix.connect(v.filter("bandpass", f * 3.2, 7, v.gain(1.4, amp)));
    mix.connect(v.filter("bandpass", f * 5.4, 9, v.gain(0.8, amp)));
    mix.connect(v.filter("lowpass", f * 1.8, 0.7, v.gain(0.35, amp)));
    const o1 = v.osc("sawtooth", f, t, end + 0.05, mix);
    const o2 = v.osc("square", f * 1.006, t, end + 0.05, v.gain(0.45, mix));
    amp.gain.setValueAtTime(MIN_GAIN, t);
    for (let i = 0; i < n; i++) {
      const tb = t + i * slot;
      const drop = dying ? 1 - 0.12 * (i + 1) : 1 - 0.04 * i;
      for (const [o, k] of [[o1, 1], [o2, 1.006]]) {
        o.frequency.setValueAtTime(hz(f * k * 0.9 * drop), tb);
        o.frequency.exponentialRampToValueAtTime(hz(f * k * 1.08 * drop), tb + len * 0.35);
        o.frequency.exponentialRampToValueAtTime(hz(f * k * 0.95 * drop), tb + len);
      }
      amp.gain.setValueAtTime(MIN_GAIN, tb);
      amp.gain.linearRampToValueAtTime(1, tb + 0.03);
      amp.gain.exponentialRampToValueAtTime(0.55, tb + len * 0.7);
      amp.gain.exponentialRampToValueAtTime(MIN_GAIN, tb + len);
    }
  }

  /** Chirp: quick FM sweeps, alternating up and down, with a throat resonance. */
  _chirp(v, dest, t, f, d, w, dying) {
    const n = clamp(Math.round(d / 0.11), 2, 6);
    const slot = d / n;
    const len = Math.min(0.1, slot * 0.8);
    const end = t + d;
    const amp = v.gain(0, dest);
    const res = v.filter("bandpass", f * 2.2, 1.6, v.gain(1.6, amp));
    const car = v.osc("sine", f * 2, t, end + 0.05);
    car.connect(amp);
    car.connect(res);
    const idx = v.gain(0, car.frequency);
    const mod = v.osc("sine", f * 3, t, end + 0.05, idx);
    amp.gain.setValueAtTime(MIN_GAIN, t);
    for (let i = 0; i < n; i++) {
      const tc = t + i * slot;
      const up = i % 2 === 0;
      const dr = dying ? Math.max(0.4, 0.85 - 0.1 * i) : 1;
      const a = (up ? 1.5 : 2.6) * dr;
      const b = (up ? 2.7 : 1.6) * dr;
      sweep(car.frequency, tc, f * a, f * b, len);
      sweep(mod.frequency, tc, f * a * 1.48, f * b * 1.48, len);
      idx.gain.setValueAtTime(f * 1.1, tc);
      idx.gain.linearRampToValueAtTime(f * 0.05, tc + len);
      amp.gain.setValueAtTime(MIN_GAIN, tc);
      amp.gain.linearRampToValueAtTime(1, tc + 0.008);
      amp.gain.exponentialRampToValueAtTime(MIN_GAIN, tc + len);
    }
  }

  /** Shriek: harsh rising/falling screech — rasping FM, saturation, bright formants, stutter. */
  _shriek(v, dest, t, f, d, w, dying) {
    const end = t + d;
    const shape = dying ? SHAPE_DYING : SHAPE_SHRIEK;
    const amp = v.gain(0, dest);
    const sh = v.shaper(this.curve);
    sh.connect(v.filter("bandpass", 2300, 2.5, v.gain(1.1, amp)));
    sh.connect(v.filter("bandpass", 3600, 3, v.gain(0.5, amp)));
    sh.connect(v.filter("lowpass", 1500, 0.7, v.gain(0.5, amp)));
    const stut = v.gain(0.72, sh);
    v.osc("sine", rnd(10, 14), t, end + 0.05, v.gain(0.28, stut.gain));
    const pre = v.gain(0.5, stut);
    const rasp = v.gain(140);
    v.osc("sine", rnd(70, 100), t, end + 0.05, rasp);
    for (const [type, k, g] of [["sawtooth", 2, 1], ["square", 2.02, 0.4]]) {
      const o = v.osc(type, f * k, t, end + 0.05, v.gain(g, pre));
      contour(o.frequency, t, f * k, d, shape);
      rasp.connect(o.detune);
    }
    v.noise(this.buf.white, t, end + 0.05, v.filter("highpass", 2200, 0.7, v.gain(0.35, pre)));
    amp.gain.setValueAtTime(MIN_GAIN, t);
    amp.gain.linearRampToValueAtTime(1, t + 0.05);
    amp.gain.setValueAtTime(1, t + d * 0.5);
    amp.gain.exponentialRampToValueAtTime(MIN_GAIN, end);
  }

  /** Hoot: soft, hollow two-part call (hoo-hooo) through a narrow resonance. */
  _hoot(v, dest, t, f, d, w, dying) {
    const end = t + d;
    const amp = v.gain(0, dest);
    const mix = v.gain(0.7, amp);
    mix.connect(v.filter("bandpass", f * 2, 9, v.gain(0.9, amp)));
    const o1 = v.osc("sine", f, t, end + 0.05, mix);
    const o2 = v.osc("triangle", f * 1.003, t, end + 0.05, v.gain(0.35, mix));
    const vib = v.gain(10);
    v.osc("sine", rnd(5, 6), t, end + 0.05, vib);
    vib.connect(o1.detune);
    vib.connect(o2.detune);
    v.noise(this.buf.pink, t, end + 0.05, v.filter("bandpass", Math.min(3000, f * 4), 1.5, v.gain(0.12, amp)));
    const dr = dying ? 0.85 : 1;
    amp.gain.setValueAtTime(MIN_GAIN, t);
    for (const [s, len, a, b, c] of [[0, 0.38, 0.94, 1.05, 1.0], [0.46, 0.54, 0.9, 0.99, 0.86]]) {
      const th = t + s * d;
      const l = len * d;
      for (const [o, k] of [[o1, 1], [o2, 1.003]]) {
        o.frequency.setValueAtTime(hz(f * k * a * dr), th);
        o.frequency.exponentialRampToValueAtTime(hz(f * k * b * dr), th + l * 0.4);
        o.frequency.exponentialRampToValueAtTime(hz(f * k * c * dr * (dying ? 0.8 : 1)), th + l);
      }
      amp.gain.setValueAtTime(MIN_GAIN, th);
      amp.gain.linearRampToValueAtTime(1, th + Math.min(0.09, l * 0.3));
      amp.gain.exponentialRampToValueAtTime(0.5, th + l * 0.7);
      amp.gain.exponentialRampToValueAtTime(MIN_GAIN, th + l);
    }
  }

  /**
   * Rumble: a closed-mouth boom under a growl (Tyrannosaurus). Laptop speakers
   * can't play a 30 Hz fundamental, so the 2nd–4th harmonics carry it and a
   * slow amplitude flutter stands in for the infrasound you'd feel.
   */
  _rumbleCall(v, dest, t, f, d, w, dying) {
    const end = t + d;
    const shape = dying ? SHAPE_DYING : SHAPE_RUMBLE;
    const amp = v.gain(0, dest);
    const lp = v.filter("lowpass", Math.max(180, f * 4), 0.9, amp);
    const flutter = v.gain(0.65, lp);
    v.osc("sine", rnd(6, 8), t, end + 0.05, v.gain(0.35, flutter.gain));
    for (const [type, k, g] of [["sine", 1, 0.7], ["triangle", 2, 0.55], ["sine", 3, 0.3], ["sawtooth", 4, 0.12]]) {
      contour(v.osc(type, f * k, t, end + 0.05, v.gain(g, flutter)).frequency, t, f * k, d, shape);
    }
    // The growl: two rough saws through a saturating throat band, with a fast tremolo.
    const sh = v.shaper(this.curve);
    sh.connect(v.filter("bandpass", lerp(420, 260, w), 2.4, v.gain(0.45, amp)));
    const growl = v.gain(0.3, sh);
    v.osc("sine", rnd(16, 22), t, end + 0.05, v.gain(0.15, growl.gain));
    for (const k of [3, 3.02]) contour(v.osc("sawtooth", f * k, t, end + 0.05, growl).frequency, t, f * k, d, shape);
    v.noise(this.buf.pink, t, end + 0.05, v.filter("lowpass", 380, 0.7, v.gain(0.12, amp)));
    sweep(lp.frequency, t, Math.max(160, f * 3), Math.max(320, f * 8), d * 0.3);
    lp.frequency.exponentialRampToValueAtTime(Math.max(160, f * 3), end);
    amp.gain.setValueAtTime(MIN_GAIN, t);
    amp.gain.linearRampToValueAtTime(1, t + d * 0.22);
    amp.gain.setValueAtTime(1, t + d * 0.6);
    amp.gain.exponentialRampToValueAtTime(MIN_GAIN, end);
  }

  /**
   * Rattle: a hiss on the intake, a pulsed hollow croak through a long snout's
   * narrow formants, then two dry jaw-claps (Spinosaurus).
   */
  _rattle(v, dest, t, f, d, w, dying) {
    const end = t + d;
    const amp = v.gain(1, dest);
    // Intake hiss through the retracted nostrils.
    const hg = v.gain(0, amp);
    const hf = v.filter("bandpass", 3600, 1.3, hg);
    v.noise(this.buf.white, t, t + d * 0.34, hf);
    sweep(hf.frequency, t, 3800, 1700, d * 0.3);
    hg.gain.setValueAtTime(MIN_GAIN, t);
    hg.gain.linearRampToValueAtTime(0.28, t + d * 0.07);
    hg.gain.exponentialRampToValueAtTime(MIN_GAIN, t + d * 0.32);
    // The croak: saw + square, gated by a slowing pulse train (the rattle).
    const t0 = t + d * 0.16;
    const t1 = dying ? end : t + d * 0.8;
    const body = v.gain(0, amp);
    const gate = v.gain(0.45, body);
    const lfo = v.osc("square", lerp(16, 11, w), t0, t1 + 0.05, v.gain(0.45, gate.gain));
    lfo.frequency.setValueAtTime(lerp(16, 11, w), t0);
    lfo.frequency.exponentialRampToValueAtTime(lerp(9, 6, w), t1);
    const sh = v.shaper(this.curve);
    sh.connect(v.filter("bandpass", clamp(f * 6, 420, 1100), 5, v.gain(1.1, gate)));
    sh.connect(v.filter("bandpass", lerp(1800, 1250, w), 6, v.gain(0.55, gate)));
    sh.connect(v.filter("lowpass", f * 2.2, 0.7, v.gain(0.55, gate)));
    const pre = v.gain(0.55, sh);
    for (const [type, k] of [["sawtooth", 1], ["square", 1.012]]) {
      contour(v.osc(type, f * k, t0, t1 + 0.05, pre).frequency, t0, f * k, t1 - t0, dying ? SHAPE_DYING : SHAPE_RATTLE);
    }
    v.noise(this.buf.pink, t0, t1 + 0.05, v.filter("bandpass", f * 4, 1.2, v.gain(0.35, pre)));
    body.gain.setValueAtTime(MIN_GAIN, t0);
    body.gain.linearRampToValueAtTime(1, t0 + 0.08);
    body.gain.setValueAtTime(1, lerp(t0, t1, 0.6));
    body.gain.exponentialRampToValueAtTime(MIN_GAIN, t1 + 0.04);
    if (dying) return;
    // Two hard jaw-claps to finish.
    for (const tc of [t1 + 0.06, t1 + 0.06 + lerp(0.15, 0.22, w)]) {
      const k = v.gain(0, amp);
      v.noise(this.buf.white, tc, tc + 0.1, v.filter("bandpass", lerp(1900, 1150, w), 1.3, k));
      v.osc("triangle", lerp(460, 280, w), tc, tc + 0.1, v.gain(0.7, k));
      k.gain.setValueAtTime(MIN_GAIN, tc);
      k.gain.linearRampToValueAtTime(1.1, tc + 0.004);
      k.gain.exponentialRampToValueAtTime(MIN_GAIN, tc + 0.09);
    }
  }

  /* --- Combat / body foley ---------------------------------------------------------- */

  _whoosh(v, t, kind, w) {
    const len = kind === "tail" ? lerp(0.3, 0.55, w) : lerp(0.14, 0.3, w);
    const lo = kind === "tail" ? 300 : 500;
    const g = v.gain(0, v.out);
    const bp = v.filter("bandpass", lo, 1.2, g);
    v.noise(this.buf.white, t, t + len + 0.05, bp);
    bp.frequency.setValueAtTime(lo, t);
    bp.frequency.exponentialRampToValueAtTime(lo * 4.5 * lerp(1, 0.6, w), t + len * 0.55);
    bp.frequency.exponentialRampToValueAtTime(lo * 1.3, t + len);
    g.gain.setValueAtTime(MIN_GAIN, t);
    g.gain.linearRampToValueAtTime(lerp(0.25, 0.55, w), t + len * 0.55);
    g.gain.exponentialRampToValueAtTime(MIN_GAIN, t + len);
  }

  /** Jaws closing: a bright click and a woody "tok". */
  _snap(v, t, w) {
    const cg = v.gain(0, v.out);
    v.noise(this.buf.white, t, t + 0.04, v.filter("highpass", 1800, 0.7, cg));
    pluck(cg.gain, t, 0.0008, 0.7, 0.018);
    const tg = v.gain(0, v.out);
    const o = v.osc("sine", 260, t, t + 0.1, tg);
    sweep(o.frequency, t, lerp(340, 160, w), lerp(120, 60, w), 0.06);
    pluck(tg.gain, t, 0.001, 0.6, 0.07);
  }

  _crunch(v, t, w, k) {
    const g = v.gain(0, v.out);
    v.noise(this.buf.crackle, t, t + 0.25, v.filter("bandpass", lerp(2200, 1300, w), 1, g));
    pluck(g.gain, t, 0.003, 0.9 * k, lerp(0.12, 0.22, w));
  }

  _thud(v, t, w, k) {
    const f = lerp(150, 40, w);
    const len = lerp(0.12, 0.45, w);
    const g = v.gain(0, v.out);
    const o = v.osc("sine", f, t, t + len + 0.05, g);
    sweep(o.frequency, t, f * 1.5, f * 0.6, len);
    pluck(g.gain, t, 0.003, 0.95 * k, len);
    const ng = v.gain(0, v.out);
    v.noise(this.buf.pink, t, t + 0.2, v.filter("lowpass", lerp(1200, 500, w), 0.7, ng));
    pluck(ng.gain, t, 0.002, 0.5 * k, lerp(0.06, 0.15, w));
  }

  _rumble(v, t, w, k) {
    const g = v.gain(0, v.out);
    const len = lerp(0.3, 1.1, w);
    v.noise(this.buf.brown, t, t + len + 0.1, v.filter("lowpass", 120, 0.8, g));
    pluck(g.gain, t, 0.015, clamp((w - 0.45) * 2.4, 0.1, 1.2) * k, len);
  }

  _rustle(v, t, k) {
    const g = v.gain(0, v.out);
    v.noise(this.buf.crackle, t, t + 0.4, v.filter("highpass", 1500, 0.6, g));
    pluck(g.gain, t, 0.02, 0.35 * k, 0.3);
  }

  /** A pained grunt in the player's own voice (its species' call pitch). */
  _grunt(v, t, p, w) {
    const scale = clamp(num(p?.scale, 1), 0.1, 2);
    const f = clamp((num(p?.species?.call?.pitch, 200) * 0.8) / Math.sqrt(scale), 50, 900);
    const len = lerp(0.18, 0.4, w);
    const amp = v.gain(0, v.out);
    const mix = v.gain(0.5);
    const f1 = lerp(900, 380, w);
    const f2 = lerp(1900, 900, w);
    mix.connect(v.filter("bandpass", f1, 3, v.gain(1.4, amp)));
    mix.connect(v.filter("bandpass", f2, 5, v.gain(0.7, amp)));
    mix.connect(v.filter("lowpass", f * 2, 0.7, v.gain(0.4, amp)));
    const o = v.osc("sawtooth", f, t, t + len + 0.05, mix);
    sweep(o.frequency, t, f * 1.15, f * 0.78, len);
    v.noise(this.buf.pink, t, t + len + 0.05, v.filter("bandpass", f1 * 1.5, 1.2, v.gain(0.3, mix)));
    amp.gain.setValueAtTime(MIN_GAIN, t);
    amp.gain.linearRampToValueAtTime(2.2, t + 0.025);
    amp.gain.exponentialRampToValueAtTime(MIN_GAIN, t + len);
  }

  /** Drowning: bubbling gurgle. */
  _gurgle(w) {
    const v = this._voice(0.8);
    if (!v) return;
    this._routeDirect(v, this.sfxBus, 0.05);
    const t = this.ctx.currentTime + LOOKAHEAD;
    const g = v.gain(0, v.out);
    const bp = v.filter("bandpass", 600, 12, g);
    v.noise(this.buf.white, t, t + 0.75, bp);
    let ts = t;
    while (ts < t + 0.65) {
      bp.frequency.setValueAtTime(rnd(300, 950) * lerp(1.2, 0.7, w), ts);
      ts += rnd(0.04, 0.08);
    }
    swell(g.gain, t, 0.05, 3, 0.4, 0.2);
    this._count("drown");
  }

  /* --- Stingers ------------------------------------------------------------------- */

  /** Growth: a warm, rising bell arpeggio over a soft pad. */
  _chime(adult) {
    const v = this._voice(0.8);
    if (!v) return;
    this._routeDirect(v, this.uiBus, 0.5);
    v.out.gain.value = 0.45;
    const t = this.ctx.currentTime + LOOKAHEAD;
    const root = adult ? 261.63 : 329.63;
    const steps = adult ? [0, 7, 12, 16, 19] : [0, 7, 12, 16];
    steps.forEach((st, i) => {
      const f = root * Math.pow(2, st / 12);
      const tn = t + i * 0.11;
      const g = v.gain(0, v.out);
      v.osc("sine", f, tn, tn + 2.8, g);
      v.osc("sine", f * 2, tn, tn + 1.4, v.gain(0.22, g));
      v.osc("sine", f * 3.01, tn, tn + 0.8, v.gain(0.07, g));
      pluck(g.gain, tn, 0.008, 0.32, 2.6);
    });
    const pad = v.gain(0, v.out);
    v.osc("triangle", root / 2, t, t + 3.6, v.filter("lowpass", 800, 0.7, pad));
    swell(pad.gain, t, 0.8, 0.2, 0.6, 2);
  }

  /** New day: a slow, quiet open-fifths swell. */
  _dawnSwell() {
    const v = this._voice(0.5);
    if (!v) return;
    this._routeDirect(v, this.uiBus, 0.5);
    v.out.gain.value = 0.5;
    const t = this.ctx.currentTime + LOOKAHEAD;
    const end = t + 9.5;
    const amp = v.gain(0, v.out);
    const lp = v.filter("lowpass", 300, 0.8, amp);
    for (const f of [146.83, 220, 293.66, 369.99]) {
      v.osc("sawtooth", f * rnd(0.998, 1.002), t, end, v.gain(0.22, lp));
    }
    sweep(lp.frequency, t, 280, 1500, 3.8);
    lp.frequency.exponentialRampToValueAtTime(380, end);
    swell(amp.gain, t, 3.6, 0.22, 1.4, 4.4);
    const sg = v.gain(0, v.out);
    v.osc("sine", 1174.66, t + 1, end, sg);
    swell(sg.gain, t + 1, 3, 0.03, 1, 4);
    this._count("dawn");
  }

  /** Player death: a low detuned drone that swells and sinks away. */
  _deathDrone() {
    const v = this._voice(1);
    if (!v) return;
    this._routeDirect(v, this.sfxBus, 0.6);
    v.out.gain.value = 0.7;
    const t = this.ctx.currentTime + LOOKAHEAD;
    const end = t + 10;
    const amp = v.gain(0, v.out);
    const lp = v.filter("lowpass", 180, 1.2, amp);
    for (const f of [55, 55.4, 82.4, 110.3, 164.6]) v.osc("sawtooth", f, t, end, v.gain(0.2, lp));
    sweep(lp.frequency, t, 160, 720, 3);
    lp.frequency.exponentialRampToValueAtTime(130, end);
    swell(amp.gain, t, 2.6, 0.9, 2.4, 4.8);
    const ng = v.gain(0, v.out);
    v.noise(this.buf.brown, t, t + 5.6, v.filter("lowpass", 300, 0.7, ng));
    swell(ng.gain, t, 2, 0.5, 1, 3.3);
    this._duck(0.7);
    this._count("deathDrone");
  }
}
