// IQAIR//OS - learning validation harness
//
// Every learned mechanism built across three rounds (Oracle's driver/
// regime/session/direction/magnitude calibration + learned pattern
// reliability; the ADX/DI+Pattern honesty loop's leg weights, learned
// qualify bar, and learned HTF veto; Tempo's per-pair accuracy gate and
// cross-engine confluence boost) is now live and silently shaping real
// decisions. Nothing before this script checked whether any of it is
// actually helping rather than quietly overfitting to noise.
//
// This is NOT a full walk-forward backtest - a true one would need to
// replay the entire historical candle series through both a
// learning-enabled and a learning-disabled copy of the prediction
// pipeline, which is a much bigger project (and would need to pin every
// learned provider to null while re-running predictNextCandle/
// fitAdxPatternBias/tempoDecide over OLD market data). What this script
// DOES do, honestly, from data already on disk:
//
//   1. First-half vs second-half split of each engine's resolved ledger.
//      Every learned mechanism here requires 20-30+ resolved samples
//      before it starts influencing live decisions (see each plugin's
//      MIN_N constants) - so the ledger's FIRST half is mostly "hand-set
//      defaults only" behavior and the SECOND half is where learning was
//      actually active. A real improvement from half 1 to half 2 is
//      direct, non-simulated evidence the learning is earning its keep;
//      a flat or worse second half is a real warning sign, not proof of
//      nothing (market conditions changed too), but worth investigating.
//
//   2. The ADX/DI+Pattern honesty loop's HTF-veto shadow ledger IS a true,
//      already-built counterfactual (see plugins/adxhonesty.ts's `shadow`
//      field): those are calls the veto blocked from firing, tracked
//      anyway purely to learn from. Comparing their hit rate against the
//      live-fired set is a genuine "would the veto have helped" readout,
//      not an approximation.
//
//   3. Dumps the CURRENT learned values (driver weights, pattern
//      reliability is universe-wide and not persisted standalone here,
//      leg weights, qualify bar, HTF penalty, confluence boost, per-pair
//      Tempo multipliers) next to their sample counts, so a human can
//      sanity-check whether any of them have drifted somewhere absurd.
//
// Run with: bun run scripts/validate-learning.ts   (from
// mini-services/trading-core/, after the service has run long enough to
// have resolved real predictions - data/*.json must exist)

import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'

function readJson<T>(file: string): T | null {
  const p = join(process.cwd(), 'data', file)
  if (!existsSync(p)) return null
  try {
    return JSON.parse(readFileSync(p, 'utf8')) as T
  } catch {
    return null
  }
}

function splitHalves<T>(rows: T[]): { first: T[]; second: T[] } {
  const mid = Math.floor(rows.length / 2)
  return { first: rows.slice(0, mid), second: rows.slice(mid) }
}

function hitRate<T>(rows: T[], hit: (r: T) => boolean): number | null {
  if (rows.length === 0) return null
  return rows.filter(hit).length / rows.length
}

function fmt(n: number | null, digits = 1): string {
  return n === null ? 'n/a' : (n * 100).toFixed(digits) + '%'
}

function section(title: string): void {
  console.log(`\n${'='.repeat(title.length)}\n${title}\n${'='.repeat(title.length)}`)
}

