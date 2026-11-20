// IQAIR//OS - CHESS: the market as a board of competing forces, read for POSITION, TACTICS and a few moves of LOOK-AHEAD instead of the last candle.
// The pieces are hypotheses (a mental model), not equivalences:
//   pawn   = small individual moves (bars under 0.6 ATR): the pawn structure is their drift
//   knight = sudden nonlinear jumps (a 1.8+ ATR bar or a gap), and a FORK when one jump takes out two levels at once
//   bishop = momentum that runs diagonally across the structure (persistent, progressing slope)
//   rook   = a strong directional leg (efficient, 3+ ATR)
//   queen  = the dominant force right now: whichever of the above is strongest, and which side it serves
//   king   = capital preservation: how much room the position leaves before the invalidation level
// POSITION: material (the pieces) + structure + king safety + MOBILITY (free squares: ATR of room each side has before meeting a level that has held) -> one evaluation, -1 (sellers) .. +1 (buyers).
// TACTICS (stage-aware, so they can be seen BEFORE the final move): trap (a failed break of a level that sellers/buyers absorbed), mating net (lower highs, support breaks, the recovery of the broken level fails),
//   fork (one jump through two levels), sacrifice (a wick-run beyond a swing that closes back inside). Each is run over the pair's own history so its hit rate and count come with it.
// LOOK-AHEAD: a small expectimax. Plies: which level is reached first (analog odds from nm, else gambler's-ruin), then at the level either TAKE the move or HOLD for the next level using how often that
//   level has held. Actions: CALL, PUT, WAIT (EV 0). EV is in R (reward over the stop at the invalidation level).
// HONESTY: the piece mapping and weights are judgement. The tree is only as good as its probabilities (analog counts or a random walk). The market has no fixed board, no fixed players and no single opponent:
//   a "checkmate" here is a statistically favourable setup, never a guarantee. reportChess() measures each tactic against a baseline before you trust it.

import { features, type F } from './dao'
import { readNextMove, type NmResult } from './nextmove'
import type { CeCandle } from './causeeffect'

export interface ChessOptions { horizon?: number; otc?: boolean; light?: boolean }
const clamp = (x: number, a: number, b: number) => Math.max(a, Math.min(b, x))
const sg = (x: number) => (x > 0 ? 1 : x < 0 ? -1 : 0)
const shrink = (hit: number, n: number, k = 10) => (hit + 0.5 * k) / (n + k)
const MIN = 150

interface Piv { idx: number; price: number; hi: boolean; conf: number }
function pivots(c: CeCandle[]): Piv[] {
  const n = c.length, out: Piv[] = []
  for (let i = 2; i < n - 2; i++) {
    if (c[i].high > c[i - 1].high && c[i].high > c[i - 2].high && c[i].high >= c[i + 1].high && c[i].high >= c[i + 2].high) out.push({ idx: i, price: c[i].high, hi: true, conf: i + 2 })
    if (c[i].low < c[i - 1].low && c[i].low < c[i - 2].low && c[i].low <= c[i + 1].low && c[i].low <= c[i + 2].low) out.push({ idx: i, price: c[i].low, hi: false, conf: i + 2 })
  }
  return out
}
/** confirmed pivots up to bar i, newest last */
const upTo = (pv: Piv[], i: number) => { let k = pv.length; while (k > 0 && pv[k - 1].conf > i) k--; return pv.slice(0, k) }

export type ChessTacticName = 'trap' | 'mating-net' | 'fork' | 'sacrifice'
export interface ChessTactic { name: ChessTacticName; dir: 'call' | 'put'; stage: string; level: number; barsAgo: number; note: string }

