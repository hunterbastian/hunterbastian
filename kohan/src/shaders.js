// GLSL for the scene and for the post stack.
// Scene shaders share COMMON: noise, the palette, sky, fog and the light model.

const V = "#version 300 es\n";

const COMMON = /* glsl */ `
precision highp float;
precision highp int;
uniform mat4 u_vp;
uniform vec3 u_camPos;
uniform vec3 u_sunDir;
uniform vec3 u_wind;
uniform float u_time;
uniform float u_clip;
uniform vec4 u_canopy;   // xz centre, radius, height of the tree canopy
uniform vec2 u_trunk;
uniform vec2 u_streak;   // direction the high cloud streaks run (xz)

const vec3 PAL_NAVY = vec3(0.027, 0.055, 0.114);
const vec3 PAL_CHAR = vec3(0.110, 0.114, 0.153);
const vec3 PAL_SLATE = vec3(0.227, 0.239, 0.310);
const vec3 PAL_SLATE_L = vec3(0.345, 0.353, 0.435);
const vec3 PAL_RUST_D = vec3(0.306, 0.204, 0.192);
const vec3 PAL_RUST = vec3(0.478, 0.290, 0.180);
const vec3 PAL_RUST_L = vec3(0.647, 0.376, 0.173);
const vec3 PAL_TAN = vec3(0.784, 0.604, 0.384);
const vec3 PAL_PURP = vec3(0.235, 0.239, 0.431);
const vec3 PAL_PERI_L = vec3(0.541, 0.635, 0.925);
const vec3 PAL_CLOUD = vec3(0.808, 0.859, 0.969);

float hash12(vec2 p) {
  vec3 p3 = fract(vec3(p.xyx) * 0.1031);
  p3 += dot(p3, p3.yzx + 33.33);
  return fract((p3.x + p3.y) * p3.z);
}
float hash13(vec3 p3) {
  p3 = fract(p3 * 0.1031);
  p3 += dot(p3, p3.zyx + 31.32);
  return fract((p3.x + p3.y) * p3.z);
}
float vnoise(vec2 p) {
  vec2 i = floor(p), f = fract(p);
  vec2 u = f * f * (3.0 - 2.0 * f);
  float a = hash12(i), b = hash12(i + vec2(1.0, 0.0));
  float c = hash12(i + vec2(0.0, 1.0)), d = hash12(i + vec2(1.0, 1.0));
  return mix(mix(a, b, u.x), mix(c, d, u.x), u.y);
}
float fbm(vec2 p) {
  float s = 0.0, a = 0.5;
  for (int i = 0; i < 4; i++) { s += a * vnoise(p); p = p * 2.03 + vec2(17.1, 9.3); a *= 0.5; }
  return s / 0.9375;
}
float vnoise3(vec3 p) {
  vec3 i = floor(p), f = fract(p);
  vec3 u = f * f * (3.0 - 2.0 * f);
  float n000 = hash13(i), n100 = hash13(i + vec3(1, 0, 0));
  float n010 = hash13(i + vec3(0, 1, 0)), n110 = hash13(i + vec3(1, 1, 0));
  float n001 = hash13(i + vec3(0, 0, 1)), n101 = hash13(i + vec3(1, 0, 1));
  float n011 = hash13(i + vec3(0, 1, 1)), n111 = hash13(i + vec3(1, 1, 1));
  return mix(mix(mix(n000, n100, u.x), mix(n010, n110, u.x), u.y),
             mix(mix(n001, n101, u.x), mix(n011, n111, u.x), u.y), u.z);
}
float fbm3(vec3 p) {
  float s = 0.0, a = 0.5;
  for (int i = 0; i < 5; i++) { s += a * vnoise3(p); p = p * 2.02 + vec3(5.1, 1.7, 9.2); a *= 0.5; }
  return s / 0.96875;
}

vec3 skyGradient(vec3 d) {
  float y = max(d.y, 0.0);
  vec3 hor = vec3(0.80, 0.84, 0.92);
  vec3 zen = vec3(0.55, 0.61, 0.69);
  vec3 c = mix(hor, zen, smoothstep(0.0, 0.6, y));
  float s = max(dot(d, u_sunDir), 0.0);
  c += vec3(1.0, 0.96, 0.9) * (pow(s, 8.0) * 0.1 + pow(s, 90.0) * 0.4);
  return c;
}

vec3 fogColor(vec3 d) {
  return skyGradient(normalize(vec3(d.x, 0.015, d.z)));
}

// Purple aerial haze first, then the sky swallows the far distance.
vec3 applyFog(vec3 col, vec3 wp) {
  vec3 v = wp - u_camPos;
  float dist = length(v);
  float haze = 1.0 - exp(-dist * 0.0011);
  col = mix(col, vec3(0.27, 0.29, 0.50), haze * 0.55);
  float f = 1.0 - exp(-dist * 0.0003);
  return mix(col, fogColor(v / max(dist, 1e-3)), clamp(f * f * 1.4, 0.0, 1.0));
}

// The tree's shadow, cast analytically: march from the point toward the sun
// up to canopy height and test the canopy disc, plus the trunk near the ground.
float canopyShadow(vec3 wp) {
  float sy = max(u_sunDir.y, 0.05);
  float k = (u_canopy.w - 2.0 - wp.y) / sy;
  if (k < 0.0) return 1.0;
  vec2 q = wp.xz + u_sunDir.xz * k;
  float r = length(q - u_canopy.xy) / u_canopy.z;
  float dap = vnoise(q * 1.1) * 0.6 + vnoise(q * 2.7) * 0.4;
  float sh = smoothstep(1.0, 0.65, r + (dap - 0.5) * 0.55);
  float k2 = (u_canopy.w - 9.0 - wp.y) / sy;
  vec2 q2 = wp.xz + u_sunDir.xz * max(k2, 0.0);
  float tr = smoothstep(0.95, 0.5, length(q2 - u_trunk)) * step(0.0, k2);
  return 1.0 - max(sh * 0.8, tr * 0.85);
}

// Pixel-art light: shadows fall toward navy, not black; rim light from the
// low sun behind the tree.
vec3 shade(vec3 alb, vec3 n, vec3 wp, float ao, float sh, float rimAmt) {
  vec3 Vv = normalize(u_camPos - wp);
  float sunD = max(dot(n, u_sunDir), 0.0) * sh;
  float sky = 0.5 + 0.5 * n.y;
  float l = sky * 0.5 * ao + sunD * 0.7;
  vec3 dark = mix(PAL_NAVY, alb * 0.5, 0.3);
  vec3 col = mix(dark, alb, clamp(l * 1.2, 0.0, 1.0));
  col += alb * max(l * 1.2 - 1.0, 0.0) * 0.7;
  float back = pow(max(dot(-Vv, u_sunDir), 0.0), 2.0);
  float rim = pow(1.0 - max(dot(n, Vv), 0.0), 3.0) * back * sh;
  col += (alb * 0.9 + vec3(0.22, 0.2, 0.2)) * rim * rimAmt;
  return col;
}
`;

