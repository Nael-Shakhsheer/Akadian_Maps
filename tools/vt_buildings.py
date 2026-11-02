"""Virginia Tech indoor maps, built from public plans with the same pipeline as GMU's.

Torgersen Hall's plans (VT Computer Science space plans, floors 1-3) are vector CAD drawings: black walls, blue
windows, red door swings, magenta room numbers and orange call-out boxes. Instead of rendering them as a picture,
the plan is redrawn from its vector paths in the engine's convention (walls dark, corridors gray, rooms white),
and room numbers are read from the magenta paths alone, so call-outs and door swings never get in the way.

    python tools/vt_buildings.py prepare     # redraw plans + read labels into data/vt/torgersen-hall/{plans,ocr}
"""
import json, math, re, sys
from pathlib import Path

import cv2
import numpy as np
import pymupdf

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT))
from engine.pipeline import ingest, build as builder, campus as campus_pipe

TORG = ROOT / "data/vt/torgersen-hall"
SCALE = 250 / 72          # plan pixels per PDF point (250 dpi, like GMU's renders)
TEXT_K = 2.4              # room numbers are read from a sharper drawing
WALL, WINDOW, NUMBER = (0.0, 0.0, 0.0), (0.0, 0.0, 1.0), (1.0, 0.0, 1.0)
CORRIDOR_GRAY = 215       # the engine treats 200-229 as walkable corridor
PAD = 60                  # white margin around each page: Torgersen's northeast wing runs to the page edge

FLOORS = [  # id, name, level, pdf, offset relative to Floor 1 (common frame), from align() (checked with overlays)
    ("first", "Floor 1", 1, "Torg1", [0.0, 0.0]),
    ("second", "Floor 2", 2, "Torg2", [-4.6, -23.4]),
    ("third", "Floor 3", 3, "Torg3", [-23.1, 112.3]),
]
LEVEL_FLOOR = {"1": "first", "2": "second", "3": "third"}  # OSM entrance level -> floor
# Stairs and elevators aren't numbered on these plans. They are placed where every floor draws them (stair treads
# with UP/DN marks, X-marked shafts), in floor 1 page pixels before the margin; each lists the floors it serves.
VERTICAL = [
    ("STAIR1", "stair", (548, 800), ("first", "second", "third")),     # open stair in the atrium
    ("STAIR2", "stair", (140, 915), ("first", "second", "third")),     # west end
    ("STAIR3", "stair", (1622, 80), ("first", "second", "third")),     # northeast wing
    ("STAIR4", "stair", (1162, 975), ("first", "second", "third")),    # south, by the auditoriums
    ("ELEV1", "elevator", (1370, 97), ("first", "second", "third")),   # north end
    ("ELEV2", "elevator", (58, 903), ("first", "second")),             # west end
]


def _segments(item):
    k = item[0]
    if k == "l":
        return [(item[1], item[2])]
    if k == "c":  # bezier: its control polygon is close enough at this scale
        return [(item[1], item[2]), (item[2], item[3]), (item[3], item[4])]
    if k == "re":
        r = item[1]
        return [(r.tl, r.tr), (r.tr, r.br), (r.br, r.bl), (r.bl, r.tl)]
    if k == "qu":
        q = item[1]
        return [(q.ul, q.ur), (q.ur, q.lr), (q.lr, q.ll), (q.ll, q.ul)]
    return []


