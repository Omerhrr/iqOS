// IQAIR//OS - the story of every chart type (`story.of("renko" | "kagi" | "effort" | "ha" | "tickbars" | "ticks" | "baseline" | "footprint")`).
//
// candlestory.ts tells what the last candle(s) did. A strategy built on Renko, Kagi, effort bricks, Heikin Ashi, tick bars, ticks, a baseline or a footprint needs the same plain
// facts about THAT chart, so each one gets a story with the same shape: ok, kind (one label), dir (+1/-1/0), facts (named numbers a script can test), text (one readable
// paragraph). Everything is derived by the SAME engines the charts use (renko.ts, kagi.ts, effortbricks.ts, tickbars.ts, baseline.ts, footprint.ts, chartsignals.ts heikin ashi) -
// nothing is re-derived here, so the story and the chart cannot disagree.
//
// HONESTY: these describe. Whether a label predicts anything is a separate question (see storystudy.ts). The footprint here is the CANDLE footprint (volume spread over the range with a
// close-location buy/sell split - an approximation, no bid/ask feed); the raw live tick read is `ticks`.
import type { Candle } from '../types'
import { renkoBricks } from './renko'
import { kagi } from './kagi'
import { effortBricks } from './effortbricks'
import { heikinAshiSeries } from './chartsignals'
import { tickBars, type TickPoint } from './tickbars'
import { computeFootprint } from './footprint'

export type Fact = number | string | boolean
export interface ChartStory { ok: boolean; type: string; kind: string; dir: 1 | -1 | 0; facts: Record<string, Fact>; text: string }
const NA = (type: string, why: string): ChartStory => ({ ok: false, type, kind: '', dir: 0, facts: {}, text: why })
const f = (x: number, d = 2): string => (Number.isFinite(x) ? x.toFixed(d) : 'n/a')
const cap = (t: string): string => t.charAt(0).toUpperCase() + t.slice(1)
const side = (d: number): string => (d > 0 ? 'up' : d < 0 ? 'down' : 'flat')
const median = (a: number[]): number => { if (!a.length) return NaN; const s = [...a].sort((x, y) => x - y); const m = s.length >> 1; return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2 }

// ---------------------------------------------------------------- bricks (renko / effort / tick bars share this)
interface RunFacts { cur: number; curDir: 1 | -1 | 0; prev: number; longest: number; flips: number; flipShare: number; avgRun: number }
export function runFacts(dirs: number[], window = 30): RunFacts {
  const d = dirs.slice(-window)
  if (!d.length) return { cur: 0, curDir: 0, prev: 0, longest: 0, flips: 0, flipShare: 0, avgRun: 0 }
  const runs: number[] = []; let len = 1
  for (let i = 1; i < d.length; i++) { if (d[i] === d[i - 1]) len++; else { runs.push(len); len = 1 } }
  runs.push(len)
  const flips = runs.length - 1
  return { cur: runs[runs.length - 1], curDir: d[d.length - 1] > 0 ? 1 : -1, prev: runs.length >= 2 ? runs[runs.length - 2] : 0, longest: Math.max(...runs), flips, flipShare: d.length > 1 ? flips / (d.length - 1) : 0, avgRun: runs.reduce((a, b) => a + b, 0) / runs.length }
}
function brickKind(r: RunFacts): string {
  if (r.flipShare >= 0.5) return 'chop'
  if (r.cur >= 6) return 'extended-run'
  if (r.cur >= 3) return 'trend-run'
  if (r.cur <= 2 && r.prev >= 4) return 'fresh-reversal'
  if (r.cur === 1 && r.prev === 1) return 'chop'
  return 'building'
}
function brickSentence(what: string, r: RunFacts, kind: string): string {
  const s = side(r.curDir)
  const base: Record<string, string> = {
    'extended-run': `an extended ${s} run: ${r.cur} ${what} in a row (the longest in the window is ${r.longest})`,
    'trend-run': `a ${s} trend run of ${r.cur} ${what}`,
    'fresh-reversal': `a fresh reversal to ${s} after a ${r.prev}-${what.replace(/s$/, '')} run the other way (only ${r.cur} so far)`,
    chop: `chop: the ${what} flipped direction ${r.flips} times in the last ${Math.round(r.flips / Math.max(0.01, r.flipShare)) + 1}, no run is lasting`,
    building: `a ${s} move that is still building (${r.cur} ${what} so far, previous run ${r.prev})`,
  }
  return base[kind] ?? `${r.cur} ${what} ${s}`
}

