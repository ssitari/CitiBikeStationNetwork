# Citi Bike Station Network: NYC Citi Bike trips by station (2025)

A station-level companion to
[LinkedNetworkGraphChoroplethMap](https://github.com/ssitari/LinkedNetworkGraphChoroplethMap), which
links a force-directed network to a map of NYC Community District Tabulation Areas. Districts turned
out to be too coarse for bike trips: the median Citi Bike trip is about 1.6 km in a straight line, and
38% of trips start and end in the same district. This version drops the polygons and works with the
stations themselves.

Each dot on the map is a station. Select one and the map zooms to it and its busiest partners, while
the network panel lays out just that station and those partners, linked by the trips between them.
Click a partner in the network to move to it.

Built with [D3.js](https://d3js.org). No build step — plain HTML, CSS, and JavaScript.

---

## Live demo

[View on GitHub Pages](https://ssitari.github.io/CitiBikeStationNetwork/)

Built for desktop. The map and the network are meant to be read side by side, so below 760px the
page shows a notice rather than a cramped layout.

---

## What it does

- **Station map** — 2,224 stations over the borough outlines. With nothing selected, each is sized
  and colored by its total trips (or by its typical miss in vs. expected mode)
- **Selection** — click a station, search for it by name, or pick a suggested starting point. The map
  zooms to the station and the partners carrying 90% of its shown trips, with lines to each partner
- **Network of partners** — only the selected station and its top partners. Spokes run from the
  selection; partner-to-partner links come from the partners' own top-50 lists, so the layout shows
  which partners also ride with each other
- **Partners shown** — a slider from 10 to 50. The top 10 partners carry a median 24% of a
  station's trips, the top 50 about 56%
- **Edge weight** — trips, or each pair's trips divided by what a gravity model predicts
- **Classed symbols** — counts and typical miss use five quantile classes (ColorBrewer YlGnBu), vs.
  expected uses ColorBrewer RdBu with fixed breaks at 0.5, 0.8, 1.25 and 2×. On the map, size
  repeats the class; the legends label each class with the range of values in view
- **Tooltips** — a station's trips from and to it; with a station selected, the trips between the two

Full year only. Single months at station level are mostly noise: in July, 78% of station pairs with
any trips had fewer than ten.

---

## Vs. expected

Trips between two stations are mostly a function of how busy each is and how far apart they are, so
a layout weighted by raw trips mostly redraws the map. **Vs. expected** compares each pair with a
gravity model's prediction instead, so what stands out is what the model cannot explain.

### The model

A Poisson regression over every pair of stations — 2.47 million pairs, including the 62% with no
trips at all:

```
log E[trips_ij] = a_i + a_j + f(km_ij)
```

- **`a_i`, `a_j`** — one term per station. They absorb how busy each station is, including being open
  for only part of the year, so every station's expected total equals its actual total. What is left
  says only *who* a station trades with.
- **`f(km)`** — straight-line distance as a piecewise-linear curve in log(km), bending at 0.5, 1, 2, 4
  and 8 km. For 2025 the slope is flat under 500 m and only −0.3 out to 1 km, then steepens: −1.7 (1–2 km), −2.3 (2–4), −3.2
  (4–8) and −4.5 beyond 8 km.

It explains **88.7% of the deviance** (the Poisson analogue of R²), lower than the 95.8% of the
district-level model because station-pair counts are far smaller and noisier. Actual and expected
trips agree within 5% in every distance band out to 16 km.

The model is fitted once, offline, by `prep/fit_gravity.py` (numpy, Newton-Raphson on the full
Hessian, about 20 seconds). The page loads each station's top 50 partners with their expected counts.

### What it shows

Most over expected are closed loops: Roosevelt Island's stations ride among themselves (Southpoint
Park to the Tramway at 127×), as do Governors Island's (Yankee Ferry Terminal to Soissons Landing at
99×). Central Park S & 6 Ave to Central Park North runs at 43×, and Albany St in Lower Manhattan to
Riverside Blvd & W 67 St at 59× — 7.8 km up the Hudson River Greenway.

Most under expected are very short hops in Lower Manhattan and Chelsea, 340 m to 1 km apart, most of
them to or from a station on West St (the West Side Highway) or at Chelsea Piers.

With nothing selected in vs. expected mode, the map shows each station's **typical miss**: the
trip-weighted average of how far its partners on show sit from expected, as a factor.

### Caveats

- **Thin pairs produce nonsense ratios.** A pair with a handful of trips can post 50× and mean
  nothing. The partners shown are always a station's busiest, which keeps most of them well clear of
  that, but treat any small pair's ratio with suspicion.
- **Straight-line distance is not route distance.** Rivers, highways and park walls are invisible to
  the model, which is why so many of the strongest results are islands, parks and West St.
- **Partner-to-partner links are incomplete.** A link between two partners appears only when one is
  in the other's top 50.

---

## Running locally

The app loads its data via `fetch()`, so it must be served over HTTP:

```bash
python -m http.server 8000
# then open http://localhost:8000
```

---

## Data pipeline

The prep scripts are in `prep/` and run in order. They need Python 3 and numpy.

1. **`build_stations.py`** — builds the station list from the GeoPackage in `data/source/`. It makes three
   repairs:
   - **Lost trailing zeros.** Citi Bike IDs look like `6948.10`; anywhere one is read as a number it
     becomes `6948.1`. In the GeoPackage this split 95 stations into two rows each under the same
     truncated ID. The zero is restored and the rows summed.
   - **ID handoffs.** Two IDs within 100 m whose active months overlap by at most one are one station
     that moved or was renumbered — the old ID goes quiet the month the new one starts. 2025 has
     eleven; each is merged and placed at the busier ID's location.
   - **Out of scope.** Jersey City and Hoboken stations (their trips are in separate files), plus the
     lab, repair-shop and system IDs, are dropped.
2. **`build_pairs.py`** — full-year trips between each pair of stations, by direction, from the
   station-pair OD table built by `build_od_tables.py` in
   [LinkedNetworkGraphChoroplethMap](https://github.com/ssitari/LinkedNetworkGraphChoroplethMap).
   That table is ~400 MB and not in either repository; set `OD_CSV` in `prep/common.py` to your copy.
   99.9% of trips match a station.
3. **`fit_gravity.py`** — fits the model and writes `data/station_network.json` (2.5 MB), the file the
   page loads.
4. **`build_basemap.py`** — converts the borough outlines to `data/boroughs.geojson`.

Intermediate files go to `data/cache/`, which is not committed.

---

## Data sources

**Trip data:** [Citi Bike System Data](https://citibikenyc.com/system-data), 2025 trip histories.
Licensed under the [NYCBS Data Use Policy](https://ride.citibikenyc.com/data-sharing-policy).

**Station locations:** Columbia University Libraries, *New York City Citibike Stations, 2025*, derived
from the Citi Bike trip data ([download](https://www.columbia.edu/acis/eds/gis/images/citi_2025_stations.zip)).
FGDC metadata is in `data/source/citi_2025_stations.xml`. The published file has the lost-zero
duplicates described above.

**Borough outlines:** New York (N.Y.). Department of City Planning, *New York City Boroughs, 2023*
(water excluded). Via Columbia University Libraries,
[geodata.library.columbia.edu/catalog/columbia-nycp-nybb-2023](https://geodata.library.columbia.edu/catalog/columbia-nycp-nybb-2023),
as prepared for the [CensusGeographies](https://github.com/ssitari/CensusGeographies) project.

---

## Libraries

| Library | Use | License |
|---|---|---|
| [D3.js v7](https://d3js.org) | Map, force simulation, interaction | ISC |
| [NumPy](https://numpy.org) | Model fitting (prep only) | BSD-3-Clause |

---

## Acknowledgements

Color schemes from [ColorBrewer](https://colorbrewer2.org) by Cynthia Brewer.

Most of the code written with assistance from [Claude](https://claude.ai) (Anthropic).

---

## License

MIT — free to use, adapt, and redistribute with attribution.
