// Thin WebGL2 helpers: programs, meshes, render targets, and a full-screen pass.

export const ATTR = { pos: 0, nrm: 1, col: 2, ext: 3 };

export function createProgram(gl, vsSrc, fsSrc, name) {
  const compile = (type, src) => {
    const sh = gl.createShader(type);
    gl.shaderSource(sh, src);
    gl.compileShader(sh);
    if (!gl.getShaderParameter(sh, gl.COMPILE_STATUS)) {
      const log = gl.getShaderInfoLog(sh);
      const lines = src.split("\n").map((l, i) => `${String(i + 1).padStart(4)}| ${l}`).join("\n");
      console.error(`[${name}] shader compile failed:\n${log}\n${lines}`);
      throw new Error(`Shader "${name}" failed to compile: ${log}`);
    }
    return sh;
  };
  const prog = gl.createProgram();
  gl.attachShader(prog, compile(gl.VERTEX_SHADER, vsSrc));
  gl.attachShader(prog, compile(gl.FRAGMENT_SHADER, fsSrc));
  for (const [k, loc] of Object.entries(ATTR)) gl.bindAttribLocation(prog, loc, "a_" + k);
  gl.linkProgram(prog);
  if (!gl.getProgramParameter(prog, gl.LINK_STATUS)) {
    throw new Error(`Program "${name}" failed to link: ${gl.getProgramInfoLog(prog)}`);
  }
  const locs = new Map();
  const loc = (n) => {
    if (!locs.has(n)) locs.set(n, gl.getUniformLocation(prog, n));
    return locs.get(n);
  };
  let unit = 0;
  return {
    name,
    prog,
    use() {
      gl.useProgram(prog);
      unit = 0;
      return this;
    },
    f1(n, v) { gl.uniform1f(loc(n), v); return this; },
    i1(n, v) { gl.uniform1i(loc(n), v); return this; },
    f2(n, a, b) { gl.uniform2f(loc(n), a, b); return this; },
    f3(n, a, b, c) { gl.uniform3f(loc(n), a, b, c); return this; },
    v3(n, v) { gl.uniform3f(loc(n), v[0], v[1], v[2]); return this; },
    f4(n, a, b, c, d) { gl.uniform4f(loc(n), a, b, c, d); return this; },
    m4(n, m) { gl.uniformMatrix4fv(loc(n), false, m); return this; },
    v3a(n, arr) { gl.uniform3fv(loc(n), arr); return this; },
    tex(n, texture) {
      gl.activeTexture(gl.TEXTURE0 + unit);
      gl.bindTexture(gl.TEXTURE_2D, texture);
      gl.uniform1i(loc(n), unit);
      unit++;
      return this;
    },
  };
}

// Mesh from separate attribute arrays. `dynamic` keeps buffers for updates.
export function createMesh(gl, arrays, dynamic = false) {
  const vao = gl.createVertexArray();
  gl.bindVertexArray(vao);
  const buffers = {};
  const sizes = { pos: 3, nrm: 3, col: 3, ext: 4 };
  for (const key of Object.keys(sizes)) {
    const data = arrays[key];
    if (!data) continue;
    const buf = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, buf);
    gl.bufferData(gl.ARRAY_BUFFER, data, dynamic ? gl.DYNAMIC_DRAW : gl.STATIC_DRAW);
    gl.enableVertexAttribArray(ATTR[key]);
    gl.vertexAttribPointer(ATTR[key], sizes[key], gl.FLOAT, false, 0, 0);
    buffers[key] = buf;
  }
  const ibo = gl.createBuffer();
  gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, ibo);
  gl.bufferData(gl.ELEMENT_ARRAY_BUFFER, arrays.idx, dynamic ? gl.DYNAMIC_DRAW : gl.STATIC_DRAW);
  gl.bindVertexArray(null);
  return {
    vao,
    count: arrays.idx.length,
    buffers,
    update(key, data) {
      gl.bindBuffer(gl.ARRAY_BUFFER, buffers[key]);
      gl.bufferSubData(gl.ARRAY_BUFFER, 0, data);
    },
    draw(count = this.count) {
      if (!count) return;
      gl.bindVertexArray(vao);
      gl.drawElements(gl.TRIANGLES, count, gl.UNSIGNED_INT, 0);
    },
  };
}

// Colour target, optionally with a sampleable depth texture or a depth renderbuffer.
export function createTarget(gl, w, h, opts = {}) {
  const { depth = "none", filter = gl.LINEAR } = opts;
  const t = { w: 0, h: 0, fb: gl.createFramebuffer(), tex: gl.createTexture(), depthTex: null, rb: null };
  t.resize = (nw, nh) => {
    nw = Math.max(1, Math.round(nw));
    nh = Math.max(1, Math.round(nh));
    if (nw === t.w && nh === t.h) return t;
    t.w = nw;
    t.h = nh;
    gl.bindTexture(gl.TEXTURE_2D, t.tex);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA8, nw, nh, 0, gl.RGBA, gl.UNSIGNED_BYTE, null);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, filter);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, filter);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    gl.bindFramebuffer(gl.FRAMEBUFFER, t.fb);
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, t.tex, 0);
    if (depth === "texture") {
      if (!t.depthTex) t.depthTex = gl.createTexture();
      gl.bindTexture(gl.TEXTURE_2D, t.depthTex);
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.DEPTH_COMPONENT24, nw, nh, 0, gl.DEPTH_COMPONENT, gl.UNSIGNED_INT, null);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
      gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.DEPTH_ATTACHMENT, gl.TEXTURE_2D, t.depthTex, 0);
    } else if (depth === "buffer") {
      if (!t.rb) t.rb = gl.createRenderbuffer();
      gl.bindRenderbuffer(gl.RENDERBUFFER, t.rb);
      gl.renderbufferStorage(gl.RENDERBUFFER, gl.DEPTH_COMPONENT24, nw, nh);
      gl.framebufferRenderbuffer(gl.FRAMEBUFFER, gl.DEPTH_ATTACHMENT, gl.RENDERBUFFER, t.rb);
    }
    const status = gl.checkFramebufferStatus(gl.FRAMEBUFFER);
    if (status !== gl.FRAMEBUFFER_COMPLETE) throw new Error("Framebuffer incomplete: 0x" + status.toString(16));
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    return t;
  };
  t.bind = () => {
    gl.bindFramebuffer(gl.FRAMEBUFFER, t.fb);
    gl.viewport(0, 0, t.w, t.h);
  };
  t.resize(w, h);
  return t;
}

// Float heightmap, sampled by the water to know how deep it is.
export function createHeightTexture(gl, data, w, h) {
  const tex = gl.createTexture();
  gl.bindTexture(gl.TEXTURE_2D, tex);
  gl.texImage2D(gl.TEXTURE_2D, 0, gl.R16F, w, h, 0, gl.RED, gl.FLOAT, data);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
  return tex;
}

// One oversized triangle covers the screen; no vertex buffers needed.
export function createFullscreen(gl) {
  const vao = gl.createVertexArray();
  return {
    draw() {
      gl.bindVertexArray(vao);
      gl.drawArrays(gl.TRIANGLES, 0, 3);
    },
  };
}
