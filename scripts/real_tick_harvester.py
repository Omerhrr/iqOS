#!/usr/bin/env python3
# IQAIR//OS — REAL-market tick harvester daemon (Task 53 contrast control).
# Deltas /tick_stats from the sidecar for REAL (non-OTC) pairs and appends
# new points to data/real/ticks_real__<date>.jsonl in the SAME format as the
# OTC tick archive {"ts":ms,"t":pair,"p":price} so the forensics battery can
# consume both identically. Run via daemonizer. Safe to restart (dedupes by
# (ts, price) per pair per file at load; appends only new points).
#
# NOTE: sidecar tick capture = 100ms polling of the RAM candle table, records
# a point only when price CHANGES; buffer capped at 1000/pair, so we must
# delta-poll faster than the buffer turnover (~1000 changes). EURUSD real
# changes ~1-3/s -> 2s poll is comfortable.

import json
import os
import time
import urllib.parse
import urllib.request
from datetime import datetime

SIDECAR = "http://127.0.0.1:8788"
OUT_DIR = "/home/z/my-project/mini-services/trading-core/data/real"
PAIRS = ["EURUSD", "GBPUSD"]
POLL_SEC = 2.0


def fetch(path: str):
    try:
        with urllib.request.urlopen(SIDECAR + path, timeout=15) as r:
            return json.loads(r.read())
    except Exception:  # noqa: BLE001
        return None


def today_file() -> str:
    return os.path.join(OUT_DIR, f"ticks_real__{datetime.now():%Y%m%d}.jsonl")


def load_seen(path: str):
    seen = set()
    if os.path.exists(path):
        with open(path) as fh:
            for line in fh:
                try:
                    d = json.loads(line)
                    seen.add((d["t"], int(d["ts"]), float(d["p"])))
                except Exception:
                    pass
    return seen


def main():
    os.makedirs(OUT_DIR, exist_ok=True)
    state = {p: {} for p in PAIRS}  # pair -> {ts_ms: price} local pending window
    while True:
        path = today_file()
        seen = load_seen(path)  # cheap: file is small (few MB/day)
        new_rows = []
        for p in PAIRS:
            d = fetch(f"/tick_stats?asset={urllib.parse.quote(p)}")
            if not d or not d.get("ok"):
                continue
            for pt in d.get("points") or []:
                ts = int(pt["time"] * 1000)
                px = float(pt["price"])
                state[p][ts] = px  # latest value per ts
            # flush points older than 30s (buffer churned past them)
            cutoff = int(time.time() * 1000) - 30_000
            for ts in sorted(list(state[p].keys())):
                if ts > cutoff:
                    continue
                px = state[p].pop(ts)
                if (p, ts, px) not in seen:
                    new_rows.append({"ts": ts, "t": p, "p": px})
        if new_rows:
            new_rows.sort(key=lambda r: (r["t"], r["ts"]))
            with open(path, "a") as fh:
                for r in new_rows:
                    fh.write(json.dumps(r) + "\n")
        time.sleep(POLL_SEC)


if __name__ == "__main__":
    main()
