#!/usr/bin/env python3
"""Honest tradeable-outcome audit of the BONKUSD-OTC drift claim.

Question: does betting the majority (down) side every 1m candle actually WIN
at a binary payout of 0.82, under honest accounting?
  win  = close[i+1] < close[i]   (+0.82)
  lose = close[i+1] > close[i]   (-1.0)
  draw = close[i+1] == close[i]  (refund, 0)
Also: the walk-forward's rolling-K majority follower with the SAME rule,
plus the draw-counted-as-win variant (to expose how the 59.2% arose).
"""
import json

f = '/home/z/my-project/mini-services/trading-core/data/otc/candles_1m/candles_1m__BONKUSD-OTC.jsonl'
seen = {}
with open(f) as fh:
    for line in fh:
        try:
            r = json.loads(line)
            seen[r['t']] = (r['o'], r['h'], r['l'], r['c'])  # keep last write
        except Exception:
            pass
bars = [seen[t] for t in sorted(seen)]
closes = [b[3] for b in bars]
n = len(closes)
print(f'unique bars: {n}, span days: {(sorted(seen)[-1]-sorted(seen)[0])/86400:.1f}')

up = down = flat = 0
for i in range(1, n):
    d = closes[i] - closes[i - 1]
    if d > 0: up += 1
    elif d < 0: down += 1
    else: flat += 1
T = n - 1
print(f'transitions: up {up/T:.4f}  down {down/T:.4f}  flat {flat/T:.4f}')

# honest down-bet every bar
win = down / T
ev = win * 0.82 - up / T
print(f'DOWN every bar: win {win:.4f} ({win*100:.1f}%), EV/trade {ev:+.4f} (breakeven 55.0%)')

# draw-counted-as-win variant (the suspected flaw in the earlier study)
print(f'DOWN w/ draws as wins: {(down+flat)/T:.4f} ({(down+flat)/T*100:.1f}%)  <-- matches the 59.2% claim?')

# rolling-K majority follower (zero lookahead) over the whole archive
for K in (120, 500, 1500):
    wins = losses = draws = trades = 0
    for i in range(K, n - 1):
        w = closes[i - K:i]
        u = sum(1 for j in range(1, len(w)) if w[j] > w[j - 1])
        dn = sum(1 for j in range(1, len(w)) if w[j] < w[j - 1])
        side = 1 if dn > u else (-1 if u > dn else 0)  # majority side, down-positive
        if side == 0: continue
        trades += 1
        d = closes[i + 1] - closes[i]
        if side == 1:
            if d < 0: wins += 1
            elif d > 0: losses += 1
            else: draws += 1
        else:
            if d > 0: wins += 1
            elif d < 0: losses += 1
            else: draws += 1
    wr = wins / max(1, trades)
    ev = (wins * 0.82 - losses) / max(1, trades)
    wr_drawwin = (wins + draws) / max(1, trades)
    print(f'K={K:>5}: trades {trades}, win {wr*100:.1f}%, EV {ev:+.4f}, win+draw {wr_drawwin*100:.1f}%')
