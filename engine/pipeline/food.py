"""Food and coffee spots on campus from OpenStreetMap (restaurants, fast food, cafes, convenience stores).

Published shape: [{"name", "kind", "cuisine", "hours", "lat", "lon", "building", "building_id"}]
"building" is the campus building the spot sits inside (if any), so the app can route indoors to it.
"""
import math

KIND = {"cafe": "Café", "fast_food": "Fast food", "restaurant": "Restaurant", "food_court": "Food court",
        "ice_cream": "Ice cream", "pub": "Pub", "bar": "Bar", "convenience": "Convenience store",
        "coffee": "Coffee", "bakery": "Bakery", "deli": "Deli"}
DUPLICATE_M = 30


def _level(v):
    try:
        return int(float(str(v).split(";")[0]))
    except (TypeError, ValueError):
        return None


def _inside(pt, ring):
    x, y = pt
    hit = False
    for (x1, y1), (x2, y2) in zip(ring, ring[1:]):
        if (y1 > y) != (y2 > y) and x < (x2 - x1) * (y - y1) / (y2 - y1) + x1:
            hit = not hit
    return hit


def _m(a, b):
    kx = 111320 * math.cos(math.radians((a[1] + b[1]) / 2))
    return math.hypot((a[0] - b[0]) * kx, (a[1] - b[1]) * 110540)


def compile_food(elements: list, buildings: list, levels: dict = None) -> list:
    """levels: {"Name@Building": floor level} for spots whose floor OSM doesn't record (studio campus hints)."""
    levels = levels or {}
    out = []
    for e in elements:
        t = e.get("tags", {})
        name = t.get("name")
        if not name:
            continue  # unnamed spots aren't useful to search for
        c = e.get("center", e)
        p = (c["lon"], c["lat"])
        if any(o["name"] == name and _m(p, (o["lon"], o["lat"])) < DUPLICATE_M for o in out):
            continue  # same place mapped as both a point and an outline
        bld = next((b for b in buildings if b.get("name") and _inside(p, b["ring"])), None)
        kind = t.get("amenity") or t.get("shop")
        out.append({"name": name, "kind": KIND.get(kind, kind or "Food"),
                    "cuisine": t.get("cuisine", "").replace("_", " ").replace(";", ", "),
                    "hours": t.get("opening_hours", ""), "lat": round(c["lat"], 7), "lon": round(c["lon"], 7),
                    "building": bld["name"] if bld else None, "building_id": bld["id"] if bld else None,
                    "level": levels.get(f"{name}@{bld['name']}" if bld else name, _level(t.get("level")))})
    return sorted(out, key=lambda f: f["name"].lower())
