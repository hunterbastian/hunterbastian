// Dynamic resolution: when frames start to drop, draw fewer pixels; when
// there's headroom again, draw more. Most of Underfern's cost is per pixel
// (lit, hazed terrain and foliage), so on a phone that is warming up a step
// down in resolution is the cheapest way back to a steady frame rate.
//
// It works from frame intervals alone (WebGL on iOS has no GPU timers):
//   - the display's rate is the shortest interval seen lately, held between
//     60 Hz and 30 Hz — never chasing a 120 Hz screen, and taking a device
//     capped at 30 (iOS Low Power Mode, the Battery saver setting) as on time
//     rather than as slow;
//   - each second, a mean interval more than ~22 % over that rate means frames
//     are being missed: one step down (to `min` at most);
//   - several clean seconds in a row earn one step back up. A step up that
//     drops frames again soon after makes the next attempt wait twice as long,
//     so it settles instead of see-sawing.
// Hitches (a tab switch, a resize, a garbage collection) are ignored.

export class DynamicResolution {
  /**
   * @param {{ min?: number, max?: number, step?: number, onChange?: (scale: number) => void }} [o]
   */
  constructor({ min = 0.6, max = 1, step = 0.1, onChange = null } = {}) {
    this.min = min;
    this.max = max;
    this.step = step;
    this.onChange = onChange;
    /** Current share of the style's full resolution (rows), min … max. */
    this.scale = max;
    this._mins = []; // shortest interval of each of the last few windows
    this._upWait = 4; // clean windows needed before a step up
    this._sinceUp = Infinity; // windows since the last step up
    this.reset();
  }

  /**
   * Start the current window over (after a resize, a change of scale or style,
   * or a return from the background); what was learnt about the display stays.
   */
  reset() {
    this._sum = 0;
    this._n = 0;
    this._minI = Infinity;
    this._warm = 1; // a window to skip while new targets and shaders settle
    this._good = 0;
  }

  /** The display's frame interval as currently estimated (s). */
  get refresh() {
    const m = this._mins.length ? Math.min(...this._mins) : 1 / 60;
    return Math.min(1 / 30, Math.max(1 / 60, m));
  }

  /**
   * Feed one frame's interval (seconds since the previous frame).
   * @returns {boolean} true if the scale changed
   */
  frame(interval) {
    if (!(interval > 0) || interval > 0.25) return false; // a hitch, not a trend
    this._sum += interval;
    this._n++;
    this._minI = Math.min(this._minI, interval);
    if (this._sum < 1) return false;
    // A one-second window is complete.
    const mean = this._sum / this._n;
    this._mins.push(this._minI);
    if (this._mins.length > 3) this._mins.shift();
    this._sum = 0;
    this._n = 0;
    this._minI = Infinity;
    this._sinceUp++;
    if (this._warm > 0) {
      this._warm--;
      return false;
    }
    const refresh = this.refresh;
    if (mean > refresh * 1.22) {
      this._good = 0;
      // Dropping frames right after a step up: that step was too far.
      if (this._sinceUp <= 3) this._upWait = Math.min(this._upWait * 2, 32);
      return this._set(this.scale - this.step);
    }
    if (mean < refresh * 1.06) {
      if (++this._good >= this._upWait && this.scale < this.max) {
        this._good = 0;
        this._sinceUp = 0;
        return this._set(this.scale + this.step);
      }
    } else {
      this._good = 0;
    }
    return false;
  }

  /** Set the scale directly (clamped); calls onChange if it moved. */
  setScale(s) {
    return this._set(s);
  }

  _set(s) {
    const next = Math.round(Math.min(this.max, Math.max(this.min, s)) * 100) / 100;
    if (next === this.scale) return false;
    this.scale = next;
    this.onChange?.(next);
    return true;
  }
}
