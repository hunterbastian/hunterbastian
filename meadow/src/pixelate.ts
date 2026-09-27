import * as THREE from 'three';

export interface PixelSettings {
  /** Size of one "art pixel" in CSS pixels. 1 = full resolution. */
  pixelSize: number;
  /** Colour levels per channel after dithering. */
  levels: number;
  dither: boolean;
  /** Snap to the hand-picked palette instead of per-channel levels. */
  palette: boolean;
}

// Hand-picked, cosy palette (sRGB): greens, dirt, stone, sky, warm light.
const PALETTE_HEX = [
  0x151812, 0x0f1f0c, 0x1d3512, 0x2d4d18, 0x3f661f, 0x5a8229, 0x7c9e38, 0xa3b95a, 0xc8d288,
  0x3b2a1b, 0x5c4127, 0x80603a, 0xa5845a, 0xc7a97a,
  0x6e6150, 0x8f7f68, 0xb09d7f, 0xcfbd9c, 0xe6dbc2,
  0x9fb4c8, 0xc2d0dc, 0xdde6ec, 0xf4f1e6,
  0xf0c890, 0xd98f5a, 0x7a86a0,
];
const PALETTE = PALETTE_HEX.map((h) => new THREE.Vector3(((h >> 16) & 255) / 255, ((h >> 8) & 255) / 255, (h & 255) / 255));

/**
 * Renders the scene into a small linear render target, then blows it up with
 * nearest-neighbour sampling while tone-mapping, ordered (Bayer 4×4) dithering and
 * quantising colours — a crunchy, pixel-art look.
 */
export class Pixelator {
  readonly settings: PixelSettings = { pixelSize: 4, levels: 6, dither: true, palette: true };
  private target: THREE.WebGLRenderTarget;
  private quadScene = new THREE.Scene();
  private quadCamera = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);
  private uniforms = {
    tScene: { value: null as THREE.Texture | null },
    uRes: { value: new THREE.Vector2(1, 1) },
    uLevels: { value: 7 },
    uDither: { value: 1 },
    uUsePalette: { value: 1 },
    uPalette: { value: PALETTE },
  };

  constructor(private renderer: THREE.WebGLRenderer) {
    this.target = new THREE.WebGLRenderTarget(1, 1, {
      type: THREE.HalfFloatType,
      minFilter: THREE.NearestFilter,
      magFilter: THREE.NearestFilter,
      depthBuffer: true,
    });
    this.uniforms.tScene.value = this.target.texture;

    const mat = new THREE.ShaderMaterial({
      uniforms: this.uniforms,
      depthTest: false,
      depthWrite: false,
      vertexShader: /* glsl */ `
        varying vec2 vUv;
        void main() {
          vUv = uv;
          gl_Position = vec4(position.xy, 0.0, 1.0);
        }`,
      fragmentShader: /* glsl */ `
        uniform sampler2D tScene;
        uniform vec2 uRes;
        uniform float uLevels;
        uniform float uDither;
        uniform float uUsePalette;
        uniform vec3 uPalette[${PALETTE.length}];
        varying vec2 vUv;

        vec3 nearest(vec3 c) {
          vec3 best = uPalette[0];
          float bestD = 1e9;
          for (int i = 0; i < ${PALETTE.length}; i++) {
            vec3 d = (c - uPalette[i]) * vec3(0.9, 1.2, 0.7);
            float dd = dot(d, d);
            if (dd < bestD) { bestD = dd; best = uPalette[i]; }
          }
          return best;
        }

        float bayer4(vec2 p) {
          vec2 q = mod(floor(p), 4.0);
          int i = int(q.x + q.y * 4.0);
          int m[16] = int[16](0, 8, 2, 10, 12, 4, 14, 6, 3, 11, 1, 9, 15, 7, 13, 5);
          return (float(m[i]) + 0.5) / 16.0;
        }

        void main() {
          vec2 cell = floor(vUv * uRes);
          vec2 uv = (cell + 0.5) / uRes;
          gl_FragColor = texture2D(tScene, uv);
          #include <tonemapping_fragment>
          #include <colorspace_fragment>

          vec3 c = gl_FragColor.rgb;
          // A touch of warmth and contrast so the reduced palette stays cosy.
          c = mix(vec3(dot(c, vec3(0.299, 0.587, 0.114))), c, 1.08);
          float threshold = mix(0.5, bayer4(cell), uDither);
          if (uUsePalette > 0.5) {
            c = nearest(c + (threshold - 0.5) * 0.14);
          } else {
            float steps = uLevels - 1.0;
            c = floor(c * steps + threshold) / steps;
          }
          gl_FragColor = vec4(clamp(c, 0.0, 1.0), 1.0);
        }`,
    });
    const quad = new THREE.Mesh(new THREE.PlaneGeometry(2, 2), mat);
    quad.frustumCulled = false;
    this.quadScene.add(quad);
  }

  get enabled(): boolean {
    return this.settings.pixelSize > 1 || this.settings.dither;
  }

  resize(): void {
    const s = Math.max(1, this.settings.pixelSize);
    // pixelSize 1 still renders at device resolution so "off" looks crisp.
    const scale = s === 1 ? this.renderer.getPixelRatio() : 1 / s;
    const w = Math.max(1, Math.floor(innerWidth * scale));
    const h = Math.max(1, Math.floor(innerHeight * scale));
    this.target.setSize(w, h);
    this.uniforms.uRes.value.set(w, h);
  }

  render(scene: THREE.Scene, camera: THREE.Camera): void {
    if (!this.enabled) {
      this.renderer.setRenderTarget(null);
      this.renderer.render(scene, camera);
      return;
    }
    this.uniforms.uLevels.value = this.settings.levels;
    this.uniforms.uDither.value = this.settings.dither ? 1 : 0;
    this.uniforms.uUsePalette.value = this.settings.palette ? 1 : 0;
    this.renderer.setRenderTarget(this.target);
    this.renderer.render(scene, camera);
    this.renderer.setRenderTarget(null);
    this.renderer.render(this.quadScene, this.quadCamera);
  }
}
