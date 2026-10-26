"""Seed the engine with the GMU demo: indoor maps of the Johnson Center, Research Hall, Merten Hall and The HUB
(public GMU floor plans) and the GMU campus layer (OSM).

    python tools/seed_gmu.py                 # asks for your engine passphrase, imports JC as an editable project, publishes
    python tools/seed_gmu.py --publish-only  # no vault needed: just builds and writes the public map files

Only uses public material in data/gmu/ (GMU Student Centers PDFs, OpenStreetMap extracts).
"""
import argparse, getpass, json, os, sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT))
from engine.vault import Vault
from engine.store import Store
from engine.pipeline import ingest, build as builder, campus as campus_pipe, basemap

GMU = ROOT / "data/gmu"
JC = GMU / "johnson-center"
CAMPUS = GMU / "campus"

FLOORS = [  # id, name, level, room prefix, offset relative to Floor 1
    ("ground", "Ground", 0, "G", [0.0, -91.0]),
    ("first", "Floor 1", 1, "1", [0.0, 0.0]),
    ("second", "Floor 2", 2, "2", [-3.6, -105.7]),
    ("third", "Floor 3", 3, "3", [-4.5, 5.0]),
]
_OCT = [[1325, 615], [1325, 760], [1265, 660], [1265, 715], [1390, 660], [1390, 715]]
_UP = [[629, 620], [629, 750], [420, 686], [730, 686], [1076, 620], [1076, 750], [1010, 686], [1140, 686]] + _OCT
VOIDS = {"first": _OCT, "second": _UP, "third": _UP}
NAMES = {
    "G10C": "CEC Network Engineering / Cyber Lab", "G11": "Barnes & Noble Bookstore (lower level)",
    "G18": "Catering Offices", "G19": "Gold Room", "G26": "Dewberry Hall", "G30BD": "Cinema", "G33": "WGMU Radio Station",
    "G34": "Dance Studio", "G35": "Dance Studio", "G38": "Bistro", "G45": "Event Services Offices",
    "112": "Campus Bookstore (Barnes & Noble)", "133": "Patriot Computer Store",
    **{r: "Overflow Seating / Meeting Room" for r in ("117", "118", "119", "120", "121")},
    "134L": "Student Centers Flex Space", "136B": "University Information",
    "213": "Admissions", "218": "Group Study Room", "219": "Group Study Room", "226": "Group Study Room",
    "227E": "The Lab for Writing and Communication", "228": "Office of Undergraduate Education / OSCAR",
    "229": "STAR Lab (Student Technology Assistance & Resource Lab)",
    **{r: "Meeting Room" for r in ("234", "239A", "243", "244", "325", "326", "327", "333", "334", "335", "336", "337")},
    **{r: "Office of Global Education" for r in ("235", "241", "245")}, "239H": "Campus Ministries",
    "240A": "African and African American Studies Resource Center / Paul Robeson Reading Room",
    "240K": "Women and Gender Studies", "311": "CLUB – Collaborative Learning Hub", "312": "Meditation Space",
    "314": "Group Study Room", "315": "Group Study Room", "320": "Group Study Room", "321": "George's",
    "324": "Student Centers Admin Office", **{r: "Computer Lab" for r in ("340", "341", "342", "343")},
    "344": "Math Tutoring Center",
}
ENTRANCES = {  # OSM node -> (floor, vestibule label, nudge onto the doors, name)
    2742432941: ("first", "VEST2", (-45, -35), "North entrance (Aquia Creek side)"),
    2742432932: ("first", "VEST1", (-45, 45), "Northwest entrance"),
    576186181: ("first", "VEST3", (0, -80), "East entrance (main)"),
    2439656056: ("first", "VEST4", (0, 80), "West entrance"),
    2742633911: ("ground", "VEST", (60, 0), "South entrance (lower level)"),
}
HINTS = {
    "dorms": ["Sandbridge", "Tidewater Hall", "Blueridge Hall", "Piedmont Hall", "Northern Neck", "Hampton Roads",
              "Eastern Shore", "Commonwealth Hall", "Dominion Hall", "Liberty Square", "Potomac Heights", "Hanover Hall",
              "Brunswick Hall", "Essex Hall", "Grayson Hall", "Carroll Hall", "Dickenson Hall", "Franklin Hall",
              "Amherst Hall", "Truman Hall", "Monroe Hall", "Jefferson Hall", "Roosevelt Hall", "Harrison Hall",
              "Adams Hall", "Wilson Hall", "Washington Hall", "Lincoln Hall", "Kennedy Hall", "Madison Hall",
              "Jackson Hall", "Whitetop Hall", "Whitetop", "Rogers Hall", "Beacon Hall", "Taylor Hall", "Eisenhower Hall",
              "Masonvale Leasing Office"],
    "athletics": ["Eagle Bank Arena", "EagleBank Arena", "Field House", "Recreation and Athletic Complex",
                  "Aquatic and Fitness Center", "Skyline Fitness", "West PE Module"],
    "levels": {"Johnson Center": 4, "Eagle Bank Arena": 6, "Fenwick Library": 6, "Exploratory Hall": 5,
               "Engineering Building": 5, "Research Hall": 4, "Innovation Hall": 4, "Enterprise Hall": 4,
               "Planetary Hall": 4, "Ángel Cabrera Global Center": 6, "Merten Hall": 4, "Horizon Hall": 5,
               "Peterson Family Health Sciences Hall": 5, "The HUB": 2, "Student Union 1": 3, "Concert Hall": 4},
    # Johnson Center directory: Starbucks is on the Ground floor; the food court is on Floor 1
    "food_levels": {"Starbucks@Johnson Center": 0},
}


