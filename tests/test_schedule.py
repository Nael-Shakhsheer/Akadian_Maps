"""Bus timetable step: a small GTFS feed (a loop with a repeating trip and untimed stops) matched to campus stops.

    python tests/test_schedule.py      (no engine dependencies needed)
"""
import io, sys, zipfile
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT))
from engine.pipeline.schedule import read_gtfs, compile_schedule

FEED = {
    "agency.txt": "agency_id,agency_name,agency_url,agency_timezone\n1,CUE Bus - City of Fairfax,http://x,America/New_York\n",
    "routes.txt": "route_id,route_short_name,route_long_name,route_type,route_color\nR1,,Green 1,3,2ba117\n",
    "calendar.txt": "service_id,monday,tuesday,wednesday,thursday,friday,saturday,sunday,start_date,end_date\n"
                    "WK,1,1,1,1,1,0,0,20230828,20501230\n",
    "calendar_dates.txt": "service_id,date,exception_type\nWK,20261126,2\n",
    "stops.txt": "stop_id,stop_name,stop_lat,stop_lon\n"
                 "A,Vienna Metro North Bay C,38.8784,-77.2718\n"
                 "B,Rappahannock Ln at Patriot Circle,38.8300,-77.3070\n"
                 "C,Chain Bridge Rd at School St,38.8400,-77.3090\n",
    "trips.txt": "route_id,service_id,trip_id\nR1,WK,T1\nR1,WK,T2\n",
    # T1 has no time at C (between timepoints); T2 is a template repeated by frequencies.txt
    "stop_times.txt": "trip_id,arrival_time,departure_time,stop_id,stop_sequence,stop_headsign\n"
                      "T1,06:00:00,06:00:00,A,1,Metro-Mason via Pickett\n"
                      "T1,06:20:00,06:20:00,B,2,Metro-Mason via Jermantown\n"
                      "T1,,,C,3,Metro-Mason via Jermantown\n"
                      "T1,06:40:00,06:40:00,A,4,Metro-Mason via Jermantown\n"
                      "T2,23:50:00,23:50:00,A,1,Metro-Mason via Pickett\n"
                      "T2,24:10:00,24:10:00,B,2,Metro-Mason via Jermantown\n"
                      "T2,24:20:00,24:20:00,C,3,Metro-Mason via Jermantown\n"
                      "T2,24:30:00,24:30:00,A,4,Metro-Mason via Jermantown\n",
    "frequencies.txt": "trip_id,start_time,end_time,headway_secs\nT2,23:00:00,23:50:00,1800\n",
}


def zipped(files):
    buf = io.BytesIO()
    with zipfile.ZipFile(buf, "w") as z:
        for name, text in files.items():
            z.writestr(name, text)
    return buf.getvalue()


def test_schedule():
    feed = read_gtfs(zipped(FEED), "https://example.test/cue.zip")
    transit = {"stops": [
        {"name": "GMU Campus (Merten Hall)", "lat": 38.83003, "lon": -77.30702, "lines": [], "networks": []},  # 4 m from B
        {"name": "Bus stop on Chain Bridge Road", "lat": 38.84002, "lon": -77.30899, "lines": ["F29"], "networks": []},  # near C
        {"name": "Bus stop on Braddock Road", "lat": 38.82, "lon": -77.32, "lines": [], "networks": []},  # nothing near
    ], "lines": {}}
    s = compile_schedule([feed], transit)

    assert s["feeds"] == [{"agency": "CUE Bus - City of Fairfax", "url": "https://example.test/cue.zip", "tz": "America/New_York"}]
    assert s["services"] == [{"days": "1111100", "start": "20230828", "end": "20501230", "add": [], "remove": ["20261126"]}]
    assert [x[3] for x in s["stops"]] == [-1, 0, 1]  # Vienna Metro is off campus; B and C match campus stops
    route = s["routes"]["Green 1"]
    assert route["colour"] == "#2ba117"
    (pat,) = route["patterns"]  # both trips call at the same stops
    assert pat["heads"] == ["Metro-Mason via Pickett", "Metro-Mason via Jermantown"] and pat["via"] == [0, 1, 1, 1]
    trips = [m for _, m in pat["trips"]]
    assert trips[0] == [360, 380, 390, 400], "C's time is interpolated between its timepoints"
    assert trips[1:] == [[1380, 1400, 1410, 1420], [1410, 1430, 1440, 1450]], "the template repeats every 30 min, past midnight"

    # campus stops learn the line, the agency, and a real name instead of a made-up one
    assert transit["stops"][0]["name"] == "GMU Campus (Merten Hall)"
    assert transit["stops"][1]["name"] == "Chain Bridge Rd at School St"
    assert transit["stops"][1]["lines"] == ["F29", "Green 1"] and transit["stops"][1]["networks"] == ["CUE Bus"]
    assert transit["stops"][2]["lines"] == []

    # a feed with no trips is refused
    try:
        read_gtfs(zipped({"agency.txt": FEED["agency.txt"]}))
        raise AssertionError("expected a ValueError")
    except ValueError:
        pass


if __name__ == "__main__":
    test_schedule()
    print("schedule: ok")