export function storyRenko(candles: Candle[], opts: { brickSize?: number; atrPeriod?: number; atrMult?: number; window?: number } = {}): ChartStory {
  if (candles.length < 30) return NA('renko', 'not enough candles to build renko bricks')
  const r = renkoBricks(candles, opts)
  if (r.bricks.length < 3) return NA('renko', `only ${r.bricks.length} renko bricks so far`)
  const dirs = r.bricks.map((b) => b.dir), rf = runFacts(dirs, opts.window ?? 30), kind = brickKind(rf)
  const last = r.bricks[r.bricks.length - 1], px = candles[candles.length - 1].close, size = r.brickSize
  const progress = rf.curDir > 0 ? (px - last.close) / size : (last.close - px) / size      // >0 toward the next same-direction brick, <0 a pullback
  const toReversal = 2 + Math.min(0, progress)                                                    // renko reverses after 2 bricks against the run
  const span = candles.length >= 2 ? candles[candles.length - 1].time - candles[candles.length - 2].time : 0
  const barsSince = span > 0 ? Math.round((candles[candles.length - 1].time - last.time) / span) : NaN
  let sameBar = 0; for (let k = r.bricks.length - 1; k >= 0 && r.bricks[k].time === last.time; k--) sameBar++
  const parts = [brickSentence('bricks', rf, kind)]
  parts.push(progress < 0 ? `price has pulled back ${f(-progress)} brick(s), ${f(toReversal)} more would reverse the run` : `price is ${f(progress)} brick(s) into the next one`)
  if (Number.isFinite(barsSince)) parts.push(barsSince === 0 ? `the last brick painted on the latest candle${sameBar > 1 ? ` (${sameBar} bricks in one candle - a fast move)` : ''}` : `the last brick painted ${barsSince} candle(s) ago (${barsSince >= 6 ? 'stalling' : 'recent'})`)
  const atrRatio = Number.isFinite(r.atr) && r.atr > 0 ? size / r.atr : NaN
  return { ok: true, type: 'renko', kind, dir: rf.curDir, facts: { run: rf.cur, prevRun: rf.prev, longestRun: rf.longest, flips: rf.flips, flipShare: rf.flipShare, avgRun: rf.avgRun, brickSize: size, brickAtr: atrRatio, progress, toReversal, barsSinceBrick: barsSince, bricksLastCandle: sameBar, bricks: r.bricks.length }, text: cap(parts.join('; ')) + '.' }
}

