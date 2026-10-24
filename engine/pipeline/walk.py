"""Outdoor walking network from OpenStreetMap ways (sidewalks, footpaths, crossings, campus roads).

The graph is compacted: only junctions are nodes; the points between junctions ride along on each edge.
Published shape:
  {"nodes": [[lon, lat], ...],
   "names": ["Patriot Circle", ...],
   "edges": [[a, b, metres, cost_x10, flags, [lon, lat, ...between points], name_index or -1, kind], ...]}
flags: 1 = steps (skipped by step-free routes)
kind:  "p" path, "s" sidewalk, "c" crosswalk, "t" stairs, "r" road, "v" service road / parking aisle

Most campus footpaths have no name in OSM, so names are inferred where it's safe:
crosswalks take the name of the road they cross, sidewalks the name of the road they run beside.
"""
import math

# How much we prefer each kind of way (cost multiplier on distance). Sidewalks and paths win over roads.
COST = {"footway": 1.0, "pedestrian": 1.0, "path": 1.0, "steps": 1.1, "corridor": 1.0, "cycleway": 1.1,
        "living_street": 1.15, "track": 1.2, "service": 1.3, "residential": 1.3, "unclassified": 1.4,
        "tertiary": 1.6, "secondary": 2.2, "primary": 2.6}
ROADS = {"living_street", "residential", "unclassified", "tertiary", "secondary", "primary"}
NO_FOOT = {"no", "private"}
SIDEWALK_RADIUS_M = 25


def walkable(tags):
    hw = tags.get("highway")
    if hw not in COST:
        return False
    if tags.get("foot") in NO_FOOT or (tags.get("access") in NO_FOOT and tags.get("foot") not in ("yes", "designated")):
        return False
    if hw in ("primary", "secondary") and tags.get("sidewalk") in ("no", "separate"):
        return False  # sidewalks are mapped as their own footways
    return True


def kind_of(tags):
    hw, fw = tags.get("highway"), tags.get("footway")
    if hw == "steps":
        return "t"
    if fw == "crossing" or tags.get("crossing"):
        return "c"
    if fw == "sidewalk":
        return "s"
    if hw in ROADS:
        return "r"
    if hw == "service":
        return "v"
    return "p"


def _dist(a, b):
    kx = 111320 * math.cos(math.radians((a[1] + b[1]) / 2))
    return math.hypot((b[0] - a[0]) * kx, (b[1] - a[1]) * 110540)


def compile_walk(ways: list) -> dict:
    ways = [w for w in ways if w.get("type") == "way" and "geometry" in w and walkable(w.get("tags", {}))]
    coord, uses = {}, {}
    for w in ways:
        for nid, g in zip(w["nodes"], w["geometry"]):
            coord[nid] = (round(g["lon"], 7), round(g["lat"], 7))
            uses[nid] = uses.get(nid, 0) + 1
    junction = lambda nid: uses[nid] > 1

    index, nodes, edges, names = {}, [], [], []
    name_idx = {}
    def node(nid):
        if nid not in index:
            index[nid] = len(nodes)
            nodes.append(list(coord[nid]))
        return index[nid]
    def name_of(s):
        if not s:
            return -1
        if s not in name_idx:
            name_idx[s] = len(names)
            names.append(s)
        return name_idx[s]

    for w in ways:
        t = w["tags"]
        factor = COST[t["highway"]]
        flags = 1 if t["highway"] == "steps" else 0
        kind = kind_of(t)
        nm = name_of(t.get("name"))
        ids = w["nodes"]
        start, between, length = ids[0], [], 0.0
        for i in range(1, len(ids)):
            length += _dist(coord[ids[i - 1]], coord[ids[i]])
            if junction(ids[i]) or i == len(ids) - 1:
                if start != ids[i] or between:
                    edges.append([node(start), node(ids[i]), round(length, 1), round(factor * 10), flags,
                                  [v for nid in between for v in coord[nid]], nm, kind])
                start, between, length = ids[i], [], 0.0
            else:
                between.append(ids[i])
    _infer_names(nodes, edges)
    return _main_component(nodes, edges, names)


def _pts(nodes, e):
    return [nodes[e[0]]] + [e[5][i:i + 2] for i in range(0, len(e[5]), 2)] + [nodes[e[1]]]


def _infer_names(nodes, edges):
    named_roads = [e for e in edges if e[7] in ("r", "v") and e[6] >= 0]
    at_node = {}
    for e in named_roads:
        at_node.setdefault(e[0], []).append(e[6])
        at_node.setdefault(e[1], []).append(e[6])
    # crosswalks: the road meeting either end of the crossing
    for e in edges:
        if e[7] == "c" and e[6] < 0:
            for n in (e[0], e[1]):
                if at_node.get(n):
                    e[6] = at_node[n][0]
                    break
    # sidewalks: the nearest named road within a few metres of the sidewalk's middle
    segs = []
    for e in named_roads:
        if e[7] != "r":
            continue
        p = _pts(nodes, e)
        segs += [(p[i - 1], p[i], e[6]) for i in range(1, len(p))]
    for e in edges:
        if e[7] != "s" or e[6] >= 0:
            continue
        p = _pts(nodes, e)
        mx, my = p[len(p) // 2]
        kx = 111320 * math.cos(math.radians(my))
        best = (SIDEWALK_RADIUS_M, -1)
        for (x1, y1), (x2, y2), nm in segs:
            ax, ay = (x1 - mx) * kx, (y1 - my) * 110540
            bx, by = (x2 - mx) * kx, (y2 - my) * 110540
            dx, dy = bx - ax, by - ay
            L2 = dx * dx + dy * dy or 1e-9
            t = max(0.0, min(1.0, -(ax * dx + ay * dy) / L2))
            d = math.hypot(ax + t * dx, ay + t * dy)
            if d < best[0]:
                best = (d, nm)
        e[6] = best[1]


def _main_component(nodes, edges, names):
    """Keep only the largest connected network (stray path fragments would strand a route)."""
    adj = {}
    for a, b, *_ in edges:
        adj.setdefault(a, []).append(b)
        adj.setdefault(b, []).append(a)
    best, seen = set(), set()
    for start in adj:
        if start in seen:
            continue
        comp, stack = {start}, [start]
        seen.add(start)
        while stack:
            for y in adj[stack.pop()]:
                if y not in seen:
                    seen.add(y); comp.add(y); stack.append(y)
        if len(comp) > len(best):
            best = comp
    remap = {old: i for i, old in enumerate(sorted(best))}
    return {"nodes": [nodes[old] for old in sorted(best)], "names": names,
            "edges": [[remap[a], remap[b], *rest] for a, b, *rest in edges if a in best]}
