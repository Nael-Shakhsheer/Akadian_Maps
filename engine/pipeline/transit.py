"""Bus stops, shuttle stops and bus route lines from OpenStreetMap (public data).

Published shape:
  {"stops":  [{"name", "lat", "lon", "shuttle": bool, "lines": [ref, ...], "networks": [...], "shelter": bool, "bays": n}],
   "lines":  {ref: {"name", "network", "colour", "paths": [[[lon, lat], ...], ...]}}}
"""
import math

GROUP_M = 30          # stops closer than this are bays of one stop
LANDMARK_M = 140      # name unnamed stops after a building this close
SIMPLIFY_M = 4


def _m(a, b):
    kx = 111320 * math.cos(math.radians((a[1] + b[1]) / 2))
    return math.hypot((a[0] - b[0]) * kx, (a[1] - b[1]) * 110540)


def _simplify(pts, eps):
    if len(pts) < 3:
        return pts
    keep = [False] * len(pts); keep[0] = keep[-1] = True
    stack = [(0, len(pts) - 1)]
    while stack:
        a, b = stack.pop()
        best, bi = 0.0, -1
        for i in range(a + 1, b):
            # distance from pts[i] to segment a-b, in metres (local flat approximation)
            ax, ay = pts[a]; bx, by = pts[b]; px, py = pts[i]
            kx = 111320 * math.cos(math.radians(py))
            dx, dy = (bx - ax) * kx, (by - ay) * 110540
            qx, qy = (px - ax) * kx, (py - ay) * 110540
            L2 = dx * dx + dy * dy or 1e-9
            t = max(0, min(1, (qx * dx + qy * dy) / L2))
            d = math.hypot(qx - t * dx, qy - t * dy)
            if d > best:
                best, bi = d, i
        if best > eps:
            keep[bi] = True
            stack += [(a, bi), (bi, b)]
    return [p for p, k in zip(pts, keep) if k]


def _short_name(tags):
    ref, net = tags.get("ref", ""), tags.get("network", "")
    if net == "CUE":
        return f"CUE {ref}"
    if "Metrobus" in net:
        return f"Metrobus {ref}"
    return tags.get("name") or ref


ROAD_M = 45  # name unnamed stops after the road they sit on, if one is this close
ROAD_TYPES = {"primary", "secondary", "tertiary", "residential", "unclassified", "living_street", "service"}


def _nearest_road(p, roads):
    best, name = ROAD_M, None
    for nm, pts in roads:
        for q in pts:
            d = _m(p, q)
            if d < best:
                best, name = d, nm
    return name


def compile_transit(elements: list, buildings: list, bounds, walk_ways=()) -> dict:
    """elements: Overpass output (stop nodes + route relations with geometry); buildings: compiled campus buildings;
    walk_ways: raw OSM highway ways (used to name stops after their road)."""
    roads = [(w["tags"]["name"], [(g["lon"], g["lat"]) for g in w["geometry"]]) for w in walk_ways
             if w.get("type") == "way" and w.get("tags", {}).get("highway") in ROAD_TYPES and w["tags"].get("name") and "geometry" in w]
    w, s, e, n = bounds
    inside = lambda p: w <= p[0] <= e and s <= p[1] <= n
    nodes = [x for x in elements if x["type"] == "node"]
    rels = [x for x in elements if x["type"] == "relation" and "members" in x]

    # which lines stop where
    lines_at, lines = {}, {}
    for r in rels:
        t = r.get("tags", {})
        ref = t.get("ref") or str(r["id"])
        line = lines.setdefault(ref, {"name": _short_name(t), "network": t.get("network", ""),
                                      "colour": t.get("colour", "#2dd4bf"), "ways": {}})
        for m in r["members"]:
            if m["type"] == "node":
                lines_at.setdefault(m["ref"], set()).add(ref)
            elif m["type"] == "way" and "geometry" in m:
                line["ways"][m["ref"]] = [(g["lon"], g["lat"]) for g in m["geometry"]]
    out_lines = {}
    for ref, line in lines.items():
        paths = []
        for pts in line["ways"].values():  # both directions share most ways; dedupe by way id
            run = []
            for p in pts:
                if inside(p):
                    run.append(p)
                elif run:
                    paths.append(run); run = []
            if len(run) > 1:
                paths.append(run)
        paths = [[[round(x, 6), round(y, 6)] for x, y in _simplify(p, SIMPLIFY_M)] for p in paths if len(p) > 1]
        if paths:
            out_lines[ref] = {"name": line["name"], "network": line["network"], "colour": line["colour"], "paths": paths}

    # stops, with nearby bays merged into one
    groups = []
    for x in sorted(nodes, key=lambda x: x["id"]):
        p = (x["lon"], x["lat"])
        if not inside(p):
            continue
        g = next((g for g in groups if _m(g["pts"][0], p) < GROUP_M), None)
        if not g:
            g = {"pts": [], "tags": [], "ids": []}
            groups.append(g)
        g["pts"].append(p); g["tags"].append(x.get("tags", {})); g["ids"].append(x["id"])

    named = [b for b in buildings if b.get("name")]
    stops = []
    for g in groups:
        lon = sum(p[0] for p in g["pts"]) / len(g["pts"])
        lat = sum(p[1] for p in g["pts"]) / len(g["pts"])
        shuttle = any("George Mason" in t.get("operator", "") for t in g["tags"])
        refs = sorted({r for i in g["ids"] for r in lines_at.get(i, ())}, key=lambda r: (len(r), r))
        nets = sorted({n.strip() for t in g["tags"] for n in t.get("network", "").split(";") if n.strip()})
        name = next((t["name"] for t in g["tags"] if t.get("name")), None)
        near = None
        best = LANDMARK_M
        for b in named:
            for q in b["ring"][::2]:
                d = _m((lon, lat), q)
                if d < best:
                    best, near = d, b["name"]
        if not name:
            road = _nearest_road((lon, lat), roads)
            name = ("Mason Shuttle stop" if shuttle else "Bus stop") + (f" on {road}" if road else "") + (f" by {near}" if near else "")
        elif near and name in ("GMU Campus",):
            name = f"{name} ({near})"
        stops.append({"name": name, "lat": round(lat, 7), "lon": round(lon, 7), "shuttle": shuttle,
                      "lines": refs, "networks": (["Mason Shuttles"] if shuttle else []) + nets,
                      "shelter": any(t.get("shelter") == "yes" for t in g["tags"]), "bays": len(g["pts"])})
    return {"stops": stops, "lines": out_lines}
