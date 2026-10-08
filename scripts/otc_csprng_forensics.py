#!/usr/bin/env python3
# IQAIR//OS — OTC CSPRNG dive (Task 52): generator forensics on the recorded
# 100ms tick stream, with DETECTOR CALIBRATION on known generators.
#
# Why: the 1m candle battery + flat-aware forensics (Tasks 50/51) tested the
# OUTPUT for anomalies and found none. But "no anomaly found" is weak evidence
# unless the detectors are PROVEN able to catch a weak generator through the
# same observation channel. So this script:
#   1. Reconstructs the broker tick stream per pair (merged JSONL+CSV, deduped)
#   2. Builds CONTROL streams in the IDENTICAL observable space (integer
#      lattice units, same step-magnitude distribution, same length):
#        - mulberry32 (our synthfeed's generator, 32-bit state, KNOWN weak)
#        - LCG48 (java.util.Random family, classic weak)
#        - secrets  (true CSPRNG control)
#   3. Runs the same 10-test battery on every stream:
#        T1  runs-z         Wald–Wolfowitz on decided signs
#        T2  autocorr       max |corr| lags 1..30 on decided steps
#        T3  chi2_2d        independence of consecutive step pairs (quantile bins)
#        T4  rank_bits      Marsaglia binary 8x8 matrix rank over GF(2) (linear
#                           generator fingerprint)
#        T5  digit_chi2     uniformity of low digit of price-in-grid-units
#        T6  compression    zlib ratio on sign bytes + on lattice-unit low bytes
#        T7  interp         zero-step share, equal-step run census, run share
#        T8  ngram_oos      4-gram sign prediction, 70/30 split, binomial z
#        T9  fft_peak       max non-DC periodogram power vs shuffled null
#        T10 cross_pair     cross-pair sign correlation on 1s buckets (shared
#                           state / one-generator-drives-all signature)
#   4. Verdict logic:
#        - detectors that catch controls = "live"; detectors that don't are
#          marked UNDERPOWERED and a clean broker result on them is NOT evidence
#        - broker trips a live detector => lead, report which and where
#        - broker clean on all live detectors => CSPRNG-grade within the power
#          of this channel, and we state the state-recovery feasibility math.
#
# Scope: passive analysis of OUR recorded feed only. No intrusion, no probing.
#
# USAGE: python3 scripts/otc_csprng_forensics.py [--pairs N] [--seed 0]
# (run from mini-services/trading-core so data/otc resolves, same as os.db)

import argparse
import glob
import json
import math
import os
import secrets as pysecrets
import zlib
from collections import Counter, defaultdict

import numpy as np

DATA_DIR = "/home/z/my-project/mini-services/trading-core/data/otc"
M32 = 0xFFFFFFFF


# ---------------------------------------------------------------- generators
def mulberry32(seed: int):
    """Exact JS port of our synthfeed generator (32-bit state)."""
    a = seed & M32

    def rng():
        nonlocal a
        a = (a + 0x6D2B79F5) & M32
        t = ((a ^ (a >> 15)) * ((1 | a) & M32)) & M32
        t = (t + (((t ^ (t >> 7)) * (61 | t)) & M32)) & M32
        t ^= t
        return ((t ^ (t >> 14)) & M32) / 4294967296.0

    return rng


def lcg48(seed: int):
    """java.util.Random family: 48-bit truncated LCG."""
    state = (seed ^ 0x5DEECE66D) & ((1 << 48) - 1)

    def rng():
        nonlocal state
        state = (25214903917 * state + 11) & ((1 << 48) - 1)
        return (state >> 16) / float(1 << 32)

    return rng


def csprng(_seed: int):
    def rng():
        return pysecrets.randbelow(1 << 32) / 4294967296.0

    return rng


# ---------------------------------------------------------------- data load
def load_broker_ticks(pairs_wanted: int):
    """Merge ticks100ms jsonl + ticks csv, dedupe on (pair, ts_ms, price)."""
    per = defaultdict(dict)  # pair -> {(ts_ms, price): 1}
    f1 = os.path.join(DATA_DIR, "ticks100ms__20261006.jsonl")
    if os.path.exists(f1):
        with open(f1) as fh:
            for line in fh:
                try:
                    d = json.loads(line)
                    per[d["t"]][(int(d["ts"]), float(d["p"]))] = 1
                except Exception:
                    pass
    for f in sorted(glob.glob(os.path.join(DATA_DIR, "ticks__*.csv"))):
        with open(f) as fh:
            for line in fh:
                try:
                    ts, pair, px = line.split(",")
                    per[pair.strip()][(round(float(ts) * 1000), float(px))] = 1
                except Exception:
                    pass
    out = {}
    for pair, d in per.items():
        if len(d) < 3000:
            continue
        recs = sorted(d.keys())
        out[pair] = ([r[0] for r in recs], [r[1] for r in recs])
    top = sorted(out.items(), key=lambda kv: -len(kv[1][0]))[:pairs_wanted]
    return dict(top)


