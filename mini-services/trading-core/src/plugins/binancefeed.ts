// IQAIR//OS - Binance public market-data feed (BTCUSDT / ETHUSDT): closed 1m candles with real volume, an
// aggressor-tagged footprint built from the trade stream, a REST backfill, a recorder, and health.
//
// No account, no API key: Binance publishes market data on public endpoints. Both hosts are overridable
// (BINANCE_WS_URL / BINANCE_REST_URL) so a market-data-only hostname can be used where the main one is blocked.
//
// HONESTY: this is Binance's market, not IQ Option's. It is merged onto IQ candles by the minute (analytics/binancedata.ts)
// and a strategy chooses per script whether to use it (`configure data.source`). Only CLOSED minutes are ever served.
//
// Failure behaviour: if the socket drops the feed reconnects with backoff and backfills the gap over REST; until then
// `health().stale` is true and consumers see the minutes they already have, never invented ones. A minute whose trade
// ladder has a gap (reconnect, missing aggTrade id) is stored with footComplete=false and its delta falls back to the
// kline taker split.

import { appendFileSync, existsSync, mkdirSync, readdirSync, readFileSync, unlinkSync } from 'node:fs'
import { join } from 'node:path'
import type { Plugin } from '../kernel'
import { BINANCE_BIN, BINANCE_SYMBOLS, TF_SEC, aggAt, binanceCandles, binanceSymbolFor, nowBar, overlayVolume, type BinanceMinute, type BinanceNow, type FootRow, type MinuteSource } from '../analytics/binancedata'
import { setBinanceReader } from '../analytics/strategylang'
import type { Candle } from '../types'

const MAX_MINUTES = 6000 // ~4 days of 1m per symbol
const RESTORE_DAYS = 2

interface Forming { rows: Map<number, FootRow>; trades: number; complete: boolean }
interface Kl { t: number; o: number; h: number; l: number; c: number; v: number; q: number; n: number; V: number; atMs: number }
interface SymState {
  lastKline: Kl | null
  minutes: BinanceMinute[]
  forming: Map<number, Forming>
  lastAggId: number
  lastTradeMs: number
  lastCloseMs: number
}

export interface BinanceHealth {
  enabled: boolean
  connected: boolean
  stale: boolean
  reconnects: number
  lastMessageAgoSec: number | null
  lastError: string | null
  restUrl: string
  wsUrl: string
  symbols: { symbol: string; pair: string; minutesHeld: number; lastClosed: number; lastClosedAgoSec: number | null; footMinutes: number; lastTradeAgoSec: number | null }[]
  recorder: { on: boolean; dir: string; written: number; snapshots: number }
}

export class BinanceFeed implements MinuteSource {
  private state = new Map<string, SymState>()
  private ws: WebSocket | null = null
  private enabled = false
  private connected = false
  private stopped = false
  private reconnects = 0
  private lastMsgMs = 0
  private lastError: string | null = null
  private backoffMs = 1000
  private watchdog: ReturnType<typeof setInterval> | null = null
  private snapTimer: ReturnType<typeof setInterval> | null = null
  private snapWritten = 0
  private sessionStartMs = 0
  private written = 0
  private recorderOn = true
  private readonly dir: string
  readonly restUrl: string
  readonly wsUrl: string
  /** the IQ 1m candle at a minute, for the recorder (so the saved file has both sides) */
  iqMinute: ((pair: string, timeSec: number) => { open: number; high: number; low: number; close: number } | undefined) | null = null
  private nowMs: () => number

  constructor(opts: { dataDir?: string; nowMs?: () => number } = {}) {
    this.dir = join(opts.dataDir ?? join(process.cwd(), 'data'), 'binance')
    this.restUrl = (process.env.BINANCE_REST_URL ?? 'https://api.binance.com').replace(/\/$/, '')
    this.wsUrl = (process.env.BINANCE_WS_URL ?? 'wss://stream.binance.com:9443').replace(/\/$/, '')
    this.nowMs = opts.nowMs ?? Date.now
    for (const sym of Object.values(BINANCE_SYMBOLS)) this.state.set(sym, { lastKline: null, minutes: [], forming: new Map(), lastAggId: 0, lastTradeMs: 0, lastCloseMs: 0 })
  }

