"""Underfern's dinosaurs, built in Blender.

Run with Blender's Python module (`pip install bpy`) or with Blender itself:

  python tools/blender/build_dinos.py --ref <refDir> --out assets/dinos [--ids tyrannosaurus …] [--preview <dir>]
  blender -b -P tools/blender/build_dinos.py -- --ref <refDir> --out assets/dinos

`<refDir>` comes from export-reference.mjs (the game's rig, landmarks and its
old procedural mesh for each species). For every species:

  1. Block-in   the reference parts become closed Blender meshes.
  2. Volume     body, legs and arms are fused into one surface by a voxel
                remesh, and the joins relaxed into fillets.
  3. Sculpt     muscle masses, skull landmarks, ridges, folds and wrinkles are
                displaced into the high-res surface (recipes per species below).
  4. Game mesh  the sculpt is decimated, mirror-symmetric, to the LOD budgets;
                eyes, teeth and claws are kept as modelled in the reference.
  5. Bake       UV unwrap; Cycles bakes the sculpt into a tangent-space normal
                map; ambient occlusion is ray cast into the vertices.
  6. Skin       surface masks and bone weights carry over from the reference
                (smoothed across the fused joins), onto the game's own bones.
  7. Export     one GLB per species: the armature, LOD0, LOD1 (and the
                raptor's feathers), with the normal map. The game reads it in
                src/creatures/dinoAssets.js.

Coordinates stay the game's (y up, +z toward the snout, metres, adult size);
the GLB is written with export_yup off, so they pass through unchanged.
"""

import argparse
import json
import math
import os
import sys
import time

import numpy as np
import bpy
import bmesh
from mathutils import Vector, noise
from mathutils.bvhtree import BVHTree

# Vertex groups of the game mesh (attribute "grp").
SOFT, JAW, EYES, TEETH, CLAWS, FEAT = 1, 2, 3, 4, 5, 6

# Per-species sculpt recipe: strengths (0 = off, 1 = typical). See sculpt_*().
RECIPES = {
    "dryosaurus": dict(kind="ornithopod", thigh=0.9, calf=0.8, caudo=0.9, temple=0.35, brow=0.45, cheek=0.5, fenestra=0.0,
                       nasal=0.0, scutes=0.0, ribs=0.7, belly=0.8, neck=0.7, folds=0.8, tail=0.8, wrinkles=0.6, ossicles=0.0),
    "utahraptor": dict(kind="theropod", thigh=1.0, calf=0.9, caudo=1.0, temple=0.6, brow=0.7, cheek=0.6, fenestra=0.7,
                       nasal=0.25, scutes=0.0, ribs=0.6, belly=0.6, neck=0.8, folds=0.7, tail=0.7, wrinkles=0.6, ossicles=0.0),
    "allosaurus": dict(kind="theropod", thigh=1.0, calf=1.0, caudo=1.0, temple=0.8, brow=0.8, cheek=0.8, fenestra=1.0,
                       nasal=0.7, scutes=0.7, ribs=0.8, belly=0.9, neck=1.0, folds=1.0, tail=1.0, wrinkles=0.9, ossicles=0.0),
    "tyrannosaurus": dict(kind="theropod", thigh=1.1, calf=1.0, caudo=1.15, temple=1.3, brow=1.0, cheek=1.0, fenestra=0.9,
                          nasal=1.0, scutes=0.9, ribs=0.8, belly=1.0, neck=1.2, folds=1.2, tail=1.0, wrinkles=1.1, ossicles=0.0),
    "stegosaurus": dict(kind="quad", thigh=0.9, calf=0.5, caudo=0.8, temple=0.3, brow=0.4, cheek=0.5, fenestra=0.0,
                        nasal=0.0, scutes=0.0, ribs=0.6, belly=1.0, neck=0.9, folds=1.1, tail=0.8, wrinkles=1.2, ossicles=1.0),
    "brontosaurus": dict(kind="sauropod", thigh=0.8, calf=0.4, caudo=0.8, temple=0.25, brow=0.3, cheek=0.3, fenestra=0.0,
                         nasal=0.0, scutes=0.0, ribs=0.5, belly=1.2, neck=1.2, folds=1.3, tail=0.8, wrinkles=1.4, ossicles=0.0),
}


def log(*a):
    print("[blender]", *a, flush=True)


def smoothstep(a, b, x):
    t = np.clip((x - a) / (b - a), 0.0, 1.0)
    return t * t * (3.0 - 2.0 * t)


def gauss(x, c, s):
    return np.exp(-(((x - c) / s) ** 2))


def norm(v):
    return v / np.maximum(np.linalg.norm(v, axis=-1, keepdims=True), 1e-9)


# --- Blender plumbing -----------------------------------------------------

def link(ob):
    bpy.context.scene.collection.objects.link(ob)
    return ob


def mesh_obj(name, V, F):
    me = bpy.data.meshes.new(name)
    me.from_pydata([tuple(map(float, v)) for v in V], [], [tuple(map(int, f)) for f in F])
    me.update()
    return link(bpy.data.objects.new(name, me))


def verts_of(me):
    a = np.empty(len(me.vertices) * 3)
    me.vertices.foreach_get("co", a)
    return a.reshape(-1, 3)


def set_verts(me, V):
    me.vertices.foreach_set("co", np.ascontiguousarray(V, dtype=np.float64).ravel())
    me.update()


def normals_of(me):
    a = np.empty(len(me.vertices) * 3)
    me.vertex_normals.foreach_get("vector", a)
    return a.reshape(-1, 3)


def edges_of(me):
    a = np.empty(len(me.edges) * 2, dtype=np.int64)
    me.edges.foreach_get("vertices", a)
    return a.reshape(-1, 2)


def tris_of(me):
    me.calc_loop_triangles()
    a = np.empty(len(me.loop_triangles) * 3, dtype=np.int64)
    me.loop_triangles.foreach_get("vertices", a)
    return a.reshape(-1, 3)


def apply_modifier(ob, kind, **props):
    m = ob.modifiers.new(kind.lower(), kind)
    for k, v in props.items():
        setattr(m, k, v)
    dg = bpy.context.evaluated_depsgraph_get()
    me = bpy.data.meshes.new_from_object(ob.evaluated_get(dg))
    ob.modifiers.remove(m)
    old = ob.data
    ob.data = me
    bpy.data.meshes.remove(old)
    return ob


def select_only(*obs, active=None):
    for o in list(bpy.context.view_layer.objects):
        if o is not None:
            o.select_set(False)
    for o in obs:
        o.select_set(True)
    bpy.context.view_layer.objects.active = active or (obs[0] if obs else None)


def close_holes(ob):
    bm = bmesh.new()
    bm.from_mesh(ob.data)
    bmesh.ops.remove_doubles(bm, verts=bm.verts, dist=1e-5)
    edges = [e for e in bm.edges if e.is_boundary]
    if edges:
        bmesh.ops.holes_fill(bm, edges=edges, sides=0)
    bmesh.ops.triangulate(bm, faces=bm.faces)
    bm.to_mesh(ob.data)
    bm.free()
    ob.data.update()


def laplacian(V, E, w, iters):
    """Uniform Laplacian smoothing, per-vertex strength w (0..1)."""
    n = len(V)
    deg = np.bincount(E[:, 0], minlength=n) + np.bincount(E[:, 1], minlength=n)
    deg = np.maximum(deg, 1).astype(np.float64)
    for _ in range(iters):
        avg = np.empty_like(V)
        for c in range(3):
            avg[:, c] = (np.bincount(E[:, 0], weights=V[E[:, 1], c], minlength=n) + np.bincount(E[:, 1], weights=V[E[:, 0], c], minlength=n)) / deg
        V = V + w[:, None] * (avg - V)
    return V