def infer_grid(prices) -> tuple[float, int]:
    """Smallest modal decided step = 1 lattice unit; return (grid, units)."""
    steps = Counter(
        round(abs(prices[i + 1] - prices[i]), 12) for i in range(len(prices) - 1)
    )
    steps.pop(0.0, None)
    if not steps:
        return 1e-5, 1
    grid = min(k for k, v in steps.items() if v >= max(3, steps.most_common(1)[0][1] * 0.05))
    return grid, 1


def to_units(prices, grid) -> np.ndarray:
    return np.round(np.asarray(prices) / grid).astype(np.int64)


# ---------------------------------------------------------------- controls
def make_control_walk(n: int, u0: int, step_mags: np.ndarray, rng) -> np.ndarray:
    """Random walk in lattice units; step magnitudes RESAMPLED from the real
    pair's decided-step distribution (numpy rng, fixed seed), signs from the
    generator under test. => identical observable space as broker ticks."""
    nprng = np.random.default_rng(777)
    mags = nprng.choice(step_mags, size=n)
    signs = np.where(np.array([rng() for _ in range(n)]) < 0.5, -1, 1)
    return u0 + np.cumsum(signs * mags)


# ---------------------------------------------------------------- tests
def t_runs(signs: np.ndarray) -> float:
    """Wald–Wolfowitz runs z on ±1 signs (0 = no edge)."""
    n = len(signs)
    if n < 100:
        return float("nan")
    n1 = int((signs > 0).sum())
    n2 = n - n1
    if n1 < 10 or n2 < 10:
        return float("nan")
    runs = 1 + int((signs[1:] != signs[:-1]).sum())
    er = 2.0 * n1 * n2 / n + 1.0
    vr = (er - 1.0) * (er - 2.0) / (n - 1.0)
    return (runs - er) / math.sqrt(max(vr, 1e-12))


def t_autocorr(steps: np.ndarray, kmax: int = 30):
    s = steps.astype(np.float64)
    s = s - s.mean()
    var = float((s * s).sum())
    best, blat = 0.0, 0
    for k in range(1, kmax + 1):
        c = float((s[:-k] * s[k:]).sum()) / max(var, 1e-12)
        if abs(c) > abs(best):
            best, blat = c, k
    thr = 3.0 / math.sqrt(len(s))
    return best, blat, thr


def t_chi2_2d(steps: np.ndarray, bins: int = 5):
    """Quantile-bin consecutive pairs; chi2 independence."""
    a, b = steps[:-1], steps[1:]
    if len(a) < 500:
        return float("nan"), 0
    qa = np.quantile(a, np.linspace(0, 1, bins + 1)[1:-1])
    qb = np.quantile(b, np.linspace(0, 1, bins + 1)[1:-1])
    ia = np.searchsorted(qa, a)
    ib = np.searchsorted(qb, b)
    obs = np.zeros((bins, bins))
    for x, y in zip(ia, ib):
        obs[x, y] += 1
    ea = obs.sum(1, keepdims=True)
    eb = obs.sum(0, keepdims=True)
    exp = ea * eb / obs.sum()
    mask = exp > 0
    chi2 = float(((obs - exp)[mask] ** 2 / exp[mask]).sum())
    from scipy.stats import chi2 as chi2dist
    return chi2, int((bins - 1) ** 2)


def gf2_rank8(rows) -> int:
    rows = list(rows)
    r = 0
    for col in range(7, -1, -1):
        piv = next((i for i in range(r, 8) if (rows[i] >> col) & 1), None)
        if piv is None:
            continue
        rows[r], rows[piv] = rows[piv], rows[r]
        for i in range(8):
            if i != r and ((rows[i] >> col) & 1):
                rows[i] ^= rows[r]
        r += 1
        if r == 8:
            break
    return r


