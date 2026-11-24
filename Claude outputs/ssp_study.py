"""Faithful Python port of the kernel's SSP (steady, shock-free pressure, with the trend) = story.ssp() with default settings.
Pure standard library. Used by ssp_study.py. Verified against the TypeScript engine on recorded data (see ssp_verify.py)."""
import math

def true_range(h, l, c):
    out = [0.0] * len(c)
    if c: out[0] = h[0] - l[0]
    for i in range(1, len(c)):
        out[i] = max(h[i] - l[i], abs(h[i] - c[i - 1]), abs(l[i] - c[i - 1]))
    return out

def atr(h, l, c, period=14):
    tr = true_range(h, l, c)
    out = [float('nan')] * len(c)
    acc = 0.0
    for i in range(len(c)):
        if i < period:
            acc += tr[i]
            if i == period - 1: out[i] = acc / period
        else:
            out[i] = (out[i - 1] * (period - 1) + tr[i]) / period
    return out

def ema(src, period):
    out = [float('nan')] * len(src)
    k = 2 / (period + 1)
    seed = 0.0
    for i in range(len(src)):
        if i < period - 1: seed += src[i]; continue
        if i == period - 1: seed += src[i]; out[i] = seed / period
        else: out[i] = src[i] * k + out[i - 1] * (1 - k)
    return out

def sign(x): return (x > 0) - (x < 0)

def ssp(closed, five, open_sec, now_sec, tf_sec=60, atr_period=14,
        burst_sec=10.0, shock_thr=0.30, press_thr=0.12, min_eff=0.30):
    """closed = list of closed bars [t,o,h,l,c] BEFORE the forming candle (the last ~300).
    five = list of 5-second bars [t,o,h,l,c] whose start time is within [open_sec, now_sec].
    Returns +1 (call), -1 (put) or 0 (no setup)."""
    if len(closed) < 60 or not five: return 0
    h = [b[2] for b in closed]; l = [b[3] for b in closed]; c = [b[4] for b in closed]
    a = atr(h, l, c, atr_period)[-1]
    if not (a > 0): return 0
    e20, e50 = ema(c, 20), ema(c, 50)
    tc, a20, a50 = c[-1], e20[-1], e50[-1]
    if math.isnan(a20) or math.isnan(a50): trend = 0
    else: trend = 1 if (a20 > a50 and tc > a50) else (-1 if (a20 < a50 and tc < a50) else 0)
    opn = five[0][1]
    pts = [(open_sec, opn)]
    for b in five:
        t = b[0] + 5
        if t > open_sec and t <= now_sec + 1e-6: pts.append((t, b[4]))
    pts.sort(key=lambda x: x[0])
    P = pts[-800:] if len(pts) > 800 else pts
    if len(P) < 4: return 0
    freshness = max(10.0, 0.3 * tf_sec)
    last = P[-1][1]; body = last - opn
    bi = bj = 0; bmv = 0.0
    for i in range(len(P) - 1):
        j = i + 1
        while j < len(P) and P[j][0] - P[i][0] <= burst_sec + 1e-6:
            mv = P[j][1] - P[i][1]
            if abs(mv) > abs(bmv): bmv, bi, bj = mv, i, j
            j += 1
    shock_atr = abs(bmv) / a; shock_age = now_sec - P[bj][0]
    shock = shock_atr >= shock_thr and shock_age <= freshness
    if shock: return 0                      # SSP needs NO shock
    rest_net = body
    path = sum(abs(P[k][1] - P[k - 1][1]) for k in range(1, len(P)))
    eff = abs(rest_net) / path if path > 0 else 0.0
    pressure = (abs(rest_net) / a) >= press_thr and eff >= min_eff
    if not pressure: return 0
    if trend == 0: return 0
    return 1 if trend > 0 else -1           # WITH THE TREND



def sp(closed, five, open_sec, now_sec, tf_sec=60, atr_period=14,
       burst_sec=10.0, shock_thr=0.30, press_thr=0.12, min_eff=0.30):
    """story.sp() with default settings: cases 1 and 2 only.
    1 = pressure UP + shock UP -> PUT (-1);  2 = pressure DOWN + shock DOWN -> CALL (+1);  anything else 0."""
    if len(closed) < 60 or not five: return 0
    h = [b[2] for b in closed]; l = [b[3] for b in closed]; c = [b[4] for b in closed]
    a = atr(h, l, c, atr_period)[-1]
    if not (a > 0): return 0
    opn = five[0][1]
    pts = [(open_sec, opn)]
    for b in five:
        t = b[0] + 5
        if t > open_sec and t <= now_sec + 1e-6: pts.append((t, b[4]))
    pts.sort(key=lambda x: x[0])
    P = pts[-800:] if len(pts) > 800 else pts
    if len(P) < 4: return 0
    freshness = max(10.0, 0.3 * tf_sec)
    last = P[-1][1]; body = last - opn
    bi = bj = 0; bmv = 0.0
    for i in range(len(P) - 1):
        j = i + 1
        while j < len(P) and P[j][0] - P[i][0] <= burst_sec + 1e-6:
            mv = P[j][1] - P[i][1]
            if abs(mv) > abs(bmv): bmv, bi, bj = mv, i, j
            j += 1
    shock_atr = abs(bmv) / a; shock_age = now_sec - P[bj][0]
    shock = shock_atr >= shock_thr and shock_age <= freshness
    if not shock: return 0                   # sp needs a shock
    shock_dir = sign(bmv)
    rest_net = body - bmv
    path = 0.0
    for k in range(1, len(P)):
        if bi < k <= bj: continue
        path += abs(P[k][1] - P[k - 1][1])
    eff = abs(rest_net) / path if path > 0 else 0.0
    pressure = (abs(rest_net) / a) >= press_thr and eff >= min_eff
    if not pressure: return 0
    pdir = sign(rest_net)
    if pdir > 0 and shock_dir > 0: return -1    # case 1 -> put
    if pdir < 0 and shock_dir < 0: return 1     # case 2 -> call
    return 0                                     # a shock against the pressure = no call


