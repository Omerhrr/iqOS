// IQAIR//OS - Expiry Probability Surface engine.
//
// Turns the Next-Expiry Oracle's own per-rung prediction (analytics/
// nextexpiry.ts#predictNextExpiry - already built, already validated,
// already calibration-tracked) into a HEATMAP over time instead of a
// single live snapshot: one column per historical 1m bar close, one row
// per expiry rung (1/2/3/5/15m), each cell the oracle's own pUp AS IT
// WOULD HAVE READ AT THAT MOMENT - a walk-forward replay, not a
// retrospective re-fit. Nothing new is computed here; this module's only
// job is calling the SAME pure `predictNextExpiry()` the live plugin uses,
// once per historical bar, with only the candles that bar could actually
// see (`candles.slice(0, i + 1)`) - the same no-look-ahead discipline
// mslbacktest.ts's closed-bar walk already follows.
//
// HONESTY, stated plainly because it matters here more than most engines:
// this replay does NOT apply the live plugin's own per-(asset,expiry)
// calibration discount (`NextExpiryService.calibrationFor()`'s ledger) -
// that ledger only exists on the live service instance, is asset-specific
// state built from real resolved trades, and reconstructing it
// retroactively would mean pretending history had calibration data it
// never actually had at the time. Every column here is therefore the
// oracle's RAW fused probability, not its honesty-adjusted live
// confidence - `calibrated: false` on every row, and `note` says so. The
// live/current column a caller overlays on top of this (from the real
// `/next_expiry` route) IS calibrated - the two are deliberately drawn
// differently in the frontend for exactly this reason.
//
// 1m-NATIVE ONLY, same constraint predictNextExpiry() itself enforces (it
// refuses a non-~60s base series) - this surface only ever makes sense on
// 1-minute candles, since the expiry rungs are literally defined in
// minutes.
//
// O(lookback x EXPIRY_ORACLE_MIN_CANDLES) - each column reruns the
// oracle's own windowed stats (variance ratio, OU half-life, Hurst) over
// its own slice; trivial in practice (lookback capped at 300, the oracle's
// own window capped at 720) but still real work, so this function is
// never called inside a per-tick render loop - it's a poll-cadence fetch,
// same as every other "recompute over the kernel's candle archive" route.

import type { Candle } from '../types'
import { EXPIRIES_MIN, EXPIRY_ORACLE_MIN_CANDLES, predictNextExpiry } from './nextexpiry'

export interface ExpirySurfaceCell {
  expiry: number
  ok: boolean
  pUp: number
  direction: 'call' | 'put' | 'none'
  pWin: number
  confidence: number
}

export interface ExpirySurfaceColumn {
  time: number
  cells: ExpirySurfaceCell[]
}

export interface ExpirySurfaceResult {
  asset: string
  expiries: readonly number[]
  columns: ExpirySurfaceColumn[]
  /** Always false - see module header's HONESTY note. Carried on the
   * result (not just in prose) so a caller can't accidentally forget it. */
  calibrated: false
  note: string
}

export function computeExpirySurface(candles: Candle[], asset: string, opts: { lookback?: number } = {}): ExpirySurfaceResult {
  const lookback = Math.max(5, Math.min(300, Math.round(opts.lookback ?? 120)))
  const note = 'walk-forward replay of the Next-Expiry Oracle\'s RAW fused probability - the live oracle\'s own per-asset calibration discount is NOT applied retroactively (see module header); overlay the live /next_expiry read for the calibrated current column.'
  const empty: ExpirySurfaceResult = { asset, expiries: EXPIRIES_MIN, columns: [], calibrated: false, note }
  if (candles.length < EXPIRY_ORACLE_MIN_CANDLES + 2) return empty

  const last = candles[candles.length - 1]
  const prev = candles[candles.length - 2]
  const barSec = Math.max(60, last.time - prev.time || 60)
  if (Math.abs(barSec - 60) > 5) return { ...empty, note: `${note} (refused: this surface is 1m-native and this series' bar spacing is ~${barSec}s)` }

  const startIdx = Math.max(EXPIRY_ORACLE_MIN_CANDLES - 1, candles.length - lookback)
  const columns: ExpirySurfaceColumn[] = []
  for (let i = startIdx; i < candles.length; i++) {
    const slice = candles.slice(0, i + 1)
    const pred = predictNextExpiry(slice, { asset, mode: 'sim' })
    if (!pred) continue
    columns.push({
      time: candles[i].time,
      cells: pred.rows.map((r) => ({ expiry: r.expiry, ok: r.ok, pUp: r.pUp, direction: r.direction, pWin: r.pWin, confidence: r.confidence })),
    })
  }
  return { asset, expiries: EXPIRIES_MIN, columns, calibrated: false, note }
}