def fillet(V, E, N, w, iters, k=0.55):
    """Fill concave creases (where a limb runs into the body) and leave bulges alone:
    a vertex sitting below its neighbours' average moves out along its normal."""
    n = len(V)
    deg = np.maximum(np.bincount(E[:, 0], minlength=n) + np.bincount(E[:, 1], minlength=n), 1).astype(np.float64)
    for _ in range(iters):
        avg = np.empty_like(V)
        for c in range(3):
            avg[:, c] = (np.bincount(E[:, 0], weights=V[E[:, 1], c], minlength=n) + np.bincount(E[:, 1], weights=V[E[:, 0], c], minlength=n)) / deg
        d = avg - V
        s = (d * N).sum(-1)
        V = V + (w * k * np.maximum(s, 0.0))[:, None] * N + (w * 0.25)[:, None] * (d - s[:, None] * N)
    return V


def smooth_field(X, E, iters, k=0.5, mask=None):
    """Average a per-vertex field (n × m) with its neighbours."""
    n = len(X)
    deg = np.maximum(np.bincount(E[:, 0], minlength=n) + np.bincount(E[:, 1], minlength=n), 1).astype(np.float64)
    w = np.full(n, k) if mask is None else k * mask
    for _ in range(iters):
        avg = np.empty_like(X)
        for c in range(X.shape[1]):
            avg[:, c] = (np.bincount(E[:, 0], weights=X[E[:, 1], c], minlength=n) + np.bincount(E[:, 1], weights=X[E[:, 0], c], minlength=n)) / deg
        X = X + w[:, None] * (avg - X)
    return X


# --- The reference --------------------------------------------------------

class Ref:
    def __init__(self, path):
        r = json.load(open(path))
        self.r = r
        self.id = r["id"]
        self.H = r["height"]
        self.length = r["length"]
        self.bones = r["bones"]
        self.bone_names = [b["name"] for b in self.bones]
        sp = r["spine"]
        self.sa = np.array([s["a"] for s in sp])
        self.sp = np.array([s["p"] for s in sp])
        self.st = norm(np.array([s["t"] for s in sp]))
        self.sw = np.array([s["w"] for s in sp])
        self.stop = np.array([s["top"] for s in sp])
        self.sbot = np.array([s["bot"] for s in sp])
        self.arcs = r["arcs"]
        self.head = {k: np.array(v) if isinstance(v, list) else v for k, v in r["head"].items()}
        self.eye = {k: np.array(v) if isinstance(v, list) else v for k, v in r["eye"].items()}
        self.legs = [{k: np.array(v) if isinstance(v, list) and k != "bones" else v for k, v in l.items()} for l in r["legs"]]
        self.arms = [{k: np.array(v) if isinstance(v, list) and k != "bones" else v for k, v in a.items()} for a in r["arms"]]
        self.lods = [self._lod(m) for m in r["lod"]]
        f = r.get("feathers")
        self.feathers = None
        if f:
            self.feathers = dict(
                P=np.array(f["position"]).reshape(-1, 3), I=np.array(f["index"]).reshape(-1, 3), uv=np.array(f["uv"]).reshape(-1, 2),
                N=np.array(f["normal"]).reshape(-1, 3), col=np.array(f["color"]).reshape(-1, 3), skin=np.array(f["skin"]).reshape(-1, 4),
                surf=np.array(f["surf"]).reshape(-1, 2), J=np.array(f["joints"]).reshape(-1, 4), W=np.array(f["weights"]).reshape(-1, 4))

    def _lod(self, m):
        L = dict(P=np.array(m["position"]).reshape(-1, 3), I=np.array(m["index"]).reshape(-1, 3), col=np.array(m["color"]).reshape(-1, 3),
                 skin=np.array(m["skin"]).reshape(-1, 4), surf=np.array(m["surf"]).reshape(-1, 2), J=np.array(m["joints"]).reshape(-1, 4),
                 W=np.array(m["weights"]).reshape(-1, 4), parts=m["parts"])
        # Group of every reference triangle, and its part (body 0, leg i 10+i, arm j 20+j, …).
        nt = len(L["I"])
        grp = np.zeros(nt, dtype=np.int64)
        part = np.full(nt, -1, dtype=np.int64)
        hard = (L["skin"][L["I"], 0] < 0.5).all(axis=1)
        for p in m["parts"]:
            t = slice(p["t0"], p["t1"])
            name = p["name"]
            if name == "body":
                grp[t] = SOFT
                part[t] = 0
            elif name == "jaw":
                grp[t] = JAW
            elif name == "eyes":
                grp[t] = EYES
            elif name == "teeth":
                grp[t] = TEETH
            elif name.startswith("leg") or name.startswith("arm"):
                idx = np.arange(p["t0"], p["t1"])
                grp[idx] = np.where(hard[idx], CLAWS, SOFT)
                part[idx] = (10 if name.startswith("leg") else 20) + int(name[3:])
            else:
                grp[t] = FEAT
        L["grp"] = grp
        L["part"] = part
        # Weights as a dense (vertex × bone) matrix, for interpolation.
        n = len(L["P"])
        Wd = np.zeros((n, len(self.bones)))
        for k in range(4):
            np.add.at(Wd, (np.arange(n), L["J"][:, k]), L["W"][:, k])
        L["Wd"] = Wd
        return L

    def spine_at(self, a):
        P = np.stack([np.interp(a, self.sa, self.sp[:, c]) for c in range(3)], axis=-1)
        T = norm(np.stack([np.interp(a, self.sa, self.st[:, c]) for c in range(3)], axis=-1))
        return P, T, np.interp(a, self.sa, self.sw), np.interp(a, self.sa, self.stop), np.interp(a, self.sa, self.sbot)


def submesh(L, mask):
    """Triangles of reference LOD L where mask → compact (V, F, vertex map)."""
    F = L["I"][mask]
    used = np.unique(F)
    remap = np.full(len(L["P"]), -1, dtype=np.int64)
    remap[used] = np.arange(len(used))
    return L["P"][used], remap[F], used


# --- Anatomy coordinates ---------------------------------------------------

class Anatomy:
    """Where each vertex sits on the animal: spine arc and angle, limb segment."""

    def __init__(self, ref, V, part):
        self.ref = ref
        n = len(V)
        self.V = V
        self.part = part
        # Spine: nearest station, refined along its tangent.
        sp = ref.sp
        a = np.empty(n)
        for i0 in range(0, n, 8000):
            chunk = V[i0:i0 + 8000]
            d2 = ((chunk[:, None, :] - sp[None, :, :]) ** 2).sum(-1)
            k = d2.argmin(1)
            a[i0:i0 + 8000] = ref.sa[k] + ((chunk - sp[k]) * ref.st[k]).sum(-1)
        a = np.clip(a, 0, ref.arcs["L"])
        P, T, w, top, bot = ref.spine_at(a)
        up = np.array([0.0, 1.0, 0.0])
        U = norm(up[None, :] - T * (T @ up)[:, None])
        S = np.cross(U, T)
        d = V - P
        self.a = a
        self.theta = np.arctan2((d * S).sum(-1), (d * U).sum(-1))  # 0 top, ±π/2 sides, ±π belly
        self.at = np.abs(self.theta)
        self.radial = np.linalg.norm(d, axis=-1)
        self.w = w
        self.r = np.where(np.abs(self.theta) < math.pi / 2, top, bot)  # rough local radius
        self.rr = np.maximum((w + top + bot) / 3, 1e-3)
        self.U, self.S, self.T = U, S, T
        # Limbs: segment index (0 upper … 3 foot), position along it, angle round it.
        self.seg = np.full(n, -1)
        self.t = np.zeros(n)
        self.phi = np.zeros(n)
        self.lr = np.zeros(n)  # distance to the limb axis
        self.fore = np.zeros(n, dtype=bool)
        self.arm = np.zeros(n, dtype=bool)
        for li, leg in enumerate(ref.legs):
            idx = np.nonzero(part == 10 + li)[0]
            self._limb(idx, [leg["hip"], leg["knee"], leg["ankle"], leg["ball"], leg["toe"]])
            self.fore[idx] = leg["fore"]
        for ai, arm in enumerate(ref.arms):
            idx = np.nonzero(part == 20 + ai)[0]
            self._limb(idx, [arm["shoulder"], arm["elbow"], arm["wrist"], arm["hand"]])
            self.arm[idx] = True

    def _limb(self, idx, joints):
        if not len(idx):
            return
        side = 1.0 if joints[0][0] >= 0 else -1.0  # which side of the body the limb is on
        X = self.V[idx]
        best = np.full(len(idx), np.inf)
        for s in range(len(joints) - 1):
            A, B = joints[s], joints[s + 1]
            AB = B - A
            L2 = max(float(AB @ AB), 1e-9)
            t = np.clip(((X - A) @ AB) / L2, 0, 1)
            C = A + t[:, None] * AB
            d = np.linalg.norm(X - C, axis=-1)
            take = d < best
            best = np.where(take, d, best)
            self.seg[idx[take]] = s
            self.t[idx[take]] = t[take]
            ax = AB / math.sqrt(L2)
            fwd = np.array([0.0, 0.0, 1.0]) - ax * ax[2]
            fwd /= max(np.linalg.norm(fwd), 1e-9)
            out = np.cross(ax, fwd)
            if out[0] * side < 0:
                out = -out
            R = X[take] - C[take]
            self.phi[idx[take]] = np.arctan2(R @ out, R @ fwd)  # 0 front, +π/2 outer, ±π back
            self.lr[idx[take]] = d[take]