export function storyEffort(candles: Candle[], opts: { brickSize?: number; atrPeriod?: number; atrMult?: number; effortMult?: number; lookback?: number; window?: number } = {}): ChartStory {
  if (candles.length < 30) return NA('effort', 'not enough candles to build effort bricks')
  const r = effortBricks(candles, opts)
  if (r.bricks.length < 3) return NA('effort', `only ${r.bricks.length} effort bricks so far`)
  const rf = runFacts(r.bricks.map((b) => b.dir), opts.window ?? 30), kind0 = brickKind(rf)
  const last = r.bricks[r.bricks.length - 1]
  let confRun = 0; for (let k = r.bricks.length - 1; k >= 0 && r.bricks[k].confirmed; k--) confRun++
  const kind = r.effortSource === 'none' ? kind0 : r.regime === 'trending' && (kind0 === 'trend-run' || kind0 === 'extended-run') ? 'confirmed-trend' : r.regime === 'choppy' ? 'unconfirmed-chop' : r.regime === 'ranging' ? 'confirmed-range' : kind0
  const parts = [brickSentence('bricks', rf, kind0)]
  if (r.effortSource === 'none') parts.push('there is no volume in this window, so effort cannot confirm anything')
  else {
    parts.push(`the last brick took ${f(last.effortRatio)}x the usual effort (${last.confirmed ? 'confirmed' : 'not confirmed'}); ${(r.confirmedRatio * 100).toFixed(0)}% of the last ${r.lookback} bricks were confirmed${confRun >= 2 ? `, and the last ${confRun} in a row were` : ''}`)
    parts.push(`regime: ${r.regime}`)
  }
  return { ok: true, type: 'effort', kind, dir: rf.curDir, facts: { run: rf.cur, prevRun: rf.prev, flips: rf.flips, flipShare: rf.flipShare, effortRatio: last.effortRatio, confirmed: last.confirmed, confirmedRun: confRun, confirmedRatio: r.confirmedRatio, regime: r.regime, effortSource: r.effortSource, brickSize: r.brickSize }, text: cap(parts.join('; ')) + '.' }
}

export function storyKagi(candles: Candle[], opts: { reversal?: number; atrPeriod?: number; reversalAtrMult?: number; regimeLookback?: number } = {}): ChartStory {
  if (candles.length < 30) return NA('kagi', 'not enough candles to build kagi lines')
  const k = kagi(candles, opts)
  if (k.lines.length < 1) return NA('kagi', 'no kagi lines yet')
  const lines = k.lines, lastL = lines[lines.length - 1], prevL = lines.length >= 2 ? lines[lines.length - 2] : { price: candles[0].close }
  const leg = k.reversal > 0 ? Math.abs(lastL.price - prevL.price) / k.reversal : NaN
  const ev = k.events[k.events.length - 1]
  const evAgo = ev ? candles.length - 1 - ev.index : NaN
  const dirEv = k.events.filter((e) => e.type === 'reversal'); const lastRev = dirEv[dirEv.length - 1]; const revAgo = lastRev ? candles.length - 1 - lastRev.index : NaN
  let kind: string
  if (k.regime === 'choppy') kind = 'choppy'
  else if (Number.isFinite(revAgo) && revAgo <= 3) kind = k.direction > 0 ? 'fresh-reversal-up' : 'fresh-reversal-down'
  else if (k.direction > 0 && k.thick) kind = 'yang-trend'
  else if (k.direction < 0 && !k.thick) kind = 'yin-trend'
  else if (k.direction > 0) kind = 'weak-up'
  else if (k.direction < 0) kind = 'weak-down'
  else kind = 'flat'
  const s = side(k.direction)
  const head: Record<string, string> = {
    choppy: `a choppy kagi: ${k.legsInWindow} reversals inside the last ${opts.regimeLookback ?? 40} candles, too many for the structure to mean much`,
    'fresh-reversal-up': `the line just reversed up (${revAgo} candle(s) ago)`, 'fresh-reversal-down': `the line just reversed down (${revAgo} candle(s) ago)`,
    'yang-trend': 'a strong rising line: thick (yang), price is above the last shoulder, buyers are in charge',
    'yin-trend': 'a strong falling line: thin (yin), price is below the last waist, sellers are in charge',
    'weak-up': 'a rising line that is still thin: it is going up but has not broken the last shoulder yet',
    'weak-down': 'a falling line that is still thick: it is going down but has not broken the last waist yet', flat: 'no direction yet',
  }
  const parts = [head[kind]]
  if (k.structure !== 'none') parts.push(`structure: ${k.structure === 'hh-hl' ? 'higher highs and higher lows' : 'lower highs and lower lows'}`)
  parts.push(`the current line is ${f(leg, 1)} reversal-units long`)
  if (k.shoulder !== null) parts.push(`shoulder ${f(k.shoulder, 5)}`)
  if (k.waist !== null) parts.push(`waist ${f(k.waist, 5)}`)
  if (ev && Number.isFinite(evAgo)) parts.push(`last event: ${ev.type === 'reversal' ? (ev.dir > 0 ? 'up-reversal' : 'down-reversal') : ev.type === 'yang' ? 'broke the shoulder (turned thick)' : 'broke the waist (turned thin)'} ${evAgo} candle(s) ago`)
  parts.push(`regime: ${k.regime}`)
  return { ok: true, type: 'kagi', kind, dir: k.direction, facts: { thick: k.thick, structure: k.structure, regime: k.regime, legsInWindow: k.legsInWindow, legUnits: leg, reversal: k.reversal, shoulder: k.shoulder ?? NaN, waist: k.waist ?? NaN, lastEvent: ev ? ev.type : '', lastEventAgo: evAgo, barsSinceReversal: revAgo, lines: lines.length }, text: cap(parts.join('; ')) + '.' }
}

