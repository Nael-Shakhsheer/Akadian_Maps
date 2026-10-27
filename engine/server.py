"""Two web apps from one engine:

* admin  (127.0.0.1 only): passphrase-protected studio to import schematics, edit, build and publish.
* public (any interface):  the map app + read-only published maps. No uploads, no exports, no schematics.
"""
import json, secrets, threading, time, traceback, uuid
from pathlib import Path

from fastapi import FastAPI, Request, Response, HTTPException, UploadFile, File, Form, Depends
from fastapi.responses import FileResponse, HTMLResponse, JSONResponse
from fastapi.staticfiles import StaticFiles
from starlette.middleware.gzip import GZipMiddleware

from .vault import Vault
from .store import Store, check_slug
from .pipeline import ingest, build as builder, campus as campus_pipe, basemap

ROOT = Path(__file__).resolve().parent.parent
APP_DIR = ROOT / "app"
ADMIN_UI = Path(__file__).resolve().parent / "admin_ui"
MAX_UPLOAD = 60 * 1024 * 1024
SESSION_IDLE = 8 * 3600
COOKIE = "akadian_admin"

SECURITY_HEADERS = {
    "X-Content-Type-Options": "nosniff",
    "Referrer-Policy": "no-referrer",
    "X-Frame-Options": "DENY",
    "Cross-Origin-Opener-Policy": "same-origin",
}


def _headers(app, extra=None):
    # compress text responses (JS, JSON, CSS: ~4x smaller); tiles that are already gzipped are left alone
    app.add_middleware(GZipMiddleware, minimum_size=1024, compresslevel=6)

    @app.middleware("http")
    async def add_headers(request, call_next):
        resp = await call_next(request)
        for k, v in {**SECURITY_HEADERS, **(extra or {})}.items():
            resp.headers.setdefault(k, v)
        return resp


