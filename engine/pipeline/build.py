"""Compile a building project into the public map format (vector rooms, routing grid, links, georeference).

Coordinates: every floor is shifted into a "common frame" (the reference floor's plan pixels) using its offset:
pixel (x, y) on the reference floor == (x + dx, y + dy) on that floor.
"""
import math
import cv2
import numpy as np

from .ingest import is_title, encode_png
from .georef import fit_outline

CELL = 3  # routing grid cell size in plan pixels


# ---------- per-floor image prep ----------
def shift_to_common(img, off, border):
    dx, dy = off
    M = np.float32([[1, 0, dx], [0, 1, dy]])  # common(x,y) samples floor(x+dx, y+dy)
    return cv2.warpAffine(img, M, (img.shape[1], img.shape[0]), flags=cv2.INTER_NEAREST | cv2.WARP_INVERSE_MAP,
                          borderValue=border)


def to_common(pt, off):
    return (pt[0] - off[0], pt[1] - off[1])


def prep_floor(im, ocr_items, floor, canvas):
    """Blank titles, frame and excluded areas; build a text mask; shift into the common frame."""
    im = im.copy()
    H, W = canvas
    if im.shape != (H, W):  # floors can be different sizes; pad onto a shared canvas
        pad = np.full((H, W), 255, np.uint8)
        h, w = min(H, im.shape[0]), min(W, im.shape[1])
        pad[:h, :w] = im[:h, :w]
        im = pad
    im[:8, :] = 255; im[-8:, :] = 255; im[:, :8] = 255; im[:, -8:] = 255
    for x0, y0, x1, y1 in floor.get("exclude", []):
        im[int(y0):int(y1), int(x0):int(x1)] = 255
    text = np.zeros_like(im)
    for it in ocr_items:
        x0, y0 = int(it["x"] - it["w"] / 2) - 2, int(it["y"] - it["h"] / 2) - 1
        x1, y1 = int(it["x"] + it["w"] / 2) + 2, int(it["y"] + it["h"] / 2) + 1
        if is_title(it["text"]):
            im[max(0, y0):y1, max(0, x0):x1] = 255
        else:
            text[max(0, y0):y1, max(0, x0):x1] = 255
    off = floor.get("offset", [0, 0])
    return shift_to_common(im, off, 255), shift_to_common(text, off, 0)


def masks(im, text):
    dark = (im < 165).astype(np.uint8)
    gray = ((im >= 200) & (im <= 229)).astype(np.uint8)
    # footprint: close everything drawn, then fill holes
    drawn = cv2.morphologyEx((im < 245).astype(np.uint8), cv2.MORPH_CLOSE, np.ones((17, 17), np.uint8))
    ff = drawn.copy() * 255
    h, w = ff.shape
    for corner in ((2, 2), (w - 3, 2), (2, h - 3), (w - 3, h - 3)):  # from every corner: a plan that spans the
        if ff[corner[1], corner[0]] == 0:                               # page width mustn't wall off the bottom
            cv2.floodFill(ff, np.zeros((h + 2, w + 2), np.uint8), corner, 128)
    footprint = (ff != 128).astype(np.uint8)
    footprint = cv2.morphologyEx(footprint, cv2.MORPH_OPEN, np.ones((9, 9), np.uint8))
    # walkable: gray fill, with text and thin lines inside it closed over
    walk = gray | ((text > 0) & (im < 229)).astype(np.uint8)
    walk = cv2.morphologyEx(walk, cv2.MORPH_CLOSE, np.ones((5, 5), np.uint8))
    walk = cv2.morphologyEx(walk, cv2.MORPH_OPEN, np.ones((5, 5), np.uint8)) & footprint
    # walls: dark pixels that aren't label text, minus tiny bits
    walls = dark & (text == 0).astype(np.uint8) & footprint
    n, lab, stats, _ = cv2.connectedComponentsWithStats(walls, connectivity=8)
    keep = np.zeros(n, np.uint8); keep[1:] = stats[1:, cv2.CC_STAT_AREA] >= 30
    walls = keep[lab]
    return dark, gray, footprint, walk, walls


