// Signal outcome tracker - deterministic logic e2e (bun).
// Simulates scans, price sweeps and clock advances; asserts resolution
// semantics, dedup, engine attribution, stats math and restore.
import { SignalOutcomeTracker } from '../mini-services/trading-core/src/analytics/signaloutcomes'

let pass = 0
let fail = 0
function ok(cond, name) {
  if (cond) {
    pass++
    console.log('  ok', name)
  } else {
    fail++
    console.log('  FAIL', name)
  }
}

const VOTES = (dir) => [
  { engine: 'renko', dir, weight: 0.8, note: 'trend' },
  { engine: 'pnf', dir, weight: 0.85, note: 'X column' },
  { engine: 'range', dir: 0, weight: 0, note: 'flat' },
  { engine: 'heikin', dir: -dir, weight: 0.4, note: 'counter' },
]

const optSignal = (asset, direction, price, expirySec, ts) => ({
  asset, name: asset, category: 'forex', otc: false, price,
  direction, score: direction === 'call' ? 60 : -60, strength: 60,
  agree: 2, total: 4, expirySec, votes: VOTES(direction === 'call' ? 1 : -1),
  cfd: null, ts, validUntil: ts + 150_000, dataSource: 'test',
})

const cfdSignal = (asset, direction, price, ts) => ({
  ...optSignal(asset, direction, price, 300, ts),
  kind: 'cfd',
  cfd: { entry: price, sl: direction === 'call' ? price * 0.99 : price * 1.01, tp: direction === 'call' ? price * 1.02 : price * 0.98, slDist: price * 0.01, tpDist: price * 0.02, rr: 2 },
})

const T0 = 1_700_000_000_000
const prices = {}
const priceOf = (a) => prices[a] ?? 0

// --- 1. option resolution: win / loss / flat --------------------------------
{
  const t = new SignalOutcomeTracker()
  const added = t.record('option', '1m', [
    optSignal('EURUSD', 'call', 1.1, 60, T0),      // rises -> win
    optSignal('GBPUSD', 'put', 1.26, 60, T0),      // falls -> put wins
    optSignal('USDJPY', 'call', 150.0, 60, T0),    // exactly flat -> flat
  ], T0)
  ok(added === 3, 'record: 3 pending added')
  ok(t.record('option', '1m', [optSignal('EURUSD', 'call', 1.1, 60, T0)], T0 + 5000) === 0, 'dedup: same kind+asset+dir while pending')

  prices.EURUSD = 1.1 // pre-expiry sample, unchanged yet
  let r = t.tick(T0 + 30_000, priceOf)
  ok(r.length === 0, 'tick before maturity: nothing resolves')
  r = t.tick(T0 + 35_000, priceOf)
  ok(r.length === 0, 'still nothing at 35s (expiry 60s)')

  prices.EURUSD = 1.101 // +0.0909% -> call win
  prices.GBPUSD = 1.2574 // -0.2063% -> put win
  prices.USDJPY = 150.0 // 0 -> flat
  r = t.tick(T0 + 61_000, priceOf)
  ok(r.length === 3, 'expiry: all three resolve')
  const by = Object.fromEntries(r.map((x) => [x.asset, x]))
  ok(by.EURUSD.outcome === 'win' && by.EURUSD.movePct > 0, 'EURUSD call win, movePct>0')
  ok(by.GBPUSD.outcome === 'win' && by.GBPUSD.movePct > 0, 'GBPUSD put win (signed by direction)')
  ok(by.USDJPY.outcome === 'flat' && by.USDJPY.movePct === 0, 'USDJPY flat at exactly 0')
  ok(by.EURUSD.engines.filter((e) => e.hit).length === 2, 'engine hits: renko+pnf hit, heikin miss')
  ok(by.EURUSD.maxFavPct >= by.EURUSD.movePct, 'maxFavPct >= final move')

  const st = t.stats().option
  ok(st.resolved === 3 && st.wins === 2 && st.losses === 0 && st.flats === 1, 'stats: 3 resolved 2W 0L 1 flat')
  ok(st.winRate === 100, 'winRate excludes flat (2/2 = 100%)')
  const renko = st.engines.find((e) => e.engine === 'renko')
  const heikin = st.engines.find((e) => e.engine === 'heikin')
  ok(renko?.votes === 2 && renko.hits === 2 && renko.winRate === 100, 'renko 2/2 hits (flat read excluded)')
  ok(heikin?.votes === 2 && heikin.hits === 0 && heikin.winRate === 0, 'heikin 0/2 (counter-votes missed, flat excluded)')
  ok(st.pending === 0 && st.recorded === 3, 'pending drained, recorded total intact')
}

