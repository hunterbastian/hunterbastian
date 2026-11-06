// The "Retro SD" render style — the island as a GameCube or PS2 game would
// have looked on a CRT over a composite cable. It follows gsimone's breakdown
// of that look as a stack of post passes:
//
//   1. A standard-definition frame (about 448 lines), shown at a whole number
//      of screen pixels per line so the scanlines stay even.
//   2. Bloom: the bright parts shrunk to a quarter and Kawase-blurred.
//   3. Depth of field: a blurred copy blended in more with distance.
//   4. Sun shafts: the bright sky smeared out radially from the sun.
//   5. Colour depth: 5 bits per channel (the PS2's 16-bit frame buffers;
//      the GameCube's RGBA6 was 6) with a 4×4 ordered dither, so gradients
//      show the dither — and a little banding, on purpose.
//   6. Deflicker: every line blended with the lines above and below it, the
//      GameCube's copy filter — a big part of why its games look so soft.
//   7. Composite cable and CRT: colour bleeding sideways; scanlines whose
//      beam swells with brightness (bright lines all but close the gaps, as
//      on a tube); and, given enough screen pixels per line, a faint
//      aperture-grille phosphor mask.
//
//   scene ──► sceneRT (+ depth) at source size
//   sceneRT ──bright pass, ¼ (alpha: sky)──► bloomA ─┬─radial, toward the sun──► shafts (¼)
//                                                    └─Kawase ×4──► bloom
//   sceneRT ──¼──► soft ──Kawase ×3──► soft (depth of field)
//   all of it ──composite (DOF, bloom, shafts, grade, 5-bit dither)──► frameRT (source size)
//   frameRT ──output (deflicker, composite bleed, scanlines)──► canvas (k × source)
//
// The scene target poses as an XR target for the reason given in retro.js.

import * as THREE from "three";
import { target, fullScreenQuad, postMaterial } from "./retro.js";
import { LOOK } from "./look.js";

/** Tuning (display-referred values, 0..1). */
export const RETRO_SD = {
  // Bloom: bright pass (max channel), knee and strength. Kept off the plain
  // daylight sky, or it stacks with the island's own haze into fog.
  threshold: 0.76,
  knee: 0.22,
  bloom: 0.36,
  // Depth of field: blur starts (m), is full (m), and how much of it.
  dofStart: 110,
  dofEnd: 600,
  dof: 0.55,
  // Sun shafts strength, and how far round the sun they reach (uv).
  shafts: 0.42,
  shaftReach: 0.4,
  // Saturation (1 = unchanged): that era's screens ran a little hot.
  saturation: 1.12,
  // Levels per channel − 1 (31 = 5 bits, the PS2's 16-bit frame buffers): the
  // dither shows on smooth gradients, a little banding on purpose.
  levels: 31,
  // Deflicker (0 off … 1 the full ¼ ½ ¼ filter), chroma bleed, scanline depth,
  // and the phosphor mask (only drawn at 3+ screen pixels per line).
  deflicker: 1,
  bleed: 1,
  scanlines: 0.36,
  mask: 0.1,
};

const CLIP_GLSL = /* glsl */ `
uniform vec2 uClip; // camera near, far
float viewZ(float d) {
  float z = d * 2.0 - 1.0;
  return 2.0 * uClip.x * uClip.y / (uClip.y + uClip.x - z * (uClip.y - uClip.x));
}
`;

