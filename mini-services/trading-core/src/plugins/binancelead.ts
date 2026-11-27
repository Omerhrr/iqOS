// IQAIR//OS - live Binance vs IQ Option lead/lag monitor (BTCUSD, ETHUSD).
//
// Keeps a 100 ms price ring for each side:
//   Binance  every aggTrade price from the feed (arrival time on this machine)
//   IQ       the sidecar's 100 ms sampled quote (/tick_stats), polled about once a second while the live IQ session is up
// and from them
//   - re-estimates who leads and by how much every 30 s over the last 10 minutes (analytics/binancelead.ts) and keeps the recent estimates, so the
//     tab can show whether the lead is STABLE or just a lucky window;
//   - tracks the live gap: how far Binance is above/below IQ after removing the usual ratio between them (the median of the last 5 minutes);
//   - records both tick streams to data/binance/ticks-YYYY-MM-DD.jsonl (when the Binance recorder is on) so the edge can be tested later on real days.
// binance.gap() / leadMs() / leadCorr() / leadStable() / leadOk() in MSL read the live view; they refuse to run in a backtest.
//
// Honest limits: IQ points are the sidecar's 100 ms samples of IQ's stream (a coarser or delayed view than the broker's internal price), Binance is
// a different market with its own basis to IQ's quote, and a lag only matters if your order lands on IQ before IQ's price has caught up.
import { appendFileSync, existsSync, mkdirSync, readdirSync, readFileSync, unlinkSync } from 'node:fs'
import { join } from 'node:path'
import type { Plugin } from '../kernel'
import { BINANCE_SYMBOLS } from '../analytics/binancedata'
import { analyzeGapEdge, estimateLag, gapBpsNow, type EdgeOpts, type LagResult, type Pt } from '../analytics/binancelead'
import { getBinanceFeed, setActiveLeadSource, type BinanceFeed, type LeadViewLite } from './binancefeed'

const BUCKET_MS = 100
const RING = 36_000            // one hour of 100 ms buckets
const EST_WINDOW_MS = 600_000
const EST_EVERY_MS = 30_000
const FLUSH_EVERY_MS = 10_000
const RATIO_KEEP = 900
const HIST_KEEP = 40
const TICK_KEEP_DAYS = 7
const MIN_CORR = 0.08

interface Est { t: number; lagMs: number; corr: number; leader: LagResult['leader'] }
interface PairState {
  bin: Pt[]; iq: Pt[]; ratios: number[]
  lastIqT: number; iqOkAt: number; iqPolls: number; iqFails: number; iqPts: number
  est: LagResult | null; estAt: number; hist: Est[]
  binLatSum: number; binLatN: number
}
export interface LeadView extends LeadViewLite {
  pair: string
  binAgeSec: number | null
  iqAgeSec: number | null
  iqPollAgeSec: number | null
  note: string
}
export interface LeadStatus {
  running: boolean
  iqLive: boolean
  recording: boolean
  pairs: (LeadView & { binTicks: number; iqTicks: number; iqTicksPerMin: number; recvLatencyMs: number | null; history: Est[]; curve: { lagMs: number; corr: number }[]; n: number })[]
}

export class LeadMonitor {
  private st = new Map<string, PairState>()
  private pending: string[] = []
  private timers: ReturnType<typeof setInterval>[] = []
  private polling = false
  private lastFlush = 0
  private lastDay = ''
  nowMs: () => number = () => Date.now()
  /** fetch IQ's 100 ms quotes for a pair; null = IQ is not live */
  getIq: ((pair: string) => Promise<Pt[] | null>) | null = null
  iqLive = false
  recorderOn: () => boolean = () => false
  readonly dir: string

  constructor(dir: string, readonly pairs: string[] = Object.keys(BINANCE_SYMBOLS)) {
    this.dir = dir
    for (const p of pairs) this.st.set(p, { bin: [], iq: [], ratios: [], lastIqT: 0, iqOkAt: 0, iqPolls: 0, iqFails: 0, iqPts: 0, est: null, estAt: 0, hist: [], binLatSum: 0, binLatN: 0 })
  }