// --- Sky -------------------------------------------------------------------
export const SKY_VS = V + /* glsl */ `
out vec2 v_ndc;
void main() {
  vec2 p = vec2(float((gl_VertexID << 1) & 2), float(gl_VertexID & 2));
  v_ndc = p * 2.0 - 1.0;
  gl_Position = vec4(v_ndc, 0.0, 1.0);
}`;

export const SKY_FS = V + COMMON + /* glsl */ `
uniform vec3 u_camR, u_camU, u_camF;
uniform vec2 u_tan;
in vec2 v_ndc;
out vec4 o;

vec3 skyColor(vec3 d) {
  vec3 c = skyGradient(d);
  float y = max(d.y, 0.0);
  float t = u_time;
  // overcast mottling on a flattened cloud deck
  vec3 q = d / (y + 0.25);
  float m = fbm3(vec3(q.x * 1.1 + t * 0.006, y * 2.0, q.z * 1.1));
  c = mix(c, vec3(0.58, 0.64, 0.70), smoothstep(0.38, 0.66, m) * 0.75 * smoothstep(0.02, 0.22, y));
  c = mix(c, vec3(0.88, 0.91, 0.97), smoothstep(0.62, 0.8, m) * 0.4 * smoothstep(0.1, 0.4, y));
  // cumulus banks heaped along the horizon
  vec3 h = normalize(vec3(d.x, 0.0, d.z));
  vec3 bp = vec3(h.x * 4.5 + t * 0.008, y * 15.0, h.z * 4.5);
  float b = fbm3(bp);
  float band = smoothstep(0.36, 0.04, y) * smoothstep(-0.01, 0.03, d.y);
  float cum = smoothstep(0.47, 0.56, b * 0.9 + band * 0.42 - y * 0.5) * band;
  float bt = fbm3(bp + vec3(0.0, 0.45, 0.0));
  float lit = clamp(0.6 + (b - bt) * 4.0 + y * 2.5, 0.0, 1.0);
  float toward = pow(max(dot(d, u_sunDir), 0.0), 3.0);
  vec3 cc = mix(vec3(0.6, 0.65, 0.79), vec3(0.93, 0.95, 0.99), lit);
  cc = mix(cc, vec3(1.0), toward * 0.75);
  c = mix(c, cc, cum);
  // long wind streaks that converge toward the sun side of the horizon
  vec2 p = d.xz / (y + 0.06);
  vec2 sdir = normalize(u_streak);
  vec2 sp = vec2(dot(p, sdir) * 0.05, dot(p, vec2(-sdir.y, sdir.x)) * 0.7);
  float st = fbm(sp + vec2(t * 0.01, 0.0));
  float streak = smoothstep(0.6, 0.74, st) * smoothstep(0.07, 0.22, y) * smoothstep(0.95, 0.5, y);
  c = mix(c, vec3(0.96, 0.98, 1.0), streak * 0.9);
  return c;
}

void main() {
  vec3 d = normalize(u_camF + v_ndc.x * u_tan.x * u_camR + v_ndc.y * u_tan.y * u_camU);
  vec3 c = skyColor(d);
  if (d.y < 0.0) c = mix(c, fogColor(d), smoothstep(0.0, -0.05, d.y));
  o = vec4(c, 1.0);
}`;