def jc_project():
    labels = {}
    for fid, *_ in FLOORS:
        ls = json.loads((JC / f"ocr/{fid}.labels.json").read_text())
        for l in ls:
            if l["id"] in NAMES and l["kind"] == "room":
                l["name"] = NAMES[l["id"]]
        labels[fid] = ls
    osm_ent = {e["id"]: e for e in json.loads((JC / "osm/jc-entrances.json").read_text())["elements"]}
    entrances = []
    for node, (fid, vest, (nx, ny), name) in ENTRANCES.items():
        v = next(l for l in labels[fid] if l["id"] == vest)
        entrances.append({"name": name, "floor": fid, "label": vest, "x": v["x"] + nx, "y": v["y"] + ny,
                          "lat": osm_ent[node]["lat"], "lon": osm_ent[node]["lon"]})
    way = json.loads((JC / "osm/jc-building.json").read_text())["elements"][0]
    return {
        "id": "gmu-jc", "name": "Johnson Center", "campus": "gmu", "osm_way": way["id"],
        "floors": [{"id": f, "name": n, "level": lv, "prefix": px, "offset": off, "reference": f == "first",
                    "exclude": [[1762, 0, 4000, 4000]], "processed": True} for f, n, lv, px, off in FLOORS],
        "labels": labels, "voids": VOIDS, "entrances": entrances,
        "extra_links": [[["ground", "STAIR-LOBBY2"], ["first", "STAIR5"]]],
        "footprint": [[p["lat"], p["lon"]] for p in way["geometry"]],
    }


