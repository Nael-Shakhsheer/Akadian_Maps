"""End-to-end check of the engine's admin + public APIs in a throwaway home folder.

    python -m pytest tests/test_engine.py -q      (or: python tests/test_engine.py)
"""
import json, sys, tempfile, time
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT))
sys.path.insert(0, str(ROOT / "tools"))
from fastapi.testclient import TestClient
from engine.server import admin_app, public_app
import seed_gmu

H = {"x-akadian": "1"}
PASS = "correct horse battery staple"


def wait(c, jid):
    for _ in range(600):
        j = c.get(f"/api/jobs/{jid}").json()
        if j["status"] != "running":
            assert j["status"] == "done", j
            return j["result"]
        time.sleep(0.5)
    raise TimeoutError


def test_engine_end_to_end():
    home = Path(tempfile.mkdtemp())
    a = TestClient(admin_app(home))
    pub = TestClient(public_app(home))

    # locked until set up; setup needs the custom header and a long passphrase
    assert a.get("/api/projects").status_code in (401, 423)
    assert a.post("/api/auth/setup", json={"passphrase": PASS}).status_code == 403
    assert a.post("/api/auth/setup", json={"passphrase": "short"}, headers=H).status_code == 400
    assert a.post("/api/auth/setup", json={"passphrase": PASS}, headers=H).status_code == 200

    # mutating calls without the header (CSRF-style) are refused
    assert a.post("/api/projects", json={"id": "x1", "name": "X"}).status_code == 403
    assert a.post("/api/projects", json={"id": "../evil", "name": "X"}, headers=H).status_code == 400
    assert a.post("/api/projects", json={"id": "gmu-jc", "name": "Johnson Center", "campus": "gmu"}, headers=H).status_code == 200

    # upload a real schematic (public GMU PDF), process it
    pdf = (ROOT / "data/gmu/johnson-center/source/floor-plans-pdf/JC-Third-Floor-Plan.pdf").read_bytes()
    r = a.post("/api/projects/gmu-jc/floors", headers=H, files={"file": ("plan.pdf", pdf, "application/pdf")},
               data={"id": "third", "name": "Floor 3", "level": "3", "prefix": "3"})
    assert r.status_code == 200, r.text
    res = wait(a, r.json()["job"])
    assert res["labels"] > 50

    # nothing on disk is readable without the key
    blobs = list((home / "projects/gmu-jc/blobs").glob("*.enc"))
    assert blobs and all(b"%PDF" not in b.read_bytes()[:64] for b in blobs)
    assert b"Johnson" not in (home / "projects/gmu-jc/settings.enc").read_bytes()

    # the plan image is admin-only; the public server has no such route
    assert a.get("/api/projects/gmu-jc/floors/third/plan.png").headers["content-type"] == "image/png"
    assert pub.get("/api/projects/gmu-jc/floors/third/plan.png").status_code == 404

    # entrances + voids from the seed config, then build
    seed = seed_gmu.jc_project()
    p = a.get("/api/projects/gmu-jc").json()
    p["floors"][0].update(exclude=[[1762, 0, 4000, 4000]])
    ents = [dict(e, floor="third") for e in seed["entrances"] if e["floor"] == "first"]  # same plan frame as floor 3 (offset small)
    r = a.put("/api/projects/gmu-jc", headers=H, json={"floors": p["floors"], "voids": {"third": seed["voids"]["third"]},
                                                       "entrances": ents})
    assert r.status_code == 200
    rep = wait(a, a.post("/api/projects/gmu-jc/build", headers=H).json()["job"])
    assert rep["rooms"] > 40

    # restricted rooms are left out of the published map entirely
    p = a.get("/api/projects/gmu-jc").json()
    lab = next(l for l in p["labels"]["third"] if l["id"] == "344")
    lab["restricted"] = True
    a.put("/api/projects/gmu-jc", headers=H, json={"labels": p["labels"]})
    wait(a, a.post("/api/projects/gmu-jc/build", headers=H).json()["job"])

    # not public until published
    assert pub.get("/api/public/buildings/gmu-jc.json").status_code == 404
    assert a.post("/api/projects/gmu-jc/publish", headers=H).status_code == 200
    m = pub.get("/api/public/buildings/gmu-jc.json").json()
    assert m["floors"][0]["id"] == "third" and not any(r["id"] == "344" for r in m["rooms"])
    assert all(k not in json.dumps(m) for k in ("ocr", "plan.png", "source-"))

    # public side is read-only
    assert pub.post("/api/projects", json={}).status_code in (404, 405)
    assert pub.get("/api/public/buildings/..%2Fvault.json").status_code == 404
    # self-hosted basemap: unknown tiles are empty, odd font paths are refused
    assert pub.get("/api/public/tiles/gmu/14/1/1.pbf").status_code == 204
    assert pub.get("/api/public/tiles/..%2F..%2Fvault/14/1/1.pbf").status_code == 404
    assert pub.get("/api/public/fonts/..%2F..%2Fvault/0-255.pbf").status_code == 404
    assert pub.get("/api/public/fonts/Noto Sans Regular/0-255;rm.pbf").status_code == 404

    # locking ends the session
    assert a.post("/api/auth/lock", headers=H).status_code == 200
    assert a.get("/api/projects").status_code in (401, 423)
    # wrong passphrase is rejected; right one unlocks
    assert a.post("/api/auth/unlock", json={"passphrase": "nope nope nope"}, headers=H).status_code == 401
    assert a.post("/api/auth/unlock", json={"passphrase": PASS}, headers=H).status_code == 200
    assert a.get("/api/projects").json()[0]["published"] is True


def test_four_digit_rooms():
    from engine.pipeline.ingest import labels_from_ocr
    items = [{"text": t, "x": 10 * i, "y": 0, "w": 30, "h": 10, "score": 0.9}
             for i, t in enumerate(["1201A", "12010", "1005", "204", "VEST1"])]
    ids = {l["id"] for l in labels_from_ocr(items, "1", digits=4)}
    assert {"1201A", "1201D", "1005", "VEST1"} <= ids and "204" not in ids, ids
    assert {l["id"] for l in labels_from_ocr(items, "2")} == {"204", "VEST1"}  # default: 3-digit rooms


def test_footprint_fit():
    """A plan with no surveyed entrances is placed by fitting its outline to the footprint."""
    import math
    import cv2
    import numpy as np
    from engine.pipeline.georef import fit_outline
    # an L-shaped building, 60 x 40 m, drawn at 0.05 m/px and rotated 30 degrees on the map
    plan = np.array([[100, 100], [1300, 100], [1300, 500], [700, 500], [700, 900], [100, 900]])
    mask = np.zeros((1000, 1400), np.uint8)
    cv2.fillPoly(mask, [plan.astype(np.int32)], 1)
    th, s = math.radians(30), 0.05
    R = s * np.array([[math.cos(th), -math.sin(th)], [math.sin(th), math.cos(th)]])
    poly_m = np.c_[plan[:, 0], -plan[:, 1]] @ R.T + [5, -3]
    M, _ = fit_outline(mask, poly_m)
    err = np.c_[plan[:, 0], -plan[:, 1]] @ M[:, :2].T + M[:, 2] - poly_m
    assert np.hypot(*err.T).max() < 1.0, err  # corners within a metre
    assert abs(math.hypot(M[0, 0], M[1, 0]) - s) < 0.002


if __name__ == "__main__":
    test_engine_end_to_end()
    test_four_digit_rooms()
    test_footprint_fit()
    print("engine end-to-end, labels, footprint fit: OK")