def redraw(pdf: Path):
    """PDF -> (plan image in the engine's convention, sharp image of the room numbers only)."""
    page = pymupdf.open(pdf)[0]
    W, H = int(page.rect.width * SCALE) + 2 * PAD, int(page.rect.height * SCALE) + 2 * PAD
    plan = np.full((H, W), 255, np.uint8)
    text = np.full((int(H * TEXT_K), int(W * TEXT_K)), 255, np.uint8)
    for path in page.get_drawings():
        col = tuple(round(v, 2) for v in (path.get("color") or ()))
        if col not in (WALL, WINDOW, NUMBER):
            continue  # door swings, call-out boxes and their fills
        for a, b in (s for it in path["items"] for s in _segments(it)):
            if col == NUMBER:
                k, o = SCALE * TEXT_K, PAD * TEXT_K
                cv2.line(text, (round(a.x * k + o), round(a.y * k + o)), (round(b.x * k + o), round(b.y * k + o)), 0, 2, cv2.LINE_AA)
            else:
                cv2.line(plan, (round(a.x * SCALE) + PAD, round(a.y * SCALE) + PAD),
                         (round(b.x * SCALE) + PAD, round(b.y * SCALE) + PAD), 0, 2)
    return plan, text


def read_labels(text_img):
    """Room numbers (1010, 1100C, 10051), shared spaces (A25 on floor 1, B25 on floor 2, C.. on floor 3: corridors,
    lobbies, stairs) and stair 'UP'/'DN' marks."""
    eng = ingest._ocr_engine()
    res, _ = eng(cv2.cvtColor(text_img, cv2.COLOR_GRAY2BGR), box_thresh=0.3, text_score=0.3)
    raw, labels = [], {}
    for box, txt, score in res or []:
        xs = [p[0] / TEXT_K for p in box]; ys = [p[1] / TEXT_K for p in box]
        x, y = sum(xs) / 4, sum(ys) / 4
        raw.append({"text": txt, "x": round(x, 1), "y": round(y, 1), "w": round(max(xs) - min(xs), 1),
                    "h": round(max(ys) - min(ys), 1), "score": round(float(score), 2)})
        for tok in re.findall(r"[A-Z0-9]+", txt.upper()):
            t = re.sub(r"(?<=\d)[OQ](?=\d|$)", "0", tok)
            t = re.sub(r"(?<=\d)S(?=\d)", "5", t)
            t = re.sub(r"(?<=\d)[I|L](?=\d|$)", "1", t)
            if re.fullmatch(r"\d{4}[08]", t) and not t.startswith("1005"):  # 2050B read as 20508, 2030D as 20300
                t = t[:4] + {"8": "B", "0": "D"}[t[4]]
            if re.fullmatch(r"\d{4,5}[A-Z]?", t):
                kind = "room"
            elif re.fullmatch(r"[ABC]\d{1,2}", t):
                kind = "circulation"
            elif t in ("UP", "DN"):
                kind = "stair-mark"
            else:
                continue
            key = t if kind != "stair-mark" else f"{t}@{round(x)},{round(y)}"
            if key not in labels or labels[key]["score"] < score:
                labels[key] = {"id": t, "kind": kind, "x": round(x), "y": round(y), "score": float(score)}
    out = sorted(labels.values(), key=lambda l: (l["kind"], l["id"]))
    for l in out:
        l.pop("score")
    return raw, out


def seal(plan):
    """Close the outer envelope. These drawings leave exterior doorways open, which would let 'outside' leak
    into the corridors; routes start just inside each door, so the doorway itself isn't needed."""
    walls = (plan < 128).astype(np.uint8)
    body = cv2.morphologyEx(walls, cv2.MORPH_CLOSE, cv2.getStructuringElement(cv2.MORPH_ELLIPSE, (41, 41)))
    h, w = body.shape
    ff = body * 255
    cv2.floodFill(ff, np.zeros((h + 2, w + 2), np.uint8), (0, 0), 128)
    body = (ff != 128).astype(np.uint8)
    body = cv2.morphologyEx(body, cv2.MORPH_OPEN, np.ones((9, 9), np.uint8))  # drop thin stray lines (titles, stubs)
    cs, _ = cv2.findContours(body, cv2.RETR_EXTERNAL, cv2.CHAIN_APPROX_NONE)
    out = plan.copy()
    cv2.drawContours(out, [c for c in cs if cv2.contourArea(c) > 20000], -1, 0, 2)
    return out