def fbm(V, scale, octaves=4, seed=0.0):
    out = np.empty(len(V))
    off = Vector((seed * 13.1, seed * 7.7, seed * 3.3))
    for i, p in enumerate(V):
        out[i] = noise.fractal(Vector(p) * scale + off, 0.55, 2.0, octaves)
    return out


def cells(V, scale, seed=0.0):
    """Distance to the nearest Voronoi feature point (F1) and F2 − F1."""
    f1 = np.empty(len(V))
    f21 = np.empty(len(V))
    off = Vector((seed * 5.1, seed * 2.9, seed * 8.3))
    for i, p in enumerate(V):
        d, _ = noise.voronoi(Vector(p) * scale + off, distance_metric="DISTANCE", exponent=2.5)
        f1[i] = d[0]
        f21[i] = d[1] - d[0]
    return f1, f21


# --- Sculpt recipes --------------------------------------------------------

def sculpt_body(ref, A, Nrm, rc):
    """Displacement (m, along the normal) for the fused body / limbs."""
    H = ref.H
    n = len(A.V)
    D = np.zeros(n)   # large forms: muscles, ridges (smoothed across the joins)
    Dd = np.zeros(n)  # fine detail: folds, wrinkles, scutes, studs
    body = A.part == 0
    a = A.a
    arcs = ref.arcs
    aH, aC, h0, h1 = arcs["hips"], arcs["chest"], arcs["head0"], arcs["head1"]
    th = A.at
    trunk = body & (a > aH) & (a < aC)
    neck = body & (a >= aC) & (a < h0)
    tail = body & (a <= aH)
    headm = body & (a >= h0)
    quad = rc["kind"] in ("quad", "sauropod")

    # Trunk: ribs under the flank, belly folds (gastralia / loose skin), a dorsal keel.
    span = max(aC - aH, 1e-3)
    u = (a - aH) / span
    ribP = span / (9 if quad else 11)
    wob = fbm(A.V, 1.0 / (0.25 * H), 2, 9.0)  # breaks up anything periodic
    ribs = np.cos(2 * math.pi * ((a - aH) / ribP + 0.15 * (th - 1.2) * A.rr / ribP + 0.4 * wob)) ** 2
    ribmask = trunk * smoothstep(0.2, 0.4, u) * (1 - smoothstep(0.7, 0.92, u)) * gauss(th, 1.3, 0.38)
    Dd += rc["ribs"] * 0.0045 * H * (ribs - 0.5) * ribmask * (0.7 + 0.6 * wob)
    fold = np.sin(2 * math.pi * ((a - aH) / (0.06 * H + 0.04 * span) + 0.5 * wob))
    Dd += rc["belly"] * 0.0022 * H * fold * trunk * smoothstep(2.4, 2.9, th) * smoothstep(0.05, 0.25, u)
    # A soft flank fold along the belly line (where the skin hangs off the ribs).
    D -= rc["belly"] * 0.006 * H * trunk * gauss(th, 2.1, 0.16) * smoothstep(0.15, 0.4, u) * (1 - smoothstep(0.75, 0.95, u))
    # Shoulder / hip muscle masses (quadrupeds carry theirs on the trunk).
    for leg in ref.legs:
        J = leg["hip"]
        d = np.linalg.norm(A.V - (J + np.array([0.0, 0.05 * H, 0.0])), axis=-1)
        D += rc["thigh"] * (0.05 if quad else 0.035) * H * gauss(d, 0.0, 0.33 * H) * body * smoothstep(0.6, 1.4, th) * (np.sign(A.V[:, 0]) == (1.0 if leg["hip"][0] >= 0 else -1.0))

    # Tail: caudofemoralis bulge at the base, a lateral groove (the septum), folds beneath.
    ta = np.clip((aH - a) / max(aH, 1e-3), 0, 1)  # 0 at the hips … 1 at the tip
    D += rc["caudo"] * 0.045 * H * tail * gauss(ta, 0.12, 0.13) * gauss(th, 1.9, 0.55)
    D -= rc["tail"] * 0.010 * H * tail * gauss(th, 1.57, 0.09) * smoothstep(0.02, 0.1, ta) * (1 - smoothstep(0.6, 0.9, ta)) * np.minimum(1, A.rr / (0.12 * H))
    tf = np.sin(2 * math.pi * (aH - a) / (0.045 * H))
    Dd += rc["tail"] * 0.004 * H * tf * tail * smoothstep(2.3, 2.8, th) * (1 - smoothstep(0.3, 0.6, ta))

    # Neck: long muscle bands each side, a throat of loose folds, wrinkles where it meets the body.
    nl = max(h0 - aC, 1e-3)
    nu = (a - aC) / nl
    D += rc["neck"] * 0.18 * A.rr * neck * gauss(th, 1.05, 0.32) * smoothstep(0.0, 0.2, nu) * (1 - smoothstep(0.8, 1.0, nu))
    D -= rc["neck"] * 0.06 * A.rr * neck * gauss(th, 1.65, 0.12) * smoothstep(0.05, 0.25, nu) * (1 - smoothstep(0.75, 0.95, nu))
    nf = np.sin(2 * math.pi * ((a - aC) / (0.05 * H + 0.04 * nl) + 0.5 * wob))
    Dd += rc["neck"] * 0.0016 * H * nf * neck * smoothstep(2.3, 2.8, th) * (0.6 + 0.8 * wob)
    base = np.exp(-((a - aC) / (0.1 * H + 0.08 * nl)) ** 2) * body * (a > aH)
    Dd += rc["folds"] * 0.002 * H * np.sin(2 * math.pi * ((a - aC) / (0.035 * H + 0.02 * nl) + 0.6 * wob)) * base * smoothstep(0.9, 1.4, th) * (0.6 + 0.8 * wob)

    # Dorsal midline: a low row of scutes along the back and tail.
    if rc["scutes"] > 0:
        sc = 0.5 + 0.5 * np.cos(2 * math.pi * a / (0.06 * H))
        Dd += rc["scutes"] * 0.0045 * H * body * (~headm) * gauss(th, 0.0, 0.13) * sc ** 2 * smoothstep(0.03, 0.15, a / arcs["L"])

    # Head (skull landmarks, in the head's frame).
    if headm.any():
        hm, hd = sculpt_head(ref, A, Nrm, rc)
        D += hm * headm
        Dd += hd * headm

    # Limbs.
    leg = (A.part >= 10) & (A.part < 20)
    arm = A.part >= 20
    s, t, ph, lr = A.seg, A.t, A.phi, A.lr
    up = leg & (s == 0)
    lo = leg & (s == 1)
    me = leg & (s == 2)
    ft = leg & (s == 3)
    hindk = 1.0 if not quad else 0.8
    # Thigh: a broad mass on the front-outer face, fading to the knee.
    D += rc["thigh"] * 0.14 * hindk * lr * up * gauss(t, 0.45, 0.28) * smoothstep(0.05, 0.3, t) * (0.55 + 0.45 * np.cos(ph - 0.7))
    # A groove between thigh and calf behind the knee; a knob at the knee's front.
    D -= rc["calf"] * 0.10 * lr * ((up & (t > 0.7)) | (lo & (t < 0.25))) * gauss(np.abs(ph), math.pi, 0.7) * np.where(up, gauss(t, 1.0, 0.15), gauss(t, 0.0, 0.15))
    D += 0.05 * lr * ((up & (t > 0.8)) | (lo & (t < 0.15))) * gauss(ph, 0.0, 0.6)
    # Calf (gastrocnemius) behind the shin.
    D += rc["calf"] * 0.16 * lr * lo * gauss(t, 0.28, 0.2) * gauss(np.abs(ph), math.pi, 0.95)
    # Shin and metatarsus: tendons down the front.
    if not quad:
        Dd += rc["calf"] * 0.07 * lr * (me | (lo & (t > 0.5))) * (gauss(ph, 0.4, 0.18) + gauss(ph, -0.4, 0.18)) * smoothstep(0.0, 0.2, t)
    # Wrinkle rings at the ankle and wrist, deeper on the graviportal legs.
    wob = fbm(A.V, 1.0 / (0.12 * H), 2, 4.0)
    ring = np.sin(2 * math.pi * (A.V[:, 1] / ((0.022 if not quad else 0.03) * H) + 0.8 * wob)) * (0.55 + 0.9 * np.abs(wob))
    ankle = ((lo & (t > 0.75)) | (me & (t < (0.35 if not quad else 0.55)))).astype(np.float64)
    Dd += rc["wrinkles"] * (0.012 if not quad else 0.016) * lr * ring * ankle
    knee = (up & (t > 0.8)) | (lo & (t < 0.2))
    Dd += rc["wrinkles"] * 0.012 * lr * ring * knee * gauss(np.abs(ph), math.pi, 1.2)
    # Toes: knuckle pads.
    Dd += 0.08 * lr * ft * (0.5 + 0.5 * np.cos(2 * math.pi * t * 3)) * gauss(np.abs(ph), math.pi, 1.0)
    # Arms: deltoid at the shoulder, forearm muscle, wrist folds.
    au = arm & (s == 0)
    af = arm & (s == 1)
    D += rc["thigh"] * 0.12 * lr * au * gauss(t, 0.18, 0.25)
    D += rc["calf"] * 0.10 * lr * af * gauss(t, 0.3, 0.25) * gauss(ph, -0.4, 1.0)
    Dd += rc["wrinkles"] * 0.012 * lr * ring * ((af & (t > 0.8)) | (arm & (s == 2) & (t < 0.3)))

    # Osteoderms (Stegosaurus): little bony studs over the flanks and the throat.
    if rc["ossicles"] > 0:
        f1, f21 = cells(A.V, 1.0 / (0.09 * H), seed=3.0)
        stud = (1 - smoothstep(0.1, 0.42, f1)) ** 2
        mask = body * smoothstep(1.6, 1.9, th) * (1 - smoothstep(2.3, 2.6, th)) * trunk + neck * smoothstep(2.2, 2.7, th)
        Dd += rc["ossicles"] * 0.006 * H * stud * np.clip(mask, 0, 1)
    return D, Dd


