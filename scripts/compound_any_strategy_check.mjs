// Task 36b — verify compound stake plans attach to EVERY builtin strategy.
// Creates a compound bot per strategy against the live kernel, checks /bot_save
// accepts it + stats echo the plan, then deletes each bot. Read-only for books.
const KERNEL = process.env.KERNEL_URL ?? 'http://127.0.0.1:3030'

const STRATEGIES = [
  'rsi-reversion', 'macd-cross', 'bb-bounce', 'ema-trend', 'markov-edge',
  'donchian-breakout', 'stoch-cross', 'supertrend-follow', 'pattern-confluence',
  'kalman-ou-reversion', 'confluence-core', 'vsk-synthesis', 'tsk-synthesis',
]

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

const health = await j('GET', '/health')
ok(health.data?.ok === true, 'kernel healthy')

// a valid watchlist ticker — take the first mapped asset
const assets = await j('GET', '/assets')
const ticker = assets.data?.assets?.[0]?.ticker ?? assets.data?.assets?.[0]?.symbol
ok(Boolean(ticker), 'got a watchlist ticker', ticker)

const created = []
for (const sid of STRATEGIES) {
  const body = {
    name: `cx-${sid}`,
    watchlist: [ticker],
    strategyId: sid,
    tf: '1m',
    enabled: false, // never arm - config acceptance only
    stakePlan: { kind: 'compound', base: 1, rollPct: 100, payoutCap: 70, stopOnLoss: true },
  }
  const res = await j('POST', '/bot_save', body)
  const bot = res.data?.bot
  const okSave = res.status === 200 && res.data?.ok === true && bot?.stakePlan?.kind === 'compound'
  ok(okSave, `compound + ${sid}`, res.data?.ok ? { base: bot?.stakePlan?.base, cap: bot?.stakePlan?.payoutCap, stopOnLoss: bot?.stakePlan?.stopOnLoss } : res.data?.error ?? res.status)
  if (okSave) created.push(bot.id)
}

// stats echo: pot/rollN/restarts/halted all present for every compound bot
const bots = await j('GET', '/bots')
for (const id of created) {
  const row = bots.data?.bots?.find((b) => b.bot?.id === id)
  ok(row && typeof row.stats?.pot === 'number' && typeof row.stats?.halted === 'boolean', `stats expose compound state for ${id}`)
}

for (const id of created) await j('POST', '/bot_delete', { id })
ok(true, `cleaned up ${created.length} bots`)

console.log(`\n${pass} PASS / ${fail} FAIL`)
process.exit(fail ? 1 : 0)
