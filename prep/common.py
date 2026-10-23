"""Paths and helpers shared by the prep scripts."""

import math
import re
from pathlib import Path

ROOT  = Path(__file__).resolve().parent.parent
DATA  = ROOT / "data"
CACHE = DATA / "cache"
CACHE.mkdir(exist_ok=True)

STATIONS_GPKG = DATA / "source" / "citi_2025_stations.gpkg"
BOROUGHS_TOPO = DATA / "source" / "boroughs_topo.json"

# The station-pair x month x day-of-week table built by build_od_tables.py in
# the sibling LinkedNetworkGraphChoroplethMap repo. It is ~400 MB and gitignored
# there; point this at your copy.
OD_CSV = ROOT.parent / "LinkedNetworkGraphChoroplethMap" / "od_station_month_dow.csv"

MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun",
          "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"]


def canon(sid):
    """Citi Bike IDs look like "6948.10". Wherever one is parsed as a number the
    trailing zero is lost ("6948.1"), and both the GeoPackage and the trip table
    contain such IDs. Restore the second decimal so every spelling matches."""
    sid = sid.strip()
    return sid + "0" if re.fullmatch(r"\d+\.\d", sid) else sid


def km(lat1, lon1, lat2, lon2):
    """Equirectangular distance -- well under 0.1% error at city scale."""
    x = (lon2 - lon1) * 111.32 * math.cos(math.radians((lat1 + lat2) / 2))
    y = (lat2 - lat1) * 110.57
    return math.hypot(x, y)
