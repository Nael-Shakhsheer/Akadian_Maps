"""Download Virginia Tech's public floor plans used by the VT demo.

Torgersen Hall floors 1-3 come from the VT Department of Computer Science's public space-planning page
(people.cs.vt.edu/~ribbens/d/space/). They belong to Virginia Tech, so they aren't stored in this repository.
Run this once after cloning, before tools/vt_buildings.py prepare and tools/seed_vt.py:

    python tools/fetch_vt_sources.py
"""
import pathlib, time, urllib.error, urllib.request

ROOT = pathlib.Path(__file__).resolve().parent.parent
VT = ROOT / "data/vt"
BASE = "https://people.cs.vt.edu/~ribbens/d/space"
FILES = {f"torgersen-hall/source/floor-plans-pdf/Torg{n}.pdf": f"{BASE}/Torg{n}_proposed.pdf" for n in (1, 2, 3)}


def main():
    for rel, url in FILES.items():
        dest = VT / rel
        if dest.exists():
            print(f"have  {rel}")
            continue
        dest.parent.mkdir(parents=True, exist_ok=True)
        req = urllib.request.Request(url, headers={"User-Agent": "AkadianMapEngine/0.1"})
        for attempt in range(4):
            try:
                with urllib.request.urlopen(req, timeout=60) as r:
                    dest.write_bytes(r.read())
                break
            except urllib.error.HTTPError as e:
                if e.code != 429 or attempt == 3:
                    raise
                time.sleep(10 * (attempt + 1))
        print(f"got   {rel}  ({dest.stat().st_size // 1024} KB)")
        time.sleep(1.5)
    print("Done. Next: python tools/vt_buildings.py prepare   then   python tools/seed_vt.py --publish-only")


if __name__ == "__main__":
    main()