  pairOfSymbol(sym: string): string | undefined { return this.pairs.find((p) => BINANCE_SYMBOLS[p] === sym) }

  ingestBin(pair: string, ms: number, price: number, tradeMs?: number): void {
    const s = this.st.get(pair)
    if (!s || !(price > 0)) return
    const b = Math.floor(ms / BUCKET_MS) * BUCKET_MS
    const last = s.bin[s.bin.length - 1]
    if (last && last.t === b) last.p = price
    else {
      if (last) this.pending.push(JSON.stringify({ k: 'b', y: pair, t: last.t, p: last.p }))
      s.bin.push({ t: b, p: price })
      if (s.bin.length > RING) s.bin.splice(0, s.bin.length - RING)
    }
    if (tradeMs) { const d = ms - tradeMs; if (d > -5000 && d < 5000) { s.binLatSum += d; s.binLatN++; if (s.binLatN > 2000) { s.binLatSum /= 2; s.binLatN /= 2 } } }
  }

  ingestIq(pair: string, pts: Pt[], nowMs = this.nowMs()): void {
    const s = this.st.get(pair)
    if (!s) return
    s.iqOkAt = nowMs; s.iqPolls++
    for (const q of pts) {
      if (q.t <= s.lastIqT || !(q.p > 0)) continue
      s.lastIqT = q.t
      const last = s.iq[s.iq.length - 1]
      if (last && last.p === q.p) continue
      s.iq.push({ t: q.t, p: q.p }); s.iqPts++
      this.pending.push(JSON.stringify({ k: 'i', y: pair, t: q.t, p: q.p }))
    }
    if (s.iq.length > RING) s.iq.splice(0, s.iq.length - RING)
  }

  /** one-second step: sample the Binance/IQ price ratio (the usual level the gap is measured against) */
  sample(nowMs = this.nowMs()): void {
    for (const s of this.st.values()) {
      const b = s.bin[s.bin.length - 1], q = s.iq[s.iq.length - 1]
      if (!b || !q || nowMs - b.t > 3000 || nowMs - s.iqOkAt > 5000) continue
      s.ratios.push(b.p / q.p)
      if (s.ratios.length > RATIO_KEEP) s.ratios.splice(0, s.ratios.length - RATIO_KEEP)
    }
  }

  estimate(nowMs = this.nowMs()): void {
    for (const [pair, s] of this.st) {
      const t0 = nowMs - EST_WINDOW_MS
      const bin = s.bin.filter((x) => x.t >= t0 - 1000), iq = s.iq.filter((x) => x.t >= t0 - 60_000)
      const r = estimateLag(bin, iq, t0, nowMs, { minCorr: MIN_CORR })
      s.est = r; s.estAt = nowMs
      if (r.ok) { s.hist.push({ t: nowMs, lagMs: r.lagMs, corr: r.corr, leader: r.leader }); if (s.hist.length > HIST_KEEP) s.hist.shift() }
      void pair
    }
  }

  view(pair: string, nowMs = this.nowMs()): LeadView | undefined {
    const s = this.st.get(pair)
    if (!s) return undefined
    const b = s.bin[s.bin.length - 1], q = s.iq[s.iq.length - 1]
    const binAge = b ? (nowMs - b.t) / 1000 : null
    const iqPollAge = s.iqOkAt ? (nowMs - s.iqOkAt) / 1000 : null
    const iqAge = q ? (nowMs - q.t) / 1000 : null
    const fresh = !!b && !!q && binAge! <= 3 && iqPollAge !== null && iqPollAge <= 5
    const gap = fresh ? gapBpsNow(b!.p, q!.p, s.ratios) : null
    const est = s.est
    const recent = s.hist.slice(-20)
    const stable = recent.length ? recent.filter((h) => h.leader === 'binance').length / recent.length : 0
    const leader = est?.leader ?? 'none'
    const ok = fresh && gap !== null && !!est && est.ok && leader === 'binance' && est.corr >= MIN_CORR
    let note = est?.note ?? 'no estimate yet (needs a few minutes of both streams)'
    if (!this.iqLive) note = 'IQ is not live: the lead/lag needs the live IQ session (sim mode has no real IQ ticks)'
    else if (!fresh) note = 'one of the two price streams is stale right now'
    return { pair, leader, lagMs: est?.lagMs ?? 0, corr: est?.corr ?? 0, stable, gapBps: gap ?? 0, fresh: fresh && gap !== null, ok, binAgeSec: binAge, iqAgeSec: iqAge, iqPollAgeSec: iqPollAge, note }
  }

