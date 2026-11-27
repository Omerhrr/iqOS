// Runs many strategies over the recorded Binance data and ranks them (POST /binance/replay). See analytics/binancereplay.ts for what a run does and how the verdict is judged.
//
// Each strategy is run in its follow and fade form (when it declares a `mode` input), at every requested expiry, on the candle mode it asks for.
// The number of runs is passed to the verdict as "variants tried": the more things are tried on the same data, the more of them look good by luck, so the bar for "candidate" rises with it.
import { BUILTIN_TV_SPECS } from './builtinTvSpecs'
import { binanceSymbolFor, BINANCE_SYMBOLS } from '../analytics/binancedata'
import { ArrayMinuteSource, replayModeOf, runReplay, type ReplayMode, type ReplayStats } from '../analytics/binancereplay'
import { listScriptInputs, type MslInputValue } from '../analytics/strategylang'
import { loadRecorded, type BinanceFeed, type RecordedData } from './binancefeed'

export interface BoardRequest {
  pair?: string
  tf?: string
  expiry?: number[]
  payout?: number
  /** saved/builtin strategy ids; omitted = every builtin whose id starts with meta:builtin-binance- */
  ids?: string[]
  /** an ad-hoc script text to include */
  script?: string
  from?: string
  to?: string
  /** force a candle mode for every script (otherwise each script's own dataSource input decides) */
  modeOverride?: ReplayMode
  /** also run the fade form of each script that has a follow/fade `mode` input (default true) */
  variants?: boolean
  maxRuns?: number
}
export interface BoardRow {
  id: string
  label: string
  variant: string
  mode: ReplayMode | 'iq'
  expiryBars: number
  ok: boolean
  error?: string
  candles: number
  stats: ReplayStats | null
}
export interface BoardResult {
  ok: boolean
  error?: string
  pair: string
  tf: string
  payout: number
  breakeven: number
  coverage: RecordedData['coverage'][string] | null
  files: number
  runs: number
  note: string
  rows: BoardRow[]
}

const yieldLoop = () => new Promise<void>((r) => setImmediate(r))

export async function runBoard(feed: BinanceFeed, getScript: (id: string) => string | undefined, req: BoardRequest): Promise<BoardResult> {
  const pair = (req.pair ?? 'BTCUSD').toUpperCase()
  const tf = req.tf ?? '1m'
  const payout = Math.min(1.5, Math.max(0.1, Number(req.payout ?? 0.85)))
  const expiry = (req.expiry?.length ? req.expiry : [1, 3]).map((n) => Math.max(1, Math.round(n))).slice(0, 4)
  const symbol = binanceSymbolFor(pair)
  const base: BoardResult = { ok: false, pair, tf, payout, breakeven: 1 / (1 + payout), coverage: null, files: 0, runs: 0, note: '', rows: [] }
  if (!symbol) return { ...base, error: `no Binance market for ${pair} (only ${Object.keys(BINANCE_SYMBOLS).join(', ')})` }
  const data = loadRecorded(feed.recordedDir(), req.from, req.to)
  const cov = data.coverage[symbol] ?? null
  if (!cov || !cov.minutes) return { ...base, files: data.files.length, error: 'nothing recorded for this pair yet: leave the recorder on and try again after a few hours' }
  const src = new ArrayMinuteSource(); src.set(symbol, data.minutes.get(symbol) ?? [])
  const iq = data.iq.get(symbol) ?? new Map()

  // which scripts
  const items: { id: string; label: string; script: string }[] = []
  const ids = req.ids?.length ? req.ids : BUILTIN_TV_SPECS.filter((s) => s.id.startsWith('meta:builtin-binance-')).map((s) => s.id)
  for (const id of ids) {
    const script = getScript(id) ?? BUILTIN_TV_SPECS.find((s) => s.id === id)?.script
    if (script) items.push({ id, label: BUILTIN_TV_SPECS.find((s) => s.id === id)?.name ?? id, script })
  }
  if (req.script && req.script.trim()) items.push({ id: 'adhoc', label: 'ad-hoc script', script: req.script })
  if (!items.length) return { ...base, coverage: cov, files: data.files.length, error: 'no strategies to run' }

  // plan the runs (so the verdict knows how many variants were tried)
  type Plan = { item: (typeof items)[number]; variant: string; inputs?: Record<string, MslInputValue>; ex: number }
  const plan: Plan[] = []
  for (const it of items) {
    const decl = listScriptInputs(it.script)
    const hasMode = decl.ok && decl.inputs.some((i) => i.name === 'mode')
    const variants: { v: string; inputs?: Record<string, MslInputValue> }[] = hasMode && req.variants !== false ? [{ v: 'follow', inputs: { mode: 'follow' } }, { v: 'fade', inputs: { mode: 'fade' } }] : [{ v: 'default' }]
    for (const v of variants) for (const ex of expiry) plan.push({ item: it, variant: v.v, inputs: v.inputs, ex })
  }
  const maxRuns = Math.min(80, req.maxRuns ?? 60)
  const planned = plan.slice(0, maxRuns)
  const tried = planned.length

  const rows: BoardRow[] = []
  for (const p of planned) {
    await yieldLoop() // never hold the kernel's loop for the whole board
    let mode = req.modeOverride ?? replayModeOf(p.item.script, p.inputs)
    let note = ''
    if (mode === 'iq') { rows.push({ id: p.item.id, label: p.item.label, variant: p.variant, mode, expiryBars: p.ex, ok: false, error: 'dataSource is iq: IQ has no volume, nothing to replay', candles: 0, stats: null }); continue }
    if (mode === 'volume' && cov.iq < 60) { mode = 'binance'; note = ' (IQ candles not recorded for this pair yet: replayed on Binance candles instead)' }
    const r = runReplay({ script: p.item.script, inputs: p.inputs, mode, tf, symbol, src, iq, expiryBars: p.ex, payout, tried })
    rows.push({ id: p.item.id, label: p.item.label, variant: p.variant + note, mode, expiryBars: p.ex, ok: r.ok, error: r.ok ? undefined : /compares the live Binance and IQ/i.test(r.error ?? '') ? 'live only: this strategy compares the live Binance and IQ streams - test it with the lead/lag analyzer on recorded ticks' : /only exists live/i.test(r.error ?? '') ? 'live only: this strategy reads the forming bar, so it cannot be replayed (the running-bar snapshots are kept for a later test)' : r.error, candles: r.candles, stats: r.stats })
  }
  const rank = (r: BoardRow) => (r.stats && r.stats.trades >= 30 && r.stats.expectancy != null ? r.stats.expectancy : -9)
  rows.sort((a, b) => rank(b) - rank(a))
  return {
    ...base, ok: true, coverage: cov, files: data.files.length, runs: tried, rows,
    note: `${tried} runs on ${cov.minutes} recorded minutes (${((cov.last - cov.first) / 3600).toFixed(1)} h). With this many variants tried on the same data, some look good by luck: only a "candidate" survives that correction and the out-of-sample tail, and even then it needs fresh days to confirm.`,
  }
}
