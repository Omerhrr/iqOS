#!/usr/bin/env python3
# IQAIR//OS - OTC feed harvester (research data collection for the OTC
# forensics battery, Task 50).
#
# WHAT: a background daemon that
#   (1) BACKFILLS deep 1m candle history for every -OTC pair the broker
#       exposes (pages /candles backwards via the `end` window - IQ keeps
#       roughly 30-90 days), tiered: pairs with fresh data get 30d, stale
#       pairs get 10d;
#   (2) LIVE-CAPTURES open pairs: batched stream prices (~1s cadence) into
#       a rotating tick CSV + newly closed 1m candles every 60s;
#   (3) writes everything under mini-services/trading-core/data/otc/
#       (gitignored) as JSONL/CSV that scripts/otc_battery.py reads.
#
# HONEST FRAMING: this is passive observation of the feed the broker
# already streams to the user's own session. No intrusion, no generator
# internals - the statistical battery decides later whether ANY exploitable
# structure exists, and out-of-sample + placebo controls decide whether a
# finding is real. If nothing is found, the defense layer's no_edge verdict
# gains evidence. Either outcome is a win.
#
# LAUNCH (must survive the sandbox reaper - always via daemonizer):
#   python3 /home/z/my-project/scripts/daemonizer.py \
#     bash -c "cd /home/z/my-project/live && exec python3 otc_harvester.py >> /home/z/my-project/mini-services/trading-core/data/otc/harvester.log 2>&1"

import csv
import json
import os
import signal
import sys
import time
import urllib.parse
import urllib.request
from datetime import datetime, timezone

BASE = "http://127.0.0.1:8788"
DATA_DIR = "/home/z/my-project/mini-services/trading-core/data/otc"
CANDLE_DIR = os.path.join(DATA_DIR, "candles_1m")
TIER1_DEPTH = 30 * 86400   # pairs with data in the last 48h
TIER2_DEPTH = 10 * 86400   # everything else
FRESH_CUTOFF = 48 * 3600
PAGE = 1000                # IQ caps get_candles at 1000/call
CALL_PACE = 0.2            # seconds between sidecar round-trips
PRICES_INTERVAL = 1.0      # live tick cadence
CANDLE_INTERVAL = 60.0     # live closed-candle append cadence
TICK_ROTATE_BYTES = 50 * 1024 * 1024

os.makedirs(CANDLE_DIR, exist_ok=True)
STOP = False


def _sigterm(_sig, _frm):
    global STOP
    STOP = True


signal.signal(signal.SIGTERM, _sigterm)
signal.signal(signal.SIGINT, _sigterm)


def log(msg: str) -> None:
    print(f"[harvest {datetime.now(timezone.utc).isoformat(timespec='seconds')}] {msg}", flush=True)


def fetch(path: str, body: dict | None = None, timeout: float = 25.0, tries: int = 3):
    url = BASE + path
    for attempt in range(tries):
        try:
            if body is None:
                req = urllib.request.Request(url)
            else:
                req = urllib.request.Request(
                    url, data=json.dumps(body).encode(),
                    headers={"Content-Type": "application/json"})
            with urllib.request.urlopen(req, timeout=timeout) as r:
                return json.loads(r.read().decode())
        except Exception as exc:  # noqa: BLE001
            if attempt == tries - 1:
                log(f"fetch FAILED {path[:80]}: {exc}")
                return None
            time.sleep(1.5 * (attempt + 1))
    return None


def pair_file(ticker: str) -> str:
    safe = ticker.replace("/", "_")
    return os.path.join(CANDLE_DIR, f"candles_1m__{safe}.jsonl")


def last_time_in_file(path: str) -> int:
    if not os.path.exists(path):
        return 0
    t = 0
    try:
        with open(path, "rb") as fh:
            # files are appended chronologically; scan the tail for speed
            fh.seek(0, os.SEEK_END)
            size = fh.tell()
            fh.seek(max(0, size - 65536))
            for line in fh.read().splitlines():
                line = line.strip()
                if not line:
                    continue
                try:
                    row = json.loads(line)
                    t = max(t, int(row["t"]))
                except Exception:  # noqa: BLE001
                    continue
    except Exception:  # noqa: BLE001
        pass
    return t