// --- Lit geometry: terrain, bark, stone, the stele, the far shore ----------
export const LIT_VS = V + /* glsl */ `
precision highp float;
layout(location = 0) in vec3 a_pos;
layout(location = 1) in vec3 a_nrm;
layout(location = 2) in vec3 a_col;
layout(location = 3) in vec4 a_ext;
uniform mat4 u_vp;
out vec3 v_wp;
out vec3 v_n;
out vec3 v_col;
out vec4 v_ext;
void main() {
  v_wp = a_pos;
  v_n = a_nrm;
  v_col = a_col;
  v_ext = a_ext;
  gl_Position = u_vp * vec4(a_pos, 1.0);
}`;

export const LIT_FS = V + COMMON + /* glsl */ `
uniform int u_mat;
uniform float u_lantern;
in vec3 v_wp;
in vec3 v_n;
in vec3 v_col;
in vec4 v_ext;
out vec4 o;

vec3 terrainAlbedo(vec3 wp, vec3 n, out float ao) {
  float n1 = fbm(wp.xz * 0.08);
  float n2 = vnoise(wp.xz * 1.7);
  float flatness = smoothstep(0.78, 0.95, n.y);
  vec3 alb = mix(PAL_RUST_D * 0.8, PAL_RUST * 0.92, smoothstep(0.4, 0.75, n1));
  alb = mix(alb, PAL_TAN * 0.85, smoothstep(0.74, 0.9, n2 * 0.6 + n1 * 0.5) * flatness * smoothstep(0.25, 0.7, wp.y) * 0.6);
  alb = mix(alb, PAL_CHAR, (1.0 - smoothstep(0.55, 0.85, n.y)) * 0.55);
  float wet = 1.0 - smoothstep(0.02, 0.45, wp.y);
  alb = mix(alb, alb * 0.5 + PAL_CHAR * 0.2, wet);
  if (wp.y < 0.0) alb = mix(alb, vec3(0.16, 0.18, 0.42), clamp(-wp.y * 1.2, 0.0, 0.9));
  float dt = length(wp.xz - u_trunk);
  float under = length(wp.xz - u_canopy.xy) / u_canopy.z;
  ao = mix(0.45, 1.0, smoothstep(1.5, 8.0, dt)) * mix(0.55, 1.0, smoothstep(0.35, 1.05, under));
  return alb;
}

vec3 barkAlbedo(vec4 e) {
  float a = e.x, along = e.y;
  float streak = vnoise(vec2(a * 7.0, along * 0.7));
  float fine = vnoise(vec2(a * 21.0, along * 2.6));
  vec3 alb = mix(PAL_CHAR, PAL_SLATE, smoothstep(0.3, 0.72, streak));
  alb = mix(alb, PAL_SLATE_L * 1.1, smoothstep(0.7, 0.92, fine) * 0.85);
  return alb;
}

vec3 steleAlbedo(vec3 wp, vec4 e) {
  vec3 alb = mix(vec3(0.8, 0.85, 0.96), vec3(0.95, 0.97, 1.0), vnoise(wp.xz * 3.0 + wp.y * 2.0)) * 1.12;
  alb *= 0.9 + 0.12 * vnoise(vec2(wp.y * 9.0, (wp.x + wp.z) * 9.0));
  if (e.z > 0.5 && e.z < 1.5) {
    vec2 g = e.xy * vec2(6.0, 24.0);
    vec2 cell = floor(g);
    vec2 f = fract(g);
    if ((cell.x == 2.0 || cell.x == 3.0) && cell.y > 4.0 && cell.y < 21.0) {
      vec2 sub = floor(f * 3.0);
      float on = step(0.42, hash12(cell * 3.1 + sub * 1.7));
      if (on > 0.5 && f.x > 0.14 && f.x < 0.86 && f.y > 0.16 && f.y < 0.84) alb *= 0.5;
    }
  }
  alb = mix(alb * 0.55, alb, smoothstep(-0.2, 0.45, wp.y));
  return alb;
}

void main() {
  if (u_clip > 0.5 && v_wp.y < -0.02) discard;
  vec3 n = normalize(v_n);
  if (v_ext.w > 0.5) {
    // emissive: town windows always, the lantern only when lit
    float k = v_ext.z > 1.5 ? u_lantern : 0.75;
    vec3 off = PAL_CHAR * 0.8;
    vec3 e = mix(off, v_col * 1.5, k);
    o = vec4(applyFog(e, v_wp), 1.0);
    return;
  }
  vec3 alb;
  float ao = 1.0;
  float sh = 1.0;
  if (u_mat == 0) {
    alb = terrainAlbedo(v_wp, n, ao);
    sh = canopyShadow(v_wp);
  } else if (u_mat == 1) {
    alb = barkAlbedo(v_ext);
    sh = mix(0.55, 1.0, smoothstep(6.0, 14.0, v_wp.y - u_canopy.w + 12.0));
  } else if (u_mat == 2) {
    alb = v_col * (0.85 + 0.25 * vnoise(v_wp.xz * 4.0 + v_wp.y * 3.0));
    sh = canopyShadow(v_wp);
  } else if (u_mat == 3) {
    alb = steleAlbedo(v_wp, v_ext);
    sh = canopyShadow(v_wp);
  } else {
    alb = v_col;
  }
  float rimAmt = u_mat == 0 ? 0.12 : (u_mat == 1 ? 1.0 : 0.35);
  vec3 col = shade(alb, n, v_wp, ao, sh, rimAmt);
  o = vec4(applyFog(col, v_wp), 1.0);
}`;

