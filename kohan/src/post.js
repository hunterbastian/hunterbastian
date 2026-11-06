// The post stack, in the order from gsimone's PS2/GameCube thread:
// 1 low resolution, 2 bloom (Kawase), 3 depth of field, 4 sun shafts,
// 5 colour depth + dither, 6 deflicker, 7 composite cable + CRT.

import { createProgram, createTarget, createFullscreen } from "./gl.js";
import * as S from "./shaders.js";

// 16 colours sampled from the reference painting.
export const PAINTING_PALETTE = [
  "#070e1d", "#1c1d27", "#3a3d4f", "#5a5c72",
  "#4e3431", "#7a4a2e", "#a5602c", "#c89a62",
  "#3c3d6e", "#4c57b0", "#6080d0", "#8aa2ec",
  "#9eadb7", "#b6c3d6", "#cedbf7", "#ffffff",
];

const DEPTH_MODES = { off: 0, ps2: 1, gc: 2, rgb444: 3, palette: 4, banding: 5 };

export class PostStack {
  constructor(gl) {
    this.gl = gl;
    this.fs = createFullscreen(gl);
    const P = (fs, name) => createProgram(gl, S.POST_VS, fs, name);
    this.p = {
      down: P(S.KAWASE_DOWN_FS, "kawase-down"),
      up: P(S.KAWASE_UP_FS, "kawase-up"),
      raysMask: P(S.RAYS_MASK_FS, "rays-mask"),
      raysBlur: P(S.RAYS_BLUR_FS, "rays-blur"),
      compose: P(S.COMPOSE_FS, "compose"),
      deflicker: P(S.DEFLICKER_FS, "deflicker"),
      composite: P(S.COMPOSITE_FS, "composite"),
      output: P(S.OUTPUT_FS, "output"),
    };
    const L = gl.LINEAR, N = gl.NEAREST;
    this.scene = createTarget(gl, 4, 4, { depth: "texture", filter: L });
    this.refl = createTarget(gl, 4, 4, { depth: "buffer", filter: L });
    this.bloomDown = [0, 1, 2, 3].map(() => createTarget(gl, 2, 2, { filter: L }));
    this.bloomUp = [0, 1, 2].map(() => createTarget(gl, 2, 2, { filter: L }));
    this.blurDown = [0, 1].map(() => createTarget(gl, 2, 2, { filter: L }));
    this.blurUp = createTarget(gl, 2, 2, { filter: L });
    this.raysA = createTarget(gl, 2, 2, { filter: L });
    this.raysB = createTarget(gl, 2, 2, { filter: L });
    this.comp = createTarget(gl, 2, 2, { filter: N });
    this.defl = createTarget(gl, 2, 2, { filter: N });
    this.signal = createTarget(gl, 2, 2, { filter: L });
    this.pal = new Float32Array(PAINTING_PALETTE.flatMap((h) => [1, 3, 5].map((i) => parseInt(h.slice(i, i + 2), 16) / 255)));
    this.W = 0;
    this.H = 0;
  }

  resize(W, H) {
    if (W === this.W && H === this.H) return;
    this.W = W;
    this.H = H;
    this.scene.resize(W, H);
    this.refl.resize(W, H);
    let w = W, h = H;
    for (let i = 0; i < 4; i++) {
      w = Math.max(1, Math.ceil(w / 2));
      h = Math.max(1, Math.ceil(h / 2));
      this.bloomDown[i].resize(w, h);
      if (i < 3) this.bloomUp[i].resize(w, h);
      if (i < 2) this.blurDown[i].resize(w, h);
    }
    this.blurUp.resize(this.blurDown[0].w, this.blurDown[0].h);
    this.raysA.resize(Math.ceil(W / 2), Math.ceil(H / 2));
    this.raysB.resize(Math.ceil(W / 2), Math.ceil(H / 2));
    this.comp.resize(W, H);
    this.defl.resize(W, H);
    this.signal.resize(W * 2, H);
  }