  symbols(): string[] { return [...this.state.keys()] }

  // ---------- MinuteSource ----------
  range(symbol: string, fromSec: number, toSec: number): BinanceMinute[] {
    const arr = this.state.get(symbol)?.minutes
    if (!arr || !arr.length) return []
    let lo = 0, hi = arr.length
    while (lo < hi) { const mid = (lo + hi) >> 1; if (arr[mid].time < fromSec) lo = mid + 1; else hi = mid }
    const out: BinanceMinute[] = []
    for (let i = lo; i < arr.length && arr[i].time < toSec; i++) out.push(arr[i])
    return out
  }
  lastClosed(symbol: string): number { const a = this.state.get(symbol)?.minutes; return a && a.length ? a[a.length - 1].time : 0 }
  firstHeld(symbol: string): number { const a = this.state.get(symbol)?.minutes; return a && a.length ? a[0].time : 0 }

  // ---------- ingest (public so tests can drive it without a socket) ----------
  /** insert a CLOSED minute (kept sorted, deduped by time) */
  addMinute(symbol: string, m: BinanceMinute, record = true): void {
    const st = this.state.get(symbol)
    if (!st) return
    const arr = st.minutes
    if (!arr.length || m.time > arr[arr.length - 1].time) arr.push(m)
    else {
      let lo = 0, hi = arr.length
      while (lo < hi) { const mid = (lo + hi) >> 1; if (arr[mid].time < m.time) lo = mid + 1; else hi = mid }
      if (arr[lo] && arr[lo].time === m.time) { if (!arr[lo].foot && m.foot) arr[lo] = m } else arr.splice(lo, 0, m)
    }
    if (arr.length > MAX_MINUTES) arr.splice(0, arr.length - MAX_MINUTES)
    if (record) this.record(symbol, m)
  }

  private formingFor(st: SymState, minuteSec: number): Forming {
    let f = st.forming.get(minuteSec)
    if (!f) {
      // a minute is only "complete" when this socket session started before it did
      f = { rows: new Map(), trades: 0, complete: minuteSec * 1000 >= this.sessionStartMs }
      st.forming.set(minuteSec, f)
    }
    return f
  }

  ingestTrade(symbol: string, aggId: number, price: number, qty: number, tradeMs: number, buyerIsMaker: boolean): void {
    const st = this.state.get(symbol)
    if (!st || !(price > 0) || !(qty > 0)) return
    const minuteSec = Math.floor(tradeMs / 60000) * 60
    const f = this.formingFor(st, minuteSec)
    if (st.lastAggId && aggId !== st.lastAggId + 1) f.complete = false // a hole in the trade ids: this minute's ladder is partial
    st.lastAggId = aggId
    st.lastTradeMs = tradeMs
    const step = BINANCE_BIN[symbol] ?? 1
    const p = Math.round(price / step) * step
    let row = f.rows.get(p)
    if (!row) { row = { price: p, buy: 0, sell: 0 }; f.rows.set(p, row) }
    // buyer is the maker -> the SELLER hit the bid (aggressor = sell)
    if (buyerIsMaker) row.sell += qty; else row.buy += qty
    f.trades++
  }

  ingestKline(symbol: string, k: { t: number; o: string; h: string; l: string; c: string; v: string; q: string; n: number; V: string; x: boolean }): void {
    const st = this.state.get(symbol)
    if (!st) return
    if (!k.x) {
      // the minute in progress: kept ONLY for nowBar() (live reads), never added to the closed history
      const t = Number(k.t), o = Number(k.o), h = Number(k.h), l = Number(k.l), c = Number(k.c), v = Number(k.v)
      if ([t, o, h, l, c, v].every(Number.isFinite)) st.lastKline = { t: Math.floor(t / 1000), o, h, l, c, v, q: Number(k.q), n: Number(k.n), V: Number(k.V), atMs: this.nowMs() }
      return
    }
    st.lastKline = null
    const timeSec = Math.floor(k.t / 1000)
    const f = st.forming.get(timeSec)
    const m: BinanceMinute = {
      time: timeSec, open: Number(k.o), high: Number(k.h), low: Number(k.l), close: Number(k.c),
      volume: Number(k.v), quoteVolume: Number(k.q), trades: k.n, takerBuy: Number(k.V),
    }
    if (![m.open, m.high, m.low, m.close, m.volume].every(Number.isFinite)) return
    if (f && f.rows.size) {
      m.foot = [...f.rows.values()].sort((a, b) => a.price - b.price)
      // the ladder must add up to the kline volume, otherwise some trades were missed and it is NOT complete
      const sum = m.foot.reduce((a, r) => a + r.buy + r.sell, 0)
      m.footComplete = f.complete && Math.abs(sum - m.volume) <= Math.max(1e-6, m.volume * 0.002)
    }
    st.forming.delete(timeSec)
    for (const key of [...st.forming.keys()]) if (key < timeSec - 180) st.forming.delete(key) // stale leftovers
    st.lastCloseMs = this.nowMs()
    this.addMinute(symbol, m)
  }

