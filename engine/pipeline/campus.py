"""Campus layer: 3D building shells, parking lots and sports fields from OpenStreetMap (public data only).

The only network access in the engine: fetching public OSM data from Overpass when you ask it to.
"""
import json, math, re, urllib.parse, urllib.request
from collections import Counter

from .walk import compile_walk
from .transit import compile_transit
from .schedule import compile_schedule
from .food import compile_food

OVERPASS = "https://overpass-api.de/api/interpreter"
LEVEL_M = 3.8
SERVICE_WORDS = ("Facilities", "Plant", "Warehouse", "Police", "Archives", "Shops", "Parking Services")


def overpass(query: str) -> list:
    req = urllib.request.Request(OVERPASS, data=urllib.parse.urlencode({"data": query}).encode(),
                                 headers={"User-Agent": "AkadianMapEngine/0.1"})
    with urllib.request.urlopen(req, timeout=120) as r:
        return json.loads(r.read().decode("utf-8"))["elements"]


def fetch(boundary_way: int) -> dict:
    """Download the campus boundary, buildings, parking and sports areas inside it."""
    area = f"way({boundary_way});map_to_area->.c;"
    boundary = overpass(f"[out:json][timeout:60];way({boundary_way});out geom;")
    buildings = overpass(f"[out:json][timeout:90];{area}(way[\"building\"](area.c);relation[\"building\"](area.c););out geom;")
    areas = overpass(f"[out:json][timeout:90];{area}(way[\"amenity\"=\"parking\"](area.c);relation[\"amenity\"=\"parking\"](area.c);"
                     f"way[\"leisure\"~\"^(pitch|stadium|track|sports_centre)$\"](area.c);relation[\"leisure\"~\"^(pitch|stadium|track|sports_centre)$\"](area.c););out geom;")
    if not boundary:
        raise ValueError(f"OSM way {boundary_way} not found.")
    s, w, n, e = bbox(boundary[0], margin_m=400)
    walk = overpass(f"[out:json][timeout:120];way[\"highway\"~\"^({'|'.join(WALK_HIGHWAYS)})$\"]({s},{w},{n},{e});out geom;")
    bb = f"({s},{w},{n},{e})"
    transit = overpass(f"[out:json][timeout:120];(node[\"highway\"=\"bus_stop\"]{bb};"
                       f"node[\"public_transport\"~\"platform|stop_position\"][\"bus\"=\"yes\"]{bb};node[\"amenity\"=\"bus_station\"]{bb};)->.s;"
                       f".s out;rel(bn.s)[\"route\"~\"bus|shuttle\"];out geom;")
    food = overpass(f"[out:json][timeout:90];{area}(nwr[\"amenity\"~\"^(restaurant|fast_food|cafe|food_court|ice_cream|pub|bar)$\"](area.c);"
                    f"nwr[\"shop\"~\"^(convenience|coffee|bakery|deli)$\"](area.c););out center tags;")
    return {"boundary": boundary[0], "buildings": buildings, "areas": areas, "walk": walk, "transit": transit, "food": food}


WALK_HIGHWAYS = ["footway", "path", "pedestrian", "steps", "living_street", "residential", "service", "unclassified",
                 "tertiary", "secondary", "primary", "cycleway", "track", "corridor"]


def bbox(boundary_el, margin_m=0):
    """(south, west, north, east) of the boundary, grown by margin_m metres."""
    lats = [p["lat"] for p in boundary_el["geometry"]]
    lons = [p["lon"] for p in boundary_el["geometry"]]
    dlat = margin_m / 110540
    dlon = margin_m / (111320 * math.cos(math.radians(sum(lats) / len(lats))))
    return min(lats) - dlat, min(lons) - dlon, max(lats) + dlat, max(lons) + dlon


def fetch_building(way_id: int) -> dict:
    """A single building's footprint and tagged entrances (to help place entrances)."""
    els = overpass(f"[out:json][timeout:60];way({way_id});out geom;way({way_id});node(w)[\"entrance\"];out;")
    way = next((e for e in els if e["type"] == "way"), None)
    if not way:
        raise ValueError(f"OSM way {way_id} not found.")
    return {"name": way.get("tags", {}).get("name"), "footprint": [[p["lat"], p["lon"]] for p in way["geometry"]],
            "entrances": [{"osm": e["id"], "lat": e["lat"], "lon": e["lon"], "tags": e.get("tags", {})} for e in els if e["type"] == "node"]}