export function storyHeikin(candles: Candle[], opts: { window?: number } = {}): ChartStory {
  if (candles.length < 20) return NA('ha', 'not enough candles for heikin ashi')
  const ha = heikinAshiSeries(candles), n = Math.min(opts.window ?? 12, ha.length)
  const w = ha.slice(-n), dirs = w.map((c) => (c.close >= c.open ? 1 : -1))
  const rf = runFacts(dirs, n), curDir = rf.curDir
  const range = (c: Candle) => Math.max(c.high - c.low, 1e-12)
  const body = (c: Candle) => Math.abs(c.close - c.open) / range(c)
  const lowW = (c: Candle) => (Math.min(c.open, c.close) - c.low) / range(c), upW = (c: Candle) => (c.high - Math.max(c.open, c.close)) / range(c)
  const flatTail = (c: Candle) => (curDir > 0 ? lowW(c) : upW(c)) <= 0.05                       // no wick against the trend: the strong-trend signature
  let flatRun = 0; for (let i = w.length - 1; i >= w.length - rf.cur && i >= 0 && flatTail(w[i]); i--) flatRun++
  const last = w[w.length - 1], prev3 = w.slice(-6, -3), last3 = w.slice(-3)
  const avgBody = (a: Candle[]) => (a.length ? a.reduce((x, c) => x + body(c), 0) / a.length : NaN)
  const shrink = avgBody(prev3) > 0 ? avgBody(last3) / avgBody(prev3) : NaN
  const against = (c: Candle) => (curDir > 0 ? lowW(c) : upW(c))
  const real = candles[candles.length - 1]
  let kind: string
  if (body(last) <= 0.15 && lowW(last) >= 0.25 && upW(last) >= 0.25) kind = 'indecision'
  else if (rf.cur >= 3 && flatRun >= 2) kind = curDir > 0 ? 'strong-up' : 'strong-down'
  else if (rf.cur >= 3 && Number.isFinite(shrink) && shrink < 0.7 && against(last) >= 0.2) kind = curDir > 0 ? 'weakening-up' : 'weakening-down'
  else if (rf.cur === 1 && rf.prev >= 3) kind = curDir > 0 ? 'flip-up' : 'flip-down'
  else if (rf.flipShare >= 0.5) kind = 'chop'
  else kind = curDir > 0 ? 'up' : 'down'
  const s = side(curDir)
  const head: Record<string, string> = {
    'strong-up': `a strong up trend: ${rf.cur} green HA candles, the last ${flatRun} with no lower wick (nobody is selling into it)`,
    'strong-down': `a strong down trend: ${rf.cur} red HA candles, the last ${flatRun} with no upper wick (nobody is buying into it)`,
    'weakening-up': `an up trend that is weakening: ${rf.cur} green candles but the bodies shrank to ${f(shrink)}x and wicks against it are growing`,
    'weakening-down': `a down trend that is weakening: ${rf.cur} red candles but the bodies shrank to ${f(shrink)}x and wicks against it are growing`,
    'flip-up': `a fresh flip to green after a ${rf.prev}-candle red run`, 'flip-down': `a fresh flip to red after a ${rf.prev}-candle green run`,
    indecision: 'an indecision HA candle: tiny body with wicks on both sides', chop: `chop: HA colour flipped ${rf.flips} times in the last ${n} candles`, up: `${rf.cur} green HA candle(s), no strong signature yet`, down: `${rf.cur} red HA candle(s), no strong signature yet`,
  }
  const parts = [head[kind] ?? `${rf.cur} ${s} candles`]
  const agree = (real.close >= real.open ? 1 : -1) === curDir
  parts.push(agree ? 'the real candle agrees with the HA colour' : 'the real candle disagrees with the HA colour (HA is smoothing a turn)')
  return { ok: true, type: 'ha', kind, dir: curDir, facts: { run: rf.cur, prevRun: rf.prev, flips: rf.flips, flatTailRun: flatRun, bodyShare: body(last), lowerWick: lowW(last), upperWick: upW(last), bodyShrink: shrink, realAgrees: agree }, text: cap(parts.join('; ')) + '.' }
}

