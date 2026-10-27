"""
Transfer facial shape keys (ARKit 52 + Oculus visemes) from one Ready Player Me-style avatar
onto another whose face has none, even when the faces have different proportions.

Run inside Blender with both avatars imported (File > Import > glTF):

    blender --python tools/blender/transfer_shapes.py -- \
        --target Wolf3D_Avatar --target-armature Armature \
        --source-head Wolf3D_Head --source-teeth Wolf3D_Teeth --source-armature Armature.001

or paste into Blender's Text Editor and edit CONFIG below. The target may be a single merged
mesh (as Ready Player Me exports for PowerPoint/Office); its eyes and teeth only need to be
separate loose parts.

How it works:
1. Landmarks (eye poles and corners, nose tip, mouth seam and corners, chin, head bones) are found
   on both faces.
2. A thin-plate-spline warp fitted to those landmarks bends the source head, and every one of its
   shape keys, onto the target face.
3. Each target vertex takes the shape offsets of the nearest point on the warped source surface.
   Around the mouth, upper-lip vertices may only sample the source's upper lip and lower-lip
   vertices its lower lip, otherwise the jaw drags the upper lip with it.
4. Teeth move rigidly with whichever source tooth part they match.
"""

import sys

import bmesh
import bpy
import numpy as np
from mathutils import Vector
from mathutils.bvhtree import BVHTree
from mathutils.kdtree import KDTree

CONFIG = {
    "target": "Wolf3D_Avatar",
    "target_armature": "Armature",
    "source_head": "Wolf3D_Head",
    "source_teeth": "Wolf3D_Teeth",
    "source_armature": "Armature.001",
    # Offsets fade out for target vertices this far (m) from the warped source surface.
    "near": 0.004,
    "far": 0.015,
}


# --- Mesh helpers ------------------------------------------------------------------------------


def world_coords(obj, key=None):
    n = len(obj.data.vertices)
    a = np.empty(n * 3)
    (key.data if key else obj.data.vertices).foreach_get("co", a)
    mw = np.array(obj.matrix_world)
    return a.reshape(-1, 3) @ mw[:3, :3].T + mw[:3, 3]


def topology(obj):
    """Loose parts, boundary-vertex mask and adjacency lists."""
    bm = bmesh.new()
    bm.from_mesh(obj.data)
    bm.verts.ensure_lookup_table()
    adj = [[e.other_vert(v).index for e in v.link_edges] for v in bm.verts]
    boundary = np.array([any(e.is_boundary for e in v.link_edges) for v in bm.verts])
    bm.free()
    part = np.full(len(adj), -1)
    parts = []
    for s in range(len(adj)):
        if part[s] >= 0:
            continue
        part[s] = len(parts)
        stack, comp = [s], []
        while stack:
            u = stack.pop()
            comp.append(u)
            for w in adj[u]:
                if part[w] < 0:
                    part[w] = len(parts)
                    stack.append(w)
        parts.append(np.array(comp))
    return parts, boundary, adj


def bone_head(arm, name):
    b = arm.data.bones.get(name)
    return np.array(arm.matrix_world @ b.head_local) if b else None


# --- Landmarks ---------------------------------------------------------------------------------


def eye_landmarks(P):
    """Front pole, outer, inner, top and bottom of an eyeball."""
    return [
        P[P[:, 1].argmin()],
        P[np.abs(P[:, 0]).argmax()],
        P[np.abs(P[:, 0]).argmin()],
        P[P[:, 2].argmax()],
        P[P[:, 2].argmin()],
    ]


def face_landmarks(P, boundary, eye_front_y):
    """Nose tip, mouth seam centre, mouth corners and chin (model faces −y, z up)."""
    mid = P[np.abs(P[:, 0]) < 0.0015]
    nose = mid[mid[:, 1].argmin()]
    B = P[boundary]
    seam = B[(np.abs(B[:, 0]) < 0.0015) & (B[:, 2] < nose[2]) & (B[:, 1] < eye_front_y)].mean(0)
    lips = B[(np.abs(B[:, 2] - seam[2]) < 0.012) & (B[:, 1] < seam[1] + 0.012)]
    chin_c = mid[(mid[:, 1] < eye_front_y - 0.002) & (mid[:, 2] < seam[2])]
    return {
        "nose": nose,
        "seam": seam,
        "cornerL": lips[lips[:, 0].argmax()],
        "cornerR": lips[lips[:, 0].argmin()],
        "chin": chin_c[chin_c[:, 2].argmin()],
    }


# --- Thin-plate spline -------------------------------------------------------------------------


def fit_tps(X, Y):
    n = len(X)
    K = np.linalg.norm(X[:, None] - X[None], axis=2) + np.eye(n) * 1e-6
    Pm = np.hstack([np.ones((n, 1)), X])
    A = np.zeros((n + 4, n + 4))
    A[:n, :n], A[:n, n:], A[n:, :n] = K, Pm, Pm.T
    sol = np.linalg.solve(A, np.vstack([Y, np.zeros((4, 3))]))
    W, aff = sol[:n], sol[n:]

    def warp(Q):
        return np.hstack([np.ones((len(Q), 1)), Q]) @ aff + np.linalg.norm(Q[:, None] - X[None], axis=2) @ W

    return warp