def t_rank_bits(units: np.ndarray):
    """Marsaglia 8x8 binary rank test on low bits of FINE-lattice units
    (price*1e6 integers; see t_digit_chi2 artifact note)."""
    bits = np.concatenate([((units >> b) & 1).astype(np.uint8) for b in range(8)])
    nmat = len(bits) // 64
    if nmat < 200:
        return float("nan"), 0, 0, 0
    ranks = Counter()
    for m in range(nmat):
        chunk = bits[m * 64:(m + 1) * 64]
        rows = [int("".join(map(str, chunk[r * 8:(r + 1) * 8])), 2) for r in range(8)]
        ranks[gf2_rank8(rows)] += 1
    n1, n2, n3 = ranks[8], ranks[7], nmat - ranks[8] - ranks[7]
    # theoretical: p8=.2888 p7=.5776 p<=6=.1336
    e = np.array([0.2888 * nmat, 0.5776 * nmat, 0.1336 * nmat])
    o = np.array([n1, n2, n3])
    chi2 = float(((o - e) ** 2 / e).sum())
    from scipy.stats import chi2 as chi2dist
    return chi2dist.sf(chi2, 2), n1 / nmat, n2 / nmat, n3 / nmat


def t_digit_chi2(units: np.ndarray):
    """Low-decimal-digit uniformity on FINE-lattice integer units.
    NOTE: units must be price*1e6 integers (decimal fraction bits are
    structured — using coarse modal-step units made this test meaningless
    in the first run: every broker 'p=0.000' was a quantization artifact)."""
    d = np.abs(units) % 10
    obs = np.bincount(d, minlength=10).astype(float)
    exp = np.full(10, obs.sum() / 10.0)
    chi2v = float(((obs - exp) ** 2 / exp).sum())
    from scipy.stats import chi2 as chi2dist
    return chi2dist.sf(chi2v, 9)


def t_compression(units: np.ndarray, signs: np.ndarray):
    ub = bytes((units & 0xFF).astype(np.uint8).tolist())
    sb = bytes(((signs > 0).astype(np.uint8) + 1).tolist())
    ru = len(zlib.compress(ub, 9)) / max(1, len(ub))
    rs = len(zlib.compress(sb, 9)) / max(1, len(sb))
    return rs, ru


def t_interp(prices: np.ndarray):
    """EQUAL-step run census (consecutive steps identical signed value).
    ARTIFACT HISTORY (Task 52): an earlier version counted runs of NONZERO
    steps (only flats breaking the run) and read 'max 523 interpolated
    runway' — that was a misnamed counter, not interpolation. On continuous
    step distributions equal-step runs are ~0 by construction; compare
    against the shuffle null in scripts/otc_segment_study.py, not raw."""
    d = np.diff(prices)
    nz = d != 0
    zero_frac = 1.0 - float(nz.mean()) if len(d) else 1.0
    run_len, cur, prev = [], 0, None
    for x in d:
        if x != 0 and x == prev:
            cur += 1
        else:
            if cur >= 2:
                run_len.append(cur + 1)
            cur = 0
        prev = x
    if cur >= 2:
        run_len.append(cur + 1)
    decided = int(nz.sum())
    in_run = sum(run_len) if run_len else 0
    return zero_frac, len(run_len), (max(run_len) if run_len else 0), (
        in_run / decided if decided else 0.0)


def t_ngram(signs: np.ndarray, k: int = 4):
    s = (signs > 0).astype(np.int8)
    split = int(len(s) * 0.7)
    if split < 500:
        return float("nan"), 0
    train, test = s[:split], s[split:]
    counts = defaultdict(Counter)
    for i in range(len(train) - k):
        counts[tuple(train[i:i + k])][int(train[i + k])] += 1
    wins = tries = 0
    for i in range(len(test) - k):
        ctx = tuple(test[i:i + k])
        c = counts.get(ctx)
        if not c or sum(c.values()) < 8:
            continue
        pred = c.most_common(1)[0][0]
        tries += 1
        wins += int(test[i + k] == pred)
    if tries < 100:
        return float("nan"), tries
    z = (wins - 0.5 * tries) / math.sqrt(0.25 * tries)
    return z, tries


def t_fft(signs: np.ndarray, nperm: int = 300):
    x = signs.astype(np.float64)
    x = x - x.mean()
    n = len(x)
    pow_obs = np.abs(np.fft.rfft(x))[1:] ** 2
    obs_max = float(pow_obs.max())
    rng = np.random.default_rng(12345)
    cnt = 0
    for _ in range(nperm):
        y = x[rng.permutation(n)]
        m = float((np.abs(np.fft.rfft(y))[1:] ** 2).max())
        if m >= obs_max:
            cnt += 1
    return (1 + cnt) / (1 + nperm)


