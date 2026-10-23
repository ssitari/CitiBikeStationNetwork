"""
build_stations.py

One row per physical station, from the Columbia University Libraries
"New York City Citibike Stations, 2025" GeoPackage (data/source/).

The GeoPackage has one row per station ID, which needs three repairs before
it can serve as the node list:

1. Lost trailing zeros. 196 IDs had their second decimal dropped when parsed as
   numbers, which split 95 stations into two rows each under the same
   truncated ID ("7386.1" with 222 starts and again with 15,668). Restore the
   zero and sum the rows.
2. ID handoffs. When a dock moves a few metres or is renumbered, the old ID
   goes quiet in the month the new one starts. Two IDs within 100 m whose
   active months overlap by at most one are treated as one station, placed at
   the busier ID's location. 2025 has eleven of these.
3. Non-public and out-of-scope IDs. Jersey City and Hoboken (JC*, HB*) are
   dropped -- their trips are in separate files, so they would be nodes
   without data -- along with the lab, repair-shop and system IDs.

Writes data/cache/stations.json.
"""

import json
import sqlite3
from collections import defaultdict

from common import CACHE, MONTHS, STATIONS_GPKG, canon, km

GPKG_MONTHS = ["January", "Febuary", "March", "April", "May", "June", "July",
               "August", "September", "October", "November", "December"]
DROP_IDS    = {"NA", "Lab - NYC - Monolith", "Shop Morgan", "SYS016", "SYS018",
               "SYS033", "SYS038"}
HANDOFF_M   = 100   # metres
HANDOFF_OVERLAP = 1  # months both IDs may be active (the switchover month)

cols = ", ".join(f"start_{m}, end_{m}" for m in GPKG_MONTHS)
db   = sqlite3.connect(f"file:{STATIONS_GPKG.as_posix()}?mode=ro", uri=True)
rows = db.execute(f"SELECT station_id, name, latitude, longitude, {cols} "
                  f"FROM citi_2025_stations").fetchall()

# ── 1. Merge rows that share an ID once its zero is restored ─────────────────
by_id = {}
dropped = defaultdict(int)
for sid, name, lat, lon, *monthly in rows:
    sid = canon(sid)
    if sid in DROP_IDS or sid.startswith(("JC", "HB")):
        dropped["Jersey City / Hoboken" if sid.startswith(("JC", "HB"))
                else "non-public"] += 1
        continue
    act = [(monthly[2 * i] or 0) + (monthly[2 * i + 1] or 0) for i in range(12)]
    s = by_id.get(sid)
    if s is None:
        by_id[sid] = {"id": sid, "name": name.strip(), "lat": lat, "lon": lon,
                      "act": act, "busiest": sum(act)}
    else:
        # The truncated duplicate: same name, same place. Sum the activity and
        # keep the location of whichever row carried more trips.
        if sum(act) > s["busiest"]:
            s.update(lat=lat, lon=lon, busiest=sum(act))
        s["act"] = [a + b for a, b in zip(s["act"], act)]

merged_dupes = len(rows) - sum(dropped.values()) - len(by_id)

# ── 2. Union ID handoffs ─────────────────────────────────────────────────────
ids    = sorted(by_id)
parent = {i: i for i in ids}

def find(i):
    while parent[i] != i:
        parent[i] = parent[parent[i]]
        i = parent[i]
    return i

handoffs = []
for x, a in enumerate(ids):
    A = by_id[a]
    for b in ids[x + 1:]:
        B = by_id[b]
        if abs(A["lat"] - B["lat"]) > 0.001:
            continue
        d = km(A["lat"], A["lon"], B["lat"], B["lon"]) * 1000
        if d > HANDOFF_M:
            continue
        overlap = sum(1 for p, q in zip(A["act"], B["act"]) if p and q)
        if overlap <= HANDOFF_OVERLAP:
            parent[find(b)] = find(a)
            handoffs.append((round(d), a, A["name"], b, B["name"]))

groups = defaultdict(list)
for i in ids:
    groups[find(i)].append(by_id[i])

# ── 3. One node per group ────────────────────────────────────────────────────
stations = []
for members in groups.values():
    members.sort(key=lambda s: -sum(s["act"]))
    lead = members[0]
    act  = [sum(m["act"][k] for m in members) for k in range(12)]
    stations.append({
        "id":     lead["id"],
        "ids":    [m["id"] for m in members],
        "name":   lead["name"],
        "lat":    round(lead["lat"], 6),
        "lon":    round(lead["lon"], 6),
        "active": [k for k in range(12) if act[k]],
    })
stations.sort(key=lambda s: s["id"])

(CACHE / "stations.json").write_text(json.dumps(stations, indent=0), encoding="utf-8")

part_year = sum(len(s["active"]) < 12 for s in stations)
print(f"GeoPackage rows      : {len(rows):,}")
print(f"Dropped              : {dict(dropped)}")
print(f"Duplicate rows merged: {merged_dupes} (lost-zero IDs)")
print(f"ID handoffs merged   : {len(handoffs)}")
for h in sorted(handoffs):
    print(f"    {h[0]:>3} m  {h[1]} {h[2]!r} + {h[3]} {h[4]!r}")
print(f"Stations             : {len(stations):,} ({part_year} active part of the year)")
