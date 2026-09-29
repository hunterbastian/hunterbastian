import * as THREE from "three";
import { paletteSRGB } from "./palette";

// The heart of the look: the scene is drawn into a tiny render target, then
// every pixel is nudged by a 4×4 Bayer threshold and snapped to the nearest
// palette color. The canvas itself is low-res and upscaled with
// `image-rendering: pixelated`, so each dither dot is a crisp chunky square.

export const DITHER_MODES = ["palette", "posterize", "off"] as const;
export type DitherMode = (typeof DITHER_MODES)[number];

export class DitherPass {
  readonly target: THREE.WebGLRenderTarget;
  private readonly scene = new THREE.Scene();
  private readonly camera = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);
  private readonly material: THREE.ShaderMaterial;

  constructor(renderer: THREE.WebGLRenderer) {
    // Half-float keeps dark gradients smooth before dithering, but not every
    // mobile GPU can render to it — fall back to 8-bit where it can't.
    const halfFloat = renderer.extensions.has("EXT_color_buffer_float") || renderer.extensions.has("EXT_color_buffer_half_float");
    this.target = new THREE.WebGLRenderTarget(1, 1, {
      minFilter: THREE.NearestFilter,
      magFilter: THREE.NearestFilter,
      type: halfFloat ? THREE.HalfFloatType : THREE.UnsignedByteType,
      depthBuffer: true,
    });
    const palette = paletteSRGB();
    this.material = new THREE.ShaderMaterial({
      depthTest: false,
      depthWrite: false,
      uniforms: {
        tScene: { value: this.target.texture },
        uRes: { value: new THREE.Vector2(1, 1) },
        uPalette: { value: palette },
        uMode: { value: 0 },
        uSpread: { value: 0.16 },
        uTime: { value: 0 },
      },
      defines: { PALETTE_SIZE: palette.length },
      vertexShader: /* glsl */ `
        varying vec2 vUv;
        void main() {
          vUv = uv;
          gl_Position = vec4(position.xy, 0.0, 1.0);
        }
      `,
      fragmentShader: /* glsl */ `
        uniform sampler2D tScene;
        uniform vec2 uRes;
        uniform vec3 uPalette[PALETTE_SIZE];
        uniform int uMode;
        uniform float uSpread;
        varying vec2 vUv;

        // Classic 4x4 ordered dither, built from bit-interleaving.
        float bayer4(vec2 p) {
          int x = int(mod(p.x, 4.0));
          int y = int(mod(p.y, 4.0));
          int xc = x ^ y;
          int v = ((xc & 1) << 3) | ((y & 1) << 2) | (xc & 2) | ((y & 2) >> 1);
          return (float(v) + 0.5) / 16.0;
        }

        vec3 toSRGB(vec3 c) {
          c = max(c, 0.0);
          return mix(c * 12.92, 1.055 * pow(c, vec3(1.0 / 2.4)) - 0.055, step(0.0031308, c));
        }

        // "Redmean" weighted distance — cheap and kinder to greens than plain RGB.
        float colorDist(vec3 a, vec3 b) {
          vec3 d = a - b;
          float r = 0.5 * (a.r + b.r);
          return (2.0 + r) * d.r * d.r + 4.0 * d.g * d.g + (3.0 - r) * d.b * d.b;
        }

        void main() {
          vec2 pixel = floor(vUv * uRes);
          vec3 col = toSRGB(texture2D(tScene, (pixel + 0.5) / uRes).rgb);

          // Cozy grade: lift + warm the shadows, soften the whites.
          col = mix(vec3(0.11, 0.09, 0.1), vec3(1.0, 0.97, 0.9), col);
          // Dithered vignette so the edges of the frame feel like an old TV.
          vec2 q = vUv - 0.5;
          col *= 1.0 - dot(q, q) * 0.55;

          float b = bayer4(pixel) - 0.5;
          vec3 outCol = col;

          if (uMode == 0) {
            vec3 target = col + b * uSpread;
            float best = 1e9;
            for (int i = 0; i < PALETTE_SIZE; i++) {
              float d = colorDist(target, uPalette[i]);
              if (d < best) { best = d; outCol = uPalette[i]; }
            }
          } else if (uMode == 1) {
            float levels = 5.0;
            outCol = floor(col * (levels - 1.0) + b + 0.5) / (levels - 1.0);
          }

          gl_FragColor = vec4(clamp(outCol, 0.0, 1.0), 1.0);
        }
      `,
    });
    const quad = new THREE.Mesh(new THREE.PlaneGeometry(2, 2), this.material);
    quad.frustumCulled = false;
    this.scene.add(quad);
  }

  setSize(w: number, h: number) {
    this.target.setSize(w, h);
    this.material.uniforms.uRes.value.set(w, h);
  }

  setMode(mode: DitherMode) {
    this.material.uniforms.uMode.value = DITHER_MODES.indexOf(mode);
  }

  render(renderer: THREE.WebGLRenderer, scene: THREE.Scene, camera: THREE.Camera) {
    renderer.setRenderTarget(this.target);
    renderer.render(scene, camera);
    renderer.setRenderTarget(null);
    renderer.render(this.scene, this.camera);
  }
}