# ---------------------------------------------------------------- main
def battery(name, prices, grid, units, steps, signs, res):
    # fine-lattice integer units (1e-6) for bit/digit tests — coarse
    # modal-step units embed decimal-fraction structure and fake fingerprints
    fine = np.round(prices * 1e6).astype(np.int64)
    z_runs = t_runs(signs)
    (r, lag, thr) = t_autocorr(steps)
    chi2, df = t_chi2_2d(steps)
    from scipy.stats import chi2 as chi2dist
    p2d = chi2dist.sf(chi2, df) if df else float("nan")
    p_rank, f8, f7, f6 = t_rank_bits(fine)
    p_dig = t_digit_chi2(fine)
    rs, ru = t_compression(units, signs)
    zf, nruns, maxrun, runshare = t_interp(prices)
    z_ng, tries = t_ngram(signs)
    p_fft = t_fft(signs)
    res[name] = {
        "n_ticks": int(len(prices)), "n_decided": int(len(signs)),
        "grid": grid,
        "T1_runs_z": round(z_runs, 3) if z_runs == z_runs else None,
        "T2_autocorr": [round(r, 5), int(lag), round(thr, 5)],
        "T3_chi2_2d_p": float(f"{p2d:.5g}") if p2d == p2d else None,
        "T4_rank_p": float(f"{p_rank:.5g}") if p_rank == p_rank else None,
        "T4_rank_freqs": [round(f8, 3), round(f7, 3), round(f6, 3)],
        "T5_digit_p": float(f"{p_dig:.5g}"),
        "T6_comp_sign": round(rs, 5), "T6_comp_units": round(ru, 5),
        "T7_zero_frac": round(zf, 4), "T7_eq_runs": nruns,
        "T7_eq_max": maxrun, "T7_run_share": round(runshare, 4),
        "T8_ngram_z": round(z_ng, 3) if z_ng == z_ng else None,
        "T8_tries": tries,
        "T9_fft_p": round(p_fft, 4),
    }