import csv, json, math, sys, time, urllib.request
from collections import defaultdict
from datetime import datetime, timezone, timedelta
from math import comb

DAYS = int(sys.argv[1]) if len(sys.argv) > 1 else 7
END = int(time.time()) // 60 * 60 - 120

def get(url):
    err = None
    for _ in range(4):
        try:
            with urllib.request.urlopen(urllib.request.Request(url, headers={'User-Agent': 'Mozilla/5.0'}), timeout=25) as r: return json.loads(r.read())
        except Exception as e:
            err = e; time.sleep(1.5)
    raise SystemExit('request failed: %s' % err)

def fetch_1s(start, end):
    rows, t, n = [], start, 0
    while t < end:
        d = get('https://data-api.binance.vision/api/v3/klines?symbol=BTCUSDT&interval=1s&startTime=%d&endTime=%d&limit=1000' % (t * 1000, end * 1000))
        if not d: break
        for k in d: rows.append((k[0] // 1000, float(k[1]), float(k[2]), float(k[3]), float(k[4])))
        nt = d[-1][0] // 1000 + 1
        if nt <= t: break
        t = nt; n += 1; time.sleep(0.12)
        if n % 50 == 0: print('  downloaded %d seconds (%.1f%%)' % (len(rows), 100.0 * (t - start) / max(1, end - start)), flush=True)
    return rows

def fold(rows, sec):
    out, cur = [], None
    for t, o, h, l, c in rows:
        b = t // sec * sec
        if cur is None or cur[0] != b:
            if cur is not None: out.append(cur)
            cur = [b, o, h, l, c]
        else:
            cur[2] = max(cur[2], h); cur[3] = min(cur[3], l); cur[4] = c
    if cur is not None: out.append(cur)
    return out

def pval(n, w):  # one-sided exact binomial P(X >= w | n, 0.5)
    return sum(comb(n, k) for k in range(w, n + 1)) / 2 ** n if n else 1.0

def fmt(a):
    n = len(a); w = sum(1 for x in a if x)
    return '%5d sig %5d wins %5.1f%%  p=%.3f' % (n, w, 100.0 * w / n, pval(n, w)) if n else '    0 sig'

def run(rows1s):
    m1 = fold(rows1s, 60); s5 = fold(rows1s, 5)
    s5t = [b[0] for b in s5]
    import bisect
    price_at = {b[0]: b for b in s5}
    out = []   # one record per (minute, checkpoint)
    for i in range(300, len(m1)):
        o = m1[i][0]
        if m1[i][0] - m1[i - 1][0] != 60: continue          # skip minutes right after a data gap
        closed = m1[i - 300:i]
        if closed[-1][0] != o - 60: continue
        for off in (30, 45):
            lo = bisect.bisect_left(s5t, o); hi = bisect.bisect_right(s5t, o + off)
            five = s5[lo:hi]
            if len(five) < 5: continue
            now = o + off
            last5 = [b for b in five if b[0] + 5 <= now]
            if len(last5) < 5: continue
            entry = last5[-1][4]
            d = ssp(closed, five, o, now); dsp = sp(closed, five, o, now)
            mclose = m1[i][4]
            nxt = price_at.get(now)                             # the 5s bar that starts at the checkpoint
            delayed = nxt[1] if nxt else None                   # its open = the price 5 s later ... (delayed entry ~ now)
            e60 = price_at.get(now + 55)                        # 5s bar starting at now+55 -> its close = price at now+60
            drift = sign(entry - five[0][1])
            out.append(dict(o=o, off=off, d=d, dsp=dsp, drift=drift, entry=entry, mclose=mclose,
                            delayed=(price_at.get(now + 5)[1] if price_at.get(now + 5) else None),
                            p60=(e60[4] if e60 else None)))
    return out

def report(res, utc_offset=1, model='ssp'):
    key = 'd' if model == 'ssp' else 'dsp'
    for off in (30, 45):
        R0 = [r for r in res if r['off'] == off]
        R = [dict(r, d=r[key]) for r in R0]
        S = [r for r in R if r['d'] != 0 and r['mclose'] != r['entry']]
        win = lambda r, ex, en=None: ((ex - (r['entry'] if en is None else en)) * r['d'] > 0) if ex is not None and (en if en is not None else r['entry']) is not None and ex != (r['entry'] if en is None else en) else None
        print('\n' + '=' * 78)
        print('%s, checkpoint +%ds into the minute  |  %d minutes tested, %d %s signals (%.1f%% of minutes)' % (model.upper(), off, len(R), len(S), model.upper(), 100.0 * len(S) / max(1, len(R))))
        print('=' * 78)
        A = [win(r, r['mclose']) for r in S]; A = [x for x in A if x is not None]
        print('A) exit at the minute close (~%ds expiry):          %s' % (60 - off, fmt(A)))
        B = [win(r, r['p60']) for r in S]; B = [x for x in B if x is not None]
        print('B) fixed 60-second expiry from the checkpoint:     %s' % fmt(B))
        C = [win(r, r['mclose'], r['delayed']) for r in S if r['delayed'] is not None]; C = [x for x in C if x is not None]
        print('C) entry delayed 5 s, exit at the minute close:    %s' % fmt(C))
        # baselines on EVERY minute (not just SSP signals)
        fade = [((r['mclose'] - r['entry']) * -r['drift'] > 0) for r in R if r['drift'] != 0 and r['mclose'] != r['entry']]
        fol = [((r['mclose'] - r['entry']) * r['drift'] > 0) for r in R if r['drift'] != 0 and r['mclose'] != r['entry']]
        print('baseline: FADE the minute so far, every minute:   %s' % fmt(fade))
        print('baseline: FOLLOW the minute so far, every minute: %s' % fmt(fol))
        ag = [win(r, r['mclose']) for r in S if r['drift'] == -r['d']]; ag = [x for x in ag if x is not None]
        wi = [win(r, r['mclose']) for r in S if r['drift'] == r['d']]; wi = [x for x in wi if x is not None]
        print('%s trades AGAINST the minute drift:              %s' % (model.upper(), fmt(ag)))
        print('%s trades WITH the minute drift:                 %s' % (model.upper(), fmt(wi)))
        # time of day (local = UTC + utc_offset)
        byh = defaultdict(list)
        for r in S:
            w = win(r, r['mclose'])
            if w is not None: byh[(datetime.fromtimestamp(r['o'], timezone.utc) + timedelta(hours=utc_offset)).hour].append(w)
        print('\nby hour of day (UTC+%d), variant A:' % utc_offset)
        sigh = 0
        for h in range(24):
            if byh[h]:
                n = len(byh[h]); w = sum(byh[h]); p = pval(n, w)
                if p < 0.05: sigh += 1
                print('  %02d:00  %s%s' % (h, fmt(byh[h]), '   <-- p<0.05' if p < 0.05 else ''))
        print('  hours with p<0.05: %d of %d tested (by chance alone expect about %.1f)' % (sigh, sum(1 for h in byh if byh[h]), 0.05 * sum(1 for h in byh if byh[h])))
        inw = [x for h in (13, 14, 15) for x in byh.get(h, [])]
        outw = [x for h in range(24) if h not in (13, 14, 15) for x in byh.get(h, [])]
        print('\n1pm-4pm UTC+%d window:   %s' % (utc_offset, fmt(inw)))
        print('rest of the day:         %s' % fmt(outw))
        # stability: by day
        byd = defaultdict(list)
        for r in S:
            w = win(r, r['mclose'])
            if w is not None: byd[datetime.fromtimestamp(r['o'], timezone.utc).strftime('%Y-%m-%d')].append(w)
        print('\nby day (UTC), variant A:')
        for k in sorted(byd): print('  %s  %s' % (k, fmt(byd[k])))
        wd = defaultdict(list)
        for r in S:
            w = win(r, r['mclose'])
            if w is not None and (datetime.fromtimestamp(r['o'], timezone.utc) + timedelta(hours=utc_offset)).hour in (13, 14, 15): wd[datetime.fromtimestamp(r['o'], timezone.utc).strftime('%Y-%m-%d')].append(w)
        print('\nthe 1pm-4pm window, by day:')
        for k in sorted(wd): print('  %s  %s' % (k, fmt(wd[k])))

if __name__ == '__main__':
    start = END - DAYS * 86400
    print('Downloading ~%d days of 1-second BTCUSDT candles from Binance (public data, no key)...' % DAYS, flush=True)
    rows = fetch_1s(start, END)
    print('got %d seconds. Building bars and running SSP and SP...' % len(rows), flush=True)
    res = run(rows)
    report(res, model='ssp')
    report(res, model='sp')
    print('\nNOTE: Binance BTCUSDT prices, not the IQ quote; entry/exit have no payout, spread or latency except variants B and C. Read the p-values with the number of cells tested in mind.')