# --- Upper/lower lip labels --------------------------------------------------------------------


def lip_labels(P, adj, seam, verts, conf=0.002):
    """True where a vertex near the mouth belongs to the lower lip/jaw.

    Clearly-above and clearly-below vertices are labelled by height; vertices on the seam itself
    take their neighbours' label, which works because the two lip edges aren't connected.
    """
    n = len(P)
    region = np.zeros(n, bool)
    v = np.asarray(verts)
    p = P[v]
    region[v] = (np.abs(p[:, 0]) < 0.045) & (p[:, 2] > seam[2] - 0.035) & (p[:, 2] < seam[2] + 0.02) & (p[:, 1] < seam[1] + 0.06)
    lab = np.full(n, -1)
    r = np.where(region)[0]
    lab[r[P[r, 2] < seam[2] - conf]] = 1
    lab[r[P[r, 2] > seam[2] + conf]] = 0
    changed = True
    while changed:
        changed = False
        upd = {}
        for i in np.where(region & (lab < 0))[0]:
            nl = [lab[j] for j in adj[i] if lab[j] >= 0]
            if nl:
                m = np.mean(nl)
                upd[i] = int(P[i, 2] < seam[2]) if m == 0.5 else int(round(m))
        for i, val in upd.items():
            lab[i] = val
            changed = True
    return region, lab == 1


# --- Transfer ----------------------------------------------------------------------------------


def barycentric(p, a, b, c):
    v0, v1, v2 = b - a, c - a, p - a
    d00, d01, d11, d20, d21 = v0 @ v0, v0 @ v1, v1 @ v1, v2 @ v0, v2 @ v1
    den = d00 * d11 - d01 * d01 or 1e-12
    v = (d11 * d20 - d01 * d21) / den
    w = (d00 * d21 - d01 * d20) / den
    return 1 - v - w, v, w


def warped_source(obj, warp):
    keys = obj.data.shape_keys.key_blocks
    base = warp(world_coords(obj, keys[0]))
    deltas = {kb.name: warp(world_coords(obj, kb)) - base for kb in keys[1:]}
    obj.data.calc_loop_triangles()
    tris = np.array([tuple(t.vertices) for t in obj.data.loop_triangles])
    return base, deltas, tris


def project(P, verts, base, deltas, tris, near, far, choose_tree=None):
    """Offsets for target vertices `verts`, interpolated from the nearest warped-source point."""
    names = list(deltas)
    D = np.stack([deltas[k] for k in names])
    out = np.zeros((len(names), len(P), 3))
    trees = {}

    def tree(sel_key, sel):
        if sel_key not in trees:
            trees[sel_key] = (BVHTree.FromPolygons([Vector(p) for p in base], [tuple(tris[i]) for i in sel]), sel)
        return trees[sel_key]

    all_tris = list(range(len(tris)))
    for i in verts:
        key, sel = choose_tree(i) if choose_tree else ("all", all_tris)
        bvh, sel = tree(key, sel)
        loc, _n, fi, d = bvh.find_nearest(Vector(P[i]))
        if loc is None:
            continue
        w = 1.0 if d < near else max(0.0, 1 - (d - near) / (far - near))
        if w == 0:
            continue
        a, b, c = tris[sel[fi]]
        bu, bv, bw = barycentric(np.array(loc), base[a], base[b], base[c])
        out[:, i] = w * (bu * D[:, a] + bv * D[:, b] + bw * D[:, c])
    return names, out


def kabsch(A, B):
    ca, cb = A.mean(0), B.mean(0)
    U, _s, Vt = np.linalg.svd((A - ca).T @ (B - cb))
    d = np.sign(np.linalg.det(Vt.T @ U.T))
    R = Vt.T @ np.diag([1, 1, d]) @ U.T
    return R, ca, cb