/** All tactics visible at bar i (only bars <= i and pivots confirmed <= i). */
export function detectTactics(c: CeCandle[], f: F, pv: Piv[], i: number): ChessTactic[] {
  const out: ChessTactic[] = [], a = f.atr[i]
  if (!(a > 0) || i < 60) return out
  const P = upTo(pv, i).filter((p) => p.idx >= i - 80)
  const highs = P.filter((p) => p.hi), lows = P.filter((p) => !p.hi)
  // ---- trap: a break of a swing level that failed and was absorbed ----
  const trapFor = (hiSide: boolean) => {
    const lv = (hiSide ? highs : lows).filter((p) => p.idx <= i - 4)
    for (let q = lv.length - 1; q >= 0 && q >= lv.length - 4; q--) {
      const L = lv[q].price
      for (let k = 0; k <= 6; k++) {
        const j = i - k, b = c[j]
        const attempt = hiSide ? b.high > L + 0.05 * a && b.close <= L : b.low < L - 0.05 * a && b.close >= L
        if (!attempt) continue
        const back = hiSide ? c[i].close < L - 0.1 * a : c[i].close > L + 0.1 * a
        if (!back) continue
        const confirm = hiSide ? c[i].close < L - 0.3 * a : c[i].close > L + 0.3 * a
        out.push({ name: 'trap', dir: hiSide ? 'put' : 'call', stage: confirm ? 'confirmed' : 'rejection', level: L, barsAgo: k, note: hiSide ? `buyers pushed through ${L} and failed; sellers absorbed it${confirm ? ' and took control' : ''}` : `sellers pushed through ${L} and failed; buyers absorbed it${confirm ? ' and took control' : ''}` })
        return
      }
    }
  }
  trapFor(true); trapFor(false)
  // ---- mating net: lower highs -> support breaks -> recovery of it fails (mirror for longs) ----
  const netFor = (short: boolean) => {
    const side = (short ? highs : lows).slice(-3), opp = (short ? lows : highs).filter((p) => p.idx <= i - 6)
    if (side.length < 2 || !opp.length) return
    const progressing = short ? side[side.length - 1].price < side[side.length - 2].price - 0.05 * a : side[side.length - 1].price > side[side.length - 2].price + 0.05 * a
    if (!progressing) return
    const S = opp[opp.length - 1].price // the level the net presses on
    let brokeAt = -1
    for (let k = 7; k >= 0; k--) { const j = i - k; if (short ? c[j].close < S - 0.3 * a : c[j].close > S + 0.3 * a) { brokeAt = k; break } }
    if (brokeAt < 0) { out.push({ name: 'mating-net', dir: short ? 'put' : 'call', stage: 'net-forming', level: S, barsAgo: 0, note: short ? `buyers keep failing (lower highs) pressing ${S}` : `sellers keep failing (higher lows) pressing ${S}` }); return }
    let failed = false
    for (let k = brokeAt - 1; k >= 0; k--) { const j = i - k; if (short ? c[j].high >= S - 0.25 * a && c[j].close < S - 0.05 * a : c[j].low <= S + 0.25 * a && c[j].close > S + 0.05 * a) { failed = true; break } }
    out.push({ name: 'mating-net', dir: short ? 'put' : 'call', stage: failed ? 'recovery-failed' : 'broken', level: S, barsAgo: brokeAt, note: short ? `support ${S} broke${failed ? ' and the attempt to recover it failed' : ''}` : `resistance ${S} broke${failed ? ' and the attempt to lose it failed' : ''}` })
  }
  netFor(true); netFor(false)
  // ---- fork: one jump through two swing levels ----
  for (let k = 0; k <= 2; k++) {
    const j = i - k, b = c[j], body = (b.close - b.open) / f.atr[j]
    if (Math.abs(body) < 1.8) continue
    const before = upTo(pv, j - 1)
    const lv = (body > 0 ? before.filter((p) => p.hi) : before.filter((p) => !p.hi)).slice(-4).filter((p) => (body > 0 ? p.price < b.close && p.price > b.open - 0.2 * f.atr[j] : p.price > b.close && p.price < b.open + 0.2 * f.atr[j]))
    if (lv.length >= 2) out.push({ name: 'fork', dir: body > 0 ? 'call' : 'put', stage: k === 0 ? 'just-played' : 'recent', level: lv[lv.length - 1].price, barsAgo: k, note: `one ${body > 0 ? 'up' : 'down'} jump of ${Math.abs(body).toFixed(1)} ATR took out ${lv.length} levels` })
  }
  // ---- sacrifice: a wick-run beyond a swing extreme that closes back inside ----
  for (let k = 0; k <= 2; k++) {
    const j = i - k, b = c[j], rng = b.high - b.low; if (!(rng > 0)) continue
    const before = upTo(pv, j - 1)
    const sh = before.filter((p) => p.hi).slice(-1)[0], sl = before.filter((p) => !p.hi).slice(-1)[0]
    if (sh && b.high > sh.price + 0.3 * f.atr[j] && b.close < sh.price && (b.high - Math.max(b.open, b.close)) / rng >= 0.6) out.push({ name: 'sacrifice', dir: 'put', stage: k === 0 ? 'just-played' : 'recent', level: sh.price, barsAgo: k, note: `a stop-run above ${sh.price} was given up (long upper wick, closed back inside)` })
    else if (sl && b.low < sl.price - 0.3 * f.atr[j] && b.close > sl.price && (Math.min(b.open, b.close) - b.low) / rng >= 0.6) out.push({ name: 'sacrifice', dir: 'call', stage: k === 0 ? 'just-played' : 'recent', level: sl.price, barsAgo: k, note: `a stop-run below ${sl.price} was given up (long lower wick, closed back inside)` })
  }
  return out
}

