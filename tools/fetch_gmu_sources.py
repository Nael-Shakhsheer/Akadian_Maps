"""Download the public Johnson Center floor plans and directories from GMU's Student Centers site.

These files belong to George Mason University, so they aren't stored in this repository.
Run this once after cloning, before tools/seed_gmu.py:

    python tools/fetch_gmu_sources.py
"""
import pathlib, urllib.request

ROOT = pathlib.Path(__file__).resolve().parent.parent
SRC = ROOT / "data/gmu/johnson-center/source"
BASE = "https://studentcenters.gmu.edu/wp-content/uploads"
FILES = {
    "floor-plans-pdf/JC-Ground-Floor-Plan.pdf": f"{BASE}/2020/11/JC-Ground-Floor-Plan.pdf",
    "floor-plans-pdf/JC-First-Floor-Plan.pdf": f"{BASE}/2020/11/JC-First-Floor-Plan.pdf",
    "floor-plans-pdf/JC-Second-Floor-Plan.pdf": f"{BASE}/2020/11/JC-Second-Floor-Plan.pdf",
    "floor-plans-pdf/JC-Third-Floor-Plan.pdf": f"{BASE}/2020/11/JC-Third-Floor-Plan.pdf",
    "directories/JC-Ground-Directory.png": f"{BASE}/2023/02/JC-GroundFloor.png",
    "directories/JC-First-Directory.png": f"{BASE}/2023/02/JC-First_floor.png",
    "directories/JC-Second-Directory.jpg": f"{BASE}/2023/02/JohnsonCenterFloor2-scaled.jpg",
    "directories/JC-Third-Directory.jpg": f"{BASE}/2023/02/JC-ThirdFloor-scaled.jpg",
}


def main():
    for rel, url in FILES.items():
        dest = SRC / rel
        if dest.exists():
            print(f"have  {rel}")
            continue
        dest.parent.mkdir(parents=True, exist_ok=True)
        req = urllib.request.Request(url, headers={"User-Agent": "AkadianMapEngine/0.1"})
        with urllib.request.urlopen(req, timeout=60) as r:
            dest.write_bytes(r.read())
        print(f"got   {rel}  ({dest.stat().st_size // 1024} KB)")
    print("Done. Next: python tools/seed_gmu.py --publish-only")


if __name__ == "__main__":
    main()
