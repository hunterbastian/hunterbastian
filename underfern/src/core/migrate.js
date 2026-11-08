// One-time carry-overs of saved data: from the game's working title, and
// settings from before a change of default (see the end).
//
// Underfern was called "Sauria" while it was being built, and players' saves,
// settings and hints live under "sauria.*" localStorage keys. Move each one to
// its "underfern.*" key the first time the renamed game loads (never
// overwriting newer data, and never leaving the old copy behind: a save the
// game deletes must stay deleted). Imported first by main.js so every module
// reads the new keys.

const KEYS = ["save.v1", "settings.v1", "hints.v1", "turnNote", "rotateHint"];

// Data of a game mode that no longer exists, under either name. Removing a
// missing key is a no-op, so this costs nothing once they're gone.
const RETIRED = ["hunter.v1", "hunter.plan.v1"];

const SETTINGS = "underfern.settings.v1";

try {
  for (const k of KEYS) {
    const from = `sauria.${k}`;
    const to = `underfern.${k}`;
    const old = localStorage.getItem(from);
    if (old === null) continue;
    if (localStorage.getItem(to) === null) localStorage.setItem(to, old);
    localStorage.removeItem(from);
  }
  for (const k of RETIRED) {
    localStorage.removeItem(`sauria.${k}`);
    localStorage.removeItem(`underfern.${k}`);
  }
  const raw = localStorage.getItem(SETTINGS);
  const next = raw ? migrateSettings(JSON.parse(raw)) : null;
  if (next) localStorage.setItem(SETTINGS, JSON.stringify(next));
} catch {
  /* storage blocked (private mode, sandbox) or unreadable: nothing to migrate */
}

/**
 * Default style changes, each applied once and stamped (styleVersion) so a
 * player who picks the old style again keeps it:
 *   0.10 (v2): "Retro HD" became the default — the old default, Pixel, moves over.
 *   0.22 (v3): Storybook graded Dark fantasy became the default — Retro HD moves over.
 * @param {object} s stored settings
 * @returns {object | null} the settings to store instead, or null if they're current
 */
export function migrateSettings(s) {
  if (!s || typeof s !== "object" || s.styleVersion >= 3) return null;
  let out = s;
  if (!(out.styleVersion >= 2)) out = { ...out, style: out.style === "pixel" || !out.style ? "retro" : out.style, styleVersion: 2 };
  // 0.22: Storybook, graded Dark fantasy, became the default. Settings still
  // on the old default, Retro HD, move over once; any other choice stays.
  if (out.style === "retro" || !out.style) return { ...out, style: "story", grade: "fantasy", styleVersion: 3 };
  return { ...out, styleVersion: 3 };
}