/** did price travel +1 ATR in `dir` before -1 ATR within 10 bars of bar i (from its close)? null when unresolved */
const firstPassage = (c: CeCandle[], a: number, i: number, dir: 'call' | 'put'): boolean | null => {
  const base = c[i].close, up = base + a, dn = base - a
  for (let k = 1; k <= 10 && i + k < c.length; k++) { const b = c[i + k], u = b.high >= up, d = b.low <= dn; if (u && d) return null; if (u) return dir === 'call'; if (d) return dir === 'put' }
  return null
}

export interface ChessResult {
  ok: boolean; error?: string
  pieces: { pawnPush: number; pawnCount: number; knight: number; knightBarsAgo: number; bishop: number; rook: number; queen: string; queenSide: number; kingLong: number; kingShort: number }
  position: { eval: number; label: string; mobBuy: number; mobSell: number; control: 'buyers' | 'sellers' | 'contested'; rank: number; tempo: number }
  tactics: (ChessTactic & { hitRate: number; hitN: number; baseRate: number })[]
  mate: { mated: 'buyers' | 'sellers' | 'none'; stage: string; mate: boolean }
  think: { best: 'call' | 'put' | 'wait'; bestEv: number; callEv: number; putEv: number; waitEv: number; evidence: 'analog' | 'random-walk'; line: string; pu: number; pd: number; pn: number }
  verdict: { dir: 'call' | 'put' | 'none'; strength: number; reasons: string[]; blocks: string[] }
  lines: string[]
  text: string
}

