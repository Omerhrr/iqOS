#!/usr/bin/env python3
"""Task 56 e2e: auto-trader strategy-selection + market-scope verification.

Runs against the sandbox kernel (paper account, sim feed):
  A) partial direction pin: CALL pinned to ema-trend, PUT falls back to the
     pool (macd-cross). Every trade's (side, strategy) pair must respect the
     pin layout - the unpinned side used to be completely dead.
  B) marketScope 'otc' -> every trade on a -OTC ticker;
     marketScope 'real' -> every trade on a real ticker.
Restores human mode + original config + OTC policy afterwards.

NOTE on leg isolation: set_mode('auto') fires an immediate tick, and a tick
already in flight when set_mode('human') lands can still complete its order
within the same second - so each leg sleeps 3s after returning to human and
filters trades with tsOpen >= t0 captured AFTER that sleep.
"""

import json
import time
import urllib.request

BASE = "http://localhost:3030"


def call(path, body=None, method=None):
    if body is None and method is None:
        method = "GET"
    req = urllib.request.Request(
        BASE + path,
        data=json.dumps(body).encode() if body is not None else (b"{}" if method == "POST" else None),
        method=method or ("POST" if body is not None else "GET"),
        headers={"content-type": "application/json"},
    )
    with urllib.request.urlopen(req, timeout=30) as r:
        return json.loads(r.read())


def auto_trades_since(ts):
    out = []
    for st in ("open", "closed"):
        for p in call(f"/positions?status={st}").get("positions", []):
            if str(p.get("note", "")).startswith("auto:") and p.get("tsOpen", 0) >= ts:
                out.append(p)
    seen, uniq = set(), []
    for p in out:
        if p["id"] not in seen:
            seen.add(p["id"])
            uniq.append(p)
    return uniq


def set_mode(mode):
    call("/mode_set", {"mode": mode})


def wait_for_trades(since_ts, want, timeout_s):
    deadline = time.time() + timeout_s
    while time.time() < deadline:
        trades = auto_trades_since(since_ts)
        if len(trades) >= want:
            return trades
        time.sleep(10)
    return auto_trades_since(since_ts)


def main():
    orig = call("/mode")["autotrader"]["config"]
    orig_otc_policy = call("/otc_config")["config"]["policy"]
    results = []
    try:
        # ---------- TEST A: partial direction pin + pool fallback ----------
        print("=== TEST A: partial direction pin (CALL->ema-trend, PUT->pool) ===", flush=True)
        call("/autotrader_config", {
            "enabled": True, "signalSource": "strategy",
            "strategyIds": ["ema-trend", "macd-cross"], "strategyPickMode": "ensemble",
            "minConfidence": 50, "directionStrategy": {"call": "ema-trend"},
            "direction": "both", "tf": "1m", "stake": 10, "maxOpen": 5,
            "cooldownSec": 0, "paceSec": 5, "pickVariety": 1,
            "watchlist": ["USDJPY", "USDCHF", "EURGBP", "NZDUSD"], "watchlistMode": "only",
            "marketScope": "all",
        })
        set_mode("auto")
        t0 = int(time.time())
        trades = wait_for_trades(t0, 2, 300)
        set_mode("human")
        time.sleep(3)  # let any in-flight tick finish before the next leg's clock starts
        print(f"A trades: {[(p['asset'], p['side'], p.get('strategy')) for p in trades]}", flush=True)
        ok_a = len(trades) > 0
        for p in trades:
            side, strat = p["side"], p.get("strategy")
            if strat == "ema-trend" and side != "call":
                ok_a = False
                print(f"  VIOLATION: pinned CALL strategy ema-trend traded {side}")
            if strat == "macd-cross" and side != "put":
                ok_a = False
                print(f"  VIOLATION: pool-owned PUT side got {side} from macd-cross")
            if strat not in ("ema-trend", "macd-cross"):
                ok_a = False
                print(f"  VIOLATION: unexpected strategy label {strat}")
        calls = [p for p in trades if p["side"] == "call"]
        puts = [p for p in trades if p["side"] == "put"]
        print(f"A: {len(calls)} call(s) via pin, {len(puts)} put(s) via pool fallback", flush=True)
        results.append(("A partial direction pin", ok_a))

        # ---------- TEST B: market scopes ----------
        call("/otc_config", {"policy": "warn"})  # let sim OTC trades through for the scope check
        base_cfg = {
            "enabled": True, "signalSource": "strategy", "strategyIds": ["ema-trend"],
            "strategyPickMode": "ensemble", "direction": "both", "tf": "1m", "stake": 10,
            "maxOpen": 5, "cooldownSec": 0, "paceSec": 5, "pickVariety": 1,
            "directionStrategy": {},
            "watchlist": [],
            "watchlistMode": "only",
        }
        legs = [
            ("otc", True, ["USDJPY-OTC", "EURJPY-OTC", "GBPJPY-OTC", "NZDUSD-OTC"]),
            # disjoint real pairs - the 1hr per-asset cooldown floor must not
            # collide with test A's watchlist (USDJPY/USDCHF/EURGBP/NZDUSD)
            ("real", False, ["USDCAD", "EURJPY", "CADJPY", "AUDJPY"]),
        ]
        for scope, expect_otc, watchlist in legs:
            print(f"=== TEST B: marketScope={scope} (expect {'-OTC only' if expect_otc else 'real only'}) ===", flush=True)
            call("/autotrader_config", {**base_cfg, "marketScope": scope, "watchlist": watchlist})
            set_mode("auto")
            t0 = int(time.time())
            trades = wait_for_trades(t0, 2, 300)
            set_mode("human")
            time.sleep(3)
            print(f"{scope} trades: {[(p['asset'], p['side']) for p in trades]}", flush=True)
            ok = len(trades) > 0
            for p in trades:
                is_otc = p["asset"].endswith("-OTC")
                if expect_otc and not is_otc:
                    ok = False
                    print(f"  VIOLATION: scope {scope} traded real pair {p['asset']}")
                if not expect_otc and is_otc:
                    ok = False
                    print(f"  VIOLATION: scope {scope} traded OTC pair {p['asset']}")
            results.append((f"B marketScope={scope}", ok))
    finally:
        # restore
        try:
            call("/otc_config", {"policy": orig_otc_policy})
            clean = {k: v for k, v in orig.items() if k not in ("planState", "strategyParams")}
            call("/autotrader_config", {**clean, "directionStrategy": {}, "pairStrategy": {}, "strategyIds": [], "marketScope": "all"})
            set_mode("human")
        except Exception as exc:  # noqa: BLE001
            print(f"RESTORE FAILED: {exc}")

    print("\n===== RESULTS =====")
    all_ok = True
    for name, ok in results:
        print(f"{'PASS' if ok else 'FAIL'}  {name}")
        all_ok = all_ok and ok
    print("ALL PASS" if all_ok else "SOME FAILED")
    return 0 if all_ok else 1


if __name__ == "__main__":
    raise SystemExit(main())
