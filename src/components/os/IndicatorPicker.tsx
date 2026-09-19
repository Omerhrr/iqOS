'use client'

// IQAIR//OS - Indicator registry picker: browse 100+ indicators, add overlays & sub-panes
import { useMemo, useState } from 'react'
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { Button } from '@/components/ui/button'
import type { RegistryEntry } from '@/lib/os/client'

interface Props {
  open: boolean
  onOpenChange: (v: boolean) => void
  registry: RegistryEntry[]
  activeOverlays: string[]
  activeSubs: string[]
  onAddOverlay: (id: string, params?: Record<string, number>) => void
  onAddSub: (id: string, params?: Record<string, number>) => void
  onRemoveOverlay: (id: string) => void
  onRemoveSub: (id: string) => void
}

const CATS = ['all', 'overlap', 'momentum', 'trend', 'volatility', 'volume', 'cycle', 'statistic'] as const
const CAT_COLOR: Record<string, string> = {
  overlap: '#38bdf8',
  momentum: '#f59e0b',
  trend: '#10b981',
  volatility: '#a78bfa',
  volume: '#e879f9',
  cycle: '#2dd4bf',
  statistic: '#facc15',
  patterns: '#f43f5e',
}

export default function IndicatorPicker({
  open,
  onOpenChange,
  registry,
  activeOverlays,
  activeSubs,
  onAddOverlay,
  onAddSub,
  onRemoveOverlay,
  onRemoveSub,
}: Props) {
  const [cat, setCat] = useState<(typeof CATS)[number]>('all')
  const [q, setQ] = useState('')
  const [expanded, setExpanded] = useState<string | null>(null)
  const [paramVals, setParamVals] = useState<Record<string, Record<string, number>>>({})

  const filtered = useMemo(() => {
    const needle = q.trim().toLowerCase()
    return registry.filter((r) => {
      if (cat !== 'all' && r.category !== cat) return false
      if (needle && !r.name.toLowerCase().includes(needle) && !r.id.includes(needle)) return false
      return true
    })
  }, [registry, cat, q])

  const handleAdd = (r: RegistryEntry) => {
    const params = paramVals[r.id]
    if (r.pane === 'overlay') {
      if (activeOverlays.includes(r.id)) onRemoveOverlay(r.id)
      else onAddOverlay(r.id, params)
    } else {
      if (activeSubs.includes(r.id)) onRemoveSub(r.id)
      else onAddSub(r.id, params)
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-2xl border-[#1c2739] bg-[#0b111c] p-0 text-[#dbe4f0]">
        <DialogHeader className="border-b border-[#1c2739] px-4 py-3">
          <DialogTitle className="flex items-center justify-between text-[13px] font-semibold uppercase tracking-[0.18em] text-[#7c8aa5]">
            <span>Indicator Library</span>
            <span className="font-mono text-[10px] text-cyan-400">{registry.length} loaded</span>
          </DialogTitle>
        </DialogHeader>

        <div className="flex flex-wrap gap-1 px-4 pt-3">
          {CATS.map((c) => (
            <button
              key={c}
              onClick={() => setCat(c)}
              className={`rounded px-2 py-0.5 text-[9px] font-semibold uppercase tracking-wider transition-colors ${
                cat === c ? 'bg-cyan-500/15 text-cyan-300 ring-1 ring-cyan-500/40' : 'bg-[#101828] text-[#4b5a72] hover:text-[#aab6cc]'
              }`}
            >
              {c}
            </button>
          ))}
        </div>

        <div className="px-4 pt-2">
          <input
            value={q}
            onChange={(e) => setQ(e.target.value)}
            placeholder="Search indicators…"
            className="w-full rounded border border-[#1c2739] bg-[#101828] px-2 py-1.5 font-mono text-[11px] text-[#e2e8f0] placeholder-[#3d4d66] outline-none focus:border-cyan-500/50"
          />
        </div>

        <div className="max-h-[46vh] overflow-y-auto px-2 py-2">
          {filtered.map((r) => {
            const isActive = r.pane === 'overlay' ? activeOverlays.includes(r.id) : activeSubs.includes(r.id)
            const isExp = expanded === r.id
            return (
              <div key={r.id} className={`mb-1 rounded border px-2.5 py-2 transition-colors ${isActive ? 'border-cyan-500/40 bg-cyan-500/5' : 'border-[#1c2739] bg-[#0d1420]'}`}>
                <div className="flex items-center justify-between gap-2">
                  <button className="min-w-0 flex-1 text-left" onClick={() => setExpanded(isExp ? null : r.id)}>
                    <div className="flex items-center gap-2">
                      <span className="text-[12px] font-semibold text-[#dbe4f0]">{r.name}</span>
                      <span className="rounded px-1 text-[8px] font-mono uppercase" style={{ color: CAT_COLOR[r.category], background: `${CAT_COLOR[r.category]}14` }}>
                        {r.category}
                      </span>
                      <span className={`rounded px-1 text-[8px] font-mono uppercase ${r.pane === 'overlay' ? 'bg-emerald-500/10 text-emerald-400' : 'bg-violet-500/10 text-violet-400'}`}>
                        {r.pane === 'overlay' ? 'on chart' : 'sub-pane'}
                      </span>
                    </div>
                    <div className="mt-0.5 truncate text-[10px] text-[#4b5a72]">{r.description}</div>
                  </button>
                  <Button
                    size="sm"
                    variant="outline"
                    onClick={() => handleAdd(r)}
                    className={`h-7 shrink-0 px-2 text-[10px] font-bold uppercase ${
                      isActive ? 'border-rose-500/40 text-rose-400 hover:bg-rose-500/10' : 'border-cyan-500/40 text-cyan-300 hover:bg-cyan-500/10'
                    }`}
                  >
                    {isActive ? 'Remove' : 'Add'}
                  </Button>
                </div>
                {isExp && r.params.length > 0 && (
                  <div className="mt-2 flex flex-wrap gap-2 border-t border-[#1c2739] pt-2">
                    {r.params.map((pp) => {
                      const cur = paramVals[r.id]?.[pp.key] ?? pp.default
                      return (
                        <label key={pp.key} className="flex items-center gap-1 font-mono text-[9px] text-[#7c8aa5]">
                          {pp.label}
                          <input
                            type="number"
                            value={cur}
                            min={pp.min}
                            max={pp.max}
                            step={pp.step ?? 1}
                            onChange={(e) =>
                              setParamVals((prev) => ({
                                ...prev,
                                [r.id]: { ...prev[r.id], [pp.key]: Number(e.target.value) },
                              }))
                            }
                            className="w-16 rounded border border-[#1c2739] bg-[#101828] px-1 py-0.5 text-right text-[10px] text-[#e2e8f0]"
                          />
                        </label>
                      )
                    })}
                  </div>
                )}
              </div>
            )
          })}
        </div>

        <div className="flex items-center justify-between border-t border-[#1c2739] px-4 py-2 font-mono text-[9px] text-[#4b5a72]">
          <span>
            active overlays: {activeOverlays.length ? activeOverlays.join(', ') : 'none'} · sub-panes:{' '}
            {activeSubs.length ? activeSubs.join(', ') : 'none'}
          </span>
          <Button size="sm" variant="ghost" onClick={() => onOpenChange(false)} className="h-6 text-[10px] text-[#7c8aa5]">
            Close
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  )
}
