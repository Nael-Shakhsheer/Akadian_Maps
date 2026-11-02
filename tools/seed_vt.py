"""Seed the engine with the Virginia Tech demo: the Blacksburg campus layer (OSM) and indoor maps from public plans.

    python tools/seed_vt.py --publish-only   # no vault needed: builds and writes the public map files
    python tools/seed_vt.py                  # asks for your engine passphrase and also saves editable projects
    python tools/seed_vt.py --refresh-osm    # re-download the campus from OpenStreetMap first

Only uses public material in data/vt/ (OpenStreetMap extracts; plan files fetched by tools/fetch_vt_sources.py).
"""
import argparse, getpass, json, os, sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT))
sys.path.insert(0, str(ROOT / "tools"))
from engine.vault import Vault
from engine.store import Store
from engine.pipeline import campus as campus_pipe, basemap

VT = ROOT / "data/vt"
CAMPUS = VT / "campus"
CAMPUS_ID, CAMPUS_NAME, BOUNDARY_REL = "vt", "Virginia Tech – Blacksburg", 1214378
HINTS = {
    "dorms": [],  # VT's residence halls are tagged as dormitories in OSM
    "athletics": ["Cassell Coliseum", "Rector Field House", "Jamerson Athletic Center", "Merryman Athletic Center",
                  "Hahn-Hurst Basketball Practice Center", "Burrows-Burleson Tennis Facility", "Football Locker Room",
                  "McComas Hall", "War Memorial Hall", "Rec Sports Field House"],
    "levels": {"Burruss Hall": 6, "Newman Library": 6, "Squires Student Center": 3, "Torgersen Hall": 3,
               "Goodwin Hall": 4, "Cassell Coliseum": 5, "Owens Hall": 3, "Derring Hall": 6, "Norris Hall": 4,
               "Holden Hall": 4, "Randolph Hall": 4, "Whittemore Hall": 5, "Hahn Hall North": 4, "Hahn Hall South": 4},
    "food_levels": {},
}
RAW_KEYS = ("boundary", "buildings", "areas", "walk", "transit", "food")


def load_raw():
    return {k: (json.loads((CAMPUS / f"{k}.json").read_text(encoding="utf-8"))["elements"]) for k in RAW_KEYS}


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--home", default=str(ROOT / "engine_data"))
    ap.add_argument("--publish-only", action="store_true", help="skip the vault; only write the public map files")
    ap.add_argument("--refresh-osm", action="store_true", help="re-download the campus from OpenStreetMap")
    a = ap.parse_args()
    home = Path(a.home)

    if a.refresh_osm or not (CAMPUS / "buildings.json").exists():
        CAMPUS.mkdir(parents=True, exist_ok=True)
        fresh = campus_pipe.fetch(BOUNDARY_REL, kind="relation")
        for k, v in fresh.items():
            (CAMPUS / f"{k}.json").write_text(json.dumps({"elements": v if isinstance(v, list) else [v]}), encoding="utf-8")

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

    # indoor maps (same pipeline as GMU); each returns its project after publishing
    import vt_buildings
    projects = vt_buildings.publish_all(store, save_projects=not a.publish_only)

    raw = load_raw()
    raw["boundary"] = raw["boundary"][0]
    indoor = {str(p["osm_way"]): f"buildings/{p['id']}.json" for p in projects}
    camp = campus_pipe.compile_campus(CAMPUS_NAME, raw, HINTS, indoor)
    stats = camp.pop("stats")
    camp["card"] = {"short": "Virginia Tech", "place": "Blacksburg, VA", "accent": "#861f41"}  # campus picker
    store.publish("campus", CAMPUS_ID, camp)
    if not a.publish_only:
        store.save("campuses", CAMPUS_ID, {"id": CAMPUS_ID, "name": CAMPUS_NAME, "boundary_way": BOUNDARY_REL,
                                           "boundary_kind": "relation", "hints": HINTS, "raw": raw,
                                           "indoor": {str(p["osm_way"]): p["id"] for p in projects}, "stats": stats})
    print(f"VT campus: {stats}")
    if not (home / f"published/tiles/{CAMPUS_ID}/meta.json").exists():
        w, s, e, n = camp["bounds"]
        basemap.download_tiles([w, s, e, n], home / f"published/tiles/{CAMPUS_ID}")
        basemap.download_fonts(home / "published/fonts")
    print("Published. Open the public map at http://localhost:8080/?campus=vt")


if __name__ == "__main__":
    main()
