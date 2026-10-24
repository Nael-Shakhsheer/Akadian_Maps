"""Self-hosted basemap: download the vector tiles and label fonts for a campus area once, then serve them ourselves.

Tiles use the OpenMapTiles schema (OpenStreetMap data, ODbL) from OpenFreeMap. After the download the public app
needs nothing from outside your server to draw the map.
"""
import gzip, json, math, re, time, urllib.parse, urllib.request
from pathlib import Path

TILEJSON = "https://tiles.openfreemap.org/planet"
FONTS_URL = "https://tiles.openfreemap.org/fonts/{stack}/{range}.pbf"
FONT_STACKS = ["Noto Sans Regular", "Noto Sans Bold"]
FONT_RANGES = ["0-255", "256-511", "8192-8447"]  # Latin, Latin Extended, punctuation (– ’ …)
MIN_Z, MAX_Z = 10, 14  # the map overzooms past 14 using the z14 tiles
UA = {"User-Agent": "AkadianMapEngine/0.1"}


def _get(url: str) -> bytes:
    req = urllib.request.Request(url, headers={**UA, "Accept-Encoding": "gzip"})
    with urllib.request.urlopen(req, timeout=60) as r:
        return r.read()


def tile_range(bounds, z):
    """bounds = [west, south, east, north] -> x0, x1, y0, y1 (inclusive) at zoom z."""
    w, s, e, n = bounds
    def tx(lon): return int((lon + 180) / 360 * 2 ** z)
    def ty(lat):
        r = math.radians(lat)
        return int((1 - math.log(math.tan(r) + 1 / math.cos(r)) / math.pi) / 2 * 2 ** z)
    return tx(w), tx(e), ty(n), ty(s)


def download_tiles(bounds, dest: Path, log=print, zmin=MIN_Z, zmax=MAX_Z) -> dict:
    raw = _get(TILEJSON)
    template = json.loads(gzip.decompress(raw) if raw[:2] == b"\x1f\x8b" else raw)["tiles"][0]
    count = size = 0
    for z in range(zmin, zmax + 1):
        x0, x1, y0, y1 = tile_range(bounds, z)
        n = (x1 - x0 + 1) * (y1 - y0 + 1)
        log(f"zoom {z}: {n} tiles")
        for x in range(x0, x1 + 1):
            for y in range(y0, y1 + 1):
                data = _get(template.replace("{z}", str(z)).replace("{x}", str(x)).replace("{y}", str(y)))
                p = dest / str(z) / str(x) / f"{y}.pbf"
                p.parent.mkdir(parents=True, exist_ok=True)
                p.write_bytes(data)  # kept exactly as served (usually gzip)
                count += 1
                size += len(data)
                time.sleep(0.05)  # be polite to the free tile host
    (dest / "meta.json").write_text(json.dumps({"bounds": bounds, "minzoom": zmin, "maxzoom": zmax, "source": template,
                                                "attribution": "© OpenMapTiles © OpenStreetMap contributors"}))
    log(f"{count} tiles, {size / 1e6:.1f} MB")
    return {"tiles": count, "mb": round(size / 1e6, 1)}


def download_fonts(dest: Path, log=print) -> int:
    n = 0
    for stack in FONT_STACKS:
        for rng in FONT_RANGES:
            p = dest / stack / f"{rng}.pbf"
            if p.exists():
                continue
            p.parent.mkdir(parents=True, exist_ok=True)
            p.write_bytes(_get(FONTS_URL.format(stack=urllib.parse.quote(stack), range=rng)))
            n += 1
    log(f"{n} font files downloaded")
    return n


FONT_RANGE_RE = re.compile(r"^\d{1,5}-\d{1,5}$")