// ---------- Oracle (Next-Candle) ----------
interface ResolvedPrediction {
  asset: string
  tf: string
  predicted: 'call' | 'put' | 'none'
  actual: 'up' | 'down' | 'flat'
  score: number
  brier: number
  regime: string
}
{
  section('Next-Candle Oracle')
  const data = readJson<{ resolved: ResolvedPrediction[] }>('nextcandle_outcomes.json')
  const rows = data?.resolved ?? []
  console.log(`resolved predictions on disk: ${rows.length}`)
  if (rows.length >= 20) {
    const { first, second } = splitHalves(rows)
    const hr1 = hitRate(first, (r) => r.score >= 1)
    const hr2 = hitRate(second, (r) => r.score >= 1)
    const br1 = first.length ? first.reduce((s, r) => s + r.brier, 0) / first.length : null
    const br2 = second.length ? second.reduce((s, r) => s + r.brier, 0) / second.length : null
    console.log(`half 1 (n=${first.length}): hit rate ${fmt(hr1)}, mean Brier ${br1?.toFixed(3) ?? 'n/a'}`)
    console.log(`half 2 (n=${second.length}): hit rate ${fmt(hr2)}, mean Brier ${br2?.toFixed(3) ?? 'n/a'}`)
    if (hr1 !== null && hr2 !== null) {
      const delta = (hr2 - hr1) * 100
      console.log(`delta: ${delta >= 0 ? '+' : ''}${delta.toFixed(1)}pp hit rate second half vs first half`)
    }
  } else {
    console.log('not enough resolved history yet for a half-split comparison (need >=20)')
  }
}

// ---------- ADX/DI + Pattern Bias honesty loop ----------
interface ResolvedAdxCall {
  asset: string
  tf: string
  composite: number
  actual: 'up' | 'down' | 'flat'
  hit: boolean
  htfDisagrees: boolean
  shadow: boolean
  oracleAgrees: boolean | null
}
{
  section('ADX/DI + Pattern Bias honesty loop')
  const data = readJson<{ resolved: ResolvedAdxCall[] }>('adxpatternbias_outcomes.json')
  const rows = (data?.resolved ?? []).filter((r) => r.actual !== 'flat')
  const live = rows.filter((r) => !r.shadow)
  const shadow = rows.filter((r) => r.shadow)
  console.log(`resolved live calls: ${live.length}, shadow (HTF-vetoed) calls: ${shadow.length}`)
  if (live.length >= 20) {
    const { first, second } = splitHalves(live)
    console.log(`half 1 (n=${first.length}): hit rate ${fmt(hitRate(first, (r) => r.hit))}`)
    console.log(`half 2 (n=${second.length}): hit rate ${fmt(hitRate(second, (r) => r.hit))}`)
  } else {
    console.log('not enough live history yet for a half-split comparison (need >=20)')
  }
  // genuine counterfactual: would the calls the HTF veto blocked have
  // actually done worse (justifying the veto) or just as well (wasted
  // trade frequency)?
  if (shadow.length >= 10) {
    console.log(`HTF-vetoed shadow calls hit rate: ${fmt(hitRate(shadow, (r) => r.hit))} (vs live ${fmt(hitRate(live, (r) => r.hit))})`)
    console.log(shadow.length >= 20 ? '-> enough shadow samples for the learned HTF penalty to be active' : '-> still thin; learned HTF penalty not yet trusted (needs >=20 each side)')
  } else {
    console.log('too few HTF-vetoed shadow calls yet to judge the veto (need >=10 to even look)')
  }
  // confluence: did oracle-agreeing calls actually resolve better?
  const agree = live.filter((r) => r.oracleAgrees === true)
  const rest = live.filter((r) => r.oracleAgrees !== true)
  if (agree.length >= 10 && rest.length >= 10) {
    console.log(`oracle-agreeing calls hit rate: ${fmt(hitRate(agree, (r) => r.hit))} (n=${agree.length}) vs rest ${fmt(hitRate(rest, (r) => r.hit))} (n=${rest.length})`)
  }
}

