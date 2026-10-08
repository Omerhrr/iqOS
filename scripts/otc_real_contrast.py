#!/usr/bin/env python3
# IQAIR//OS — REAL vs OTC feed contrast (Task 53). Same battery, matched
# depth, real-market controls. The question: which tests SEPARATE the real
# feed from the OTC synthetic — i.e., which microstructure axes did the OTC
# generator not bother to simulate?
#
# Streams: real EURUSD/GBPUSD 1m (fresh 32d sidecar backfill, ~22 FX days)
#          vs OTC EURUSD-OTC/GBPUSD-OTC 1m (harvest, 30d continuous).
# Depth-matched to min(len); weekend-gap returns (>2min) dropped in BOTH.
#
# Tests:
#   C1  flat rate          zero-change 1m closes
#   C2  decided-z          fair-coin directional test (Task 51 protocol)
#   C3  vol clustering     |r| autocorr lags 1..10 + Ljung-Box Q
#   C4  session structure  mean|r| by UTC hour + Kruskal-Wallis
#   C5  step shape         kurtosis, p99/p50 of |r|
#   C6  lag-1 signed acf   mean reversion / momentum
#   C7  runs-z             Wald-Wolfowitz (calibrated battery)
#   C8  ngram OOS z        4-gram (calibrated battery — caught mulberry32)
#   C9  fft peak p         vs shuffle null (calibrated battery)
#
# USAGE: python3 scripts/otc_real_contrast.py

import json
import math
import os
import sys
from collections import defaultdict

import numpy as np

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from otc_csprng_forensics import t_runs, t_ngram, t_fft  # noqa: E402

OTC_DIR = "/home/z/my-project/mini-services/trading-core/data/otc/candles_1m"
REAL_DIR = "/home/z/my-project/mini-services/trading-core/data/real"
OUT = "/home/z/my-project/mini-services/trading-core/data/real/contrast_report.json"


def load_candles(path: str, max_gap_sec: int = 120):
    seen = {}
    with open(path) as fh:
        for line in fh:
            try:
                d = json.loads(line)
                seen[int(d["t"])] = (float(d["o"]), float(d["c"]))
            except Exception:
                pass
    rows = sorted(seen.items())
    t = np.array([r[0] for r in rows], dtype=np.int64)
    c = np.array([r[1][1] for r in rows])
    o = np.array([r[1][0] for r in rows])
    # keep only bar->bar transitions without weekend gaps; align every stat
    # to the SOURCE bar i (t/o/c) with its successor close
    keep = np.diff(t) <= max_gap_sec  # (N-1,)
    t2, o2, c2 = t[:-1][keep], o[:-1][keep], c[:-1][keep]
    t_next, c_next = t[1:][keep], c[1:][keep]
    return t2, o2, c2, t_next, c_next