def sculpt_head(ref, A, Nrm, rc):
    O, Dh, Nh, ln = ref.head["O"], norm(ref.head["D"]), norm(ref.head["N"]), ref.head["len"]
    E, er = ref.eye["center"], ref.eye["r"]
    X = A.V - O
    hf = X @ Dh
    hu = X @ Nh
    hx = np.abs(A.V[:, 0])
    ef, eu, ex = float((E - O) @ Dh), float((E - O) @ Nh), abs(float(E[0]))
    lat = np.abs(Nrm[:, 0])
    k = ln  # landmarks scale with the skull
    if not hasattr(ref, "_logged_head"):
        ref._logged_head = True
        log(f"{ref.id}: head len {ln:.2f}, eye r {er:.3f} at forward {ef:.2f} up {eu:.2f} side {ex:.2f}")
    D = np.zeros(len(A.V))
    Dd = np.zeros(len(A.V))
    # Brow ridge over the eye, ending in a boss behind it.
    brow_u = eu + max(1.2 * er, 0.045 * k)
    D += rc["brow"] * 0.05 * k * gauss(hf, ef + 0.02 * k, 0.09 * k) * gauss(hu, brow_u, 0.03 * k) * smoothstep(0.3 * ex, 0.7 * ex, hx)
    D += rc["brow"] * 0.045 * k * gauss(hf, ef - 0.05 * k, 0.045 * k) * gauss(hu, brow_u + 0.01 * k, 0.035 * k) * smoothstep(0.3 * ex, 0.7 * ex, hx)
    # Cheek (jugal) ridge under the eye, running forward.
    D += rc["cheek"] * 0.03 * k * gauss(hu, eu - max(1.4 * er, 0.06 * k), 0.025 * k) * gauss(hf, ef + 0.03 * k, 0.14 * k) * lat
    # Jaw muscles bulging behind the eye.
    D += rc["temple"] * 0.05 * k * gauss(hf, ef - 0.13 * k, 0.08 * k) * gauss(hu, eu - 0.01 * k, 0.07 * k) * lat
    # The antorbital opening: a shallow, skin-covered hollow ahead of the eye.
    D -= rc["fenestra"] * 0.035 * k * gauss(hf, ef + 0.2 * k, 0.09 * k) * gauss(hu, eu - 0.02 * k, 0.04 * k) * smoothstep(0.4, 0.8, lat)
    # Eye socket rim: a crease round the eye.
    de = np.linalg.norm(np.stack([hx - ex, hu - eu, hf - ef], -1), axis=-1)
    Dd -= 0.3 * er * gauss(de, 1.4 * er, 0.3 * er)
    # Nasal rugosity: knobbly bone along the top of the snout.
    if rc["nasal"] > 0:
        top = smoothstep(0.45, 0.85, Nrm @ Nh)
        f1, _ = cells(A.V, 1.0 / (0.065 * k), seed=7.0)
        Dd += rc["nasal"] * 0.011 * k * top * (1 - smoothstep(0.15, 0.55, f1)) * smoothstep(ef + 0.08 * k, ef + 0.18 * k, hf) * (1 - smoothstep(0.85 * k, 0.97 * k, hf))
    # Lip: a firm edge along the mouth, with a row of lip scales.
    lip = gauss(hu, 0.03 * k, 0.018 * k) * lat * smoothstep(0.1 * k, 0.3 * k, hf)
    Dd += 0.006 * k * lip * (0.6 + 0.4 * np.sin(hf / (0.012 * k)))
    return D, Dd


def sculpt_jaw(ref, V, Nrm, rc):
    H = ref.H
    O, Dh, Nh = ref.head["O"], norm(ref.head["D"]), norm(ref.head["N"])
    er = ref.eye["r"]
    X = V - O
    hf = X @ Dh
    under = smoothstep(0.3, 0.8, -(Nrm @ Nh))
    lat = np.abs(Nrm[:, 0])
    D = np.zeros(len(V))
    # Throat folds under the lower jaw, and the jaw muscle at its back.
    D += rc["neck"] * 0.0015 * H * np.sin(2 * math.pi * hf / (0.03 * H + 0.4 * er)) * under * smoothstep(-0.2 * ref.head["len"], 0.1 * ref.head["len"], -hf + 0.5 * ref.head["len"])
    ln = ref.head["len"]
    hu = X @ Nh
    D += rc["temple"] * 0.02 * ln * gauss(hf, 0.1 * ln, 0.1 * ln) * lat
    D += 0.005 * ln * gauss(hu, float(np.percentile(hu, 92)), 0.02 * ln) * lat * (0.6 + 0.4 * np.sin(hf / (0.012 * ln)))
    return D


def skin_noise(ref, V, rc, seed):
    """Fine, irregular folds over everything (baked to the normal map)."""
    H = ref.H
    big = fbm(V, 1.0 / (0.09 * H), 4, seed)
    fine = fbm(V, 1.0 / (0.025 * H), 3, seed + 11)
    return rc["folds"] * (0.0017 * H * big + 0.0007 * H * fine)


