// All sound is synthesised with WebAudio: creature voices pitched by body
// mass, footfalls, a little generative music and ambience. No audio files.

import { clamp } from './util.js';

const PENTA = [0, 2, 4, 7, 9];
const semis = (n) => Math.pow(2, n / 12);

export class AudioEngine {
  constructor() {
    this.ctx = null;
    this.muted = false;
    this.music = true;
    this.amb = 'none';
    this.night = 0;
    this.tMusic = 0;
    this.tAmb = 2;
    this.bar = 0;
    try {
      this.muted = localStorage.getItem('phyla-muted') === '1';
    } catch {
      /* storage unavailable */
    }
  }

  // Must be called from a user gesture at least once.
  unlock() {
    if (this.ctx) {
      if (this.ctx.state === 'suspended') this.ctx.resume();
      return;
    }
    const AC = window.AudioContext || window.webkitAudioContext;
    if (!AC) return;
    const ctx = (this.ctx = new AC());
    this.master = ctx.createGain();
    this.master.gain.value = this.muted ? 0 : 0.85;
    const comp = ctx.createDynamicsCompressor();
    this.master.connect(comp).connect(ctx.destination);
    this.sfx = ctx.createGain();
    this.sfx.connect(this.master);
    this.mus = ctx.createGain();
    this.mus.gain.value = 0.5;
    this.mus.connect(this.master);
    // a soft echo for music and voices
    const delay = ctx.createDelay(1);
    delay.delayTime.value = 0.36;
    const fb = ctx.createGain();
    fb.gain.value = 0.34;
    const wet = ctx.createGain();
    wet.gain.value = 0.3;
    delay.connect(fb).connect(delay);
    delay.connect(wet).connect(this.master);
    this.echo = delay;
    this.mus.connect(delay);
    // noise source material
    const len = ctx.sampleRate * 2;
    const buf = ctx.createBuffer(1, len, ctx.sampleRate);
    const d = buf.getChannelData(0);
    for (let i = 0; i < len; i++) d[i] = Math.random() * 2 - 1;
    this.noiseBuf = buf;
    // wind / water bed
    const src = ctx.createBufferSource();
    src.buffer = buf;
    src.loop = true;
    this.bedFilter = ctx.createBiquadFilter();
    this.bedFilter.type = 'lowpass';
    this.bedFilter.frequency.value = 500;
    this.bedGain = ctx.createGain();
    this.bedGain.gain.value = 0;
    src.connect(this.bedFilter).connect(this.bedGain).connect(this.master);
    src.start();
  }

  setMuted(m) {
    this.muted = m;
    try {
      localStorage.setItem('phyla-muted', m ? '1' : '0');
    } catch {
      /* storage unavailable */
    }
    if (this.master) this.master.gain.setTargetAtTime(m ? 0 : 0.85, this.ctx.currentTime, 0.05);
  }

  setAmbience(kind) {
    this.amb = kind;
    if (!this.ctx) return;
    const t = this.ctx.currentTime;
    this.bedGain.gain.setTargetAtTime(kind === 'world' ? 0.045 : kind === 'cell' ? 0.09 : 0, t, 0.8);
    this.bedFilter.frequency.setTargetAtTime(kind === 'cell' ? 220 : 520, t, 0.8);
  }

  /* ------------------------------ primitives ----------------------------- */

  tone(freq, o = {}) {
    const ctx = this.ctx;
    if (!ctx) return;
    const t = ctx.currentTime + (o.at || 0);
    const dur = o.dur || 0.2;
    const osc = ctx.createOscillator();
    osc.type = o.type || 'sine';
    osc.frequency.setValueAtTime(freq, t);
    if (o.to) osc.frequency.exponentialRampToValueAtTime(Math.max(o.to, 20), t + dur);
    if (o.vib) {
      const l = ctx.createOscillator();
      const lg = ctx.createGain();
      l.frequency.value = o.vib;
      lg.gain.value = freq * (o.vibDepth || 0.03);
      l.connect(lg).connect(osc.frequency);
      l.start(t);
      l.stop(t + dur + 0.1);
    }
    const g = ctx.createGain();
    const vol = (o.vol === undefined ? 0.2 : o.vol);
    const a = o.attack || 0.01;
    g.gain.setValueAtTime(0.0001, t);
    g.gain.linearRampToValueAtTime(vol, t + a);
    g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
    let node = osc;
    if (o.lp) {
      const f = ctx.createBiquadFilter();
      f.type = 'lowpass';
      f.frequency.value = o.lp;
      node = osc.connect(f);
    }
    node.connect(g);
    g.connect(o.dest || this.sfx);
    if (o.echo) g.connect(this.echo);
    osc.start(t);
    osc.stop(t + dur + 0.05);
  }

