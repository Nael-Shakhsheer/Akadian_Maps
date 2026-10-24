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


if __name__ == "__main__":
    test_engine_end_to_end()
    print("engine end-to-end: OK")
