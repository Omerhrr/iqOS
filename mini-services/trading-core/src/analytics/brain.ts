// IQAIR//OS - the "Brain": a regime-aware CONFLUENCE reader over the structure engines the platform already has.
//
// It does not invent a new signal. It reads, on CLOSED candles only (causal, nothing looks ahead):
//   REGIME     trending / ranging / volatile (efficiency ratio over 30 bars + ATR percentile)
//   FIB        the Auto-Fibonacci leg: a turning bar inside the 0.382-0.786 pullback zone of a leg worth >= 2 ATR
//   SMC        the live SMC/ICT concepts on the last 3 bars (order blocks, FVG, sweeps, BOS/CHoCH ...), net bullish vs bearish
//   CANDLE     the candle patterns on the last 2 bars, weighted by their reliability
//   AMD        accumulation / manipulation / distribution (ICT Power of 3): a reclaimed sweep or a fresh distribution
//   WYCKOFF    accumulation / distribution schematic, phase C or D
// then picks a PLAYBOOK by regime and events:
//   reversal       a Wyckoff phase-C/D or an AMD reclaim/distribution names the direction (they must not disagree)
//   continuation   a trending regime: trade with the trend
//   range_fade     a ranging regime with price at the edge of the last 30-bar range: fade it
// and proposes a trade only when at least `minAgree` (default 3) of the five structure families agree with that direction and at most one opposes.
//
// HONESTY, in code and not just in comments:
//   - `confluence` is the weighted share of families that agree. It is AGREEMENT, not a win probability. The families are correlated
//     views of the same candles, so five of them agreeing is far less independent evidence than it looks.
//   - Nothing here has a measured real-market win rate. The planted-structure tests prove the machinery finds what was put there.
//   - A proposal is only a PROPOSAL. plugins/braintrader.ts hands it to a reviewer that can veto it, and logs both outcomes so the
//     reviewer's value can be measured instead of assumed.
// Pure: no I/O, no clock.
import type { Candle } from '../types'
import { fibSwing, fibPos, readVol } from './mslfib'
import { scanSmc } from './smc'
import { detectPatterns } from './patterns'
import { AMD_MIN_BARS, readAmd } from './mslamd'
import { WYCKOFF_MIN_BARS, readWyckoff } from './mslwyckoff'

export const BRAIN_MIN_BARS = Math.max(WYCKOFF_MIN_BARS, AMD_MIN_BARS, 150)
export const BRAIN_ER_BARS = 30
export const TREND_ER = 0.35
export const RANGE_ER = 0.2
export const RANGE_EDGE = 0.15

export type BrainRegime = 'trend_up' | 'trend_down' | 'range' | 'volatile' | 'unclear'
export type BrainPlaybook = 'reversal' | 'continuation' | 'range_fade' | 'none'
export type BrainFamily = 'fib' | 'smc' | 'candle' | 'amd' | 'wyckoff'

export interface BrainComponent {
  family: BrainFamily
  /** +1 bullish (call), -1 bearish (put), 0 nothing to say */
  dir: number
  weight: number
  note: string
}

export interface BrainRead {
  ok: boolean
  regime: BrainRegime
  playbook: BrainPlaybook
  /** the playbook's direction BEFORE the confluence gate */
  candidate: 'call' | 'put' | 'none'
  /** candidate passed the confluence gate - this is what the trader hands to the reviewer */
  proposal: boolean
  direction: 'call' | 'put' | 'none'
  /** weighted share (0-100) of the five families agreeing with `direction`. AGREEMENT, not probability. */
  confluence: number
  agree: BrainFamily[]
  oppose: BrainFamily[]
  components: BrainComponent[]
  /** why there is no proposal (or a one-line summary when there is) */
  reason: string
  /** price that, if closed through, kills the idea (recent 6-bar extreme on the losing side) */
  invalidation: number
  price: number
  atr: number
  er: number
  volRank: number
}

const DEFAULT_WEIGHTS: Record<BrainFamily, number> = { fib: 1.5, smc: 1.5, candle: 1, amd: 1.5, wyckoff: 1.5 }
export const BRAIN_FAMILIES: BrainFamily[] = ['fib', 'smc', 'candle', 'amd', 'wyckoff']

/** The brain's STRATEGY: which playbooks it may run, which readers get a vote and how much, and the regime / fib thresholds.
 * Every field has a default; the defaults are conventions, not tuned values. */
