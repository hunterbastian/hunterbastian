// One-time carry-over of saved data from the game's working title.
//
// Underfern was called "Sauria" while it was being built, and players' saves,
// settings, hunter profiles and hints live under "sauria.*" localStorage keys.
// Copy each one to its "underfern.*" key the first time the renamed game loads
// (never overwriting newer data). Imported first by main.js so every module
// reads the new keys.

const KEYS = ["save.v1", "settings.v1", "hunter.v1", "hunter.plan.v1", "hints.v1", "turnNote", "rotateHint"];

try {
  for (const k of KEYS) {
    const from = `sauria.${k}`;
    const to = `underfern.${k}`;
    const old = localStorage.getItem(from);
    if (old !== null && localStorage.getItem(to) === null) localStorage.setItem(to, old);
  }
} catch {
  /* storage blocked (private mode, sandbox): nothing to migrate */
}
