// The "Storybook" render style — the island as a painted picture book, in the
// spirit of the soft open country of Breath of the Wild (its own look, not a
// copy of that game's).
//
// Most of it lives in the materials (world/look.js, uLookStory): a lush
// palette, a painted blue middle distance and light in three soft bands —
// free, so phones get them too. This pass adds what needs the finished frame:
//
//   scene ──► sceneRT (colour + depth, ≤ 1080 rows; see main.js resize)
//   sceneRT ──composite──► canvas
//     · brushwork (High only): a Kuwahara filter — each pixel takes the mean
//       of the calmest of four neighbourhoods, so texture noise flattens into
//       small patches of colour;
//     · soft ink (not on Low): a thin, cool, dark line where the depth jumps,
//       fading out with distance so far hills stay soft;
//     · the sky, as the colour grade has it (look.js STORY_GRADES).
//
// Like the retro passes, the scene target poses as an XR target so the
// materials tone-map, grade and haze exactly as they do on screen.

import * as THREE from "three";
import { VERT, target, fullScreenQuad } from "./retro.js";
import { LOOK } from "./look.js";

/** Tuning (display-referred). */
export const STORY = {
  // Ink: how dark the line is (0 off … 1), and the colour it darkens toward.
  // A touch lighter than the look study's (a line leaves ~58% of the colour,
  // where the study left ~47%).
  ink: 0.72,
  inkColor: [0.42, 0.46, 0.56],
  // Relative depth jump that starts / completes a line, and the distance (m) it fades out over.
  inkEdge: [0.04, 0.12],
  inkFade: [180, 650],
  // Brushwork mix (High only).
  brush: 0.8,
  // Sky: how much of the grade's sky treatment to apply.
  sky: 1,
};

const COMPOSITE_FRAG = /* glsl */ `
uniform sampler2D tScene;
uniform sampler2D tDepth;
uniform vec2 uTexel;
uniform vec2 uNearFar;
uniform vec4 uInk;      // x strength, y edge start, z edge full, w unused
uniform vec3 uInkColor;
uniform vec2 uInkFade;  // metres
uniform vec2 uFx;       // x brush mix, y sky
uniform vec4 uLookSGSky;     // the grade's sky: x desaturation, yzw added
uniform vec3 uLookSGSkyTint;
varying vec2 vUv;

float depthAt(vec2 uv) {
  float z = texture2D(tDepth, uv).x * 2.0 - 1.0;
  return 2.0 * uNearFar.x * uNearFar.y / (uNearFar.y + uNearFar.x - z * (uNearFar.y - uNearFar.x));
}

#if BRUSH == 1
// Kuwahara over four (R+1)² quadrants: the mean of the one with least variance.
#define KR 3
vec3 brush(vec2 uv) {
  vec3 m0 = vec3(0.0), m1 = vec3(0.0), m2 = vec3(0.0), m3 = vec3(0.0);
  vec3 s0 = vec3(0.0), s1 = vec3(0.0), s2 = vec3(0.0), s3 = vec3(0.0);
  for (int j = 0; j <= KR; j++) {
    for (int i = 0; i <= KR; i++) {
      vec2 o = vec2(float(i), float(j)) * uTexel;
      vec3 a = texture2D(tScene, uv - o).rgb;
      vec3 b = texture2D(tScene, uv + vec2(o.x, -o.y)).rgb;
      vec3 c = texture2D(tScene, uv + vec2(-o.x, o.y)).rgb;
      vec3 d = texture2D(tScene, uv + o).rgb;
      m0 += a; s0 += a * a;
      m1 += b; s1 += b * b;
      m2 += c; s2 += c * c;
      m3 += d; s3 += d * d;
    }
  }
  float n = float((KR + 1) * (KR + 1));
  m0 /= n; m1 /= n; m2 /= n; m3 /= n;
  float v0 = dot(abs(s0 / n - m0 * m0), vec3(1.0));
  float v1 = dot(abs(s1 / n - m1 * m1), vec3(1.0));
  float v2 = dot(abs(s2 / n - m2 * m2), vec3(1.0));
  float v3 = dot(abs(s3 / n - m3 * m3), vec3(1.0));
  vec3 r = m0;
  float v = v0;
  if (v1 < v) { v = v1; r = m1; }
  if (v2 < v) { v = v2; r = m2; }
  if (v3 < v) { r = m3; }
  return r;
}
#endif

void main() {
  float raw = texture2D(tDepth, vUv).x;
  float sky = step(0.99999, raw);
  vec3 c = texture2D(tScene, vUv).rgb;
#if BRUSH == 1
  c = mix(c, brush(vUv), uFx.x * (1.0 - 0.6 * sky));
#endif
#if INK == 1
  if (sky < 0.5) {
    float d = depthAt(vUv);
    float e = abs(depthAt(vUv + vec2(uTexel.x, 0.0)) - d);
    e = max(e, abs(depthAt(vUv - vec2(uTexel.x, 0.0)) - d));
    e = max(e, abs(depthAt(vUv + vec2(0.0, uTexel.y)) - d));
    e = max(e, abs(depthAt(vUv - vec2(0.0, uTexel.y)) - d));
    float edge = smoothstep(uInk.y, uInk.z, e / max(d, 1.0)) * (1.0 - smoothstep(uInkFade.x, uInkFade.y, d));
    c = mix(c, c * uInkColor, edge * uInk.x);
  }
#endif
  // The sky, as the grade has it (paler and warmer, or cleaner and bluer).
  float sl = dot(c, vec3(0.2126, 0.7152, 0.0722));
  c = mix(c, mix(c, vec3(sl), uLookSGSky.x) * uLookSGSkyTint + uLookSGSky.yzw, sky * uFx.y);
  gl_FragColor = vec4(clamp(c, 0.0, 1.0), 1.0);
}
`;