def void_mask(im, dark, footprint, seeds, log):
    """Flood-fill "open to below" areas from seed points (railings and walls stop the fill)."""
    barrier = cv2.dilate(dark, np.ones((5, 5), np.uint8))
    free = ((im >= 235) & (barrier == 0)).astype(np.uint8) & footprint
    h, w = im.shape
    out = np.zeros_like(free)
    for sx, sy in seeds:
        sx, sy = int(sx), int(sy)
        ys, xs = np.nonzero(free[max(0, sy - 12):sy + 13, max(0, sx - 12):sx + 13])
        if len(xs) == 0:
            log(f"void point {sx},{sy} is not on open floor; skipped")
            continue
        i = int(np.argmin((xs - 12) ** 2 + (ys - 12) ** 2))
        sx, sy = max(0, sx - 12) + int(xs[i]), max(0, sy - 12) + int(ys[i])
        ff = free.copy()
        cv2.floodFill(ff, np.zeros((h + 2, w + 2), np.uint8), (sx, sy), 2)
        out |= (ff == 2).astype(np.uint8)
    return cv2.dilate(out, np.ones((7, 7), np.uint8)) & footprint


def cost_grid(im, footprint, walk, walls, voids, bbox, gw, gh):
    """Per-cell class: 0 blocked, 1 corridor/lobby, 2 inside a room (walkable but discouraged)."""
    x0, y0, x1, y1 = bbox
    def pool_max(m):
        return m[y0:y1, x0:x1].reshape(gh, CELL, gw, CELL).max(axis=(1, 3))
    def pool_mean(m):
        return m[y0:y1, x0:x1].reshape(gh, CELL, gw, CELL).astype(np.float32).mean(axis=(1, 3))
    shaft = ((im >= 150) & (im < 200)).astype(np.uint8) & (walk == 0)
    shaft = cv2.morphologyEx(shaft, cv2.MORPH_OPEN, np.ones((7, 7), np.uint8))  # solid fills only
    g = np.full((gh, gw), 2, np.uint8)
    g[pool_mean(walk) > 0.5] = 1
    g[pool_mean(footprint) < 0.6] = 0
    g[pool_mean(shaft) > 0.5] = 0
    g[pool_mean(voids) > 0.3] = 0
    g[pool_max(walls) > 0] = 0
    return g, shaft


def small_region(im, footprint, pt, kind):
    """Stairs, elevators, restrooms, entrances: a small box at the label."""
    x, y = int(round(pt[0])), int(round(pt[1]))
    s = {"stair": 16, "elevator": 9, "restroom": 18, "entrance": 18}.get(kind, 14)
    m = np.zeros_like(im, np.uint8)
    m[max(0, y - s):y + s, max(0, x - s):x + s] = 1
    return m & footprint


def flat(c):
    return [int(v) for p in c for v in (p[0][0], p[0][1])]


def mask_polys(mask, eps, min_area):
    """Clean vector outlines (with holes) of a binary mask."""
    k = np.ones((3, 3), np.uint8)
    m = cv2.morphologyEx(cv2.morphologyEx(mask, cv2.MORPH_OPEN, k), cv2.MORPH_CLOSE, k)
    cs, hier = cv2.findContours(m, cv2.RETR_CCOMP, cv2.CHAIN_APPROX_SIMPLE)
    out = []
    if hier is None:
        return out
    for i, c in enumerate(cs):
        if hier[0][i][3] != -1 or cv2.contourArea(c) < min_area:
            continue
        o = cv2.approxPolyDP(c, eps, True)
        if len(o) < 3:
            continue
        holes, j = [], hier[0][i][2]
        while j != -1:
            h = cv2.approxPolyDP(cs[j], eps, True)
            if len(h) >= 3 and cv2.contourArea(h) >= min_area:
                holes.append(flat(h))
            j = hier[0][j][0]
        out.append({"o": flat(o), "h": holes})
    return out


