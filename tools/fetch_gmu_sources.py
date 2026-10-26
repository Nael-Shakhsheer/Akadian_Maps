"""Download GMU's public floor plans (and Johnson Center directories) from the Student Centers site.

These files belong to George Mason University, so they aren't stored in this repository.
Run this once after cloning, before tools/seed_gmu.py:

    python tools/fetch_gmu_sources.py
"""
import pathlib, time, urllib.request

ROOT = pathlib.Path(__file__).resolve().parent.parent
GMU = ROOT / "data/gmu"
BASE = "https://studentcenters.gmu.edu/wp-content/uploads"
FILES = {
    # Johnson Center: 4 floors + the 2023 wayfinding directories (for room names)
    "johnson-center/source/floor-plans-pdf/JC-Ground-Floor-Plan.pdf": f"{BASE}/2020/11/JC-Ground-Floor-Plan.pdf",
    "johnson-center/source/floor-plans-pdf/JC-First-Floor-Plan.pdf": f"{BASE}/2020/11/JC-First-Floor-Plan.pdf",
    "johnson-center/source/floor-plans-pdf/JC-Second-Floor-Plan.pdf": f"{BASE}/2020/11/JC-Second-Floor-Plan.pdf",
    "johnson-center/source/floor-plans-pdf/JC-Third-Floor-Plan.pdf": f"{BASE}/2020/11/JC-Third-Floor-Plan.pdf",
    "johnson-center/source/directories/JC-Ground-Directory.png": f"{BASE}/2023/02/JC-GroundFloor.png",
    "johnson-center/source/directories/JC-First-Directory.png": f"{BASE}/2023/02/JC-First_floor.png",
    "johnson-center/source/directories/JC-Second-Directory.jpg": f"{BASE}/2023/02/JohnsonCenterFloor2-scaled.jpg",
    "johnson-center/source/directories/JC-Third-Directory.jpg": f"{BASE}/2023/02/JC-ThirdFloor-scaled.jpg",
    # Research Hall: floors 1-4 (the lower-level PDF shows only a cut-off sliver of mechanical space)
    "research-hall/source/floor-plans-pdf/Research-1.pdf": f"{BASE}/2020/11/Research-First-Floor-Plan.pdf",
    "research-hall/source/floor-plans-pdf/Research-2.pdf": f"{BASE}/2020/11/Research-Second-Floor-Plan.pdf",
    "research-hall/source/floor-plans-pdf/Research-3.pdf": f"{BASE}/2020/11/Research-Third-Floor-Plan.pdf",
    "research-hall/source/floor-plans-pdf/Research-4.pdf": f"{BASE}/2020/11/Research-Fourth-Floor-Plan.pdf",
    # Merten Hall: only floor 1 is published
    "merten-hall/source/floor-plans-pdf/Merten-1.pdf": f"{BASE}/2020/11/Merten-First-Floor-Plan.pdf",
    # The HUB: floor 1 (updated 2025)
    "the-hub/source/floor-plans-pdf/Hub-1.pdf": f"{BASE}/2025/03/Updated-THE-HUB-1.pdf",
}


def main():
    for rel, url in FILES.items():
        dest = GMU / rel
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
                time.sleep(10 * (attempt + 1))  # the site rate-limits; back off and retry
        print(f"got   {rel}  ({dest.stat().st_size // 1024} KB)")
        time.sleep(1.5)  # be polite
    print("Done. Next: python tools/seed_gmu.py --publish-only")


if __name__ == "__main__":
    main()