# Other buildings with public plans. Plans are prepared with tools/prepare_building.py; floors are aligned to the
# reference floor by offsets (checked with build.overlay). Buildings with one tagged OSM entrance are placed on the
# map by fitting the plan outline to the OSM footprint (engine/pipeline/georef.py).
_W = [1755, 0, 1818, 475]  # the PDF viewer's zoom widget baked into GMU's plan images (right edge)
OTHER = [
    {"id": "gmu-research", "name": "Research Hall", "slug": "research-hall",
     # the lower level is left out: GMU's PDF shows only a sliver of mechanical space, cut off at the page edge
     "floors": [("first", "Floor 1", 1, "Research-1", [0, 0], [_W, [1758, 490, 1806, 650]]),
                ("second", "Floor 2", 2, "Research-2", [1.6, -84.7], [_W, [1750, 475, 1818, 1463], [0, 0, 66, 1463]]),
                ("third", "Floor 3", 3, "Research-3", [1.7, -65.8], [_W, [1750, 475, 1818, 1463], [0, 0, 66, 1463]]),
                ("fourth", "Floor 4", 4, "Research-4", [1.8, -56.3], [_W, [1750, 475, 1818, 1463], [0, 0, 66, 1463]])],
     "fix": {"first": {"ELEV": "ELEV2", "+ELEV1": (1141, 745)},
             "second": {"ELEV2": (1141, 705), "ELEV8": "ELEV3"},
             "third": {"ELEV": "ELEV2", "+ELEV1": (1141, 680), "MENS": "MENS1"},
             "fourth": {"ELEV": "ELEV2", "+ELEV1": (1141, 689)}},
     "entrances": [("first", "VEST1", (0, -30), "East entrance"),
                   ("first", "VEST3", (-5, 35), "West entrance (by the rotunda)")]},
    {"id": "gmu-merten", "name": "Merten Hall", "slug": "merten-hall",
     "floors": [("first", "Floor 1", 1, "Merten-1", [0, 0], [[1540, 0, 1818, 1463]])],
     "fix": {"first": {"1201OB": "1201B", "UNISEX301": "UNISEX3", "ELEV": "ELEV1",
                       "+1007": (155, 573), "+1114": (240, 800), "+1116": (240, 740), "+1101A": (455, 768),
                       "+1101B": (403, 728), "+1101C": (330, 735), "+WOMENS2": (853, 503), "+MENS2": (1060, 503),
                       "+WOMENS1": (912, 514), "+MENS1": (993, 514), "+VEST2": (515, 935)}},
     "entrances": [("first", "VEST1", (0, 38), "South entrance (main)"),
                   ("first", "VEST2", (0, 22), "Southwest entrance")], "osm_entrances": {0: 2439656666}},
    {"id": "gmu-hub", "name": "The HUB", "slug": "the-hub",
     # only the lower level (HUB-1) is published; the plan also outlines the wing above it, which is cut out here
     "floors": [("first", "Lower Level", 1, "Hub-1", [0, 0],
                 [[2490, 0, 2561, 1141], [0, 0, 440, 80], [1035, 905, 1182, 990], [1662, 1040, 1797, 1112],
                  [819, 0, 1619, 527], [1619, 0, 1740, 420]])],
     "fix": {"first": {"1004D": "1004A", "1006S": "1006B", "1206I": "1206", "1207I": "1207", "ELEV": "ELEV2",
                       "+1004B": (1372, 689), "+1005": (1349, 727), "+1015": (1369, 929), "+1201": (1428, 936),
                       "+1208": (1527, 1012), "+1209": (1559, 1012), "+1229": (1505, 956), "+1230": (1544, 956),
                       "+1217": (1703, 806), "+1220": (1648, 779), "+MENS1": (1231, 608), "+WOMENS1": (1291, 608),
                       "+STAIR3": (1712, 453), "+ELEV1": (1178, 702), "+ELEV3": (1711, 783)}},
     "entrances": [("first", "VEST2", (-22, 0), "West entrance (lower level)")], "partial": True,
     "osm_entrances": {0: 2742633993}},
]
KINDS = {"VEST": "entrance", "STAIR": "stair", "ELEV": "elevator", "MENS": "restroom", "WOMENS": "restroom",
         "UNISEX": "restroom"}


