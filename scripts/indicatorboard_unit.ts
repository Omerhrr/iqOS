// Full indicator board - deterministic logic unit (bun, in-process).
// Locks the contract of analytics/indicatorboard.ts (the AI trader's
// "access to ALL our indicators" seat):
//   - thin history -> ok:false warming note, ZERO lines (no fabricated votes)
//   - a 300-bar synthetic uptrend -> ok:true, every family present, each
//     line carries a finite-parsable value or an honest n/a, and the trend
//     family leans BULLISH (the board must agree with an uptrend it is shown)
//   - a zero-volume feed -> the volume family is ALL n/a (never silent zeros
//     that would read as perfectly balanced flow), other families unaffected
//   - the tally only counts real stances (bull+bear+neutral === counted)
//   - indicatorBoardLines renders one line per family + a tally header, and
//     the strings carry the [BULL|BEAR|=|n/a] marks
//   - the ADX line exists (the indicator that was missing from every signal
//     surface before this module) and discloses the DI spread
import { buildIndicatorBoard, indicatorBoardLines, BOARD_MIN_BARS } from '../mini-services/trading-core/src/analytics/indicatorboard'
import type { Candle } from '../mini-services/trading-core/src/types'

let pass = 0
let fail = 0
function ok(cond: boolean, name: string, detail = '') {
  if (cond) {
    pass++
    console.log('  ok', name)
  } else {
    fail++
    console.log('  FAIL', name, detail)
  }
}

/** Synthetic OHLCV candles: a clean multiplicative uptrend (every bar's
 * close higher than the last, tiny sin wiggle so bands/ranges have geometry),
 * configurable volume. ENDS on an up leg by construction. */
function makeCandles(n: number, volume: (i: number) => number = () => 1000): Candle[] {
  const out: Candle[] = []
  const t0 = Date.now() - n * 60_000
  for (let i = 0; i < n; i++) {
    const open = 1.1 * Math.pow(1.0008, i) + Math.sin(i / 5) * 0.0001
    const close = 1.1 * Math.pow(1.0008, i + 1) + Math.sin((i + 1) / 5) * 0.0001
    const wick = 0.0003 + (i % 11) * 0.00005
    out.push({ time: Math.floor((t0 + i * 60_000) / 1000), open, close, high: Math.max(open, close) + wick, low: Math.min(open, close) - wick, volume: volume(i) })
  }
  return out
}

function family(board: ReturnType<typeof buildIndicatorBoard>, fam: string) {
  return board.lines.filter((l) => l.family === fam)
}

// 1 - thin history: fail closed, zero lines
{
  const thin = makeCandles(BOARD_MIN_BARS - 1)
  const b = buildIndicatorBoard(thin)
  ok(!b.ok && b.lines.length === 0 && /warming up/.test(b.note), 'thin history -> ok:false warming note, zero lines', `${b.note} lines=${b.lines.length}`)
  ok(indicatorBoardLines(thin).length === 1 && /warming up/.test(indicatorBoardLines(thin)[0] ?? ''), 'thin history lines = just the warming note')
}