// Downsample to a quarter (four bilinear taps cover the 4×4 footprint), with an
// optional bright pass; alpha carries how much of the footprint is open sky.
const DOWN_FRAG = /* glsl */ `
uniform sampler2D tSrc;
uniform sampler2D tDepth;
uniform vec2 uSrcTexel;
uniform vec3 uBright; // x threshold, y knee, z gain (threshold < 0: pass through)
varying vec2 vUv;
${CLIP_GLSL}
void main() {
  vec2 o = uSrcTexel;
  vec2 a = vUv + vec2(-o.x, -o.y);
  vec2 b = vUv + vec2(o.x, -o.y);
  vec2 c2 = vUv + vec2(-o.x, o.y);
  vec2 d = vUv + vec2(o.x, o.y);
  vec3 c = (texture2D(tSrc, a).rgb + texture2D(tSrc, b).rgb + texture2D(tSrc, c2).rgb + texture2D(tSrc, d).rgb) * 0.25;
  float sky = 0.25 * (step(1800.0, viewZ(texture2D(tDepth, a).x)) + step(1800.0, viewZ(texture2D(tDepth, b).x))
                    + step(1800.0, viewZ(texture2D(tDepth, c2).x)) + step(1800.0, viewZ(texture2D(tDepth, d).x)));
  if (uBright.x >= 0.0) {
    float peak = max(c.r, max(c.g, c.b));
    c *= smoothstep(uBright.x, uBright.x + uBright.y, peak) * uBright.z;
  }
  gl_FragColor = vec4(c, sky);
}
`;

// One Kawase blur iteration: four taps on the diagonals, (i + ½) texels out.
const KAWASE_FRAG = /* glsl */ `
uniform sampler2D tSrc;
uniform vec2 uTexel;
uniform float uIter;
varying vec2 vUv;
void main() {
  vec2 o = uTexel * (uIter + 0.5);
  vec4 c = texture2D(tSrc, vUv + vec2(-o.x, o.y)) + texture2D(tSrc, vUv + vec2(o.x, o.y))
         + texture2D(tSrc, vUv + vec2(o.x, -o.y)) + texture2D(tSrc, vUv + vec2(-o.x, -o.y));
  gl_FragColor = c * 0.25;
}
`;

// Sun shafts: march from each texel toward the sun, gathering bright open sky
// (trees and ridges in the way leave dark gaps — the shafts between them).
const SHAFT_FRAG = /* glsl */ `
uniform sampler2D tSrc;
uniform vec2 uSun;    // the sun, in uv
uniform float uShaft; // strength × how visible the sun is
uniform float uReach; // how far round the sun the shafts gather (uv)
varying vec2 vUv;
void main() {
  vec2 stride = (vUv - uSun) * (0.9 / 28.0);
  vec2 uv = vUv;
  vec3 acc = vec3(0.0);
  float w = 1.0;
  for (int i = 0; i < 28; i++) {
    uv -= stride;
    vec4 s = texture2D(tSrc, uv);
    float nearSun = 1.0 - smoothstep(0.0, uReach, distance(uv, uSun));
    acc += s.rgb * s.a * nearSun * w;
    w *= 0.95;
  }
  gl_FragColor = vec4(acc * uShaft * (1.0 / 9.0), 1.0);
}
`;

const COMPOSITE_FRAG = /* glsl */ `
uniform sampler2D tScene;
uniform sampler2D tDepth;
uniform sampler2D tBloom;
uniform sampler2D tSoft;
uniform sampler2D tShafts;
uniform vec3 uDof;  // x start (m), y full (m), z amount
uniform vec4 uFx;   // x bloom, y shafts, z saturation, w levels
varying vec2 vUv;
${CLIP_GLSL}

float bayer2(vec2 a) {
  a = floor(a);
  return fract(dot(a, vec2(0.5, a.y * 0.75)));
}
float bayer4(vec2 a) {
  return bayer2(0.5 * a) * 0.25 + bayer2(a);
}

void main() {
  vec3 c = texture2D(tScene, vUv).rgb;
  // Depth of field: the far distance goes soft.
  float z = viewZ(texture2D(tDepth, vUv).x);
  c = mix(c, texture2D(tSoft, vUv).rgb, smoothstep(uDof.x, uDof.y, z) * uDof.z);
  // Bloom, screened on; shafts, added.
  vec3 b = clamp(texture2D(tBloom, vUv).rgb * uFx.x, 0.0, 1.0);
  c = 1.0 - (1.0 - clamp(c, 0.0, 1.0)) * (1.0 - b);
  c += texture2D(tShafts, vUv).rgb * uFx.y;
  // A little more colour.
  float l = dot(c, vec3(0.299, 0.587, 0.114));
  c = mix(vec3(l), c, uFx.z);
  // Fewer colours (5 bits a channel) with a 4×4 ordered dither.
  c = floor(clamp(c, 0.0, 1.0) * uFx.w + bayer4(gl_FragCoord.xy)) / uFx.w;
  gl_FragColor = vec4(c, 1.0);
}
`;

