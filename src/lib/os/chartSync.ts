// Keeps the main chart and every indicator sub-pane on the SAME time window: scroll or zoom any one of them and the rest follow (by time, so panes with a different bar count still line up).
import type { IChartApi } from 'lightweight-charts'

interface Entry { chart: IChartApi; isMain: boolean; off: () => void }
const entries = new Set<Entry>()
let busy = false

const same = (a: { from: unknown; to: unknown } | null, b: { from: unknown; to: unknown } | null) => !!a && !!b && a.from === b.from && a.to === b.to

function push(from: IChartApi) {
  if (busy) return
  const r = from.timeScale().getVisibleRange()
  if (!r) return
  busy = true
  try {
    for (const e of entries) {
      if (e.chart === from) continue
      try {
        if (!same(e.chart.timeScale().getVisibleRange(), r)) e.chart.timeScale().setVisibleRange(r)
      } catch { /* that pane has no data in the window yet */ }
    }
  } finally { busy = false }
}

/** Register a chart; returns the unregister function. The main chart leads when a pane first loads (alignToMain). */
export function registerSyncChart(chart: IChartApi, isMain = false): () => void {
  const handler = () => push(chart)
  chart.timeScale().subscribeVisibleTimeRangeChange(handler)
  const e: Entry = { chart, isMain, off: () => { try { chart.timeScale().unsubscribeVisibleTimeRangeChange(handler) } catch { /* chart already removed */ } } }
  entries.add(e)
  return () => { e.off(); entries.delete(e) }
}

/** Snap one pane to the main chart's current window (call after the pane's data is set). */
export function alignToMain(chart: IChartApi) {
  for (const e of entries) {
    if (!e.isMain || e.chart === chart) continue
    try {
      const r = e.chart.timeScale().getVisibleRange()
      if (r) chart.timeScale().setVisibleRange(r)
    } catch { /* no data yet */ }
    return
  }
}