  /** one combined-stream frame */
  handleMessage(raw: string): void {
    this.lastMsgMs = this.nowMs()
    let o: { stream?: string; data?: Record<string, unknown> }
    try { o = JSON.parse(raw) } catch { return }
    const d = (o.data ?? o) as Record<string, any>
    const sym = String(d.s ?? '')
    if (d.e === 'aggTrade') this.ingestTrade(sym, Number(d.a), Number(d.p), Number(d.q), Number(d.T), Boolean(d.m))
    else if (d.e === 'kline' && d.k) this.ingestKline(sym, d.k)
  }

  // ---------- network ----------
  private url(): string {
    const parts: string[] = []
    for (const s of this.symbols()) { const l = s.toLowerCase(); parts.push(`${l}@kline_1m`, `${l}@aggTrade`) }
    return `${this.wsUrl}/stream?streams=${parts.join('/')}`
  }

  private connect(): void {
    if (this.stopped) return
    let ws: WebSocket
    try { ws = new WebSocket(this.url()) } catch (e) { this.fail(e); return }
    this.ws = ws
    ws.onopen = () => {
      this.connected = true
      this.sessionStartMs = this.nowMs()
      this.backoffMs = 1000
      this.lastError = null
      for (const st of this.state.values()) st.lastAggId = 0 // a new session: the id chain starts over
      void this.backfillAll()
    }
    ws.onmessage = (ev: MessageEvent) => { try { this.handleMessage(typeof ev.data === 'string' ? ev.data : String(ev.data)) } catch (e) { this.lastError = String(e) } }
    ws.onerror = () => { this.lastError = 'websocket error' }
    ws.onclose = () => {
      this.connected = false
      this.ws = null
      if (this.stopped) return
      this.reconnects++
      const wait = this.backoffMs
      this.backoffMs = Math.min(60_000, this.backoffMs * 2)
      setTimeout(() => this.connect(), wait)
    }
  }

  private fail(e: unknown): void {
    this.lastError = e instanceof Error ? e.message : String(e)
    if (this.stopped) return
    setTimeout(() => this.connect(), this.backoffMs)
    this.backoffMs = Math.min(60_000, this.backoffMs * 2)
  }

  /** REST klines -> closed minutes (the still-forming last one is dropped). Fills history at start and any gap after a reconnect. */
  async backfill(symbol: string, limit = 1000): Promise<number> {
    const res = await fetch(`${this.restUrl}/api/v3/klines?symbol=${symbol}&interval=1m&limit=${limit}`, { signal: AbortSignal.timeout(15_000) })
    if (!res.ok) throw new Error(`klines ${symbol}: HTTP ${res.status}`)
    const rows = (await res.json()) as unknown[][]
    const nowSec = Math.floor(this.nowMs() / 1000)
    let n = 0
    for (const r of rows) {
      const closeMs = Number(r[6])
      if (closeMs >= nowSec * 1000) continue // still forming
      this.addMinute(symbol, {
        time: Math.floor(Number(r[0]) / 1000), open: Number(r[1]), high: Number(r[2]), low: Number(r[3]), close: Number(r[4]),
        volume: Number(r[5]), quoteVolume: Number(r[7]), trades: Number(r[8]), takerBuy: Number(r[9]),
      }, false)
      n++
    }
    return n
  }