def corridors(plan, labels):
    """Paint the shared spaces (A-numbers) gray so routes prefer corridors. Door openings are sealed first,
    so the fill stays out of the rooms."""
    walls = (plan < 128).astype(np.uint8)
    sealed = cv2.morphologyEx(walls, cv2.MORPH_CLOSE, cv2.getStructuringElement(cv2.MORPH_ELLIPSE, (15, 15)))
    free = (1 - sealed).astype(np.uint8) * 255
    out = plan.copy()
    h, w = plan.shape
    for l in labels:
        if l["kind"] != "circulation":
            continue
        x, y = int(l["x"]), int(l["y"])
        if not (0 <= x < w and 0 <= y < h) or not free[y, x]:
            continue
        mask = np.zeros((h + 2, w + 2), np.uint8)
        region = free.copy()
        n, _, _, (bx, by, bw, bh) = cv2.floodFill(region, mask, (x, y), 128)
        if n > 0.12 * h * w:  # leaked outside (an open exterior door): skip this one
            continue
        m = mask[1:-1, 1:-1] > 0
        out[m & (plan > 128)] = CORRIDOR_GRAY
    return out


def align(ref, im, search=260):
    """Offset of a floor relative to the reference floor (same drawing scale): the best overlap of the two
    outlines (coarse search), refined with ECC on the walls. Returns ([dx, dy], correlation)."""
    H = max(ref.shape[0], im.shape[0]); W = max(ref.shape[1], im.shape[1])
    def prep(x, blur=3):
        p = np.zeros((H, W), np.float32)
        p[:x.shape[0], :x.shape[1]] = cv2.GaussianBlur((x < 128).astype(np.float32), (0, 0), blur)
        return p
    # coarse: slide the floor over the reference at 1/4 size
    q = 4
    a4 = cv2.resize(prep(ref, 6), None, fx=1 / q, fy=1 / q, interpolation=cv2.INTER_AREA)
    b4 = cv2.resize(prep(im, 6), None, fx=1 / q, fy=1 / q, interpolation=cv2.INTER_AREA)
    m = search // q
    padded = cv2.copyMakeBorder(a4, m, m, m, m, cv2.BORDER_CONSTANT, value=0)
    res = cv2.matchTemplate(padded, b4, cv2.TM_CCORR_NORMED)
    _, _, _, (mx, my) = cv2.minMaxLoc(res)
    dx, dy = (m - mx) * q, (m - my) * q  # floor(x + dx, y + dy) == reference(x, y)
    a, b = prep(ref), prep(im)
    warp = np.float32([[1, 0, dx], [0, 1, dy]])
    cc, warp = cv2.findTransformECC(a, b, warp, cv2.MOTION_TRANSLATION, (cv2.TERM_CRITERIA_EPS | cv2.TERM_CRITERIA_COUNT, 200, 1e-5), None, 5)
    return [round(float(warp[0, 2]), 1), round(float(warp[1, 2]), 1)], round(float(cc), 3)


def prepare():
    (TORG / "plans").mkdir(parents=True, exist_ok=True)
    (TORG / "ocr").mkdir(parents=True, exist_ok=True)
    plans = {}
    for fid, _, _, pdf, _ in FLOORS:
        plan, text = redraw(TORG / f"source/floor-plans-pdf/{pdf}.pdf")
        raw, labels = read_labels(text)
        plans[fid] = plan
        plan = seal(plan)
        plans[fid] = plan
        cv2.imwrite(str(TORG / f"plans/{pdf}.png"), corridors(plan, labels))
        (TORG / f"ocr/{pdf}.ocr.json").write_text(json.dumps(raw, indent=1))
        (TORG / f"ocr/{pdf}.labels.json").write_text(json.dumps(labels, indent=1))
        kinds = {}
        for l in labels:
            kinds[l["kind"]] = kinds.get(l["kind"], 0) + 1
        print(f"{pdf}: {plan.shape[1]}x{plan.shape[0]} px, labels {kinds}")
    for fid, *_ in FLOORS[1:]:
        print(fid, "offset", *align(plans["first"], plans[fid]))


