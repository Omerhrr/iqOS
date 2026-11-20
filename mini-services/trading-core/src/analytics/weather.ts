// IQAIR//OS - the WEATHER chapter of the story: what kind of market is this right now?
// The same call means different things in a trend, a range, a squeeze and a dead market. This classifies the regime from price alone (works on OTC too):
//   er    : Kaufman efficiency ratio over 20 bars (net move / distance travelled; 1 = a straight line, 0 = chop)
//   chop  : Choppiness Index over 14 bars (>61.8 choppy, <38.2 trending)
//   volRank / bwRank : where today's ATR and Bollinger bandwidth sit among the last 300 bars (0..1)
//   atrRatio : ATR14 / ATR100 (expansion when well above 1)
// Regimes: dead, squeeze, expansion, trend-up, trend-down, range, mixed.
// It also looks BACK: in this pair's own history, in bars of the same regime, how often did the next candle continue the last 3 bars? -> `favours` follow (trend-following paid) / fade (reversal paid) / neither.
// HONESTY: thresholds are conventional, not fitted; `favours` is a count on this pair's history and says "neither" unless it has 30+ cases and a clear tilt.

export interface WxCandle { time: number; open: number; high: number; low: number; close: number }
export type WxRegime = 'dead' | 'squeeze' | 'expansion' | 'trend-up' | 'trend-down' | 'range' | 'mixed'
export interface WxResult {
  ok: boolean
  error?: string
  regime: WxRegime
  er: number; chop: number; volRank: number; bwRank: number; atrRatio: number
  favours: 'follow' | 'fade' | 'neither'
  momentumHit: number; momentumN: number
  tradeable: boolean
  text: string
}

const clamp = (x: number, a: number, b: number) => Math.max(a, Math.min(b, x))

export function readWeather(candles: WxCandle[]): WxResult {
  const c = candles.filter((x) => x && [x.high, x.low, x.close].every((v) => Number.isFinite(v)))
  const n = c.length
  const bad = (error: string): WxResult => ({ ok: false, error, regime: 'mixed', er: NaN, chop: NaN, volRank: NaN, bwRank: NaN, atrRatio: NaN, favours: 'neither', momentumHit: 0.5, momentumN: 0, tradeable: false, text: error })
  if (n < 150) return bad(`needs 150 closed bars, have ${n}`)
  const tr: number[] = [c[0].high - c[0].low]
  for (let i = 1; i < n; i++) tr.push(Math.max(c[i].high - c[i].low, Math.abs(c[i].high - c[i - 1].close), Math.abs(c[i].low - c[i - 1].close)))
  const sma = (arr: number[], i: number, w: number) => { let s = 0; for (let k = i - w + 1; k <= i; k++) s += arr[k]; return s / w }
  const atr14 = new Array<number>(n).fill(NaN), atr100 = new Array<number>(n).fill(NaN), er = new Array<number>(n).fill(NaN), chop = new Array<number>(n).fill(NaN), bw = new Array<number>(n).fill(NaN)
  const cl = c.map((x) => x.close)
  for (let i = 100; i < n; i++) {
    atr14[i] = sma(tr, i, 14); atr100[i] = sma(tr, i, 100)
    let path = 0; for (let k = i - 19; k <= i; k++) path += Math.abs(cl[k] - cl[k - 1])
    er[i] = path > 0 ? Math.abs(cl[i] - cl[i - 20]) / path : 0
    let hh = -Infinity, ll = Infinity, str = 0; for (let k = i - 13; k <= i; k++) { hh = Math.max(hh, c[k].high); ll = Math.min(ll, c[k].low); str += tr[k] }
    chop[i] = hh > ll ? clamp((100 * Math.log10(str / (hh - ll))) / Math.log10(14), 0, 100) : 50
    const m = sma(cl, i, 20); let v = 0; for (let k = i - 19; k <= i; k++) v += (cl[k] - m) ** 2
    bw[i] = m > 0 ? (4 * Math.sqrt(v / 20)) / m : 0
  }
  const rank = (arr: number[], i: number) => { let lo = 0, tot = 0; const from = Math.max(100, i - 299); for (let k = from; k <= i; k++) { if (!Number.isFinite(arr[k])) continue; tot++; if (arr[k] <= arr[i]) lo++ } return tot ? lo / tot : 0.5 }
  const classify = (i: number): WxRegime => {
    const e = er[i], ch = chop[i], vr = rank(atr14, i), br = rank(bw, i), ar = atr14[i] / atr100[i]
    // a clear directional character wins first; "dead"/"squeeze" additionally need volatility to have really FALLEN against its own 50-bar level (ranks alone fire by chance in any stationary series)
    if (ar > 1.4 && e > 0.35) return 'expansion'
    if (e > 0.4 && ch < 50) return cl[i] >= cl[i - 20] ? 'trend-up' : 'trend-down'
    if (vr < 0.25 && ar < 0.65) return 'dead'
    if (br < 0.25 && ch > 55 && ar < 0.95) return 'squeeze'
    if (e > 0.35 && ch < 50) return cl[i] >= cl[i - 20] ? 'trend-up' : 'trend-down'
    if (e < 0.2 || ch > 55) return 'range'
    return 'mixed'
  }
  const coarse = (r: WxRegime) => (r === 'trend-up' || r === 'trend-down' ? 'trend' : r)
  const t = n - 1, regime = classify(t), cls = coarse(regime)
  // history of this regime class: did the next candle continue the last 3 bars?
  let hit = 0, cnt = 0
  for (let i = 110; i < n - 1; i++) {
    if (coarse(classify(i)) !== cls) continue
    const prior = Math.sign(cl[i] - cl[i - 3]), next = Math.sign(cl[i + 1] - cl[i])
    if (prior === 0 || next === 0) continue
    cnt++; if (prior === next) hit++
  }
  const momentumHit = (hit + 0.5 * 10) / (cnt + 10)
  const favours: WxResult['favours'] = cnt >= 30 && momentumHit > 0.54 ? 'follow' : cnt >= 30 && momentumHit < 0.46 ? 'fade' : 'neither'
  const volRank = rank(atr14, t), bwRank = rank(bw, t), atrRatio = atr14[t] / atr100[t]
  const tradeable = regime !== 'dead' && regime !== 'squeeze'
  const desc: Record<WxRegime, string> = { dead: 'dead - very low volatility, little to trade', squeeze: 'squeeze - tight and choppy, a breakout may be coming but direction is unknown', expansion: 'expansion - volatility rising with direction', 'trend-up': 'trending up', 'trend-down': 'trending down', range: 'ranging - back and forth', mixed: 'mixed - no clear character' }
  const text = `Weather: ${desc[regime]} (efficiency ${er[t].toFixed(2)}, chop ${chop[t].toFixed(0)}, volatility ${(volRank * 100).toFixed(0)}th percentile, ATR x${atrRatio.toFixed(2)} of its 100-bar level). On this pair, in ${cls} conditions the next candle continued the last 3 bars ${(momentumHit * 100).toFixed(0)}% of ${cnt} times -> ${favours === 'follow' ? 'following the move has paid' : favours === 'fade' ? 'fading the move has paid' : 'no clear tilt'}.`
  return { ok: true, regime, er: er[t], chop: chop[t], volRank, bwRank, atrRatio, favours, momentumHit, momentumN: cnt, tradeable, text }
}