  noise(o = {}) {
    const ctx = this.ctx;
    if (!ctx) return;
    const t = ctx.currentTime + (o.at || 0);
    const dur = o.dur || 0.15;
    const src = ctx.createBufferSource();
    src.buffer = this.noiseBuf;
    src.loop = true;
    const f = ctx.createBiquadFilter();
    f.type = o.type || 'bandpass';
    f.frequency.setValueAtTime(o.freq || 1000, t);
    if (o.to) f.frequency.exponentialRampToValueAtTime(o.to, t + dur);
    f.Q.value = o.q || 1;
    const g = ctx.createGain();
    g.gain.setValueAtTime(0.0001, t);
    g.gain.linearRampToValueAtTime(o.vol === undefined ? 0.2 : o.vol, t + (o.attack || 0.005));
    g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
    src.connect(f).connect(g).connect(this.sfx);
    src.start(t, Math.random());
    src.stop(t + dur + 0.05);
  }

  /* --------------------------------- sfx --------------------------------- */

  blip(kind) {
    switch (kind) {
      case 'tick': this.tone(660, { dur: 0.05, vol: 0.06, type: 'triangle' }); break;
      case 'place': this.tone(520, { dur: 0.09, vol: 0.12, type: 'triangle', to: 780 }); this.noise({ freq: 2400, dur: 0.05, vol: 0.05 }); break;
      case 'remove': this.tone(420, { dur: 0.12, vol: 0.1, type: 'triangle', to: 240 }); break;
      case 'bad': this.tone(200, { dur: 0.16, vol: 0.12, type: 'square', lp: 700 }); break;
      case 'good': [0, 4, 7].forEach((s, i) => this.tone(523 * semis(s), { at: i * 0.07, dur: 0.22, vol: 0.12, type: 'triangle', echo: true })); break;
      case 'helix': this.tone(880, { dur: 0.12, vol: 0.09 }); this.tone(1320, { at: 0.06, dur: 0.16, vol: 0.07, echo: true }); break;
      case 'unlock': [0, 2, 4, 7, 9, 12].forEach((s, i) => this.tone(440 * semis(s), { at: i * 0.075, dur: 0.4, vol: 0.12, type: 'triangle', echo: true })); break;
      case 'ally': [0, 7, 4, 9, 12, 16].forEach((s, i) => this.tone(392 * semis(s), { at: i * 0.11, dur: 0.55, vol: 0.13, type: 'sine', echo: true })); break;
      case 'evolve': [0, 4, 7, 11, 12, 16, 19].forEach((s, i) => this.tone(330 * semis(s), { at: i * 0.12, dur: 0.9, vol: 0.12, type: 'sine', echo: true, attack: 0.04 })); break;
      case 'fail': this.tone(300, { dur: 0.3, vol: 0.12, to: 150, type: 'triangle' }); break;
      case 'pop': this.tone(300, { dur: 0.07, vol: 0.14, to: 900 }); break;
      case 'bubble': this.tone(500 + Math.random() * 500, { dur: 0.08, vol: 0.05, to: 1400 }); break;
      default: break;
    }
  }

  step(vol = 1, heavy = 0.5) {
    this.noise({ type: 'lowpass', freq: 240 + (1 - heavy) * 500, dur: 0.07, vol: 0.07 * vol });
  }

  eat() {
    for (let i = 0; i < 3; i++) this.noise({ at: i * 0.17, freq: 1700 + Math.random() * 800, q: 2, dur: 0.08, vol: 0.14 });
  }

  hit(strength = 1) {
    this.noise({ type: 'lowpass', freq: 900, dur: 0.1, vol: 0.22 * strength });
    this.tone(120, { dur: 0.14, vol: 0.2 * strength, to: 60 });
  }

  splash() {
    this.noise({ freq: 1400, to: 500, dur: 0.3, vol: 0.12, q: 0.6 });
  }