def append_candles(path: str, candles: list[dict]) -> int:
    if not candles:
        return 0
    with open(path, "a") as fh:
        for c in candles:
            fh.write(json.dumps({
                "t": int(c["time"]), "o": c["open"], "h": c["high"],
                "l": c["low"], "c": c["close"], "v": c.get("volume", 0),
            }, separators=(",", ":")) + "\n")
    return len(candles)


class Harvester:
    def __init__(self):
        self.status = {
            "started": time.time(),
            "phase": "boot",
            "pairs_total": 0,
            "pairs_open": 0,
            "backfill_done": {},     # ticker -> bars backfilled
            "ticks_written": 0,
            "live_candles_written": 0,
            "errors": 0,
            "updated": time.time(),
        }

    def save_status(self) -> None:
        self.status["updated"] = time.time()
        tmp = os.path.join(DATA_DIR, "harvester_status.json.tmp")
        with open(tmp, "w") as fh:
            json.dump(self.status, fh, indent=1)
        os.replace(tmp, os.path.join(DATA_DIR, "harvester_status.json"))

    # ---------------- backfill ----------------

    def probe_recency(self, tickers: list[str]) -> dict[str, int]:
        """One size=1 call per pair -> last candle age. Sequential, paced."""
        out = {}
        for i, t in enumerate(tickers):
            if STOP:
                break
            d = fetch(f"/candles?asset={urllib.parse.quote(t)}&size=1&tf=60")
            cs = (d or {}).get("candles") or []
            out[t] = cs[-1]["time"] if cs else 0
            if (i + 1) % 50 == 0:
                log(f"recency probe {i + 1}/{len(tickers)}")
            time.sleep(CALL_PACE)
        return out

    def backfill(self, ticker: str, depth_sec: int) -> int:
        path = pair_file(ticker)
        cutoff = int(time.time()) - depth_sec
        # resumable: a pair whose stored history already reaches the cutoff
        # (minus a small slop) is done - restarting the daemon must not
        # re-pull 30 days for every pair
        if last_time_in_file(path) and last_time_in_file(path) <= cutoff + 120:
            return 0
        end = int(time.time())
        written = 0
        seen_oldest = None
        while not STOP:
            d = fetch(f"/candles?asset={urllib.parse.quote(ticker)}&size={PAGE}&tf=60&end={end}")
            cs = (d or {}).get("candles") or []
            if not cs:
                break
            written += append_candles(path, cs)
            oldest = min(int(c["time"]) for c in cs)
            if seen_oldest is not None and oldest >= seen_oldest:
                break  # server is not paging further back - stop
            seen_oldest = oldest
            if oldest <= cutoff or len(cs) < PAGE:
                break
            end = oldest - 60
            time.sleep(CALL_PACE)
        return written

    # ---------------- live capture ----------------

    def live_tick_cycle(self, open_tickers: list[str]) -> None:
        """POST /prices in chunks of 40 - stream-first, no bus lock. Append
        every observed quote to the rotating tick CSV."""
        now = time.time()
        day = datetime.now(timezone.utc).strftime("%Y%m%d")
        path = os.path.join(DATA_DIR, f"ticks__{day}.csv")
        got_any = False
        for i in range(0, len(open_tickers), 40):
            chunk = open_tickers[i:i + 40]
            d = fetch("/prices", {"tickers": chunk}, timeout=10)
            prices = (d or {}).get("prices") or {}
            if not prices:
                continue
            got_any = True
            rows = [(f"{now:.3f}", t, repr(float(p))) for t, p in prices.items() if isinstance(p, (int, float))]
            with open(path, "a", newline="") as fh:
                csv.writer(fh).writerows(rows)
            self.status["ticks_written"] += len(rows)
        # rotation: roll to .gz when the active file gets heavy
        if got_any and os.path.exists(path) and os.path.getsize(path) > TICK_ROTATE_BYTES:
            import gzip
            with open(path, "rb") as fin, gzip.open(path + f".{int(now)}.gz", "wb") as fout:
                fout.writelines(fin)
            os.remove(path)

    def live_candle_cycle(self, open_tickers: list[str]) -> None:
        """Append newly CLOSED 1m candles for open pairs (size=3, cheap)."""
        now = int(time.time())
        bucket = (now // 60) * 60  # current (forming) candle open - skip it
        for t in open_tickers:
            if STOP:
                break
            path = pair_file(t)
            last = last_time_in_file(path)
            d = fetch(f"/candles?asset={urllib.parse.quote(t)}&size=3&tf=60")
            cs = (d or {}).get("candles") or []
            fresh = [c for c in cs if last < int(c["time"]) < bucket]
            if fresh:
                self.status["live_candles_written"] += append_candles(path, fresh)
            time.sleep(0.05)

    # ---------------- main ----------------

    def run(self) -> None:
        log("harvester booting")
        d = fetch("/assets", timeout=60)
        assets = (d or {}).get("assets") or []
        otc = [a for a in assets if str(a.get("ticker", "")).endswith("-OTC")]
        tickers = sorted({a["ticker"] for a in otc})
        open_set = {a["ticker"] for a in otc if a.get("is_open")}
        self.status.update(pairs_total=len(tickers), pairs_open=len(open_set))
        log(f"{len(tickers)} OTC pairs known, {len(open_set)} open now")

        # existing files count as already-backfilled (resumable)
        already = {t: last_time_in_file(pair_file(t)) for t in tickers}
        fresh_pairs, stale_pairs = [], []
        for t in tickers:
            if already[t] and already[t] >= time.time() - FRESH_CUTOFF:
                fresh_pairs.append(t)
            else:
                stale_pairs.append(t)
        log(f"{len(fresh_pairs)} pairs have data <48h old in store, {len(stale_pairs)} to probe")

        recency = self.probe_recency([t for t in stale_pairs])
        tier1 = fresh_pairs + [t for t, ts in recency.items() if ts >= time.time() - FRESH_CUTOFF]
        tier2 = [t for t, ts in recency.items() if ts < time.time() - FRESH_CUTOFF]
        log(f"backfill plan: tier1={len(tier1)} pairs @30d, tier2={len(tier2)} pairs @10d")
        self.status["phase"] = "backfill"

        for i, t in enumerate(tier1 + tier2):
            if STOP:
                break
            depth = TIER1_DEPTH if t in tier1 else TIER2_DEPTH
            n = self.backfill(t, depth)
            self.status["backfill_done"][t] = n
            if (i + 1) % 10 == 0:
                total = sum(self.status["backfill_done"].values())
                log(f"backfill {i + 1}/{len(tier1) + len(tier2)} - {t} +{n} bars (total {total})")
            self.save_status()
            # INTERLEAVE: live tick/candle capture must not wait for the
            # whole backfill (weekend OTC sessions are the scarce data)
            if open_set and (i + 1) % 5 == 0:
                try:
                    self.live_tick_cycle(sorted(open_set))
                except Exception as exc:  # noqa: BLE001
                    self.status["errors"] += 1
                    log(f"interleaved tick cycle error: {exc}")

        total = sum(self.status["backfill_done"].values())
        log(f"backfill complete: {total} bars across {len(self.status['backfill_done'])} pairs")
        self.status["phase"] = "live"

        last_candle_cycle = 0.0
        while not STOP:
            loop_start = time.time()
            live = sorted(open_set) if open_set else []
            if live:
                try:
                    self.live_tick_cycle(live)
                except Exception as exc:  # noqa: BLE001
                    self.status["errors"] += 1
                    log(f"tick cycle error: {exc}")
                if loop_start - last_candle_cycle >= CANDLE_INTERVAL:
                    last_candle_cycle = loop_start
                    try:
                        self.live_candle_cycle(live)
                    except Exception as exc:  # noqa: BLE001
                        self.status["errors"] += 1
                        log(f"candle cycle error: {exc}")
            self.save_status()
            dt = time.time() - loop_start
            time.sleep(max(0.2, PRICES_INTERVAL - dt))
        log("harvester stopped cleanly")


if __name__ == "__main__":
    Harvester().run()
