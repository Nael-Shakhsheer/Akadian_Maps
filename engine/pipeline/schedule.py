"""Bus timetables from GTFS feeds (public schedule data, e.g. CUE's), matched to the campus stops.

Only the published schedule: no live positions. Published shape (campus["transit"]["schedule"]):
  {"feeds":    [{"agency", "url", "tz"}],
   "services": [{"days": "1111100" (Mon..Sun), "start": "YYYYMMDD", "end": "YYYYMMDD", "add": [date, ...], "remove": [...]}],
   "stops":    [[name, lat, lon, campus stop index or -1], ...],
   "routes":   {ref: {"name", "colour", "feed": i,
                      "patterns": [{"stops": [stop i, ...], "via": [headsign i per stop], "heads": [headsign, ...],
                                    "trips": [[service i, [minutes after midnight at each stop]], ...]}]}}}
Minutes can pass 1440 for a trip that runs past midnight (GTFS times like 24:30:00).
"""
import csv, io, math, urllib.request, zipfile

MATCH_M = 50  # a feed stop this close to a campus stop is that stop
TABLES = {  # only what the timetable needs
    "agency.txt": ("agency_name", "agency_timezone"),
    "routes.txt": ("route_id", "route_short_name", "route_long_name", "route_color"),
    "trips.txt": ("route_id", "service_id", "trip_id"),
    "stop_times.txt": ("trip_id", "arrival_time", "departure_time", "stop_id", "stop_sequence", "stop_headsign"),
    "stops.txt": ("stop_id", "stop_name", "stop_lat", "stop_lon"),
    "calendar.txt": ("service_id", "monday", "tuesday", "wednesday", "thursday", "friday", "saturday", "sunday",
                     "start_date", "end_date"),
    "calendar_dates.txt": ("service_id", "date", "exception_type"),
    "frequencies.txt": ("trip_id", "start_time", "end_time", "headway_secs"),
}
DAYS = ("monday", "tuesday", "wednesday", "thursday", "friday", "saturday", "sunday")


def read_gtfs(data: bytes, url: str = "") -> dict:
    """The tables of a GTFS zip that the timetable uses, as lists of dicts (stored with the campus's raw data)."""
    z = zipfile.ZipFile(io.BytesIO(data))
    names = {n.rsplit("/", 1)[-1]: n for n in z.namelist()}
    feed = {"url": url}
    for t, cols in TABLES.items():
        if t not in names:
            feed[t] = []
            continue
        rows = csv.DictReader(io.TextIOWrapper(z.open(names[t]), "utf-8-sig"))
        feed[t] = [{c: (r.get(c) or "").strip() for c in cols} for r in rows]
    if not feed["stop_times.txt"] or not feed["trips.txt"]:
        raise ValueError("That file isn't a GTFS feed with trips and stop times.")
    return feed


def fetch_gtfs(url: str) -> dict:
    """Download a published GTFS feed (public schedule data)."""
    req = urllib.request.Request(url, headers={"User-Agent": "AkadianMapEngine/0.1"})
    with urllib.request.urlopen(req, timeout=120) as r:
        return read_gtfs(r.read(), url)


def _m(a, b):
    kx = 111320 * math.cos(math.radians((a[1] + b[1]) / 2))
    return math.hypot((a[0] - b[0]) * kx, (a[1] - b[1]) * 110540)


def _mins(t):
    if not t:
        return None
    h, m, *s = (int(x) for x in t.split(":"))
    return h * 60 + m + round((s[0] if s else 0) / 60)


def _interpolate(times):
    """GTFS allows times only at timepoints; fill the stops between them evenly."""
    known = [i for i, t in enumerate(times) if t is not None]
    if not known:
        return None
    out = list(times)
    for a, b in zip(known, known[1:]):
        for i in range(a + 1, b):
            out[i] = round(times[a] + (times[b] - times[a]) * (i - a) / (b - a))
    for i in range(known[0]):
        out[i] = times[known[0]]
    for i in range(known[-1] + 1, len(out)):
        out[i] = times[known[-1]]
    return out


def _generated(name):
    # compile_transit names unnamed OSM stops itself; a feed's own stop name is better than those
    return name.startswith(("Bus stop", "Mason Shuttle stop"))