def plan_project(cfg):
    """A project for one of OTHER: OCR labels + hand fixes, entrances (OSM-tagged doors give the map position)."""
    base = GMU / cfg["slug"]
    labels = {}
    for fid, _, _, name, _, _ in cfg["floors"]:
        ls = {l["id"]: l for l in json.loads((base / f"ocr/{name}.labels.json").read_text())}
        for k, v in cfg.get("fix", {}).get(fid, {}).items():
            if k.startswith("+"):  # a label OCR missed
                i = k[1:]
                kind = next((kd for pre, kd in KINDS.items() if i.startswith(pre)), "room")
                ls[i] = {"id": i, "kind": kind, "x": v[0], "y": v[1]}
            elif isinstance(v, str):  # misread id
                ls[v] = dict(ls.pop(k), id=v)
            else:  # misplaced label
                ls[k] = dict(ls[k], x=v[0], y=v[1])
        labels[fid] = sorted(ls.values(), key=lambda l: (l["kind"], l["id"]))
    way = json.loads((base / "osm/building.json").read_text())["elements"][0]
    tagged = json.loads((base / "osm/entrances.json").read_text())["elements"]
    entrances = []
    for fid, vest, (nx, ny), name in cfg["entrances"]:
        v = next(l for l in labels[fid] if l["id"] == vest)
        entrances.append({"name": name, "floor": fid, "label": vest, "x": v["x"] + nx, "y": v["y"] + ny})
    for e, node in cfg.get("osm_entrances", {}).items():  # entrance index -> OSM node it matches
        n = next(t for t in tagged if t["id"] == node)
        entrances[e].update(lat=n["lat"], lon=n["lon"])
    return {
        "id": cfg["id"], "name": cfg["name"], "campus": "gmu", "osm_way": way["id"],
        "floors": [{"id": f, "name": n, "level": lv, "prefix": "", "offset": off, "reference": off == [0, 0],
                    "exclude": ex, "processed": True, "pdf": pdf} for f, n, lv, pdf, off, ex in cfg["floors"]],
        "labels": labels, "voids": {}, "entrances": entrances, "extra_links": [],
        "footprint": [[p["lat"], p["lon"]] for p in way["geometry"]], "footprint_partial": cfg.get("partial", False),
    }


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--home", default=str(ROOT / "engine_data"))
    ap.add_argument("--publish-only", action="store_true", help="skip the vault; only write the public map files")
    a = ap.parse_args()
    home = Path(a.home)
    missing = [f for f in ("Ground", "First", "Second", "Third") if not (JC / f"source/floor-plans-pdf/JC-{f}-Floor-Plan.pdf").exists()]
    missing += [f[3] for cfg in OTHER for f in cfg["floors"] if not (GMU / cfg["slug"] / f"source/floor-plans-pdf/{f[3]}.pdf").exists()]
    if missing:
        sys.exit("GMU's floor-plan PDFs aren't downloaded yet. Run:  python tools/fetch_gmu_sources.py")
    vault = Vault(home)
    if not a.publish_only:
        pw = os.environ.get("AKADIAN_PASSPHRASE") or getpass.getpass("Engine passphrase: ")
        if vault.configured:
            if not vault.unlock(pw):
                sys.exit("Wrong passphrase.")
        else:
            if pw != getpass.getpass("Repeat passphrase (new vault): "):
                sys.exit("Passphrases don't match.")
            vault.setup(pw)
    store = Store(home, vault)

    jc = jc_project()
    for f in jc["floors"]:
        f["pdf"] = f"JC-{f['id'].capitalize()}-Floor-Plan"
    projects = [(jc, JC, lambda f, pdf: f"ocr/{f['id']}.ocr.json")]
    projects += [(plan_project(cfg), GMU / cfg["slug"], lambda f, pdf: f"ocr/{pdf}.ocr.json") for cfg in OTHER]
    for p, base, ocr_path in projects:
        images, ocr = {}, {}
        for f in p["floors"]:
            pdf = f.pop("pdf")
            src = (base / f"source/floor-plans-pdf/{pdf}.pdf").read_bytes()
            images[f["id"]] = ingest.render(src)
            ocr[f["id"]] = json.loads((base / ocr_path(f, pdf)).read_text())
            f["size"] = [int(images[f["id"]].shape[1]), int(images[f["id"]].shape[0])]
            if not a.publish_only:
                store.put_blob("projects", p["id"], f"source-{f['id']}", src)
                store.put_blob("projects", p["id"], f"render-{f['id']}", ingest.encode_png(images[f["id"]]))
                store.put_blob("projects", p["id"], f"ocr-{f['id']}", json.dumps(ocr[f["id"]]).encode())
        out, debug, report = builder.build(p, images, ocr, log=lambda m: None)
        store.publish("buildings", p["id"], out)
        if not a.publish_only:
            store.save("projects", p["id"], p)
            store.put_blob("projects", p["id"], "draft", json.dumps(out).encode())
            for fid, d in debug.items():
                store.put_blob("projects", p["id"], f"debug-{fid}", d)
        print(f"{p['name']}: {report['rooms']} rooms, {report['links']} links, georef {report['georef']}")

    raw = {"boundary": json.loads((CAMPUS / "boundary.json").read_text(encoding="utf-8"))["elements"][0],
           "buildings": json.loads((CAMPUS / "buildings-raw.json").read_text(encoding="utf-8"))["elements"],
           "areas": json.loads((CAMPUS / "areas-raw.json").read_text(encoding="utf-8"))["elements"],
           "walk": json.loads((CAMPUS / "walk-raw.json").read_text(encoding="utf-8"))["elements"],
           "transit": json.loads((CAMPUS / "transit-raw.json").read_text(encoding="utf-8"))["elements"],
           "food": json.loads((CAMPUS / "food-raw.json").read_text(encoding="utf-8"))["elements"]}
    indoor = {str(p["osm_way"]): f"buildings/{p['id']}.json" for p, _, _ in projects}
    camp = campus_pipe.compile_campus("George Mason University – Fairfax", raw, HINTS, indoor)
    stats = camp.pop("stats")
    store.publish("campus", "gmu", camp)
    if not a.publish_only:
        store.save("campuses", "gmu", {"id": "gmu", "name": camp["name"], "boundary_way": raw["boundary"]["id"],
                                       "hints": HINTS, "raw": raw, "indoor": {str(p["osm_way"]): p["id"] for p, _, _ in projects},
                                       "stats": stats})
    print(f"GMU campus: {stats}")
    if not (home / "published/tiles/gmu/meta.json").exists():
        w, s, e, n = camp["bounds"]
        basemap.download_tiles([w, s, e, n], home / "published/tiles/gmu")
        basemap.download_fonts(home / "published/fonts")
    print("Published. Open the public map at http://localhost:8080")


if __name__ == "__main__":
    main()
