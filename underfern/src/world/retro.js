// The "Retro HD" render style — the island as a late-2000s console game would
// have drawn it: a sub-HD frame (720 rows at most, fewer on phones), soft
// "quincunx" anti-aliasing, a hazy bloom bleeding round every bright edge, a
// slightly bronzed and desaturated grade with crushed blacks, film grain and a
// touch of lens fringing toward the corners. The canvas is then stretched to
// the window with ordinary bilinear filtering, the soft upscale that era's TVs
// gave every game.
//
// Unlike the other two styles this one needs a post pass:
//
//   scene ──► sceneRT (full drawing-buffer size)
//   sceneRT ──bright pass + ¼ downsample──► b1 ──blur H/V──► b1
//   b1 ──⅛ downsample──► b2 ──blur H/V──► b2
//   sceneRT + b1 + b2 ──composite (soften, fringe, bloom, grade, grain)──► canvas
//
// Every material grades and hazes *after* three's tone mapping and sRGB
// encode (world/look.js), and three only applies those when drawing to the
// screen — or to an XR target. So the scene target is flagged as one: the
// materials then run exactly the programs they run on screen, and the target
// holds the finished, display-referred frame. Its sRGB storage format decodes
// on read what it encoded on write, so the composite samples the very values
// the shaders wrote.

import * as THREE from "three";

/** Tuning (display-referred values, 0..1). */
export const RETRO = {
  // Bloom: what counts as bright (max channel), how soft the knee, how strong.
  threshold: 0.68,
  knee: 0.3,
  bloom: 0.45,
  // Quincunx soften, 0 (sharp) … 1 (full five-tap blend).
  soften: 0.7,
  // Lens fringe at the corners (uv units at r² = 0.5).
  fringe: 0.009,
  // Film grain amplitude (strongest in the mid-tones).
  grain: 0.032,
  // Grade: desaturation, S-curve contrast (kept off the deep shadows, so night
  // stays playable), black crush, bronze/teal tint.
  desat: 0.14,
  contrast: 0.3,
  crush: 0.01,
  tint: 1,
};

const VERT = /* glsl */ `
varying vec2 vUv;
void main() {
  vUv = uv;
  gl_Position = vec4(position.xy, 0.0, 1.0);
}
`;

// Bright pass + downsample: four bilinear taps one source texel off each
// diagonal average the whole 4×4 footprint of a quarter-size texel, so even a
// single-pixel firefly reaches the bloom instead of flickering in and out.
const DOWN_FRAG = /* glsl */ `
uniform sampler2D tSrc;
uniform vec2 uSrcTexel;
uniform vec3 uBright; // x threshold, y knee, z gain (threshold < 0: pass through)
varying vec2 vUv;
void main() {
  vec2 o = uSrcTexel;
  vec3 c = texture2D(tSrc, vUv + vec2(-o.x, -o.y)).rgb + texture2D(tSrc, vUv + vec2(o.x, -o.y)).rgb
         + texture2D(tSrc, vUv + vec2(-o.x, o.y)).rgb + texture2D(tSrc, vUv + vec2(o.x, o.y)).rgb;
  c *= 0.25;
  if (uBright.x >= 0.0) {
    float peak = max(c.r, max(c.g, c.b));
    c *= smoothstep(uBright.x, uBright.x + uBright.y, peak) * uBright.z;
  }
  gl_FragColor = vec4(c, 1.0);
}
`;

// Nine-tap Gaussian in five bilinear fetches.
const BLUR_FRAG = /* glsl */ `
uniform sampler2D tSrc;
uniform vec2 uStep; // texel size × direction × spread
varying vec2 vUv;
void main() {
  vec3 c = texture2D(tSrc, vUv).rgb * 0.2270270;
  c += (texture2D(tSrc, vUv + uStep * 1.3846154).rgb + texture2D(tSrc, vUv - uStep * 1.3846154).rgb) * 0.3162162;
  c += (texture2D(tSrc, vUv + uStep * 3.2307692).rgb + texture2D(tSrc, vUv - uStep * 3.2307692).rgb) * 0.0702703;
  gl_FragColor = vec4(c, 1.0);
}
`;