interface Lv { p: number; touches: number }
function levelsAt(c: CeCandle[], pv: Piv[], i: number, a: number): Lv[] {
  const P = upTo(pv, i).filter((p) => p.idx >= i - 250), out: Lv[] = []
  for (const x of [...P].sort((p, q) => p.price - q.price)) { const l = out[out.length - 1]; if (l && Math.abs(x.price - l.p) <= 0.25 * a) { l.p = (l.p * l.touches + x.price) / (l.touches + 1); l.touches++ } else out.push({ p: x.price, touches: 1 }) }
  return out
}
/** how often price HELD (was rejected at) a level after touching it, over the recent bars */
function heldRate(c: CeCandle[], f: F, L: number, side: 'res' | 'sup', upto: number): { hold: number; n: number } {
  let held = 0, n = 0
  for (let i = Math.max(110, upto - 400); i < upto - 3; i++) {
    const a = f.atr[i]; if (!(a > 0)) continue
    const touch = side === 'res' ? c[i].high >= L - 0.2 * a && c[i].high <= L + 0.4 * a && c[i].close < L : c[i].low <= L + 0.2 * a && c[i].low >= L - 0.4 * a && c[i].close > L
    if (!touch) continue
    n++; const g = c[i + 3].close; if (side === 'res' ? g < L - 0.3 * a : g > L + 0.3 * a) held++
    i += 2
  }
  return { hold: n ? shrink(held, n, 4) : 0.5, n }
}

