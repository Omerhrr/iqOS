// Keeps the main chart and every indicator sub-pane on the SAME window, INCLUDING the empty space to the right of the newest bar (the chart's shift): scroll or zoom any one of them and the rest follow.
// It syncs by LOGICAL range shifted by each pane's own index offset for the same bar time, so panes with a different bar count still line up, and the right-hand shift carries over (a time-range sync cannot,
// because a time range stops at the last bar).
import type { IChartApi, LogicalRange } from 'lightweight-charts'

interface Entry { chart: IChartApi; isMain: boolean; off: () => void }
const entries = new Set<Entry>()
let busy = false

const near = (a: LogicalRange | null, b: LogicalRange) => !!a && Math.abs(a.from - b.from) < 0.01 && Math.abs(a.to - b.to) < 0.01

/** The logical range `src` shows, expressed in `dst`'s own bar indexes (anchored on a bar time both charts have). */
function mapRange(src: IChartApi, dst: IChartApi): LogicalRange | null {
  const lr = src.timeScale().getVisibleLogicalRange()
  const tr = src.timeScale().getVisibleRange()
  if (!lr || !tr) return null
  const a = src.timeScale().timeToIndex(tr.to, true)
  const b = dst.timeScale().timeToIndex(tr.to, true)
  if (a === null || b === null) return null
  const d = (b as number) - (a as number)
  return { from: (lr.from + d) as LogicalRange["from"], to: (lr.to + d) as LogicalRange["to"] }
}

function push(from: IChartApi) {
  if (busy) return
  busy = true
  try {
    for (const e of entries) {
      if (e.chart === from) continue
      try {
        const m = mapRange(from, e.chart)
        if (m && !near(e.chart.timeScale().getVisibleLogicalRange(), m)) e.chart.timeScale().setVisibleLogicalRange(m)
      } catch { /* that pane has no data in the window yet */ }
    }
  } finally { busy = false }
}

/** Register a chart; returns the unregister function. The main chart leads when a pane first loads (alignToMain). */
export function registerSyncChart(chart: IChartApi, isMain = false): () => void {
  const handler = () => push(chart)
  chart.timeScale().subscribeVisibleLogicalRangeChange(handler)
  const e: Entry = { chart, isMain, off: () => { try { chart.timeScale().unsubscribeVisibleLogicalRangeChange(handler) } catch { /* chart already removed */ } } }
  entries.add(e)
  return () => { e.off(); entries.delete(e) }
}

/** Snap one pane to the main chart's current window (call after the pane's data is set). */
export function alignToMain(chart: IChartApi) {
  for (const e of entries) {
    if (!e.isMain || e.chart === chart) continue
    try {
      const m = mapRange(e.chart, chart)
      if (m) chart.timeScale().setVisibleLogicalRange(m)
    } catch { /* no data yet */ }
    return
  }
}
