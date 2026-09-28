// Minimal interface: an entry card, a four-step route indicator and a
// quiet place-name toast.

import { ZONES, ZoneId } from '../world/layout';

export class Hud {
  private root = document.getElementById('hud')!;
  private intro = document.getElementById('intro')!;
  private introTitle = this.intro.querySelector<HTMLElement>('[data-title]')!;
  private introAction = this.intro.querySelector<HTMLElement>('[data-action]')!;
  private toast = document.getElementById('toast')!;
  private steps = new Map<ZoneId, HTMLElement>();
  private visited = new Set<ZoneId>();
  private current: ZoneId | null = null;
  private toastTimer = 0;
  private started = false;
  private touch = false;

  constructor() {
    const route = document.getElementById('route')!;
    for (const z of ZONES) {
      const li = document.createElement('li');
      li.textContent = z.label;
      li.dataset.zone = z.id;
      route.appendChild(li);
      this.steps.set(z.id, li);
    }
  }

  ready() {
    this.root.classList.remove('is-loading');
  }

  /** Switch hints and wording between mouse/keyboard and touch. */
  setInputMode(mode: 'touch' | 'mouse') {
    this.touch = mode === 'touch';
    this.root.dataset.input = mode;
    this.introAction.textContent = this.started
      ? `${this.touch ? 'Tap' : 'Click'} to continue`
      : `${this.touch ? 'Tap' : 'Click'} to enter`;
  }

  setPlaying(locked: boolean) {
    this.root.classList.toggle('is-playing', locked);
    if (locked && !this.started) {
      this.started = true;
      // Announce where the walk begins once the card is out of the way.
      if (this.current) this.showToast(ZONES.find((z) => z.id === this.current)!.label);
    }
    if (!locked && this.started) {
      this.introTitle.textContent = 'Paused';
      this.introAction.textContent = `${this.touch ? 'Tap' : 'Click'} to continue`;
    }
  }

  lockBlocked() {
    this.introAction.textContent = `${this.touch ? 'Tap' : 'Click'} again to continue`;
  }

  setZone(zone: ZoneId | null) {
    if (!zone || zone === this.current) return;
    this.current = zone;
    const first = !this.visited.has(zone);
    this.visited.add(zone);
    for (const [id, el] of this.steps) {
      el.classList.toggle('is-current', id === zone);
      el.classList.toggle('is-visited', this.visited.has(id) && id !== zone);
    }
    if (first && this.started) this.showToast(ZONES.find((z) => z.id === zone)!.label);
  }

  private showToast(text: string) {
    this.toast.textContent = text;
    this.toast.classList.add('is-visible');
    window.clearTimeout(this.toastTimer);
    this.toastTimer = window.setTimeout(() => this.toast.classList.remove('is-visible'), 2600);
  }
}