def room_spaces(im, dark, footprint, voids, walk):
    """Every enclosed white space becomes its own room outline (walls left as thin gaps between them)."""
    barrier = cv2.dilate(dark, np.ones((7, 7), np.uint8))
    free = ((im >= 228) & (barrier == 0) & (walk == 0) & (voids == 0)).astype(np.uint8) & footprint
    n, lab, stats, _ = cv2.connectedComponentsWithStats(free, connectivity=4)
    spaces, comp_to_space = [], {}
    for i in range(1, n):
        x, y, w, h, area = stats[i]
        if area < 60:
            continue
        pad = 6
        xa, ya = max(0, x - pad), max(0, y - pad)
        m = (lab[ya:y + h + pad, xa:x + w + pad] == i).astype(np.uint8)
        m = cv2.morphologyEx(m, cv2.MORPH_CLOSE, np.ones((7, 7), np.uint8))  # swallow text holes
        m = cv2.dilate(m, np.ones((5, 5), np.uint8))
        cs, _ = cv2.findContours(m, cv2.RETR_EXTERNAL, cv2.CHAIN_APPROX_SIMPLE)
        c = max(cs, key=cv2.contourArea)
        (_, (rw, rh), _) = cv2.minAreaRect(c)
        if min(rw, rh) < 10 or cv2.contourArea(c) < 220:  # slivers from glass lines, specks
            continue
        o = cv2.approxPolyDP(c, 1.8, True) + np.array([xa, ya])
        if len(o) < 3:
            continue
        comp_to_space[i] = len(spaces)
        spaces.append({"o": flat(o), "k": "room"})
    return spaces, lab, comp_to_space


def space_at(lab, comp_to_space, x, y, r=20):
    x, y = int(round(x)), int(round(y))
    win = lab[max(0, y - r):y + r + 1, max(0, x - r):x + r + 1]
    best = None
    for yy, xx in zip(*np.nonzero(win)):
        c = win[yy, xx]
        if c in comp_to_space:
            d = (xx - min(r, x)) ** 2 + (yy - min(r, y)) ** 2
            if best is None or d < best[0]:
                best = (d, comp_to_space[c])
    return None if best is None else best[1]


def rle(values):
    """Run-length encode a flat array as [value, count, value, count, ...]."""
    out, cur, n = [], values[0], 0
    for v in values:
        if v == cur:
            n += 1
        else:
            out += [cur, n]; cur, n = v, 1
    out += [cur, n]
    return out