# --- Building one species --------------------------------------------------

def bvh_for(P, F):
    return BVHTree.FromPolygons([tuple(map(float, p)) for p in P], [tuple(map(int, f)) for f in F], all_triangles=True)


def nearest_on(bvh, P, F, X):
    """Nearest reference triangle for each point: (triangle index, barycentric weights)."""
    n = len(X)
    tri = np.zeros(n, dtype=np.int64)
    bary = np.zeros((n, 3))
    loc = np.zeros((n, 3))
    for i, x in enumerate(X):
        hit = bvh.find_nearest(Vector(x))
        if hit[0] is None:
            continue
        loc[i] = hit[0]
        tri[i] = hit[2]
    A = P[F[tri, 0]]
    B = P[F[tri, 1]]
    C = P[F[tri, 2]]
    v0, v1, v2 = B - A, C - A, loc - A
    d00 = (v0 * v0).sum(-1)
    d01 = (v0 * v1).sum(-1)
    d11 = (v1 * v1).sum(-1)
    d20 = (v2 * v0).sum(-1)
    d21 = (v2 * v1).sum(-1)
    den = np.where(np.abs(d00 * d11 - d01 * d01) < 1e-20, 1e-20, d00 * d11 - d01 * d01)
    v = (d11 * d20 - d01 * d21) / den
    w = (d00 * d21 - d01 * d20) / den
    bary = np.clip(np.stack([1 - v - w, v, w], -1), 0, 1)
    bary /= np.maximum(bary.sum(-1, keepdims=True), 1e-9)
    return tri, bary, loc


def interp(L, F, tri, bary, key):
    vals = L[key]
    return (vals[F[tri]] * bary[:, :, None]).sum(1)


