/** Side length of the square world, in world units (1 unit ≈ 1 metre). */
export const WORLD_SIZE = 96;
/** How far from the centre players may build. */
export const BUILD_RADIUS = 34;
/** Resolution of the painted path mask. */
export const MASK_RES = 1024;

export const BRICK = {
  length: 0.62,
  height: 0.3,
  thickness: 0.56,
  gap: 0.04,
} as const;

export const WALL_COURSES = { min: 3, max: 14, default: 7 } as const;

export const BRUSH = {
  path: 0.85,
  erase: 1.4,
} as const;

const params = new URLSearchParams(location.search);
const coarse = matchMedia('(pointer: coarse)').matches;
/** `?q=low` or touch devices get a lighter grass field. */
export const LOW_QUALITY = params.get('q') === 'low' || (coarse && params.get('q') !== 'high');
