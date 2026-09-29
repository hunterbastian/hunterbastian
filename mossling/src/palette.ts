import * as THREE from "three";

// The whole game is squeezed through this palette by the dither pass.
// Warm, mossy, a little faded — like a CRT in a cabin.
export const PALETTE_HEX = [
  // shadows
  "#1c1a20", "#2c2830", "#3a3438",
  // forest greens
  "#243224", "#33442a", "#475a30", "#62743a", "#80903f", "#a3a852", "#c4c173",
  // earth + bark
  "#3f2d24", "#5a4031", "#7b5a3e", "#9e7b52", "#c49e6c",
  // warm lights
  "#e3cf9c", "#f2e6c4", "#fff8e2",
  // blossoms + embers
  "#b95c3c", "#df8f55", "#f0b870", "#c9747a", "#e6a9a0",
  // haze, sky, water
  "#4b5a63", "#6f8588", "#94a8a2", "#bcc8b4", "#d9d9b8",
  "#35595a", "#548079",
  // dusk violets
  "#4a3e56", "#76637e",
] as const;

export const PALETTE: THREE.Color[] = PALETTE_HEX.map((h) => new THREE.Color().setStyle(h, THREE.SRGBColorSpace));

/** Palette as raw sRGB triplets for the dither shader. */
export function paletteSRGB(): THREE.Vector3[] {
  return PALETTE_HEX.map((h) => {
    const n = parseInt(h.slice(1), 16);
    return new THREE.Vector3(((n >> 16) & 255) / 255, ((n >> 8) & 255) / 255, (n & 255) / 255);
  });
}

// Named scene colors (sRGB hex, converted to linear by THREE.Color).
export const COLORS = {
  fog: 0xd2cfa9,
  skyTop: 0x8fa8a4,
  skyHorizon: 0xeadcaa,
  sun: 0xffe9b8,
  grass: 0x6f8a3a,
  grassDark: 0x3f5a2c,
  moss: 0x8f9c42,
  dirt: 0x9a7650,
  sand: 0xcdb27a,
  rock: 0x8a8a78,
  rockDark: 0x5e5f58,
  bark: 0x6a4a34,
  leaf: 0x55742f,
  leafLight: 0x8ea043,
  pine: 0x35512e,
  water: 0x4c7f78,
  creatureFur: 0xe2c79a,
  creatureBelly: 0xf4e7c8,
  creatureMoss: 0x7f9a3c,
  creaturePaw: 0x5a4031,
  lantern: 0xffc46b,
} as const;