def _floor_labels(fid, off):
    ls = [l for l in json.loads((TORG / f"ocr/{dict((f[0], f[3]) for f in FLOORS)[fid]}.labels.json").read_text())
          if l["kind"] in ("room", "circulation")]
    for lid, kind, (cx, cy), floors in VERTICAL:
        if fid in floors:
            ls.append({"id": lid, "kind": kind, "x": round(cx + PAD + off[0]), "y": round(cy + PAD + off[1])})
    return ls


def _side(lat, lon, lat0, lon0):
    a = math.degrees(math.atan2((lat - lat0) * 110540, (lon - lon0) * 111320 * math.cos(math.radians(lat0))))
    return ["East", "Northeast", "North", "Northwest", "West", "Southwest", "South", "Southeast"][round(a / 45) % 8]


def torgersen_project(entrances):
    rel = json.loads((TORG / "osm/building.json").read_text())["elements"][0]
    outline = campus_pipe.relation_outline(rel)
    floors = [{"id": f, "name": n, "level": lv, "prefix": "", "offset": off, "reference": off == [0.0, 0.0],
               "exclude": [[1440 + PAD, 1100 + PAD, 1760 + PAD, 1400 + PAD]], "processed": True}  # "FIRST FLOOR" titles
              for f, n, lv, _, off in FLOORS]
    return {
        "id": "vt-torgersen", "name": "Torgersen Hall", "campus": "vt", "osm_way": rel["id"],
        "floors": floors, "labels": {f["id"]: _floor_labels(f["id"], f["offset"]) for f in floors},
        "voids": {}, "entrances": entrances, "extra_links": [],
        "footprint": [[p["lat"], p["lon"]] for p in outline["geometry"]],
    }


def _osm_entrances(out, p):
    """OSM's tagged doors (each with its floor) in plan coordinates, using the building's map placement."""
    B = out["building"]; o = B["origin"]
    a, b, c, d, e, f = B["transform"]
    inv = np.linalg.inv(np.array([[a, b], [d, e]]))
    offs = {fl["id"]: fl["offset"] for fl in p["floors"]}
    lat0 = sum(q[0] for q in p["footprint"]) / len(p["footprint"]); lon0 = sum(q[1] for q in p["footprint"]) / len(p["footprint"])
    ents = []
    for n in json.loads((TORG / "osm/entrances.json").read_text())["elements"]:
        fid = LEVEL_FLOOR.get(n.get("tags", {}).get("level", ""))
        if not fid:
            continue
        east = (n["lon"] - o["lon"]) * B["mPerDegLon"] - c; north = (n["lat"] - o["lat"]) * B["mPerDegLat"] - f
        x, my = inv @ np.array([east, north])  # common frame px (y flipped)
        kind = n["tags"].get("entrance")
        name = f"{_side(n['lat'], n['lon'], lat0, lon0)} {'main entrance' if kind == 'main' else 'entrance'}"
        ents.append({"name": name, "floor": fid, "x": round(x + offs[fid][0]), "y": round(-my + offs[fid][1]),
                     "cx": x, "cy": -my, "lat": n["lat"], "lon": n["lon"], "osm": n["id"]})
    return ents


def _name_doors(ents, p):
    """'Northwest main entrance (Floor 2)'; two doors on the same side and floor get numbers."""
    fname = {fl["id"]: fl["name"] for fl in p["floors"]}
    for e in ents:
        same = [x for x in ents if x["name"] == e["name"] and x["floor"] == e["floor"]]
        if len(same) > 1:
            for i, x in enumerate(same, 1):
                x["name"] = f"{x['name']} {i}"
    for e in ents:
        e["name"] = f"{e['name'][0].upper()}{e['name'][1:]} ({fname[e['floor']]})"
    return ents