// --- Foliage: leaf cards, grass tufts, reeds, falling leaves ---------------
export const FOLIAGE_VS = V + /* glsl */ `
precision highp float;
layout(location = 0) in vec3 a_pos;
layout(location = 1) in vec3 a_nrm;
layout(location = 2) in vec3 a_col;
layout(location = 3) in vec4 a_ext;
uniform mat4 u_vp;
uniform vec3 u_wind;
uniform float u_time;
uniform float u_windAmt;
out vec3 v_wp;
out vec3 v_n;
out vec3 v_col;
out vec4 v_ext;
void main() {
  vec3 p = a_pos;
  float kind = a_ext.w;
  if (kind < 0.5) {
    float h = max(p.y - 5.0, 0.0);
    float ph = dot(p.xz, vec2(0.13, 0.17)) + a_ext.z * 6.283;
    float gust = sin(u_time * 0.9 + ph * 0.25) * 0.5 + 0.5;
    p.xz += u_wind.xz * gust * h * 0.016 * u_windAmt;
    p += vec3(sin(u_time * 3.1 + ph), sin(u_time * 4.3 + ph * 1.7), cos(u_time * 2.7 + ph)) * 0.035 * u_windAmt;
  } else if (kind < 2.0) {
    float t = a_ext.y;
    float ph = a_ext.z * 6.283 + dot(p.xz, vec2(0.31, 0.21));
    float sway = (sin(u_time * 1.6 + ph) * 0.5 + 0.75) * t * t;
    p.xz += u_wind.xz * sway * 0.2 * u_windAmt;
  }
  v_wp = p;
  v_n = a_nrm;
  v_col = a_col;
  v_ext = a_ext;
  gl_Position = u_vp * vec4(p, 1.0);
}`;

export const FOLIAGE_FS = V + COMMON + /* glsl */ `
in vec3 v_wp;
in vec3 v_n;
in vec3 v_col;
in vec4 v_ext;
out vec4 o;
void main() {
  if (u_clip > 0.5 && v_wp.y < -0.02) discard;
  float kind = v_ext.w;
  vec2 uv = v_ext.xy;
  float seed = v_ext.z;
  vec3 Vv = normalize(v_wp - u_camPos);
  float back = pow(max(dot(Vv, u_sunDir), 0.0), 6.0);
  vec3 col;
  if (kind < 0.5) {
    vec2 c = uv - 0.5;
    float a = vnoise(uv * 5.0 + seed * 41.0) * 0.6 + vnoise(uv * 11.0 + seed * 13.0) * 0.35 + (0.5 - length(c)) * 1.3;
    if (a < 0.66) discard;
    vec3 n = normalize(v_n);
    float up = n.y * 0.5 + 0.5;
    float sunD = max(dot(n, u_sunDir), 0.0);
    float l = up * 0.62 + sunD * 0.35 + (a - 0.66) * 0.45 - 0.12;
    vec3 dark = mix(PAL_NAVY, v_col * 0.3, 0.3);
    col = mix(dark, v_col * 1.08, clamp(l * 1.15, 0.0, 1.0));
    col = mix(col, PAL_RUST_L * 1.15, smoothstep(0.88, 1.05, l) * 0.5);
    col += vec3(0.8, 0.45, 0.17) * back * (0.2 + 0.8 * (1.0 - up)) * 0.3;
  } else if (kind < 2.0) {
    bool reed = kind > 1.25;
    float cover = 0.0;
    for (int i = 0; i < 5; i++) {
      float fi = float(i);
      float x0 = 0.12 + 0.76 * hash12(vec2(seed * 91.0, fi));
      float lean = (hash12(vec2(fi, seed * 37.0)) - 0.5) * 0.7;
      float hgt = 0.5 + 0.5 * hash12(vec2(seed * 13.0 + fi, 3.0));
      float x = x0 + lean * uv.y * uv.y;
      float w = (reed ? 0.045 : 0.075) * (1.0 - uv.y / hgt);
      cover = max(cover, step(abs(uv.x - x), w) * step(uv.y, hgt));
    }
    if (cover < 0.5) discard;
    float sh = canopyShadow(v_wp);
    vec3 base = mix(PAL_RUST_D * 0.5, v_col, smoothstep(0.0, 0.85, uv.y));
    col = mix(mix(PAL_NAVY, base * 0.4, 0.3), base, clamp((0.55 + 0.5 * uv.y) * mix(0.7, 1.0, sh), 0.0, 1.0));
    col += v_col * back * uv.y * 0.5 * sh;
  } else {
    vec2 c = (uv - 0.5) * vec2(1.0, 1.8);
    float r = length(c) + abs(uv.x - 0.5) * 0.2;
    if (r > 0.5) discard;
    vec3 n = normalize(v_n);
    float l = 0.55 + 0.45 * abs(dot(n, u_sunDir));
    col = v_col * l + v_col * back * 0.6;
  }
  o = vec4(applyFog(col, v_wp), 1.0);
}`;

