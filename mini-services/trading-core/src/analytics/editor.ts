// IQAIR//OS - the EDITOR chapter of the story: one verdict from pm (who is pushing), nm (where price is and what followed from here) and the weather (what kind of market this is).
//   AGREEMENT : pm (already blended with its higher timeframe) and nm agree -> stronger, opposite -> no call, one side silent -> that side at reduced weight.
//   WEATHER   : dead market -> no call; squeeze -> weaker; a call that goes AGAINST a trend while this pair's history says trend-following pays -> weaker; with it -> a little stronger.
//   INVALIDATION : the level that would prove the call wrong (the nearest nm level on the other side) and the chance, from nm's similar moments, that price gets there first.
// HONESTY: this stacks models that read the SAME candles, so agreement is weaker evidence than two independent sources. Use reportEditor() to measure whether agreement actually beat the better single model
// on a pair's own history before trusting the blend.

import { readCauseEffect, combineCeMtf, type CeCandle, type CeTick, type CeMtf, type CeResult } from './causeeffect'
import { readNextMove, combineNmPm, type NmResult } from './nextmove'
import { readWeather, type WxResult } from './weather'

export interface EditorOptions { htfTf?: string; horizon?: number; otc?: boolean }
export interface EditorResult {
  ok: boolean
  error?: string
  dir: 'call' | 'put' | 'none'
  prob: number
  strength: number
  agreement: 'aligned' | 'conflict' | 'nm-only' | 'pm-only' | 'no-call'
  regime: WxResult['regime']
  reasons: string[]
  invalidation: number
  invalidationProb: number
  tradeNow: boolean
  pm: CeMtf
  nm: NmResult
  wx: WxResult
  text: string
}

const clamp = (x: number, a: number, b: number) => Math.max(a, Math.min(b, x))

export function readEditor(candles: CeCandle[], ticks?: readonly CeTick[], htfCandles?: CeCandle[] | null, opts: EditorOptions = {}): EditorResult {
  const htfTf = opts.htfTf ?? '5m', otc = !!opts.otc
  const trig: CeResult = readCauseEffect(candles, ticks, { otc })
  let htf: CeResult | null = null
  if (htfTf !== 'none' && htfCandles && htfCandles.length) { try { htf = readCauseEffect(htfCandles, undefined, { otc }) } catch { htf = null } }
  const pm = combineCeMtf(trig, htf, htfTf)
  const nm = readNextMove(candles, { otc, horizon: opts.horizon })
  const wx = readWeather(candles)
  const fail = (error: string): EditorResult => ({ ok: false, error, dir: 'none', prob: 0.5, strength: 0, agreement: 'no-call', regime: wx.regime, reasons: [error], invalidation: NaN, invalidationProb: NaN, tradeNow: false, pm, nm, wx, text: error })
  if (!pm.ok && !nm.ok) return fail(`neither model has enough history (pm: ${trig.error ?? 'n/a'}; nm: ${nm.error ?? 'n/a'})`)
  const pmView = pm.ok ? { pm: { sign: pm.dir === 'call' ? 1 : pm.dir === 'put' ? -1 : 0, prob: pm.prob, confidence: pm.strength } } : null
  const cb = combineNmPm(nm, pmView)
  const reasons: string[] = []
  let dir = cb.dir, strength = cb.strength, prob = cb.prob
  reasons.push(cb.alignment === 'aligned' ? 'pm and nm agree' : cb.alignment === 'conflict' ? 'pm and nm point opposite ways' : cb.alignment === 'nm-only' ? 'only nm has a view (pm silent)' : cb.alignment === 'pm-only' ? 'only pm has a view (nm silent)' : 'neither model has a call')
  if (pm.ok && pm.alignment === 'conflict') { reasons.push(`pm's ${pm.htfTf} frame disagrees with its trigger`) }
  if (wx.ok && dir !== 'none') {
    if (wx.regime === 'dead') { dir = 'none'; strength = 0; prob = 0.5; reasons.push('dead market - no call') }
    else if (wx.regime === 'squeeze') { strength = Math.round(strength * 0.6); reasons.push('squeeze: tight and choppy, call weakened') }
    else {
      const withTrend = (wx.regime === 'trend-up' && dir === 'call') || (wx.regime === 'trend-down' && dir === 'put')
      const againstTrend = (wx.regime === 'trend-up' && dir === 'put') || (wx.regime === 'trend-down' && dir === 'call')
      if (againstTrend && wx.favours === 'follow') { strength = Math.round(strength * 0.7); reasons.push(`against a ${wx.regime} where following has paid on this pair`) }
      else if (withTrend && wx.favours === 'follow') { strength = Math.min(100, strength + 5); reasons.push(`with the ${wx.regime}, which has paid on this pair`) }
      else if (wx.regime === 'range' && wx.favours === 'fade') reasons.push('range where fading has paid on this pair')
      else reasons.push(`weather: ${wx.regime}`)
    }
  }
  // invalidation: the level on the other side, and the chance price reaches it first
  let invalidation = NaN, invalidationProb = NaN
  if (dir === 'call' && nm.ok) { invalidation = nm.reach.downLevel; invalidationProb = nm.reach.pDownFirst }
  else if (dir === 'put' && nm.ok) { invalidation = nm.reach.upLevel; invalidationProb = nm.reach.pUpFirst }
  const validatedAny = (pm.ok && trig.validation.validated) || (nm.ok && nm.nm.validated)
  const tradeNow = dir !== 'none' && strength >= 50 && validatedAny
  const text = `${dir === 'none' ? 'No call' : dir.toUpperCase() + ' ' + (prob * 100).toFixed(0) + '%'} (${strength}/100) - ${reasons.join('; ')}.${Number.isFinite(invalidation) ? ` Wrong if price reaches ${invalidation} first (${(invalidationProb * 100).toFixed(0)}% of similar cases did).` : ''} ${wx.text}`
  return { ok: true, dir, prob, strength, agreement: cb.alignment, regime: wx.regime, reasons, invalidation, invalidationProb, tradeNow, pm, nm, wx, text }
}

