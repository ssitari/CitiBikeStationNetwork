"""
fit_gravity.py

Fits the gravity model behind "vs. expected" and writes the file the page
loads, data/station_network.json.

Model -- Poisson regression over every pair of stations, including the ~60%
with no trips at all:

    log E[trips_ij] = a_i + a_j + f(km_ij)

a_i is one term per station. It absorbs how busy the station is -- including
being open only part of the year -- so each station's expected total equals
its actual total and the residuals say only *who* it trades with. f is
piecewise linear in log(km), bending at KNOTS_KM: a single power law cannot
fit both the short hops and the long rides. Same model as the CDTA-level
LinkedNetworkGraphChoroplethMap, with the knots moved down to station scale.

~2,200 station terms over ~2.5M pairs is too big for the browser but small
for numpy: pairs are held as dense n x n matrices and the model is solved by
Newton-Raphson on the full Hessian, about a dozen iterations.

For each station the page gets its top MAX_PARTNERS partners by trips, with
trips in each direction and the expected count.
"""

import json
import time

import numpy as np

from common import CACHE, DATA, MONTHS

KNOTS_KM     = [0.5, 1, 2, 4, 8]
MAX_PARTNERS = 50     # the page's slider runs up to this
MIN_KM       = 0.05   # floor on distance, so two docks at one corner stay finite

t0 = time.time()
stations = json.loads((CACHE / "stations.json").read_text(encoding="utf-8"))
pz = np.load(CACHE / "pairs.npz")

n_all = len(stations)
T = np.zeros((n_all, n_all), dtype=np.float64)       # T[i, j] = trips i -> j
np.add.at(T, (pz["src"], pz["dst"]), pz["trips"])

# Stations with no trips to any other station cannot be fitted; drop them.
keep = np.flatnonzero((T.sum(0) + T.sum(1)) > 0)
T = T[np.ix_(keep, keep)]
stations = [stations[i] for i in keep]
n = len(stations)
Y = T + T.T                                            # undirected trips

lat = np.radians([s["lat"] for s in stations])
lon = np.radians([s["lon"] for s in stations])
dx = (lon[None, :] - lon[:, None]) * 6371.0 * np.cos((lat[None, :] + lat[:, None]) / 2)
dy = (lat[None, :] - lat[:, None]) * 6371.0
L  = np.log(np.maximum(np.hypot(dx, dy), MIN_KM))      # log km
del dx, dy

off = ~np.eye(n, dtype=bool)
LOGK = np.log(KNOTS_KM)
K = 1 + len(LOGK)

def basis(k):
    return L if k == 0 else np.maximum(L - LOGK[k - 1], 0.0)

def eta(theta):
    a, b = theta[:n], theta[n:]
    e = a[:, None] + a[None, :]
    for k in range(K):
        e = e + b[k] * basis(k)
    return e

def loglik(theta):
    e = eta(theta)
    return 0.5 * float(np.sum((Y * e - np.exp(e))[off]))

# Start from no distance decay, each station's term set so its trips roughly balance.
mass = Y.sum(1)
theta = np.concatenate([np.log(mass) - 0.5 * np.log(mass.sum()), np.zeros(K)])
ll = loglik(theta)

for it in range(50):
    Mu = np.exp(eta(theta)) * off
    R  = Y - Mu
    B  = [basis(k) for k in range(K)]
    g  = np.concatenate([R.sum(1), [0.5 * np.sum(R * B[k]) for k in range(K)]])
    H  = np.zeros((n + K, n + K))
    H[:n, :n] = Mu + np.diag(Mu.sum(1))
    for k in range(K):
        MB = Mu * B[k]
        H[:n, n + k] = H[n + k, :n] = MB.sum(1)
        for l in range(k, K):
            H[n + k, n + l] = H[n + l, n + k] = 0.5 * np.sum(MB * B[l])
    del B, R
    step = np.linalg.solve(H, g)
    s = 1.0
    while s > 1e-6:
        cand = theta + s * step
        llc = loglik(cand)
        if llc >= ll:
            break
        s /= 2
    else:
        break                     # no improving step: converged as far as floats allow
    theta, ll = cand, llc
    print(f"  iter {it + 1:2d}  step {np.abs(step).max() * s:.2e}  loglik {ll:,.0f}")
    if np.abs(step).max() * s < 1e-8:
        break

Mu = np.exp(eta(theta)) * off

# ── Diagnostics ──────────────────────────────────────────────────────────────
iu = np.triu_indices(n, 1)
y, mu, d = Y[iu], Mu[iu], np.exp(L[iu])
pos = y > 0
dev  = 2 * (np.sum(y[pos] * np.log(y[pos] / mu[pos])) - np.sum(y - mu))
ybar = y.mean()
dev0 = 2 * (np.sum(y[pos] * np.log(y[pos] / ybar)) - np.sum(y - ybar))
slopes = np.cumsum(theta[n:])
print(f"\nStations {n:,} | pairs {len(y):,} ({pos.sum():,} with trips) | {time.time() - t0:.0f} s")
print(f"Deviance explained: {1 - dev / dev0:.3f}")
edges = [0] + KNOTS_KM + [None]
print("Distance-decay slope by segment: " + ", ".join(
    f"{edges[k]}-{edges[k + 1] or ''} km: {slopes[k]:.2f}" for k in range(K)))
print("Actual / expected by distance band:")
for lo, hi in [(0, .5), (.5, 1), (1, 2), (2, 4), (4, 8), (8, 16), (16, 60)]:
    m = (d >= lo) & (d < hi)
    print(f"  {lo:>4}-{hi:<3} km  pairs {m.sum():>9,}  {y[m].sum() / mu[m].sum():.2f}x")

# ── Output ───────────────────────────────────────────────────────────────────
sig = lambda x: float(f"{x:.3g}")
out = []
for i, s in enumerate(stations):
    row = Y[i]
    nz = np.flatnonzero(row)
    top = nz[np.argsort(-row[nz], kind="stable")][:MAX_PARTNERS]
    out.append({
        "id": s["id"], "ids": s["ids"], "name": s["name"],
        "lon": s["lon"], "lat": s["lat"], "active": s["active"],
        "out": int(T[i].sum()), "in": int(T[:, i].sum()),
        # [partner index, trips from this station, trips to it, expected trips both ways]
        "p": [[int(j), int(T[i, j]), int(T[j, i]), sig(Mu[i, j])] for j in top],
    })

meta = {
    "year": 2025,
    "trips": int(T.sum()),
    "deviance_explained": round(1 - dev / dev0, 4),
    "knots_km": KNOTS_KM,
    "slopes": [round(float(x), 3) for x in slopes],
    "max_partners": MAX_PARTNERS,
    "months": MONTHS,
}
path = DATA / "station_network.json"
path.write_text(json.dumps({"meta": meta, "stations": out}, separators=(",", ":")),
                encoding="utf-8")
print(f"\nWrote {path.name}: {path.stat().st_size / 1e6:.1f} MB")