# ---------- the whole building ----------
def build(project, images, ocr, log=print):
    """
    project: settings dict (floors, labels, voids, entrances, extra_links, footprint)
    images:  {floor_id: grayscale plan image}
    ocr:     {floor_id: raw OCR items}
    Returns (public_map_dict, {floor_id: debug_png_bytes}, report_dict).
    """
    floors_cfg = sorted(project["floors"], key=lambda f: f["level"])
    floors_cfg = [f for f in floors_cfg if f["id"] in images]
    if not floors_cfg:
        raise ValueError("No processed floors yet. Upload and process at least one floor.")
    H = max(images[f["id"]].shape[0] for f in floors_cfg)
    W = max(images[f["id"]].shape[1] for f in floors_cfg)

    data = {}
    for f in floors_cfg:
        im, text = prep_floor(images[f["id"]], ocr.get(f["id"], []), f, (H, W))
        data[f["id"]] = (im, text) + masks(im, text)

    allfp = np.zeros((H, W), np.uint8)
    for v in data.values():
        allfp |= v[4]
    ys, xs = np.nonzero(allfp)
    if not len(xs):
        raise ValueError("Couldn't find the building outline on any floor.")
    x0, y0 = max(0, int(xs.min()) - 3) // CELL * CELL, max(0, int(ys.min()) - 3) // CELL * CELL
    x1, y1 = min(W, int(xs.max()) + 4), min(H, int(ys.max()) + 4)
    gw, gh = (x1 - x0) // CELL, (y1 - y0) // CELL
    x1, y1 = x0 + gw * CELL, y0 + gh * CELL

    floors_out, rooms, debug, report = [], [], {}, {"floors": {}}
    labels_common = {}
    for f in floors_cfg:
        fid = f["id"]
        im, text, dark, gray, footprint, walk, walls = data[fid]
        off = f.get("offset", [0, 0])
        labels = project.get("labels", {}).get(fid, [])
        labels_common[fid] = {l["id"]: dict(l, x=to_common((l["x"], l["y"]), off)[0], y=to_common((l["x"], l["y"]), off)[1]) for l in labels}

        voids = void_mask(im, dark, footprint, project.get("voids", {}).get(fid, []), log)
        g, shaft = cost_grid(im, footprint, walk, walls, voids, (x0, y0, x1, y1), gw, gh)
        n, lab_g = cv2.connectedComponents((g > 0).astype(np.uint8))
        sizes = sorted(np.bincount(lab_g.ravel())[1:].tolist(), reverse=True)

        spaces, lab, comp_to_space = room_spaces(im, dark, footprint, voids, walk)
        spaces += [{"o": p["o"], "k": "shaft"} for p in mask_polys(shaft & footprint, 1.5, 60)]

        dbg = cv2.cvtColor(im, cv2.COLOR_GRAY2BGR)
        big = cv2.resize(g, (x1 - x0, y1 - y0), interpolation=cv2.INTER_NEAREST)
        tint = np.zeros_like(dbg)
        tint[y0:y1, x0:x1][big == 1] = (255, 200, 0)
        tint[y0:y1, x0:x1][big == 2] = (180, 255, 180)
        tint[y0:y1, x0:x1][big == 0] = (60, 60, 200)
        dbg = (dbg * 0.55 + tint * 0.45).astype(np.uint8)

        n_rooms = 0
        for l in labels_common[fid].values():
            kind = l["kind"]
            if kind in ("circulation", "service"):
                continue
            lx, ly = l["x"], l["y"]
            si = space_at(lab, comp_to_space, lx, ly) if kind == "room" else None
            if si is not None:
                o = spaces[si]["o"]
                poly = [[o[i], o[i + 1]] for i in range(0, len(o), 2)]
            else:
                reg = small_region(im, footprint, (lx, ly), kind)
                cs, _ = cv2.findContours(reg, cv2.RETR_EXTERNAL, cv2.CHAIN_APPROX_SIMPLE)
                poly = [[int(p[0][0]), int(p[0][1])] for p in max(cs, key=cv2.contourArea)] if cs else \
                    [[int(lx) - 12, int(ly) - 9], [int(lx) + 12, int(ly) - 9], [int(lx) + 12, int(ly) + 9], [int(lx) - 12, int(ly) + 9]]
            if l.get("restricted"):
                # private rooms: keep the shape anonymous, publish nothing that identifies them
                cv2.polylines(dbg, [np.array(poly)], True, (80, 80, 80), 2)
                continue
            if si is not None:
                spaces[si]["id"] = l["id"]
            room = {"id": l["id"], "floor": fid, "kind": kind, "label": [round(lx), round(ly)], "poly": poly}
            if l.get("name"):
                room["name"] = l["name"]
            if si is not None:
                room["space"] = si
            rooms.append(room)
            n_rooms += kind == "room"
            color = {"room": (0, 120, 255), "stair": (0, 180, 0), "elevator": (200, 0, 200), "restroom": (255, 0, 0),
                     "entrance": (0, 0, 255)}.get(kind, (0, 0, 0))
            cv2.polylines(dbg, [np.array(poly)], True, color, 2)
        debug[fid] = encode_png(dbg[y0:y1, x0:x1])

        floors_out.append({"id": fid, "name": f["name"], "level": f["level"], "grid": rle(g.ravel().tolist()),
                           "slab": mask_polys(footprint & (voids == 0).astype(np.uint8), 2.5, 500),
                           "walk": mask_polys(walk & footprint & (voids == 0).astype(np.uint8), 2.0, 400),
                           "spaces": spaces})
        report["floors"][fid] = {"rooms": n_rooms, "spaces": len(spaces), "walk_components": sizes[:5]}
        log(f"{fid}: {len(spaces)} spaces, {n_rooms} labeled rooms, walkable areas {sizes[:3]}")

    # vertical connectors: same kind, adjacent floors, close in the common frame
    links = []
    order = [f["id"] for f in floors_cfg]
    vert = [r for r in rooms if r["kind"] in ("stair", "elevator")]
    for a, b in zip(order, order[1:]):
        for ra in [r for r in vert if r["floor"] == a]:
            best = None
            for rb in [r for r in vert if r["floor"] == b and r["kind"] == ra["kind"]]:
                d = math.dist(ra["label"], rb["label"])
                if d < 45 and (best is None or d < best[0]):
                    best = (d, rb)
            if best:
                links.append({"kind": ra["kind"], "a": [a, ra["id"]], "b": [b, best[1]["id"]]})
    byid = {(r["floor"], r["id"]): r for r in rooms}
    for (fa, ia), (fb, ib) in project.get("extra_links", []):
        if (fa, ia) in byid and (fb, ib) in byid and not any(l["a"] == [fa, ia] and l["b"] == [fb, ib] for l in links):
            links.append({"kind": byid[(fa, ia)]["kind"], "a": [fa, ia], "b": [fb, ib]})
    report["links"] = len(links)
    log(f"{len(links)} stair/elevator links between floors")

    # georeference: similarity transform common px -> local metres (east, north). Fitted to entrances with
    # lat/lon when there are two or more; otherwise to the building's footprint outline (see georef.py).
    offs = {f["id"]: f.get("offset", [0, 0]) for f in floors_cfg}
    ents = [e for e in project.get("entrances", []) if e["floor"] in offs]
    geo = [e for e in ents if e.get("lat") is not None and e.get("lon") is not None]
    fp = project.get("footprint")
    if len(geo) < 2 and not fp:
        raise ValueError("Add at least two entrances with latitude/longitude (or the building's footprint) "
                         "so the map can be placed on campus.")
    if not ents:
        raise ValueError("Add at least one entrance so routes can start at a door.")
    ref_pts = [(e["lat"], e["lon"]) for e in geo] if len(geo) >= 2 else [tuple(p) for p in fp]
    lat0 = sum(p[0] for p in ref_pts) / len(ref_pts)
    lon0 = sum(p[1] for p in ref_pts) / len(ref_pts)
    kx, ky = 111320 * math.cos(math.radians(lat0)), 110540
    to_m = lambda lat, lon: [(lon - lon0) * kx, (lat - lat0) * ky]
    plan_pt = {id(e): to_common((e["x"], e["y"]), offs[e["floor"]]) for e in ents}
    if len(geo) >= 2:
        src = [[plan_pt[id(e)][0], -plan_pt[id(e)][1]] for e in geo]  # flip y so the transform is a proper rotation
        M, _ = cv2.estimateAffinePartial2D(np.float32(src), np.float32([to_m(e["lat"], e["lon"]) for e in geo]),
                                           method=cv2.LMEDS)
        if M is None:
            raise ValueError("Couldn't fit the entrances to the map; check their positions and coordinates.")
        how = "entrances"
    else:
        hint = [(plan_pt[id(e)], to_m(e["lat"], e["lon"])) for e in geo]
        M, fit = fit_outline(allfp, np.array([to_m(*p) for p in fp]), hint, partial=project.get("footprint_partial", False))
        how = f"footprint outline (score {fit})"
    scale = math.hypot(M[0, 0], M[1, 0])
    entrances = []
    for e in ents:
        px, py = plan_pt[id(e)]
        start = (px, py)
        if e.get("label") and e["label"] in labels_common.get(e["floor"], {}):
            l = labels_common[e["floor"]][e["label"]]
            start = (l["x"], l["y"])
        east, north = M[:, :2] @ np.array([px, -py]) + M[:, 2]
        entrances.append({"name": e["name"], "floor": e["floor"], "lat": lat0 + north / ky, "lon": lon0 + east / kx,
                          "plan": [round(px), round(py)], "start": [round(start[0]), round(start[1])]})
    res = [math.dist(M[:, :2] @ np.array([plan_pt[id(e)][0], -plan_pt[id(e)][1]]) + M[:, 2], to_m(e["lat"], e["lon"]))
           for e in geo]
    if len(geo) >= 2:  # entrances define the fit: publish their surveyed coordinates
        for out_e, e in zip(entrances, ents):
            if e.get("lat") is not None and e.get("lon") is not None:
                out_e["lat"], out_e["lon"] = e["lat"], e["lon"]
    report["georef"] = {"method": how, "m_per_px": round(scale, 5),
                        "rotation_deg": round(math.degrees(math.atan2(M[1, 0], M[0, 0])), 1),
                        "residuals_m": [round(r, 1) for r in res]}
    log(f"georeference by {how}: {scale:.4f} m/px, entrance residuals {report['georef']['residuals_m']} m")

    footprint = project.get("footprint")
    if not footprint:  # derive from the reference floor's outline
        ref = next((f for f in floors_out if offs[f["id"]] == [0, 0]), floors_out[0])
        o = max(ref["slab"], key=lambda p: len(p["o"]))["o"]
        footprint = []
        for i in range(0, len(o), 2):
            e_, n_ = M[:, :2] @ np.array([o[i], -o[i + 1]]) + M[:, 2]
            footprint.append([lat0 + n_ / ky, lon0 + e_ / kx])

    out = {
        "building": {"id": project["id"], "name": project["name"], "campus": project.get("campus", ""),
                     "origin": {"lat": lat0, "lon": lon0}, "mPerDegLon": kx, "mPerDegLat": ky,
                     # metres: east = a*x + b*(-y) + c ; north = d*x + e*(-y) + f
                     "transform": [float(v) for v in M.ravel()], "footprint": footprint},
        "mPerPx": scale,
        "grid": {"cell": CELL, "x0": x0, "y0": y0, "w": gw, "h": gh},
        "texture": {"x0": x0, "y0": y0, "w": x1 - x0, "h": y1 - y0},
        "floors": floors_out, "rooms": rooms, "links": links, "entrances": entrances,
    }
    report["rooms"] = sum(1 for r in rooms if r["kind"] == "room")
    return out, debug, report