const COMPOSITE_FRAG = /* glsl */ `
uniform sampler2D tScene;
uniform sampler2D tBloom1;
uniform sampler2D tBloom2;
uniform vec2 uTexel;
uniform vec4 uFx;    // x bloom, y grain, z fringe, w soften
uniform vec4 uGrade; // x desaturate, y contrast, z crush, w tint
uniform float uSeed;
varying vec2 vUv;

float hash12(vec2 p) {
  vec3 p3 = fract(vec3(p.xyx) * 0.1031);
  p3 += dot(p3, p3.yzx + 33.33);
  return fract((p3.x + p3.y) * p3.z);
}

void main() {
  vec2 uv = vUv;
  // Quincunx: the pixel's own sample at half weight plus its four corners
  // (each a bilinear average of the pixels meeting there) at an eighth.
  vec3 mid = texture2D(tScene, uv).rgb;
  vec2 h = uTexel * 0.5;
  vec3 corners = texture2D(tScene, uv + vec2(-h.x, -h.y)).rgb + texture2D(tScene, uv + vec2(h.x, -h.y)).rgb
               + texture2D(tScene, uv + vec2(-h.x, h.y)).rgb + texture2D(tScene, uv + vec2(h.x, h.y)).rgb;
  vec3 c = mix(mid, mid * 0.5 + corners * 0.125, uFx.w);

  // Lens fringe: red pushed out, blue pulled in, growing toward the corners.
  vec2 d = uv - 0.5;
  vec2 f = d * dot(d, d) * uFx.z * 2.0;
  c.r += texture2D(tScene, uv + f).r - mid.r;
  c.b += texture2D(tScene, uv - f).b - mid.b;

  // Bloom, screened on so highlights glow rather than clip flat.
  vec3 b = (texture2D(tBloom1, uv).rgb * 0.55 + texture2D(tBloom2, uv).rgb * 0.75) * uFx.x;
  c = 1.0 - (1.0 - clamp(c, 0.0, 1.0)) * (1.0 - clamp(b, 0.0, 1.0));

  // Grade: a little colour drained, blacks pressed down, an S-curve, and the
  // era's tint — bronze in the highlights, a cool green-teal in the shade.
  // The curve eases in above the deep shadows, or night would go to mud.
  float l = dot(c, vec3(0.299, 0.587, 0.114));
  c = mix(vec3(l), c, 1.0 - uGrade.x);
  c = max(c - uGrade.z, 0.0) / (1.0 - uGrade.z);
  c = mix(c, c * c * (3.0 - 2.0 * c), uGrade.y * smoothstep(0.06, 0.3, l));
  float l2 = dot(c, vec3(0.299, 0.587, 0.114));
  vec3 tint = mix(vec3(0.95, 1.0, 1.0), vec3(1.04, 1.0, 0.9), smoothstep(0.15, 0.75, l2));
  c *= mix(vec3(1.0), tint, uGrade.w);

  // Film grain: triangular noise, new every frame, strongest in the mid-tones.
  vec2 p = gl_FragCoord.xy + uSeed;
  float n = hash12(p) + hash12(p * 1.37 + 17.17) - 1.0;
  c += n * uFx.y * (0.25 + 0.75 * (1.0 - abs(2.0 * l2 - 1.0)));

  gl_FragColor = vec4(c, 1.0);
}
`;

function target(w, h, options = {}) {
  const rt = new THREE.WebGLRenderTarget(w, h, {
    type: THREE.UnsignedByteType,
    minFilter: THREE.LinearFilter,
    magFilter: THREE.LinearFilter,
    depthBuffer: false,
    generateMipmaps: false,
    ...options,
  });
  rt.texture.generateMipmaps = false;
  return rt;
}