// --- Water -------------------------------------------------------------------
export const WATER_VS = V + /* glsl */ `
precision highp float;
layout(location = 0) in vec3 a_pos;
uniform mat4 u_vp;
out vec3 v_wp;
void main() {
  v_wp = a_pos;
  gl_Position = u_vp * vec4(a_pos, 1.0);
}`;

export const WATER_FS = V + COMMON + /* glsl */ `
uniform sampler2D u_refl;
uniform sampler2D u_height;
uniform vec4 u_hmap;
uniform vec2 u_res;
uniform vec2 u_heroR, u_heroF;
in vec3 v_wp;
out vec4 o;

float waves(vec2 q, float t) {
  vec2 a = vec2(dot(q, u_heroR), dot(q, u_heroF));
  return vnoise(vec2(a.x * 0.22, a.y * 1.3) + vec2(t * 0.05, t * 0.22)) * 0.6
       + vnoise(vec2(a.x * 0.5 + a.y * 0.2, a.y * 2.8) - vec2(t * 0.1, t * 0.35)) * 0.4;
}

void main() {
  vec3 wp = v_wp;
  vec3 toCam = u_camPos - wp;
  float dist = length(toCam);
  vec3 Vv = toCam / dist;
  float t = u_time;
  float e = 0.12;
  float h0 = waves(wp.xz, t);
  float hx = waves(wp.xz + vec2(e, 0.0), t);
  float hz = waves(wp.xz + vec2(0.0, e), t);
  float fade = exp(-dist * 0.006);
  vec3 n = normalize(vec3(-(hx - h0) / e * 0.22 * fade, 1.0, -(hz - h0) / e * 0.22 * fade));

  vec2 huv = (wp.xz - u_hmap.xy) / u_hmap.zw;
  float ground = (huv.x > 0.0 && huv.y > 0.0 && huv.x < 1.0 && huv.y < 1.0) ? texture(u_height, huv).r : -10.0;
  float depth = max(-ground, 0.0);

  vec2 suv = gl_FragCoord.xy / u_res;
  suv.y = 1.0 - suv.y;
  suv += n.xz * vec2(0.5, 1.0) * 0.05 / (1.0 + dist * 0.03);
  vec3 refl = texture(u_refl, clamp(suv, vec2(0.001), vec2(0.999))).rgb;

  float F = 0.2 + 0.8 * pow(1.0 - max(dot(n, Vv), 0.0), 5.0);
  vec3 deep = vec3(0.21, 0.25, 0.62);
  vec3 shallow = vec3(0.3, 0.4, 0.76);
  vec3 base = mix(shallow, deep, smoothstep(0.0, 3.0, depth));
  vec3 tint = refl * vec3(0.36, 0.44, 0.95);
  vec3 col = mix(base, tint + base * 0.3, 0.32 + 0.4 * F);

  vec2 a = vec2(dot(wp.xz, u_heroR), dot(wp.xz, u_heroF));
  float lines = smoothstep(0.73, 0.8, vnoise(vec2(a.x * 0.16, a.y * 1.9) + vec2(t * 0.04, t * 0.12)));
  vec2 sunH = normalize(u_sunDir.xz);
  float sunSide = 0.45 + 0.55 * pow(max(dot(normalize(-Vv.xz), sunH), 0.0), 3.0);
  col = mix(col, PAL_PERI_L, lines * 0.55 * sunSide);
  vec3 H = normalize(Vv + u_sunDir);
  col += vec3(1.0, 0.97, 0.9) * pow(max(dot(n, H), 0.0), 140.0) * 0.9;
  col *= mix(0.72, 1.0, canopyShadow(wp));

  float alpha = mix(0.62, 0.97, smoothstep(0.0, 1.0, depth));
  float foam = smoothstep(0.1, 0.0, depth) * smoothstep(0.55, 0.8, vnoise(wp.xz * 2.2 + t * 0.3));
  col = mix(col, PAL_PERI_L, foam * 0.5);
  o = vec4(applyFog(col, wp), alpha);
}`;

