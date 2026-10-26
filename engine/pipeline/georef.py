"""Place a plan on the map by fitting its outline to the building's OpenStreetMap footprint.

Used when a building has fewer than two entrances with known coordinates. The plan outline (pixels) is matched to
the footprint polygon (metres) with a similarity transform (scale, rotation, shift; never a mirror), scored by how
close the plan's outer walls fall to the footprint's edges and how much of the plan falls outside it. When the plan
covers the whole footprint, the footprint's edges must also fall close to the plan's; a plan of a lower level that
sits under only part of the building (partial=True) is scored from the plan side only.
"""
import math

import cv2
import numpy as np

RES = 0.1    # metres per raster cell
CAP = 3.0    # metres: edge distances beyond this count the same (robust to walls the footprint doesn't have)


def _raster(poly_m, pad):
    lo = poly_m.min(0) - pad
    size = np.ceil((poly_m.max(0) + pad - lo) / RES).astype(int)
    pts = np.round((poly_m - lo) / RES).astype(np.int32)
    inside = np.zeros((size[1], size[0]), np.uint8)
    cv2.fillPoly(inside, [pts], 1)
    edge = np.full_like(inside, 255)
    cv2.polylines(edge, [pts], True, 0, 1)
    dist = cv2.distanceTransform(edge, cv2.DIST_L2, 5) * RES
    return lo, inside, np.minimum(dist, CAP)


def fit_outline(footprint_mask, poly_m, hint=None, partial=False):
    """footprint_mask: uint8 plan mask (common px). poly_m: Nx2 footprint in metres (east, north).
    hint: optional (plan_xy, metres_xy) pairs (e.g. the one tagged entrance) that should land close together.
    Returns (M, score): M is 2x3, metres = M @ [x, -y, 1]."""
    cs, _ = cv2.findContours(footprint_mask.astype(np.uint8), cv2.RETR_EXTERNAL, cv2.CHAIN_APPROX_NONE)
    if not cs:
        raise ValueError("Couldn't find the plan outline to fit to the footprint.")
    edge = np.concatenate([c[:, 0, :] for c in cs if cv2.contourArea(c) > 2000] or [max(cs, key=cv2.contourArea)[:, 0, :]])
    edge = edge[:: max(1, len(edge) // 1500)].astype(np.float64)
    ys, xs = np.nonzero(footprint_mask)
    step = max(1, len(xs) // 1500)
    fill = np.stack([xs[::step], ys[::step]], 1).astype(np.float64)
    area_px = float(footprint_mask.sum())
    E = np.c_[edge[:, 0], -edge[:, 1]]; F = np.c_[fill[:, 0], -fill[:, 1]]
    c_plan = F.mean(0)
    pedge = np.full(footprint_mask.shape, 255, np.uint8)
    cv2.drawContours(pedge, cs, -1, 0, 1)
    pdist = cv2.distanceTransform(pedge, cv2.DIST_L2, 5)
    ph, pw = pdist.shape

    poly_m = np.asarray(poly_m, np.float64)
    lo, inside, dist = _raster(poly_m, CAP + 2)
    h, w = dist.shape
    area_m = float(inside.sum()) * RES * RES
    c_poly = poly_m.mean(0)
    span = poly_m.max(0) - poly_m.min(0)
    ring = np.vstack([poly_m, poly_m[:1]])
    O = np.concatenate([np.linspace(a, b, max(2, int(math.dist(a, b) / 0.5)), endpoint=False) for a, b in zip(ring, ring[1:])])

    def look(grid, P, fallback):
        ix = np.round((P[:, 0] - lo[0]) / RES).astype(int); iy = np.round((P[:, 1] - lo[1]) / RES).astype(int)
        ok = (ix >= 0) & (ix < w) & (iy >= 0) & (iy < h)
        out = np.full(len(P), fallback, np.float64)
        out[ok] = grid[iy[ok], ix[ok]]
        return out

    def transform(p):
        s, th, tx, ty = p
        R = s * np.array([[math.cos(th), -math.sin(th)], [math.sin(th), math.cos(th)]])
        return np.c_[R, np.array([tx, ty]) - R @ c_plan]

    def cost(p):
        M = transform(p)
        e = E @ M[:, :2].T + M[:, 2]; f = F @ M[:, :2].T + M[:, 2]
        c = look(dist, e, CAP).mean() + 4 * (1 - look(inside, f, 0).mean())
        if not partial:  # footprint edges -> plan outline (in plan px, converted to metres)
            A = M[:, :2]; q = (O - M[:, 2]) @ np.linalg.inv(A).T
            ix = np.round(q[:, 0]).astype(int); iy = np.round(-q[:, 1]).astype(int)
            ok = (ix >= 0) & (ix < pw) & (iy >= 0) & (iy < ph)
            d = np.full(len(O), CAP)
            d[ok] = np.minimum(pdist[iy[ok], ix[ok]] * p[0], CAP)
            c += d.mean()
        if hint:
            for (px, py), m in hint:
                q = M[:, :2] @ np.array([px, -py]) + M[:, 2]
                c += 0.3 * min(math.dist(q, m), 15)
        return c

    s0 = math.sqrt(area_m / area_px)
    cands = []
    for th in np.radians(np.arange(0, 360, 3)):
        for sf in (0.55, 0.7, 0.85, 1.0, 1.15):
            for fx in (-0.3, -0.15, 0, 0.15, 0.3):
                for fy in (-0.3, -0.15, 0, 0.15, 0.3):
                    p = (s0 * sf, th, c_poly[0] + fx * span[0], c_poly[1] + fy * span[1])
                    cands.append((cost(p), p))
    cands.sort(key=lambda t: t[0])
    best = None
    for c, p in cands[:12]:  # refine the best starts by shrinking coordinate steps
        p = list(p); steps = [0.04 * p[0], math.radians(2), 1.5, 1.5]
        for _ in range(60):
            moved = False
            for i in range(4):
                for d in (-1, 1):
                    q = p.copy(); q[i] += d * steps[i]
                    cq = cost(q)
                    if cq < c:
                        c, p, moved = cq, q, True
            if not moved:
                steps = [s * 0.5 for s in steps]
                if steps[2] < 0.02:
                    break
        if best is None or c < best[0]:
            best = (c, p)
    return transform(best[1]), round(best[0], 3)
