#!/usr/bin/env python3
# IQAIR//OS — tick-level REAL vs OTC contrast (Task 53b). Uses the fresh
# real-tick harvest (EURUSD/GBPUSD real) vs the OTC tick archive for the
# OTC twins. The candle-level contrast (otc_real_contrast.py) showed iid
# steps + no vol memory in OTC; this checks the same axes at tick cadence.

import json
import math
from collections import defaultdict

import numpy as np

REAL_F = "/home/z/my-project/mini-services/trading-core/data/real/ticks_real__20261006.jsonl"
OTC_FILES = [
    "/home/z/my-project/mini-services/trading-core/data/otc/ticks100ms__20261006.jsonl",
    "/home/z/my-project/mini-services/trading-core/data/otc/ticks__20261006.csv",
]


def load(paths, want, csv=False):
    per = defaultdict(list)
    seen = set()
    for path in paths:
        with open(path) as fh:
            for line in fh:
                try:
                    if csv:
                        ts, pair, px = line.split(",")
                        k = (pair.strip(), round(float(ts) * 1000), float(px))
                    else:
                        d = json.loads(line)
                        k = (d["t"], int(d["ts"]), float(d["p"]))
                    if k in seen:
                        continue
                    seen.add(k)
                    per[k[0]].append((k[1], k[2]))
                except Exception:
                    pass
    out = {}
    for pair, recs in per.items():
        if pair in want and len(recs) >= 1500:
            recs.sort()
            out[pair] = np.array([r[1] for r in recs])
    return out


def tick_stats(px, rng):
    steps = np.diff(px)
    nz = steps[steps != 0]
    sgn = np.where(nz > 0, 1.0, -1.0)
    n = len(sgn)
    same = float((sgn[1:] == sgn[:-1]).mean())
    z = (same * (n - 1) - (n - 1) / 2) / math.sqrt((n - 1) / 4)
    # tick-level vol clustering: |step| acf1
    a = np.abs(nz)
    a = a - a.mean()
    acf1 = float((a[:-1] * a[1:]).sum() / (a * a).sum()) if (a * a).sum() else 0.0
    # equal-step continuation vs shuffle null
    eq = float((nz[1:] == nz[:-1]).mean())
    mags = np.abs(nz)
    sg2 = np.where(nz > 0, 1.0, -1.0)
    eqs = []
    for _ in range(30):
        rng.shuffle(sg2)
        s2 = sg2 * mags
        eqs.append(float((s2[1:] == s2[:-1]).mean()))
    m = mags - mags.mean()
    kurt = float(((m**4).mean()) / max(1e-18, (m * m).mean() ** 2))
    return {
        "n_decided": n,
        "P_same_sign": round(same, 4),
        "sign_z": round(z, 2),
        "abs_acf1": round(acf1, 4),
        "eq_cont": round(eq, 5),
        "eq_shuf": round(float(np.mean(eqs)), 5),
        "kurtosis": round(kurt, 1),
    }


def main():
    rng = np.random.default_rng(11)
    real = load([REAL_F], {"EURUSD", "GBPUSD"})
    otc = load(OTC_FILES, {"EURUSD-OTC", "GBPUSD-OTC", "JPYTHB-OTC"})
    print("=" * 96)
    print("TICK-LEVEL CONTRAST — real harvested feed vs OTC archive (mixed capture cadence)")
    print("=" * 96)
    print(f"{'stream':16s} {'decided':>8s} {'P(same)':>8s} {'sign_z':>7s} {'|s|acf1':>8s} {'eq_cont':>8s} {'eq_shuf':>8s} {'kurt':>6s}")
    for name, streams in [("REAL", real), ("OTC", otc)]:
        for pair, px in sorted(streams.items()):
            s = tick_stats(px, rng)
            print(f"{pair:16s} {s['n_decided']:8d} {s['P_same_sign']:8.4f} {s['sign_z']:+7.2f} "
                  f"{s['abs_acf1']:8.4f} {s['eq_cont']:8.5f} {s['eq_shuf']:8.5f} {s['kurtosis']:6.1f}")


if __name__ == "__main__":
    main()
