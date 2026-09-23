// IQAIR//OS - calibration report
// The composite signal's confidence and the Markov P(up) are heuristic
// numbers nobody has checked against reality: does "confidence 72" actually
// win about 72% of the time? This buckets every settled trade that carries
// an entry-time snapshot (Position.entryConfidence / entryPUp, captured by
// ExecutionService.snapshotSignal at placement) by predicted strength and
// compares to the REALIZED win rate in that bucket, plus a Brier score
// (mean squared error between predicted probability and 0/1 outcome - 0 is
// perfect, 0.25 is what an honest coin flip that claims 50/50 scores, and
// worse than that means the model is actively overconfident).
import type { Position } from '../types'

/** Structural slice of Store - matches the 'storeRaw' service contract used
 * elsewhere in index.ts, so this module doesn't need to import the concrete
 * Store class. */
export interface CalibrationStoreSlice {
  listPositions(status?: 'open' | 'closed', limit?: number): Position[]
}

export interface CalibrationBucket {
  rangeLabel: string
  predictedMid: number
  n: number
  wins: number
  realizedWinRate: number // %
}

export interface CalibrationReport {
  n: number // trades usable in this report
  excluded: number // settled trades skipped (no snapshot, or a draw with no clear win/loss)
  byConfidence: CalibrationBucket[] // composite signal's own self-rated confidence, 0-100
  byMarkovProb: CalibrationBucket[] // Markov P(up) reframed as "implied win probability of the side taken"
  brierConfidence: number | null
  brierMarkov: number | null
  note: string
}

function isWin(p: Position): boolean | undefined {
  if (p.status === 'won') return true
  if (p.status === 'lost') return false
  if (p.pnl !== undefined && p.pnl !== 0) return p.pnl > 0
  return undefined // still open, or a flat draw - not a calibration data point
}

function bucketize(rows: { p: Position; win: boolean }[], predictPct: (p: Position) => number): { buckets: CalibrationBucket[]; brier: number | null } {
  const edges = [0, 10, 20, 30, 40, 50, 60, 70, 80, 90, 100]
  const buckets: CalibrationBucket[] = []
  for (let i = 0; i < edges.length - 1; i++) {
    const lo = edges[i]
    const hi = edges[i + 1]
    const inBucket = rows.filter(({ p }) => {
      const v = predictPct(p)
      return v >= lo && (hi === 100 ? v <= hi : v < hi)
    })
    const wins = inBucket.filter((x) => x.win).length
    buckets.push({
      rangeLabel: `${lo}-${hi}`,
      predictedMid: (lo + hi) / 2,
      n: inBucket.length,
      wins,
      realizedWinRate: inBucket.length ? Math.round((wins / inBucket.length) * 1000) / 10 : 0,
    })
  }
  if (!rows.length) return { buckets, brier: null }
  let sum = 0
  for (const { p, win } of rows) {
    const pred = predictPct(p) / 100
    sum += (pred - (win ? 1 : 0)) ** 2
  }
  return { buckets, brier: Math.round((sum / rows.length) * 1000) / 1000 }
}

export function buildCalibrationReport(
  store: CalibrationStoreSlice,
  opts: { asset?: string; strategyId?: string; limit?: number } = {}
): CalibrationReport {
  const rows = store.listPositions('closed', opts.limit ?? 2000)
  const withSnapshot = rows.filter(
    (p) =>
      p.entryConfidence !== undefined &&
      p.entryPUp !== undefined &&
      (opts.asset ? p.asset === opts.asset : true) &&
      (opts.strategyId ? p.strategy === opts.strategyId : true)
  )
  const usable = withSnapshot
    .map((p) => ({ p, win: isWin(p) }))
    .filter((x): x is { p: Position; win: boolean } => x.win !== undefined)
  const excluded = rows.length - usable.length

  const conf = bucketize(usable, (p) => p.entryConfidence ?? 0)
  const markov = bucketize(usable, (p) => {
    const pUp = p.entryPUp ?? 0.5
    const implied = p.side === 'call' ? pUp : 1 - pUp
    return implied * 100
  })

  const note =
    usable.length < 30
      ? `only ${usable.length} usable trade(s) - the curve below is too small a sample to trust yet; keep trading and re-check once you have 30+`
      : 'lower Brier is better calibrated (0 = perfect, 0.25 = what an honest 50/50 coin flip scores, higher = the model is overconfident somewhere - check which bucket realized well below its predicted rate)'

  return {
    n: usable.length,
    excluded,
    byConfidence: conf.buckets,
    byMarkovProb: markov.buckets,
    brierConfidence: conf.brier,
    brierMarkov: markov.brier,
    note,
  }
}
