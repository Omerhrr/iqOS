#!/usr/bin/env python3
# IQAIR//OS — REAL-market 1m candle backfill (Task 53 contrast control).
# Deep-backfills REAL (non-OTC) pairs via sidecar /candles end-paging into
# data/real/, mirroring the OTC harvest format {"t","o","h","l","c","v"} so
# the contrast study can load both with one loader.
#
# USAGE: python3 scripts/real_backfill.py [--pairs EURUSD,GBPUSD] [--days 32]

import argparse
import json
import os
import time
import urllib.parse
import urllib.request

SIDECAR = "http://127.0.0.1:8788"
OUT_DIR = "/home/z/my-project/mini-services/trading-core/data/real"
PAGE = 1000


def fetch(path: str, tries: int = 4):
    last = None
    for i in range(tries):
        try:
            with urllib.request.urlopen(SIDECAR + path, timeout=60) as r:
                return json.loads(r.read())
        except Exception as e:  # noqa: BLE001
            last = e
            time.sleep(2 + 2 * i)
    raise RuntimeError(f"fetch failed {path}: {last}")


def backfill(ticker: str, depth_sec: int) -> int:
    os.makedirs(OUT_DIR, exist_ok=True)
    out = os.path.join(OUT_DIR, f"candles_1m__{ticker}.jsonl")
    seen = {}
    if os.path.exists(out):
        with open(out) as fh:
            for line in fh:
                try:
                    d = json.loads(line)
                    seen[d["t"]] = d
                except Exception:
                    pass
    end = int(time.time())
    oldest = end - depth_sec
    calls = 0
    new = 0
    while end > oldest and calls < 60:
        d = fetch(f"/candles?asset={urllib.parse.quote(ticker)}&size={PAGE}&tf=60&end={end}")
        rows = (d or {}).get("candles") or []
        if not rows:
            break
        for c in rows:
            t = int(c["time"])
            if t < oldest:
                continue
            rec = {"t": t, "o": c["open"], "h": c["high"], "l": c["low"],
                   "c": c["close"], "v": c.get("volume", 0.0)}
            if t not in seen or seen[t] != rec:
                new += 1
            seen[t] = rec
        calls += 1
        first = int(rows[0]["time"])
        if first >= end - 60:  # no progress -> stop
            break
        end = first
        time.sleep(0.4)  # don't hog the iqair bus
    rows_sorted = sorted(seen.values(), key=lambda r: r["t"])
    with open(out, "w") as fh:
        for r in rows_sorted:
            fh.write(json.dumps(r) + "\n")
    print(f"{ticker}: {len(rows_sorted)} unique 1m bars ({calls} calls, +{new} new) -> {out}")
    return len(rows_sorted)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--pairs", default="EURUSD,GBPUSD")
    ap.add_argument("--days", type=int, default=32)
    args = ap.parse_args()
    depth = args.days * 86400
    for p in [x.strip() for x in args.pairs.split(",") if x.strip()]:
        try:
            backfill(p, depth)
        except Exception as e:  # noqa: BLE001
            print(f"{p}: FAILED {e}")


if __name__ == "__main__":
    main()
