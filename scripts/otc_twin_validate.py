#!/usr/bin/env python3
"""Task 54 validation: does /otc_twin output pass the Task 53 contrast battery?

The twin must be indistinguishable from the broker's OTC feed on every axis
of the recovered spec (iid, near-Gaussian, fair coin, no session structure),
AND must read synthetic-like. Also checks seeded-mode reproducibility.
"""
import json
import math
import urllib.request

BASE = "http://127.0.0.1:3030"


def get(path):
    with urllib.request.urlopen(BASE + path, timeout=30) as r:
        return json.load(r)


def battery(candles, label):
    closes = [c["close"] for c in candles]
    steps = [closes[i] - closes[i - 1] for i in range(1, len(closes))]
    n = len(steps)
    up = sum(1 for s in steps if s > 0)
    down = sum(1 for s in steps if s < 0)
    flat = sum(1 for s in steps if s == 0)
    dec = up + down
    dec_up = up / max(1, dec)
    z = (dec_up - 0.5) / math.sqrt(0.25 / max(1, dec))
    mean_abs = sum(abs(s) for s in steps) / n
    var = sum(s * s for s in steps) / n
    m2 = sum(s**4 for s in steps) / n
    kurt = m2 / (var * var) if var > 0 else 0  # normal -> 3
    # |r| acf lag-1..10 + Ljung-Box
    a = [abs(s) for s in steps]
    m = sum(a) / n
    dev = [v - m for v in a]
    c0 = sum(v * v for v in dev)
    rho = [sum(dev[k:] [0] * 0 for _ in [0]) if False else 0]
    rho = []
    for k in range(1, 11):
        num = sum(dev[i + k] * dev[i] for i in range(n - k))
        rho.append(num / c0 if c0 > 0 else 0)
    Q = n * (n + 2) * sum(r * r / (n - (k + 1)) for k, r in enumerate(rho, start=1))
    # Wilson-Hilferty chi2(10) p
    zh = (math.cbrt(Q / 10) - (1 - 2 / 90)) / math.sqrt(2 / 90)
    # normal sf via erfc
    p = 0.5 * math.erfc(zh / math.sqrt(2))
    # hourly vol spread
    hv = {}
    for i, c in enumerate(candles[1:], start=1):
        h = int(c["time"] // 3600)
        s = abs(closes[i] - closes[i - 1])
        hv.setdefault(h, [0.0, 0])
        hv[h][0] += s
        hv[h][1] += 1
    vols = sorted(v / c for v, c in hv.values() if c >= 30)
    spread = (vols[int(len(vols) * 0.99)] / vols[int(len(vols) * 0.01)]) if len(vols) >= 8 else 0
    print(f"  {label}:")
    print(f"    decided up-rate {dec_up:.4f} (z {z:+.2f})  flat {flat / n:.4f}")
    print(f"    kurtosis {kurt:.2f} (broker OTC ~3.9-4.2, real 161-236)")
    print(f"    |r| acf1 {rho[0]:+.4f}  LB(10) p {p:.3f}  (broker 0.003-0.028 / >0.3)")
    print(f"    hourly vol spread {spread:.2f}x (broker ~1.1x, real 3.6-3.8x)")
    return {"z": z, "acf1": rho[0], "lb": p, "kurt": kurt, "spread": spread}


twin = get("/otc_twin?asset=EURUSD-OTC&tf=1m&n=2000&payout=0.82")
assert twin.get("ok"), twin
forensics = get("/otc_forensics?asset=EURUSD-OTC&tf=1m&limit=2000")

print("== TWIN vs BROKER FEED (EURUSD-OTC, 1m) ==")
bt = battery(twin["twin"], "TWIN  (ours, recovered spec)")
# broker candles: forensics returns stats only; use live candles for the same window
try:
    broker = get("/candles?asset=EURUSD-OTC&tf=1m&size=2000")
    bc = broker.get("candles", [])
    if len(bc) > 300:
        bb = battery(bc, "BROKER (live/memory)")
    else:
        print("  BROKER: thin in memory, using forensics numbers instead")
except Exception as e:
    print("  BROKER candles fetch failed:", e)
print()
print("forensics on broker feed:", json.dumps(forensics["authenticity"]))
print("twin selfTest:", json.dumps(twin["selfTest"]))
print()
# reproducibility of seeded mode
s1 = get("/otc_twin?asset=EURUSD-OTC&tf=1m&n=100&seed=42")["twin"]
s2 = get("/otc_twin?asset=EURUSD-OTC&tf=1m&n=100&seed=42")["twin"]
s3 = get("/otc_twin?asset=EURUSD-OTC&tf=1m&n=100&seed=43")["twin"]
print("seeded reproducible (seed=42 == seed=42):", s1 == s2, "| different seed differs:", s1 != s3)
print("csprng runs differ (no accidental seeding):",
      get("/otc_twin?asset=EURUSD-OTC&tf=1m&n=100")["twin"] != get("/otc_twin?asset=EURUSD-OTC&tf=1m&n=100")["twin"])