export class RetroPass {
  /** @param {THREE.WebGLRenderer} renderer */
  constructor(renderer) {
    this.renderer = renderer;
    // The finished frame (see the header for why it poses as an XR target).
    this.sceneRT = target(1, 1, { depthBuffer: true, colorSpace: THREE.SRGBColorSpace });
    this.sceneRT.isXRRenderTarget = true;
    this.b1 = target(1, 1);
    this.b1Tmp = target(1, 1);
    this.b2 = target(1, 1);
    this.b2Tmp = target(1, 1);

    this.down = new THREE.ShaderMaterial({
      name: "underfern-retro-down",
      uniforms: { tSrc: { value: null }, uSrcTexel: { value: new THREE.Vector2() }, uBright: { value: new THREE.Vector3() } },
      vertexShader: VERT,
      fragmentShader: DOWN_FRAG,
      depthTest: false,
      depthWrite: false,
      toneMapped: false,
    });
    this.blur = new THREE.ShaderMaterial({
      name: "underfern-retro-blur",
      uniforms: { tSrc: { value: null }, uStep: { value: new THREE.Vector2() } },
      vertexShader: VERT,
      fragmentShader: BLUR_FRAG,
      depthTest: false,
      depthWrite: false,
      toneMapped: false,
    });
    this.composite = new THREE.ShaderMaterial({
      name: "underfern-retro-composite",
      uniforms: {
        tScene: { value: this.sceneRT.texture },
        tBloom1: { value: this.b1.texture },
        tBloom2: { value: this.b2.texture },
        uTexel: { value: new THREE.Vector2() },
        uFx: { value: new THREE.Vector4() },
        uGrade: { value: new THREE.Vector4() },
        uSeed: { value: 0 },
      },
      vertexShader: VERT,
      fragmentShader: COMPOSITE_FRAG,
      depthTest: false,
      depthWrite: false,
      toneMapped: false,
    });

    // One full-screen triangle, drawn with whichever material the pass needs.
    const geo = new THREE.BufferGeometry();
    geo.setAttribute("position", new THREE.Float32BufferAttribute([-1, -1, 0, 3, -1, 0, -1, 3, 0], 3));
    geo.setAttribute("uv", new THREE.Float32BufferAttribute([0, 0, 2, 0, 0, 2], 2));
    this.quad = new THREE.Mesh(geo, this.composite);
    this.quad.frustumCulled = false;
    this.quadCam = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);
    this.width = 1;
    this.height = 1;
    this._frame = 0;
    /** The shared tuning (live: tweak it from the console or a test). */
    this.tuning = RETRO;
  }

  /** Match the drawing buffer (call after renderer.setSize). */
  setSize(w, h) {
    w = Math.max(1, Math.round(w));
    h = Math.max(1, Math.round(h));
    if (w === this.width && h === this.height) return;
    this.width = w;
    this.height = h;
    this.sceneRT.setSize(w, h);
    const qw = Math.max(1, Math.round(w / 4));
    const qh = Math.max(1, Math.round(h / 4));
    const ew = Math.max(1, Math.round(w / 8));
    const eh = Math.max(1, Math.round(h / 8));
    this.b1.setSize(qw, qh);
    this.b1Tmp.setSize(qw, qh);
    this.b2.setSize(ew, eh);
    this.b2Tmp.setSize(ew, eh);
  }

  _pass(material, rt) {
    this.quad.material = material;
    this.renderer.setRenderTarget(rt);
    this.renderer.render(this.quad, this.quadCam);
  }

  _downsample(src, dst, bright) {
    this.down.uniforms.tSrc.value = src.texture;
    this.down.uniforms.uSrcTexel.value.set(1 / src.width, 1 / src.height);
    this.down.uniforms.uBright.value.copy(bright);
    this._pass(this.down, dst);
  }

  _blur(rt, tmp, spread) {
    const u = this.blur.uniforms;
    u.tSrc.value = rt.texture;
    u.uStep.value.set(spread / rt.width, 0);
    this._pass(this.blur, tmp);
    u.tSrc.value = tmp.texture;
    u.uStep.value.set(0, spread / rt.height);
    this._pass(this.blur, rt);
  }

  /** Draw `scene` through the retro finish onto the canvas. */
  render(scene, camera) {
    const r = this.renderer;
    const prev = r.getRenderTarget();
    r.setRenderTarget(this.sceneRT);
    r.render(scene, camera);

    const T = this.tuning;
    this._downsample(this.sceneRT, this.b1, _bright.set(T.threshold, T.knee, 1));
    this._blur(this.b1, this.b1Tmp, 1.25);
    this._downsample(this.b1, this.b2, _bright.set(-1, 0, 1));
    this._blur(this.b2, this.b2Tmp, 1.5);

    const u = this.composite.uniforms;
    u.uTexel.value.set(1 / this.width, 1 / this.height);
    u.uFx.value.set(T.bloom, T.grain, T.fringe, T.soften);
    u.uGrade.value.set(T.desat, T.contrast, T.crush, T.tint);
    this._frame = (this._frame + 1) % 997;
    u.uSeed.value = this._frame * 7.31;
    this._pass(this.composite, prev);
  }

  /**
   * Mean colour (0..255) of a sparse grid over the finished scene target and
   * the wide bloom — a cheap health check for tests.
   */
  stats() {
    const read = (rt) => {
      const w = rt.width;
      const h = rt.height;
      const px = new Uint8Array(4);
      const sum = [0, 0, 0];
      let n = 0;
      for (let j = 1; j < 8; j++) {
        for (let i = 1; i < 8; i++) {
          this.renderer.readRenderTargetPixels(rt, Math.floor((i / 8) * w), Math.floor((j / 8) * h), 1, 1, px);
          sum[0] += px[0];
          sum[1] += px[1];
          sum[2] += px[2];
          n++;
        }
      }
      return sum.map((v) => Math.round(v / n));
    };
    return { width: this.width, height: this.height, scene: read(this.sceneRT), bloom: read(this.b2) };
  }

  dispose() {
    for (const rt of [this.sceneRT, this.b1, this.b1Tmp, this.b2, this.b2Tmp]) rt.dispose();
    for (const m of [this.down, this.blur, this.composite]) m.dispose();
    this.quad.geometry.dispose();
  }
}

const _bright = new THREE.Vector3();
