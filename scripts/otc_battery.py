#!/usr/bin/env python3
# IQAIR//OS - OTC forensics battery (Task 50: "can we reverse-engineer OTC?")
#
# WHAT THIS IS: a passive statistical battery over the 1m candle history the
# broker itself streams to our own session. It asks one question with
# rigorous controls: does the OTC feed contain ANY structure that beats
# chance - autocorrelation, conditional direction bias (n-grams), volatility
# clustering beyond a block-bootstrap null, periodic generation artifacts,
# price-quantization fingerprints, cross-pair shared-clock signatures?
#
# METHOD (the honesty engine):
#   Every test statistic computed on the REAL feed is ALSO computed on
#   M Monte-Carlo twins of that same feed, generated two ways:
#     NULL_IID - permutation of the real return series (destroys ALL time
#                structure, keeps the return distribution exactly).
#     NULL_BLK - circular block bootstrap, block=8 (identical mechanics to
#                analytics/synthfeed.ts - preserves <=8-bar memory).
#   Empirical z and p come from the null distribution, so fat tails and
#   cadence can never fake significance. A test "flags" only when the real
#   statistic is extreme against BOTH nulls.
#   Family-level verdicts use the cross-pair distribution of z-scores: with
#   ~150 pairs, ~|z|>=3 outliers appear by pure chance - only a family whose
#   z-distribution is globally shifted (KS test) counts as a discovery.
#   The OOS protocol is the final arbiter for tradeable rules: patterns are
#   mined on the first 70% of each series and must survive on the last 30%.
#
# USAGE:  python3 scripts/otc_battery.py [--min-bars 3000] [--mc 200]
# OUTPUT: mini-services/trading-core/data/otc/battery_report.json + console

import argparse
import glob
import json
import math
import os
import sys
import time
import zlib
from datetime import datetime, timezone

import numpy as np

DATA_DIR = "/home/z/my-project/mini-services/trading-core/data/otc"
CANDLE_DIR = os.path.join(DATA_DIR, "candles_1m")
BLOCK = 8  # matches synthfeed.ts calibration blockLen


# ---------------------------------------------------------------- data ----

def load_pair(path: str) -> np.ndarray:
    """-> structured array with fields t,o,h,l,c (deduped by t, sorted)."""
    rows = {}
    with open(path) as fh:
        for line in fh:
            line = line.strip()
            if not line:
                continue
            try:
                r = json.loads(line)
                rows[int(r["t"])] = (r["o"], r["h"], r["l"], r["c"])
            except Exception:  # noqa: BLE001
                continue
    if not rows:
        return np.empty(0, dtype=[("t", "i8"), ("o", "f8"), ("h", "f8"), ("l", "f8"), ("c", "f8")])
    ts = np.fromiter(rows.keys(), dtype="i8", count=len(rows))
    ts.sort()
    out = np.empty(len(ts), dtype=[("t", "i8"), ("o", "f8"), ("h", "f8"), ("l", "f8"), ("c", "f8")])
    out["t"] = ts
    vals = np.array([rows[int(t)] for t in ts], dtype="f8")
    out["o"], out["h"], out["l"], out["c"] = vals[:, 0], vals[:, 1], vals[:, 2], vals[:, 3]
    return out


# ------------------------------------------------------------- nulls -------

def null_iid(r: np.ndarray, m: int, rng: np.random.Generator) -> np.ndarray:
    """Permute the real returns: same distribution, zero time structure."""
    n = len(r)
    out = np.empty((m, n))
    for i in range(m):
        out[i] = rng.permutation(r)
    return out


def null_block(r: np.ndarray, m: int, rng: np.random.Generator, block: int = BLOCK) -> np.ndarray:
    """Circular block bootstrap (synthfeed mechanics): draws consecutive
    blocks of `block` real returns - keeps short-memory structure."""
    n = len(r)
    nb = math.ceil(n / block)
    starts = rng.integers(0, n, size=(m, nb))
    idx = (starts[:, :, None] + np.arange(block)[None, None, :]) % n
    return r[idx.reshape(m, nb * block)[:, :n]]