export interface BrainStrategy {
  playbooks: { reversal: boolean; continuation: boolean; range_fade: boolean }
  families: Record<BrainFamily, boolean>
  weights: Record<BrainFamily, number>
  /** families that must agree with the playbook's direction (default 3: on random walks 2 proposes on ~11% of bars, 3 on ~1.7%) */
  minAgree: number
  /** efficiency ratio at/above which the regime is a trend, at/below which it is a range */
  trendEr: number
  rangeEr: number
  /** fraction of the 30-bar range that counts as 'at the edge' for the range fade */
  rangeEdge: number
  /** fib pullback zone (retracement fraction of the leg) */
  fibZoneLo: number
  fibZoneHi: number
  /** a volatile regime (ATR in its top decile and expanding) stands aside */
  standAsideWhenVolatile: boolean
}

export const DEFAULT_BRAIN_STRATEGY: BrainStrategy = {
  playbooks: { reversal: true, continuation: true, range_fade: true },
  families: { fib: true, smc: true, candle: true, amd: true, wyckoff: true },
  weights: { ...DEFAULT_WEIGHTS },
  minAgree: 3,
  trendEr: TREND_ER,
  rangeEr: RANGE_ER,
  rangeEdge: RANGE_EDGE,
  fibZoneLo: 0.382,
  fibZoneHi: 0.786,
  standAsideWhenVolatile: true,
}

/** merge + clamp a partial strategy into a full, valid one (used by the trader's config and by tests) */
export function sanitizeBrainStrategy(p?: Partial<BrainStrategy> | null): BrainStrategy {
  const d = DEFAULT_BRAIN_STRATEGY
  const num = (v: unknown, fb: number, lo: number, hi: number) => (typeof v === 'number' && Number.isFinite(v) ? Math.min(hi, Math.max(lo, v)) : fb)
  const bool = (v: unknown, fb: boolean) => (typeof v === 'boolean' ? v : fb)
  const pb = (p?.playbooks ?? {}) as Partial<BrainStrategy['playbooks']>
  const fam = (p?.families ?? {}) as Partial<BrainStrategy['families']>
  const w = (p?.weights ?? {}) as Partial<BrainStrategy['weights']>
  const families = {} as Record<BrainFamily, boolean>
  const weights = {} as Record<BrainFamily, number>
  for (const f of BRAIN_FAMILIES) {
    families[f] = bool(fam[f], d.families[f])
    weights[f] = num(w[f], d.weights[f], 0.1, 5)
  }
  const trendEr = num(p?.trendEr, d.trendEr, 0.1, 0.9)
  const rangeEr = Math.min(num(p?.rangeEr, d.rangeEr, 0.02, 0.6), trendEr - 0.02)
  const lo = num(p?.fibZoneLo, d.fibZoneLo, 0.1, 0.9)
  const hi = num(p?.fibZoneHi, d.fibZoneHi, 0.2, 1)
  return {
    playbooks: { reversal: bool(pb.reversal, true), continuation: bool(pb.continuation, true), range_fade: bool(pb.range_fade, true) },
    families,
    weights,
    minAgree: Math.max(1, Math.min(5, Math.round(num(p?.minAgree, d.minAgree, 1, 5)))),
    trendEr,
    rangeEr,
    rangeEdge: num(p?.rangeEdge, d.rangeEdge, 0.05, 0.4),
    fibZoneLo: Math.min(lo, hi - 0.05),
    fibZoneHi: Math.max(hi, lo + 0.05),
    standAsideWhenVolatile: bool(p?.standAsideWhenVolatile, true),
  }
}

const sgn = (x: number) => (x > 0 ? 1 : x < 0 ? -1 : 0)

function empty(reason: string, price = 0): BrainRead {
  return {
    ok: false, regime: 'unclear', playbook: 'none', candidate: 'none', proposal: false, direction: 'none', confluence: 0,
    agree: [], oppose: [], components: [], reason, invalidation: 0, price, atr: 0, er: 0, volRank: 0,
  }
}

/** efficiency ratio of closes over the last `n` bars: |net move| / path length. 1 = straight line, ~0 = back and forth. */
function efficiency(c: Candle[], n: number): { er: number; net: number } {
  const i = c.length - 1
  const s = Math.max(0, i - n)
  let path = 0
  for (let k = s + 1; k <= i; k++) path += Math.abs(c[k].close - c[k - 1].close)
  const net = c[i].close - c[s].close
  return { er: path > 1e-12 ? Math.abs(net) / path : 0, net }
}

export type BrainOptions = Partial<BrainStrategy>