// --- Post stack ------------------------------------------------------------
export const POST_VS = V + /* glsl */ `
out vec2 v_uv;
void main() {
  vec2 p = vec2(float((gl_VertexID << 1) & 2), float(gl_VertexID & 2));
  v_uv = p;
  gl_Position = vec4(p * 2.0 - 1.0, 0.0, 1.0);
}`;

const POST_HEAD = V + /* glsl */ `
precision highp float;
precision highp int;
in vec2 v_uv;
out vec4 o;
`;

// Dual Kawase filter (Marius Bjørge, "Bandwidth-efficient rendering", SIGGRAPH 2015).
export const KAWASE_DOWN_FS = POST_HEAD + /* glsl */ `
uniform sampler2D u_src;
uniform vec2 u_texel;
uniform float u_threshold;
uniform float u_prefilter;
vec3 pre(vec3 c) {
  if (u_prefilter < 0.5) return c;
  float br = max(c.r, max(c.g, c.b));
  return c * smoothstep(u_threshold, u_threshold + 0.18, br);
}
void main() {
  vec2 h = u_texel;
  vec3 s = pre(texture(u_src, v_uv).rgb) * 4.0;
  s += pre(texture(u_src, v_uv - h).rgb);
  s += pre(texture(u_src, v_uv + h).rgb);
  s += pre(texture(u_src, v_uv + vec2(h.x, -h.y)).rgb);
  s += pre(texture(u_src, v_uv - vec2(h.x, -h.y)).rgb);
  o = vec4(s / 8.0, 1.0);
}`;

export const KAWASE_UP_FS = POST_HEAD + /* glsl */ `
uniform sampler2D u_src;
uniform vec2 u_texel;
void main() {
  vec2 h = u_texel;
  vec3 s = texture(u_src, v_uv + vec2(-h.x * 2.0, 0.0)).rgb;
  s += texture(u_src, v_uv + vec2(-h.x, h.y)).rgb * 2.0;
  s += texture(u_src, v_uv + vec2(0.0, h.y * 2.0)).rgb;
  s += texture(u_src, v_uv + vec2(h.x, h.y)).rgb * 2.0;
  s += texture(u_src, v_uv + vec2(h.x * 2.0, 0.0)).rgb;
  s += texture(u_src, v_uv + vec2(h.x, -h.y)).rgb * 2.0;
  s += texture(u_src, v_uv + vec2(0.0, -h.y * 2.0)).rgb;
  s += texture(u_src, v_uv + vec2(-h.x, -h.y)).rgb * 2.0;
  o = vec4(s / 12.0, 1.0);
}`;

// Sun shafts, step 1: bright sky pixels near the sun.
export const RAYS_MASK_FS = POST_HEAD + /* glsl */ `
uniform sampler2D u_color;
uniform sampler2D u_depth;
uniform vec2 u_sun;
uniform float u_aspect;
void main() {
  float d = texture(u_depth, v_uv).r;
  vec3 c = texture(u_color, v_uv).rgb;
  float sky = d > 0.999999 ? 1.0 : 0.0;
  float lum = dot(c, vec3(0.3, 0.59, 0.11));
  vec2 dv = (v_uv - u_sun) * vec2(u_aspect, 1.0);
  float fall = exp(-dot(dv, dv) * 10.0);
  o = vec4(vec3(sky * smoothstep(0.9, 1.0, lum) * fall), 1.0);
}`;

// Step 2: radial blur toward the sun (GPU Gems 3, ch. 13).
export const RAYS_BLUR_FS = POST_HEAD + /* glsl */ `
uniform sampler2D u_mask;
uniform vec2 u_sun;
void main() {
  const int N = 48;
  vec2 uv = v_uv;
  vec2 delta = (uv - u_sun) * (0.95 / float(N));
  float illum = 1.0;
  float acc = 0.0;
  for (int i = 0; i < N; i++) {
    uv -= delta;
    acc += texture(u_mask, uv).r * illum;
    illum *= 0.965;
  }
  o = vec4(vec3(acc / float(N) * 2.6), 1.0);
}`;