  private async backfillAll(): Promise<void> {
    for (const s of this.symbols()) {
      try { await this.backfill(s) } catch (e) { this.lastError = e instanceof Error ? e.message : String(e) }
    }
  }

  start(): void {
    this.enabled = process.env.BINANCE_FEED !== 'off'
    if (!this.enabled) return
    this.stopped = false
    this.restore()
    this.connect()
    // running-bar snapshots for later intrabar strategy tests (data/binance/now-YYYY-MM-DD.jsonl); older than 14 days are pruned
    this.pruneSnapshots()
    const snapSec = Math.max(1, Number(process.env.BINANCE_SNAP_SEC ?? 5))
    this.snapTimer = setInterval(() => this.snapshot(), snapSec * 1000)
    this.watchdog = setInterval(() => {
      // a socket that is "open" but silent for 60 s is dead: recycle it
      if (this.connected && this.nowMs() - this.lastMsgMs > 60_000) { try { this.ws?.close() } catch { /* ignore */ } }
    }, 15_000)
  }

  stop(): void {
    this.stopped = true
    if (this.watchdog) clearInterval(this.watchdog)
    if (this.snapTimer) clearInterval(this.snapTimer)
    try { this.ws?.close() } catch { /* ignore */ }
  }

  // ---------- recorder ----------
  setRecorder(on: boolean): void { this.recorderOn = on }

  private record(symbol: string, m: BinanceMinute): void {
    if (!this.recorderOn || !this.enabled) return
    try {
      mkdirSync(this.dir, { recursive: true })
      const day = new Date(m.time * 1000).toISOString().slice(0, 10)
      const pair = Object.keys(BINANCE_SYMBOLS).find((k) => BINANCE_SYMBOLS[k] === symbol)
      const iq = pair && this.iqMinute ? this.iqMinute(pair, m.time) : undefined
      const line = JSON.stringify({
        s: symbol, t: m.time, o: m.open, h: m.high, l: m.low, c: m.close, v: m.volume, q: m.quoteVolume, n: m.trades, tb: m.takerBuy,
        ...(m.foot ? { f: m.foot.map((r) => [r.price, r.buy, r.sell]), fc: m.footComplete ? 1 : 0 } : {}),
        ...(iq ? { iq: [iq.open, iq.high, iq.low, iq.close] } : {}),
      })
      appendFileSync(join(this.dir, `${day}.jsonl`), line + '\n')
      this.written++
    } catch (e) { this.lastError = `recorder: ${e instanceof Error ? e.message : String(e)}` }
  }

  /** one line per symbol: the minute in progress (running volume, taker buy, ladder buy/sell when complete). Public so a test can drive it. */
  snapshot(): void {
    if (!this.recorderOn || !this.enabled || !this.connected) return
    try {
      mkdirSync(this.dir, { recursive: true })
      const nowMs = this.nowMs()
      for (const sym of this.symbols()) {
        const m = this.formingMinute(sym)
        if (!m) continue
        let bb: number | undefined, bs: number | undefined
        if (m.foot && m.footComplete) { bb = 0; bs = 0; for (const r of m.foot) { bb += r.buy; bs += r.sell } }
        const day = new Date(nowMs).toISOString().slice(0, 10)
        appendFileSync(join(this.dir, `now-${day}.jsonl`), JSON.stringify({ s: sym, ts: nowMs, m: m.time, o: m.open, h: m.high, l: m.low, c: m.close, v: m.volume, n: m.trades, tb: m.takerBuy, ...(bb !== undefined ? { bb, bs } : {}) }) + '\n')
        this.snapWritten++
      }
    } catch (e) { this.lastError = `snapshot: ${e instanceof Error ? e.message : String(e)}` }
  }

  private pruneSnapshots(): void {
    try {
      if (!existsSync(this.dir)) return
      const cutoff = new Date(this.nowMs() - 14 * 86_400_000).toISOString().slice(0, 10)
      for (const f of readdirSync(this.dir)) if (f.startsWith('now-') && f.slice(4, 14) < cutoff) unlinkSync(join(this.dir, f))
    } catch { /* best effort */ }
  }

