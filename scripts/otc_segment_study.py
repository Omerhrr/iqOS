#!/usr/bin/env python3
# IQAIR//OS — OTC segment study (Task 52b): the csprng forensics battery found
# ~82% of decided tick movement inside equal-step runs (max 526). That is the
# anchor+INTERPOLATION hypothesis CONFIRMED at the feed level. This script
# quantifies the only question that matters:
#
#   "Given the last k equal steps, how predictable is the next step — and how
#    much predictable runway remains?"
#
# Protocol (walk-forward, zero lookahead):
#   at tick i: if steps[i-1..i-k] are all equal and nonzero -> predict
#   steps[i] = steps[i-1]. Score. Also measure remaining-run distribution.
#
# ARTIFACT KILLERS:
#   A1. JSONL-ONLY recomputation (no CSV merge) — merge cannot create runs.
#   A2. Placebo on sign-shuffled broker stream (destroys segments, keeps counts)
#       -> continuation must collapse to ~50%.
#   A3. CSPRNG control stream (same step magnitudes) -> ~50%.
#   A4. Step-size census inside vs outside runs (animation velocity constant?).
#
# Scope: passive analysis of OUR recorded feed only.

import glob
import json
import math
import os
from collections import defaultdict

import numpy as np

DATA_DIR = "/home/z/my-project/mini-services/trading-core/data/otc"


def load_jsonl_only(pairs_wanted: int):
    per = defaultdict(list)
    f1 = os.path.join(DATA_DIR, "ticks100ms__20261006.jsonl")
    seen = set()
    with open(f1) as fh:
        for line in fh:
            try:
                d = json.loads(line)
                key = (d["t"], int(d["ts"]), float(d["p"]))
                if key in seen:
                    continue
                seen.add(key)
                per[d["t"]].append((key[1], key[2]))
            except Exception:
                pass
    out = {}
    for pair, recs in per.items():
        if len(recs) < 3000:
            continue
        recs.sort()
        out[pair] = (np.array([r[0] for r in recs]), np.array([r[1] for r in recs]))
    return dict(sorted(out.items(), key=lambda kv: -len(kv[1][1]))[:pairs_wanted])


def continuation_stats(steps: np.ndarray, k: int):
    """P(steps[i] == steps[i-1] | last k equal, nonzero), walk-forward."""
    n = len(steps)
    wins = tries = 0
    for i in range(k, n):
        ok = True
        for j in range(1, k + 1):
            if steps[i - j] != steps[i - k] or steps[i - k] == 0:
                ok = False
                break
        if not ok:
            continue
        tries += 1
        wins += int(steps[i] == steps[i - 1])
    return wins, tries


def run_census(steps: np.ndarray):
    """Runs of consecutive EQUAL NONZERO steps; returns list of run lengths."""
    runs = []
    prev = None
    cur = 0
    for s in steps:
        if s != 0 and s == prev:
            cur += 1
        else:
            if cur >= 1 and prev is not None and prev != 0:
                runs.append(cur + 1)  # run of L equal steps
            cur = 0
        prev = s
    if cur >= 1 and prev is not None and prev != 0:
        runs.append(cur + 1)
    return np.array(runs)


def horizons(steps: np.ndarray):
    """After observing k equal steps inside a run, how many equal steps remain?"""
    rem2, rem3 = [], []
    run = 0
    for i, s in enumerate(steps):
        if s != 0 and i > 0 and s == steps[i - 1]:
            run += 1
        else:
            run = 1 if s != 0 else 0
        # run = current equal-step streak length ending at i
        if run >= 3:
            rem2.append(run - 2)   # after 2 confirmations (streak 3)
        if run >= 4:
            rem3.append(run - 3)
    return np.array(rem2), np.array(rem3)