// Combine: depth of field, bloom, shafts, then colour depth + dither and grain.
export const COMPOSE_FS = POST_HEAD + /* glsl */ `
uniform sampler2D u_scene, u_depth, u_bloom, u_blur, u_rays;
uniform float u_bloomAmt, u_dofAmt, u_raysAmt, u_grain, u_frame;
uniform vec3 u_raysCol;
uniform vec2 u_nearFar, u_dof;
uniform int u_depthMode;
uniform vec3 u_pal[16];

const float BAYER[16] = float[16](0., 8., 2., 10., 12., 4., 14., 6., 3., 11., 1., 9., 15., 7., 13., 5.);
// The PS2 GS dither matrix most games load into DIMX.
const float PS2D[16] = float[16](-4., 2., -3., 3., 0., -2., 1., -1., -3., 3., -4., 2., 1., -1., 0., -2.);

float linearDepth(float d) {
  float z = d * 2.0 - 1.0;
  float n = u_nearFar.x, f = u_nearFar.y;
  return 2.0 * n * f / (f + n - z * (f - n));
}
float hash12(vec2 p) {
  vec3 p3 = fract(vec3(p.xyx) * 0.1031);
  p3 += dot(p3, p3.yzx + 33.33);
  return fract((p3.x + p3.y) * p3.z);
}

void main() {
  vec3 c = texture(u_scene, v_uv).rgb;
  if (u_dofAmt > 0.0) {
    float z = linearDepth(texture(u_depth, v_uv).r);
    float k = smoothstep(u_dof.x, u_dof.y, z) * u_dofAmt;
    c = mix(c, texture(u_blur, v_uv).rgb, k);
  }
  if (u_bloomAmt > 0.0) c += texture(u_bloom, v_uv).rgb * u_bloomAmt;
  if (u_raysAmt > 0.0) c += texture(u_rays, v_uv).r * u_raysCol * u_raysAmt;
  c = min(c, vec3(1.0)) + max(c - 1.0, 0.0) * 0.15;
  c = clamp(c, 0.0, 1.0);

  ivec2 px = ivec2(gl_FragCoord.xy);
  int bi = (px.y & 3) * 4 + (px.x & 3);
  float bay = (BAYER[bi] + 0.5) / 16.0;
  float g = hash12(vec2(px) + vec2(u_frame * 7.0, u_frame * 3.0)) - 0.5;

  if (u_depthMode == 1) {
    // PS2: 15-bit colour, GS ordered dither added before truncation
    vec3 c8 = floor(c * 255.0) + PS2D[bi];
    vec3 c5 = floor(clamp(c8, 0.0, 255.0) / 8.0);
    c = (c5 * 8.0 + floor(c5 / 4.0)) / 255.0;
  } else if (u_depthMode == 2) {
    // GameCube: 6 bits per channel in the EFB, ordered dither
    vec3 c6 = floor(c * 63.0 + bay);
    c = c6 / 63.0;
  } else if (u_depthMode == 3) {
    // 12-bit colour, heavier dither
    c = floor(c * 15.0 + bay) / 15.0;
  } else if (u_depthMode == 4) {
    // the painting's palette, Bayer-dithered
    vec3 q = c + (bay - 0.5) * 0.16 + g * u_grain * 1.5;
    float best = 1e9;
    vec3 pick = q;
    for (int i = 0; i < 16; i++) {
      vec3 dd = q - u_pal[i];
      float rm = (q.r + u_pal[i].r) * 0.5;
      float dist = (2.0 + rm) * dd.r * dd.r + 4.0 * dd.g * dd.g + (3.0 - rm) * dd.b * dd.b;
      if (dist < best) { best = dist; pick = u_pal[i]; }
    }
    c = pick;
  } else if (u_depthMode == 5) {
    // banding on purpose: posterised, no dither
    c = floor(c * 6.0 + 0.5) / 6.0;
  }
  if (u_depthMode != 4) c += g * u_grain;
  o = vec4(clamp(c, 0.0, 1.0), 1.0);
}`;

// GameCube copy filter: each output line blends the lines above and below.
// Coefficients from the default vertical filter (7, 7, 12, 12, 12, 7, 7) / 64,
// summed per source line: 14, 36, 14.
export const DEFLICKER_FS = POST_HEAD + /* glsl */ `
uniform sampler2D u_src;
void main() {
  ivec2 p = ivec2(gl_FragCoord.xy);
  ivec2 sz = textureSize(u_src, 0);
  vec3 a = texelFetch(u_src, ivec2(p.x, max(p.y - 1, 0)), 0).rgb;
  vec3 b = texelFetch(u_src, p, 0).rgb;
  vec3 c = texelFetch(u_src, ivec2(p.x, min(p.y + 1, sz.y - 1)), 0).rgb;
  o = vec4((a * 14.0 + b * 36.0 + c * 14.0) / 64.0, 1.0);
}`;

