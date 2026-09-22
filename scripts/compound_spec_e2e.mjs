// Task 37 E2E — the user's spoken spec, verbatim, into a structured bot:
//   "trade confluence-core, entries in EURUSD/GBPUSD/USDJPY, 2m tf,
//    15 minute expiry, no concurrent trades, compound $1 for 7 periods,
//    de-risk to half after the 5th period, overlap session only"
// Verifies: /compound_plan ladder with periods+derisk, /bot_save echo,
// /bot_restart acceptance, cleanup.
const KERNEL = process.env.KERNEL_URL ?? 'http://127.0.0.1:3030'

const j = async (method, path, body) => {
  const res = await fetch(`${KERNEL}${path}`, {
    method,
    headers: { 'content-type': 'application/json' },
    body: body ? JSON.stringify(body) : undefined,
  })
  return { status: res.status, data: await res.json().catch(() => ({})) }
}

let pass = 0, fail = 0
const ok = (cond, label, extra) => {
  if (cond) { pass++; console.log(`PASS - ${label}`, extra !== undefined ? `(${JSON.stringify(extra)})` : '') }
  else { fail++; console.log(`FAIL - ${label}`, extra !== undefined ? `(${JSON.stringify(extra)})` : '') }
}
const near = (a, b, tol = 0.011) => Math.abs(a - b) <= tol

// ---------- 1. the ladder the copilot would SHOW before deploying ----------
const plan = await j('GET', '/compound_plan?base=1&payout=0.7&periods=7&deriskAfter=5&deriskPct=50')
ok(plan.data?.ok === true, 'compound_plan ok')
ok(plan.data?.schedule?.length === 7, 'ladder bounded to 7 periods', plan.data?.schedule?.length)
const phases = plan.data.schedule.map((s) => s.phase).join(',')
ok(phases === 'compound,compound,compound,compound,compound,derisk,derisk', 'derisk phase starts after 5 wins', phases)
const stakes = plan.data.schedule.map((s) => s.stake)
ok(
  near(stakes[0], 1) && near(stakes[1], 1.7) && near(stakes[2], 2.89) && near(stakes[3], 4.91) && near(stakes[4], 8.35),
  'compound-phase stakes at 70% cap', stakes,
)
ok(near(stakes[5], 7.1) && near(stakes[6], 9.58), 'derisk-phase stakes are HALF the pot', [stakes[5], stakes[6]])
ok(near(plan.data.cycleProfit, 24.88), 'cycleProfit for a perfect 7-period run', plan.data.cycleProfit)
ok(near(plan.data.schedule[6].lossAt, 35.53), 'lossAt = worst-case capital if the last trade dies', plan.data.schedule[6].lossAt)

// ---------- 2. deploy the exact spoken spec ----------
const spec = {
  name: 'Confluence 7p overlap',
  watchlist: ['EURUSD', 'GBPUSD', 'USDJPY'],
  strategyId: 'confluence-core',
  tf: '2m',
  kind: 'digital',
  expirySec: 900,
  session: 'overlap',
  minScore: 55,
  maxOpen: 1,
  cooldownSec: 60,
  enabled: false, // E2E never arms - config acceptance only
  stakePlan: {
    kind: 'compound', base: 1, rollPct: 100, payoutCap: 70, stopOnLoss: true,
    periods: 7, deriskAfter: 5, deriskPct: 50, onComplete: 'halt',
  },
}
const saved = await j('POST', '/bot_save', spec)
const bot = saved.data?.bot
ok(saved.data?.ok === true, 'full spoken spec accepted by /bot_save', saved.data?.error ?? '')
ok(bot?.kind === 'digital' && bot?.expirySec === 900, '15-minute expiry mapped to digital + expirySec 900', { kind: bot?.kind, expirySec: bot?.expirySec })
ok(bot?.session === 'overlap', 'overlap session stored')
ok(bot?.maxOpen === 1, 'no concurrent trades (maxOpen 1)')
ok(bot?.stakePlan?.periods === 7 && bot?.stakePlan?.deriskAfter === 5 && bot?.stakePlan?.deriskPct === 50, 'periods + de-risk stored', bot?.stakePlan)

// ---------- 3. restart accepted on this bot (periods-complete flows use it) ----------
const rr = await j('POST', '/bot_restart', { id: bot.id })
ok(rr.data?.ok === true, 'bot_restart ok on periods bot', rr.data?.error ?? '')

// ---------- 4. bots list carries the new stats fields ----------
const bots = await j('GET', '/bots')
const row = bots.data?.bots?.find((b) => b.bot?.id === bot.id)
ok(row && typeof row.stats?.complete === 'boolean', 'stats expose complete flag', row?.stats)

await j('POST', '/bot_delete', { id: bot.id })
ok(true, 'cleaned up')

console.log(`\n${pass} PASS / ${fail} FAIL`)
process.exit(fail ? 1 : 0)