  // A creature making a sound. Pitch comes from its body mass.
  voiceFor(stats, action, vol = 1) {
    if (!this.ctx || vol <= 0.02) return;
    const f = stats ? stats.pitch : 300;
    const v = clamp(vol, 0, 1);
    const echo = v > 0.6;
    switch (action) {
      case 'trill': {
        const notes = [0, 2, 4, 2, 7, 4, 9];
        notes.forEach((s, i) => this.tone(f * 1.5 * semis(PENTA[s % 5] + (s > 4 ? 12 : 0)), { at: i * 0.13, dur: 0.16, vol: 0.13 * v, type: 'triangle', vib: 24, vibDepth: 0.05, echo }));
        break;
      }
      case 'sway':
        for (let i = 0; i < 5; i++) {
          this.noise({ at: i * 0.24, freq: 900 + (i % 2) * 700, q: 3, dur: 0.07, vol: 0.13 * v });
          this.tone(f * 0.75 * (i % 2 ? 1.25 : 1), { at: i * 0.24, dur: 0.12, vol: 0.08 * v, type: 'triangle' });
        }
        break;
      case 'flare':
        this.noise({ freq: 500, to: 3200, dur: 0.5, vol: 0.12 * v, q: 0.8 });
        this.tone(f, { dur: 0.5, to: f * 2.2, vol: 0.11 * v, type: 'sawtooth', lp: 1800, echo });
        this.tone(f * 2.2, { at: 0.5, dur: 0.45, vol: 0.09 * v, type: 'triangle', vib: 12 });
        break;
      case 'glow':
        [0, 7, 12, 16, 19].forEach((s, i) => this.tone(f * 2 * semis(s), { at: i * 0.16, dur: 0.7, vol: 0.07 * v, attack: 0.05, echo }));
        break;
      case 'bite':
        this.noise({ type: 'highpass', freq: 2200, dur: 0.05, vol: 0.2 * v, at: 0.12 });
        this.tone(f * 0.6, { dur: 0.12, to: f * 0.4, vol: 0.12 * v, type: 'sawtooth', lp: 900 });
        break;
      case 'ram':
        this.tone(f * 0.5, { dur: 0.4, to: f * 0.3, vol: 0.16 * v, type: 'sawtooth', lp: 700 });
        break;
      case 'swipe':
        this.noise({ freq: 3200, to: 700, dur: 0.16, vol: 0.14 * v, q: 0.7 });
        break;
      case 'hurt':
        this.tone(f * 1.8, { dur: 0.18, to: f * 0.9, vol: 0.14 * v, type: 'triangle' });
        break;
      case 'growl':
        this.tone(f * 0.42, { dur: 0.7, vol: 0.14 * v, type: 'sawtooth', lp: 600, vib: 28, vibDepth: 0.12 });
        break;
      case 'happy':
        this.tone(f * 1.5, { dur: 0.12, vol: 0.12 * v, type: 'triangle' });
        this.tone(f * 2.25, { at: 0.12, dur: 0.2, vol: 0.12 * v, type: 'triangle', echo });
        break;
      case 'no':
        this.tone(f, { dur: 0.16, vol: 0.1 * v, type: 'triangle', to: f * 0.8 });
        this.tone(f * 0.8, { at: 0.2, dur: 0.2, vol: 0.1 * v, type: 'triangle', to: f * 0.6 });
        break;
      case 'call':
      default:
        this.tone(f * 1.2, { dur: 0.28, to: f * 1.5, vol: 0.1 * v, type: 'triangle', vib: 9 });
        break;
    }
  }

  /* --------------------------- music & ambience -------------------------- */

  update(dt, night = 0) {
    if (!this.ctx || this.muted) return;
    this.night = night;
    if (this.amb === 'none') return;
    this.tAmb -= dt;
    if (this.tAmb <= 0) {
      this.tAmb = 2.5 + Math.random() * 6;
      if (this.amb === 'cell') {
        for (let i = 0; i < 3; i++) this.tone(300 + Math.random() * 500, { at: i * 0.14 + Math.random() * 0.1, dur: 0.1, to: 900 + Math.random() * 600, vol: 0.025 });
      } else if (night > 0.6) {
        for (let i = 0; i < 6; i++) this.tone(4300 + Math.random() * 300, { at: i * 0.075, dur: 0.035, vol: 0.012, type: 'square', lp: 6000 });
      } else if (night < 0.3) {
        const b = 1900 + Math.random() * 1500;
        const n = 2 + Math.floor(Math.random() * 4);
        for (let i = 0; i < n; i++) this.tone(b * (1 + Math.random() * 0.25), { at: i * 0.11, dur: 0.09, to: b * (0.8 + Math.random() * 0.6), vol: 0.016 });
      }
    }
    if (!this.music) return;
    this.tMusic -= dt;
    if (this.tMusic <= 0) {
      const cell = this.amb === 'cell';
      this.tMusic = cell ? 5.2 : 4.6;
      const roots = cell ? [0, -3, 2, -5] : night > 0.6 ? [0, -4, -2, -7] : [0, 5, -3, 2];
      const root = (cell ? 146.8 : 196) * semis(roots[this.bar % roots.length]);
      this.bar++;
      for (const s of [0, 7, 16]) this.tone(root * semis(s), { dur: this.tMusic * 1.25, attack: 1.4, vol: 0.028, dest: this.mus, type: 'sine' });
      this.tone(root * 0.5, { dur: this.tMusic * 1.2, attack: 1.2, vol: 0.035, dest: this.mus, type: 'triangle', lp: 400 });
      const plucks = 1 + Math.floor(Math.random() * 3);
      for (let i = 0; i < plucks; i++) {
        const deg = PENTA[Math.floor(Math.random() * 5)] + 12 * Math.floor(Math.random() * 2);
        this.tone(root * 2 * semis(deg), { at: 0.4 + i * (0.6 + Math.random() * 0.9), dur: 1.1, vol: 0.03, dest: this.mus, type: 'triangle', attack: 0.006 });
      }
    }
  }
}
