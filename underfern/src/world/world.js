// World — owns everything that exists on the island: terrain, water, sky,
// vegetation, wind and the ecosystem of creatures. main.js builds one per seed
// and drives it with update(dt, focus) every frame.

import { WORLD, TIME, GAME, QUALITY } from "../config.js";
import { EventBus } from "../core/events.js";
import { makeRng, hash } from "../core/rng.js";
import { Terrain } from "./terrain.js";
import { Water } from "./water.js";
import { Sky } from "./sky.js";
import { Vegetation } from "./vegetation.js";
import { Wind } from "./wind.js";
import { Ecosystem } from "../creatures/ecosystem.js";
import { SPECIES } from "../creatures/species.js";
import { prewarmDinoGeometry } from "../creatures/dinoModel.js";

/** Resolve after the browser has had a chance to paint (keeps loading UI alive). */
const nextFrame = () =>
  new Promise((resolve) => {
    if (typeof requestAnimationFrame === "function") requestAnimationFrame(() => setTimeout(resolve, 0));
    else setTimeout(resolve, 0);
  });

export class World {
  /**
   * Build the whole island synchronously. Prefer `World.create()` in the app so
   * the loading screen can repaint between the heavy steps.
   * @param {{ scene: THREE.Scene, camera: THREE.Camera, renderer?: THREE.WebGLRenderer,
   *           seed?: number, quality?: object, startPhase?: number, deferred?: boolean }} opts
   */
  constructor({ scene, camera, renderer = null, seed = WORLD.seed, quality = QUALITY.high, startPhase = TIME.startPhase, deferred = false } = {}) {
    this.scene = scene;
    this.camera = camera;
    this.renderer = renderer;
    this.seed = seed >>> 0;
    this.quality = quality;
    this.startPhase = startPhase;
    this.events = new EventBus();
    this.rng = makeRng(hash(this.seed, "world"));
    /** Seconds of simulated time since the world was built. */
    this.time = 0;

    this.terrain = null;
    this.water = null;
    this.sky = null;
    this.vegetation = null;
    this.wind = null;
    this.ecosystem = null;

    if (!deferred) for (const step of this._steps()) step.run();
  }

  /**
   * Build a world step by step, yielding to the browser between steps.
   * @param {object} opts same as the constructor
   * @param {(progress: number, label: string) => void} [onProgress]
   * @returns {Promise<World>}
   */
  static async create(opts, onProgress = () => {}) {
    const world = new World({ ...opts, deferred: true });
    const steps = world._steps();
    let done = 0;
    for (const step of steps) {
      onProgress(done / steps.length, step.label);
      await nextFrame();
      step.run();
      done += step.weight;
    }
    onProgress(1, "Ready");
    await nextFrame();
    return world;
  }

  /** The player's creature, if any. */
  get player() {
    return this.ecosystem ? this.ecosystem.player : null;
  }

  /**
   * Advance the world one frame.
   * @param {number} dt seconds (already clamped by main)
   * @param {THREE.Vector3|{x:number,y?:number,z:number}} focus where the action is (player or camera)
   */
  update(dt, focus) {
    this.time += dt;
    if (this.wind) this.wind.update(dt);
    this.sky.update(dt, focus, this.camera);
    if (this.vegetation) this.vegetation.update(dt, focus);
    this.ecosystem.update(dt, focus);
    this.water.update(dt, this.sky);
  }

  /** Free GPU resources and detach everything from the scene. */
  dispose() {
    this.ecosystem?.clear();
    if (this.vegetation) {
      this.scene.remove(this.vegetation.group);
      this.vegetation.dispose?.();
    }
    if (this.water) {
      this.scene.remove(this.water.mesh);
      this.water.dispose?.();
    }
    this.sky?.dispose?.();
    if (this.terrain) {
      this.scene.remove(this.terrain.mesh);
      this.terrain.dispose?.();
    }
  }

  /* --- Construction steps ------------------------------------------------ */

  /** Ordered build steps; `weight` is the share of the progress bar each takes. */
  _steps() {
    const q = this.quality || QUALITY.high;
    return [
      {
        label: "Raising the island",
        weight: 0.45,
        run: () => {
          this.terrain = new Terrain({
            size: WORLD.size,
            resolution: q.terrainResolution || WORLD.resolution,
            seed: this.seed,
            seaLevel: WORLD.seaLevel,
            maxHeight: WORLD.maxHeight,
          });
          this.scene.add(this.terrain.mesh);
        },
      },
      {
        label: "Filling the lakes",
        weight: 0.1,
        run: () => {
          this.sky = new Sky(this.scene, {
            startPhase: this.startPhase,
            dayLengthSec: TIME.dayLengthSec,
            viewDistance: q.viewDistance,
            shadows: q.shadows,
            shadowMapSize: q.shadowMapSize,
          });
          this.sky.onNewDay = (day) => this.events.emit("newDay", { day });
          this.water = new Water(this.terrain);
          this.scene.add(this.water.mesh);
          this.wind = new Wind(hash(this.seed, "wind"));
        },
      },
      {
        label: "Growing the forests",
        weight: 0.3,
        run: () => {
          this.vegetation = new Vegetation(this.terrain, {
            seed: hash(this.seed, "vegetation"),
            density: q.vegetationDensity,
            grass: q.grass,
            renderer: this.renderer,
          });
          // Sway follows the same wind that carries scent.
          if (this.wind) this.vegetation.wind = this.wind;
          this.scene.add(this.vegetation.group);
        },
      },
      {
        label: "Waking the dinosaurs",
        weight: 0.15,
        run: () => {
          // Build every species' shared skin once now, not as a hitch on first spawn.
          prewarmDinoGeometry(Object.keys(SPECIES));
          this.ecosystem = new Ecosystem(this, {
            seed: hash(this.seed, "ecosystem"),
            npcCap: Math.round(GAME.npcCap * (q.npcScale ?? 1)),
          });
        },
      },
    ];
  }
}
