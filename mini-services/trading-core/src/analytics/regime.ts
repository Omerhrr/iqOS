// IQAIR//OS - regime classifier
// Same 4-way classification the copilot's regime_playbook tool computes
// client-side from /analysis (adx, hurst, garch-vs-ewma vol) - ported here so
// the KERNEL's own regime gate (autopilot.ts) can enforce it directly instead
// of the old bull/bear-only Markov check, without a network round-trip.
// Keep the thresholds in sync with route.ts's regime_playbook tool.
import type { AnalysisResult } from '../types'

export type Regime = 'TRENDING' | 'RANGING' | 'VOLATILE' | 'MIXED'

export function classifyRegime(a: AnalysisResult): Regime {
  const adx = a.indicators?.adx ?? 0
  const hurst = a.quant?.hurst ?? 0.5
  const garchVol = a.quant?.garchVol ?? 0
  const ewmaVol = a.quant?.ewmaVol ?? 0
  const volSpike = ewmaVol > 0 && garchVol > 1.6 * ewmaVol
  if (volSpike) return 'VOLATILE'
  if (adx >= 25 && hurst > 0.55) return 'TRENDING'
  if (adx < 20 && hurst < 0.48) return 'RANGING'
  return 'MIXED'
}