export interface EditorReport {
  ok: boolean
  error?: string
  bars: number
  step: number
  groups: Record<string, { n: number; hit: number; rate: number | null }>
  byRegime: Record<string, { n: number; hit: number; rate: number | null }>
  verdict: string
}

/** Walk over a pair's own history and measure, for the NEXT candle, how often each group was right: pm alone, nm alone, both agreeing, both conflicting (reported by pm's side), the editor's final call, and the
 * editor by regime. Each read uses only bars up to that point. The point: does agreement beat the better single model? */
export function reportEditor(candles: CeCandle[], ticks: readonly CeTick[] | undefined, opts: EditorOptions & { step?: number; from?: number } = {}): EditorReport {
  const step = Math.max(1, Math.round(opts.step ?? 8)), from = Math.max(200, opts.from ?? 200), n = candles.length
  const groups: EditorReport['groups'] = {}, byRegime: EditorReport['byRegime'] = {}
  const add = (m: Record<string, { n: number; hit: number; rate: number | null }>, k: string, ok: boolean) => { const g = (m[k] ??= { n: 0, hit: 0, rate: null }); g.n++; if (ok) g.hit++ }
  if (n < from + 20) return { ok: false, error: `needs ${from + 20} bars, have ${n}`, bars: n, step, groups, byRegime, verdict: '' }
  for (let t = from; t < n - 1; t += step) {
    const nextUp = candles[t + 1].close > candles[t].close, flat = candles[t + 1].close === candles[t].close
    if (flat) continue
    const sl = candles.slice(0, t + 1)
    const ed = readEditor(sl, ticks ? ticks.filter((x) => x.ts < (candles[t].time + 60) * 1000) : undefined, null, { ...opts, htfTf: 'none' })
    const right = (d: string) => (d === 'call') === nextUp
    if (ed.pm.ok && ed.pm.dir !== 'none') add(groups, 'pm alone', right(ed.pm.dir))
    if (ed.nm.ok && ed.nm.nm.dir !== 'none') add(groups, 'nm alone', right(ed.nm.nm.dir))
    if (ed.agreement === 'aligned') add(groups, 'pm + nm agree', right(ed.dir === 'none' ? ed.nm.nm.dir : ed.dir))
    if (ed.agreement === 'conflict' && ed.pm.dir !== 'none') add(groups, 'pm + nm conflict (pm side)', right(ed.pm.dir))
    if (ed.dir !== 'none') { add(groups, 'editor final call', right(ed.dir)); add(byRegime, ed.regime, right(ed.dir)) }
  }
  for (const m of [groups, byRegime]) for (const g of Object.values(m)) g.rate = g.n ? g.hit / g.n : null
  const r = (k: string) => groups[k]?.rate ?? null, nn = (k: string) => groups[k]?.n ?? 0
  const best = Math.max(r('pm alone') ?? 0, r('nm alone') ?? 0), ag = r('pm + nm agree')
  const verdict = ag === null || nn('pm + nm agree') < 30 ? 'Too few agreeing moments to judge (need 30+). Use a longer history or a smaller step.' : ag > best + 0.02 ? `Agreement beat the better single model (${(ag * 100).toFixed(1)}% vs ${(best * 100).toFixed(1)}%) - they complement each other on this pair, at least on this history.` : `Agreement did NOT clearly beat the better single model (${(ag * 100).toFixed(1)}% vs ${(best * 100).toFixed(1)}%) - stacking them adds little here.`
  return { ok: true, bars: n, step, groups, byRegime, verdict }
}