def category(tags, hints):
    """parking | dorm | athletics | academic | other"""
    name, kind = tags.get("name", ""), tags.get("building")
    if ("Parking" in name and "Services" not in name) or kind == "parking" or tags.get("parking") == "multi-storey":
        return "parking"
    if name in hints.get("athletics", []) or kind in ("stadium", "sports_hall") or tags.get("leisure") in ("stadium", "sports_centre"):
        return "athletics"
    if name in hints.get("dorms", []) or kind in ("dormitory", "residential", "apartments", "house"):
        return "dorm"
    if any(w in name for w in SERVICE_WORDS) or kind in ("garage", "shed", "service", "greenhouse", "roof"):
        return "other"
    if name or kind in ("university", "school", "college"):
        return "academic"
    return "other"


def height(tags, hints):
    if "height" in tags:
        m = re.match(r"[\d.]+", tags["height"])
        if m:
            return float(m.group())
    name = tags.get("name", "")
    levels = hints.get("levels", {})
    if "building:levels" in tags and re.match(r"[\d.]+", tags["building:levels"]):
        lv = float(re.match(r"[\d.]+", tags["building:levels"]).group())
    elif name in levels:
        lv = levels[name]
    elif "Parking Deck" in name:
        lv = 5
    elif "Module" in name or tags.get("building") in ("shed", "garage", "roof", "kiosk"):
        lv = 1
    elif tags.get("building") in ("dormitory", "residential", "apartments") or name.endswith("Hall"):
        lv = 4
    elif name:
        lv = 3
    else:
        lv = 2
    return lv * LEVEL_M


def rings(el):
    if el["type"] == "way":
        return [[[p["lon"], p["lat"]] for p in el["geometry"]]], []
    outer = [[[p["lon"], p["lat"]] for p in m["geometry"]] for m in el["members"] if m.get("role") == "outer" and "geometry" in m]
    inner = [[[p["lon"], p["lat"]] for p in m["geometry"]] for m in el["members"] if m.get("role") == "inner" and "geometry" in m]
    return outer, inner


def _r(ring):
    return [[round(x, 7), round(y, 7)] for x, y in ring]


def compile_campus(name: str, raw: dict, hints: dict, indoor: dict) -> dict:
    """raw: output of fetch(); indoor: {osm way id (str): public path of the building's indoor map}."""
    buildings = []
    for el in raw["buildings"]:
        tags = el.get("tags", {})
        outer, inner = rings(el)
        for o in outer:
            if o[0] != o[-1]:
                o.append(o[0])
            buildings.append({"id": el["id"], "name": tags.get("name"), "h": round(height(tags, hints), 1),
                              "ring": _r(o), "holes": [_r(r) for r in inner],
                              "indoor": indoor.get(str(el["id"])), "cat": category(tags, hints)})
    areas = []
    for el in raw["areas"]:
        tags = el.get("tags", {})
        if tags.get("amenity") == "parking":
            if tags.get("parking") == "multi-storey":
                continue  # decks are drawn as buildings
            cat = "parking"
        elif tags.get("leisure") == "stadium":
            cat = "athletics"
        else:
            cat = "fields"
        outer, inner = rings(el)
        for o in outer:
            if len(o) < 4:
                continue
            if o[0] != o[-1]:
                o.append(o[0])
            label = tags.get("name") or ("Parking" if cat == "parking" else tags.get("sport", "Field").replace("_", " ").title())
            areas.append({"name": label, "cat": cat, "ring": _r(o), "holes": [_r(r) for r in inner]})
    walk = compile_walk(raw.get("walk", []))
    s, w, n, e = bbox(raw["boundary"], margin_m=3000)
    ts, tw, tn, te = bbox(raw["boundary"], margin_m=400)
    transit = compile_transit(raw.get("transit", []), buildings, (tw, ts, te, tn), raw.get("walk", []))
    if raw.get("gtfs"):
        schedule = compile_schedule(raw["gtfs"], transit)
        if schedule:
            transit["schedule"] = schedule
    food = compile_food(raw.get("food", []), buildings, hints.get("food_levels"))
    return {
        "name": name,
        "boundary": [[p["lon"], p["lat"]] for p in raw["boundary"]["geometry"]],
        "bounds": [round(w, 5), round(s, 5), round(e, 5), round(n, 5)],  # area covered by the self-hosted basemap
        "buildings": buildings,
        "areas": areas,
        "walk": walk,
        "transit": transit,
        "food": food,
        "attribution": "© OpenStreetMap contributors (ODbL)",
        "stats": {"buildings": dict(Counter(b["cat"] for b in buildings)), "areas": dict(Counter(a["cat"] for a in areas)),
                  "walk": {"junctions": len(walk["nodes"]), "segments": len(walk["edges"])},
                  "transit": {"stops": len(transit["stops"]), "lines": sorted(transit["lines"]),
                              "timetables": sorted(transit.get("schedule", {}).get("routes", {}))},
                  "food": len(food)},
    }
