#!/usr/bin/env python3
"""Measure TRUE unique-bar history in the OTC harvest archive (dedupe by open time)."""
import json, os, glob, time

d = '/home/z/my-project/mini-services/trading-core/data/otc/candles_1m'
files = sorted(glob.glob(os.path.join(d, '*.jsonl')))
print(f'{len(files)} files')
print(f"{'pair':22} {'lines':>7} {'unique':>7} {'dup_x':>6} {'span_h':>8} {'age_h':>6}")
worst = []
for f in files[:12] + [x for x in files if 'BONK' in x]:
    ts = []
    with open(f) as fh:
        for line in fh:
            try:
                ts.append(json.loads(line)['t'])
            except Exception:
                pass
    uniq = sorted(set(ts))
    span_h = (uniq[-1] - uniq[0]) / 3600 if uniq else 0
    age_h = (time.time() - uniq[-1]) / 3600 if uniq else 0
    name = os.path.basename(f).replace('candles_1m__', '').replace('.jsonl', '')
    dup = len(ts) / max(1, len(uniq))
    print(f'{name:22} {len(ts):>7} {len(uniq):>7} {dup:>5.1f}x {span_h:>8.2f} {age_h:>6.2f}')
    worst.append((len(uniq), name))