  /** reload the last days of recorded minutes so a restart does not lose the footprint history */
  private restore(): void {
    try {
      if (!existsSync(this.dir)) return
      const files = readdirSync(this.dir).filter((f) => f.endsWith('.jsonl') && !f.startsWith('now-')).sort().slice(-RESTORE_DAYS)
      for (const f of files) {
        for (const line of readFileSync(join(this.dir, f), 'utf8').split('\n')) {
          if (!line) continue
          try {
            const j = JSON.parse(line)
            this.addMinute(j.s, {
              time: j.t, open: j.o, high: j.h, low: j.l, close: j.c, volume: j.v, quoteVolume: j.q, trades: j.n, takerBuy: j.tb,
              ...(j.f ? { foot: (j.f as number[][]).map((r) => ({ price: r[0], buy: r[1], sell: r[2] })), footComplete: j.fc === 1 } : {}),
            }, false)
          } catch { /* skip a torn line */ }
        }
      }
    } catch (e) { this.lastError = `restore: ${e instanceof Error ? e.message : String(e)}` }
  }

  // ---------- live (forming) bar ----------
  /** the minute in progress as a BinanceMinute: kline running totals, overridden by the trade ladder when that ladder is complete (trades arrive faster than klines) */
  private formingMinute(symbol: string): BinanceMinute | undefined {
    const st = this.state.get(symbol)
    const kl = st?.lastKline
    if (!st || !kl) return undefined
    const nowMin = Math.floor(this.nowMs() / 60000) * 60
    if (kl.t !== nowMin || this.nowMs() - kl.atMs > 20_000) return undefined // stale kline: the minute rolled and no update came
    const f = st.forming.get(kl.t)
    const m: BinanceMinute = { time: kl.t, open: kl.o, high: kl.h, low: kl.l, close: kl.c, volume: kl.v, quoteVolume: kl.q, trades: kl.n, takerBuy: kl.V }
    if (f && f.rows.size) {
      m.foot = [...f.rows.values()].sort((a, b) => a.price - b.price)
      m.footComplete = f.complete
      if (f.complete) {
        let buy = 0, sell = 0
        for (const r of m.foot) { buy += r.buy; sell += r.sell }
        if (buy + sell >= m.volume) { m.volume = buy + sell; m.takerBuy = buy }
      }
    }
    return m
  }

  /** running bar on a timeframe; undefined when the feed has nothing fresh. LIVE ONLY. */
  now(symbol: string, tfSec: number): BinanceNow | undefined {
    const fm = this.formingMinute(symbol)
    if (!fm) return undefined
    return nowBar(this.range(symbol, Math.floor(this.nowMs() / 1000 / tfSec) * tfSec, fm.time), fm, tfSec, BINANCE_BIN[symbol] ?? 1, this.nowMs() / 1000)
  }

  /** true when the feed is connected, hearing messages and the newest closed minute is recent (<= maxAgeSec) */
  isFresh(symbol: string, maxAgeSec = 150): boolean {
    const last = this.lastClosed(symbol)
    return this.connected && this.lastMsgMs > 0 && this.nowMs() - this.lastMsgMs <= 15_000 && last > 0 && this.nowMs() / 1000 - last <= maxAgeSec
  }

  // ---------- reads ----------
  health(): BinanceHealth {
    const now = this.nowMs()
    const syms = this.symbols().map((s) => {
      const st = this.state.get(s)!
      const last = st.minutes.length ? st.minutes[st.minutes.length - 1].time : 0
      const pair = Object.keys(BINANCE_SYMBOLS).find((k) => BINANCE_SYMBOLS[k] === s) ?? s
      return {
        symbol: s, pair, minutesHeld: st.minutes.length, lastClosed: last,
        lastClosedAgoSec: last ? Math.round(now / 1000 - last) : null,
        footMinutes: st.minutes.filter((m) => m.footComplete).length,
        lastTradeAgoSec: st.lastTradeMs ? Math.round((now - st.lastTradeMs) / 1000) : null,
      }
    })
    const stale = !this.connected || !this.lastMsgMs || now - this.lastMsgMs > 15_000
    return {
      enabled: this.enabled, connected: this.connected, stale, reconnects: this.reconnects,
      lastMessageAgoSec: this.lastMsgMs ? Math.round((now - this.lastMsgMs) / 1000) : null,
      lastError: this.lastError, restUrl: this.restUrl, wsUrl: this.wsUrl,
      symbols: syms, recorder: { on: this.recorderOn && this.enabled, dir: this.dir, written: this.written, snapshots: this.snapWritten },
    }
  }
}