def run(cfg):
    O = bpy.data.objects
    T, arm_t = O[cfg["target"]], O[cfg["target_armature"]]
    H, teeth_s, arm_s = O[cfg["source_head"]], O[cfg["source_teeth"]], O[cfg["source_armature"]]
    eye_s = [o for o in O if o.parent == arm_s and o.type == "MESH" and o.name.startswith("Eye")]

    P = world_coords(T)
    parts, boundary, adj = topology(T)

    # Target parts: each eyeball is the biggest small part around its eye bone (eyelash pieces sit
    # just as close, but are much smaller); teeth sit inside the mouth.
    def eyeball(point):
        near = [p for p in parts if len(p) < 400 and np.linalg.norm(P[p].mean(0) - point) < 0.015]
        return max(near, key=len)

    eyeL_t, eyeR_t = eyeball(bone_head(arm_t, "LeftEye")), eyeball(bone_head(arm_t, "RightEye"))
    head_t = max(parts, key=len)
    eL, eR = eye_landmarks(P[eyeL_t]), eye_landmarks(P[eyeR_t])
    eye_front = min(eL[0][1], eR[0][1])
    head_mask = np.zeros(len(P), bool)
    head_mask[head_t] = True
    ft = face_landmarks(np.where(head_mask[:, None], P, np.inf), boundary & head_mask, eye_front)

    Ps = world_coords(H)
    _parts_s, boundary_s, adj_s = topology(H)
    left_s = next(o for o in eye_s if "Left" in o.name)
    right_s = next(o for o in eye_s if "Right" in o.name)
    sL, sR = eye_landmarks(world_coords(left_s)), eye_landmarks(world_coords(right_s))
    fs = face_landmarks(Ps, boundary_s, min(sL[0][1], sR[0][1]))

    src, tgt = sL + sR + list(fs.values()), eL + eR + list(ft.values())
    for b in ("Head", "Neck", "HeadTop_End"):
        bs, bt = bone_head(arm_s, b), bone_head(arm_t, b)
        if bs is not None and bt is not None:
            src.append(bs)
            tgt.append(bt)
    warp = fit_tps(np.array(src), np.array(tgt))

    # Which target parts are teeth, which are head (skin, lashes, brows, hair).
    neck_z = bone_head(arm_t, "Neck")[2]
    seam, cL, cR = ft["seam"], ft["cornerL"], ft["cornerR"]
    teeth_parts, head_verts = [], []
    for p in parts:
        if p is eyeL_t or p is eyeR_t:
            continue
        c = P[p].mean(0)
        if c[2] < neck_z:
            continue
        # The mouth interior also sits in there but runs deep into the head; it's soft tissue,
        # and the source head has its own, so it goes with the head.
        depth = P[p][:, 1].max() - P[p][:, 1].min()
        inside = (cR[0] - 0.005 < c[0] < cL[0] + 0.005 and abs(c[2] - seam[2]) < 0.03
                  and P[p][:, 1].min() > seam[1] - 0.003 and len(p) < 200 and depth < 0.05)
        (teeth_parts.append(p) if inside else head_verts.extend(p))

    # Head: lip-aware projection.
    base, deltas, tris = warped_source(H, warp)
    sreg, slow = lip_labels(Ps, adj_s, fs["seam"], range(len(Ps)))
    treg, tlow = lip_labels(P, adj, seam, head_verts)
    lowv = sreg & slow
    low_tris = [i for i, t in enumerate(tris) if lowv[t].all()]
    up_tris = [i for i, t in enumerate(tris) if not lowv[t].any()]
    all_tris = list(range(len(tris)))

    def choose(i):
        if not treg[i]:
            return "all", all_tris
        return ("low", low_tris) if tlow[i] else ("up", up_tris)

    names, offsets = project(P, head_verts, base, deltas, tris, cfg["near"], cfg["far"], choose)

    # Teeth: each part follows the rigid motion of the source tooth part it overlaps most.
    tbase, tdeltas, _tt = warped_source(teeth_s, warp)
    tparts, _b, _a = topology(teeth_s)
    tlabel = np.empty(len(tbase), int)
    for k, p in enumerate(tparts):
        tlabel[p] = k
    kd = KDTree(len(tbase))
    for i, p in enumerate(tbase):
        kd.insert(Vector(p), i)
    kd.balance()
    for p in teeth_parts:
        votes = [tlabel[kd.find(Vector(P[i]))[1]] for i in p]
        idx = tparts[int(np.bincount(votes).argmax())]
        for k, name in enumerate(names):
            d = tdeltas[name][idx]
            if np.abs(d).max() < 1e-7:
                continue
            R, ca, cb = kabsch(tbase[idx], tbase[idx] + d)
            offsets[k, p] = (P[p] - ca) @ R.T + cb - P[p]

    # Write shape keys (world offsets back into the mesh's local space).
    if T.data.shape_keys is None:
        T.shape_key_add(name="Basis", from_mix=False)
    inv = np.array(T.matrix_world.inverted())[:3, :3]
    rest = np.empty(len(P) * 3)
    T.data.vertices.foreach_get("co", rest)
    rest = rest.reshape(-1, 3)
    for k, name in enumerate(names):
        kb = T.data.shape_keys.key_blocks.get(name) or T.shape_key_add(name=name, from_mix=False)
        kb.data.foreach_set("co", (rest + offsets[k] @ inv.T).ravel())
        kb.value = 0
    T.data.update()
    return {"keys": len(names), "head_verts": len(head_verts), "teeth_parts": len(teeth_parts), "landmarks": len(src)}


def parse_args(argv):
    cfg = dict(CONFIG)
    if "--" in argv:
        args = argv[argv.index("--") + 1:]
        for flag, value in zip(args[::2], args[1::2]):
            cfg[flag.lstrip("-").replace("-", "_")] = value
    return cfg


if __name__ == "__main__":
    print(run(parse_args(sys.argv)))