  status(nowMs = this.nowMs()): LeadStatus {
    const pairs = this.pairs.map((p) => {
      const s = this.st.get(p)!
      const v = this.view(p, nowMs)!
      const spanMin = s.iq.length > 1 ? Math.max(1, (s.iq[s.iq.length - 1].t - s.iq[0].t) / 60000) : 1
      return { ...v, binTicks: s.bin.length, iqTicks: s.iq.length, iqTicksPerMin: Math.round(s.iq.length / spanMin), recvLatencyMs: s.binLatN ? Math.round(s.binLatSum / s.binLatN) : null, history: s.hist, curve: s.est?.curve ?? [], n: s.est?.n ?? 0 }
    })
    return { running: this.timers.length > 0, iqLive: this.iqLive, recording: this.recorderOn(), pairs }
  }

  // ---------- recording ----------
  flush(nowMs = this.nowMs()): void {
    if (!this.pending.length) return
    if (!this.recorderOn()) { this.pending.length = 0; return }
    try {
      mkdirSync(this.dir, { recursive: true })
      const day = new Date(nowMs).toISOString().slice(0, 10)
      appendFileSync(join(this.dir, `ticks-${day}.jsonl`), this.pending.join('\n') + '\n')
      this.pending.length = 0
      if (day !== this.lastDay) {
        this.lastDay = day
        const cutoff = new Date(nowMs - TICK_KEEP_DAYS * 86400_000).toISOString().slice(0, 10)
        for (const f of readdirSync(this.dir)) if (/^ticks-\d{4}-\d{2}-\d{2}\.jsonl$/.test(f) && f.slice(6, 16) < cutoff) unlinkSync(join(this.dir, f))
      }
    } catch { this.pending.length = 0 }
  }

  // ---------- running ----------
  private async pollIq(): Promise<void> {
    if (this.polling || !this.getIq) return
    this.polling = true
    try {
      let any = false
      for (const p of this.pairs) {
        const pts = await this.getIq(p)
        const s = this.st.get(p)!
        if (pts) { this.ingestIq(p, pts); any = true } else s.iqFails++
      }
      this.iqLive = any
    } catch { this.iqLive = false } finally { this.polling = false }
  }

  start(pollMs = 1000): void {
    if (this.timers.length) return
    this.timers.push(setInterval(() => { void this.pollIq().then(() => this.sample()); const n = this.nowMs(); if (n - this.lastFlush >= FLUSH_EVERY_MS) { this.lastFlush = n; this.flush(n) } }, pollMs))
    this.timers.push(setInterval(() => this.estimate(), EST_EVERY_MS))
  }
  stop(): void { for (const t of this.timers) clearInterval(t); this.timers = []; this.flush() }
}

// ---------- recorded ticks -> offline analysis ----------
export function loadTicks(dir: string, pair: string, from?: string, to?: string): { bin: Pt[]; iq: Pt[]; files: string[] } {
  const bin: Pt[] = [], iq: Pt[] = [], files: string[] = []
  if (!existsSync(dir)) return { bin, iq, files }
  for (const f of readdirSync(dir).filter((x) => /^ticks-\d{4}-\d{2}-\d{2}\.jsonl$/.test(x)).sort()) {
    const day = f.slice(6, 16)
    if ((from && day < from) || (to && day > to)) continue
    files.push(f)
    for (const line of readFileSync(join(dir, f), 'utf8').split('\n')) {
      if (!line) continue
      try {
        const o = JSON.parse(line) as { k: string; y: string; t: number; p: number }
        if (o.y !== pair || !(o.p > 0) || !Number.isFinite(o.t)) continue
        ;(o.k === 'b' ? bin : iq).push({ t: o.t, p: o.p })
      } catch { /* torn line */ }
    }
  }
  bin.sort((a, b) => a.t - b.t); iq.sort((a, b) => a.t - b.t)
  return { bin, iq, files }
}