// The cable and the tube. Reads the finished SD frame pixel by pixel.
const OUTPUT_FRAG = /* glsl */ `
uniform sampler2D tFrame;
uniform vec2 uSrc;  // source size (px)
uniform vec4 uCrt;  // x deflicker, y chroma bleed, z scanline depth, w phosphor mask
varying vec2 vUv;

const mat3 TO_YIQ = mat3(0.299, 0.596, 0.211, 0.587, -0.274, -0.523, 0.114, -0.322, 0.312);
const mat3 TO_RGB = mat3(1.0, 1.0, 1.0, 0.956, -0.272, -1.106, 0.621, -0.647, 1.703);

vec3 px(vec2 p) {
  return texture2D(tFrame, (p + 0.5) / uSrc).rgb;
}

void main() {
  vec2 sp = vUv * uSrc;
  vec2 p = floor(sp);
  float fy = fract(sp.y);
  // Deflicker: this line blended with the ones above and below (¼ ½ ¼).
  vec3 c0 = px(p);
  vec3 c = mix(c0, (px(p + vec2(0.0, 1.0)) + 2.0 * c0 + px(p - vec2(0.0, 1.0))) * 0.25, uCrt.x);
  // Composite: colour (I, Q) carried on a narrow band, so it smears sideways;
  // brightness (Y) only softens a touch.
  vec3 yiq = TO_YIQ * c;
  vec3 r1 = TO_YIQ * px(p + vec2(1.0, 0.0));
  vec3 l1 = TO_YIQ * px(p - vec2(1.0, 0.0));
  vec3 r2 = TO_YIQ * px(p + vec2(2.0, 0.0));
  vec3 l2 = TO_YIQ * px(p - vec2(2.0, 0.0));
  vec2 iq = yiq.yz * 0.32 + (r1.yz + l1.yz) * 0.22 + (r2.yz + l2.yz) * 0.12;
  yiq.yz = mix(yiq.yz, iq, uCrt.y);
  yiq.x = mix(yiq.x, (r1.x + l1.x) * 0.5, 0.18 * uCrt.y);
  c = TO_RGB * yiq;
  // Scanlines: each line's beam fades toward its edge, and swells with
  // brightness, so bright lines all but close the gap (brightness made up).
  float lum = clamp(yiq.x, 0.0, 1.0);
  c *= (1.0 - uCrt.z * smoothstep(0.45, 0.95, fy) * (1.0 - 0.6 * lum)) * (1.0 + uCrt.z * 0.3);
  // Aperture grille: a faint red-green-blue stripe per screen column.
  float col = mod(floor(gl_FragCoord.x), 3.0);
  vec3 grille = vec3(col < 0.5 ? 1.0 : 0.0, col > 0.5 && col < 1.5 ? 1.0 : 0.0, col > 1.5 ? 1.0 : 0.0);
  c *= mix(vec3(1.0), 0.8 + 0.6 * grille, uCrt.w);
  gl_FragColor = vec4(c, 1.0);
}
`;