let active: BinanceFeed | null = null
export function getBinanceFeed(): BinanceFeed | null { return active }
/**
 * A candle-close handler runs the instant IQ's candle closes; Binance's closed minute can land a moment later. Wait (up to maxMs) until the
 * Binance minute that ends this candle is in, so a strategy never reads the bar before its volume exists. false = it did not arrive in time (skip the bar).
 * A pair without a Binance market returns true (nothing to wait for).
 */
export async function binanceSettle(asset: string, tf: string, barTimeSec: number, maxMs = 3000): Promise<boolean> {
  const sym = binanceSymbolFor(asset)
  if (!sym) return true
  const feed = active
  if (!feed) return false
  const need = barTimeSec + (TF_SEC[tf] ?? 60) - 60
  const t0 = Date.now()
  while (feed.lastClosed(sym) < need) {
    if (Date.now() - t0 >= maxMs) return false
    await new Promise((r) => setTimeout(r, 100))
  }
  return true
}

/** test seam: point the module at a feed built in a test */
export function setActiveBinanceFeed(f: BinanceFeed | null): void { active = f }

/**
 * Fail-closed gate for a strategy that asked for Binance data (dataSource volume / binance): null = fine, otherwise the reason it must not trade.
 * A pair with no Binance market, a missing/disconnected feed or a stale feed all stop the evaluation, so a "binance" strategy can never silently run on IQ candles.
 */
export function binanceDataBlock(asset: string): string | null {
  const sym = binanceSymbolFor(asset)
  if (!sym) return `dataSource needs a pair with a Binance market (BTCUSD, ETHUSD); ${asset} has none`
  const feed = active
  if (!feed) return 'the Binance feed is not running'
  if (!feed.isFresh(sym)) return 'the Binance feed is stale or disconnected - not trading on old data'
  return null
}

/** run `fn` with binance.* reads pointed at this asset's Binance symbol (null reader when the pair has no Binance market or the feed is off) */
export function binanceReaderScope<T>(asset: string, fn: () => T): T {
  const feed = active
  const sym = binanceSymbolFor(asset)
  setBinanceReader(feed && sym ? { asset, at: (t, tfSec) => aggAt(feed, sym, t, tfSec), now: (tfSec) => feed.now(sym, tfSec) } : null)
  try { return fn() } finally { setBinanceReader(null) }
}

export const binanceFeedPlugin: Plugin = {
  name: 'binance-feed',
  start(ctx) {
    const feed = new BinanceFeed()
    active = feed
    ctx.provide('binance', feed)
    try {
      const market = ctx.use<{ getCandles(a: string, tf: string, n: number, closedOnly?: boolean): { time: number; open: number; high: number; low: number; close: number }[]; setCandleOverlay?: unknown }>('market')
      feed.iqMinute = (pair, t) => market.getCandles(pair, '1m', 5, true).find((c) => c.time === t)
    } catch { /* market not up yet: the recorder just omits the IQ side */ }
    try {
      const market = ctx.use<{ setCandleOverlay(fn: (asset: string, tf: string, candles: Candle[], limit: number, closedOnly: boolean, mode: 'volume' | 'binance') => Candle[] | null): void }>('market')
      market.setCandleOverlay((asset, tf, candles, limit, closedOnly, mode) => {
        const sym = binanceSymbolFor(asset)
        if (!sym || !feed.lastClosed(sym)) return null // not a Binance pair / no data yet: fall back to IQ's own candles
        if (mode === 'volume') return overlayVolume(candles, tf, sym, feed)
        const out = binanceCandles(tf, sym, feed, limit, closedOnly, Math.floor(Date.now() / 1000))
        return out.length ? out : null
      })
    } catch { /* no market service */ }
    feed.start()
  },
  stop() {
    active?.stop()
    active = null
  },
}