export function storyTickBars(points: TickPoint[], dataSource: 'tick' | 'candle', per = 10, window = 30): ChartStory {
  if (points.length < per * 4) return NA('tickbars', `only ${points.length} observations - need at least ${per * 4} for tick bars of ${per}`)
  const r = tickBars(points, { per, dataSource })
  const bars = r.bars.filter((b) => b.ticks >= Math.ceil(per * 0.8) || b === r.bars[r.bars.length - 1])
  if (bars.length < 4) return NA('tickbars', 'too few tick bars so far')
  const dirs = bars.map((b) => (b.close >= b.open ? 1 : -1)), rf = runFacts(dirs, window), kind0 = brickKind(rf)
  const dur = bars.map((b) => Math.max(0, b.endTime - b.time)); const lastDur = dur[dur.length - 1], med = median(dur.slice(-window, -1))
  const speed = med > 0 ? med / Math.max(lastDur, 1e-9) : NaN                                  // >1 = this bar formed faster than usual
  const rng = bars.map((b) => b.high - b.low), lastRng = rng[rng.length - 1], medRng = median(rng.slice(-window, -1))
  const size = medRng > 0 ? lastRng / medRng : NaN
  const kind = Number.isFinite(speed) && speed >= 1.8 && rf.cur >= 2 ? (rf.curDir > 0 ? 'surge-up' : 'surge-down') : Number.isFinite(speed) && speed <= 0.5 ? 'stalling' : kind0
  const parts = [brickSentence('tick bars', rf, kind0)]
  if (Number.isFinite(speed)) parts.push(speed >= 1.5 ? `the last bar formed ${f(speed)}x faster than usual (activity is picking up)` : speed <= 0.6 ? `the last bar formed ${f(1 / Math.max(speed, 1e-9))}x slower than usual (activity is fading)` : 'bars are forming at a normal pace')
  if (Number.isFinite(size)) parts.push(`the last bar's range was ${f(size)}x the typical one`)
  if (dataSource === 'candle') parts.push('built from candle closes, not live ticks, so the pace reading is only a rough guide')
  return { ok: true, type: 'tickbars', kind, dir: rf.curDir, facts: { run: rf.cur, prevRun: rf.prev, flips: rf.flips, flipShare: rf.flipShare, speed, barSeconds: lastDur, rangeRatio: size, bars: bars.length, per, source: dataSource }, text: cap(parts.join('; ')) + '.' }
}