export class RetroSDPass {
  /** @param {THREE.WebGLRenderer} renderer */
  constructor(renderer) {
    this.renderer = renderer;
    this.sceneRT = target(1, 1, { depthBuffer: true, colorSpace: THREE.SRGBColorSpace, depthTexture: new THREE.DepthTexture(1, 1) });
    this.sceneRT.isXRRenderTarget = true;
    this.bloomA = target(1, 1);
    this.bloomB = target(1, 1);
    this.softA = target(1, 1);
    this.softB = target(1, 1);
    this.shaftRT = target(1, 1);
    this.frameRT = target(1, 1, { minFilter: THREE.NearestFilter, magFilter: THREE.NearestFilter });

    const clip = { value: new THREE.Vector2(0.1, 2000) };
    this._clip = clip;
    this.down = postMaterial(
      "underfern-sd-down",
      { tSrc: { value: this.sceneRT.texture }, tDepth: { value: this.sceneRT.depthTexture }, uSrcTexel: { value: new THREE.Vector2() }, uBright: { value: new THREE.Vector3() }, uClip: clip },
      DOWN_FRAG,
    );
    // The blurs run at half precision; the passes that read depth or address
    // single pixels (down, composite, output) keep full precision.
    this.kawase = postMaterial("underfern-sd-kawase", { tSrc: { value: null }, uTexel: { value: new THREE.Vector2() }, uIter: { value: 0 } }, KAWASE_FRAG, "mediump");
    this.shaft = postMaterial("underfern-sd-shafts", { tSrc: { value: this.bloomA.texture }, uSun: { value: new THREE.Vector2(0.5, 0.5) }, uShaft: { value: 0 }, uReach: { value: 0.4 } }, SHAFT_FRAG, "mediump");
    this.composite = postMaterial(
      "underfern-sd-composite",
      {
        tScene: { value: this.sceneRT.texture },
        tDepth: { value: this.sceneRT.depthTexture },
        tBloom: { value: this.bloomA.texture },
        tSoft: { value: this.softB.texture },
        tShafts: { value: this.shaftRT.texture },
        uClip: clip,
        uDof: { value: new THREE.Vector3() },
        uFx: { value: new THREE.Vector4() },
      },
      COMPOSITE_FRAG,
    );
    this.output = postMaterial(
      "underfern-sd-output",
      { tFrame: { value: this.frameRT.texture }, uSrc: { value: new THREE.Vector2(1, 1) }, uCrt: { value: new THREE.Vector4() } },
      OUTPUT_FRAG,
    );
    this.quad = fullScreenQuad(this.composite);
    this.quadCam = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);
    /** Source frame size (px) and screen pixels per source pixel. */
    this.width = 1;
    this.height = 1;
    this.scale = 1;
    /** The shared tuning (live: tweak it from the console or a test). */
    this.tuning = RETRO_SD;
    this.sunVisible = 0;
  }

  /**
   * @param {number} w source width (px)
   * @param {number} h source height (px) — the "lines"
   * @param {number} k whole screen pixels per source pixel (the canvas is k× the source)
   */
  setSize(w, h, k) {
    w = Math.max(1, Math.round(w));
    h = Math.max(1, Math.round(h));
    this.scale = Math.max(1, Math.round(k));
    if (w === this.width && h === this.height) return;
    this.width = w;
    this.height = h;
    // A fresh depth texture at the new size (the old one is sized once, at first use).
    this.sceneRT.depthTexture.dispose();
    this.sceneRT.depthTexture = new THREE.DepthTexture(w, h);
    this.down.uniforms.tDepth.value = this.sceneRT.depthTexture;
    this.composite.uniforms.tDepth.value = this.sceneRT.depthTexture;
    this.sceneRT.setSize(w, h);
    this.frameRT.setSize(w, h);
    const qw = Math.max(1, Math.round(w / 4));
    const qh = Math.max(1, Math.round(h / 4));
    for (const rt of [this.bloomA, this.bloomB, this.softA, this.softB, this.shaftRT]) rt.setSize(qw, qh);
    this.output.uniforms.uSrc.value.set(w, h);
  }

  _pass(material, rt) {
    this.quad.material = material;
    this.renderer.setRenderTarget(rt);
    this.renderer.render(this.quad, this.quadCam);
  }

  /** Kawase-blur `a` for `iters` iterations, ping-ponging with `b`; returns the target holding the result. */
  _kawase(a, b, iters) {
    const u = this.kawase.uniforms;
    u.uTexel.value.set(1 / a.width, 1 / a.height);
    let src = a;
    let dst = b;
    for (const i of iters) {
      u.tSrc.value = src.texture;
      u.uIter.value = i;
      this._pass(this.kawase, dst);
      [src, dst] = [dst, src];
    }
    return src;
  }

  /** Where the sun sits on screen, and how much of it shows (0..1). */
  _sun(camera) {
    const s = LOOK.uLookSun.value;
    _dir.set(s.x, s.y, s.z).normalize();
    camera.getWorldDirection(_fwd);
    _p.copy(camera.position).addScaledVector(_dir, 1000).project(camera);
    const facing = _fwd.dot(_dir);
    const onScreen = 1 - THREE.MathUtils.smoothstep(Math.max(Math.abs(_p.x), Math.abs(_p.y)), 1.0, 1.6);
    const up = THREE.MathUtils.smoothstep(_dir.y, -0.04, 0.08);
    this.sunVisible = facing > 0 ? THREE.MathUtils.smoothstep(facing, 0.15, 0.5) * onScreen * up : 0;
    this.shaft.uniforms.uSun.value.set(_p.x * 0.5 + 0.5, _p.y * 0.5 + 0.5);
  }

  /** Draw `scene` through the SD finish onto the canvas. */
  render(scene, camera) {
    const r = this.renderer;
    const prev = r.getRenderTarget();
    const T = this.tuning;
    this._clip.value.set(camera.near, camera.far);
    r.setRenderTarget(this.sceneRT);
    r.render(scene, camera);

    // Bright pass (alpha: sky) → shafts from it, then the bloom blur.
    const d = this.down.uniforms;
    d.uSrcTexel.value.set(1 / this.width, 1 / this.height);
    d.uBright.value.set(T.threshold, T.knee, 1);
    this._pass(this.down, this.bloomA);
    this._sun(camera);
    this.shaft.uniforms.uShaft.value = T.shafts * this.sunVisible;
    this.shaft.uniforms.uReach.value = T.shaftReach;
    this._pass(this.shaft, this.shaftRT);
    const bloom = this._kawase(this.bloomA, this.bloomB, [0, 1, 2, 3]);
    // A plain quarter copy, blurred, for the depth of field.
    d.uBright.value.set(-1, 0, 1);
    this._pass(this.down, this.softA);
    const soft = this._kawase(this.softA, this.softB, [0, 1, 2]);

    const u = this.composite.uniforms;
    u.tBloom.value = bloom.texture;
    u.tSoft.value = soft.texture;
    u.uDof.value.set(T.dofStart, T.dofEnd, T.dof);
    u.uFx.value.set(T.bloom, T.shafts > 0 ? 1 : 0, T.saturation, T.levels);
    this._pass(this.composite, this.frameRT);

    // Scanlines need at least two screen rows per line; the mask, three.
    this.output.uniforms.uCrt.value.set(T.deflicker, T.bleed, this.scale >= 2 ? T.scanlines : 0, this.scale >= 3 ? T.mask : 0);
    this._pass(this.output, prev);
  }

  /** Mean colours (0..255) of a sparse grid over the scene, the bloom and the finished SD frame — for tests. */
  stats() {
    const read = (rt) => {
      const px = new Uint8Array(4);
      const sum = [0, 0, 0];
      let n = 0;
      for (let j = 1; j < 8; j++) {
        for (let i = 1; i < 8; i++) {
          this.renderer.readRenderTargetPixels(rt, Math.floor((i / 8) * rt.width), Math.floor((j / 8) * rt.height), 1, 1, px);
          sum[0] += px[0];
          sum[1] += px[1];
          sum[2] += px[2];
          n++;
        }
      }
      return sum.map((v) => Math.round(v / n));
    };
    return {
      width: this.width,
      height: this.height,
      scale: this.scale,
      scene: read(this.sceneRT),
      bloom: read(this.bloomA),
      frame: read(this.frameRT),
      sun: Math.round(this.sunVisible * 100) / 100,
    };
  }

  dispose() {
    for (const rt of [this.sceneRT, this.bloomA, this.bloomB, this.softA, this.softB, this.shaftRT, this.frameRT]) rt.dispose();
    this.sceneRT.depthTexture?.dispose();
    for (const m of [this.down, this.kawase, this.shaft, this.composite, this.output]) m.dispose();
    this.quad.geometry.dispose();
  }
}

const _dir = new THREE.Vector3();
const _fwd = new THREE.Vector3();
const _p = new THREE.Vector3();