export function readChess(candles: CeCandle[], opts: ChessOptions = {}): ChessResult {
  const H = Math.max(2, Math.min(30, Math.round(opts.horizon ?? 5)))
  const c = candles.filter((x) => x && [x.time, x.open, x.high, x.low, x.close].every((v) => Number.isFinite(v))).slice(-1600)
  const fail = (error: string): ChessResult => ({ ok: false, error, pieces: {} as never, position: {} as never, tactics: [], mate: { mated: 'none', stage: '', mate: false }, think: { best: 'wait', bestEv: 0, callEv: 0, putEv: 0, waitEv: 0, evidence: 'random-walk', line: error, pu: 0.5, pd: 0.5, pn: 0 }, verdict: { dir: 'none', strength: 0, reasons: [], blocks: [error] }, lines: [error], text: error })
  if (c.length < MIN) return fail(`needs ${MIN} closed bars, have ${c.length}`)
  const f = features(c), n = f.n, t = n - 1, a = f.atr[t], px = c[t].close
  if (!(a > 0)) return fail('ATR not ready')
  const pv = pivots(c)
  // ---- pieces ----
  let ps = 0, pc = 0
  for (let k = t - 19; k <= t; k++) { if (Math.abs(c[k].close - c[k].open) < 0.6 * f.atr[k] && c[k].high - c[k].low < 0.8 * f.atr[k]) { pc++; ps += (c[k].close - c[k].open) / f.atr[k] } }
  const pawnPush = clamp(ps / 2, -1, 1)
  let knight = 0, knightAgo = 99
  for (let k = 0; k <= 15; k++) { const j = t - k, body = (c[j].close - c[j].open) / f.atr[j], gap = (c[j].open - c[j - 1].close) / f.atr[j]; const jump = Math.abs(body) >= 1.8 ? body : Math.abs(gap) >= 1 ? gap : 0; if (jump) { knight = clamp(jump / 3, -1, 1); knightAgo = k; break } }
  const roc = f.roc[t], bishop = clamp(roc / 4, -1, 1) * clamp((f.persist[t] - 0.4) / 0.4, 0, 1), rook = f.er[t] > 0.5 && Math.abs(roc) >= 3 ? sg(roc) * Math.min(1, Math.abs(roc) / 6) : 0
  const push = clamp(f.push[t] * 1.5, -1, 1)
  const cand: [string, number][] = [['pawn', pawnPush * 0.6], ['knight', knight * (knightAgo <= 3 ? 1 : 0.4)], ['bishop', bishop], ['rook', rook], ['pressure', push]]
  const top = cand.reduce((x, y) => (Math.abs(y[1]) > Math.abs(x[1]) ? y : x))
  const queen = Math.abs(top[1]) < 0.15 ? 'none' : top[0] === 'pressure' ? 'order-flow' : top[0]
  // ---- levels, mobility, king ----
  const lv = levelsAt(c, pv, t, a).filter((l) => l.touches >= 2 || true)
  const aboveL = lv.filter((l) => l.p > px + 0.15 * a).sort((x, y) => x.p - y.p), belowL = lv.filter((l) => l.p < px - 0.15 * a).sort((x, y) => y.p - x.p)
  const u1 = aboveL[0], u2 = aboveL[1], d1 = belowL[0], d2 = belowL[1]
  const upD = u1 ? (u1.p - px) / a : 3, dnD = d1 ? (px - d1.p) / a : 3
  const hu1 = u1 ? heldRate(c, f, u1.p, 'res', t) : { hold: 0.5, n: 0 }, hd1 = d1 ? heldRate(c, f, d1.p, 'sup', t) : { hold: 0.5, n: 0 }
  // mobility: ATR of free room until a level that has HELD more often than not (a wall), capped at 3
  const wallUp = aboveL.find((l) => heldRate(c, f, l.p, 'res', t).hold >= 0.5), wallDn = belowL.find((l) => heldRate(c, f, l.p, 'sup', t).hold >= 0.5)
  const mobBuy = clamp(wallUp ? (wallUp.p - px) / a : 3, 0, 3), mobSell = clamp(wallDn ? (px - wallDn.p) / a : 3, 0, 3)
  const kingLong = clamp(dnD / 2, 0, 1), kingShort = clamp(upD / 2, 0, 1)
  // ---- position ----
  let hh = -Infinity, ll = Infinity; for (let k = Math.max(0, n - 100); k < n; k++) { hh = Math.max(hh, f.hi[k]); ll = Math.min(ll, f.lo[k]) }
  const rp = hh > ll ? (px - ll) / (hh - ll) : 0.5, rank = Math.min(8, Math.max(1, Math.floor(rp * 8) + 1))
  let tempo = 0; for (let k = 0; k < 8; k++) { const i = t - k, j = i - 4; if (f.push[i] > 0.15 && f.push[j] < -0.15) { tempo = 1; break } if (f.push[i] < -0.15 && f.push[j] > 0.15) { tempo = -1; break } }
  const material = 0.35 * push + 0.2 * rook + 0.15 * bishop + 0.1 * knight * (knightAgo <= 3 ? 1 : 0.3), structure = 0.1 * pawnPush
  const mobDiff = clamp((mobBuy - mobSell) / 3, -1, 1), kingDiff = kingLong - kingShort
  const ev = clamp(material + structure + 0.15 * mobDiff + 0.08 * kingDiff + 0.06 * tempo, -1, 1)
  const control: 'buyers' | 'sellers' | 'contested' = ev > 0.15 ? 'buyers' : ev < -0.15 ? 'sellers' : 'contested'
  const position = { eval: ev, label: control === 'buyers' ? 'buyers stand better' : control === 'sellers' ? 'sellers stand better' : 'roughly balanced', mobBuy, mobSell, control, rank, tempo }
  // ---- tactics with their own history ----
  const found = detectTactics(c, f, pv, t)
  const bases: Record<string, number> = {}
  let upN = 0, upH = 0, dnN = 0, dnH = 0
  for (let i = 110; i < n - 12; i += 2) { const r1 = firstPassage(c, f.atr[i], i, 'call'), r2 = firstPassage(c, f.atr[i], i, 'put'); if (r1 !== null) { upN++; if (r1) upH++ } if (r2 !== null) { dnN++; if (r2) dnH++ } }
  bases.call = upN ? upH / upN : 0.5; bases.put = dnN ? dnH / dnN : 0.5
  const hist: Record<string, { n: number; hit: number }> = {}
  if (found.length && !opts.light) {
    const names = new Set(found.map((x) => `${x.name}|${x.dir}|${x.stage}`))
    const start = Math.max(110, n - 900)
    for (let i = start; i < n - 12; i += 1) { for (const tc of detectTactics(c, f, pv, i)) { const key = `${tc.name}|${tc.dir}|${tc.stage}`; if (!names.has(key)) continue; const r = firstPassage(c, f.atr[i], i, tc.dir); if (r === null) continue; const h = (hist[key] ??= { n: 0, hit: 0 }); h.n++; if (r) h.hit++ } }
  }
  const tactics = found.map((x) => { const h = hist[`${x.name}|${x.dir}|${x.stage}`]; return { ...x, hitRate: h && h.n ? shrink(h.hit, h.n) : NaN, hitN: h?.n ?? 0, baseRate: bases[x.dir] } })
  // ---- mate: one side with almost no free squares while the other has room, plus a mating net ----
  const net = found.find((x) => x.name === 'mating-net')
  let mated: 'buyers' | 'sellers' | 'none' = 'none', mstage = 'none'
  if (net) { mated = net.dir === 'put' ? 'buyers' : 'sellers'; mstage = net.stage }
  const fewOptions = (mated === 'buyers' && mobBuy < 0.6 && mobSell > 1.2) || (mated === 'sellers' && mobSell < 0.6 && mobBuy > 1.2)
  const mate = { mated, stage: mstage, mate: !!net && net.stage === 'recovery-failed' && fewOptions }
  // ---- look-ahead (expectimax) ----
  let nm: NmResult | null = null
  if (!opts.light) { try { nm = readNextMove(c, { horizon: H, otc: opts.otc }) } catch { nm = null } }
  let pu: number, pd: number, pn: number, evidence: 'analog' | 'random-walk'
  if (nm?.ok && Math.abs(nm.reach.upDist - upD) < 0.51) { pu = nm.reach.pUpFirst; pd = nm.reach.pDownFirst; pn = Math.max(0, 1 - pu - pd); evidence = 'analog' }
  else { pu = dnD / (upD + dnD) * 0.75; pd = upD / (upD + dnD) * 0.75; pn = 0.25; evidence = 'random-walk' }
  const u2D = u2 ? (u2.p - px) / a : upD + 1.5, d2D = d2 ? (px - d2.p) / a : dnD + 1.5
  const callTake = upD / dnD, callHold = (1 - hu1.hold) * (u2D / dnD) + hu1.hold * 0
  const putTake = dnD / upD, putHold = (1 - hd1.hold) * (d2D / upD) + hd1.hold * 0
  const callEv = pu * Math.max(callTake, callHold) - pd * 1, putEv = pd * Math.max(putTake, putHold) - pu * 1
  const best: 'call' | 'put' | 'wait' = Math.max(callEv, putEv) < 0.15 ? 'wait' : callEv >= putEv ? 'call' : 'put'
  const fmt = (x: number) => (Math.abs(x) >= 100 ? x.toFixed(3) : x.toFixed(5))
  const line = best === 'wait' ? `No move has a clear edge: CALL ${callEv.toFixed(2)}R, PUT ${putEv.toFixed(2)}R (needs 0.15R). Doing nothing is the move.`
    : best === 'call' ? `CALL: ${(pu * 100).toFixed(0)}% price reaches ${u1 ? fmt(u1.p) : 'the level above'} (${upD.toFixed(1)} ATR) before ${d1 ? fmt(d1.p) : 'the level below'} (${dnD.toFixed(1)} ATR). There it ${callHold > callTake ? `is worth holding: the level held only ${(hu1.hold * 100).toFixed(0)}% of ${hu1.n} times, so a break runs on to ${u2 ? fmt(u2.p) : 'the next level'}` : `is best taken (+${callTake.toFixed(2)}R): it held ${(hu1.hold * 100).toFixed(0)}% of ${hu1.n} times`}.`
      : `PUT: ${(pd * 100).toFixed(0)}% price reaches ${d1 ? fmt(d1.p) : 'the level below'} (${dnD.toFixed(1)} ATR) before ${u1 ? fmt(u1.p) : 'the level above'} (${upD.toFixed(1)} ATR). There it ${putHold > putTake ? `is worth holding: the level held only ${(hd1.hold * 100).toFixed(0)}% of ${hd1.n} times, so a break runs on to ${d2 ? fmt(d2.p) : 'the next level'}` : `is best taken (+${putTake.toFixed(2)}R): it held ${(hd1.hold * 100).toFixed(0)}% of ${hd1.n} times`}.`
  const think = { best, bestEv: Math.max(callEv, putEv, 0), callEv, putEv, waitEv: 0, evidence, line, pu, pd, pn }
  // ---- verdict: think + tactics + position + king ----
  const reasons: string[] = [], blocks: string[] = []
  let dir: 'call' | 'put' | 'none' = best === 'wait' ? 'none' : best, strength = best === 'wait' ? 0 : Math.round(clamp(Math.max(callEv, putEv) * 60, 0, 70))
  if (dir !== 'none') {
    const s = dir === 'call' ? 1 : -1
    reasons.push(`look-ahead EV ${Math.max(callEv, putEv).toFixed(2)}R (${evidence})`)
    const tc = tactics.filter((x) => x.dir === dir), against = tactics.filter((x) => x.dir !== dir && x.stage !== 'net-forming')
    if (tc.length) { strength += 12 * Math.min(2, tc.length); reasons.push(`tactic with it: ${tc.map((x) => `${x.name} (${x.stage})`).join(', ')}`) }
    if (against.length) { strength -= 25; blocks.push(`a tactic against it: ${against.map((x) => `${x.name} (${x.stage})`).join(', ')}`) }
    if (s * ev > 0.15) { strength += 8; reasons.push('the position favours this side') } else if (s * ev < -0.2) { strength -= 15; blocks.push('the position favours the other side') }
    if ((s > 0 ? kingLong : kingShort) < 0.3) { strength -= 30; blocks.push('king exposed: the invalidation level is too close') }
    if (mate.mate && mate.mated === (s > 0 ? 'sellers' : 'buyers')) { strength += 15; reasons.push('the other side has run out of squares') }
    strength = Math.round(clamp(strength, 0, 100))
    if (strength < 35) { blocks.push('not enough edge once everything is counted'); dir = 'none' }
  }
  const verdict = { dir, strength: dir === 'none' ? 0 : strength, reasons, blocks }
  const f2 = (x: number, k = 2) => (Number.isFinite(x) ? x.toFixed(k) : '-'), pc2 = (x: number) => (Number.isFinite(x) ? `${(x * 100).toFixed(0)}%` : '-')
  const lines = [
    `PIECES: queen = ${queen}${queen !== 'none' ? ` (${top[1] > 0 ? 'buyers' : 'sellers'})` : ''}; pawns ${pc} small moves drifting ${f2(pawnPush)}; knight ${knightAgo <= 15 ? `jumped ${knight > 0 ? 'up' : 'down'} ${knightAgo} bar(s) ago` : 'quiet'}; bishop ${f2(bishop)}; rook ${f2(rook)}; king room: long ${f2(kingLong)}, short ${f2(kingShort)} (1 = safe).`,
    `POSITION: ${position.label} (${f2(ev)}), rank ${rank}/8 of the recent range; free squares: buyers ${f2(mobBuy, 1)} ATR, sellers ${f2(mobSell, 1)} ATR.${tempo ? ` Tempo just passed to ${tempo > 0 ? 'buyers' : 'sellers'}.` : ''}`,
    tactics.length ? `TACTICS: ${tactics.map((x) => `${x.name} -> ${x.dir.toUpperCase()} [${x.stage}] ${x.note}${x.hitN >= 10 ? ` (such setups reached +1 ATR first ${pc2(x.hitRate)} of ${x.hitN}; baseline ${pc2(x.baseRate)})` : ' (too few past cases)'}`).join(' | ')}` : 'TACTICS: none on the board right now.',
    `MATE: ${mate.mate ? `${mate.mated} are out of good squares (${mate.stage}) - a favourable ${mate.mated === 'buyers' ? 'short' : 'long'} setup, never a guarantee.` : mated !== 'none' ? `${mated} are being squeezed (${mstage}) but not mated yet.` : 'no mating net.'}`,
    `LOOK-AHEAD (${evidence}): ${line}`,
    `VERDICT: ${verdict.dir === 'none' ? 'WAIT' : verdict.dir.toUpperCase() + ' ' + verdict.strength + '/100'}${reasons.length ? ' - ' + reasons.join('; ') : ''}${blocks.length ? ' | held back by: ' + blocks.join('; ') : ''}.`,
  ]
  return { ok: true, pieces: { pawnPush, pawnCount: pc, knight, knightBarsAgo: knightAgo, bishop, rook, queen, queenSide: Math.abs(top[1]) < 0.15 ? 0 : sg(top[1]), kingLong, kingShort }, position, tactics, mate, think, verdict, lines, text: lines.join('\n') }
}