// Composite video: encode each line as one NTSC-style signal (luma plus chroma
// on a subcarrier, four samples per cycle, two samples per pixel), then decode
// it with simple filters. Luma loses fine detail, chroma bleeds sideways, and
// the dither pattern turns into soft colour, the way it did on a real cable.
export const COMPOSITE_FS = POST_HEAD + /* glsl */ `
uniform sampler2D u_src;
uniform float u_artifact;
const float PI = 3.14159265;
vec3 rgb2yiq(vec3 c) {
  return vec3(dot(c, vec3(0.299, 0.587, 0.114)), dot(c, vec3(0.596, -0.274, -0.322)), dot(c, vec3(0.211, -0.523, 0.312)));
}
vec3 yiq2rgb(vec3 y) {
  return vec3(y.x + 0.956 * y.y + 0.621 * y.z, y.x - 0.272 * y.y - 0.647 * y.z, y.x - 1.106 * y.y + 1.703 * y.z);
}
void main() {
  ivec2 sz = textureSize(u_src, 0);
  int xs = int(gl_FragCoord.x);
  int y = int(gl_FragCoord.y);
  float Ya = 0.0, Yc = 0.0, Ia = 0.0, Qa = 0.0, Ic = 0.0, Qc = 0.0, ws = 0.0;
  for (int k = -6; k <= 5; k++) {
    int sx = xs + k;
    vec3 rgb = texelFetch(u_src, ivec2(clamp(sx >> 1, 0, sz.x - 1), y), 0).rgb;
    vec3 q = rgb2yiq(rgb);
    float ph = float(sx) * PI * 0.5 + float(y) * PI;
    float s = q.x + q.y * cos(ph) + q.z * sin(ph);
    if (k >= -2 && k <= 2) {
      float wl = (k == -2 || k == 2) ? 0.5 : 1.0;
      Ya += s * wl;
      Yc += q.x * wl;
    }
    float w = 1.0 - abs(float(k) + 0.5) / 6.5;
    Ia += s * cos(ph) * w;
    Qa += s * sin(ph) * w;
    Ic += q.y * w;
    Qc += q.z * w;
    ws += w;
  }
  vec3 art = vec3(Ya / 4.0, Ia * 2.0 / ws, Qa * 2.0 / ws);
  vec3 cln = vec3(Yc / 4.0, Ic / ws, Qc / ws);
  vec3 yiq = mix(cln, art, u_artifact);
  o = vec4(clamp(yiq2rgb(yiq), 0.0, 1.0), 1.0);
}`;

// Final pass to the screen: CRT scanlines, aperture grille, slight curvature,
// or a plain nearest-neighbour upscale when the CRT is off.
export const OUTPUT_FS = POST_HEAD + /* glsl */ `
uniform sampler2D u_src;
uniform vec2 u_srcSize;
uniform float u_crt;
uniform float u_mask;
vec3 row(float x, float r) {
  r = clamp(r, 0.0, u_srcSize.y - 1.0);
  return texture(u_src, vec2(x, (r + 0.5) / u_srcSize.y)).rgb;
}
void main() {
  vec2 uv = v_uv;
  if (u_crt < 0.5) {
    o = vec4(row(uv.x, floor(uv.y * u_srcSize.y)), 1.0);
    return;
  }
  vec2 cc = uv * 2.0 - 1.0;
  cc *= 1.0 + dot(cc, cc) * vec2(0.012, 0.018);
  uv = cc * 0.5 + 0.5;
  if (uv.x < 0.0 || uv.y < 0.0 || uv.x > 1.0 || uv.y > 1.0) { o = vec4(0.0, 0.0, 0.0, 1.0); return; }
  float ly = uv.y * u_srcSize.y - 0.5;
  float y0 = floor(ly);
  float f = ly - y0;
  vec3 c0 = row(uv.x, y0), c1 = row(uv.x, y0 + 1.0);
  float l0 = dot(c0, vec3(0.3, 0.59, 0.11)), l1 = dot(c1, vec3(0.3, 0.59, 0.11));
  float s0 = mix(0.3, 0.5, l0), s1 = mix(0.3, 0.5, l1);
  vec3 col = c0 * exp(-f * f / (2.0 * s0 * s0)) + c1 * exp(-(1.0 - f) * (1.0 - f) / (2.0 * s1 * s1));
  col *= 1.22;
  float mx = mod(gl_FragCoord.x, 3.0);
  vec3 grille = mx < 1.0 ? vec3(1.12, 0.84, 0.84) : (mx < 2.0 ? vec3(0.84, 1.12, 0.84) : vec3(0.84, 0.84, 1.12));
  col *= mix(vec3(1.0), grille, u_mask);
  vec2 v = cc * vec2(0.7, 0.8);
  col *= 1.0 - dot(v, v) * 0.35;
  o = vec4(col, 1.0);
}`;