/** the raw live tick stream: pace, who is pushing, whether it is accelerating or has gone quiet. `ticks` ts in ms ascending. */
export function storyTicks(ticks: readonly { ts: number; price: number }[], nowMs: number, atr = NaN): ChartStory {
  if (ticks.length < 20) return NA('ticks', 'no live tick feed for this pair right now (needs at least 20 ticks)')
  const win = (sec: number) => ticks.filter((t) => t.ts >= nowMs - sec * 1000 && t.ts <= nowMs)
  const stat = (sec: number) => {
    const w = win(sec); let up = 0, dn = 0
    for (let i = 1; i < w.length; i++) { const d = w[i].price - w[i - 1].price; if (d > 0) up++; else if (d < 0) dn++ }
    const net = w.length >= 2 ? w[w.length - 1].price - w[0].price : 0
    let hi = -Infinity, lo = Infinity; for (const t of w) { hi = Math.max(hi, t.price); lo = Math.min(lo, t.price) }
    return { n: w.length, rate: w.length / sec, up, dn, net, range: w.length ? hi - lo : 0 }
  }
  const a = stat(5), b = stat(15), c = stat(60)
  const lastAge = (nowMs - ticks[ticks.length - 1].ts) / 1000
  let run = 0, runDir = 0; for (let i = ticks.length - 1; i >= 1; i--) { const d = Math.sign(ticks[i].price - ticks[i - 1].price); if (d === 0) continue; if (!runDir) runDir = d; if (d === runDir) run++; else break }
  const accel = c.rate > 0 ? a.rate / c.rate : NaN
  const upShare = c.up + c.dn > 0 ? c.up / (c.up + c.dn) : 0.5
  const dir: 1 | -1 | 0 = c.net > 0 && upShare > 0.55 ? 1 : c.net < 0 && upShare < 0.45 ? -1 : 0
  const eff = c.range > 0 ? Math.abs(c.net) / c.range : 0
  const kind = lastAge >= 5 ? 'stalled' : Number.isFinite(accel) && accel >= 1.8 ? (a.net > 0 ? 'accelerating-up' : a.net < 0 ? 'accelerating-down' : 'accelerating') : dir !== 0 && eff >= 0.5 ? (dir > 0 ? 'steady-up' : 'steady-down') : c.rate >= 1 && eff < 0.3 ? 'busy-chop' : c.rate < 0.3 ? 'quiet' : 'balanced'
  const parts: string[] = []
  parts.push(lastAge >= 5 ? `the feed has gone quiet: no tick for ${f(lastAge, 0)}s` : `${f(a.rate, 1)} ticks/s over the last 5s vs ${f(c.rate, 1)} over 60s (${Number.isFinite(accel) ? (accel >= 1.5 ? 'speeding up' : accel <= 0.6 ? 'slowing down' : 'a steady pace') : 'n/a'})`)
  parts.push(`over 60s ${c.up} up-ticks vs ${c.dn} down-ticks (${(upShare * 100).toFixed(0)}% up), net ${c.net >= 0 ? '+' : ''}${f(c.net, 5)}${Number.isFinite(atr) && atr > 0 ? ` = ${f(c.net / atr)} ATR` : ''}`)
  parts.push(`${f(eff * 100, 0)}% of the 60s range was a straight push${run >= 4 ? `; ${run} ticks in a row ${runDir > 0 ? 'up' : 'down'} right now` : ''}`)
  return { ok: true, type: 'ticks', kind, dir, facts: { rate5: a.rate, rate15: b.rate, rate60: c.rate, accel, upShare60: upShare, net5: a.net, net15: b.net, net60: c.net, efficiency60: eff, runNow: run, runDir, lastTickAge: lastAge, ticks60: c.n }, text: cap(parts.join('; ')) + '.' }
}