def analyze(name, t, o, c, t2, c2):
    """o/c = open/close arrays of bar i; t2/c2 = next DECIDED-eligible bar."""
    steps = c2 - c  # close-to-close without weekend gaps
    flat = steps == 0
    nz = steps[~flat]
    signs = np.where(nz > 0, 1.0, -1.0)
    r = {}
    r["stream"] = name
    r["bars"] = int(len(c))
    r["C1_flat_rate"] = round(float(flat.mean()), 4)
    n = len(signs)
    up = float((signs > 0).mean())
    z = (up * n - n / 2) / math.sqrt(n / 4)
    r["C2_decided_z"] = round(z, 2)
    r["C2_up_rate"] = round(up, 4)
    # C3 vol clustering: |r| autocorr + Ljung-Box over lags 1..10
    a = np.abs(steps)
    a = a - a.mean()
    denom = float((a * a).sum())
    rhos = []
    for k in range(1, 11):
        rhos.append(float((a[:-k] * a[k:]).sum()) / denom if denom else 0.0)
    nb = len(a)
    q = nb * (nb + 2) * sum(rho * rho / (nb - k) for k, rho in enumerate(rhos, 1))
    from scipy.stats import chi2 as chi2dist, kruskal
    r["C3_abs_acf_1"] = round(rhos[0], 4)
    r["C3_abs_acf_5"] = round(rhos[4], 4)
    r["C3_ljungbox_p"] = float(f"{chi2dist.sf(q, 10):.3g}")
    # C4 session structure
    hours = ((t2 // 3600) % 24).astype(int)
    byh = defaultdict(list)
    for h, v in zip(hours, np.abs(steps)):
        byh[h].append(v)
    hstat, hp = kruskal(*[np.array(v) for v in byh.values()])
    hr_profile = {str(h): round(float(np.mean(v)) * 1e5, 2) for h, v in sorted(byh.items())}
    r["C4_kruskal_p"] = float(f"{hp:.3g}")
    r["C4_vol_p99_over_p01_hours"] = round(
        float(np.percentile(list(hr_profile.values()), 99) /
              max(1e-9, np.percentile(list(hr_profile.values()), 1))), 1)
    r["C4_hourly_vol_e5"] = hr_profile
    # C5 step shape
    m = np.abs(nz)
    r["C5_kurtosis"] = round(float(((m - m.mean()) ** 4).mean() /
                                   max(1e-18, ((m - m.mean()) ** 2).mean() ** 2)), 1)
    r["C5_p99_over_p50"] = round(float(np.percentile(m, 99) / np.percentile(m, 50)), 1)
    r["C5_min_step"] = float(np.min(m))
    # C6-C9 battery
    r["C6_lag1_acf"] = round(float(np.corrcoef(steps[:-1], steps[1:])[0, 1]), 4)
    r["C7_runs_z"] = round(t_runs(signs), 2)
    zng, tries = t_ngram(signs)
    r["C8_ngram_z"] = round(zng, 2) if zng == zng else None
    r["C8_ngram_n"] = tries
    r["C9_fft_p"] = round(t_fft(signs, nperm=200), 4)
    return r


def main():
    rows = []
    for real, otc in [("EURUSD", "EURUSD-OTC"), ("GBPUSD", "GBPUSD-OTC")]:
        tr, orr, cr, tr2, cr2 = load_candles(os.path.join(REAL_DIR, f"candles_1m__{real}.jsonl"))
        to, oo, co, to2, co2 = load_candles(os.path.join(OTC_DIR, f"candles_1m__{otc}.jsonl"))
        # depth-match: tail-align both to the shorter length
        nmin = min(len(cr), len(co))
        def tail(*arrs):
            return [a[-nmin:] for a in arrs]
        orr, cr, tr, tr2, cr2 = tail(orr, cr, tr, tr2, cr2)
        oo, co, to, to2, co2 = tail(oo, co, to, to2, co2)
        rows.append(analyze(f"REAL {real}", tr, orr, cr, tr2, cr2))
        rows.append(analyze(f"OTC  {otc}", to, oo, co, to2, co2))

    keys = ["C1_flat_rate", "C2_decided_z", "C3_abs_acf_1", "C3_ljungbox_p",
            "C4_kruskal_p", "C4_vol_p99_over_p01_hours", "C5_kurtosis",
            "C5_p99_over_p50", "C6_lag1_acf", "C7_runs_z", "C8_ngram_z", "C9_fft_p"]
    print("=" * 108)
    print("REAL vs OTC feed contrast — 1m closes, depth-matched, gap-filtered")
    print("=" * 108)
    print(f"{'stream':16s} " + " ".join(f"{k:>14s}" for k in keys) + "   bars")
    for r in rows:
        cells = []
        for k in keys:
            v = r[k]
            cells.append(f"{v:.4f}" if isinstance(v, float) else (f"{v:+.2f}" if isinstance(v, (int, float)) and v is not None else "n/a"))
            if isinstance(v, float) and abs(v) >= 1000:
                cells[-1] = f"{v:.3g}"
        print(f"{r['stream']:16s} " + " ".join(f"{c:>14s}" for c in cells) + f"   {r['bars']}")

    print("\nHourly vol profiles (x1e-5):")
    for r in rows:
        prof = r["C4_hourly_vol_e5"]
        line = " ".join(f"{int(h):02d}:{v:.0f}" for h, v in list(prof.items())[::2])
        print(f"  {r['stream']}: {line}")

    with open(OUT, "w") as fh:
        json.dump(rows, fh, indent=1, default=str)
    print(f"\nreport -> {OUT}")


if __name__ == "__main__":
    main()