def _onto_main_area(out, ents, max_m=15):
    """Move each door onto its floor's main walkable area (a door can land on an exterior walkway drawn
    next to the building). Doors further than max_m from it are dropped. The doors then follow the outline-fit
    placement rather than re-fitting it, so their coordinates are dropped and recomputed by the build."""
    g = out["grid"]; cell = g["cell"]
    kept = []
    for e in ents:
        f = next(fl for fl in out["floors"] if fl["id"] == e["floor"])
        cells = np.zeros(g["w"] * g["h"], np.uint8)
        pos = 0
        for i in range(0, len(f["grid"]), 2):
            cells[pos:pos + f["grid"][i + 1]] = f["grid"][i]
            pos += f["grid"][i + 1]
        open_ = (cells.reshape(g["h"], g["w"]) > 0).astype(np.uint8)
        n, lab, stats, _ = cv2.connectedComponentsWithStats(open_, connectivity=8)
        main = 1 + int(np.argmax(stats[1:, cv2.CC_STAT_AREA]))
        ys, xs = np.nonzero(lab == main)
        cx, cy = (e["cx"] - g["x0"]) / cell, (e["cy"] - g["y0"]) / cell
        d = np.hypot(xs - cx, ys - cy)
        k = int(np.argmin(d))
        if d[k] * cell * out["mPerPx"] > max_m:
            print(f"  skipped {e['name']}: {d[k] * cell * out['mPerPx']:.0f} m from the walkable area")
            continue
        e["x"] += round((xs[k] - cx) * cell); e["y"] += round((ys[k] - cy) * cell)
        kept.append(e)
    for e in kept:
        for k in ("cx", "cy", "lat", "lon"):
            e.pop(k)
    return kept


def build_torgersen(log=lambda m: None):
    images = {f: cv2.imread(str(TORG / f"plans/{pdf}.png"), cv2.IMREAD_GRAYSCALE) for f, _, _, pdf, _ in FLOORS}
    if any(v is None for v in images.values()):
        raise SystemExit("Torgersen plans aren't prepared yet. Run:  python tools/fetch_vt_sources.py  then  "
                         "python tools/vt_buildings.py prepare")
    ocr = {f: [] for f in images}  # room numbers were drawn separately, so the plans carry no text to blank
    # 1st pass: place the plan by its outline; 2nd: OSM's doors (with their floors) become the entrances
    p = torgersen_project([{"name": "provisional", "floor": "first", "x": 600 + PAD, "y": 790 + PAD}])
    out, _, _ = builder.build(p, images, ocr, log=log)
    p = torgersen_project(_name_doors(_onto_main_area(out, _osm_entrances(out, p)), p))
    out, debug, report = builder.build(p, images, ocr, log=log)
    return p, images, out, debug, report


def publish_all(store, save_projects=False):
    """Build and publish every VT building; returns their projects."""
    p, images, out, debug, report = build_torgersen()
    store.publish("buildings", p["id"], out)
    if save_projects:
        for fid, im in images.items():
            pdf = dict((f[0], f[3]) for f in FLOORS)[fid]
            store.put_blob("projects", p["id"], f"source-{fid}", (TORG / f"source/floor-plans-pdf/{pdf}.pdf").read_bytes())
            store.put_blob("projects", p["id"], f"render-{fid}", ingest.encode_png(im))
        store.save("projects", p["id"], p)
        store.put_blob("projects", p["id"], "draft", json.dumps(out).encode())
        for fid, d in debug.items():
            store.put_blob("projects", p["id"], f"debug-{fid}", d)
    print(f"{p['name']}: {report['rooms']} rooms, {report['links']} links, georef {report['georef']}")
    return [p]


if __name__ == "__main__":
    if sys.argv[1:] == ["prepare"]:
        prepare()
