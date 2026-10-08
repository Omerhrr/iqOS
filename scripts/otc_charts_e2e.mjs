#!/usr/bin/env node
// OTC charts + AI-lab wiring e2e - Task: renko/pnf into the lab, OTC velocity
// footprint chart + builtin strategy, all against the LIVE kernel (:3030).
//
// Protocol: outcome-agnostic assertions (structure + math consistency, never
// a specific signal outcome), no sandbox state mutated (everything here is a
// read-only over the data chain - footprint/learn/backtest never touch the
// archive, candles, or bot configs). lab_learn writes are avoided entirely:
// learn results are returned but never /lab_save'd.
const BASE = 'http://127.0.0.1:3030'
let pass = 0
let fail = 0
const failures = []

function check(name, cond, detail = '') {
  if (cond) {
    pass++
    console.log(`  ok   ${name}`)
  } else {
    fail++
    failures.push(`${name}${detail ? ` :: ${detail}` : ''}`)
    console.log(`  FAIL ${name}${detail ? ` :: ${detail}` : ''}`)
  }
}

const jget = async (path) => (await fetch(`${BASE}${path}`)).json()
const jpost = async (path, body) =>
  (
    await fetch(`${BASE}${path}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body ?? {}),
    })
  ).json()

const approx = (v, lo, hi) => v >= lo && v <= hi

console.log('== 1. otc velocity footprint chart ==')
{
  const d = await jget('/otc_footprint?minutes=15')
  check('footprint ok:true', d.ok === true)
  check('dataSource labeled', ['sim-tick-1s', 'sidecar-tick-100ms', 'kernel-tick-buffer', 'no-ticks-yet'].includes(d.dataSource), d.dataSource)
  check('tickSize positive', Number(d.tickSize) > 0, String(d.tickSize))
  check('cadence honest (null or >=0)', d.cadenceMs === null || d.cadenceMs >= 0, String(d.cadenceMs))
  const buckets = (d.buckets ?? []).filter((b) => b.nTicks > 0)
  check('has ticked buckets (sim ticks 1/s for >60s)', buckets.length >= 1, String(buckets.length))
  if (buckets.length) {
    const b = buckets[buckets.length - 1]
    check('bucket math: up+dn <= nTicks', b.upTicks + b.dnTicks <= b.nTicks, `${b.upTicks}+${b.dnTicks} vs ${b.nTicks}`)
    check('bucket math: velDelta == up-dn', b.velDelta === b.upTicks - b.dnTicks)
    check('closePos in [0,1]', approx(b.closePos, 0, 1.0001), String(b.closePos))
    check('speedRatio finite >=0', Number.isFinite(b.speedRatio) && b.speedRatio >= 0, String(b.speedRatio))
    check('rows sorted desc', b.rows.every((r, i) => i === 0 || b.rows[i - 1].price >= r.price))
    const maxTot = Math.max(...b.rows.map((r) => r.total))
    const pocRow = b.rows.find((r) => r.price === b.pocPrice)
    check('poc is the densest row', pocRow && pocRow.total === maxTot, JSON.stringify({ poc: b.pocPrice, maxTot }))
    check('stagnation = poc/median >= 1', b.stagnation >= 1, String(b.stagnation))
    check('divergence only fires with |delta| >= 3', b.divergence === null || Math.abs(b.velDelta) >= 3, JSON.stringify({ div: b.divergence, delta: b.velDelta }))
    const upSum = b.rows.reduce((s, r) => s + r.up, 0)
    check('row cells sum to bucket counts', upSum === b.upTicks, `${upSum} vs ${b.upTicks}`)
    const s = d.summary
    check('summary totals match buckets', s.totalUp === buckets.reduce((a, x) => a + x.upTicks, 0))
    check('summary netDelta == totalUp-totalDn', s.netDelta === s.totalUp - s.totalDn)
    check('summary signal shape', ['call', 'put', 'none'].includes(s.signal))
  }
}

console.log('== 2. builtin otc-velocity-divergence strategy ==')
{
  const list = await jget('/strategies')
  const strat = (list.strategies ?? list).find?.((s) => s.id === 'otc-velocity-divergence')
  check('registered in /strategies', !!strat, 'otc-velocity-divergence missing')
  check('params exposed', strat && Array.isArray(strat.params) && strat.params.length >= 3)
  const ev = await jpost('/run_strategy', { asset: 'EURUSD', strategy: 'otc-velocity-divergence' })
  check('run_strategy ok', ev.ok === true)
  check('direction shape', ['call', 'put', 'none'].includes(ev.eval?.direction), JSON.stringify(ev.eval))
  check('notes non-empty (honest stand-aside or signal)', typeof ev.eval?.notes === 'string' && ev.eval.notes.length > 0)
  // the hint threading: the strategy MUST see tick metrics on a sim asset
  // (notes reference delta/ratio/stagnation, not "no asset context")
  check('asset hint reached the tick buffer', !/no asset context/.test(ev.eval?.notes ?? ''), ev.eval?.notes)
}

console.log('== 3. AI lab: renko + P&F signal kinds measure (inline spec backtest) ==')
{
  // origin-side vocabulary: renko/pnf are signal KINDS (kind: 'renko' with
  // flip/streak variants, kind: 'pf' with double/triple top-bottom variants),
  // not lab bases - this probes exactly those, including normalizeSpec keeping them
  const spec = {
    name: 'e2e renko/pf probe',
    signals: [
      { kind: 'renko', variant: 'flip-up', len: 2, dir: 'call', weight: 10 },
      { kind: 'renko', variant: 'streak-down', len: 3, dir: 'put', weight: 10 },
      { kind: 'pf', variant: 'double-top-breakout', dir: 'call', weight: 10 },
      { kind: 'pf', variant: 'double-bottom-breakdown', dir: 'put', weight: 10 },
    ],
    minScore: 10,
    minVotes: 1,
    horizon: 1,
  }
  const d = await jpost('/lab_backtest', { asset: 'EURUSD', tf: '1m', spec })
  check('renko/pf probe backtest ok', d.ok === true, d.error)
  check('renko/pf signals fire (trades > 0)', (d.backtest?.trades ?? 0) > 0, JSON.stringify(d.backtest))
  check('honest metrics returned', typeof d.backtest?.winRate === 'number')
  check('renko/pf spec survived normalization', Array.isArray(d.spec?.signals) && d.spec.signals.length === 4, `kept ${d.spec?.signals?.length}/4`)
}

console.log('== 4. AI lab: learn pipeline healthy (otcv candidates present, no breakage) ==')
{
  // the otcv* family sits in CANDIDATE_SIGNALS - on a sim asset most bars
  // outside tick coverage are NaN, so learning must simply not select them
  // (never fabricate) while the whole pipeline stays healthy
  const d = await jpost('/lab_learn', { asset: 'EURUSD', tf: '1m', bars: 400, mineCombos: false })
  check('learn ok on default basis', d.ok === true, d.error)
  check('holdout measured', !!d.holdout && d.holdout.trades >= 0, JSON.stringify(d.holdout))
  check('breakeven present', typeof d.breakevenWinRate === 'number' && d.breakevenWinRate > 0)
  check('spec returned with signals', Array.isArray(d.spec?.signals) && d.spec.signals.length > 0)
}

console.log('== 5. otcv* signal family measures (inline spec backtest) ==')
{
  const spec = {
    name: 'e2e otcv probe',
    signals: [
      { kind: 'indicator', ind: 'otcvdelta', params: { period: 5 }, op: '<', threshold: -1, dir: 'put', weight: 11 },
      { kind: 'indicator', ind: 'otcvratio', params: { period: 5 }, op: '>', threshold: 1, dir: 'call', weight: 11 },
      { kind: 'indicator', ind: 'otcstagn', params: { period: 5 }, op: '>', threshold: 1, dir: 'call', weight: 11 },
    ],
    minScore: 10,
    minVotes: 1,
    horizon: 1,
  }
  const d = await jpost('/lab_backtest', { asset: 'EURUSD', tf: '1m', spec })
  check('otcv probe backtest ok', d.ok === true, d.error)
  check('otcv signals fire on sim tick history (trades > 0)', (d.backtest?.trades ?? 0) > 0, JSON.stringify(d.backtest))
  check('honest metrics returned', typeof d.backtest?.winRate === 'number')
  // normalizeSpec must NOT drop the new family (the KNOWN_INDS regression)
  check('spec survived normalization', Array.isArray(d.spec?.signals) && d.spec.signals.length === 3, `kept ${d.spec?.signals?.length}/3`)
}

console.log('== 6. data-chain sanity (footprint is read-only) ==')
{
  const c1 = await jget('/candles?asset=EURUSD&tf=1m&limit=50')
  check('candles endpoint healthy after footprint/learn traffic', Array.isArray(c1.candles) && c1.candles.length > 10)
  const times = c1.candles.map((c) => c.time)
  check('candles still strictly ascending (no contamination)', times.every((t, i) => i === 0 || t > times[i - 1]))
  const fp2 = await jget('/otc_footprint?minutes=5')
  check('second footprint read consistent shape', fp2.ok === true && Array.isArray(fp2.buckets))
}

console.log(`\nRESULT: ${pass} passed, ${fail} failed`)
if (fail) {
  console.log('FAILURES:')
  for (const f of failures) console.log(`  - ${f}`)
  process.exit(1)
}