class Species:
    def __init__(self, ref, args):
        self.ref = ref
        self.args = args
        self.rc = RECIPES[ref.id]
        H = ref.H
        self.vs = float(np.clip(H * (0.0075 if args.quick else 0.0058), 0.005, 0.032))
        self.L0, self.L1 = ref.lods

    # 1–3: the high-res sculpt -------------------------------------------------
    def build_high(self):
        ref, L0 = self.ref, self.L0
        t0 = time.time()
        soft = L0["grp"] == SOFT
        V, F, used = submesh(L0, soft)
        # The reference's limb tubes stick out of the body where they enter it;
        # sink their first stretch toward the bone so the union has no lip.
        vpart = np.full(len(L0["P"]), -1)
        for p in L0["parts"]:
            if p["name"].startswith("leg"):
                vpart[p["v0"]:p["v1"]] = 10 + int(p["name"][3:])
            elif p["name"].startswith("arm"):
                vpart[p["v0"]:p["v1"]] = 20 + int(p["name"][3:])
        A0 = Anatomy(ref, V, vpart[used])
        body0 = A0.part == 0
        limbs = {10 + i: (l["hip"], l["knee"]) for i, l in enumerate(ref.legs)}
        limbs.update({20 + i: (a["shoulder"], a["elbow"]) for i, a in enumerate(ref.arms)})
        for pid, (J0, J1) in limbs.items():
            m = A0.part == pid
            top = m & (A0.seg == 0) & (A0.t < 0.5)
            if not top.any():
                continue
            side = 1.0 if J0[0] >= 0 else -1.0
            ax = (J1 - J0) / max(np.linalg.norm(J1 - J0), 1e-9)
            along = (V - J0) @ ax
            # The reference caps each limb with a dome above the joint that
            # stands out of the body's side: shrink it onto the joint, and
            # draw the limb's first stretch in toward its bone.
            dome = m & (along < 0)
            inside = J0 * np.array([0.55, 1.0, 1.0])  # the joint can sit on the body's skin; aim inside it
            V[dome] = inside + (V[dome] - J0) * 0.35
            near = top & (along >= 0)
            C = J0 + along[near, None] * ax
            k = 0.72 + 0.28 * smoothstep(0.0, 0.35, A0.t[near])
            V[near] = C + (V[near] - C) * k[:, None]
            # Hip / shoulder muscle: swell the body's flank over what still
            # stands out, so the limb comes out of the body, not a socket.
            xl = float((V[top, 0] * side).max())
            yc, zc = float(V[top, 1].mean()), float(V[top, 2].mean())
            Ry = max(float(np.ptp(V[top, 1])) * 0.8, 0.1 * ref.H)
            Rz = max(float(np.ptp(V[top, 2])) * 0.75, 0.1 * ref.H)
            f = np.exp(-(((V[:, 1] - yc) / Ry) ** 2 + ((V[:, 2] - zc) / Rz) ** 2))
            lat = smoothstep(0.15, 0.7, A0.at) * (1 - smoothstep(2.35, 2.8, A0.at))
            want = xl + 0.015 * ref.H
            gap = np.maximum(0.0, want - V[:, 0] * side)
            sel = body0 & (V[:, 0] * side > 0)
            V[sel, 0] += side * (gap * f * lat)[sel]
        ob = mesh_obj("soft_hi", V, F)
        close_holes(ob)
        apply_modifier(ob, "REMESH", mode="VOXEL", voxel_size=self.vs, adaptivity=0.0, use_smooth_shade=True)
        me = ob.data
        X = verts_of(me)
        E = edges_of(me)
        # Fillets: fill the creases where legs and arms run into the body,
        # then a light relax of the voxel steps everywhere.
        w = np.zeros(len(X))
        for leg in ref.legs:
            d = np.linalg.norm(X - leg["hip"], axis=-1)
            w = np.maximum(w, np.exp(-((d / (0.5 * ref.H)) ** 2)))
        for arm in ref.arms:
            d = np.linalg.norm(X - arm["shoulder"], axis=-1)
            w = np.maximum(w, np.exp(-((d / (0.2 * ref.H)) ** 2)))
        X = fillet(X, E, normals_of(me), w, 60)
        X = laplacian(X, E, 0.5 * w, 10)  # round off the shelf where a limb's top meets the flank
        X = laplacian(X, E, np.full(len(X), 0.3), 2)
        set_verts(me, X)
        log(f"{ref.id}: fused volume {len(X)} verts (voxel {self.vs * 100:.2f} cm) in {time.time() - t0:.1f}s")
        # Which reference part each high-res vertex belongs to.
        Pm, Fm = L0["P"], L0["I"][soft]
        partm = L0["part"][soft]
        bvh = bvh_for(Pm, Fm)
        tri, _, _ = nearest_on(bvh, Pm, Fm, X)
        part = partm[tri]
        Nrm = normals_of(me)
        A = Anatomy(ref, X, part)
        Dm, Dd = sculpt_body(ref, A, Nrm, self.rc)
        # Large forms blend across the joins (body and limb terms meet there);
        # fine detail keeps its edge.
        Dm = smooth_field(Dm[:, None], E, 30, 0.5)[:, 0]
        Dd = smooth_field(Dd[:, None], E, 2, 0.5)[:, 0]
        Dsp = Dm + Dd + skin_noise(ref, X, self.rc, 1.0)
        set_verts(me, X + Nrm * Dsp[:, None])
        self.soft_hi = ob
        log(f"{ref.id}: sculpted in {time.time() - t0:.1f}s, displacement {Dsp.min() * 100:.1f}…{Dsp.max() * 100:.1f} cm")

        # Jaw: its own closed volume, sculpted.
        V, F, _ = submesh(L0, L0["grp"] == JAW)
        jo = mesh_obj("jaw_hi", V, F)
        close_holes(jo)
        apply_modifier(jo, "REMESH", mode="VOXEL", voxel_size=self.vs * 0.7, adaptivity=0.0, use_smooth_shade=True)
        J = verts_of(jo.data)
        JE = edges_of(jo.data)
        J = laplacian(J, JE, np.full(len(J), 0.4), 2)
        set_verts(jo.data, J)
        JN = normals_of(jo.data)
        Dj = sculpt_jaw(ref, J, JN, self.rc) + skin_noise(ref, J, self.rc, 2.0) * 0.7
        set_verts(jo.data, J + JN * Dj[:, None])
        self.jaw_hi = jo

        # Features (plates, horns, spikes): the reference's own shape, finely
        # subdivided and given a grain (vascular grooves, keratin) for the bake.
        self.feat_hi = None
        if (L0["grp"] == FEAT).any():
            V, F, _ = submesh(L0, L0["grp"] == FEAT)
            fo = mesh_obj("feat_hi", V, F)
            apply_modifier(fo, "SUBSURF", subdivision_type="SIMPLE", levels=3, render_levels=3)
            Fx = verts_of(fo.data)
            FN = normals_of(fo.data)
            g = fbm(Fx * np.array([1.0, 0.25, 1.0]), 1.0 / (0.025 * ref.H), 3, 5.0)
            ridge = np.abs(np.sin(Fx[:, 1] / (0.012 * ref.H) + 6 * g))
            set_verts(fo.data, Fx + FN * ((0.0015 * ref.H) * (g - 0.6 * ridge))[:, None])
            self.feat_hi = fo

    # 4: game meshes -----------------------------------------------------------
    def piece(self, name, V, F, grp):
        ob = mesh_obj(name, V, F)
        a = ob.data.attributes.new("grp", "INT", "POINT")
        a.data.foreach_set("value", np.full(len(V), grp, dtype=np.int32))
        return ob

    def decimated(self, src, name, tris, grp):
        ob = src.copy()
        ob.data = src.data.copy()
        ob.name = name
        link(ob)
        n0 = len(tris_of(ob.data))
        apply_modifier(ob, "DECIMATE", decimate_type="COLLAPSE", ratio=min(1.0, tris / max(n0, 1)), use_symmetry=True, symmetry_axis="X", use_collapse_triangulate=True)
        apply_modifier(ob, "TRIANGULATE")
        a = ob.data.attributes.new("grp", "INT", "POINT")
        a.data.foreach_set("value", np.full(len(ob.data.vertices), grp, dtype=np.int32))
        return ob

    def build_game(self):
        L0, L1 = self.L0, self.L1
        ntri = lambda L, g: int((L["grp"] == g).sum())
        budget_soft = int(ntri(L0, SOFT) * 1.15)
        pieces = [self.decimated(self.soft_hi, "soft0", budget_soft, SOFT), self.decimated(self.jaw_hi, "jaw0", int(ntri(L0, JAW) * 1.3), JAW)]
        for g, nm in ((EYES, "eyes0"), (TEETH, "teeth0"), (CLAWS, "claws0"), (FEAT, "feat0")):
            if (L0["grp"] == g).any():
                V, F, _ = submesh(L0, L0["grp"] == g)
                pieces.append(self.piece(nm, V, F, g))
        lod0 = join(pieces, "lod0")
        self.lod0 = lod0
        log(f"{self.ref.id}: LOD0 {len(tris_of(lod0.data))} tris (reference {len(L0['I'])})")

    def build_lod1(self):
        L0, L1 = self.L0, self.L1
        src = self.lod0
        ob = src.copy()
        ob.data = src.data.copy()
        ob.name = "lod1_body"
        link(ob)
        # Keep only soft, jaw and features; eyes and claws come from the reference's LOD1.
        bm = bmesh.new()
        bm.from_mesh(ob.data)
        gl = bm.verts.layers.int.get("grp")
        bmesh.ops.delete(bm, geom=[v for v in bm.verts if v[gl] in (EYES, TEETH, CLAWS)], context="VERTS")
        bm.to_mesh(ob.data)
        bm.free()
        want = int(((L1["grp"] == SOFT) | (L1["grp"] == JAW) | (L1["grp"] == FEAT)).sum() * 1.15)
        have = len(tris_of(ob.data))
        apply_modifier(ob, "DECIMATE", decimate_type="COLLAPSE", ratio=min(1.0, want / max(have, 1)), use_symmetry=True, symmetry_axis="X", use_collapse_triangulate=True)
        apply_modifier(ob, "TRIANGULATE")
        pieces = [ob]
        for g, nm in ((EYES, "eyes1"), (CLAWS, "claws1")):
            if (L1["grp"] == g).any():
                V, F, _ = submesh(L1, L1["grp"] == g)
                p = self.piece(nm, V, F, g)
                # UVs: borrow the nearest LOD0 vertex's of the same group (flat in the normal map).
                p.data.uv_layers.new(name="UVMap")
                uv_from_nearest(p, self.lod0, g)
                pieces.append(p)
        self.lod1 = join(pieces, "lod1")
        log(f"{self.ref.id}: LOD1 {len(tris_of(self.lod1.data))} tris (reference {len(L1['I'])})")

    # 5: UVs and bakes -------------------------------------------------------------
    def unwrap_and_bake(self, size):
        lod0 = self.lod0
        select_only(lod0)
        bpy.ops.object.mode_set(mode="EDIT")
        bpy.ops.mesh.select_all(action="SELECT")
        bpy.ops.uv.smart_project(angle_limit=math.radians(62), island_margin=0.004, area_weight=0.0, correct_aspect=True, scale_to_bounds=False)
        bpy.ops.object.mode_set(mode="OBJECT")
        lod0.data.shade_smooth()

        img = bpy.data.images.new(self.ref.id + "_normal", size, size, alpha=False, float_buffer=False)
        img.colorspace_settings.name = "Non-Color"
        mat = bpy.data.materials.new("skin")
        if not mat.node_tree:
            mat.use_nodes = True
        nt = mat.node_tree
        bsdf = nt.nodes.get("Principled BSDF")
        tex = nt.nodes.new("ShaderNodeTexImage")
        tex.image = img
        nmap = nt.nodes.new("ShaderNodeNormalMap")
        nt.links.new(tex.outputs["Color"], nmap.inputs["Color"])
        nt.links.new(nmap.outputs["Normal"], bsdf.inputs["Normal"])
        nt.nodes.active = tex
        lod0.data.materials.append(mat)
        self.mat, self.img = mat, img

        # The high-res stand-ins for the bake: the sculpts, and copies of the hard parts.
        his = [self.soft_hi, self.jaw_hi]
        if self.feat_hi:
            his.append(self.feat_hi)
        L0 = self.L0
        for g in (EYES, TEETH, CLAWS):
            if (L0["grp"] == g).any():
                V, F, _ = submesh(L0, L0["grp"] == g)
                his.append(mesh_obj(f"hard_hi_{g}", V, F))
        for h in his:
            h.data.shade_smooth()
        sc = bpy.context.scene
        sc.render.engine = "CYCLES"
        sc.cycles.device = "CPU"
        sc.cycles.samples = 1
        sc.render.bake.margin = 6
        select_only(*his, lod0, active=lod0)
        t0 = time.time()
        bpy.ops.object.bake(type="NORMAL", normal_space="TANGENT", use_selected_to_active=True, cage_extrusion=self.vs * 5.0, max_ray_distance=self.vs * 14.0, target="IMAGE_TEXTURES", margin=6)
        log(f"{self.ref.id}: normal map {size}² baked in {time.time() - t0:.1f}s")

        # Ambient occlusion into the vertices (ray cast here: a Cycles vertex
        # bake speckles a decimated surface black where its rays start inside it).
        t0 = time.time()
        self.ao0 = vertex_ao(lod0.data, 0.35 * self.ref.H, max(0.01, 1.5 * self.vs))
        log(f"{self.ref.id}: AO cast in {time.time() - t0:.1f}s (median {np.median(self.ao0):.2f}, 5th pct {np.percentile(self.ao0, 5):.2f})")
        for h in his[3 if self.feat_hi else 2:]:
            bpy.data.objects.remove(h)

    # 6: surface masks, AO and skin weights --------------------------------------
    def skin(self, ob, ao):
        ref, L0 = self.ref, self.L0
        me = ob.data
        X = verts_of(me)
        n = len(X)
        grp = np.empty(n, dtype=np.int32)
        me.attributes["grp"].data.foreach_get("value", grp)
        col = np.zeros((n, 3))
        sk = np.zeros((n, 4))
        sf = np.zeros((n, 2))
        Wd = np.zeros((n, len(ref.bones)))
        for g in (SOFT, JAW, EYES, TEETH, CLAWS, FEAT):
            idx = np.nonzero(grp == g)[0]
            if not len(idx):
                continue
            src = L0["grp"] == g
            if not src.any():
                src = np.ones(len(L0["I"]), dtype=bool)
            F = L0["I"][src]
            bvh = bvh_for(L0["P"], F)
            tri, bary, _ = nearest_on(bvh, L0["P"], F, X[idx])
            col[idx] = interp(L0, F, tri, bary, "col")
            sk[idx] = interp(L0, F, tri, bary, "skin")
            sf[idx] = interp(L0, F, tri, bary, "surf")
            Wd[idx] = interp(L0, F, tri, bary, "Wd")
        # Blend the weights across the fused joins.
        E = edges_of(me)
        softmask = (grp == SOFT).astype(np.float64)
        Es = E[(grp[E[:, 0]] == SOFT) & (grp[E[:, 1]] == SOFT)]
        Wd = smooth_field(Wd, Es, 6, 0.5, softmask)
        # Strongest four, renormalised.
        order = np.argsort(-Wd, axis=1)[:, :4]
        Wt = np.take_along_axis(Wd, order, 1)
        Wt = np.where(Wt > 1e-4, Wt, 0)
        Wt /= np.maximum(Wt.sum(1, keepdims=True), 1e-9)
        # Attributes.
        c = me.color_attributes.new("Col", "FLOAT_COLOR", "POINT")
        c.data.foreach_set("color", np.hstack([col, np.ones((n, 1))]).ravel())
        me.color_attributes.active_color = c
        s = me.attributes.new("_SKIN", "FLOAT_COLOR", "POINT")
        s.data.foreach_set("color", np.clip(sk, 0, 1).ravel())
        u = me.attributes.new("_SURF", "FLOAT_VECTOR", "POINT")
        u.data.foreach_set("vector", np.hstack([sf, ao[:, None]]).ravel())
        # Vertex groups, one per bone.
        groups = [ob.vertex_groups.new(name=b) for b in ref.bone_names]
        for k in range(4):
            for b in np.unique(order[:, k]):
                sel = np.nonzero((order[:, k] == b) & (Wt[:, k] > 0))[0]
                for v_i, w_i in zip(sel.tolist(), Wt[sel, k].tolist()):
                    groups[b].add([v_i], w_i, "REPLACE")
        me.attributes.remove(me.attributes["grp"])

    def ao_for_lod1(self):
        X0 = verts_of(self.lod0.data)
        X1 = verts_of(self.lod1.data)
        from mathutils.kdtree import KDTree
        kd = KDTree(len(X0))
        for i, x in enumerate(X0):
            kd.insert(Vector(x), i)
        kd.balance()
        out = np.empty(len(X1))
        for i, x in enumerate(X1):
            pts = kd.find_n(Vector(x), 3)
            w = np.array([1 / max(p[2], 1e-4) for p in pts])
            out[i] = (w * np.array([self.ao0[p[1]] for p in pts])).sum() / w.sum()
        return out

    def feathers(self):
        f = self.ref.feathers
        if f is None:
            return None
        # Ride the sculpt: each card moves with the surface under its root.
        L0 = self.L0
        soft = L0["grp"] == SOFT
        P, Fm = L0["P"], L0["I"][soft]
        bvh_ref = bvh_for(P, Fm)
        X1 = verts_of(self.lod0.data)
        grp = None
        T1 = tris_of(self.lod0.data)
        bvh_new = BVHTree.FromPolygons([tuple(x) for x in X1], [tuple(map(int, t)) for t in T1], all_triangles=True)
        Pf = f["P"].copy()
        for i, x in enumerate(Pf):
            a = bvh_ref.find_nearest(Vector(x))[0]
            b = bvh_new.find_nearest(Vector(x))[0]
            if a is not None and b is not None:
                Pf[i] = x + (np.array(b) - np.array(a))
        ob = mesh_obj("feathers", Pf, f["I"])
        me = ob.data
        uv = me.uv_layers.new(name="UVMap")
        loops = np.empty(len(me.loops), dtype=np.int64)
        me.loops.foreach_get("vertex_index", loops)
        # glTF writes V flipped; store the reference's uv so the game reads it back unchanged.
        uv.data.foreach_set("uv", f["uv"][loops].ravel())
        me.normals_split_custom_set_from_vertices([tuple(nv) for nv in f["N"]])
        n = len(Pf)
        c = me.color_attributes.new("Col", "FLOAT_COLOR", "POINT")
        c.data.foreach_set("color", np.hstack([f["col"], np.ones((n, 1))]).ravel())
        me.color_attributes.active_color = c
        s = me.attributes.new("_SKIN", "FLOAT_COLOR", "POINT")
        s.data.foreach_set("color", f["skin"].ravel())
        u = me.attributes.new("_SURF", "FLOAT_VECTOR", "POINT")
        u.data.foreach_set("vector", np.hstack([f["surf"], np.ones((n, 1))]).ravel())
        groups = [ob.vertex_groups.new(name=b) for b in self.ref.bone_names]
        for i in range(n):
            for k in range(4):
                if f["W"][i, k] > 0:
                    groups[int(f["J"][i, k])].add([i], float(f["W"][i, k]), "REPLACE")
        mat = bpy.data.materials.new("feathers")
        me.materials.append(mat)
        return ob

    # 7: rig and export -----------------------------------------------------------
    def rig(self, obs):
        ref = self.ref
        arm = bpy.data.armatures.new("rig")
        ao = link(bpy.data.objects.new(ref.id, arm))
        select_only(ao)
        bpy.ops.object.mode_set(mode="EDIT")
        eb = []
        kids = {i: [] for i in range(len(ref.bones))}
        for i, b in enumerate(ref.bones):
            if b["parent"] >= 0:
                kids[b["parent"]].append(i)
        for i, b in enumerate(ref.bones):
            e = arm.edit_bones.new(b["name"])
            head = np.array(b["pos"])
            tail = None
            if kids[i]:
                c = np.mean([ref.bones[k]["pos"] for k in kids[i]], axis=0)
                if np.linalg.norm(c - head) > 1e-3:
                    tail = c
            if tail is None:
                tail = head + np.array([0.0, 0.0, 0.08 * ref.H])
            e.head = Vector(head)
            e.tail = Vector(tail)
            e.use_deform = True
            eb.append(e)
        for i, b in enumerate(ref.bones):
            if b["parent"] >= 0:
                eb[i].parent = eb[b["parent"]]
        bpy.ops.object.mode_set(mode="OBJECT")
        for ob in obs:
            ob.parent = ao
            m = ob.modifiers.new("Armature", "ARMATURE")
            m.object = ao
        return ao

    def export(self, path, rig, obs):
        select_only(rig, *obs, active=rig)
        bpy.ops.export_scene.gltf(
            filepath=path, export_format="GLB", use_selection=True, export_yup=False, export_apply=False,
            export_attributes=True, export_vertex_color="NAME", export_vertex_color_name="Col", export_all_vertex_colors=False,
            export_normals=True, export_tangents=True, export_texcoords=True, export_materials="EXPORT",
            export_image_format="WEBP", export_image_quality=92, export_skins=True, export_influence_nb=4,
            export_animations=False, export_morph=False, export_extras=False, export_cameras=False, export_lights=False)


