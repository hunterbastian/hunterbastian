// Species definitions — gameplay numbers, menu copy, colour palettes and the
// body blueprints dinoModel.js lofts into skinned meshes.
//
// All values are for a full-grown ADULT. Units: metres, kilograms, seconds,
// m/s, rad/s; stats in percent where ARCHITECTURE.md says so.
//
// `body` layout (model-only, read by dinoModel.js). The model is authored at
// adult size, facing +Z, origin on the ground under the hip joints:
//   trunk:  [z, y, halfWidth, top, bottom, square?, taper?] stations along the
//           spine line from the tail tip to the top of the neck. top / bottom
//           are the radii above / below the line (bottom > top = belly sag),
//           square > 2 flattens the section toward a rounded box, taper > 0
//           widens the top (egg-shaped chest), < 0 narrows it (keeled tail).
//   head:   `at` is the mouth-line point at the back of the skull, `length`
//           and `pitch` aim the head; stations are [u, top, bottom, halfWidth,
//           taper] measured from the mouth line (u = 0 occiput … 1 snout tip).
//   hind / fore: leg blueprints — joint x offset, foot placement and bone
//           lengths, radii as [halfWidth, front, back] at the joints.
//   arms:   biped forelimbs (shoulder position, lengths, fingers).
//   features: species ornaments (plates, spikes, horns, feathers …).
//
// Optional gameplay knobs, [default]: pierce [0] share of the victim's armour
// an attack ignores · attackStamina [8] stamina per attack · juvenileSpeed
// [0.85] hatchling speed multiplier · smell [1] scent-range multiplier ·
// swimDepth hip depth while floating, in hip heights · waterAffinity [0] 0..1
// pull toward rivers, lakes and shore (spawning, patrols, prey choice) ·
// maxAlive [none] wild ones at once · pairChance [0] odds a "solo" species
// turns up as a pair.

/* --- Shared limb / head building blocks ---------------------------------- */

// Theropod foot: three weight-bearing toes (II, III, IV) plus a small hallux.
const THEROPOD_FOOT = {
  kind: "theropod",
  toes: [
    { yaw: -0.3, len: 0.82, r: 1.0 }, // II (inner)
    { yaw: 0.02, len: 1.0, r: 1.05 }, // III (middle, longest)
    { yaw: 0.34, len: 0.78, r: 1.0 }, // IV (outer)
  ],
  hallux: true,
  claw: 0.3, // claw length as a fraction of the middle toe
};

// Spinosaurid foot: long, widely splayed toes with low, flat claws
// (a broad footprint for soft river margins).
const WADER_FOOT = {
  ...THEROPOD_FOOT,
  toes: [
    { yaw: -0.38, len: 0.88, r: 1.0 },
    { yaw: 0.02, len: 1.0, r: 1.05 },
    { yaw: 0.42, len: 0.86, r: 1.0 },
  ],
  claw: 0.22,
};

const RAPTOR_FOOT = {
  kind: "raptor",
  toes: [
    { yaw: 0.04, len: 1.0, r: 1.05 }, // III
    { yaw: 0.34, len: 0.86, r: 1.0 }, // IV
  ],
  sickle: true, // digit II held off the ground with the killing claw
  hallux: true,
  claw: 0.28,
};

const ORNITHOPOD_FOOT = {
  kind: "ornithopod",
  toes: [
    { yaw: -0.28, len: 0.8, r: 1.0 },
    { yaw: 0.0, len: 1.0, r: 1.05 },
    { yaw: 0.3, len: 0.78, r: 1.0 },
  ],
  hallux: false,
  claw: 0.22,
  hoof: true, // blunt, hoof-like unguals
};

const STUMPY_FOOT = {
  kind: "stumpy",
  toes: [
    { yaw: -0.42, len: 0.85, r: 1.0 },
    { yaw: -0.08, len: 1.0, r: 1.05 },
    { yaw: 0.28, len: 0.9, r: 1.0 },
  ],
  hallux: false,
  claw: 0.3,
  hoof: true,
  pad: true, // broad fleshy heel pad (graviportal)
};

const STUMPY_HAND = {
  kind: "stumpy",
  toes: [
    { yaw: -0.7, len: 0.7, r: 0.9 },
    { yaw: -0.3, len: 0.9, r: 1.0 },
    { yaw: 0.05, len: 1.0, r: 1.0 },
    { yaw: 0.38, len: 0.9, r: 0.95 },
    { yaw: 0.72, len: 0.65, r: 0.85 },
  ],
  hallux: false,
  claw: 0.28,
  hoof: true,
  pad: true,
};

// Sauropod hind foot: a broad, elephant-like heel pad with short, nail-like toes around its front edge.
const ELEPHANT_FOOT = {
  kind: "stumpy",
  toes: [
    { yaw: -0.62, len: 0.62, r: 0.82 },
    { yaw: -0.22, len: 0.78, r: 0.92 },
    { yaw: 0.18, len: 0.72, r: 0.88 },
    { yaw: 0.56, len: 0.52, r: 0.74 },
  ],
  hallux: false,
  claw: 0.3,
  hoof: true,
  pad: true,
};

/* --- Species ------------------------------------------------------------- */