def auto_offset(ref_im, im):
    """Estimate how a floor is shifted relative to the reference floor (phase correlation on line work)."""
    def prep(x):
        e = (x < 150).astype(np.float32)
        return cv2.GaussianBlur(e, (0, 0), 3)
    H = max(ref_im.shape[0], im.shape[0]); W = max(ref_im.shape[1], im.shape[1])
    a = np.zeros((H, W), np.float32); b = np.zeros((H, W), np.float32)
    pa, pb = prep(ref_im), prep(im)
    a[:pa.shape[0], :pa.shape[1]] = pa
    b[:pb.shape[0], :pb.shape[1]] = pb
    (dx, dy), resp = cv2.phaseCorrelate(a, b)
    return [round(dx, 1), round(dy, 1)], round(float(resp), 3)


def overlay(ref_im, im, off):
    """Admin preview: reference floor in orange, this floor (shifted) in white."""
    H, W = ref_im.shape
    pad = np.full((H, W), 255, np.uint8)
    h, w = min(H, im.shape[0]), min(W, im.shape[1])
    pad[:h, :w] = im[:h, :w]
    b = shift_to_common(pad, off, 255)
    out = np.zeros((H, W, 3), np.uint8); out[:] = (29, 24, 22)
    out[ref_im < 170] = (74, 160, 240)
    out[b < 170] = (235, 235, 235)
    out[(ref_im < 170) & (b < 170)] = (150, 220, 255)
    return encode_png(out)
