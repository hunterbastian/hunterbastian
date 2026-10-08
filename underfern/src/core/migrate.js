// One-time carry-over of saved data from the game's working title.
//
// Underfern was called "Sauria" while it was being built, and players' saves,
// settings and hints live under "sauria.*" localStorage keys. Copy each one to
// its "underfern.*" key the first time the renamed game loads (never
// overwriting newer data). Imported first by main.js so every module reads the
// new keys.

const KEYS = ["save.v1", "settings.v1", "hints.v1", "turnNote", "rotateHint"];

// Data of a game mode that no longer exists, under either name. Removing a
// missing key is a no-op, so this costs nothing once they're gone.
const RETIRED = ["hunter.v1", "hunter.plan.v1"];

try {
  for (const k of KEYS) {
    const from = `sauria.${k}`;
    const to = `underfern.${k}`;
    const old = localStorage.getItem(from);
    if (old !== null && localStorage.getItem(to) === null) localStorage.setItem(to, old);
  }
  for (const k of RETIRED) {
    localStorage.removeItem(`sauria.${k}`);
    localStorage.removeItem(`underfern.${k}`);
  }
} catch {
  /* storage blocked (private mode, sandbox): nothing to migrate */
}