def compile_schedule(feeds: list, transit: dict) -> dict | None:
    """feeds: read_gtfs() outputs; transit: compile_transit() output. Adds the feeds' lines to the campus stops
    they serve (and names unnamed stops after the feed), and returns the timetable."""
    stops_out, stop_ix = [], {}  # (feed i, stop_id) -> index into stops_out
    services, service_ix = [], {}
    routes = {}
    feeds_out = []
    for fi, f in enumerate(feeds):
        agency = (f["agency.txt"] or [{}])[0]
        feeds_out.append({"agency": agency.get("agency_name", ""), "url": f.get("url", ""),
                          "tz": agency.get("agency_timezone") or "America/New_York"})
        gstops = {s["stop_id"]: s for s in f["stops.txt"]}
        trips = {t["trip_id"]: t for t in f["trips.txt"]}
        route_rows = {r["route_id"]: r for r in f["routes.txt"]}
        cal = {c["service_id"]: c for c in f["calendar.txt"]}
        extra = {}
        for d in f["calendar_dates.txt"]:
            extra.setdefault(d["service_id"], {"add": [], "remove": []})["add" if d["exception_type"] == "1" else "remove"].append(d["date"])

        def service(sid):
            key = (fi, sid)
            if key not in service_ix:
                c = cal.get(sid, {})
                ex = extra.get(sid, {"add": [], "remove": []})
                service_ix[key] = len(services)
                services.append({"days": "".join(c.get(d) or "0" for d in DAYS), "start": c.get("start_date", ""),
                                 "end": c.get("end_date", ""), "add": sorted(ex["add"]), "remove": sorted(ex["remove"])})
            return service_ix[key]

        def stop(sid):
            key = (fi, sid)
            if key not in stop_ix:
                s = gstops[sid]
                p = (float(s["stop_lon"]), float(s["stop_lat"]))
                near = min(((_m(p, (c["lon"], c["lat"])), i) for i, c in enumerate(transit["stops"])), default=(1e9, -1))
                stop_ix[key] = len(stops_out)
                stops_out.append([s["stop_name"], round(p[1], 6), round(p[0], 6), near[1] if near[0] <= MATCH_M else -1])
            return stop_ix[key]

        times = {}
        for st in f["stop_times.txt"]:
            times.setdefault(st["trip_id"], []).append(st)
        freq = {}
        for q in f["frequencies.txt"]:
            freq.setdefault(q["trip_id"], []).append(q)

        patterns = {}  # (route ref, stop sequence) -> pattern
        for tid, sts in times.items():
            t = trips.get(tid)
            if not t:
                continue
            sts.sort(key=lambda x: int(x["stop_sequence"]))
            mins = _interpolate([_mins(x["departure_time"] or x["arrival_time"]) for x in sts])
            if mins is None:
                continue
            seq = tuple(stop(x["stop_id"]) for x in sts)
            r = route_rows.get(t["route_id"], {})
            ref = r.get("route_long_name") or r.get("route_short_name") or t["route_id"]
            route = routes.setdefault(ref, {"name": ref, "colour": "#" + (r.get("route_color") or "2dd4bf"), "feed": fi, "patterns": []})
            pat = patterns.get((ref, seq))
            if not pat:
                heads = list(dict.fromkeys(x["stop_headsign"] for x in sts))
                pat = {"stops": list(seq), "via": [heads.index(x["stop_headsign"]) for x in sts], "heads": heads, "trips": []}
                patterns[(ref, seq)] = pat
                route["patterns"].append(pat)
            svc = service(t["service_id"])
            if tid in freq:  # a template trip that repeats every headway_secs
                for q in freq[tid]:
                    start, end, step = _mins(q["start_time"]), _mins(q["end_time"]), max(1, round(int(q["headway_secs"]) / 60))
                    for s in range(start, end, step):
                        pat["trips"].append([svc, [m - mins[0] + s for m in mins]])
            else:
                pat["trips"].append([svc, mins])

        # what the map knows about these lines at each campus stop
        for ref, route in routes.items():
            if route["feed"] != fi:
                continue
            for pat in route["patterns"]:
                pat["trips"].sort(key=lambda x: (x[0], x[1][0]))
                for si in pat["stops"]:
                    name, _, _, ci = stops_out[si]
                    if ci < 0:
                        continue
                    c = transit["stops"][ci]
                    if ref not in c["lines"]:
                        c["lines"].append(ref)
                    if _generated(c["name"]) and all(o["name"] != name for o in transit["stops"]):
                        c["name"] = name  # (names are how saved and recent places find a stop, so keep them unique)
                    agency = feeds_out[fi]["agency"].split(" - ")[0]
                    if agency and not any(n in agency or agency in n for n in c["networks"]):  # OSM may say "CUE"
                        c["networks"].append(agency)

    if not routes:
        return None
    for c in transit["stops"]:
        c["lines"].sort(key=lambda r: (len(r), r))
    return {"feeds": feeds_out, "services": services, "stops": stops_out, "routes": routes}