// =============================== research ===============================
export interface ChessStat { n: number; hit: number; rate: number | null }
export interface ChessReport { ok: boolean; error?: string; bars: number; baseline: { call: number; put: number }; tactics: Record<string, ChessStat & { baseline: number; lift: number | null; z: number | null; answer: string }> }
export function reportChess(candles: CeCandle[]): ChessReport {
  const c = candles.filter((x) => x && [x.time, x.open, x.high, x.low, x.close].every((v) => Number.isFinite(v)))
  if (c.length < 400) return { ok: false, error: `needs 400 closed bars, have ${c.length}`, bars: c.length, baseline: { call: 0.5, put: 0.5 }, tactics: {} }
  const f = features(c), n = f.n, pv = pivots(c)
  let un = 0, uh = 0, dn = 0, dh = 0
  const acc: Record<string, { n: number; hit: number; dir: 'call' | 'put' }> = {}
  for (let i = 110; i < n - 12; i++) {
    const r1 = firstPassage(c, f.atr[i], i, 'call'), r2 = firstPassage(c, f.atr[i], i, 'put')
    if (r1 !== null) { un++; if (r1) uh++ } if (r2 !== null) { dn++; if (r2) dh++ }
    for (const tc of detectTactics(c, f, pv, i)) { const r = firstPassage(c, f.atr[i], i, tc.dir); if (r === null) continue; const key = `${tc.name} ${tc.dir} [${tc.stage}]`; const a = (acc[key] ??= { n: 0, hit: 0, dir: tc.dir }); a.n++; if (r) a.hit++ }
  }
  const base = { call: un ? uh / un : 0.5, put: dn ? dh / dn : 0.5 }
  const out: ChessReport['tactics'] = {}
  for (const [k, a] of Object.entries(acc)) {
    const rate = a.n ? a.hit / a.n : null, b = base[a.dir], lift = rate !== null && b > 0 ? rate / b : null
    const se = Math.sqrt((b * (1 - b)) / Math.max(1, a.n)), z = rate !== null && se > 0 ? (rate - b) / se : null
    const answer = a.n < 30 || z === null || lift === null ? `Too few cases (${a.n}) to say.` : z >= 2 && lift > 1.05 ? `YES on this history: reached +1 ATR first ${(rate! * 100).toFixed(0)}% of ${a.n} vs ${(b * 100).toFixed(0)}% baseline (z ${z.toFixed(1)}).` : z <= -2 && lift < 0.95 ? `The OPPOSITE on this history: ${(rate! * 100).toFixed(0)}% of ${a.n} vs ${(b * 100).toFixed(0)}% baseline (z ${z.toFixed(1)}).` : `No clear difference: ${(rate! * 100).toFixed(0)}% of ${a.n} vs ${(b * 100).toFixed(0)}% baseline (z ${z.toFixed(1)}).`
    out[k] = { n: a.n, hit: a.hit, rate, baseline: b, lift, z, answer }
  }
  return { ok: true, bars: n, baseline: base, tactics: out }
}
