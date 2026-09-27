#!/usr/bin/env python3
"""Build static map layers from OpenStreetMap (Overpass API):

  data/canals.geojson  named canals/rivers/drains in Greater Bangkok, one
                       feature per canal name (MultiLineString)
  data/roads.geojson   named major roads, one feature per OSM way, so the page
                       can colour only the stretch near an incident

Run by .github/workflows/geo-layers.yml (manually or monthly). Stdlib only.
Geometry © OpenStreetMap contributors, ODbL.
"""
import json
import os
import re
import sys
import time
import urllib.parse
import urllib.request

HERE = os.path.dirname(os.path.abspath(__file__))
BBOX = "13.45,100.20,14.20,100.95"  # south,west,north,east
UA = "Floodwatcher/1.0 (+https://github.com/icyice1998/Flood)"
MIRRORS = [
    "https://overpass-api.de/api/interpreter",
    "https://overpass.kumi.systems/api/interpreter",
    "https://overpass.private.coffee/api/interpreter",
]

CANALS_Q = f"""[out:json][timeout:180];
way["waterway"~"^(canal|river|drain|ditch|stream)$"]["name"]({BBOX});
out geom;"""
ROADS_Q = f"""[out:json][timeout:180];
way["highway"~"^(motorway|trunk|primary|secondary|tertiary)$"]["name"]({BBOX});
out geom;"""


def overpass(query):
    last = None
    for url in MIRRORS:
        for attempt in range(2):
            try:
                body = urllib.parse.urlencode({"data": query}).encode()
                req = urllib.request.Request(url, data=body, headers={"User-Agent": UA})
                with urllib.request.urlopen(req, timeout=240) as r:
                    return json.loads(r.read())["elements"]
            except Exception as e:  # noqa: BLE001
                last = e
                print(f"  {url} attempt {attempt + 1}: {e}", file=sys.stderr)
                time.sleep(10)
    raise SystemExit(f"Overpass failed on all mirrors: {last}")


def simplify(pts, tol):
    """Douglas-Peucker on [lon, lat] points (iterative, safe for long ways)."""
    if len(pts) < 3:
        return pts
    keep = [False] * len(pts)
    keep[0] = keep[-1] = True
    stack = [(0, len(pts) - 1)]
    while stack:
        a, b = stack.pop()
        (x1, y1), (x2, y2) = pts[a], pts[b]
        dx, dy = x2 - x1, y2 - y1
        norm = (dx * dx + dy * dy) ** 0.5 or 1e-12
        idx, dmax = -1, tol
        for i in range(a + 1, b):
            x, y = pts[i]
            d = abs(dy * x - dx * y + x2 * y1 - y2 * x1) / norm
            if d > dmax:
                idx, dmax = i, d
        if idx >= 0:
            keep[idx] = True
            stack += [(a, idx), (idx, b)]
    return [p for p, k in zip(pts, keep) if k]


def line(el, tol):
    pts = [[round(p["lon"], 5), round(p["lat"], 5)] for p in el.get("geometry", [])]
    return simplify(pts, tol) if len(pts) > 1 else None


def canal_key(name):
    """Match fetch_data.canal_key: 'คลองลาดพร้าว' / 'แม่น้ำเจ้าพระยา'."""
    name = name.strip()
    if name.startswith("แม่น้ำ"):
        return name.split()[0]
    if not name.startswith("คลอง"):
        return None
    m = re.match(r"คลอง\s*([^\s\-(]+)(?:\s+(\d+)\b)?", name)
    return ("คลอง" + m.group(1) + (" " + m.group(2) if m.group(2) else "")) if m else None


def build_canals():
    els = overpass(CANALS_Q)
    groups, kinds = {}, {}
    for el in els:
        tags = el.get("tags", {})
        key = canal_key(tags.get("name", ""))
        if not key:
            continue
        ln = line(el, 0.00012)
        if ln:
            groups.setdefault(key, []).append(ln)
            if key.startswith("แม่น้ำ"):  # many คลอง are tagged waterway=river in OSM
                kinds[key] = "river"
    feats = [{"type": "Feature", "properties": {"id": k, "name": k, "kind": kinds.get(k, "canal")},
              "geometry": {"type": "MultiLineString", "coordinates": v}} for k, v in sorted(groups.items())]
    return {"type": "FeatureCollection", "attribution": "© OpenStreetMap contributors (ODbL)", "features": feats}


def road_key(name):
    n = re.sub(r"^(ถนน|ถ\.)\s*", "", name.strip())
    return re.sub(r"\s+", "", n)


def build_roads():
    els = overpass(ROADS_Q)
    feats = []
    for el in els:
        tags = el.get("tags", {})
        name = tags.get("name", "")
        ln = line(el, 0.00008)
        if not ln or not name:
            continue
        feats.append({"type": "Feature", "properties": {
            "name": name, "key": road_key(name), "name_en": tags.get("name:en", ""), "ref": tags.get("ref", "")},
            "geometry": {"type": "LineString", "coordinates": ln}})
    return {"type": "FeatureCollection", "attribution": "© OpenStreetMap contributors (ODbL)", "features": feats}


def write(name, gj):
    path = os.path.join(HERE, "data", name)
    s = json.dumps(gj, ensure_ascii=False, separators=(",", ":"))
    with open(path, "w", encoding="utf-8") as f:
        f.write(s)
    print(f"wrote {path}: {len(gj['features'])} features, {len(s) // 1024} KB", file=sys.stderr)


if __name__ == "__main__":
    write("canals.geojson", build_canals())
    time.sleep(5)
    write("roads.geojson", build_roads())