// 2 - full board on a 300-bar uptrend
{
  const candles = makeCandles(300)
  const b = buildIndicatorBoard(candles)
  ok(b.ok, '300-bar board is ok', b.note)
  ok(b.lines.length >= 40, `board reports the FULL suite (${b.lines.length} lines >= 40)`, String(b.lines.length))
  for (const fam of ['trend', 'momentum', 'volatility', 'volume', 'levels']) {
    ok(family(b, fam).length >= 2, `${fam} family present (${family(b, fam).length} lines)`)
  }
  const na = b.lines.filter((l) => l.stance === 'n/a')
  ok(b.lines.length - na.length >= 30, 'most indicators resolved on 300 bars (few n/a)', `n/a=${na.length}`)
  ok(b.tally.counted === b.tally.bull + b.tally.bear + b.tally.neutral, 'tally counts only real stances (bull+bear+neutral === counted)')
  // the trend family must lean bullish on an uptrend: more bull than bear
  const trendBull = family(b, 'trend').filter((l) => l.stance === 'bullish').length
  const trendBear = family(b, 'trend').filter((l) => l.stance === 'bearish').length
  ok(trendBull > trendBear, `trend family leans bullish on a rising series (${trendBull} bull vs ${trendBear} bear)`)
  // momentum should also lean bullish on the same series
  const momBull = family(b, 'momentum').filter((l) => l.stance === 'bullish').length
  const momBear = family(b, 'momentum').filter((l) => l.stance === 'bearish').length
  ok(momBull > momBear, `momentum leans bullish on a rising series (${momBull} bull vs ${momBear} bear)`)
  // every non-n/a line carries a non-empty value
  const empty = b.lines.filter((l) => l.stance !== 'n/a' && (!l.value || l.value === 'n/a'))
  ok(empty.length === 0, 'every resolved line carries a real value', JSON.stringify(empty.slice(0, 3)))
  // the ADX line exists (was missing from every signal surface before)
  const adx = b.lines.find((l) => l.name.startsWith('ADX'))
  ok(!!adx && /DI spread/.test(adx.name) && /ADX \d/.test(adx.value), 'ADX(14)+DI-spread line present with regime detail', JSON.stringify(adx))
  // SMA200 resolved at 300 bars
  const sma200 = b.lines.find((l) => l.name === 'close vs SMA200')
  ok(!!sma200 && sma200.stance !== 'n/a', 'SMA200 resolves at 300 bars (no fake n/a)')
}

// 3 - zero-volume feed: volume family all n/a, others unaffected
{
  const candles = makeCandles(300, () => 0)
  const b = buildIndicatorBoard(candles)
  ok(b.ok, 'zero-volume board still ok')
  const vol = family(b, 'volume')
  ok(vol.length >= 9 && vol.every((l) => l.stance === 'n/a' && /no volume/.test(l.detail ?? '')), 'zero-volume feed -> the whole volume family is honest n/a', JSON.stringify(vol.slice(0, 2)))
  ok(family(b, 'trend').length >= 9 && family(b, 'momentum').length >= 16, 'trend/momentum families unaffected by the volume degeneracy')
}

// 4 - desk rendering: tally header + one line per family + stance marks
{
  const lines = indicatorBoardLines(makeCandles(300))
  ok(lines.length === 6, `desk rendering = tally header + 5 family lines (got ${lines.length})`, JSON.stringify(lines.map((l) => l.slice(0, 40))))
  ok(/^vote tally: \d+ counted -> \d+ bull \/ \d+ bear \/ \d+ neutral/.test(lines[0] ?? ''), 'tally header leads with the vote balance', lines[0] ?? '')
  ok(/^trend: /.test(lines[1] ?? '') && /\[BULL\]|\[BEAR\]|\[=\]|\[n\/a\]/.test(lines[1] ?? ''), 'family lines carry name value [STANCE] marks', lines[1]?.slice(0, 80) ?? '')
  ok(lines.slice(1).join(' ').includes('momentum') && lines.slice(1).join(' ').includes('volatility') && lines.slice(1).join(' ').includes('volume') && lines.slice(1).join(' ').includes('levels'), 'all five families render')
}

// 5 - downseries sanity: a falling series flips the trend lean
{
  const down = makeCandles(300)
    .map((k, i) => ({ time: k.time, open: 1.1 * Math.pow(1.0008, 300 - i) + Math.sin(i / 5) * 0.0001, close: 1.1 * Math.pow(1.0008, 299 - i) + Math.sin((i + 1) / 5) * 0.0001, high: 0, low: 0, volume: k.volume }))
    .map((k) => ({ ...k, high: Math.max(k.open, k.close) + 0.0005, low: Math.min(k.open, k.close) - 0.0005 })) as Candle[]
  const b = buildIndicatorBoard(down)
  const trendBear = family(b, 'trend').filter((l) => l.stance === 'bearish').length
  const trendBull = family(b, 'trend').filter((l) => l.stance === 'bullish').length
  ok(trendBear > trendBull, `trend family flips bearish on the falling series (${trendBear} bear vs ${trendBull} bull)`)
}

console.log(`\nindicatorboard_unit: ${pass} passed, ${fail} failed`)
process.exit(fail ? 1 : 0)