def cross_pair_test(signals_by_pair: dict, bucket_ms: int = 1000):
    """Align sign streams on 1s buckets, max |corr| across pairs."""
    arrays = {}
    for pair, (tss, signs) in signals_by_pair.items():
        b = defaultdict(list)
        for ts, sg in zip(tss, signs):
            b[ts // bucket_ms].append(sg)
        arrays[pair] = {k: sum(v) for k, v in b.items() if v}
    pairs = list(arrays)
    best = (0.0, "", "")
    for i in range(len(pairs)):
        for j in range(i + 1, len(pairs)):
            ka, kb = arrays[pairs[i]], arrays[pairs[j]]
            common = sorted(set(ka) & set(kb))
            if len(common) < 300:
                continue
            a = np.array([ka[k] for k in common], float)
            b = np.array([kb[k] for k in common], float)
            a -= a.mean(); b -= b.mean()
            den = math.sqrt(float((a * a).sum()) * float((b * b).sum()))
            r = float((a * b).sum()) / den if den else 0.0
            if abs(r) > abs(best[0]):
                best = (r, pairs[i], pairs[j])
    return best, min(len(v) for v in arrays.values()) if arrays else 0


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--pairs", type=int, default=6)
    args = ap.parse_args()

    broker = load_broker_ticks(args.pairs)
    if not broker:
        print("no tick data")
        return

    results = {}
    sign_streams = {}

    for pair, (tss, prices) in broker.items():
        prices = np.asarray(prices)
        grid, _ = infer_grid(prices)
        units = to_units(prices, grid)
        d = np.diff(units)
        steps = d[d != 0]
        signs = np.where(steps > 0, 1, -1)
        sign_streams[pair] = (tss, signs)
        battery(f"BROKER {pair}", prices, grid, units, steps, signs, results)

    # ---- controls: mirror the FIRST pair's observable space
    pair0, (tss0, prices0) = next(iter(broker.items()))
    prices0 = np.asarray(prices0)
    grid0, _ = infer_grid(prices0)
    units0 = to_units(prices0, grid0)
    d0 = np.diff(units0)
    step_mags = np.abs(d0[d0 != 0])
    n = len(units0)
    u0 = int(units0[0])

    for cname, gen in [
        ("CONTROL mulberry32", mulberry32),
        ("CONTROL LCG48", lcg48),
        ("CONTROL csprng", csprng),
    ]:
        rng = gen(0x5EED if cname != "CONTROL csprng" else 1234)
        cu = make_control_walk(n, u0, step_mags, rng)
        prices = cu * grid0
        dsteps = np.diff(cu)
        csteps = dsteps[dsteps != 0]
        csigns = np.where(csteps > 0, 1, -1)
        battery(cname, prices, grid0, cu, csteps, csigns, results)

    # ---- cross-pair (broker only)
    (r, pa, pb), nb = cross_pair_test(sign_streams)
    results["_cross_pair"] = {"max_r": round(r, 4), "pairs": [pa, pb],
                              "min_common_buckets_1s": nb,
                              "thr_3_over_sqrt_n": round(3 / math.sqrt(max(nb, 1)), 4)}

    # ---- verdict: which detectors separate weak from strong controls
    def trips(rw, key):
        v = rw.get(key)
        if v is None:
            return None
        if key == "T1_runs_z":
            return abs(v) > 3.0
        if key == "T2_autocorr":
            return abs(v[0]) > v[2]
        if key in ("T3_chi2_2d_p", "T4_rank_p", "T5_digit_p", "T9_fft_p"):
            return v is not None and v < 0.01
        if key == "T8_ngram_z":
            return v is not None and abs(v) > 3.0
        if key == "T6_comp_sign":
            return v < 0.995
        if key == "T6_comp_units":
            return v < 0.995
        return None

    TESTS = ["T1_runs_z", "T2_autocorr", "T3_chi2_2d_p", "T4_rank_p",
             "T5_digit_p", "T6_comp_sign", "T6_comp_units", "T8_ngram_z",
             "T9_fft_p"]

    ctrl_rows = {k: v for k, v in results.items() if k.startswith("CONTROL")}
    live, underpowered = [], []
    for t in TESTS:
        weak_trip = [trips(ctrl_rows[c], t) for c in ctrl_rows if "csprng" not in c]
        strong_trip = trips(ctrl_rows["CONTROL csprng"], t)
        if any(x for x in weak_trip) and not strong_trip:
            live.append(t)
        elif not any(x for x in weak_trip):
            underpowered.append(t)

    print("=" * 100)
    print("OTC CSPRNG DIVE — generator forensics with calibrated detectors")
    print("=" * 100)
    hdr = f"{'stream':28s} " + " ".join(f"{t:>13s}" for t in TESTS)
    print(hdr)
    for name, rw in results.items():
        if name.startswith("_"):
            continue
        cells = []
        for t in TESTS:
            v = rw.get(t)
            if t == "T1_runs_z":
                cells.append(f"{v:+.2f}" if v is not None else "  n/a")
            elif t == "T2_autocorr":
                cells.append(f"{v[0]:+.4f}@{v[1]}" if v else "n/a")
            elif t in ("T3_chi2_2d_p", "T4_rank_p", "T5_digit_p", "T9_fft_p"):
                cells.append(f"{v:.3f}" if v is not None else "n/a")
            elif t in ("T6_comp_sign", "T6_comp_units"):
                cells.append(f"{v:.4f}")
            elif t == "T8_ngram_z":
                cells.append(f"{v:+.2f}" if v is not None else "  n/a")
        print(f"{name:28s} " + " ".join(f"{c:>13s}" for c in cells))

    print("\nDETECTOR CALIBRATION (control trial):")
    print(f"  LIVE (catch >=1 weak generator, csprng clean): {live or 'NONE'}")
    print(f"  UNDERPOWERED on this channel: {underpowered or 'none'}")

    print("\nBROKER TRIAGE (live detectors only):")
    trip_summary = {}
    for name in results:
        if not name.startswith("BROKER"):
            continue
        hits = [t for t in live if trips(results[name], t)]
        trip_summary[name] = hits
        print(f"  {name}: {'CLEAN' if not hits else 'TRIPS ' + ','.join(hits)}")

    print(f"\nCROSS-PAIR: max r={r:+.4f} ({pa} vs {pb}, n={nb} buckets, "
          f"thr {results['_cross_pair']['thr_3_over_sqrt_n']})")

    interp = [(n, results[n]["T7_zero_frac"], results[n]["T7_eq_runs"],
               results[n]["T7_eq_max"], results[n]["T7_run_share"])
              for n in results if n.startswith("BROKER")]
    print("\nINTERPOLATION CENSUS (T7, all broker pairs):")
    for n, zf, nr, mr, sh in interp:
        print(f"  {n}: zero-step {zf*100:5.1f}%  eq-runs {nr:4d}  max {mr:3d}  "
              f"decided-in-runs {sh*100:4.1f}%")

    out = {"results": results, "live_detectors": live,
           "underpowered": underpowered, "broker_trips": trip_summary,
           "cross_pair": results["_cross_pair"]}
    with open(os.path.join(DATA_DIR, "csprng_report.json"), "w") as fh:
        json.dump(out, fh, indent=1, default=str)
    print(f"\nreport -> {DATA_DIR}/csprng_report.json")


if __name__ == "__main__":
    main()