def series_from_returns(base_c: float, rets: np.ndarray) -> tuple[np.ndarray, np.ndarray]:
    """Rebuild closes + directions from a return series."""
    c = base_c * np.cumprod(1.0 + rets)
    x = np.sign(np.diff(c))
    return c, x


# -------------------------------------------------------------- tests -----

def acf_all(x: np.ndarray, max_lag: int) -> np.ndarray:
    x = x - x.mean()
    n = len(x)
    f = np.fft.rfft(x, 2 * n)
    ac = np.fft.irfft(f * np.conj(f))[:max_lag + 1].real
    if ac[0] <= 0:
        return np.zeros(max_lag + 1)
    return ac / ac[0]


def ljung_box(x: np.ndarray, lags: int) -> float:
    a = acf_all(x, lags)[1:]
    n = len(x)
    ks = np.arange(1, lags + 1)
    return n * (n + 2) * float(np.sum(a * a / (n - ks)))


def runs_z(x: np.ndarray) -> float:
    """Wald-Wolfowitz runs z on a +-1 series."""
    s = x[x != 0]
    n = len(s)
    n1 = int((s > 0).sum())
    n2 = n - n1
    if n1 == 0 or n2 == 0:
        return 0.0
    runs = 1 + int(np.sum(s[1:] != s[:-1]))
    mu = 2 * n1 * n2 / n + 1
    var = 2 * n1 * n2 * (2 * n1 * n2 - n) / (n * n * (n - 1))
    return (runs - mu) / math.sqrt(var) if var > 0 else 0.0


def ngram_best(x: np.ndarray, up_rate: float, min_n: int) -> dict:
    """Best conditional-direction bias over patterns of last k=1..3 moves.
    Vectorized: sliding windows -> pattern ids -> bincount counts/wins."""
    s = (x > 0).astype(np.int64)
    best = {"k": 0, "pattern": "", "n": 0, "wr": 0.0, "diff": 0.0}
    n_total = len(s)
    for k in (1, 2, 3):
        if n_total <= k + min_n:
            continue
        win = np.lib.stride_tricks.sliding_window_view(s, k)  # (N-k+1, k)
        ids = win @ (1 << np.arange(k, dtype=np.int64))       # window j = s[j:j+k]
        ids = ids[:-1]  # last window has no "next" observation
        targets = s[k:]                                       # value AFTER each window (len N-k)
        n_pat = np.bincount(ids, minlength=1 << k)
        w_pat = np.bincount(ids, weights=targets.astype(np.float64), minlength=1 << k)
        for pid in range(1 << k):
            n = int(n_pat[pid])
            if n < min_n:
                continue
            wr = w_pat[pid] / n
            diff = wr - up_rate
            if abs(diff) > abs(best["diff"]):
                pat = format(pid, f"0{k}b")
                best = {"k": k, "pattern": pat, "n": n, "wr": wr, "diff": diff}
    return best