def analyze(name, prices: np.ndarray, label: str):
    steps = np.diff(prices)
    dsteps = steps[steps != 0]
    out = {"stream": name, "label": label, "n_ticks": int(len(prices)),
           "n_decided": int(len(dsteps))}
    # continuation accuracies
    for k in (1, 2, 3):
        w, t = continuation_stats(steps, k)
        out[f"cont_k{k}"] = {"acc": round(w / t, 4) if t else None,
                             "n": t,
                             "z": round((w - t / 2) / math.sqrt(t / 4), 2) if t else None}
    # step sizes
    units = None
    mag = np.abs(dsteps)
    modal = np.bincount(np.round(mag / (mag.min() if len(mag) else 1)).astype(int) if len(mag) else [0])
    out["step_mag_p50"] = float(np.median(mag)) if len(mag) else None
    out["step_mag_p99"] = float(np.percentile(mag, 99)) if len(mag) else None
    # run census
    runs = run_census(dsteps)
    if len(runs):
        out["runs"] = {"count": int(len(runs)),
                       "p50": float(np.median(runs)), "p90": float(np.percentile(runs, 90)),
                       "p99": float(np.percentile(runs, 99)), "max": int(runs.max()),
                       "mean": round(float(runs.mean()), 2),
                       "share_in_runs_ge10": round(float(runs[runs >= 10].sum() / runs.sum()), 4)}
    # horizons
    r2, r3 = horizons(dsteps)
    if len(r2):
        out["horizon_after_k2"] = {"p50": float(np.median(r2)), "mean": round(float(r2.mean()), 1),
                                   "p90": float(np.percentile(r2, 90))}
    if len(r3):
        out["horizon_after_k3"] = {"p50": float(np.median(r3)), "mean": round(float(r3.mean()), 1),
                                   "p90": float(np.percentile(r3, 90))}
    return out


def placebo_signs(prices: np.ndarray, seed: int = 9):
    """Shuffle the signs of decided steps in time -> destroys segments."""
    steps = np.diff(prices).copy()
    nz = steps != 0
    rng = np.random.default_rng(seed)
    signs = np.where(steps[nz] > 0, 1.0, -1.0)
    rng.shuffle(signs)
    steps[nz] = signs * np.abs(steps[nz])
    return np.concatenate([[prices[0]], prices[0] + np.cumsum(steps)])


def main():
    pairs = load_jsonl_only(6)
    print("=" * 96)
    print("OTC SEGMENT STUDY — is the interpolated runway predictable? (JSONL-only, no merge)")
    print("=" * 96)

    rows = []
    for pair, (ts, prices) in pairs.items():
        rows.append(analyze(f"{pair}", prices, "BROKER"))

    # placebo per first pair + csprng control with same magnitudes
    p0 = list(pairs.values())[0][1]
    rows.append(analyze("PLACEBO sign-shuffle", placebo_signs(p0), "PLACEBO"))

    mags = np.abs(np.diff(p0))
    mags = mags[mags != 0]
    nprng = np.random.default_rng(777)
    import secrets as pysecrets
    u0 = 100000
    n = len(p0)
    mags_u = np.maximum(np.round(mags / max(1e-12, np.median(mags[mags > 0]))).astype(int), 1)
    signs = np.where(np.array([pysecrets.randbelow(2) for _ in range(n - 1)]) == 0, -1, 1)
    walk = u0 + np.cumsum(signs * nprng.choice(mags_u, size=n - 1))
    rows.append(analyze("CONTROL csprng-walk", walk.astype(float), "CONTROL"))

    for r in rows:
        print(f"\n--- {r['stream']} [{r['label']}] ticks={r['n_ticks']} decided={r['n_decided']}")
        for k in (1, 2, 3):
            c = r[f"cont_k{k}"]
            if c["n"]:
                print(f"  continuation k={k}: acc={c['acc']*100:6.2f}%  n={c['n']:6d}  z={c['z']:+8.2f}")
        if "runs" in r:
            rr = r["runs"]
            print(f"  equal-step runs: n={rr['count']} p50={rr['p50']:.0f} p90={rr['p90']:.0f} "
                  f"p99={rr['p99']:.0f} max={rr['max']} mean={rr['mean']} "
                  f"share_in_ge10={rr['share_in_runs_ge10']*100:.1f}%")
        if "horizon_after_k2" in r:
            h = r["horizon_after_k2"]
            print(f"  runway after 2 confirmations: p50={h['p50']:.0f} ticks mean={h['mean']} p90={h['p90']:.0f}")
        print(f"  step |mag|: p50={r['step_mag_p50']} p99={r['step_mag_p99']}")

    # median tick spacing for time context
    for pair, (ts, prices) in list(pairs.items())[:1]:
        dt = np.diff(ts)
        print(f"\ntick spacing ({pair}): p50={np.median(dt):.0f}ms p90={np.percentile(dt, 90):.0f}ms")

    with open(os.path.join(DATA_DIR, "segment_study.json"), "w") as fh:
        json.dump(rows, fh, indent=1, default=str)
    print(f"\nreport -> {DATA_DIR}/segment_study.json")


if __name__ == "__main__":
    main()