  pass(prog, target, setup) {
    const gl = this.gl;
    if (target) target.bind();
    prog.use();
    setup(prog);
    this.fs.draw();
    return target;
  }

  kawaseChain(src, downs, ups, prefilter, threshold) {
    let cur = src;
    downs.forEach((t, i) => {
      this.pass(this.p.down, t, (p) =>
        p.tex("u_src", cur.tex).f2("u_texel", 1 / cur.w, 1 / cur.h).f1("u_prefilter", i === 0 && prefilter ? 1 : 0).f1("u_threshold", threshold)
      );
      cur = t;
    });
    for (const t of ups) {
      this.pass(this.p.up, t, (p) => p.tex("u_src", cur.tex).f2("u_texel", 0.5 / cur.w, 0.5 / cur.h));
      cur = t;
    }
    return cur;
  }

  run(s, frame) {
    const gl = this.gl;
    gl.disable(gl.DEPTH_TEST);
    gl.disable(gl.BLEND);
    gl.depthMask(false);

    let bloom = null, blur = null, rays = null;
    if (s.bloom) {
      const ups = [this.bloomUp[2], this.bloomUp[1], this.bloomUp[0]];
      bloom = this.kawaseChain(this.scene, this.bloomDown, ups, true, 0.9);
    }
    if (s.dof) blur = this.kawaseChain(this.scene, this.blurDown, [this.blurUp], false, 0);
    const sunOn = s.rays && frame.sunVisible > 0.01;
    if (sunOn) {
      this.pass(this.p.raysMask, this.raysA, (p) =>
        p.tex("u_color", this.scene.tex).tex("u_depth", this.scene.depthTex).f2("u_sun", frame.sunUV[0], frame.sunUV[1]).f1("u_aspect", this.W / this.H)
      );
      this.pass(this.p.raysBlur, this.raysB, (p) => p.tex("u_mask", this.raysA.tex).f2("u_sun", frame.sunUV[0], frame.sunUV[1]));
      rays = this.raysB;
    }

    this.pass(this.p.compose, this.comp, (p) => {
      p.tex("u_scene", this.scene.tex)
        .tex("u_depth", this.scene.depthTex)
        .tex("u_bloom", (bloom || this.scene).tex)
        .tex("u_blur", (blur || this.scene).tex)
        .tex("u_rays", (rays || this.raysB).tex)
        .f1("u_bloomAmt", bloom ? 0.3 : 0)
        .f1("u_dofAmt", blur ? 0.78 : 0)
        .f1("u_raysAmt", rays ? 0.4 * frame.sunVisible : 0)
        .f3("u_raysCol", 1.0, 0.94, 0.82)
        .f2("u_nearFar", frame.near, frame.far)
        .f2("u_dof", 45, 420)
        .i1("u_depthMode", s.depth ? DEPTH_MODES[s.depthMode] : 0)
        .f1("u_grain", s.grain ? (s.depthMode === "palette" ? 0.05 : 0.022) : 0)
        .f1("u_frame", frame.grainTick)
        .v3a("u_pal", this.pal);
    });

    let src = this.comp;
    if (s.deflicker) {
      this.pass(this.p.deflicker, this.defl, (p) => p.tex("u_src", this.comp.tex));
      src = this.defl;
    }
    if (s.crt) {
      this.pass(this.p.composite, this.signal, (p) => p.tex("u_src", src.tex).f1("u_artifact", 0.32));
      src = this.signal;
    }

    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    gl.viewport(0, 0, frame.outW, frame.outH);
    this.pass(this.p.output, null, (p) =>
      p.tex("u_src", src.tex).f2("u_srcSize", src.w, src.h).f1("u_crt", s.crt ? 1 : 0).f1("u_mask", frame.dpr >= 1.5 ? 0.28 : 0.18)
    );
  }
}
