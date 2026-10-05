// Global tuning. Gameplay numbers that belong to a species live in
// creatures/species.js instead.

export const WORLD = {
  seed: 20260,
  size: 1600, // metres, square island tile centred on the origin
  resolution: 512, // terrain grid segments per side (~3.1 m cells); phones may lower it
  seaLevel: 0, // y of every body of water (ocean, lakes, rivers)
  maxHeight: 140, // tallest peaks
};

export const TIME = {
  dayLengthSec: 16 * 60, // real seconds for one full in-game day
  startPhase: 0.3, // 0 midnight, 0.25 sunrise, 0.5 noon, 0.75 sunset
};

export const GAME = {
  npcSpawnMin: 90, // NPCs appear between these distances from the focus
  npcSpawnMax: 220,
  npcDespawn: 320, // ...and vanish beyond this
  npcCap: 26, // living NPCs at once (scaled by quality)
  carcassLifetime: 600, // seconds before a carcass rots away
  saveKey: "sauria.save.v1",
};

// Two render profiles. main.js picks one (auto: low on touch / small screens),
// and `?quality=low|high` overrides it.
// Render styles (same assets): "detailed" draws at full resolution; "pixel" draws the
// 3D scene into a low-res target and upscales it with nearest-neighbour filtering.
export const STYLE = {
  default: "detailed",
  pixelHeight: { high: 360, low: 270 }, // target height in pixels for "pixel"
};

export const QUALITY = {
  high: {
    pixelRatioCap: 2,
    shadows: true,
    shadowMapSize: 2048,
    vegetationDensity: 1,
    grass: true,
    viewDistance: 560,
    npcScale: 1,
    terrainResolution: 512,
    antialias: true,
  },
  low: {
    pixelRatioCap: 1.25,
    shadows: false,
    shadowMapSize: 1024,
    vegetationDensity: 0.45,
    grass: false,
    viewDistance: 360,
    npcScale: 0.6,
    terrainResolution: 320,
    antialias: false,
  },
};
