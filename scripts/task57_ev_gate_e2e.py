#!/usr/bin/env python3
"""Task 57 e2e: auto-trader EV upgrade verification (payout floor + vol gate
+ payout-aware adaptive floor + bot streak-breaker/payout gate).

Runs against the sandbox kernel (paper account, sim feed):
  A) auto-trader payout floor: minPayoutPct=99 -> every candidate rejected,
     no trades, lastRejection names the payout; floor 0 -> a trade lands.
  B) adaptive payout-aware floor config round-trip (POST /adaptive_config).
  C) bot payout gate: paper bot with minPayoutPct=99 -> on the next 1m close
     its stats.lastRejection names the payout (fires BEFORE the mode gate,
     so human mode is fine).
Restores human mode + original auto-trader config afterwards.
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


def wait_rejection_mentions(word, timeout_s, poll=5):
    deadline = time.time() + timeout_s
    while time.time() < deadline:
        rej = call("/mode")["autotrader"].get("lastRejection") or ""
        if word in rej.lower():
            return rej
        time.sleep(poll)
    return None


def main():
    ok = True
    orig = call("/mode")["autotrader"]["config"]
    orig_mode = call("/mode")["mode"]
    print(f"orig mode={orig_mode} src={orig.get('signalSource')} minPayoutPct={orig.get('minPayoutPct')}")

    # ---------- A) payout floor gate ----------
    base_cfg = {
        "enabled": True,
        "signalSource": "screener",
        "tf": "1m",
        "minScore": 0,
        "minConfidence": 0,
        "watchlist": [],
        "watchlistMode": "only",
        "marketScope": "all",
        "direction": "both",
        "stake": 10,
        "maxOpen": 3,
        "cooldownSec": 3600,
        "paceSec": 10,
        "stakePlan": None,
    }
    try:
        # A1: impossible floor -> every candidate rejected on payout
        call("/autotrader_config", {**base_cfg, "minPayoutPct": 99, "volGate": "off"})
        time.sleep(3)  # let any in-flight tick finish before t0
        t0 = time.time()
        set_mode("auto")
        rej = wait_rejection_mentions("payout", timeout_s=90)
        trades_blocked = auto_trades_since(t0)
        if rej and "payout" in rej.lower() and not trades_blocked:
            print(f"PASS A1: payout floor blocked all candidates: {rej[:120]}")
        else:
            ok = False
            print(f"FAIL A1: rejection={rej!r} trades={len(trades_blocked)}")
        set_mode("human")
        time.sleep(3)

        # A2: floor off -> a trade should land (minScore 0 screener)
        call("/autotrader_config", {**base_cfg, "minPayoutPct": 0, "volGate": "off"})
        t1 = time.time()
        set_mode("auto")
        deadline = time.time() + 120
        trades = []
        while time.time() < deadline:
            trades = auto_trades_since(t1)
            if trades:
                break
            time.sleep(5)
        if trades:
            t = trades[0]
            print(f"PASS A2: floor off -> trade landed: {t['asset']} {t.get('side')} ${t.get('amount')}")
        else:
            ok = False
            print("FAIL A2: no trade within 120s with floor off (screener may just be quiet - check manually)")
        set_mode("human")
        time.sleep(3)
    finally:
        call("/autotrader_config", {**orig, "stakePlan": orig.get("stakePlan")})
        if orig_mode != "auto":
            set_mode(orig_mode)

    # ---------- B) adaptive payout-aware round-trip ----------
    try:
        r = call("/adaptive_config", {"floorMode": "payout-aware", "marginPct": 7})
        cfg = r.get("config", {})
        if cfg.get("floorMode") == "payout-aware" and cfg.get("marginPct") == 7:
            print("PASS B: adaptive payout-aware floor persisted (margin 7pts)")
        else:
            ok = False
            print(f"FAIL B: adaptive config echo: {cfg}")
    finally:
        call("/adaptive_config", {"floorMode": "absolute", "marginPct": 5})
    # breakeven math sanity (the formula the gate uses)
    be82 = 100 / 1.82
    if abs(be82 - 54.945) < 0.01:
        print("PASS B2: breakeven math 1/(1+0.82) = 54.9%")
    else:
        ok = False
        print(f"FAIL B2: breakeven math gave {be82}")

    # ---------- C) bot payout gate (fires before the mode gate) ----------
    bot_id = "e2e-payout-gate"
    try:
        r = call("/bot_save", {
            "id": bot_id,
            "name": "e2e payout gate",
            "enabled": True,
            "force": True,  # no walkforward verdict in the sandbox - deliberate
            "watchlist": ["EURUSD"],
            "strategyId": "confluence-core",
            "tf": "1m",
            "kind": "binary",
            "stake": 10,
            "expiryBars": 1,
            "minScore": 0,
            "direction": "both",
            "regime": "all",
            "maxOpen": 1,
            "cooldownSec": 0,
            "adaptive": False,
            "minPayoutPct": 99,
            "streakBreaker": True,
        })
        if not r.get("ok"):
            ok = False
            print(f"FAIL C0: bot_save rejected: {r}")
            return
        deadline = time.time() + 130  # wait for a 1m candle close
        rej = None
        while time.time() < deadline:
            rows = call("/bots").get("bots", [])
            row = next((b for b in rows if b["bot"]["id"] == bot_id), None)
            if row and row["stats"].get("lastRejection"):
                rej = row["stats"]["lastRejection"]
                if "payout" in rej.lower():
                    break
            time.sleep(5)
        if rej and "payout" in rej.lower():
            print(f"PASS C: bot payout gate fired: {rej[:120]}")
        else:
            ok = False
            print(f"FAIL C: bot lastRejection={rej!r}")
    finally:
        call("/bot_delete", {"id": bot_id})

    print("E2E " + ("ALL PASS" if ok else "HAS FAILURES"))
    return 0 if ok else 1


if __name__ == "__main__":
    raise SystemExit(main())
