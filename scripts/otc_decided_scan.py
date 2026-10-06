#!/usr/bin/env python3
"""Cross-pair FLAT-AWARE drift scan: decided-side z (up vs down among non-flat
transitions) over each pair's full deduped 1m archive. This is the honest
directional-drift test - the old all-transitions up-rate test confounds any
flat-candle mass with drift."""
import json, glob, os, math

d = '/home/z/my-project/mini-services/trading-core/data/otc/candles_1m'
rows = []
for f in sorted(glob.glob(os.path.join(d, '*.jsonl'))):
    seen = {}
    with open(f) as fh:
        for line in fh:
            try:
                r = json.loads(line)
                seen[r['t']] = r['c']
            except Exception:
                pass
    ts = sorted(seen)
    closes = [seen[t] for t in ts]
    n = len(closes)
    if n < 5000:
        continue
    up = down = flat = 0
    for i in range(1, n):
        diff = closes[i] - closes[i - 1]
        if diff > 0: up += 1
        elif diff < 0: down += 1
        else: flat += 1
    dec = up + down
    if dec < 1000:
        continue
    p = up / dec
    z = (p - 0.5) / math.sqrt(0.25 / dec)
    name = os.path.basename(f).replace('candles_1m__', '').replace('.jsonl', '')
    rows.append((abs(z), z, name, n, up / dec, flat / (n - 1)))

rows.sort(reverse=True)
print(f"{'pair':24} {'bars':>6} {'flat%':>6} {'decUp%':>7} {'decZ':>7}")
for az, z, name, n, p, fl in rows[:14]:
    print(f'{name:24} {n:>6} {fl*100:>5.1f}% {p*100:>6.2f}% {z:>+7.2f}')
print('...')
sig = [r for r in rows if r[0] >= 4]
print(f'\npairs with |decidedZ| >= 4 (would survive a fair-coin gate): {len(sig)} / {len(rows)}')
for az, z, name, n, p, fl in sig:
    print(f'  {name}: decZ {z:+.2f}, decUp {p*100:.2f}%, flat {fl*100:.1f}%')
