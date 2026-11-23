#!/usr/bin/env python3
"""Download 1-minute BTC candles WITH real volume from a public exchange endpoint (no account, no API key)
and write btc_volume_1m.csv (time,open,high,low,close,volume; time = epoch seconds, bar open).
Tries, in order: Binance (data-api.binance.vision, api.binance.com, api.binance.us) then Coinbase.
Usage:  python fetch_btc_volume.py [start_iso] [end_iso]
   e.g. python fetch_btc_volume.py 2026-11-20T18:00:00Z 2026-11-23T15:00:00Z   (these are the defaults)
Standard library only."""
import csv, json, sys, time, urllib.request, urllib.error
from datetime import datetime, timezone

def ts(s): return int(datetime.fromisoformat(s.replace('Z', '+00:00')).timestamp())
start = ts(sys.argv[1] if len(sys.argv) > 1 else '2026-11-20T18:00:00Z')
end = ts(sys.argv[2] if len(sys.argv) > 2 else '2026-11-23T15:00:00Z')

def get(url):
    req = urllib.request.Request(url, headers={'User-Agent': 'Mozilla/5.0'})
    with urllib.request.urlopen(req, timeout=20) as r: return json.loads(r.read())

def binance(host, symbol):
    rows, t = [], start
    while t < end:
        d = get(f'https://{host}/api/v3/klines?symbol={symbol}&interval=1m&startTime={t*1000}&endTime={end*1000}&limit=1000')
        if not d: break
        for k in d: rows.append((k[0] // 1000, float(k[1]), float(k[2]), float(k[3]), float(k[4]), float(k[5])))
        nt = d[-1][0] // 1000 + 60
        if nt <= t: break
        t = nt; time.sleep(0.2)
    return rows

def coinbase():
    rows, t = [], start
    while t < end:
        t2 = min(end, t + 300 * 60)
        iso = lambda x: datetime.fromtimestamp(x, timezone.utc).strftime('%Y-%m-%dT%H:%M:%SZ')
        d = get(f'https://api.exchange.coinbase.com/products/BTC-USD/candles?granularity=60&start={iso(t)}&end={iso(t2)}')
        for k in d: rows.append((k[0], float(k[3]), float(k[2]), float(k[1]), float(k[4]), float(k[5])))  # [time, low, high, open, close, volume]
        t = t2; time.sleep(0.4)
    return rows

sources = [('binance data-api', lambda: binance('data-api.binance.vision', 'BTCUSDT')), ('binance.com', lambda: binance('api.binance.com', 'BTCUSDT')),
           ('binance.us', lambda: binance('api.binance.us', 'BTCUSDT')), ('coinbase', coinbase)]
rows, used = [], None
for name, fn in sources:
    try:
        rows = fn()
        if len(rows) > 100: used = name; break
        print(f'{name}: only {len(rows)} rows, trying next')
    except (urllib.error.URLError, urllib.error.HTTPError, OSError, ValueError) as e:
        print(f'{name}: failed ({e}), trying next')
if not used:
    sys.exit('No source reachable from this network. Try another network / VPN, or tell Claude what each line above said.')
rows = sorted({r[0]: r for r in rows}.values())
with open('btc_volume_1m.csv', 'w', newline='') as f:
    w = csv.writer(f); w.writerow(['time', 'open', 'high', 'low', 'close', 'volume']); w.writerows(rows)
print(f'OK: {len(rows)} one-minute bars from {used}, {datetime.fromtimestamp(rows[0][0], timezone.utc)} .. {datetime.fromtimestamp(rows[-1][0], timezone.utc)} -> btc_volume_1m.csv')
