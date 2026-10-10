// Live probe: every row the RUNNING kernel serves from /screener and
// /screener2 must carry a fully finite tradeable core (layer-2 guard proof
// under the real sim feed). NaN/Inf would serialize as null in JSON.
const BASE = 'http://localhost:3030'
const CORE = ['price', 'score', 'confidence', 'pUp', 'pDown', 'rsi', 'adx', 'atrPct', 'hurst', 'changePct', 'ouZ', 'ouHalfLife', 'ouTStat']
const CORE2 = ['price', 'score', 'confidence']

let pass = 0
let fail = 0
const ok = (cond, name) => {
  if (cond) { pass++; console.log('  ok', name) } else { fail++; console.log('  FAIL', name) }
}
const fin = (v) => typeof v === 'number' && Number.isFinite(v)

const sweep = async (path, core, label) => {
  const res = await fetch(`${BASE}${path}`)
  const data = await res.json()
  const rows = data.rows ?? []
  ok(rows.length > 20, `${label}: feed has rows (${rows.length})`)
  const bad = []
  for (const r of rows) for (const k of core) if (!fin(r[k])) bad.push(`${r.asset}|${r.tf}:${k}=${r[k]}`)
  ok(bad.length === 0, `${label}: every served row fully finite-core${bad.length ? ` - bad: ${bad.slice(0, 6).join(', ')}` : ''}`)
  console.log(`  (${label}: ${rows.length} rows scanned, ${core.length} core fields each)`)
}

const waitSweep = async () => {
  for (let i = 0; i < 60; i++) {
    await new Promise((r) => setTimeout(r, 3000))
    try {
      // NOTE: the payload is nested ({ok, status:{pairs, sweeping, ...}}) and
      // `sweeping` never settles on a live feed (stale rescans requeue
      // continuously) - wait on the nested pairs count only.
      const st = await (await fetch(`${BASE}/screener_status`)).json()
      if ((st.status?.pairs ?? st.pairs ?? 0) > 100) return st.status ?? st
    } catch { /* kernel warming */ }
  }
  return null
}

const st = await waitSweep()
ok(!!st, `screener sweep completed (${st ? `${st.pairs} pairs` : 'TIMEOUT'})`)
await sweep('/screener?limit=200', CORE, 'screener')
await sweep('/screener2?limit=200', CORE2, 'screener2')
console.log(`\nlive nan-core probe: ${pass} pass / ${fail} fail`)
process.exit(fail ? 1 : 0)
