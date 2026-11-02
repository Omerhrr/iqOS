// IQAIR//OS - Accute fire-rate sanity check
//
// What actually caught the "Accute backtest is poor" bug wasn't a code
// review - the zone gate typechecked fine, bundled fine, and read
// correctly on a handful of manually-inspected rows. What caught it was
// literally counting how often the combined gate stack lets a signal
// through across the whole universe, and noticing it was ~0%. This script
// turns that one-off check into something you can run again any time a
// gate is added to or changed on Accute (zone, renko, adaptive, or a
// future one), against a LIVE running kernel (not from-disk history like
// scripts/validate-learning.ts - this is about the gate's CURRENT
// behavior on CURRENT market data, which a resolved ledger on disk can't
// show you until days later).
//
// It polls /accute_scan across every configured timeframe, buckets every
// non-agreeing row by WHY it isn't agreeing (parsed from the row's own
// summary string - "zone gate:", "renko gate:", "adaptive gate:", or the
// underlying 3-leg "waiting - ..." reasons), and checks the overall fire
// rate against a sane band. Outside that band is a strong signal
// something is mis-wired, exactly like the zone-gate bug this script
// exists to catch earlier next time.
//
// Run with: bun run scripts/accute_firerate_check.ts
// Optional: KERNEL_URL=http://localhost:3030 (default) or point it at a
// deployed kernel; TFS=1m,5m to override the timeframe list.

const KERNEL_URL = process.env.KERNEL_URL ?? 'http://localhost:3030'
const TFS = (process.env.TFS ?? '1m,2m,5m').split(',').map((s) => s.trim()).filter(Boolean)
const SCAN_LIMIT = 150

// Below this fraction of the universe agreeing, the gate stack is almost
// certainly over-vetoing (this is exactly the symptom the zone-gate bug
// produced: 0/116 agreeing). Above the upper bound, it's probably
// under-gating - triple confluence plus zone plus renko agreeing on close
// to half the board at once is not a "rarest signal in the catalog" rate.
const FIRE_RATE_MIN = 0.01
const FIRE_RATE_MAX = 0.35

interface AccuteRow {
  asset: string
  direction: 'call' | 'put' | 'none'
  summary: string
  zone: { side: 'buy' | 'sell' | 'none' }
  renko: { trend: 'up' | 'down' | 'none' }
  adaptive: { overridden: boolean }
}

interface ScanResponse {
  ok: boolean
  error?: string
  tf: string
  universe: number
  scanned: number
  agreeing: number
  rows: AccuteRow[]
}

function classifyBlock(r: AccuteRow): string {
  if (r.direction !== 'none') return 'agreeing'
  if (r.summary.startsWith('adaptive gate:')) return 'blocked: adaptive override'
  if (r.summary.startsWith('zone gate:')) return 'blocked: zone disagrees'
  if (r.summary.startsWith('renko gate:')) return 'blocked: renko disagrees'
  if (r.summary.startsWith('waiting - all 3 legs flat')) return 'no agreement: all 3 flat'
  if (r.summary.startsWith('waiting - no 3-way agreement')) return 'no agreement: some flat, none agree'
  if (r.summary.includes('lean')) return 'no agreement: 2/3 lean, 1 holding out'
  return 'other/warming up'
}

async function run(): Promise<void> {
  console.log(`Accute fire-rate sanity check against ${KERNEL_URL} (timeframes: ${TFS.join(', ')})\n`)
  let anyFail = false
  for (const tf of TFS) {
    const url = `${KERNEL_URL}/accute_scan?tf=${encodeURIComponent(tf)}&limit=${SCAN_LIMIT}&refresh=1`
    let data: ScanResponse
    try {
      const res = await fetch(url)
      data = (await res.json()) as ScanResponse
    } catch (e) {
      console.log(`[${tf}] FAIL - could not reach kernel: ${(e as Error).message}`)
      anyFail = true
      continue
    }
    if (!data.ok) {
      console.log(`[${tf}] FAIL - kernel returned error: ${data.error ?? 'unknown'}`)
      anyFail = true
      continue
    }
    const rate = data.scanned > 0 ? data.agreeing / data.scanned : 0
    const verdict = data.scanned === 0 ? 'FAIL (nothing scanned - market data not warmed up?)' : rate < FIRE_RATE_MIN ? 'FAIL (over-gated - almost nothing ever agrees)' : rate > FIRE_RATE_MAX ? 'WARN (under-gated - agreeing far more than expected)' : 'PASS'
    if (verdict.startsWith('FAIL')) anyFail = true
    console.log(`[${tf}] scanned ${data.scanned}/${data.universe}, agreeing ${data.agreeing} (${(rate * 100).toFixed(1)}%) - ${verdict}`)

    const buckets = new Map<string, number>()
    for (const r of data.rows) {
      const k = classifyBlock(r)
      buckets.set(k, (buckets.get(k) ?? 0) + 1)
    }
    for (const [k, n] of [...buckets.entries()].sort((a, b) => b[1] - a[1])) {
      console.log(`    ${n.toString().padStart(3)}  ${k}`)
    }
    console.log()
  }
  console.log(anyFail ? 'RESULT: at least one timeframe FAILed the sanity band - investigate before trusting live/backtest results.' : 'RESULT: all timeframes within the sane fire-rate band.')
  process.exit(anyFail ? 1 : 0)
}

run()
