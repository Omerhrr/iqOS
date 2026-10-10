// Layer-0 NaN hardening - ingestion guard unit (bun).
// Locks the market-data glitch filter: a bar or tick whose numbers are not
// finite (or not positive where prices must be) never enters the store -
// neither through applyTick (the funnel every timeframe forms through), nor
// through the live sidecar merge + archive path, nor back in through the
// archive hydration reads (buildSeries / getCandlesDeep). The screener's
// finGte gates (312a459) and NaN-core row rejection (0d43f8c) stay as the
// inner layers; this kills the poison before it can be stored at all.
import { MarketDataService, validCandle } from '../mini-services/trading-core/src/plugins/market-data'
import type { AssetInfo, Candle } from '../mini-services/trading-core/src/types'

let pass = 0
let fail = 0
function ok(cond: boolean, name: string) {
  if (cond) {
    pass++
    console.log('  ok', name)
  } else {
    fail++
    console.log('  FAIL', name)
  }
}

const bar = (over: Partial<Candle> = {}): Candle => ({
  time: 1_700_000_100,
  open: 1.2,
  high: 1.21,
  low: 1.19,
  close: 1.205,
  volume: 100,
  ...over,
})

// ---------- 1. validCandle contract ----------
{
  console.log('validCandle contract')
  ok(validCandle(bar()) === true, 'a healthy bar is valid')
  for (const f of ['open', 'high', 'low', 'close'] as const) {
    ok(validCandle(bar({ [f]: NaN })) === false, `NaN ${f} -> invalid`)
    ok(validCandle(bar({ [f]: Infinity })) === false, `Infinity ${f} -> invalid`)
  }
  ok(validCandle(bar({ close: 0 })) === false, 'zero close -> invalid (prices are positive)')
  ok(validCandle(bar({ low: -1 })) === false, 'negative price -> invalid')
  ok(validCandle(bar({ volume: 0 })) === true, 'volume 0 is VALID (live tick-rolled bars carry it)')
  ok(validCandle(bar({ volume: NaN })) === false, 'NaN volume -> invalid')
  ok(validCandle(bar({ volume: -5 })) === false, 'negative volume -> invalid')
  ok(validCandle(bar({ time: NaN })) === false, 'NaN time -> invalid')
}

// ---------- 2. applyTick guard (the single candle funnel) ----------
{
  console.log('applyTick ingestion guard')
  const svc = new MarketDataService()
  const logs: string[] = []
  ;(svc as unknown as { ctx: unknown }).ctx = {
    bus: { emit() {} },
    log: (_tag: string, msg: string) => logs.push(msg),
  }
  const s = svc as unknown as {
    applyTick: (a: string, tf: string, t: { ts: number; price: number; vol: number }) => void
    candles: Map<string, Candle | undefined>
    closed: Map<string, Candle[]>
    glitchDrops: number
  }
  s.closed.set('X|1m', [])
  const now = 1_700_000_100
  s.applyTick('X', '1m', { ts: now, price: NaN, vol: 0 })
  s.applyTick('X', '1m', { ts: now, price: Infinity, vol: 0 })
  s.applyTick('X', '1m', { ts: now, price: -3, vol: 0 })
  s.applyTick('X', '1m', { ts: now, price: 1.2, vol: NaN })
  ok(s.candles.get('X|1m') === undefined, 'four garbage ticks -> no forming candle created')
  ok(s.glitchDrops === 4, `each counted (${s.glitchDrops})`)
  ok(logs.length === 1 && logs[0].includes('glitch guard') && logs[0].includes('ticks'), 'first drop logs once, throttled')
  s.applyTick('X', '1m', { ts: now, price: 1.2, vol: 5 })
  const forming = s.candles.get('X|1m')
  ok(!!forming && validCandle(forming), 'a finite tick forms a valid candle')
  // rollover: next bucket files the closed bar (through the same funnel)
  s.applyTick('X', '1m', { ts: now + 60, price: 1.21, vol: 5 })
  const closedArr = s.closed.get('X|1m') ?? []
  ok(closedArr.length === 1 && validCandle(closedArr[0]), 'rollover files a valid closed bar')
}

// ---------- 3. archive read-side filters (historical poison) ----------
{
  console.log('archive hydration filters')
  const good1 = bar({ time: 1_700_000_000 })
  const glitched = bar({ time: 1_700_000_060, close: NaN })
  const good2 = bar({ time: 1_700_000_120 })
  const probe: AssetInfo = {
    ticker: 'PROBE',
    name: 'Probe',
    category: 'forex',
    otc: false,
    volatility: 0.0012,
    basePrice: 1.2,
    payout: 0.85,
    open: true,
    schedule: 'forex',
  } as unknown as AssetInfo

  const svc = new MarketDataService()
  const logs: string[] = []
  ;(svc as unknown as { ctx: unknown }).ctx = { bus: { emit() {} }, log: (_t: string, m: string) => logs.push(m) }
  const s = svc as unknown as {
    store: unknown
    assets: AssetInfo[]
    buildSeries: (a: AssetInfo, tf: string) => Candle[]
    getCandlesDeep: (a: string, tf: string, n: number, co?: boolean) => Candle[]
  }
  s.assets = [probe]
  const archived = [good1, glitched, good2]
  s.store = { getCandlesArchive: () => archived.map((c) => ({ ...c })) }

  const series = s.buildSeries(probe, '1m')
  ok(series.length > 0 && !series.some((c) => c.time === glitched.time), 'buildSeries drops the poisoned archived row')
  ok(series.every(validCandle), 'buildSeries output is fully finite (incl. synth bridge bars)')

  const deep = s.getCandlesDeep('PROBE', '1m', 2000, true)
  ok(deep.length > 0 && !deep.some((c) => c.time === glitched.time), 'getCandlesDeep drops the poisoned archived row')
  ok(deep.every(validCandle), 'getCandlesDeep output is fully finite')
}

// ---------- 4. store purity after a mixed tick stream ----------
{
  console.log('store purity')
  const svc = new MarketDataService()
  ;(svc as unknown as { ctx: unknown }).ctx = { bus: { emit() {} }, log() {} }
  const s = svc as unknown as {
    applyTick: (a: string, tf: string, t: { ts: number; price: number; vol: number }) => void
    candles: Map<string, Candle | undefined>
    closed: Map<string, Candle[]>
  }
  s.closed.set('X|1m', [])
  const now = 1_700_000_100
  // garbage interleaved with good ticks - the good story must survive untainted
  s.applyTick('X', '1m', { ts: now, price: 1.2, vol: 5 })
  s.applyTick('X', '1m', { ts: now + 5, price: NaN, vol: 0 })
  s.applyTick('X', '1m', { ts: now + 10, price: 1.25, vol: 5 })
  s.applyTick('X', '1m', { ts: now + 15, price: Infinity, vol: 0 })
  s.applyTick('X', '1m', { ts: now + 20, price: 1.22, vol: 5 })
  const forming = s.candles.get('X|1m')!
  ok(validCandle(forming) && forming.high === 1.25 && forming.close === 1.22, 'garbage ticks skip, good ticks keep building (high/close untouched)')
}

console.log(`\nnan_ingest_unit: ${pass} pass / ${fail} fail`)
process.exit(fail ? 1 : 0)
