#!/usr/bin/env python3
"""Download BTCUSDT 1-SECOND candles from Binance's public endpoint (no account, no key), fold them into 5-second bars with volume,
and write btc_5s.csv (time,open,high,low,close,volume; time = epoch seconds, bar open) plus btc_5s.csv.gz.b64 (a one-line, copy/paste-friendly version).
Default = the last 24 h of the period your CSV covers. Usage: python3 fetch_btc_5s.py [start_iso] [end_iso]   (standard library only)"""
import base64, csv, gzip, hashlib, json, sys, time, urllib.request
from datetime import datetime

def ts(s): return int(datetime.fromisoformat(s.replace('Z', '+00:00')).timestamp())
start = ts(sys.argv[1] if len(sys.argv) > 1 else '2026-11-22T15:00:00Z')
end = ts(sys.argv[2] if len(sys.argv) > 2 else '2026-11-23T15:00:00Z')
def get(url):
    for host_try in range(3):
        try:
            with urllib.request.urlopen(urllib.request.Request(url, headers={'User-Agent': 'Mozilla/5.0'}), timeout=20) as r: return json.loads(r.read())
        except Exception as e:
            err = e; time.sleep(1.5)
    raise SystemExit(f'request failed: {err}')
rows, t, n = [], start, 0
while t < end:
    d = get(f'https://data-api.binance.vision/api/v3/klines?symbol=BTCUSDT&interval=1s&startTime={t*1000}&endTime={end*1000}&limit=1000')
    if not d: break
    for k in d: rows.append((k[0] // 1000, float(k[1]), float(k[2]), float(k[3]), float(k[4]), float(k[5])))
    nt = d[-1][0] // 1000 + 1
    if nt <= t: break
    t = nt; n += 1; time.sleep(0.15)
    if n % 20 == 0: print(f'  {len(rows)} seconds so far...', flush=True)
b = {}
for r in sorted({r[0]: r for r in rows}.values()):
    k = r[0] // 5 * 5
    if k not in b: b[k] = [k, r[1], r[2], r[3], r[4], r[5]]
    else: c = b[k]; c[2] = max(c[2], r[2]); c[3] = min(c[3], r[3]); c[4] = r[4]; c[5] += r[5]
out = [b[k] for k in sorted(b)]
with open('btc_5s.csv', 'w', newline='') as f:
    w = csv.writer(f); w.writerow(['time', 'open', 'high', 'low', 'close', 'volume']); w.writerows(out)
raw = open('btc_5s.csv', 'rb').read()
open('btc_5s.csv.gz.b64', 'w').write(base64.b64encode(gzip.compress(raw, 9)).decode())
print(f'OK: {len(rows)} one-second bars -> {len(out)} five-second bars; csv md5 {hashlib.md5(raw).hexdigest()}; b64 file {len(open("btc_5s.csv.gz.b64").read())} chars')