def join(pieces, name):
    select_only(*pieces, active=pieces[0])
    bpy.ops.object.join()
    ob = bpy.context.view_layer.objects.active
    ob.name = name
    ob.data.name = name
    return ob


def vertex_ao(me, dist, eps, rays=40, seed=7):
    """Ambient occlusion per vertex: cosine-weighted rays from just off the
    surface, an occluder's weight falling off with distance, then smoothed."""
    X = verts_of(me)
    N = normals_of(me)
    T = tris_of(me)
    bvh = BVHTree.FromPolygons([tuple(map(float, x)) for x in X], [tuple(map(int, t)) for t in T], all_triangles=True)
    rng = np.random.default_rng(seed)
    u1, u2 = rng.random(rays), rng.random(rays)
    r = np.sqrt(u1)
    local = np.stack([r * np.cos(2 * math.pi * u2), r * np.sin(2 * math.pi * u2), np.sqrt(1 - u1)], -1)
    ao = np.empty(len(X))
    for i in range(len(X)):
        n = N[i]
        a = np.array([1.0, 0.0, 0.0]) if abs(n[0]) < 0.9 else np.array([0.0, 1.0, 0.0])
        t = np.cross(n, a)
        t /= max(np.linalg.norm(t), 1e-9)
        b = np.cross(n, t)
        o = Vector(X[i] + n * eps)
        occ = 0.0
        for d in local[:, 0, None] * t + local[:, 1, None] * b + local[:, 2, None] * n:
            hit = bvh.ray_cast(o, Vector(d), dist)
            if hit[0] is not None:
                occ += 1.0 - 0.6 * (hit[3] / dist)
        ao[i] = 1.0 - occ / rays
    E = edges_of(me)
    return np.clip(smooth_field(ao[:, None], E, 3, 0.5)[:, 0], 0.0, 1.0)