def spec_max(x: np.ndarray, min_period: int = 2, max_period: int = 240) -> float:
    """Max normalized periodogram power over the band (generation clocks
    would show up as a fixed-period peak)."""
    x = x - x.mean()
    n = len(x)
    p = np.abs(np.fft.rfft(x)) ** 2
    p = p / p.sum()
    lo, hi = max(1, n // max_period), max(2, n // min_period)
    if hi >= len(p) or hi <= lo:
        return 0.0
    return float(p[lo:hi].max())


def rolling_upfrac_std(x: np.ndarray, w: int = 60) -> float:
    s = (x > 0).astype(np.float64)
    cs = np.cumsum(np.insert(s, 0, 0.0))
    fr = (cs[w:] - cs[:-w]) / w
    return float(fr.std())


def digit_chi2(c: np.ndarray) -> dict:
    """Last-decimal digit uniformity at 1e-5 resolution (FX 5-digit) + the
    inferred price GRID STEP. A generator that quantizes to a coarse grid
    shows a skewed histogram / a step far above the float resolution."""
    d = np.mod(np.round(c * 1e5).astype(np.int64), 10)
    hist = np.bincount(d, minlength=10)
    n = hist.sum()
    exp = n / 10
    chi2 = float(((hist - exp) ** 2).sum() / exp)
    dof = 9
    zh = ((chi2 / dof) ** (1 / 3) - (1 - 2 / (9 * dof))) / math.sqrt(2 / (9 * dof))
    p = 0.5 * math.erfc(zh / math.sqrt(2))
    # grid step: smallest positive gap between distinct closes (round away
    # float noise first) - 2e-5 means the generator walks a 1/5-pip lattice
    u = np.unique(np.round(c, 9))
    diffs = np.diff(u)
    pos = diffs[diffs > 0]
    grid = float(np.min(pos)) if len(pos) else 0.0
    even_frac = float((d % 2 == 0).mean())
    return {"chi2": round(chi2, 2), "dof": dof, "p": round(p, 5),
            "even_frac": round(even_frac, 4), "grid_step": grid, "hist": hist.tolist()}


# ----------------------------------------------------------- battery ------

TEST_KEYS = ["up_rate", "dir_ac1", "dir_acmax", "dir_lb", "ret_ac1", "ret_acmax",
             "vol_acmax", "vol_lb", "runs", "cusum", "spec", "ngram"]


def battery_for_pair(c: np.ndarray, m: int, seed: int) -> dict:
    base = float(c[0])
    r = np.diff(c) / c[:-1]
    x = np.sign(np.diff(c))
    up_rate = float((x > 0).mean())
    n = len(r)
    rng = np.random.Generator(np.random.PCG64(seed))

    ni = null_iid(r, m, rng)
    nb = null_block(r, m, rng)

    def stats_for(rets_matrix: np.ndarray) -> dict[str, np.ndarray]:
        out = {k: np.empty(m) for k in TEST_KEYS}
        for i in range(m):
            ci, xi = series_from_returns(base, rets_matrix[i])
            ai = acf_all(xi, 20)
            ar = acf_all(rets_matrix[i], 20)
            aa = acf_all(np.abs(rets_matrix[i]), 20)
            out["up_rate"][i] = (xi > 0).mean()
            out["dir_ac1"][i] = ai[1]
            out["dir_acmax"][i] = np.abs(ai[1:]).max()
            out["dir_lb"][i] = ljung_box(xi, 20)
            out["ret_ac1"][i] = ar[1]
            out["ret_acmax"][i] = np.abs(ar[1:]).max()
            out["vol_acmax"][i] = np.abs(aa[1:]).max()
            out["vol_lb"][i] = ljung_box(np.abs(rets_matrix[i]), 20)
            out["runs"][i] = runs_z(xi)
            out["cusum"][i] = rolling_upfrac_std(xi)
            out["spec"][i] = spec_max(xi)
            out["ngram"][i] = abs(ngram_best(xi, (xi > 0).mean(), min_n=max(30, len(xi) // 500))["diff"])
        return out

    real = {
        "up_rate": up_rate,
        "dir_ac1": acf_all(x, 20)[1],
        "dir_acmax": float(np.abs(acf_all(x, 20)[1:]).max()),
        "dir_lb": ljung_box(x, 20),
        "ret_ac1": acf_all(r, 20)[1],
        "ret_acmax": float(np.abs(acf_all(r, 20)[1:]).max()),
        "vol_acmax": float(np.abs(acf_all(np.abs(r), 20)[1:]).max()),
        "vol_lb": ljung_box(np.abs(r), 20),
        "runs": runs_z(x),
        "cusum": rolling_upfrac_std(x),
        "spec": spec_max(x),
        "ngram": abs(ngram_best(x, up_rate, min_n=max(30, len(x) // 500))["diff"]),
    }
    si = stats_for(ni)
    sb = stats_for(nb)

    tests = {}
    for k in TEST_KEYS:
        zi = (real[k] - si[k].mean()) / (si[k].std() + 1e-12)
        zb = (real[k] - sb[k].mean()) / (sb[k].std() + 1e-12)
        pi = float((np.sum(si[k] >= real[k]) + 1) / (m + 1))
        pb = float((np.sum(sb[k] >= real[k]) + 1) / (m + 1))
        tests[k] = {"real": real[k], "z_iid": round(float(zi), 3), "z_blk": round(float(zb), 3),
                    "p_iid": round(pi, 4), "p_blk": round(pb, 4)}

    return {"n": int(n), "up_rate": up_rate, "tests": tests,
            "digits": digit_chi2(c)}


# ------------------------------------------------------------- OOS --------

def oos_pattern(c: np.ndarray) -> dict:
    """Mine the best n-gram rule on the first 70%, validate on the last 30%.
    This is the honest arbiter: a 'pattern' that only lives in-sample is
    noise, no matter how good it looked. All counts in 0/1 space (int64)."""
    x = np.sign(np.diff(c))
    cut = int(len(x) * 0.7)
    tr, ho = x[:cut], x[cut:]
    up_tr = (tr > 0).mean()
    tr_s, ho_s = (tr > 0).astype(np.int64), (ho > 0).astype(np.int64)
    best = None
    for k in (1, 2, 3):
        if len(tr_s) <= k + 60:
            continue
        win = np.lib.stride_tricks.sliding_window_view(tr_s, k)[:-1]
        ids = win @ (1 << np.arange(k, dtype=np.int64))
        targets = tr_s[k:]
        n_pat = np.bincount(ids, minlength=1 << k)
        w_pat = np.bincount(ids, weights=targets.astype(np.float64), minlength=1 << k)
        for pid in range(1 << k):
            n = int(n_pat[pid])
            if n < 60:
                continue
            wr = w_pat[pid] / n
            diff = wr - up_tr
            if best is None or abs(diff) > abs(best["diff"]):
                best = {"k": k, "pattern": format(pid, f"0{k}b"), "n_train": n,
                        "wr_train": wr, "diff": diff}
    if not best:
        return {"found": False}
    pat, k = best["pattern"], best["k"]
    pred01 = int(pat[-1])  # pattern's last move predicts the next one (0/1)
    hits = wins = 0
    for i in range(k, len(ho_s)):
        if "".join(map(str, ho_s[i - k:i])) == pat:
            hits += 1
            wins += int(ho_s[i] == pred01)
    if hits == 0:
        return {"found": True, "k": k, "pattern": pat, "n_train": best["n_train"],
                "wr_train": round(best["wr_train"], 4), "diff_train": round(best["diff"], 4),
                "hits_oos": 0, "survived": False}
    wr_ho = wins / hits
    z = (wr_ho - 0.5) / math.sqrt(0.25 / hits)
    p = 0.5 * math.erfc(z / math.sqrt(2))
    return {"found": True, "k": k, "pattern": pat, "n_train": best["n_train"],
            "wr_train": round(best["wr_train"], 4), "diff_train": round(best["diff"], 4),
            "hits_oos": hits, "wr_oos": round(wr_ho, 4), "z_oos": round(z, 3),
            "p_oos": round(p, 4), "survived": bool(wr_ho > 0.5 and p < 0.05)}


# ------------------------------------------------------- cross-pair -------

def cross_pair(candles: dict[str, np.ndarray], m: int = 60) -> dict:
    """Shared-clock detection: if pairs are generated by ONE process, their
    same-minute returns correlate / agree in direction far above chance."""
    usable = {k: v for k, v in candles.items() if len(v) >= 10000}
    if len(usable) < 6:
        return {"usable_pairs": len(usable), "skipped": "need >=6 pairs with >=10k bars"}
    keys = sorted(usable)[:40]
    sets = [set(usable[k]["t"].tolist()) for k in keys]
    common = sets[0]
    for s in sets[1:]:
        common &= s
    common = np.array(sorted(common), dtype="i8")
    if len(common) < 5000:
        return {"usable_pairs": len(keys), "skipped": f"common timestamps only {len(common)}"}
    tmap = {k: {int(t): i for i, t in enumerate(usable[k]["t"])} for k in keys}
    R, X = {}, {}
    for k in keys:
        idx = np.array([tmap[k][int(t)] for t in common])
        cc = usable[k]["c"][idx]
        R[k] = np.diff(cc) / cc[:-1]
        X[k] = np.sign(R[k])
    K = len(keys)
    mat = np.vstack([R[k] for k in keys])
    cm = np.corrcoef(mat)
    iu = np.triu_indices(K, 1)
    mean_abs_corr = float(np.abs(cm[iu]).mean())
    xmat = np.vstack([X[k] for k in keys])
    agree = float((xmat == xmat[0]).mean())
    # null: roll each series independently (keeps autocorr, breaks sync)
    rng = np.random.Generator(np.random.PCG64(777))
    null_corr, null_agree = np.empty(m), np.empty(m)
    n = mat.shape[1]
    for j in range(m):
        off = rng.integers(0, n, size=K)
        rm = np.vstack([np.roll(mat[i], off[i]) for i in range(K)])
        xm = np.sign(rm)
        c2 = np.corrcoef(rm)
        null_corr[j] = np.abs(c2[iu]).mean()
        null_agree[j] = (xm == xm[0]).mean()
    return {
        "usable_pairs": K, "common_minutes": int(n),
        "mean_abs_corr": round(mean_abs_corr, 5),
        "z_corr": round((mean_abs_corr - null_corr.mean()) / (null_corr.std() + 1e-12), 3),
        "p_corr": round(float((np.sum(null_corr >= mean_abs_corr) + 1) / (m + 1)), 4),
        "direction_agree": round(agree, 5),
        "z_agree": round((agree - null_agree.mean()) / (null_agree.std() + 1e-12), 3),
        "p_agree": round(float((np.sum(null_agree >= agree) + 1) / (m + 1)), 4),
    }


# ------------------------------------------------------------- main -------

def ks_vs_normal(zs: np.ndarray) -> float:
    """Cheap KS p-value of z-scores vs N(0,1) - family-level honesty check."""
    zs = zs[np.isfinite(zs)]
    n = len(zs)
    if n < 8:
        return 1.0
    s = np.sort(zs)
    cdf = 0.5 * (1 + np.vectorize(math.erf)(s / math.sqrt(2)))
    d = max(np.abs(cdf - np.arange(1, n + 1) / n).max(), np.abs(cdf - np.arange(0, n) / n).max())
    # Kolmogorov asymptotic
    lam = (math.sqrt(n) + 0.12 + 0.11 / math.sqrt(n)) * d
    p = 2 * sum((-1) ** (k - 1) * math.exp(-2 * k * k * lam * lam) for k in range(1, 101))
    return float(max(0.0, min(1.0, p)))


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--min-bars", type=int, default=3000)
    ap.add_argument("--mc", type=int, default=200)
    ap.add_argument("--pairs", type=str, default="", help="comma filter, e.g. GBPUSD-OTC,EURUSD-OTC")
    ap.add_argument("--top", type=int, default=12)
    ap.add_argument("--loop", type=int, default=0, help="re-run every N seconds (daemon mode)")
    args = ap.parse_args()
    while True:
        run_once(args)
        if not args.loop:
            break
        print(f"[battery] sleeping {args.loop}s (pairs may still be backfilling)")
        time.sleep(args.loop)


def run_once(args) -> None:

    files = sorted(glob.glob(os.path.join(CANDLE_DIR, "candles_1m__*.jsonl")))
    if args.pairs:
        want = {p.strip() for p in args.pairs.split(",")}
        files = [f for f in files if any(w in f for w in want)]
    t0 = time.time()
    report = {"generated": datetime.now(timezone.utc).isoformat(), "mc": args.mc, "pairs": {}}
    done = 0
    loaded: dict[str, np.ndarray] = {}
    for f in files:
        name = os.path.basename(f)[len("candles_1m__"):-len(".jsonl")]
        data = load_pair(f)
        if len(data) < args.min_bars:
            continue
        loaded[name] = data
        seed = zlib.crc32(name.encode())  # stable across processes
        t1 = time.time()
        res = battery_for_pair(data["c"], args.mc, seed)
        res["span_days"] = round((int(data["t"][-1]) - int(data["t"][0])) / 86400, 2)
        res["oos"] = oos_pattern(data["c"])
        report["pairs"][name] = res
        done += 1
        print(f"  [{done}] {name}: n={res['n']} span={res['span_days']}d ({time.time() - t1:.1f}s)", flush=True)

    # family-level aggregation: is any test's z-distribution globally shifted?
    fam = {}
    for k in TEST_KEYS:
        zs = np.array([p["tests"][k]["z_iid"] for p in report["pairs"].values()], dtype=float)
        zb = np.array([p["tests"][k]["z_blk"] for p in report["pairs"].values()], dtype=float)
        if len(zs) < 8:
            continue
        fam[k] = {
            "n_pairs": len(zs),
            "mean_z_iid": round(float(zs.mean()), 3), "mean_z_blk": round(float(zb.mean()), 3),
            "ks_p_iid": round(ks_vs_normal(zs), 4), "ks_p_blk": round(ks_vs_normal(zb), 4),
            "n_z3_iid": int((np.abs(zs) >= 3).sum()), "n_z3_blk": int((np.abs(zb) >= 3).sum()),
            "expected_z3": round(2 * len(zs) * 0.0027, 2),
        }

    report["cross_pair"] = cross_pair({k: v for k, v in loaded.items() if len(v) >= 10000}) if done else {}
    report["families"] = fam

    survivors = [{"pair": p, **res["oos"]} for p, res in report["pairs"].items() if res.get("oos", {}).get("found")]
    survivors = [s for s in survivors if s.get("survived")]
    report["oos_survivors"] = survivors

    out = os.path.join(DATA_DIR, "battery_report.json")
    with open(out, "w") as fh:
        json.dump(report, fh, indent=1)
    print(f"\nbattery done: {done} pairs in {time.time() - t0:.0f}s -> {out}")
    grids = [(p, res["digits"]["grid_step"], res["digits"]["even_frac"]) for p, res in report["pairs"].items()]
    odd_grids = [g for g in grids if abs(g[1] - 2e-5) > 1e-9 and g[1] > 0]
    print(f"grid-step 2e-5 (1/5 pip): {len(grids) - len(odd_grids)}/{len(grids)} pairs; off-grid: {odd_grids[:6]}")
    print(f"OOS survivors (patterns that held on the last 30%): {len(survivors)}")
    for k, v in fam.items():
        flag = "  <-- GLOBAL" if (v["ks_p_iid"] < 0.01 or v["n_z3_iid"] > max(3, v["expected_z3"] * 3)) else ""
        print(f"  {k:10s} mean_z_iid {v['mean_z_iid']:+.2f}  ks {v['ks_p_iid']:.3f}  |z|>=3: {v['n_z3_iid']} (exp {v['expected_z3']}){flag}")


def main2() -> None:  # retired helper (kept out of the hot path)
    pass


if __name__ == "__main__":
    main()