export function readBrain(c: Candle[], opts: BrainOptions = {}): BrainRead {
  const st = sanitizeBrainStrategy(opts)
  const minAgree = st.minAgree
  const n = c.length
  if (n < BRAIN_MIN_BARS) return empty(`needs ${BRAIN_MIN_BARS}+ closed bars (have ${n})`)
  const i = n - 1
  const price = c[i].close
  const vol = readVol(c)
  const { er, net } = efficiency(c, BRAIN_ER_BARS)
  const atr = vol?.atr ?? 0
  const volRank = vol?.rank ?? 0.5

  let regime: BrainRegime = 'unclear'
  if (vol && volRank >= 0.9 && vol.ratio >= 1.5) regime = 'volatile'
  else if (er >= st.trendEr) regime = net > 0 ? 'trend_up' : 'trend_down'
  else if (er <= st.rangeEr) regime = 'range'

  // ---------- the five families ----------
  const components: BrainComponent[] = []

  // FIB: a turning bar inside the 0.382-0.786 pullback zone of a leg worth >= 2 ATR that is not stale
  {
    let dir = 0
    let note = 'no usable leg'
    const sw = fibSwing(c, 150)
    if (sw && sw.legBars >= 8 && sw.diff >= 2 * Math.max(sw.atr, 1e-12) && sw.age <= 40) {
      const pos = fibPos(sw)
      const bar = c[i]
      const turning = sw.up ? bar.close > bar.open : bar.close < bar.open
      if (pos >= st.fibZoneLo && pos <= st.fibZoneHi && turning) {
        dir = sw.up ? 1 : -1
        note = `${sw.up ? 'up' : 'down'}-leg pullback at ${(pos * 100).toFixed(0)}% retracement, last bar turning with the leg`
      } else if (pos >= st.fibZoneLo && pos <= st.fibZoneHi) note = `${(pos * 100).toFixed(0)}% retracement of a ${sw.up ? 'up' : 'down'}-leg, no turning bar yet`
      else note = `${(pos * 100).toFixed(0)}% retracement - outside the ${(st.fibZoneLo * 100).toFixed(0)}-${(st.fibZoneHi * 100).toFixed(0)} zone`
    }
    components.push({ family: 'fib', dir, weight: st.weights.fib, note })
  }

  // SMC: net of the live (last 3 bars) concepts, S&R excluded (it fires far too often to be a lean)
  {
    let dir = 0
    let note = 'scan unavailable'
    try {
      const scan = scanSmc(c.slice(-300))
      if (scan) {
        const live = scan.signals.filter((s) => s.barsAgo <= 3 && s.active && s.kind !== 'SUPPORT_RESISTANCE')
        const bull = live.filter((s) => s.direction === 'bullish').length
        const bear = live.filter((s) => s.direction === 'bearish').length
        dir = bull === bear ? 0 : bull > bear ? 1 : -1
        note = live.length ? `${bull} bullish / ${bear} bearish live: ${live.map((s) => `${s.kind}:${s.direction[0]}`).join(', ')} (structure ${scan.trend})` : `nothing live (structure ${scan.trend})`
      }
    } catch {
      /* SMC needs more history than this window gave - leave neutral */
    }
    components.push({ family: 'smc', dir, weight: st.weights.smc, note })
  }

  // CANDLE patterns: last 2 bars, weighted by each detector's reliability
  {
    let dir = 0
    let note = 'no pattern'
    try {
      const hits = detectPatterns(c.slice(-60), 2)
      let b = 0
      let s = 0
      for (const h of hits) {
        if (h.direction === 'bullish') b += h.reliability
        else if (h.direction === 'bearish') s += h.reliability
      }
      dir = b === s ? 0 : b > s ? 1 : -1
      if (hits.length) note = hits.map((h) => `${h.name}(${h.direction[0]}${h.barsAgo ? ` -${h.barsAgo}` : ''})`).join(', ')
    } catch {
      /* neutral */
    }
    components.push({ family: 'candle', dir, weight: st.weights.candle, note })
  }

  // AMD: a sweep that has been reclaimed (manipulation) or a fresh distribution - both carry the expected real-move direction
  const amd = readAmd(c, 0)
  {
    let dir = 0
    let note = amd ? `phase ${amd.phase}` : 'needs more bars'
    if (amd) {
      if (amd.phase === 'manipulation' && amd.returned) {
        dir = amd.dir
        note = `sweep of the box ${amd.sweepSide > 0 ? 'high' : 'low'} reclaimed (depth ${amd.sweepDepth.toFixed(2)} ATR) - expects ${amd.dir > 0 ? 'up' : 'down'}`
      } else if (amd.phase === 'distribution' && amd.age <= 3) {
        dir = amd.dir
        note = `distribution ${amd.age} bar(s) old, moving ${amd.dir > 0 ? 'up' : 'down'}`
      }
    }
    components.push({ family: 'amd', dir, weight: st.weights.amd, note })
  }

  // WYCKOFF: phase C (spring/upthrust) or D (SOS/SOW) of an accumulation / distribution
  const wy = readWyckoff(c)
  {
    let dir = 0
    let note = wy ? 'no schematic' : 'needs more bars'
    if (wy && wy.schematic !== 'none') {
      if (wy.phase === 'C' || wy.phase === 'D') {
        dir = wy.dir
        note = `${wy.schematic} phase ${wy.phase}${wy.spring ? ' (spring)' : ''}${wy.upthrust ? ' (upthrust)' : ''}${wy.sos ? ' (SOS)' : ''}${wy.sow ? ' (SOW)' : ''}${wy.lps || wy.lpsy ? ' (last point of support/supply)' : ''}`
      } else note = `${wy.schematic} phase ${wy.phase} - not an entry phase`
    }
    components.push({ family: 'wyckoff', dir, weight: st.weights.wyckoff, note })
  }

  // a family the strategy switched off casts no vote and does not count toward the confluence share
  for (const comp of components) {
    if (!st.families[comp.family]) {
      comp.dir = 0
      comp.note = `disabled in the strategy (${comp.note})`
    }
  }

  // ---------- playbook ----------
  let playbook: BrainPlaybook = 'none'
  let candidate = 0
  let why = ''
  const anchorWy = components.find((x) => x.family === 'wyckoff')!.dir
  const anchorAmd = components.find((x) => x.family === 'amd')!.dir
  if (regime === 'volatile' && st.standAsideWhenVolatile) {
    why = 'volatile regime (ATR in its top decile and expanding) - stands aside'
  } else if (st.playbooks.reversal && anchorWy !== 0 && anchorAmd !== 0 && anchorWy !== anchorAmd) {
    why = 'Wyckoff and AMD name opposite directions - conflicting anchors'
  } else if (st.playbooks.reversal && (anchorWy !== 0 || anchorAmd !== 0)) {
    playbook = 'reversal'
    candidate = anchorWy || anchorAmd
    why = `${anchorWy !== 0 ? 'Wyckoff' : ''}${anchorWy !== 0 && anchorAmd !== 0 ? ' + ' : ''}${anchorAmd !== 0 ? 'AMD' : ''} anchor`
  } else if (st.playbooks.continuation && (regime === 'trend_up' || regime === 'trend_down')) {
    playbook = 'continuation'
    candidate = regime === 'trend_up' ? 1 : -1
    why = `${regime === 'trend_up' ? 'up' : 'down'}trend (efficiency ${er.toFixed(2)})`
  } else if (st.playbooks.range_fade && regime === 'range') {
    let hi = -Infinity
    let lo = Infinity
    for (let k = i - BRAIN_ER_BARS + 1; k <= i; k++) {
      hi = Math.max(hi, c[k].high)
      lo = Math.min(lo, c[k].low)
    }
    const pos = hi - lo > 1e-12 ? (price - lo) / (hi - lo) : 0.5
    if (pos <= st.rangeEdge) {
      playbook = 'range_fade'
      candidate = 1
      why = `ranging, price at the bottom ${(pos * 100).toFixed(0)}% of the 30-bar range`
    } else if (pos >= 1 - st.rangeEdge) {
      playbook = 'range_fade'
      candidate = -1
      why = `ranging, price at the top ${(pos * 100).toFixed(0)}% of the 30-bar range`
    } else why = 'ranging but price is mid-range - nothing at the edge'
  } else why = 'no regime read and no anchor event'

  const cand: 'call' | 'put' | 'none' = candidate > 0 ? 'call' : candidate < 0 ? 'put' : 'none'
  const agree = components.filter((x) => candidate !== 0 && x.dir === candidate).map((x) => x.family)
  const oppose = components.filter((x) => candidate !== 0 && x.dir === -candidate).map((x) => x.family)
  const totalW = components.filter((x) => st.families[x.family]).reduce((s, x) => s + x.weight, 0)
  const agreeW = components.filter((x) => candidate !== 0 && x.dir === candidate).reduce((s, x) => s + x.weight, 0)
  const confluence = candidate === 0 ? 0 : totalW > 0 ? Math.round((agreeW / totalW) * 100) : 0

  let proposal = false
  let reason = why
  if (candidate !== 0) {
    if (agree.length < minAgree) reason = `${why}; only ${agree.length}/${minAgree} families agree (${agree.join(', ') || 'none'})`
    else if (oppose.length > 1) reason = `${why}; ${oppose.length} families oppose (${oppose.join(', ')})`
    else {
      proposal = true
      reason = `${playbook} - ${why}; agree: ${agree.join(', ')}${oppose.length ? `; oppose: ${oppose.join(', ')}` : ''}`
    }
  }

  let invalidation = 0
  if (candidate !== 0) {
    invalidation = candidate > 0 ? Math.min(...c.slice(-6).map((x) => x.low)) : Math.max(...c.slice(-6).map((x) => x.high))
  }

  return {
    ok: true, regime, playbook, candidate: cand, proposal, direction: proposal ? cand : 'none', confluence, agree, oppose,
    components, reason, invalidation, price, atr, er, volRank,
  }
}