def uv_from_nearest(dst, src, g):
    sme = src.data
    sgrp = np.empty(len(sme.vertices), dtype=np.int32)
    sme.attributes["grp"].data.foreach_get("value", sgrp)
    loops = np.empty(len(sme.loops), dtype=np.int64)
    sme.loops.foreach_get("vertex_index", loops)
    suv = np.empty(len(sme.loops) * 2)
    sme.uv_layers.active.data.foreach_get("uv", suv)
    suv = suv.reshape(-1, 2)
    Xs = verts_of(sme)
    cand = np.nonzero(sgrp[loops] == g)[0]
    if not len(cand):
        cand = np.arange(len(loops))
    P = Xs[loops[cand]]
    dme = dst.data
    dl = np.empty(len(dme.loops), dtype=np.int64)
    dme.loops.foreach_get("vertex_index", dl)
    Xd = verts_of(dme)[dl]
    out = np.empty((len(dl), 2))
    for i0 in range(0, len(dl), 4000):
        d2 = ((Xd[i0:i0 + 4000, None, :] - P[None, :, :]) ** 2).sum(-1)
        out[i0:i0 + 4000] = suv[cand[d2.argmin(1)]]
    dme.uv_layers.active.data.foreach_set("uv", out.ravel())


def look_at(cam, eye, target):
    """Aim a camera at target with +Y up (the game's up)."""
    f = norm(np.array(target, dtype=np.float64) - eye)
    r = norm(np.cross(f, [0.0, 1.0, 0.0]))
    u = np.cross(r, f)
    from mathutils import Matrix
    m = Matrix(((r[0], u[0], -f[0]), (r[1], u[1], -f[1]), (r[2], u[2], -f[2])))
    cam.location = Vector(eye)
    cam.rotation_euler = m.to_euler()


def preview(sp, path, size=(1000, 600)):
    """Cycles renders for review: the sculpt, and LOD0 with its normal map, in clay."""
    sc = bpy.context.scene
    ref = sp.ref
    clay = bpy.data.materials.new("clay")
    if not clay.node_tree:
        clay.use_nodes = True
    nt = clay.node_tree
    bsdf = nt.nodes.get("Principled BSDF")
    bsdf.inputs["Base Color"].default_value = (0.42, 0.38, 0.33, 1)
    bsdf.inputs["Roughness"].default_value = 0.7
    clayN = clay.copy()
    nt = clayN.node_tree
    bsdf = nt.nodes.get("Principled BSDF")
    tex = nt.nodes.new("ShaderNodeTexImage")
    tex.image = sp.img
    nmap = nt.nodes.new("ShaderNodeNormalMap")
    nt.links.new(tex.outputs["Color"], nmap.inputs["Color"])
    nt.links.new(nmap.outputs["Normal"], bsdf.inputs["Normal"])
    cam = link(bpy.data.objects.new("cam", bpy.data.cameras.new("cam")))
    cam.data.lens = 50
    sc.camera = cam
    sun = link(bpy.data.objects.new("sun", bpy.data.lights.new("sun", "SUN")))
    sun.data.energy = 3.5
    sun.data.angle = 0.2
    look_at(sun, np.array([3.0, 6.0, 4.0]), [0, 0, 0])
    sc.world.color = (0.3, 0.32, 0.36)
    sc.render.resolution_x, sc.render.resolution_y = size
    sc.cycles.samples = 24
    L = ref.length
    c = np.array(ref.r["bound"]["center"])
    views = {"side": c + np.array([1.05 * L, 0.18 * L, 0.25 * L]), "head": None}
    hd = ref.head["O"] + norm(ref.head["D"]) * ref.head["len"] * 0.5
    views["head"] = hd + np.array([1.9, 0.45, 0.5]) * ref.head["len"] * 1.3
    shows = [("hi", [sp.soft_hi, sp.jaw_hi] + ([sp.feat_hi] if sp.feat_hi else []), clay), ("lod0", [sp.lod0], clayN)]
    all_obs = [sp.soft_hi, sp.jaw_hi, sp.lod0] + ([sp.feat_hi] if sp.feat_hi else [])
    keep = {o.name: list(o.data.materials) for o in all_obs}
    for tag, obs, mat in shows:
        for o in all_obs:
            o.hide_render = o not in obs
        for o in obs:
            o.data.materials.clear()
            o.data.materials.append(mat)
        for vname, eye in views.items():
            target = hd if vname == "head" else c
            look_at(cam, eye, target)
            sc.render.filepath = path.replace(".png", f"_{tag}_{vname}.png")
            bpy.ops.render.render(write_still=True)
    for o in all_obs:
        o.hide_render = False
        o.data.materials.clear()
        for m in keep[o.name]:
            o.data.materials.append(m)
    sp.img.filepath_raw = path.replace(".png", "_normal.png")
    sp.img.file_format = "PNG"
    sp.img.save()
    for o in (cam, sun):
        bpy.data.objects.remove(o)


def build(ref_path, args):
    bpy.ops.wm.read_factory_settings(use_empty=True)
    ref = Ref(ref_path)
    t0 = time.time()
    sp = Species(ref, args)
    sp.build_high()
    sp.build_game()
    sp.unwrap_and_bake(args.tex)
    if args.preview:
        os.makedirs(args.preview, exist_ok=True)
        preview(sp, os.path.join(args.preview, ref.id + ".png"))
    sp.build_lod1()
    ao1 = sp.ao_for_lod1()
    sp.skin(sp.lod0, sp.ao0)
    sp.skin(sp.lod1, ao1)
    sp.lod1.data.materials.clear()
    sp.lod1.data.materials.append(sp.mat)
    sp.lod1.data.shade_smooth()
    obs = [sp.lod0, sp.lod1]
    fe = sp.feathers()
    if fe:
        obs.append(fe)
    for h in (sp.soft_hi, sp.jaw_hi, sp.feat_hi):
        if h:
            bpy.data.objects.remove(h)
    rig = sp.rig(obs)
    os.makedirs(args.out, exist_ok=True)
    out = os.path.join(args.out, ref.id + ".glb")
    sp.export(out, rig, obs)
    log(f"{ref.id}: wrote {out} ({os.path.getsize(out) / 1024:.0f} KB) in {time.time() - t0:.0f}s")


def main():
    argv = sys.argv[sys.argv.index("--") + 1:] if "--" in sys.argv else sys.argv[1:]
    ap = argparse.ArgumentParser()
    ap.add_argument("--ref", required=True)
    ap.add_argument("--out", required=True)
    ap.add_argument("--ids", nargs="*")
    ap.add_argument("--preview")
    ap.add_argument("--tex", type=int, default=1024)
    ap.add_argument("--quick", action="store_true")
    args = ap.parse_args(argv)
    ids = args.ids or sorted(f[:-5] for f in os.listdir(args.ref) if f.endswith(".json"))
    for id_ in ids:
        build(os.path.join(args.ref, id_ + ".json"), args)


if __name__ == "__main__":
    main()