# ======================================================================
# admin
# ======================================================================
def admin_app(home: Path) -> FastAPI:
    vault = Vault(home)
    store = Store(home, vault)
    app = FastAPI(title="Akadian Map Engine (admin)", docs_url=None, redoc_url=None, openapi_url=None)
    _headers(app, {"Cache-Control": "no-store"})
    sessions: dict[str, float] = {}
    failures = {"n": 0, "until": 0.0}
    jobs: dict[str, dict] = {}
    lock = threading.Lock()  # one build/OCR at a time keeps memory use predictable

    # ----- auth -----
    def require_admin(request: Request):
        if not vault.unlocked:
            raise HTTPException(423, "Engine is locked.")
        tok = request.cookies.get(COOKIE)
        if not tok or sessions.get(tok, 0) < time.time():
            raise HTTPException(401, "Sign in again.")
        sessions[tok] = time.time() + SESSION_IDLE
        if request.method != "GET":
            # custom header + same-origin check: blocks cross-site form posts / CSRF
            if request.headers.get("x-akadian") != "1":
                raise HTTPException(403, "Missing request header.")
            origin = request.headers.get("origin")
            if origin and origin.split("://", 1)[-1] != request.headers.get("host"):
                raise HTTPException(403, "Cross-origin request blocked.")

    def start_session(resp: Response):
        tok = secrets.token_urlsafe(32)
        sessions[tok] = time.time() + SESSION_IDLE
        resp.set_cookie(COOKIE, tok, httponly=True, samesite="strict", max_age=SESSION_IDLE)

    @app.get("/api/auth/status")
    def status(request: Request):
        tok = request.cookies.get(COOKIE)
        return {"configured": vault.configured, "unlocked": vault.unlocked,
                "signedIn": bool(vault.unlocked and tok and sessions.get(tok, 0) > time.time())}

    @app.post("/api/auth/setup")
    async def setup(request: Request, response: Response):
        if request.headers.get("x-akadian") != "1":
            raise HTTPException(403)
        body = await request.json()
        try:
            vault.setup(body.get("passphrase", ""))
        except ValueError as e:
            raise HTTPException(400, str(e))
        start_session(response)
        return {"ok": True}

    @app.post("/api/auth/unlock")
    async def unlock(request: Request, response: Response):
        if request.headers.get("x-akadian") != "1":
            raise HTTPException(403)
        if time.time() < failures["until"]:
            raise HTTPException(429, f"Too many attempts. Try again in {int(failures['until'] - time.time())} s.")
        body = await request.json()
        if not vault.configured:
            raise HTTPException(400, "Set up a passphrase first.")
        if not vault.unlock(body.get("passphrase", "")):
            failures["n"] += 1
            if failures["n"] >= 5:
                failures["until"] = time.time() + 60 * (failures["n"] - 4)
            raise HTTPException(401, "Wrong passphrase.")
        failures["n"] = 0
        start_session(response)
        return {"ok": True}

    @app.post("/api/auth/lock", dependencies=[Depends(require_admin)])
    def lock_engine(response: Response):
        vault.lock()
        sessions.clear()
        response.delete_cookie(COOKIE)
        return {"ok": True}

    # ----- background jobs (OCR and builds take a while) -----
    def run_job(kind: str, fn) -> dict:
        jid = uuid.uuid4().hex[:12]
        job = jobs[jid] = {"id": jid, "kind": kind, "status": "running", "log": [], "result": None, "error": None}
        def log(msg):
            job["log"].append(str(msg))
        def target():
            with lock:
                try:
                    job["result"] = fn(log)
                    job["status"] = "done"
                except Exception as e:  # report to the admin UI, keep the server up
                    job["status"] = "error"
                    job["error"] = str(e)
                    job["log"].append(traceback.format_exc(limit=2))
        threading.Thread(target=target, daemon=True).start()
        return {"job": jid}

    @app.get("/api/jobs/{jid}", dependencies=[Depends(require_admin)])
    def job_status(jid: str):
        if jid not in jobs:
            raise HTTPException(404)
        return jobs[jid]

    # ----- buildings (projects) -----
    def load(pid):
        try:
            return store.load("projects", check_slug(pid))
        except (FileNotFoundError, ValueError):
            raise HTTPException(404, "No such building.")

    def floor_of(p, fid):
        f = next((f for f in p["floors"] if f["id"] == fid), None)
        if not f:
            raise HTTPException(404, "No such floor.")
        return f

    @app.get("/api/projects", dependencies=[Depends(require_admin)])
    def projects():
        out = []
        for pid in store.list("projects"):
            p = store.load("projects", pid)
            out.append({"id": pid, "name": p["name"], "campus": p.get("campus"), "floors": len(p["floors"]),
                        "published": store.published_path("buildings", pid).exists(), "built": p.get("built")})
        return out

    @app.post("/api/projects", dependencies=[Depends(require_admin)])
    async def create_project(request: Request):
        b = await request.json()
        try:
            pid = check_slug(b.get("id", ""))
        except ValueError as e:
            raise HTTPException(400, str(e))
        if store.exists("projects", pid):
            raise HTTPException(409, "That id is taken.")
        p = {"id": pid, "name": b.get("name") or pid, "campus": b.get("campus") or "", "osm_way": b.get("osm_way"),
             "floors": [], "labels": {}, "voids": {}, "entrances": [], "extra_links": [], "footprint": None}
        store.save("projects", pid, p)
        return p

    @app.get("/api/projects/{pid}", dependencies=[Depends(require_admin)])
    def get_project(pid: str):
        return load(pid)

    EDITABLE = {"name", "campus", "osm_way", "floors", "labels", "voids", "entrances", "extra_links", "footprint"}

    @app.put("/api/projects/{pid}", dependencies=[Depends(require_admin)])
    async def update_project(pid: str, request: Request):
        p = load(pid)
        body = await request.json()
        for k, v in body.items():
            if k in EDITABLE:
                p[k] = v
        store.save("projects", pid, p)
        return p

    @app.delete("/api/projects/{pid}", dependencies=[Depends(require_admin)])
    def delete_project(pid: str):
        load(pid)
        store.unpublish("buildings", pid)
        store.delete("projects", pid)
        return {"ok": True}

    @app.post("/api/projects/{pid}/floors", dependencies=[Depends(require_admin)])
    async def upload_floor(pid: str, file: UploadFile = File(...), id: str = Form(...), name: str = Form(...),
                           level: int = Form(...), prefix: str = Form("")):
        p = load(pid)
        try:
            fid = check_slug(id)
        except ValueError as e:
            raise HTTPException(400, str(e))
        data = await file.read(MAX_UPLOAD + 1)
        if len(data) > MAX_UPLOAD:
            raise HTTPException(413, "File is larger than 60 MB.")
        try:
            ingest.sniff(data)
        except ValueError as e:
            raise HTTPException(400, str(e))
        store.put_blob("projects", pid, f"source-{fid}", data)
        floors = [f for f in p["floors"] if f["id"] != fid]
        first = not floors
        floors.append({"id": fid, "name": name, "level": level, "prefix": prefix.strip().upper(),
                       "offset": [0, 0], "exclude": [], "reference": first, "processed": False})
        p["floors"] = sorted(floors, key=lambda f: f["level"])
        store.save("projects", pid, p)
        return process_floor(pid, fid)

    @app.post("/api/projects/{pid}/floors/{fid}/process", dependencies=[Depends(require_admin)])
    def process_floor(pid: str, fid: str, relabel: bool = True):
        p = load(pid); floor_of(p, fid)
        def work(log):
            log("Rendering schematic…")
            im = ingest.render(store.get_blob("projects", pid, f"source-{fid}"))
            store.put_blob("projects", pid, f"render-{fid}", ingest.encode_png(im))
            log(f"Plan image {im.shape[1]}×{im.shape[0]} px. Reading labels (on-device OCR)…")
            items = ingest.ocr(im)
            store.put_blob("projects", pid, f"ocr-{fid}", json.dumps(items).encode())
            q = store.load("projects", pid)
            f = floor_of(q, fid)
            f["processed"] = True
            f["size"] = [int(im.shape[1]), int(im.shape[0])]
            if relabel or fid not in q["labels"]:
                q["labels"][fid] = ingest.labels_from_ocr(items, f.get("prefix", ""))
            store.save("projects", pid, q)
            log(f"{len(items)} text boxes, {len(q['labels'][fid])} labels.")
            return {"labels": len(q["labels"][fid])}
        return run_job("process", work)

    @app.delete("/api/projects/{pid}/floors/{fid}", dependencies=[Depends(require_admin)])
    def delete_floor(pid: str, fid: str):
        p = load(pid); floor_of(p, fid)
        p["floors"] = [f for f in p["floors"] if f["id"] != fid]
        p["labels"].pop(fid, None); p["voids"].pop(fid, None)
        store.save("projects", pid, p)
        store.delete_floor_blobs(pid, fid)
        return p

    def png(data):
        if data is None:
            raise HTTPException(404)
        return Response(data, media_type="image/png")

    @app.get("/api/projects/{pid}/floors/{fid}/plan.png", dependencies=[Depends(require_admin)])
    def plan_png(pid: str, fid: str):
        return png(store.get_blob("projects", check_slug(pid), f"render-{check_slug(fid)}"))

    def ref_floor(p):
        return next((f for f in p["floors"] if f.get("reference")), p["floors"][0] if p["floors"] else None)

    @app.post("/api/projects/{pid}/floors/{fid}/auto-align", dependencies=[Depends(require_admin)])
    def auto_align(pid: str, fid: str):
        p = load(pid); f = floor_of(p, fid); ref = ref_floor(p)
        a = ingest.decode_png(store.get_blob("projects", pid, f"render-{ref['id']}"))
        b = ingest.decode_png(store.get_blob("projects", pid, f"render-{fid}"))
        off, conf = builder.auto_offset(a, b)
        return {"offset": off, "confidence": conf}

    @app.get("/api/projects/{pid}/floors/{fid}/overlay.png", dependencies=[Depends(require_admin)])
    def overlay_png(pid: str, fid: str, dx: float = 0, dy: float = 0):
        p = load(pid); floor_of(p, fid); ref = ref_floor(p)
        a = ingest.decode_png(store.get_blob("projects", pid, f"render-{ref['id']}"))
        b = ingest.decode_png(store.get_blob("projects", pid, f"render-{fid}"))
        return png(builder.overlay(a, b, [dx, dy]))

    @app.post("/api/projects/{pid}/build", dependencies=[Depends(require_admin)])
    def build_project(pid: str):
        load(pid)
        def work(log):
            p = store.load("projects", pid)
            images, ocr = {}, {}
            for f in p["floors"]:
                r = store.get_blob("projects", pid, f"render-{f['id']}")
                if r is None:
                    continue
                images[f["id"]] = ingest.decode_png(r)
                ocr[f["id"]] = json.loads(store.get_blob("projects", pid, f"ocr-{f['id']}") or b"[]")
            out, debug, report = builder.build(p, images, ocr, log)
            store.put_blob("projects", pid, "draft", json.dumps(out).encode())
            for fid, d in debug.items():
                store.put_blob("projects", pid, f"debug-{fid}", d)
            p["built"] = time.strftime("%Y-%m-%d %H:%M")
            store.save("projects", pid, p)
            return report
        return run_job("build", work)

    @app.get("/api/projects/{pid}/debug/{fid}.png", dependencies=[Depends(require_admin)])
    def debug_png(pid: str, fid: str):
        return png(store.get_blob("projects", check_slug(pid), f"debug-{check_slug(fid)}"))

    @app.get("/api/projects/{pid}/draft", dependencies=[Depends(require_admin)])
    def draft(pid: str):
        d = store.get_blob("projects", check_slug(pid), "draft")
        if d is None:
            raise HTTPException(404, "Build the map first.")
        return Response(d, media_type="application/json")

    @app.post("/api/projects/{pid}/publish", dependencies=[Depends(require_admin)])
    def publish(pid: str):
        d = store.get_blob("projects", check_slug(pid), "draft")
        if d is None:
            raise HTTPException(400, "Build the map first.")
        store.publish("buildings", pid, json.loads(d))
        return {"ok": True, "url": f"/api/public/buildings/{pid}.json"}

    @app.post("/api/projects/{pid}/unpublish", dependencies=[Depends(require_admin)])
    def unpublish(pid: str):
        store.unpublish("buildings", check_slug(pid))
        return {"ok": True}

    @app.get("/api/osm/building/{way}", dependencies=[Depends(require_admin)])
    def osm_building(way: int):
        try:
            return campus_pipe.fetch_building(way)
        except Exception as e:
            raise HTTPException(502, f"OpenStreetMap lookup failed: {e}")

    # ----- campuses -----
    @app.get("/api/campuses", dependencies=[Depends(require_admin)])
    def campuses():
        out = []
        for cid in store.list("campuses"):
            c = store.load("campuses", cid)
            out.append({"id": cid, "name": c["name"], "boundary_way": c.get("boundary_way"), "fetched": bool(c.get("raw")),
                        "stats": c.get("stats"), "published": store.published_path("campus", cid).exists()})
        return out

    @app.post("/api/campuses", dependencies=[Depends(require_admin)])
    async def create_campus(request: Request):
        b = await request.json()
        try:
            cid = check_slug(b.get("id", ""))
        except ValueError as e:
            raise HTTPException(400, str(e))
        c = {"id": cid, "name": b.get("name") or cid, "boundary_way": int(b["boundary_way"]),
             "hints": b.get("hints") or {"dorms": [], "athletics": [], "levels": {}}, "raw": None, "indoor": {}}
        store.save("campuses", cid, c)
        return {k: v for k, v in c.items() if k != "raw"}

    @app.get("/api/campuses/{cid}", dependencies=[Depends(require_admin)])
    def get_campus(cid: str):
        c = store.load("campuses", check_slug(cid))
        return {k: v for k, v in c.items() if k != "raw"}

    @app.put("/api/campuses/{cid}", dependencies=[Depends(require_admin)])
    async def update_campus(cid: str, request: Request):
        c = store.load("campuses", check_slug(cid))
        b = await request.json()
        for k in ("name", "hints", "indoor", "boundary_way"):
            if k in b:
                c[k] = b[k]
        store.save("campuses", cid, c)
        return {k: v for k, v in c.items() if k != "raw"}

    @app.post("/api/campuses/{cid}/fetch", dependencies=[Depends(require_admin)])
    def fetch_campus(cid: str):
        check_slug(cid)
        def work(log):
            c = store.load("campuses", cid)
            log(f"Downloading public OpenStreetMap data for boundary way {c['boundary_way']}…")
            c["raw"] = campus_pipe.fetch(c["boundary_way"])
            log(f"{len(c['raw']['buildings'])} buildings, {len(c['raw']['areas'])} parking/sports areas.")
            store.save("campuses", cid, c)
            return {"buildings": len(c["raw"]["buildings"]), "areas": len(c["raw"]["areas"])}
        return run_job("fetch", work)

    @app.post("/api/campuses/{cid}/basemap", dependencies=[Depends(require_admin)])
    def campus_basemap(cid: str):
        check_slug(cid)
        def work(log):
            c = store.load("campuses", cid)
            if not c.get("raw"):
                raise ValueError("Fetch the campus from OpenStreetMap first.")
            s, w, n, e = campus_pipe.bbox(c["raw"]["boundary"], margin_m=3000)
            log("Downloading map tiles for the campus area (public OpenStreetMap data)…")
            r = basemap.download_tiles([w, s, e, n], home / "published" / "tiles" / cid, log)
            basemap.download_fonts(home / "published" / "fonts", log)
            return r
        return run_job("basemap", work)

    @app.post("/api/campuses/{cid}/publish", dependencies=[Depends(require_admin)])
    def publish_campus(cid: str):
        c = store.load("campuses", check_slug(cid))
        if not c.get("raw"):
            raise HTTPException(400, "Fetch the campus from OpenStreetMap first.")
        # only link indoor maps that are actually published
        indoor = {way: f"buildings/{bid}.json" for way, bid in c.get("indoor", {}).items()
                  if store.published_path("buildings", bid).exists()}
        out = campus_pipe.compile_campus(c["name"], c["raw"], c.get("hints", {}), indoor)
        c["stats"] = out.pop("stats")
        store.save("campuses", cid, c)
        store.publish("campus", cid, out)
        return {"ok": True, "stats": c["stats"], "indoor": indoor, "url": f"/?campus={cid}"}

    # ----- admin UI -----
    @app.get("/")
    def admin_index():
        return FileResponse(ADMIN_UI / "index.html")

    app.mount("/ui", StaticFiles(directory=ADMIN_UI), name="ui")
    return app


