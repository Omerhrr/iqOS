// IQAIR//OS - STORY STUDY: does any story actually predict the next candle?
//
// Labels every closed candle in a history by its story (candle kind, sweep, breakout, engulfing, how stretched the move was in sigmas, the 14/21-bar window kind and the window x candle
// combinations), then measures what price did `horizon` bars later. For each label it reports how often the next bar closed UP vs DOWN and, because a binary option only pays if you
// pick the side, which side was better - chosen on the FIRST 60% of the history only and then re-tested on the LAST 40% it never saw. A label is only called a survivor if the side
// it picked in-sample also beat break-even out of sample with enough trades.
//
// HONESTY (read this before trusting a row): dozens of labels are tested, so some will look good by luck; `expectedLucky` says how many survivors pure chance would hand you at this many
// labels. Ties count as non-wins for both sides. Break-even = 1 / (1 + payout). A survivor is a HYPOTHESIS for a strategy, not an edge - re-run on other pairs and other periods.
import type { Candle } from '../types'
import { readStory, readWindowStory, type StoryBars } from './candlestory'

export interface StudyRow {
  label: string
  n: number                       // times the label occurred (over the whole history)
  upRate: number; downRate: number
  side: 'call' | 'put'            // the better side on the in-sample part
  inN: number; inWin: number      // in-sample trades and win rate of that side
  outN: number; outWin: number    // out-of-sample trades and win rate of the SAME side
  outLower: number                // Wilson 95% lower bound of the out-of-sample win rate
  avgMoveAtr: number              // average signed next-bar move in ATR (positive = up)
  survivor: boolean
}
export interface StudyResult { ok: boolean; error?: string; bars: number; horizon: number; breakEven: number; baseUp: number; labels: number; survivors: number; expectedLucky: number; splitIndex: number; rows: StudyRow[] }

const wilson = (w: number, n: number): number => { if (n <= 0) return 0; const z = 1.96, p = w / n, d = 1 + z * z / n; return (p + z * z / (2 * n) - z * Math.sqrt(p * (1 - p) / n + z * z / (4 * n * n))) / d }
const view = (s: StoryBars, end: number): StoryBars => ({ open: s.open.slice(0, end + 1), high: s.high.slice(0, end + 1), low: s.low.slice(0, end + 1), close: s.close.slice(0, end + 1), time: s.time?.slice(0, end + 1) })

export function labelsAt(v: StoryBars): string[] {
  const st = readStory(v)
  if (!st.ok || !st.kind) return []
  const out: string[] = [`kind:${st.kind}${st.dir > 0 ? '+' : st.dir < 0 ? '-' : ''}`]
  if (st.sweep) out.push(`sweep:${st.sweep > 0 ? 'bull' : 'bear'}`)
  if (st.breakout) out.push(`breakout:${st.breakout > 0 ? 'up' : 'down'}`)
  if (st.engulf) out.push(`engulf:${st.engulf > 0 ? 'up' : 'down'}`)
  if (st.inside) out.push('inside-bar')
  if (Number.isFinite(st.moveSigma)) { const m = Math.abs(st.moveSigma); if (m >= 2) out.push(`move:extreme-${st.moveSigma > 0 ? 'up' : 'down'}`); else if (m >= 1) out.push(`move:stretched-${st.moveSigma > 0 ? 'up' : 'down'}`) }
  for (const n of [14, 21]) { const w = readWindowStory(v, n); if (w.ok) { out.push(`win${n}:${w.kind}`); if (st.sweep) out.push(`win${n}:${w.kind}+sweep:${st.sweep > 0 ? 'bull' : 'bear'}`); if (st.kind === 'rejection-high' || st.kind === 'rejection-low') out.push(`win${n}:${w.kind}+${st.kind}`) } }
  return out
}

export function studyStories(candles: Candle[], opts: { horizon?: number; payout?: number; minN?: number; split?: number } = {}): StudyResult {
  const horizon = Math.max(1, Math.min(10, Math.round(opts.horizon ?? 1))), payout = opts.payout ?? 0.85, minN = opts.minN ?? 25, split = Math.max(0.3, Math.min(0.8, opts.split ?? 0.6))
  const breakEven = 1 / (1 + payout)
  const n = candles.length
  const empty: StudyResult = { ok: false, bars: n, horizon, breakEven, baseUp: NaN, labels: 0, survivors: 0, expectedLucky: 0, splitIndex: 0, rows: [] }
  if (n < 400) return { ...empty, error: `need at least 400 candles for a story study, have ${n}` }
  const s: StoryBars = { open: candles.map((c) => c.open), high: candles.map((c) => c.high), low: candles.map((c) => c.low), close: candles.map((c) => c.close), time: candles.map((c) => c.time) }
  const warm = 60, last = n - 1 - horizon, splitIndex = warm + Math.floor((last - warm) * split)
  type Acc = { n: number; up: number; dn: number; inN: number; inUp: number; inDn: number; outN: number; outUp: number; outDn: number; move: number }
  const acc = new Map<string, Acc>()
  let baseUp = 0, baseN = 0
  for (let i = warm; i <= last; i++) {
    const v = view(s, i)
    const labs = labelsAt(v)
    const d = s.close[i + horizon] - s.close[i]
    baseN++; if (d > 0) baseUp++
    // ATR before this bar as the unit for the move
    let a = 0; for (let k = i - 13; k <= i; k++) a += Math.max(s.high[k] - s.low[k], Math.abs(s.high[k] - s.close[k - 1]), Math.abs(s.low[k] - s.close[k - 1])); a /= 14
    for (const l of labs) {
      let r = acc.get(l); if (!r) acc.set(l, (r = { n: 0, up: 0, dn: 0, inN: 0, inUp: 0, inDn: 0, outN: 0, outUp: 0, outDn: 0, move: 0 }))
      r.n++; if (d > 0) r.up++; else if (d < 0) r.dn++; r.move += a > 0 ? d / a : 0
      if (i < splitIndex) { r.inN++; if (d > 0) r.inUp++; else if (d < 0) r.inDn++ } else { r.outN++; if (d > 0) r.outUp++; else if (d < 0) r.outDn++ }
    }
  }
  const rows: StudyRow[] = []
  for (const [label, r] of acc) {
    if (r.n < minN || r.inN < 12 || r.outN < 8) continue
    const side: 'call' | 'put' = r.inUp >= r.inDn ? 'call' : 'put'
    const inWinC = side === 'call' ? r.inUp : r.inDn, outWinC = side === 'call' ? r.outUp : r.outDn
    const outWin = r.outN ? outWinC / r.outN : 0
    const outLower = wilson(outWinC, r.outN)
    const inWin = r.inN ? inWinC / r.inN : 0
    rows.push({ label, n: r.n, upRate: r.up / r.n, downRate: r.dn / r.n, side, inN: r.inN, inWin, outN: r.outN, outWin, outLower, avgMoveAtr: r.move / r.n, survivor: inWin > breakEven && outWin > breakEven && r.outN >= 30 && outLower > 0.5 })
  }
  rows.sort((x, y) => Number(y.survivor) - Number(x.survivor) || y.outLower - x.outLower)
  const survivors = rows.filter((x) => x.survivor).length
  return { ok: true, bars: n, horizon, breakEven, baseUp: baseN ? baseUp / baseN : NaN, labels: rows.length, survivors, expectedLucky: rows.length * 0.05, splitIndex, rows }
}