export const SPECIES = {
  dryosaurus: {
    id: "dryosaurus",
    name: "Dryosaurus",
    diet: "herbivore",
    playable: true,
    tagline: "Fleet-footed and fragile: speed is your only armour.",
    description:
      "A slender, big-eyed ornithopod that browses ferns along the forest edge, always a heartbeat from bolting. " +
      "Few predators can catch you at full sprint, but one bite can end you, so stay with the herd and keep your ears open.",
    era: "Late Jurassic · Morrison Formation",
    length: 3.5,
    height: 0.95,
    mass: 90,
    health: 120,
    bite: 12,
    biteCooldown: 0.7,
    biteRange: 0.7,
    attack: "kick",
    armor: 0,
    bleed: 0.5,
    speed: { walk: 1.8, trot: 5.5, sprint: 13.5, crouch: 1.4, swim: 1.8 },
    turnRate: 5.0,
    stamina: { regen: 14, sprintDrain: 9 },
    metabolism: { hunger: 4.2, thirst: 5.0 },
    growthMinutes: 20,
    juvenileScale: 0.3,
    swim: 0.35,
    social: "herd",
    groupSize: [3, 6],
    aggression: 0.05,
    perception: 110,
    spawnWeight: 1.2,
    biomes: ["plains", "forest", "beach"],
    call: { kind: "chirp", pitch: 540, duration: 0.45 },
    colors: {
      eye: "#3a2616",
      morphs: [
        { base: "#8d8556", dorsal: "#5b5a37", belly: "#e3dbbd", pattern: "#3f3f28", light: "#e8dfb4", accent: "#b9673a" },
        { base: "#9a8256", dorsal: "#655034", belly: "#e6d9b8", pattern: "#4a3825", light: "#efe2bf", accent: "#a14c2e" },
        { base: "#7e8a5c", dorsal: "#4c5636", belly: "#dcdcbc", pattern: "#36402a", light: "#e2e4bc", accent: "#c08a3a" },
      ],
      // bands: [cycles per metre, threshold -1..1, warp]; spots: [strength, threshold];
      // stripe: [rest-normal height, width, strength] (a pale lateral flank stripe)
      pattern: { bands: [0, 0.6, 2], spots: [0.55, 0.62], stripe: [0.2, 0.12, 0.5], dorsal: 0.8, mottle: 0.25 },
    },
    body: {
      plan: "biped",
      scaleTile: 0.18,
      trunk: [
        [-2.05, 0.86, 0.01, 0.012, 0.012],
        [-1.75, 0.88, 0.02, 0.024, 0.024, 2, -0.2],
        [-1.25, 0.93, 0.036, 0.048, 0.05, 2, -0.25],
        [-0.7, 0.99, 0.065, 0.08, 0.09, 2, -0.2],
        [-0.3, 1.03, 0.11, 0.11, 0.17, 2, -0.1],
        [0.0, 1.05, 0.14, 0.12, 0.24],
        [0.3, 1.04, 0.16, 0.115, 0.3, 2, 0.12],
        [0.56, 1.03, 0.15, 0.105, 0.28, 2, 0.12],
        [0.76, 1.06, 0.11, 0.09, 0.17],
        [0.92, 1.14, 0.065, 0.06, 0.08],
        [1.06, 1.25, 0.05, 0.05, 0.058],
        [1.17, 1.32, 0.045, 0.046, 0.05],
      ],
      head: {
        at: [1.25, 1.31],
        length: 0.27,
        pitch: -0.3,
        stations: [
          [0.0, 0.07, 0.045, 0.043, 0],
          [0.14, 0.082, 0.05, 0.05, -0.05],
          [0.3, 0.08, 0.022, 0.047, -0.12],
          [0.52, 0.062, 0.016, 0.034, -0.18],
          [0.74, 0.047, 0.014, 0.025, -0.15],
          [0.9, 0.034, 0.013, 0.018, -0.05],
          [0.97, 0.022, 0.011, 0.013, 0],
          [1.0, 0.008, 0.006, 0.006, 0],
        ],
        jaw: { hinge: 0.1, depth: [[0, 0.03], [0.15, 0.045], [0.5, 0.032], [0.85, 0.022], [1, 0.01]], width: 0.86 },
        eye: { u: 0.3, v: 0.05, r: 0.017 },
        nostril: { u: 0.88, v: 0.026, r: 0.007 },
        beak: 0.14,
        teeth: null,
      },
      bones: { tail: 8, neck: 3, spineZ: 0.32, chestZ: 0.62, neckZ: 0.82, tailZ: -0.25 },
      hind: {
        x: 0.1, footX: 0.085, footZ: 0.06, thigh: 0.35, shin: 0.43, meta: 0.25, toe: 0.12, metaAngle: 0.42,
        radii: { top: [0.124, 0.156, 0.156], hip: [0.117, 0.143, 0.143], thigh: [0.101, 0.121, 0.115], knee: [0.042, 0.048, 0.048], calf: [0.043, 0.044, 0.062], ankle: [0.022, 0.024, 0.024], meta: [0.019, 0.02, 0.018], ball: [0.019, 0.019, 0.017] },
        foot: ORNITHOPOD_FOOT,
      },
      arms: {
        x: 0.085, y: 0.94, z: 0.66, upper: 0.12, fore: 0.1, hand: 0.06,
        radii: [0.03, 0.02, 0.014],
        fingers: [{ yaw: -0.3, len: 0.7 }, { yaw: -0.1, len: 1.0 }, { yaw: 0.1, len: 1.0 }, { yaw: 0.3, len: 0.8 }],
        claw: 0.25,
      },
      features: { beak: true },
    },
  },

  utahraptor: {
    id: "utahraptor",
    name: "Utahraptor",
    diet: "carnivore",
    playable: true,
    tagline: "Feathered, fast and armed with a killing claw.",
    description:
      "Utah's own giant raptor: a heavyset, feathered hunter whose sickle claw opens wounds that keep on bleeding. " +
      "Hunt as a pack, wear prey down with bleed, and never pick a fair fight with a grown Allosaurus.",
    era: "Early Cretaceous · Cedar Mountain Formation, Utah",
    length: 6,
    height: 1.6,
    mass: 500,
    health: 380,
    bite: 38,
    biteCooldown: 0.9,
    biteRange: 1.2,
    attack: "bite",
    armor: 0.05,
    bleed: 3,
    speed: { walk: 2.5, trot: 7, sprint: 16, crouch: 1.8, swim: 2.5 },
    turnRate: 3.6,
    stamina: { regen: 10, sprintDrain: 8 },
    metabolism: { hunger: 5.0, thirst: 4.5 },
    growthMinutes: 24,
    juvenileScale: 0.3,
    swim: 0.4,
    social: "pack",
    groupSize: [2, 4],
    aggression: 0.7,
    perception: 95,
    spawnWeight: 0.55,
    biomes: ["forest", "plains", "swamp"],
    call: { kind: "shriek", pitch: 300, duration: 1.0 },
    colors: {
      eye: "#c99a2e",
      morphs: [
        { base: "#86694a", dorsal: "#4b3826", belly: "#d9c9a6", pattern: "#33261a", light: "#eadfc8", accent: "#a4472b" },
        { base: "#6c6a62", dorsal: "#33322f", belly: "#d4d0c4", pattern: "#232220", light: "#efece4", accent: "#8f3a2a" },
        { base: "#977452", dorsal: "#5a3f2a", belly: "#e1cfad", pattern: "#3a2a1d", light: "#f1e6cf", accent: "#c0703a" },
      ],
      pattern: { bands: [3.2, 0.35, 2.5], spots: [0, 0.6], stripe: [0, 0, 0], dorsal: 0.85, mottle: 0.3 },
    },
    body: {
      plan: "biped",
      scaleTile: 0.3,
      trunk: [
        [-3.25, 1.66, 0.012, 0.016, 0.016],
        [-2.8, 1.69, 0.032, 0.042, 0.042],
        [-2.05, 1.72, 0.06, 0.075, 0.075, 2, -0.15],
        [-1.25, 1.74, 0.105, 0.125, 0.135, 2, -0.15],
        [-0.55, 1.77, 0.18, 0.18, 0.3, 2, -0.05],
        [0.0, 1.79, 0.24, 0.2, 0.42],
        [0.42, 1.77, 0.27, 0.2, 0.55, 2, 0.12],
        [0.86, 1.74, 0.26, 0.19, 0.53, 2, 0.12],
        [1.2, 1.76, 0.2, 0.17, 0.36],
        [1.46, 1.9, 0.125, 0.11, 0.15],
        [1.66, 2.1, 0.095, 0.09, 0.105],
        [1.84, 2.24, 0.085, 0.082, 0.09],
      ],
      head: {
        at: [1.96, 2.22],
        length: 0.64,
        pitch: -0.12,
        stations: [
          [0.0, 0.18, 0.1, 0.09, -0.08],
          [0.12, 0.205, 0.11, 0.105, -0.12],
          [0.26, 0.19, 0.04, 0.095, -0.2],
          [0.44, 0.155, 0.026, 0.075, -0.3],
          [0.63, 0.125, 0.024, 0.06, -0.34],
          [0.82, 0.098, 0.023, 0.05, -0.32],
          [0.94, 0.072, 0.022, 0.041, -0.22],
          [1.0, 0.03, 0.015, 0.02, 0],
        ],
        jaw: { hinge: 0.09, depth: [[0, 0.07], [0.15, 0.115], [0.45, 0.085], [0.8, 0.065], [1, 0.03]], width: 0.86 },
        eye: { u: 0.25, v: 0.13, r: 0.026 },
        nostril: { u: 0.9, v: 0.06, r: 0.012 },
        beak: 0,
        teeth: { upper: 13, lower: 12, length: 0.032, from: 0.3, to: 0.95 },
      },
      bones: { tail: 8, neck: 4, spineZ: 0.42, chestZ: 0.9, neckZ: 1.3, tailZ: -0.35 },
      hind: {
        x: 0.2, footX: 0.16, footZ: 0.1, thigh: 0.62, shin: 0.68, meta: 0.38, toe: 0.24, metaAngle: 0.4,
        radii: { top: [0.234, 0.312, 0.312], hip: [0.221, 0.286, 0.273], thigh: [0.189, 0.23, 0.216], knee: [0.078, 0.084, 0.084], calf: [0.077, 0.075, 0.112], ankle: [0.042, 0.046, 0.046], meta: [0.037, 0.039, 0.033], ball: [0.038, 0.038, 0.032] },
        foot: RAPTOR_FOOT,
      },
      arms: {
        x: 0.18, y: 1.52, z: 1.14, upper: 0.42, fore: 0.36, hand: 0.3,
        radii: [0.07, 0.045, 0.03],
        fingers: [{ yaw: -0.14, len: 0.8 }, { yaw: 0.0, len: 1.0 }, { yaw: 0.14, len: 0.85 }],
        claw: 0.32,
        folded: true, // bird-like folded wings
      },
      features: { feathers: true, teeth: true },
    },
  },

  ceratosaurus: {
    id: "ceratosaurus",
    name: "Ceratosaurus",
    diet: "carnivore",
    playable: true,
    tagline: "Horned ambusher of the swamps and riverbanks.",
    description:
      "A deep-tailed, horn-nosed predator with a ridge of bony scutes down its back and long bladed teeth. " +
      "It swims better than any hunter its size: stalk the shallows, strike from the water and drag prey in after you.",
    era: "Late Jurassic · Morrison Formation",
    length: 7,
    height: 1.9,
    mass: 900,
    health: 560,
    bite: 52,
    biteCooldown: 1.1,
    biteRange: 1.4,
    attack: "bite",
    armor: 0.1,
    bleed: 2,
    speed: { walk: 2.3, trot: 6, sprint: 12, crouch: 1.6, swim: 5 },
    turnRate: 2.8,
    stamina: { regen: 9, sprintDrain: 8 },
    metabolism: { hunger: 4.6, thirst: 4.2 },
    growthMinutes: 27,
    juvenileScale: 0.28,
    swim: 0.9,
    social: "solo",
    groupSize: [1, 2],
    aggression: 0.65,
    perception: 85,
    spawnWeight: 0.45,
    biomes: ["swamp", "forest", "beach"],
    call: { kind: "roar", pitch: 140, duration: 1.6 },
    colors: {
      eye: "#d0a032",
      morphs: [
        { base: "#6b6250", dorsal: "#33302a", belly: "#bfb394", pattern: "#26231e", light: "#d4c8a6", accent: "#b84a2a" },
        { base: "#5e6450", dorsal: "#2f342a", belly: "#b8b896", pattern: "#22261e", light: "#cfcfaa", accent: "#c25a2c" },
        { base: "#7a5f48", dorsal: "#3e2e22", belly: "#c8b190", pattern: "#2a1f17", light: "#dccaa8", accent: "#a83a26" },
      ],
      pattern: { bands: [1.6, 0.15, 2.2], spots: [0, 0.6], stripe: [0, 0, 0], dorsal: 0.85, mottle: 0.25 },
    },
    body: {
      plan: "biped",
      scaleTile: 0.4,
      trunk: [
        [-3.75, 1.66, 0.012, 0.02, 0.02],
        [-3.25, 1.71, 0.035, 0.08, 0.08, 2, -0.3],
        [-2.45, 1.8, 0.07, 0.19, 0.19, 2, -0.35],
        [-1.5, 1.9, 0.13, 0.27, 0.29, 2, -0.3],
        [-0.65, 1.99, 0.23, 0.3, 0.44, 2, -0.15],
        [0.0, 2.05, 0.31, 0.31, 0.56],
        [0.52, 2.03, 0.36, 0.29, 0.74, 2, 0.12],
        [1.02, 1.99, 0.35, 0.28, 0.72, 2, 0.12],
        [1.42, 2.0, 0.27, 0.25, 0.48],
        [1.78, 2.17, 0.18, 0.18, 0.26],
        [2.08, 2.38, 0.15, 0.155, 0.19],
        [2.33, 2.5, 0.14, 0.145, 0.165],
      ],
      head: {
        at: [2.46, 2.43],
        length: 0.8,
        pitch: -0.12,
        stations: [
          [0.0, 0.29, 0.14, 0.12, -0.1],
          [0.1, 0.315, 0.155, 0.142, -0.14],
          [0.22, 0.3, 0.06, 0.13, -0.22],
          [0.38, 0.265, 0.035, 0.105, -0.3],
          [0.58, 0.235, 0.034, 0.09, -0.34],
          [0.78, 0.205, 0.034, 0.08, -0.34],
          [0.92, 0.155, 0.033, 0.07, -0.28],
          [0.98, 0.095, 0.03, 0.05, -0.15],
          [1.0, 0.035, 0.02, 0.024, 0],
        ],
        jaw: { hinge: 0.08, depth: [[0, 0.09], [0.15, 0.16], [0.45, 0.12], [0.8, 0.1], [1, 0.045]], width: 0.84 },
        eye: { u: 0.21, v: 0.2, r: 0.033 },
        nostril: { u: 0.93, v: 0.09, r: 0.016 },
        beak: 0,
        teeth: { upper: 12, lower: 11, length: 0.06, from: 0.28, to: 0.95 },
      },
      bones: { tail: 8, neck: 4, spineZ: 0.52, chestZ: 1.05, neckZ: 1.55, tailZ: -0.45 },
      hind: {
        x: 0.27, footX: 0.22, footZ: 0.1, thigh: 0.78, shin: 0.76, meta: 0.44, toe: 0.32, metaAngle: 0.42,
        radii: { top: [0.312, 0.416, 0.416], hip: [0.299, 0.39, 0.377], thigh: [0.243, 0.311, 0.297], knee: [0.108, 0.12, 0.12], calf: [0.106, 0.1, 0.15], ankle: [0.061, 0.064, 0.064], meta: [0.053, 0.055, 0.048], ball: [0.053, 0.053, 0.046] },
        foot: THEROPOD_FOOT,
      },
      arms: {
        x: 0.24, y: 1.74, z: 1.25, upper: 0.24, fore: 0.15, hand: 0.13,
        radii: [0.062, 0.042, 0.03],
        fingers: [{ yaw: -0.22, len: 0.75 }, { yaw: -0.07, len: 1.0 }, { yaw: 0.08, len: 0.95 }, { yaw: 0.22, len: 0.55 }],
        claw: 0.22,
      },
      features: { teeth: true, nasalHorn: true, browBosses: true, scuteRow: true },
    },
  },

  stegosaurus: {
    id: "stegosaurus",
    name: "Stegosaurus",
    diet: "herbivore",
    playable: true,
    tagline: "Plates to look big, spikes to make it count.",
    description:
      "A plated giant with a tiny head, a slow mind and the most dangerous tail of the Jurassic. " +
      "Stand your ground, keep predators behind you and let the thagomizer leave them bleeding.",
    era: "Late Jurassic · Morrison Formation",
    length: 9,
    height: 2.2,
    mass: 4500,
    health: 2400,
    bite: 110,
    biteCooldown: 1.8,
    biteRange: 2.4,
    attack: "tail",
    armor: 0.3,
    bleed: 4,
    speed: { walk: 1.5, trot: 3.2, sprint: 5.8, crouch: 1.0, swim: 1.3 },
    turnRate: 1.4,
    stamina: { regen: 7, sprintDrain: 10 },
    metabolism: { hunger: 3.2, thirst: 3.5 },
    growthMinutes: 32,
    juvenileScale: 0.22,
    swim: 0.25,
    social: "herd",
    groupSize: [2, 4],
    aggression: 0.3,
    perception: 60,
    spawnWeight: 0.55,
    biomes: ["plains", "forest", "swamp"],
    call: { kind: "bellow", pitch: 90, duration: 2.0 },
    colors: {
      eye: "#3a2414",
      morphs: [
        { base: "#6f6a4c", dorsal: "#47442f", belly: "#c8bf98", pattern: "#34321f", light: "#d8d0a8", accent: "#b4542e" },
        { base: "#79674a", dorsal: "#4f412c", belly: "#cdb995", pattern: "#3a2d1e", light: "#e0cca6", accent: "#c9793a" },
        { base: "#5f6a56", dorsal: "#3c4536", belly: "#c0c2a2", pattern: "#2c3326", light: "#d4d6b6", accent: "#b9862e" },
      ],
      pattern: { bands: [0.9, 0.3, 2.6], spots: [0.4, 0.6], stripe: [0, 0, 0], dorsal: 0.7, mottle: 0.3 },
    },
    body: {
      plan: "quadruped",
      scaleTile: 0.55,
      trunk: [
        [-4.55, 1.6, 0.03, 0.035, 0.035],
        [-4.05, 1.72, 0.065, 0.08, 0.085, 2.1],
        [-3.15, 1.96, 0.14, 0.17, 0.18, 2.1],
        [-2.15, 2.26, 0.25, 0.28, 0.3, 2.2],
        [-1.1, 2.54, 0.42, 0.38, 0.48, 2.2, 0.05],
        [0.0, 2.68, 0.62, 0.44, 0.8, 2.3, 0.08],
        [0.85, 2.58, 0.72, 0.43, 1.0, 2.3, 0.1],
        [1.6, 2.3, 0.66, 0.4, 0.92, 2.3, 0.1],
        [2.25, 1.9, 0.46, 0.34, 0.64, 2.2, 0.06],
        [2.72, 1.6, 0.29, 0.24, 0.34],
        [3.12, 1.38, 0.2, 0.17, 0.22],
        [3.46, 1.22, 0.155, 0.13, 0.16],
      ],
      head: {
        at: [3.6, 1.1],
        length: 0.56,
        pitch: -0.32,
        stations: [
          [0.0, 0.13, 0.085, 0.085, 0],
          [0.14, 0.14, 0.09, 0.09, -0.05],
          [0.3, 0.125, 0.04, 0.078, -0.1],
          [0.5, 0.1, 0.03, 0.062, -0.1],
          [0.72, 0.082, 0.028, 0.05, -0.08],
          [0.9, 0.062, 0.026, 0.04, 0],
          [0.98, 0.04, 0.02, 0.028, 0],
          [1.0, 0.016, 0.01, 0.012, 0],
        ],
        jaw: { hinge: 0.1, depth: [[0, 0.06], [0.2, 0.075], [0.6, 0.05], [0.9, 0.035], [1, 0.015]], width: 0.84 },
        eye: { u: 0.27, v: 0.07, r: 0.022 },
        nostril: { u: 0.9, v: 0.035, r: 0.012 },
        beak: 0.2,
        teeth: null,
      },
      bones: { tail: 8, neck: 3, spineZ: 0.85, chestZ: 1.65, neckZ: 2.45, tailZ: -0.6 },
      hind: {
        x: 0.45, footX: 0.47, footZ: 0.05, thigh: 1.02, shin: 0.84, meta: 0.3, toe: 0.17, metaAngle: 0.12,
        radii: { top: [0.442, 0.572, 0.572], hip: [0.416, 0.52, 0.494], thigh: [0.351, 0.419, 0.405], knee: [0.18, 0.18, 0.18], calf: [0.175, 0.163, 0.213], ankle: [0.121, 0.121, 0.121], meta: [0.11, 0.11, 0.11], ball: [0.121, 0.121, 0.11] },
        foot: STUMPY_FOOT,
      },
      fore: {
        x: 0.48, y: 1.42, z: 2.15, footX: 0.55, footZ: 2.3, upper: 0.66, fore: 0.52, meta: 0.24, toe: 0.1, metaAngle: -0.05,
        radii: { top: [0.312, 0.375, 0.375], hip: [0.275, 0.312, 0.312], thigh: [0.221, 0.247, 0.234], knee: [0.15, 0.15, 0.15], calf: [0.138, 0.15, 0.138], ankle: [0.098, 0.103, 0.103], meta: [0.095, 0.095, 0.095], ball: [0.103, 0.103, 0.097] },
        foot: STUMPY_HAND,
      },
      features: { beak: true, plates: true, thagomizer: true, throatGular: true },
    },
  },

  allosaurus: {
    id: "allosaurus",
    name: "Allosaurus",
    diet: "carnivore",
    playable: true,
    tagline: "Utah's state fossil, and the Jurassic's apex predator.",
    description:
      "The Morrison's top hunter: a crested, heavy-jawed killer that strikes with its upper jaw like a hatchet. " +
      "Grow slowly, eat often, and once you're full-grown only giants from later ages will dare contest your kill.",
    era: "Late Jurassic · Morrison Formation",
    length: 9.5,
    height: 2.6,
    mass: 2300,
    health: 1300,
    bite: 85,
    biteCooldown: 1.3,
    biteRange: 1.8,
    attack: "bite",
    armor: 0.15,
    bleed: 2.5,
    speed: { walk: 2.2, trot: 5.5, sprint: 10.5, crouch: 1.5, swim: 2.2 },
    turnRate: 2.0,
    stamina: { regen: 8, sprintDrain: 9 },
    metabolism: { hunger: 4.0, thirst: 3.8 },
    growthMinutes: 35,
    juvenileScale: 0.2,
    swim: 0.35,
    social: "solo",
    groupSize: [1, 1],
    aggression: 0.85,
    perception: 100,
    spawnWeight: 0.35,
    biomes: ["plains", "forest", "highland"],
    call: { kind: "roar", pitch: 75, duration: 2.2 },
    colors: {
      eye: "#d8a032",
      morphs: [
        { base: "#7c6a50", dorsal: "#4a3c2c", belly: "#cbb995", pattern: "#3a2e22", light: "#d9c8a4", accent: "#a8452c" },
        { base: "#6c6a4c", dorsal: "#403f2d", belly: "#c4bc96", pattern: "#2f2e22", light: "#d4cca8", accent: "#b5522e" },
        { base: "#857058", dorsal: "#55443a", belly: "#d2c2a4", pattern: "#3f3128", light: "#e0d0b2", accent: "#9c3a2a" },
      ],
      pattern: { bands: [1.1, 0.35, 2.4], spots: [0.25, 0.64], stripe: [0, 0, 0], dorsal: 0.8, mottle: 0.28 },
    },
    body: {
      plan: "biped",
      scaleTile: 0.5,
      trunk: [
        [-5.2, 2.32, 0.018, 0.024, 0.024],
        [-4.6, 2.4, 0.045, 0.065, 0.065, 2, -0.2],
        [-3.6, 2.5, 0.095, 0.14, 0.145, 2, -0.25],
        [-2.5, 2.62, 0.17, 0.235, 0.255, 2, -0.2],
        [-1.45, 2.72, 0.27, 0.32, 0.37, 2, -0.12],
        [-0.65, 2.8, 0.38, 0.37, 0.6, 2, -0.05],
        [0.0, 2.85, 0.45, 0.39, 0.78],
        [0.62, 2.84, 0.52, 0.37, 1.02, 2, 0.12],
        [1.2, 2.8, 0.5, 0.35, 0.98, 2, 0.12],
        [1.68, 2.82, 0.38, 0.32, 0.66],
        [2.12, 3.0, 0.26, 0.25, 0.38],
        [2.55, 3.28, 0.21, 0.2, 0.28],
        [2.88, 3.44, 0.19, 0.18, 0.23],
      ],
      head: {
        at: [3.06, 3.32],
        length: 1.04,
        pitch: -0.14,
        stations: [
          [0.0, 0.37, 0.17, 0.155, -0.08],
          [0.1, 0.41, 0.19, 0.185, -0.14],
          [0.22, 0.39, 0.08, 0.17, -0.24],
          [0.36, 0.33, 0.04, 0.14, -0.3],
          [0.55, 0.265, 0.036, 0.115, -0.34],
          [0.74, 0.21, 0.036, 0.097, -0.34],
          [0.89, 0.16, 0.036, 0.083, -0.3],
          [0.97, 0.105, 0.034, 0.064, -0.18],
          [1.0, 0.045, 0.024, 0.03, 0],
        ],
        jaw: { hinge: 0.08, depth: [[0, 0.1], [0.15, 0.2], [0.42, 0.15], [0.75, 0.12], [0.94, 0.1], [1, 0.045]], width: 0.84 },
        eye: { u: 0.21, v: 0.27, r: 0.04 },
        nostril: { u: 0.93, v: 0.085, r: 0.018 },
        beak: 0,
        teeth: { upper: 14, lower: 13, length: 0.065, from: 0.28, to: 0.95 },
      },
      bones: { tail: 8, neck: 4, spineZ: 0.62, chestZ: 1.25, neckZ: 1.85, tailZ: -0.55 },
      hind: {
        x: 0.36, footX: 0.29, footZ: 0.14, thigh: 1.12, shin: 1.05, meta: 0.6, toe: 0.44, metaAngle: 0.44,
        radii: { top: [0.416, 0.546, 0.546], hip: [0.403, 0.52, 0.494], thigh: [0.324, 0.419, 0.392], knee: [0.15, 0.162, 0.162], calf: [0.144, 0.138, 0.206], ankle: [0.083, 0.088, 0.088], meta: [0.073, 0.075, 0.066], ball: [0.074, 0.074, 0.063] },
        foot: THEROPOD_FOOT,
      },
      arms: {
        x: 0.3, y: 2.38, z: 1.58, upper: 0.4, fore: 0.3, hand: 0.26,
        radii: [0.1, 0.065, 0.042],
        fingers: [{ yaw: -0.2, len: 0.85 }, { yaw: 0.0, len: 1.0 }, { yaw: 0.2, len: 0.75 }],
        claw: 0.38,
      },
      features: { teeth: true, browHorns: true, nasalRidge: true },
    },
  },

  tyrannosaurus: {
    id: "tyrannosaurus",
    name: "Tyrannosaurus rex",
    diet: "carnivore",
    playable: true,
    tagline: "The last tyrant, with the hardest bite of any land animal.",
    description:
      "A deep-skulled giant from the very end of the Cretaceous, with forward-facing eyes, a nose for carrion at a distance and jaws that crush bone. " +
      "You hatch fleet and leggy and grow into a slow, heavy-footed crusher: hunt by scent, close the gap before you tire, and let one bite do the work.",
    era: "Late Cretaceous · Hell Creek Formation, 68–66 Ma",
    length: 12,
    height: 3.5,
    mass: 8000,
    health: 3200,
    bite: 175, // the hardest in the game
    biteCooldown: 1.8,
    biteRange: 2.2,
    attack: "bite",
    armor: 0.15,
    bleed: 2, // crushing punctures: less slicing than Allosaurus or Utahraptor
    pierce: 0.5, // bone-crushing: armour counts half
    speed: { walk: 2.4, trot: 5.2, sprint: 8.5, crouch: 1.6, swim: 2.0 },
    turnRate: 1.35,
    stamina: { regen: 6, sprintDrain: 12.5 },
    attackStamina: 14,
    metabolism: { hunger: 3.6, thirst: 3.4 },
    growthMinutes: 50,
    juvenileScale: 0.16,
    juvenileSpeed: 1.12, // young tyrannosaurs were the fast ones
    swim: 0.35,
    social: "solo",
    groupSize: [1, 2],
    pairChance: 0.15, // now and then a pair, sometimes a parent with its young
    maxAlive: 2,
    aggression: 0.8,
    perception: 115,
    smell: 1.5, // huge olfactory bulbs
    spawnWeight: 0.07,
    biomes: ["forest", "plains", "highland"],
    // A closed-mouth boom under a growl; open / lift / swell shape the call pose (defaults 1 / 1 / 0).
    call: { kind: "rumble", pitch: 30, duration: 3.4, open: 0.65, lift: 0.3, swell: 0.06 },
    colors: {
      eye: "#b8862e",
      pupil: "round", // big predators have round pupils; other carnivores keep slits
      morphs: [
        { base: "#735a45", dorsal: "#3f2e24", belly: "#c4ae8c", pattern: "#2d2119", light: "#d6c2a0", accent: "#93492f" }, // umber
        { base: "#6e6d66", dorsal: "#3a3b37", belly: "#c9c5b5", pattern: "#2a2b28", light: "#d8d3c2", accent: "#81503c" }, // slate
        { base: "#8c7350", dorsal: "#57432d", belly: "#d4c096", pattern: "#3a2c1f", light: "#e2d0a8", accent: "#a45c30" }, // tawny
      ],
      // Drab and countershaded: broad, faint saddles over back and tail, light mottling, no stripe.
      pattern: { bands: [0.5, 0.4, 2.8], spots: [0.22, 0.64], stripe: [0, 0, 0], dorsal: 0.82, mottle: 0.36 },
    },
    body: {
      plan: "biped",
      scaleTile: 0.6,
      trunk: [
        // Heavy tail held near level, deep and wide at the base (the caudofemoralis).
        [-6.3, 3.34, 0.02, 0.028, 0.028],
        [-5.6, 3.42, 0.055, 0.085, 0.085, 2, -0.2],
        [-4.55, 3.55, 0.15, 0.22, 0.22, 2, -0.24],
        [-3.3, 3.68, 0.27, 0.36, 0.38, 2, -0.2],
        [-2.05, 3.79, 0.4, 0.46, 0.54, 2, -0.12],
        [-0.9, 3.86, 0.68, 0.52, 0.8, 2, -0.02],
        // Broad hips (the thighs blend in) and a deep barrel chest.
        [0.0, 3.88, 0.88, 0.54, 1.08, 2, 0.06],
        [0.8, 3.86, 0.9, 0.53, 1.38, 2, 0.12],
        [1.6, 3.82, 0.86, 0.52, 1.48, 2, 0.14],
        [2.35, 3.84, 0.72, 0.5, 1.24, 2, 0.1],
        // Short, bull neck that runs level into the skull (no dip, so no crease at the occiput).
        [2.9, 3.98, 0.56, 0.47, 0.88],
        [3.35, 4.15, 0.46, 0.48, 0.66],
        [3.72, 4.26, 0.41, 0.52, 0.54],
        [3.96, 4.3, 0.39, 0.55, 0.48],
      ],
      head: {
        at: [4.1, 4.3],
        length: 1.5,
        pitch: -0.08,
        cheek: 0.04, // jaw-muscle bulge behind the eye, × length (default 0.02)
        // Keyhole skull: cheeks flare to ~0.9 m behind the eyes, a deep, blunt, U-shaped muzzle in front.
        stations: [
          [0.0, 0.56, 0.36, 0.42, -0.18],
          [0.1, 0.62, 0.32, 0.49, -0.26],
          [0.22, 0.61, 0.12, 0.43, -0.34],
          [0.36, 0.55, 0.06, 0.3, -0.3],
          [0.52, 0.49, 0.055, 0.245, -0.24],
          [0.68, 0.44, 0.055, 0.225, -0.18],
          [0.82, 0.39, 0.055, 0.215, -0.12],
          [0.92, 0.335, 0.05, 0.2, -0.06],
          [0.975, 0.25, 0.045, 0.17, 0],
          [1.0, 0.1, 0.03, 0.09, 0],
        ],
        jaw: { hinge: 0.07, depth: [[0, 0.26], [0.12, 0.38], [0.4, 0.3], [0.7, 0.26], [0.92, 0.25], [1, 0.12]], width: 0.86 }, // deep, with a chin
        eye: { u: 0.25, v: 0.42, r: 0.055, fwd: 0.6 }, // fwd: gaze turned forward (binocular), default 0.28
        nostril: { u: 0.93, v: 0.2, r: 0.03 },
        beak: 0,
        teeth: { upper: 13, lower: 12, length: 0.16, from: 0.3, to: 0.96, thick: 0.36 }, // thick: round, banana-like crowns (default 0.15)
      },
      bones: { tail: 8, neck: 4, spineZ: 0.8, chestZ: 1.6, neckZ: 2.7, tailZ: -0.7 },
      hind: {
        x: 0.52, footX: 0.4, footZ: 0.16, thigh: 1.58, shin: 1.4, meta: 0.72, toe: 0.54, metaAngle: 0.45,
        radii: { top: [0.42, 0.8, 0.8], hip: [0.6, 0.84, 0.8], thigh: [0.52, 0.68, 0.64], knee: [0.28, 0.3, 0.3], calf: [0.29, 0.27, 0.45], ankle: [0.16, 0.17, 0.17], meta: [0.14, 0.15, 0.13], ball: [0.15, 0.15, 0.13] },
        foot: { ...THEROPOD_FOOT, claw: 0.24 }, // blunter claws on thick toes
      },
      arms: {
        x: 0.46, y: 2.95, z: 2.25, upper: 0.4, fore: 0.22, hand: 0.2,
        radii: [0.12, 0.085, 0.055],
        fingers: [{ yaw: -0.12, len: 0.9 }, { yaw: 0.12, len: 1.0 }], // two fingers
        claw: 0.42,
      },
      // Hatchling proportions, fading linearly to adult: legs = leg length relative to
      // the frame, head = [length, depth, width] multipliers.
      juvenile: { legs: 1.2, head: [1.12, 0.84, 0.84] },
      // bosses: rough skin-covered knobs [{ u along the skull, y as a fraction of its top
      // radius, h × head length }] (postorbital behind the eye, lacrimal ahead of it);
      // nasalBumps: rugose knobs down the snout's midline.
      features: { teeth: true, bosses: [{ u: 0.17, y: 0.9, h: 0.075 }, { u: 0.34, y: 0.86, h: 0.045 }], nasalBumps: 6 },
    },
  },

  spinosaurus: {
    id: "spinosaurus",
    name: "Spinosaurus",
    diet: "carnivore",
    playable: true,
    tagline: "A sail above the shallows, a trap of teeth below.",
    description:
      "The longest hunter on the island: a crocodile's snout, a sail of skin over its spines and a tail built like an oar. " +
      "Short-legged and slow on land, unmatched in water. Wait where the herds come down to drink, and leave the armoured giants to the tyrant.",
    era: "Mid-Cretaceous · Kem Kem and Bahariya, 99–93 Ma",
    length: 14,
    height: 2.3,
    mass: 7000,
    health: 2600,
    bite: 95,
    biteCooldown: 1.1,
    biteRange: 1.6,
    attack: "bite",
    armor: 0.1,
    bleed: 3, // deep conical punctures
    speed: { walk: 2.0, trot: 4.6, sprint: 7.8, crouch: 1.4, swim: 5.6 },
    turnRate: 1.5,
    stamina: { regen: 8, sprintDrain: 11 },
    metabolism: { hunger: 3.8, thirst: 3.2 },
    growthMinutes: 42,
    juvenileScale: 0.17,
    swim: 0.95, // the best swimmer on the island
    swimDepth: 1.15, // rides low: back and sail out, snout at the surface
    waterAffinity: 0.85,
    maxAlive: 1,
    social: "solo",
    groupSize: [1, 1],
    aggression: 0.6,
    perception: 105,
    spawnWeight: 0.12,
    biomes: ["swamp", "beach", "plains"],
    call: { kind: "rattle", pitch: 100, duration: 2.2, lift: 0.55 }, // lift: the long neck rises only part way
    colors: {
      eye: "#c2a640",
      morphs: [
        { base: "#6e6a50", dorsal: "#3b3a2c", belly: "#cbc2a0", pattern: "#2b2a21", light: "#d9d0ac", accent: "#b6532e" }, // river olive, rust sail band
        { base: "#87725a", dorsal: "#51412f", belly: "#d8c8a6", pattern: "#36291e", light: "#e6d7b6", accent: "#c8963c" }, // sand and umber, ochre band
        { base: "#5d655f", dorsal: "#333a37", belly: "#c3c3ad", pattern: "#242927", light: "#d3d3be", accent: "#8f3a2c" }, // slate, oxblood band
      ],
      // Crocodile-like cross-bands (they run up the sail as bars), light dappling, a dark back.
      // No stripe: one at rest-normal y ≈ 0 would flood the whole sail.
      pattern: { bands: [1.0, 0.52, 2.6], spots: [0.25, 0.63], stripe: [0, 0, 0], dorsal: 0.82, mottle: 0.3 },
    },
    body: {
      plan: "biped",
      scaleTile: 0.55,
      swimNeck: 0.05, // per-neck-bone pitch while swimming (default -0.12 lifts the head; this keeps it low)
      trunk: [
        // Paddle tail: tall neural spines and long chevrons, laterally flattened (square < 2 pinches top and bottom).
        [-7.35, 1.56, 0.01, 0.02, 0.02],
        [-6.9, 1.64, 0.026, 0.12, 0.1, 1.7],
        [-6.0, 1.8, 0.055, 0.34, 0.27, 1.6],
        [-4.8, 2.04, 0.09, 0.5, 0.4, 1.6],
        [-3.55, 2.3, 0.15, 0.56, 0.47, 1.65],
        [-2.35, 2.5, 0.25, 0.54, 0.5, 1.8, -0.08],
        [-1.25, 2.63, 0.38, 0.5, 0.56, 2, -0.1],
        [-0.5, 2.7, 0.52, 0.46, 0.72, 2, -0.05],
        // Long, fairly narrow trunk with a deep chest.
        [0.0, 2.72, 0.58, 0.44, 0.84],
        [0.75, 2.72, 0.6, 0.42, 1.0, 2, 0.08],
        [1.5, 2.68, 0.59, 0.4, 1.04, 2, 0.08],
        [2.2, 2.66, 0.47, 0.36, 0.86, 2, 0.06],
        // S-curved neck rising gently to a low-held head.
        [2.75, 2.74, 0.33, 0.3, 0.55],
        [3.3, 2.94, 0.26, 0.24, 0.38],
        [3.85, 3.1, 0.215, 0.2, 0.29],
        [4.4, 3.2, 0.188, 0.18, 0.23],
        [4.9, 3.24, 0.165, 0.17, 0.2],
      ],
      head: {
        at: [5.04, 3.2],
        length: 1.52,
        pitch: -0.14,
        stations: [
          [0.0, 0.3, 0.15, 0.13, -0.1],
          [0.1, 0.31, 0.15, 0.15, -0.16],
          [0.2, 0.27, 0.07, 0.135, -0.3],
          [0.29, 0.215, 0.04, 0.105, -0.45],
          [0.37, 0.235, 0.034, 0.09, -0.72], // the small nasal crest ahead of the eyes
          [0.45, 0.18, 0.03, 0.08, -0.5],
          [0.56, 0.138, 0.028, 0.07, -0.35],
          [0.68, 0.118, 0.026, 0.063, -0.3],
          [0.79, 0.098, 0.012, 0.054, -0.25], // the notch: narrowest, lip line rises
          [0.87, 0.112, 0.05, 0.072, -0.15],
          [0.94, 0.112, 0.07, 0.082, -0.08], // terminal rosette, premaxilla hanging over the jaw tip
          [0.985, 0.07, 0.05, 0.06, 0],
          [1.0, 0.028, 0.024, 0.03, 0],
        ],
        jaw: { hinge: 0.08, depth: [[0, 0.11], [0.15, 0.17], [0.45, 0.1], [0.75, 0.075], [0.83, 0.075], [0.92, 0.1], [1, 0.045]], width: 0.84 },
        eye: { u: 0.17, v: 0.24, r: 0.042 },
        nostril: { u: 0.49, v: 0.135, r: 0.032 }, // retracted to mid-snout, high on the side
        beak: 0,
        teeth: {
          upper: 15, lower: 14, length: 0.1, from: 0.34, to: 0.985,
          conical: true, rosette: 0.87, // straight round cones; past u 0.87 they splay forward and out
          size: [[0.34, 0.55], [0.6, 0.95], [0.78, 0.5], [0.84, 0.6], [0.93, 1.45], [0.985, 0.9]], // u → length multiplier
        },
      },
      bones: { tail: 10, neck: 5, spineZ: 0.85, chestZ: 1.75, neckZ: 2.75, tailZ: -0.7 },
      hind: {
        x: 0.42, footX: 0.36, footZ: 0.14, thigh: 1.06, shin: 0.9, meta: 0.46, toe: 0.5, metaAngle: 0.46,
        radii: { top: [0.3, 0.6, 0.6], hip: [0.46, 0.59, 0.56], thigh: [0.37, 0.47, 0.44], knee: [0.2, 0.21, 0.21], calf: [0.19, 0.185, 0.27], ankle: [0.115, 0.12, 0.12], meta: [0.1, 0.102, 0.09], ball: [0.1, 0.1, 0.088] },
        foot: WADER_FOOT,
      },
      arms: {
        x: 0.36, y: 2.35, z: 2.2, upper: 0.62, fore: 0.44, hand: 0.38,
        radii: [0.13, 0.085, 0.055],
        // Digit I carries the great hooked thumb claw (per-finger claw / r override the hand's).
        fingers: [{ yaw: -0.24, len: 0.95, claw: 0.66, r: 1.3 }, { yaw: -0.02, len: 1.0, claw: 0.4 }, { yaw: 0.2, len: 0.8, claw: 0.36 }],
        claw: 0.4,
      },
      features: {
        teeth: true,
        // A continuous skin membrane over the neural spines.
        sail: {
          // [z, height above the back (m)]: a rounded "M", tallest over the posterior dorsals.
          profile: [[2.85, 0], [2.5, 0.5], [2.1, 1.1], [1.7, 1.4], [1.35, 1.38], [1.0, 1.18], [0.6, 1.38], [0.15, 1.62], [-0.35, 1.5], [-0.9, 1.05], [-1.5, 0.48], [-2.05, 0.12], [-2.45, 0]],
          spines: 17, // ribs in the membrane
          thick: 0.075, // half-thickness at the root (m), thinning toward the rim
          rake: 0.1, // spines lean back (rad)
        },
      },
    },
  },

  camptosaurus: {
    id: "camptosaurus",
    name: "Camptosaurus",
    diet: "herbivore",
    playable: false,
    tagline: "The Morrison's everyday grazer: wary, common and tasty.",
    description:
      "A sturdy, beaked ornithopod that grazes on all fours and rises onto its hind legs to run. " +
      "Its herds are the staple prey of every predator on the island.",
    era: "Late Jurassic · Morrison Formation",
    length: 6,
    height: 1.6,
    mass: 700,
    health: 420,
    bite: 20,
    biteCooldown: 1.2,
    biteRange: 1.0,
    attack: "kick",
    armor: 0,
    bleed: 0.8,
    speed: { walk: 1.7, trot: 4.5, sprint: 9.5, crouch: 1.2, swim: 1.6 },
    turnRate: 2.6,
    stamina: { regen: 10, sprintDrain: 9 },
    metabolism: { hunger: 4.0, thirst: 4.2 },
    growthMinutes: 24,
    juvenileScale: 0.25,
    swim: 0.3,
    social: "herd",
    groupSize: [3, 7],
    aggression: 0.1,
    perception: 90,
    spawnWeight: 1.6,
    biomes: ["plains", "forest", "swamp"],
    call: { kind: "honk", pitch: 210, duration: 0.8 },
    colors: {
      eye: "#3a2616",
      morphs: [
        { base: "#827757", dorsal: "#5a5040", belly: "#d1c6a2", pattern: "#463c2e", light: "#e2d6b2", accent: "#9b6f44" },
        { base: "#76785a", dorsal: "#4e523c", belly: "#cfcca8", pattern: "#3a3d2c", light: "#dedcb8", accent: "#a07a42" },
        { base: "#8f7a5c", dorsal: "#614e3c", belly: "#d8c8a8", pattern: "#4a3a2c", light: "#e8d8b8", accent: "#8a5a38" },
      ],
      pattern: { bands: [1.4, 0.45, 2.2], spots: [0.3, 0.62], stripe: [0.3, 0.12, 0.22], dorsal: 0.75, mottle: 0.28 },
    },
    body: {
      plan: "quadruped",
      scaleTile: 0.32,
      bipedalSprint: true,
      trunk: [
        [-3.2, 1.42, 0.014, 0.018, 0.018],
        [-2.7, 1.47, 0.04, 0.05, 0.052, 2, -0.2],
        [-1.95, 1.56, 0.08, 0.11, 0.12, 2, -0.25],
        [-1.05, 1.67, 0.16, 0.2, 0.23, 2, -0.15],
        [-0.35, 1.75, 0.26, 0.25, 0.42, 2, -0.05],
        [0.0, 1.77, 0.3, 0.26, 0.52],
        [0.5, 1.73, 0.35, 0.26, 0.68, 2, 0.1],
        [1.02, 1.63, 0.33, 0.24, 0.6, 2, 0.1],
        [1.45, 1.53, 0.25, 0.21, 0.4],
        [1.8, 1.55, 0.16, 0.15, 0.2],
        [2.1, 1.66, 0.115, 0.115, 0.14],
        [2.33, 1.73, 0.1, 0.1, 0.12],
      ],
      head: {
        at: [2.44, 1.67],
        length: 0.56,
        pitch: -0.36,
        stations: [
          [0.0, 0.13, 0.08, 0.072, 0],
          [0.12, 0.148, 0.085, 0.082, -0.08],
          [0.28, 0.142, 0.032, 0.076, -0.14],
          [0.48, 0.118, 0.026, 0.058, -0.18],
          [0.7, 0.095, 0.025, 0.045, -0.16],
          [0.88, 0.075, 0.025, 0.038, -0.06],
          [0.97, 0.05, 0.02, 0.03, 0],
          [1.0, 0.02, 0.01, 0.014, 0],
        ],
        jaw: { hinge: 0.1, depth: [[0, 0.06], [0.18, 0.08], [0.55, 0.055], [0.88, 0.035], [1, 0.014]], width: 0.84 },
        eye: { u: 0.27, v: 0.09, r: 0.024 },
        nostril: { u: 0.9, v: 0.045, r: 0.013 },
        beak: 0.18,
        teeth: null,
      },
      bones: { tail: 8, neck: 3, spineZ: 0.5, chestZ: 1.05, neckZ: 1.62, tailZ: -0.4 },
      hind: {
        x: 0.22, footX: 0.2, footZ: 0.06, thigh: 0.66, shin: 0.66, meta: 0.36, toe: 0.19, metaAngle: 0.38,
        radii: { top: [0.26, 0.338, 0.338], hip: [0.247, 0.312, 0.299], thigh: [0.203, 0.243, 0.23], knee: [0.084, 0.09, 0.09], calf: [0.085, 0.083, 0.119], ankle: [0.046, 0.05, 0.05], meta: [0.042, 0.044, 0.04], ball: [0.044, 0.044, 0.038] },
        foot: ORNITHOPOD_FOOT,
      },
      fore: {
        x: 0.21, y: 1.0, z: 1.42, footX: 0.24, footZ: 1.54, upper: 0.52, fore: 0.44, meta: 0.16, toe: 0.07, metaAngle: -0.08,
        radii: { top: [0.138, 0.175, 0.175], hip: [0.125, 0.15, 0.15], thigh: [0.098, 0.111, 0.104], knee: [0.062, 0.062, 0.062], calf: [0.062, 0.069, 0.062], ankle: [0.04, 0.044, 0.044], meta: [0.038, 0.038, 0.038], ball: [0.039, 0.039, 0.037] },
        foot: { ...STUMPY_HAND, toes: STUMPY_HAND.toes.slice(1, 4), pad: false, thumbSpike: true },
      },
      features: { beak: true },
    },
  },

  diplodocus: {
    id: "diplodocus",
    name: "Diplodocus",
    diet: "herbivore",
    playable: false,
    tagline: "A 26-metre giant with a neck for treetops and a whip.",
    description:
      "A gentle titan that sweeps its long neck through the canopy while the ground trembles under its feet. " +
      "It ignores almost everything until it is cornered, when one crack of that whip-like tail can floor a predator.",
    era: "Late Jurassic · Morrison Formation",
    length: 26,
    height: 3.6,
    mass: 15000,
    health: 6000,
    bite: 140,
    biteCooldown: 2.2,
    biteRange: 4,
    attack: "tail",
    armor: 0.2,
    bleed: 3,
    speed: { walk: 1.6, trot: 2.8, sprint: 4.2, crouch: 1.2, swim: 1.5 },
    turnRate: 0.7,
    stamina: { regen: 6, sprintDrain: 9 },
    metabolism: { hunger: 2.4, thirst: 2.8 },
    growthMinutes: 60,
    juvenileScale: 0.15,
    swim: 0.3,
    social: "herd",
    groupSize: [2, 4],
    aggression: 0.15,
    perception: 80,
    spawnWeight: 0.18,
    biomes: ["plains", "swamp", "beach"],
    call: { kind: "bellow", pitch: 45, duration: 3.0 },
    colors: {
      eye: "#2e2012",
      morphs: [
        { base: "#7a7466", dorsal: "#57524a", belly: "#c9c1ad", pattern: "#46423a", light: "#d8d0bc", accent: "#7a5a40" },
        { base: "#827058", dorsal: "#5c4c3c", belly: "#cfbea2", pattern: "#4a3c2e", light: "#dccaae", accent: "#6a4a34" },
        { base: "#6d7262", dorsal: "#4b5044", belly: "#c4c6b0", pattern: "#3c4036", light: "#d4d6c0", accent: "#6e5a44" },
      ],
      pattern: { bands: [0.55, 0.45, 3], spots: [0.3, 0.62], stripe: [0, 0, 0], dorsal: 0.6, mottle: 0.32 },
    },
    body: {
      plan: "quadruped",
      scaleTile: 0.9,
      trunk: [
        [-14.02, 1.3, 0.012, 0.012, 0.012],
        [-12.67, 1.55, 0.026, 0.028, 0.028],
        [-10.94, 2.0, 0.055, 0.06, 0.06],
        [-9.02, 2.6, 0.11, 0.13, 0.13],
        [-7.01, 3.2, 0.19, 0.24, 0.24, 2, -0.1],
        [-4.99, 3.75, 0.31, 0.37, 0.39, 2, -0.1],
        [-2.98, 4.15, 0.5, 0.52, 0.58, 2.1],
        [-1.4, 4.33, 0.78, 0.6, 1.05, 2.2, 0.05],
        [0, 4.3, 0.98, 0.62, 1.35, 2.2, 0.08],
        [1.25, 4.18, 1.12, 0.6, 1.7, 2.2, 0.1],
        [3.15, 4.02, 1.06, 0.58, 1.62, 2.2, 0.1],
        [4.1, 3.95, 0.84, 0.56, 1.2, 2.1, 0.05],
        [5.05, 4.15, 0.62, 0.5, 0.78],
        [6.5, 4.7, 0.44, 0.38, 0.5],
        [8.1, 5.3, 0.33, 0.28, 0.36],
        [9.7, 5.82, 0.23, 0.2, 0.25],
        [11.05, 6.15, 0.15, 0.14, 0.16],
      ],
      head: {
        at: [11.32, 6.13],
        length: 0.66,
        pitch: -0.42,
        stations: [
          [0.0, 0.15, 0.09, 0.1, 0],
          [0.14, 0.2, 0.095, 0.112, -0.1],
          [0.3, 0.16, 0.04, 0.1, -0.08],
          [0.5, 0.105, 0.03, 0.086, 0],
          [0.72, 0.085, 0.03, 0.08, 0.04],
          [0.9, 0.072, 0.03, 0.078, 0.06],
          [0.98, 0.05, 0.025, 0.068, 0.06],
          [1.0, 0.02, 0.012, 0.036, 0],
        ],
        jaw: { hinge: 0.1, depth: [[0, 0.06], [0.2, 0.065], [0.6, 0.05], [0.92, 0.045], [1, 0.02]], width: 0.86 },
        eye: { u: 0.25, v: 0.12, r: 0.03 },
        nostril: { u: 0.2, v: 0.19, r: 0.022, top: true },
        beak: 0,
        teeth: { upper: 9, lower: 8, length: 0.035, from: 0.7, to: 0.98, peg: true },
      },
      bones: { tail: 12, neck: 8, spineZ: 1.4, chestZ: 3.0, neckZ: 4.6, tailZ: -1.3 },
      hind: {
        x: 0.72, footX: 0.76, footZ: 0.1, thigh: 1.78, shin: 1.38, meta: 0.45, toe: 0.24, metaAngle: 0.1,
        radii: { top: [0.715, 0.91, 0.91], hip: [0.65, 0.806, 0.78], thigh: [0.54, 0.621, 0.594], knee: [0.288, 0.288, 0.288], calf: [0.275, 0.263, 0.312], ankle: [0.198, 0.198, 0.198], meta: [0.187, 0.187, 0.187], ball: [0.2, 0.2, 0.189] },
        foot: STUMPY_FOOT,
      },
      fore: {
        x: 0.76, y: 3.05, z: 3.95, footX: 0.82, footZ: 4.05, upper: 1.36, fore: 1.1, meta: 0.56, toe: 0.08, metaAngle: -0.03,
        radii: { top: [0.525, 0.65, 0.65], hip: [0.475, 0.55, 0.55], thigh: [0.364, 0.416, 0.39], knee: [0.25, 0.25, 0.25], calf: [0.237, 0.25, 0.237], ankle: [0.184, 0.184, 0.184], meta: [0.174, 0.174, 0.174], ball: [0.184, 0.184, 0.178] },
        foot: { kind: "column", toes: [], hallux: false, claw: 0, pad: true, thumbClaw: true },
      },
      features: { teeth: true, dorsalSpines: true },
    },
  },

  brontosaurus: {
    id: "brontosaurus",
    name: "Brontosaurus",
    diet: "herbivore",
    playable: true,
    tagline: "Hatch the size of a dog. Grow into a mountain.",
    description:
      "A thunderously heavy sauropod with a neck like a slab of rock and a tail that cracks like a whip. " +
      "You hatch tiny and defenceless among giants, so hide, browse and keep growing until you're the largest animal on the island.",
    era: "Late Jurassic · Morrison Formation",
    length: 22,
    height: 4.6,
    mass: 15000,
    health: 5200,
    bite: 150,
    biteCooldown: 2.8,
    biteRange: 3.6,
    attack: "tail",
    armor: 0.15,
    bleed: 2,
    speed: { walk: 1.7, trot: 3.3, sprint: 5.0, crouch: 1.2, swim: 1.8 },
    turnRate: 0.9,
    stamina: { regen: 6, sprintDrain: 9 },
    metabolism: { hunger: 2.5, thirst: 2.9 },
    growthMinutes: 45,
    juvenileScale: 0.12,
    swim: 0.5,
    social: "herd",
    groupSize: [2, 5],
    aggression: 0.12,
    perception: 70,
    spawnWeight: 0.7,
    biomes: ["plains", "swamp", "beach"],
    call: { kind: "bellow", pitch: 38, duration: 3.4 },
    colors: {
      eye: "#2a1d10",
      morphs: [
        { base: "#7a6c58", dorsal: "#524637", belly: "#cbbd9f", pattern: "#4a3e31", light: "#d8caa9", accent: "#8e7356" },
        { base: "#6e6c5a", dorsal: "#48473a", belly: "#c4c0a4", pattern: "#3d3c31", light: "#d2cfb2", accent: "#857456" },
        { base: "#82705d", dorsal: "#5a4b3e", belly: "#d1c2a7", pattern: "#4b3e33", light: "#dccdb2", accent: "#977055" },
        { base: "#6b6b62", dorsal: "#46473f", belly: "#c3c1ae", pattern: "#3a3b33", light: "#d0cfbd", accent: "#7d6c58" },
      ],
      // No stripes (that's Diplodocus): broad dapples, soft mottling, a dark back.
      pattern: { bands: [0, 0.6, 3], spots: [0.55, 0.53], stripe: [0, 0, 0], dorsal: 0.82, mottle: 0.5 },
    },
    body: {
      plan: "quadruped",
      scaleTile: 0.85,
      neckFlexBase: 0.7, // lowers the neck from the shoulders to drink, like a crane's jib
      feedLean: 0.25,
      trunk: [
        // Whip tail: shorter and heavier than Diplodocus'.
        [-10.6, 1.5, 0.014, 0.014, 0.014],
        [-9.5, 1.85, 0.04, 0.042, 0.042],
        [-8.1, 2.42, 0.095, 0.105, 0.105],
        [-6.6, 3.08, 0.19, 0.22, 0.22],
        [-5.1, 3.76, 0.32, 0.37, 0.39, 2, -0.1],
        [-3.55, 4.45, 0.51, 0.53, 0.61, 2.1],
        [-2.0, 5.02, 0.77, 0.64, 0.9, 2.2, 0.04],
        // Barrel torso: broad, deep-chested, near-level back with a high shoulder line.
        [-0.85, 5.3, 1.04, 0.72, 1.38, 2.2, 0.06],
        [0.35, 5.38, 1.24, 0.75, 1.78, 2.25, 0.08],
        [1.6, 5.36, 1.4, 0.75, 2.12, 2.25, 0.1],
        [2.85, 5.31, 1.42, 0.74, 2.2, 2.25, 0.1],
        [3.95, 5.24, 1.2, 0.72, 1.92, 2.2, 0.06],
        // Neck: deep and broad-bottomed (the cervical ribs), narrow along the top.
        [4.9, 5.38, 0.92, 0.62, 1.46, 2.4, -0.25],
        [6.0, 5.8, 0.77, 0.51, 1.18, 2.7, -0.48],
        [7.25, 6.28, 0.65, 0.43, 1.0, 2.9, -0.55],
        [8.5, 6.74, 0.55, 0.37, 0.86, 2.9, -0.55],
        [9.65, 7.1, 0.43, 0.31, 0.66, 2.7, -0.45],
        [10.45, 7.28, 0.25, 0.22, 0.33, 2.3, -0.2],
      ],
      head: {
        at: [10.68, 7.24],
        length: 0.74,
        pitch: -0.5,
        square: 2.5,
        stations: [
          [0.0, 0.2, 0.12, 0.14, 0],
          [0.13, 0.25, 0.12, 0.155, -0.08],
          [0.28, 0.23, 0.05, 0.145, -0.06],
          [0.46, 0.17, 0.04, 0.13, 0],
          [0.66, 0.14, 0.04, 0.125, 0.04],
          [0.84, 0.13, 0.04, 0.125, 0.06],
          [0.95, 0.11, 0.035, 0.115, 0.06],
          [1.0, 0.04, 0.02, 0.06, 0],
        ],
        jaw: { hinge: 0.1, depth: [[0, 0.08], [0.2, 0.085], [0.6, 0.07], [0.92, 0.065], [1, 0.03]], width: 0.88 },
        eye: { u: 0.24, v: 0.15, r: 0.035 },
        nostril: { u: 0.2, v: 0.23, r: 0.026, top: true },
        beak: 0,
        teeth: { upper: 9, lower: 8, length: 0.04, from: 0.68, to: 0.98, peg: true },
      },
      bones: { tail: 11, neck: 8, spineZ: 1.5, chestZ: 3.2, neckZ: 4.75, tailZ: -1.4 },
      hind: {
        x: 0.95, footX: 1.0, footZ: 0.1, thigh: 2.1, shin: 1.62, meta: 0.55, toe: 0.3, metaAngle: 0.1,
        radii: { top: [1.05, 1.25, 1.25], hip: [0.95, 1.12, 1.08], thigh: [0.82, 0.92, 0.88], knee: [0.52, 0.5, 0.5], calf: [0.5, 0.48, 0.56], ankle: [0.4, 0.4, 0.42], meta: [0.42, 0.42, 0.42], ball: [0.48, 0.48, 0.45] },
        foot: ELEPHANT_FOOT,
      },
      fore: {
        x: 0.98, y: 4.25, z: 3.85, footX: 1.04, footZ: 3.95, upper: 1.8, fore: 1.48, meta: 0.7, toe: 0.1, metaAngle: -0.03,
        radii: { top: [0.78, 0.92, 0.92], hip: [0.7, 0.8, 0.8], thigh: [0.56, 0.62, 0.58], knee: [0.42, 0.42, 0.42], calf: [0.4, 0.42, 0.4], ankle: [0.34, 0.35, 0.35], meta: [0.35, 0.35, 0.35], ball: [0.4, 0.4, 0.38] },
        foot: { kind: "column", toes: [], hallux: false, claw: 0, pad: true, thumbClaw: true },
      },
      features: { teeth: true },
    },
  },
};