export class StorybookPass {
  /** @param {THREE.WebGLRenderer} renderer */
  constructor(renderer) {
    this.renderer = renderer;
    this.sceneRT = target(1, 1, { depthBuffer: true, colorSpace: THREE.SRGBColorSpace, depthTexture: new THREE.DepthTexture(1, 1) });
    this.sceneRT.isXRRenderTarget = true;
    this.composite = new THREE.ShaderMaterial({
      name: "underfern-storybook",
      defines: { BRUSH: 0, INK: 1 },
      uniforms: {
        tScene: { value: this.sceneRT.texture },
        tDepth: { value: this.sceneRT.depthTexture },
        uTexel: { value: new THREE.Vector2() },
        uNearFar: { value: new THREE.Vector2(0.1, 2000) },
        uInk: { value: new THREE.Vector4() },
        uInkColor: { value: new THREE.Vector3() },
        uInkFade: { value: new THREE.Vector2() },
        uFx: { value: new THREE.Vector2() },
        // The grade's sky, shared with the materials' grade (look.js).
        uLookSGSky: LOOK.uLookSGSky,
        uLookSGSkyTint: LOOK.uLookSGSkyTint,
      },
      vertexShader: VERT,
      fragmentShader: COMPOSITE_FRAG,
      depthTest: false,
      depthWrite: false,
      toneMapped: false,
    });
    this.quad = fullScreenQuad(this.composite);
    this.quadCam = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);
    this.width = 1;
    this.height = 1;
    /** The shared tuning (live: tweak it from the console or a test). */
    this.tuning = STORY;
    /** What this quality runs: brushwork on High only, ink everywhere but Low. */
    this.brush = false;
    this.ink = true;
  }

  /** "high" | "low": brushwork on High only, ink off on Low. */
  setQuality(name) {
    const brush = name === "high";
    const ink = name !== "low";
    if (brush === this.brush && ink === this.ink) return;
    this.brush = brush;
    this.ink = ink;
    this.composite.defines.BRUSH = brush ? 1 : 0;
    this.composite.defines.INK = ink ? 1 : 0;
    this.composite.needsUpdate = true;
  }

  /** Match the drawing buffer (call after renderer.setSize). */
  setSize(w, h) {
    w = Math.max(1, Math.round(w));
    h = Math.max(1, Math.round(h));
    if (w === this.width && h === this.height) return;
    this.width = w;
    this.height = h;
    this.sceneRT.setSize(w, h);
  }

  /** Draw `scene` through the storybook finish onto the canvas. */
  render(scene, camera) {
    const r = this.renderer;
    const prev = r.getRenderTarget();
    r.setRenderTarget(this.sceneRT);
    r.render(scene, camera);
    const T = this.tuning;
    const u = this.composite.uniforms;
    u.uTexel.value.set(1 / this.width, 1 / this.height);
    u.uNearFar.value.set(camera.near, camera.far);
    u.uInk.value.set(T.ink, T.inkEdge[0], T.inkEdge[1], 0);
    u.uInkColor.value.set(T.inkColor[0], T.inkColor[1], T.inkColor[2]);
    u.uInkFade.value.set(T.inkFade[0], T.inkFade[1]);
    u.uFx.value.set(T.brush, T.sky);
    r.setRenderTarget(prev);
    r.render(this.quad, this.quadCam);
  }

  /** Mean colour (0..255) of a sparse grid over the finished scene target (tests). */
  stats() {
    const rt = this.sceneRT;
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
    return { width: this.width, height: this.height, scene: sum.map((v) => Math.round(v / n)), brush: this.brush, ink: this.ink };
  }

  dispose() {
    this.sceneRT.depthTexture?.dispose();
    this.sceneRT.dispose();
    this.composite.dispose();
    this.quad.geometry.dispose();
  }
}