/** the BASELINE story: the window's flat reference line (first close of the window, like analytics/baseline.ts, or `mid` = the window's mid-range like TradingView's Baseline chart) and how price has lived on each side of it. */
export function storyBaseline(candles: Candle[], n = 30, mode: 'first' | 'mid' = 'first'): ChartStory {
  const nn = Math.max(5, Math.min(300, Math.round(n)))
  if (candles.length < nn + 16) return NA('baseline', `need ${nn + 16} candles for a ${nn}-bar baseline`)
  const w = candles.slice(-(nn + 1)), pre = candles.slice(0, -(nn + 1)).slice(-15)
  let atr = 0; for (let i = 1; i < pre.length; i++) atr += Math.max(pre[i].high - pre[i].low, Math.abs(pre[i].high - pre[i - 1].close), Math.abs(pre[i].low - pre[i - 1].close)); atr /= Math.max(1, pre.length - 1)
  if (!(atr > 0)) return NA('baseline', 'flat prices, no volatility yardstick')
  let hi = -Infinity, lo = Infinity; for (const c of w) { hi = Math.max(hi, c.high); lo = Math.min(lo, c.low) }
  const base = mode === 'mid' ? (hi + lo) / 2 : w[0].close
  const dev = w.map((c) => (c.close - base) / atr)
  const last = dev[dev.length - 1]
  let crossings = 0, sinceCross = NaN, above = 0, maxUp = 0, maxDn = 0, lastCrossDir = 0
  for (let i = 0; i < dev.length; i++) { if (dev[i] > 0) above++; maxUp = Math.max(maxUp, dev[i]); maxDn = Math.min(maxDn, dev[i]); if (i > 0 && Math.sign(dev[i]) !== 0 && Math.sign(dev[i - 1]) !== 0 && Math.sign(dev[i]) !== Math.sign(dev[i - 1])) { crossings++; sinceCross = dev.length - 1 - i; lastCrossDir = Math.sign(dev[i]) } }
  const aboveShare = above / dev.length
  const kind = crossings >= Math.max(3, nn / 6) ? 'chop-around-base' : Number.isFinite(sinceCross) && sinceCross <= 2 ? (lastCrossDir > 0 ? 'fresh-cross-up' : 'fresh-cross-down') : Math.abs(last) < 0.3 ? 'hugging-base' : last >= 2 ? 'above-extended' : last <= -2 ? 'below-extended' : last > 0 ? 'above-base' : 'below-base'
  const parts: string[] = []
  parts.push(`price is ${f(Math.abs(last))} ATR ${last >= 0 ? 'above (bull side)' : 'below (bear side)'} the ${nn}-bar ${mode === 'mid' ? 'mid-range' : 'opening'} baseline ${f(base, 5)}`)
  parts.push(`it spent ${(aboveShare * 100).toFixed(0)}% of the window on the bull side and ${((1 - aboveShare) * 100).toFixed(0)}% on the bear side; the furthest it got was +${f(maxUp)} ATR above and ${f(maxDn)} ATR below`)
  parts.push(crossings ? `it crossed the baseline ${crossings} time(s), the last ${sinceCross} bar(s) ago (${lastCrossDir > 0 ? 'upward' : 'downward'})` : 'it never crossed the baseline in this window')
  return { ok: true, type: 'baseline', kind, dir: last > 0.05 ? 1 : last < -0.05 ? -1 : 0, facts: { base, deviationAtr: last, aboveShare, maxAboveAtr: maxUp, maxBelowAtr: maxDn, crossings, barsSinceCross: sinceCross, lastCrossDir, mode, n: nn }, text: cap(parts.join('; ')) + '.' }
}

