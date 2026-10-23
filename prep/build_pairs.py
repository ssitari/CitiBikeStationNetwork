"""
build_pairs.py

Full-year trips between every pair of stations, by direction, from the
station-pair OD table (see OD_CSV in common.py). Trip IDs are matched through
the station table, so the two spellings of a lost-zero ID and both sides of an
ID handoff land on the same station.

Trips that start and end at the same station are dropped -- a round trip has
no partner. Trips touching an ID that is not in the station table (Jersey
City, Hoboken, system IDs) are dropped and reported as a share of all trips.

Writes data/cache/pairs.npz: directional arrays src, dst, trips.
"""

import json
from collections import defaultdict

import numpy as np

from common import CACHE, OD_CSV, canon

stations = json.loads((CACHE / "stations.json").read_text(encoding="utf-8"))
node = {sid: i for i, s in enumerate(stations) for sid in s["ids"]}

flows = defaultdict(int)
total = skipped = same = 0
with open(OD_CSV, encoding="utf-8") as f:
    next(f)
    for line in f:
        a, b, _month, _dow, c = line.rstrip("\n").split(",")
        c = int(c)
        total += c
        i, j = node.get(canon(a)), node.get(canon(b))
        if i is None or j is None:
            skipped += c
        elif i == j:
            same += c        # includes trips between two IDs of one merged station
        else:
            flows[(i, j)] += c

src, dst = (np.fromiter((k[n] for k in flows), dtype=np.int32, count=len(flows))
            for n in (0, 1))
trips = np.fromiter(flows.values(), dtype=np.int64, count=len(flows))
np.savez_compressed(CACHE / "pairs.npz", src=src, dst=dst, trips=trips)

undirected = len({(min(i, j), max(i, j)) for i, j in flows})
print(f"Trips in OD table         : {total:,}")
print(f"Unknown station (dropped) : {skipped:,} ({100 * skipped / total:.2f}%)")
print(f"Same station (dropped)    : {same:,}")
print(f"Kept                      : {int(trips.sum()):,} trips")
print(f"Station pairs with trips  : {undirected:,} of {len(stations) * (len(stations) - 1) // 2:,}")
