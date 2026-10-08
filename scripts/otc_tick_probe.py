#!/usr/bin/env python3
# IQAIR//OS - OTC tick-level microstructure probe (Task 50 follow-up to the
# 1m battery). The 1m battery found: zero time-series structure BUT a 2e-5
# price lattice with ~2% off-lattice values clustered in short runs - the
# fingerprint of an ANCHOR + INTERPOLATION generator. At candle level that
# architecture is nearly invisible; at TICK level it should be blatant:
#   - stair-steps: long runs where the price does not move at all (anchors
#     held between generator updates)
#   - constant-velocity runs: consecutive equal-sized steps (linear
#     interpolation between two anchor levels)
#   - lattice purity: every tick on the 2e-5 grid
#
# If interpolation is real, the part of a segment AFTER the anchor is
# mechanically determined -> a genuine, tradeable next-move edge for
# short-expiry binaries. If ticks are clean random walks, the defense
# verdict hardens. Either way we learn the truth.
#
# USAGE: python3 scripts/otc_tick_probe.py [--minutes 5] [--pairs X,Y]

import argparse
import csv
import glob
import math
import os
from collections import defaultdict

DATA_DIR = "/home/z/my-project/mini-services/trading-core/data/otc"


def load_ticks(minutes: int, pairs: set[str] | None):
    """Newest-first across tick CSVs; keeps the last `minutes` of data."""
    files = sorted(glob.glob(os.path.join(DATA_DIR, "ticks__*.csv")))
    if not files:
        return {}
    rows = defaultdict(list)
    cutoff = None
    for f in reversed(files):
        with open(f) as fh:
            for line in fh:
                pass
        # stream the newest file fully, older files only if needed
    # simpler: parse newest file entirely (rotates at 50MB)
    with open(files[-1]) as fh:
        rdr = csv.reader(fh)
        recs = list(rdr)
    if not recs:
        return {}
    t_end = float(recs[-1][0])
    cutoff = t_end - minutes * 60
    for ts, ticker, price in recs:
        if float(ts) < cutoff:
            continue
        if pairs and ticker not in pairs:
            continue
        try:
            rows[ticker].append((float(ts), float(price)))
        except ValueError:
            continue
    for k in rows:
        rows[k].sort()
    return rows


def probe_series(t, p) -> dict:
    n = len(p)
    if n < 120:
        return {}
    steps = [p[i + 1] - p[i] for i in range(n - 1)]
    zero = sum(1 for s in steps if abs(s) < 1e-12)
    # equal-step runs (constant velocity) at 1e-9 tolerance
    eq_runs, cur = [], 0
    for i in range(1, len(steps)):
        if abs(steps[i] - steps[i - 1]) < 1e-9 and abs(steps[i]) > 1e-12:
            cur += 1
        else:
            if cur >= 2:
                eq_runs.append(cur + 1)
            cur = 0
    if cur >= 2:
        eq_runs.append(cur + 1)
    # lattice: even last digit at 1e-5
    lat = sum(1 for x in p if int(round(x * 1e5)) % 2 == 0) / n
    # unique price levels (staircase breadth)
    return {
        "n": n,
        "zero_frac": round(zero / max(1, len(steps)), 4),
        "eq_run_max": max(eq_runs) if eq_runs else 0,
        "eq_run_count": len(eq_runs),
        "even_frac": round(lat, 4),
        "levels": len(set(p)),
        "span_s": round(t[-1] - t[0], 1),
    }


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--minutes", type=int, default=5)
    ap.add_argument("--pairs", type=str, default="")
    args = ap.parse_args()
    pairs = {p.strip() for p in args.pairs.split(",")} if args.pairs else None
    rows = load_ticks(args.minutes, pairs)
    if not rows:
        print("no tick data yet - harvester live phase not running?")
        return
    print(f"pairs with ticks: {len(rows)} (window {args.minutes}m)\n")
    print(f"{'pair':22s} {'n':>6s} {'zero%':>7s} {'eqMax':>6s} {'eqCnt':>6s} {'even%':>7s} {'levels':>7s}")
    agg = defaultdict(float)
    cnt = 0
    for k in sorted(rows):
        r = probe_series(*zip(*rows[k]))
        if not r:
            continue
        cnt += 1
        print(f"{k:22s} {r['n']:>6d} {r['zero_frac']*100:>6.1f}% {r['eq_run_max']:>6d} {r['eq_run_count']:>6d} {r['even_frac']*100:>6.1f}% {r['levels']:>7d}")
        agg["zero"] += r["zero_frac"]
        agg["even"] += r["even_frac"]
        agg["eqmax"] = max(agg["eqmax"], r["eq_run_max"])
    if cnt:
        print(f"\nAGGREGATE: mean zero-step {agg['zero']/cnt*100:.1f}% | mean even-lattice {agg['even']/cnt*100:.1f}% | longest const-velocity run {int(agg['eqmax'])}")
        print("reading: high zero% + long equal-step runs = anchor+interpolation generator (predictable segments)")
        print("         low zero% + no runs = clean random walk at tick level (defense hardens)")


if __name__ == "__main__":
    main()