# ======================================================================
# public
# ======================================================================
def public_app(home: Path) -> FastAPI:
    published = home / "published"
    app = FastAPI(title="Akadian Vertex", docs_url=None, redoc_url=None, openapi_url=None)
    # app files revalidate on every load (cheap with ETags) so an update reaches everyone right away;
    # map data and tiles set their own cache times
    _headers(app, {"Cache-Control": "no-cache"})

    def serve_json(kind, id_):
        try:
            p = published / kind / f"{check_slug(id_)}.json"
        except ValueError:
            raise HTTPException(404)
        if not p.exists():
            raise HTTPException(404)
        return FileResponse(p, media_type="application/json", headers={"Cache-Control": "public, max-age=60"})

    @app.get("/api/public/campus/{cid}.json")
    def campus_json(cid: str):
        return serve_json("campus", cid)

    @app.get("/api/public/buildings/{bid}.json")
    def building_json(bid: str):
        return serve_json("buildings", bid)

    def pbf(path: Path):
        if not path.exists():
            return Response(status_code=204)  # outside the downloaded area: empty tile
        data = path.read_bytes()
        headers = {"Cache-Control": "public, max-age=86400"}
        if data[:2] == b"\x1f\x8b":
            headers["Content-Encoding"] = "gzip"
        return Response(data, media_type="application/x-protobuf", headers=headers)

    @app.get("/api/public/tiles/{cid}/{z}/{x}/{y}.pbf")
    def tile(cid: str, z: int, x: int, y: int):
        try:
            check_slug(cid)
        except ValueError:
            raise HTTPException(404)
        return pbf(published / "tiles" / cid / str(z) / str(x) / f"{y}.pbf")

    @app.get("/api/public/fonts/{stack}/{rng}.pbf")
    def font(stack: str, rng: str):
        if stack not in basemap.FONT_STACKS or not basemap.FONT_RANGE_RE.match(rng):
            raise HTTPException(404)
        return pbf(published / "fonts" / stack / f"{rng}.pbf")

    @app.get("/", response_class=HTMLResponse)
    def index():
        html = (APP_DIR / "index.html").read_text(encoding="utf-8")
        return html.replace("<head>", "<head>\n  <script>window.AKADIAN_DATA = '/api/public';</script>", 1)

    app.mount("/", StaticFiles(directory=APP_DIR), name="app")
    return app
