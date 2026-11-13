// IQAIR//OS - evidence helpers for the Brain Trader's AI reviewer (plugins/braintrader.ts).
//
// (This file used to hold a fixed five-reader "confluence" engine. The Brain Trader now runs a saved MSL strategy instead - the first is
// the builtin "meta:builtin-brain-fib-adaptive" - and this module only turns the Fibonacci leg into text the reviewer can read.)
// Pure: no I/O, no clock.
import type { Candle } from '../types'
import { fibSwing, fibRetr, fibExt, fibPos } from './mslfib'

export const MIN_BARS = 60

/** the leg Fibonacci is drawn on, its key levels and where price sits - or a one-line "no usable leg". */
export function fibEvidence(c: Candle[]): string {
  const sw = fibSwing(c, 150)
  if (!sw) return 'FIBONACCI: no usable leg (needs 40+ bars)'
  const f = (x: number) => x.toFixed(5)
  const pos = fibPos(sw)
  const lv = [0.236, 0.382, 0.5, 0.618, 0.786].map((r) => `${(r * 100).toFixed(1)}%=${f(fibRetr(sw, r))}`).join(' ')
  return [
    `FIBONACCI: ${sw.up ? 'UP' : 'DOWN'} leg ${f(sw.lo)} -> ${f(sw.hi)} (${sw.legBars} bars, ${(sw.diff / Math.max(sw.atr, 1e-12)).toFixed(1)} ATR), leg end ${sw.age} bar(s) ago.`,
    `Price ${f(sw.last)} sits at ${(pos * 100).toFixed(0)}% retracement (0% = the leg's end extreme, 100% = its start). Levels: ${lv}. 127.2% ext ${f(fibExt(sw, 1.272))}, 161.8% ext ${f(fibExt(sw, 1.618))}. ATR ${f(sw.atr)}.`,
  ].join('\n')
}
