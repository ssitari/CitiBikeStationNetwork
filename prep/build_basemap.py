"""
build_basemap.py

Borough outlines for the map's backdrop, as plain GeoJSON so the page needs no
TopoJSON library. The source is the water-excluded NYC DCP borough file, as
already quantized to TopoJSON in the CensusGeographies repo (data/borough.json
there, copied to data/source/boroughs_topo.json). Ring winding is kept as-is,
which is what d3-geo expects of this file.

Writes data/boroughs.geojson with one property, the borough name.
"""

import json

from common import BOROUGHS_TOPO, DATA

topo = json.loads(BOROUGHS_TOPO.read_text(encoding="utf-8"))
(sx, sy), (tx, ty) = topo["transform"]["scale"], topo["transform"]["translate"]

# Delta-decode and dequantize every arc once.
arcs = []
for arc in topo["arcs"]:
    x = y = 0
    pts = []
    for dx, dy in arc:
        x += dx
        y += dy
        pts.append([round(x * sx + tx, 5), round(y * sy + ty, 5)])
    arcs.append(pts)

def ring(indices):
    out = []
    for i in indices:
        pts = arcs[i] if i >= 0 else arcs[~i][::-1]
        out.extend(pts if not out else pts[1:])   # arcs share their join point
    return out

features = []
for g in topo["objects"]["borough"]["geometries"]:
    if g["type"] == "Polygon":
        coords = [ring(r) for r in g["arcs"]]
    else:
        coords = [[ring(r) for r in poly] for poly in g["arcs"]]
    name = g["properties"]["NAME"].split(" (")[0]
    features.append({"type": "Feature", "properties": {"name": name},
                     "geometry": {"type": g["type"], "coordinates": coords}})

path = DATA / "boroughs.geojson"
path.write_text(json.dumps({"type": "FeatureCollection", "features": features},
                           separators=(",", ":")), encoding="utf-8")
print(f"Wrote {path.name}: {len(features)} boroughs, {path.stat().st_size / 1e3:.0f} KB")