export interface LeadReportReq { pair?: string; from?: string; to?: string; delayMs?: number; payout?: number; thresholdsBps?: number[]; horizonsSec?: number[] }
export function leadReport(dir: string, req: LeadReportReq) {
  const pair = (req.pair ?? 'BTCUSD').toUpperCase()
  const { bin, iq, files } = loadTicks(dir, pair, req.from, req.to)
  const base = { pair, files: files.length, binTicks: bin.length, iqTicks: iq.length }
  if (bin.length < 200 || iq.length < 200) return { ok: false as const, error: 'not enough recorded ticks for this pair yet: keep the Binance recorder on while the live IQ session is connected', ...base }
  // lag per hour of recorded data, then overall
  const t0 = Math.max(bin[0].t, iq[0].t), t1 = Math.min(bin[bin.length - 1].t, iq[iq.length - 1].t)
  const hours: { from: number; to: number; lagMs: number; corr: number; leader: string; n: number }[] = []
  for (let a = t0; a + 3600_000 <= t1 + 1; a += 3600_000) {
    const r = estimateLag(bin.filter((x) => x.t >= a - 1000 && x.t <= a + 3600_000), iq.filter((x) => x.t >= a - 60_000 && x.t <= a + 3600_000), a, a + 3600_000, { minCorr: MIN_CORR })
    if (r.ok) hours.push({ from: a, to: a + 3600_000, lagMs: r.lagMs, corr: r.corr, leader: r.leader, n: r.n })
  }
  const overall = estimateLag(bin, iq, t0, t1, { minCorr: MIN_CORR })
  const opts: EdgeOpts = { delayMs: req.delayMs, payout: req.payout, thresholdsBps: req.thresholdsBps, horizonsSec: req.horizonsSec }
  const edge = analyzeGapEdge(bin, iq, opts)
  return { ok: true as const, ...base, spanSec: Math.round((t1 - t0) / 1000), overall: { lagMs: overall.lagMs, corr: overall.corr, leader: overall.leader, n: overall.n, note: overall.note, curve: overall.curve }, hours, edge }
}

let active: LeadMonitor | null = null
export function getLeadMonitor(): LeadMonitor | null { return active }

export const binanceLeadPlugin: Plugin = {
  name: 'binance-lead',
  start(ctx) {
    const feed = getBinanceFeed() as BinanceFeed | null
    if (!feed) return
    const mon = new LeadMonitor(feed.recordedDir())
    mon.recorderOn = () => feed.recorderIsOn()
    feed.onPrice = (sym, ms, price) => { const pair = mon.pairOfSymbol(sym); if (pair) mon.ingestBin(pair, ms, price) }
    try {
      const market = ctx.use<{ liveTickPoints(a: string): Promise<Pt[] | null> }>('market')
      mon.getIq = (pair) => market.liveTickPoints(pair)
    } catch { /* no market service: the monitor just never sees IQ */ }
    active = mon
    ctx.provide('binanceLead', mon)
    setActiveLeadSource({ view: (pair) => mon.view(pair) })
    mon.start(Number(process.env.BINANCE_LEAD_IQ_POLL_MS) > 200 ? Number(process.env.BINANCE_LEAD_IQ_POLL_MS) : 1000)
  },
  stop() {
    active?.stop()
    const f = getBinanceFeed() as BinanceFeed | null
    if (f) f.onPrice = null
    setActiveLeadSource(null)
    active = null
  },
}