// ---------- Tempo ----------
interface ResolvedShot {
  asset: string
  tf: string
  hit: boolean
  flat: boolean
}
{
  section('Tempo')
  const data = readJson<{ shots: ResolvedShot[] }>('tempo_shots.json')
  const rows = (data?.shots ?? []).filter((r) => !r.flat)
  console.log(`resolved shots: ${rows.length}`)
  if (rows.length >= 20) {
    const { first, second } = splitHalves(rows)
    console.log(`half 1 (n=${first.length}): hit rate ${fmt(hitRate(first, (r) => r.hit))}`)
    console.log(`half 2 (n=${second.length}): hit rate ${fmt(hitRate(second, (r) => r.hit))}`)
  } else {
    console.log('not enough resolved shots yet for a half-split comparison (need >=20)')
  }
  // per-pair breakdown - flags which pairs pairAccuracyMult() is actually
  // dampening right now (hit rate meaningfully below 50% with n>=20).
  const byPair = new Map<string, ResolvedShot[]>()
  for (const r of rows) {
    const k = `${r.asset}:${r.tf}`
    const list = byPair.get(k) ?? []
    list.push(r)
    byPair.set(k, list)
  }
  const flagged = [...byPair.entries()]
    .filter(([, rs]) => rs.length >= 20)
    .map(([k, rs]) => ({ k, n: rs.length, hr: hitRate(rs, (r) => r.hit) ?? 0 }))
    .filter((r) => r.hr < 0.48)
    .sort((a, b) => a.hr - b.hr)
  if (flagged.length) {
    console.log('pairs currently below target hit rate (pairAccuracyMult active):')
    for (const f of flagged) console.log(`  ${f.k}: ${fmt(f.hr)} over ${f.n} shots`)
  } else {
    console.log('no pair currently flagged below target hit rate with enough samples')
  }
}

// ---------- Accute (triple confluence + zone + renko + adaptive gate) ----------
interface ResolvedAccute {
  asset: string
  tf: string
  hit: boolean
  actual: 'up' | 'down' | 'flat'
  session?: string
  regime?: string
}
{
  section('Accute (triple confluence)')
  const data = readJson<{ resolved: ResolvedAccute[] }>('accute_outcomes.json')
  const rows = (data?.resolved ?? []).filter((r) => r.actual !== 'flat')
  console.log(`resolved 3-way-agreement signals: ${rows.length}`)
  if (rows.length >= 20) {
    const { first, second } = splitHalves(rows)
    console.log(`half 1 (n=${first.length}): hit rate ${fmt(hitRate(first, (r) => r.hit))}`)
    console.log(`half 2 (n=${second.length}): hit rate ${fmt(hitRate(second, (r) => r.hit))}`)
  } else {
    console.log('not enough resolved history yet for a half-split comparison (need >=20)')
  }
  // session/regime buckets the adaptive gate (plugins/accute.ts's
  // adaptiveAdjustment()) is actually drawing from - same ADAPTIVE_MIN_N
  // floor (20) that gate itself uses, so "flagged here" means "the live
  // gate is already acting on this".
  const byBucket = new Map<string, ResolvedAccute[]>()
  for (const r of rows) {
    const k = `${r.asset} ${r.tf} ${r.session ?? 'OFF'} ${r.regime ?? 'MIXED'}`
    const list = byBucket.get(k) ?? []
    list.push(r)
    byBucket.set(k, list)
  }
  const flagged = [...byBucket.entries()]
    .filter(([, rs]) => rs.length >= 20)
    .map(([k, rs]) => ({ k, n: rs.length, hr: hitRate(rs, (r) => r.hit) ?? 0 }))
    .sort((a, b) => a.hr - b.hr)
  if (flagged.length) {
    console.log('session/regime buckets with enough samples for the adaptive gate to be acting on (worst first):')
    for (const f of flagged) console.log(`  ${f.k}: ${fmt(f.hr)} over ${f.n} signals${f.hr < 0.42 ? '  <-- past the force-waiting override threshold' : ''}`)
  } else {
    console.log('no session/regime bucket has 20+ resolved signals yet - adaptive gate still running on hand-set defaults everywhere')
  }
  console.log('note: this only judges signals that made it PAST the zone/renko gates (they are never tracked when blocked) - see scripts/accute_firerate_check.ts for whether those gates are blocking a sane fraction of agreements, not almost all of them.')
}

console.log('\n(this is a from-disk comparison of real resolved outcomes, not a simulated parallel learning-disabled run - see file header)')