export const PLAYABLE = ["dryosaurus", "utahraptor", "ceratosaurus", "stegosaurus", "allosaurus", "brontosaurus", "tyrannosaurus", "spinosaurus"];

/**
 * Look up a species definition.
 * @param {string} id
 * @returns {object} SpeciesDef
 */
export function getSpecies(id) {
  const sp = SPECIES[id];
  if (!sp) throw new Error(`[species] unknown species "${id}"`);
  return sp;
}

/**
 * Current body scale for a growth value: juvenileScale at hatching → 1 adult.
 * Eased so hatchlings put on size quickly and the last stretch to adulthood
 * is a slower filling-out (the curve flattens toward 1).
 * @param {object} species SpeciesDef
 * @param {number} growth 0..1
 */
export function growthScale(species, growth) {
  const g = Math.min(1, Math.max(0, growth || 0));
  const eased = 1 - (1 - g) * (1 - g); // ease-out quad
  const j = species.juvenileScale ?? 0.3;
  return j + (1 - j) * eased;
}

/**
 * Life stage for a growth value (ARCHITECTURE.md: juvenile [0, 0.4), sub-adult [0.4, 1), adult 1).
 * @param {number} growth 0..1
 * @returns {"juvenile"|"subadult"|"adult"}
 */
export function growthStage(growth) {
  if (growth >= 1) return "adult";
  if (growth >= 0.4) return "subadult";
  return "juvenile";
}