// --- 2. option loss + engine miss -------------------------------------------
{
  const t = new SignalOutcomeTracker()
  t.record('option', '1m', [optSignal('AUDUSD', 'call', 0.66, 60, T0)], T0)
  prices.AUDUSD = 0.659 // -0.15%
  const [r] = t.tick(T0 + 61_000, priceOf)
  ok(r.outcome === 'loss' && r.movePct < 0, 'losing call resolved')
  const st = t.stats().option
  ok(st.winRate === 0 && st.losses === 1, 'winRate 0 with 1 loss')
  ok(st.byMarket.real.winRate === 0 && st.byMarket.otc.winRate === null, 'real/otc split honest (otc empty -> null)')
}

// --- 3. CFD: first TP touch wins before horizon ------------------------------
{
  const t = new SignalOutcomeTracker()
  const entry = 1.2
  t.record('cfd', '1m', [cfdSignal('USDCAD', 'call', entry, T0)], T0)
  prices.USDCAD = entry * 1.0205 // above tp (entry*1.02)
  const [r] = t.tick(T0 + 60_000, priceOf)
  ok(!!r, 'cfd resolves on touch')
  ok(r.outcome === 'win' && r.touched === 'tp', 'tp touched first -> win (before 15m horizon)')
  ok(r.resolvedAt === T0 + 60_000, 'resolved at touch time, not horizon')
  const st = t.stats().cfd
  ok(st.winRate === 100 && st.timeouts === 0, 'cfd winRate 100, no timeouts')
}

// --- 4. CFD: SL first -> loss; no touch -> timeout at horizon ----------------
{
  const t = new SignalOutcomeTracker()
  const entry = 100
  t.record('cfd', '1m', [
    cfdSignal('X1', 'call', entry, T0),
    { ...cfdSignal('X2', 'put', entry, T0) },
  ], T0)
  // X1: slides to SL; X2: put drifts up to 100.5 (neither tp 98 nor sl 101... wait put sl = 101, put tp = 98)
  prices.X1 = 99.0 // below sl 99? sl = entry*0.99 = 99 -> price <= sl hits
  prices.X2 = 100.5 // between entry and put-sl (101): no touch
  let r = t.tick(T0 + 60_000, priceOf)
  ok(r.length === 1 && r[0].asset === 'X1' && r[0].touched === 'sl' && r[0].outcome === 'loss', 'X1 SL touched first -> loss')
  r = t.tick(T0 + 300_000, priceOf) // past expiry, before horizon: X2 stays pending
  ok(r.length === 0, 'X2 alive past expiry (plan still live until horizon)')
  prices.X2 = 100.4
  r = t.tick(T0 + 900_001, priceOf) // just past the 15m horizon
  ok(r.length === 1 && r[0].asset === 'X2' && r[0].outcome === 'timeout', 'X2 timeout at 15m horizon')
  ok(r[0].movePct < 0, 'timeout records the drift (+0.4% against the put = signed -0.4)')
  const st = t.stats().cfd
  ok(st.wins === 0 && st.losses === 1 && st.timeouts === 1, 'cfd stats: 0W 1L 1 timeout')
  ok(st.winRate === 0, 'timeout excluded from denominator (0/(0+1))')
}

// --- 5. unknown price -> skip, never resolve bogus ---------------------------
{
  const t = new SignalOutcomeTracker()
  t.record('option', '1m', [optSignal('COLD', 'call', 5, 60, T0)], T0)
  let r = t.tick(T0 + 120_000, priceOf) // COLD has no price
  ok(r.length === 1 && r[0].outcome === 'flat' && r[0].exit === 0, 'no feed at expiry -> honest flat, exit 0')
}

// --- 6. persistence round-trip -------------------------------------------------
{
  const t = new SignalOutcomeTracker()
  t.record('option', '1m', [optSignal('EURUSD', 'call', 1.1, 60, T0)], T0)
  prices.EURUSD = 1.105
  t.tick(T0 + 61_000, priceOf)
  const blob = JSON.parse(JSON.stringify(t.state()))
  const t2 = new SignalOutcomeTracker(blob.resolved)
  const st = t2.stats().option
  ok(st.resolved === 1 && st.winRate === 100, 'restore: stats survive a state round-trip')
  ok(t2.state().resolved[0].engines.length === 3, 'restore: per-engine attribution persisted')
}

console.log(`\n${pass} checks passed, ${fail} failed`)
process.exit(fail ? 1 : 0)
