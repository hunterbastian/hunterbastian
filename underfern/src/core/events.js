// A tiny synchronous event bus. One instance lives on `world.events`.
// Event names and payloads are documented in ARCHITECTURE.md ("Events").

export class EventBus {
  constructor() {
    this.listeners = new Map();
  }

  /** Subscribe. Returns an unsubscribe function. */
  on(name, fn) {
    if (!this.listeners.has(name)) this.listeners.set(name, new Set());
    this.listeners.get(name).add(fn);
    return () => this.off(name, fn);
  }

  off(name, fn) {
    this.listeners.get(name)?.delete(fn);
  }

  emit(name, payload) {
    const set = this.listeners.get(name);
    if (!set) return;
    for (const fn of [...set]) {
      try {
        fn(payload);
      } catch (err) {
        console.error(`[events] listener for "${name}" threw`, err);
      }
    }
  }
}
