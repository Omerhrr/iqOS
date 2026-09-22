#!/usr/bin/env node
// Strategy Lab E2E - drives the LIVE kernel (127.0.0.1:3030) through the full
// AI learning lifecycle: learn -> save -> library -> /strategies visibility ->
// /run_strategy live eval -> bot_save with custom:* -> lab_backtest by id ->
// lab_delete. Run: node scripts/lab_e2e.mjs
const CORE = 'http://127.0.0.1:3030'
let pass = 0
let fail = 0
const ok = (name, cond, extra = '') => {
  if (cond) {
    pass++
    console.log(`  ok ${String(pass).padStart(2)} - ${name}`)
  } else {
    fail++
    console.error(`  FAIL ${String(fail).padStart(2)} - ${name} ${extra}`)
  }
}
const get = (p) => fetch(`${CORE}${p}`).then((r) => r.json())
const post = (p, b) => fetch(`${CORE}${p}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(b ?? {}) }).then((r) => r.json())

console.log('--- kernel health ---')
{
  const h = await get('/health')
  ok('kernel up', h.ok === true, JSON.stringify(h))
}

console.log('--- /lab_learn (real pair from the live feed) ---')
let learn
{
  const assets = await get('/assets')
  const tickers = (assets.assets || []).map((a) => a.ticker)
  const asset = tickers.includes('EURUSD') ? 'EURUSD' : tickers[0]
  learn = await post('/lab_learn', { asset, tf: '1m', bars: 900, minSamples: 25, minEdge: 1, payout: 0.7 })
  ok('learn responds', learn.ok === true, JSON.stringify(learn).slice(0, 200))
  ok('learn reports candles', learn.candlesTested >= 220, `got ${learn.candlesTested}`)
  ok('measured signals present', Array.isArray(learn.signals) && learn.signals.length > 0)
  ok('breakeven consistent w/ 0.7 payout', Math.abs(learn.breakevenWinRate - 58.82) < 0.1, String(learn.breakevenWinRate))
  if (learn.ok) {
    ok('spec has signals', learn.spec.signals.length >= 2 && learn.spec.signals.length <= 12)
    ok('spec minScore calibrated 30..75', learn.spec.minScore >= 30 && learn.spec.minScore <= 75, String(learn.spec.minScore))
    ok('calibration sweep returned', learn.calibration.thresholds.length === 10)
    ok('full backtest ran', learn.backtest && learn.backtest.trades > 0, JSON.stringify(learn.backtest))
    ok('holdout ran', learn.holdout && learn.holdout.trades > 0, JSON.stringify(learn.holdout))
  } else {
    ok('no-edge case returns transparent signals', learn.signals.length > 0)
    console.log('  (learning found no qualifying edge - save/backtest checks will use an inline spec)')
  }
}

console.log('--- /lab_backtest with an INLINE spec (AI-invented combo) ---')
let inlineBt
{
  inlineBt = await post('/lab_backtest', {
    asset: 'EURUSD',
    tf: '1m',
    payout: 0.7,
    spec: {
      name: 'Inline Combo',
      signals: [
        { kind: 'ha', variant: 'streak-down', len: 3, dir: 'put', weight: 20 },
        { kind: 'indicator', ind: 'rsi', params: { period: 14 }, op: '>', threshold: 65, dir: 'put', weight: 20 },
        { kind: 'line', variant: 'breakout-down', lookback: 20, dir: 'put', weight: 20 },
      ],
      minScore: 40,
      minVotes: 1,
      horizon: 1,
    },
  })
  ok('inline spec backtest ok', inlineBt.ok === true, JSON.stringify(inlineBt).slice(0, 200))
  ok('backtest metrics present', inlineBt.backtest && typeof inlineBt.backtest.winRate === 'number')
  ok('holdout present', inlineBt.holdout && typeof inlineBt.holdout.trades === 'number')
}

console.log('--- /lab_save -> /lab_list -> /strategies ---')
let savedId
{
  const spec = learn.ok ? learn.spec : inlineBt.spec
  const saved = await post('/lab_save', {
    name: 'E2E Learned Strategy',
    spec,
    asset: 'EURUSD',
    tf: '1m',
    stats: { backtest: learn.ok ? learn.backtest : inlineBt.backtest, holdout: learn.ok ? learn.holdout : inlineBt.holdout },
  })
  ok('save ok', saved.ok === true, JSON.stringify(saved).slice(0, 200))
  savedId = saved.id
  ok('id is custom:*', typeof savedId === 'string' && savedId.startsWith('custom:'), String(savedId))
  const list = await get('/lab_list')
  ok('library contains it', (list.strategies || []).some((s) => s.id === savedId))
  ok('library row carries stats', (list.strategies || []).find((s) => s.id === savedId)?.stats?.backtest !== undefined)
  const strats = await get('/strategies')
  const row = (strats.strategies || []).find((s) => s.id === savedId)
  ok('visible in /strategies for the bot form', !!row, JSON.stringify(strats.strategies?.map((s) => s.id)))
  const dup = await post('/lab_save', { id: savedId, name: 'E2E Learned Strategy v2', spec, asset: 'EURUSD', tf: '1m' })
  ok('upsert by id keeps one row', dup.ok === true && dup.id === savedId)
}

console.log('--- /run_strategy (live evaluation of the learned spec) ---')
{
  const run = await post('/run_strategy', { strategy: savedId, asset: 'EURUSD', tf: '1m' })
  ok('run_strategy ok', run.ok === true, JSON.stringify(run).slice(0, 200))
  ok('eval shape', run.eval && ['call', 'put', 'none'].includes(run.eval.direction) && typeof run.eval.score === 'number')
  ok('notes present', typeof run.eval?.notes === 'string' && run.eval.notes.length > 0)
  const bogus = await post('/run_strategy', { strategy: 'custom:does-not-exist', asset: 'EURUSD', tf: '1m' })
  ok('unknown custom id rejected', bogus.ok === false)
}

console.log('--- bot_save accepts the custom strategy (+ compound plan) ---')
{
  const bot = await post('/bot_save', {
    id: 'lab-e2e-bot',
    name: 'Lab E2E Bot',
    watchlist: ['EURUSD'],
    strategyId: savedId,
    tf: '1m',
    kind: 'digital',
    expirySec: 300,
    stake: 10,
    minScore: 0,
    maxOpen: 1,
    cooldownSec: 60,
    enabled: false,
    stakePlan: { kind: 'compound', base: 1, rollPct: 100, payoutCap: 70, stopOnLoss: true, periods: 7, deriskAfter: 5, deriskPct: 50, onComplete: 'halt' },
  })
  ok('bot_save ok with custom strategyId', bot.ok === true, JSON.stringify(bot).slice(0, 250))
  ok('bot keeps the custom id', bot.bot?.strategyId === savedId, JSON.stringify(bot.bot?.strategyId))
  ok('compound plan accepted', bot.bot?.stakePlan?.kind === 'compound' && bot.bot?.stakePlan?.periods === 7)
  const bots = await get('/bots')
  const row = (bots.bots || []).find((b) => b.bot.id === 'lab-e2e-bot')
  ok('bot listed with stats', !!row && row.stats && typeof row.stats.pot === 'number')
  // unknown custom id must fall back to a valid strategy, never a dead bot
  const bad = await post('/bot_save', { id: 'lab-e2e-bad', name: 'Bad', watchlist: ['EURUSD'], strategyId: 'custom:nope-nope', tf: '1m', stake: 10, enabled: false })
  ok('unknown custom id -> falls back to builtin', bad.ok === true && bad.bot.strategyId !== 'custom:nope-nope', JSON.stringify(bad.bot?.strategyId))
  await post('/bot_delete', { id: 'lab-e2e-bad' })
  await post('/bot_delete', { id: 'lab-e2e-bot' })
  const bots2 = await get('/bots')
  ok('cleanup done', !(bots2.bots || []).some((b) => b.bot.id === 'lab-e2e-bot'))
}

console.log('--- /lab_backtest by saved id ---')
{
  const bt = await post('/lab_backtest', { id: savedId, asset: 'EURUSD', tf: '1m', payout: 0.7 })
  ok('backtest by id ok', bt.ok === true && bt.id === savedId, JSON.stringify(bt).slice(0, 160))
  ok('metrics again present', bt.backtest && typeof bt.backtest.winRate === 'number')
}

console.log('--- /lab_delete ---')
{
  const del = await post('/lab_delete', { id: savedId })
  ok('delete ok', del.ok === true)
  const list = await get('/lab_list')
  ok('library empty again', !(list.strategies || []).some((s) => s.id === savedId))
  const del2 = await post('/lab_delete', { id: savedId })
  ok('double delete reports not found', del2.ok === false && !!del2.error, JSON.stringify(del2))
}

console.log(`\n${pass} pass, ${fail} fail`)
process.exit(fail ? 1 : 0)