/** the candle footprint story over the last `n` candles (volume spread over each range, buy/sell split by close location - an approximation, no bid/ask). */
export function storyFootprint(candles: Candle[], n = 10): ChartStory {
  const nn = Math.max(3, Math.min(100, Math.round(n)))
  if (candles.length < nn + 2) return NA('footprint', 'not enough candles for a footprint story')
  const w = candles.slice(-nn)
  if (!w.some((c) => c.volume > 0)) return NA('footprint', 'no volume in this window, so there is no footprint to read')
  const fp = computeFootprint(w), cs = fp.candles, last = cs[cs.length - 1]
  const lastRange = last.high - last.low
  const pocPos = last.poc !== null && lastRange > 0 ? (last.poc - last.low) / lastRange : NaN
  const dShare = last.volume > 0 ? last.delta / last.volume : 0
  const cum = cs.reduce((a, c) => a + c.delta, 0), totVol = cs.reduce((a, c) => a + c.volume, 0)
  const buyIm = last.rows.filter((r) => r.imbalance === 'buy').length, sellIm = last.rows.filter((r) => r.imbalance === 'sell').length
  let stack = 0, stackDir = 0, run = 0, runDir = 0
  for (const r of last.rows) { const d = r.imbalance === 'buy' ? 1 : r.imbalance === 'sell' ? -1 : 0; if (d !== 0 && d === runDir) run++; else { run = d !== 0 ? 1 : 0; runDir = d } if (run > stack) { stack = run; stackDir = runDir } }
  const priceMove = w[w.length - 1].close - w[0].open
  const candleDir = last.close > last.open ? 1 : last.close < last.open ? -1 : 0
  const div = priceMove < 0 && cum > 0 && Math.abs(cum) / totVol > 0.05 ? 1 : priceMove > 0 && cum < 0 && Math.abs(cum) / totVol > 0.05 ? -1 : 0   // +1 = bullish divergence (price down, buyers absorbing)
  const kind = div > 0 ? 'bullish-divergence' : div < 0 ? 'bearish-divergence' : stack >= 3 ? (stackDir > 0 ? 'stacked-buy-imbalance' : 'stacked-sell-imbalance') : candleDir !== 0 && Math.sign(last.delta) === candleDir && Math.abs(dShare) >= 0.25 ? (candleDir > 0 ? 'delta-confirmed-up' : 'delta-confirmed-down') : candleDir !== 0 && Math.sign(last.delta) === -candleDir && Math.abs(dShare) >= 0.15 ? (candleDir > 0 ? 'up-on-weak-delta' : 'down-on-weak-delta') : 'balanced'
  const parts: string[] = []
  parts.push(`the last candle's delta is ${last.delta >= 0 ? '+' : ''}${f(last.delta, 0)} (${f(dShare * 100, 0)}% of its volume), ${Math.sign(last.delta) === candleDir || candleDir === 0 ? 'in line with the candle' : 'AGAINST the candle direction'}`)
  if (Number.isFinite(pocPos)) parts.push(`its busiest price (POC) sits ${(pocPos * 100).toFixed(0)}% up its range (${pocPos >= 0.66 ? 'near the high' : pocPos <= 0.34 ? 'near the low' : 'mid-range'})`)
  parts.push(`${buyIm} buy-imbalance and ${sellIm} sell-imbalance price levels${stack >= 3 ? `, ${stack} ${stackDir > 0 ? 'buy' : 'sell'} imbalances stacked in a row` : ''}`)
  parts.push(`over ${nn} candles the cumulative delta is ${cum >= 0 ? '+' : ''}${f(cum, 0)} while price moved ${priceMove >= 0 ? 'up' : 'down'}${div > 0 ? ' - a bullish divergence (price fell, buyers kept absorbing)' : div < 0 ? ' - a bearish divergence (price rose, sellers kept absorbing)' : ''}`)
  parts.push('estimated from candle volume, not real bid/ask prints')
  return { ok: true, type: 'footprint', kind, dir: (div !== 0 ? div : Math.sign(cum)) as 1 | -1 | 0, facts: { delta: last.delta, deltaShare: dShare, pocPos, buyImbalances: buyIm, sellImbalances: sellIm, stacked: stack, stackedDir: stackDir, cumDelta: cum, divergence: div, volume: last.volume }, text: cap(parts.join('; ')) + '.' }
}

export const CHART_STORY_TYPES = ['renko', 'kagi', 'effort', 'ha', 'tickbars', 'ticks', 'baseline', 'footprint'] as const
