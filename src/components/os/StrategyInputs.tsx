'use client'

// Auto-built "Inputs" form for one strategy in one engine slot.
// The fields come from the `input` lines of the strategy's script (kernel
// parses them); the defaults shown are the script's. Edits are saved PER SLOT
// (bot:<id> | auto | meta | omni) in the kernel and never touch the script, so
// removing the strategy from a slot and adding it back restores them.

import { useCallback, useEffect, useState } from 'react'
import { Input } from '@/components/ui/input'
import { Switch } from '@/components/ui/switch'
import type { MetaInputDecl, MetaInputValue, MetaInputsState } from '@/lib/os/client'
import { getMetaInputs, resetMetaInputs, setMetaInputs } from '@/lib/os/client'

const LABEL = 'text-[9px] uppercase tracking-wider text-[#4b5a72]'

function fmt(v: MetaInputValue | undefined): string {
  return v === undefined ? '' : String(v)
}

function Field({
  decl,
  value,
  edited,
  busy,
  onCommit,
}: {
  decl: MetaInputDecl
  value: MetaInputValue
  edited: boolean
  busy: boolean
  onCommit: (v: MetaInputValue | null) => void
}) {
  const [text, setText] = useState(fmt(value))
  useEffect(() => setText(fmt(value)), [value])
  const range =
    decl.type === 'number' && (decl.min !== undefined || decl.max !== undefined)
      ? `${decl.min ?? '−∞'} … ${decl.max ?? '∞'}`
      : ''
  const commitText = () => {
    if (decl.type === 'number') {
      const n = Number(text)
      if (text.trim() === '' || !Number.isFinite(n)) return setText(fmt(value))
      if (n !== value) onCommit(n)
    } else if (text !== value) onCommit(text)
  }
  return (
    <div>
      <div className="mb-0.5 flex items-center justify-between gap-1">
        <span className="truncate text-[9px] text-[#7c8aa5]" title={decl.name}>
          {decl.label ?? decl.name}
        </span>
        {edited && (
          <button
            type="button"
            disabled={busy}
            onClick={() => onCommit(null)}
            title={`back to the script default (${fmt(decl.def)})`}
            className="text-[9px] text-amber-300 hover:text-amber-200"
          >
            edited · reset
          </button>
        )}
      </div>
      {decl.type === 'boolean' ? (
        <div className="flex h-7 items-center">
          <Switch checked={value === true} disabled={busy} onCheckedChange={(v) => onCommit(v)} />
        </div>
      ) : decl.options && decl.options.length ? (
        <select
          value={String(value)}
          disabled={busy}
          onChange={(e) => onCommit(e.target.value)}
          className="h-7 w-full rounded border border-[#1c2739] bg-[#0b111c] px-1.5 text-[11px] text-[#e2e8f0] outline-none"
        >
          {decl.options.map((o) => (
            <option key={o} value={o}>
              {o}
            </option>
          ))}
        </select>
      ) : (
        <Input
          value={text}
          disabled={busy}
          inputMode={decl.type === 'number' ? 'decimal' : undefined}
          onChange={(e) => setText(decl.type === 'number' ? e.target.value.replace(/[^0-9.\-eE+]/g, '') : e.target.value)}
          onBlur={commitText}
          onKeyDown={(e) => {
            if (e.key === 'Enter') (e.target as HTMLInputElement).blur()
          }}
          className={`h-7 border-[#1c2739] bg-[#0b111c] text-right text-[11px] text-[#e2e8f0] ${edited ? 'border-amber-500/40' : ''}`}
        />
      )}
      <div className="mt-0.5 text-[8px] text-[#3d4c66]">
        script default {fmt(decl.def)}
        {range ? ` · ${range}` : ''}
      </div>
    </div>
  )
}

export default function StrategyInputs({
  slot,
  strategyId,
  title,
  showEmpty = false,
}: {
  slot: string
  strategyId: string | null | undefined
  /** shown above the fields - usually the strategy name */
  title?: string
  /** render a one-line note when the script declares no inputs (default: render nothing) */
  showEmpty?: boolean
}) {
  const [st, setSt] = useState<MetaInputsState | null>(null)
  const [err, setErr] = useState('')
  const [busy, setBusy] = useState(false)

  useEffect(() => {
    let alive = true
    setSt(null)
    setErr('')
    if (!strategyId || !strategyId.startsWith('meta:')) return
    getMetaInputs(slot, strategyId)
      .then((r) => {
        if (alive) setSt(r.ok === false ? null : r)
      })
      .catch(() => {
        // not a saved meta-strategy (or kernel older than this feature): no inputs to show
        if (alive) setSt(null)
      })
    return () => {
      alive = false
    }
  }, [slot, strategyId])

  const apply = useCallback(
    async (fn: () => Promise<MetaInputsState>) => {
      setBusy(true)
      setErr('')
      try {
        const r = await fn()
        if (r.ok === false) setErr(r.error ?? 'rejected')
        else {
          setSt(r)
          if (r.rejected?.length) setErr(`not saved: ${r.rejected.join('; ')}`)
        }
      } catch (e) {
        setErr((e as Error).message)
      } finally {
        setBusy(false)
      }
    },
    [],
  )

  if (!strategyId || !st) return null
  if (!st.declared.length) {
    return showEmpty ? (
      <p className="text-[9px] text-[#3d4c66]">This strategy's script declares no inputs (add `input name = 5` lines to make some).</p>
    ) : null
  }
  const nEdited = Object.keys(st.edited).length
  return (
    <div className="rounded border border-[#1c2739] bg-[#101828] p-2">
      <div className="mb-1.5 flex items-center justify-between gap-2">
        <div className={LABEL}>{title ?? 'Inputs'}</div>
        <div className="flex items-center gap-2">
          <span className="text-[9px] text-[#4b5a72]">
            {nEdited ? `${nEdited} edited` : 'script defaults'} · saved for this slot only
          </span>
          {nEdited > 0 && (
            <button
              type="button"
              disabled={busy}
              onClick={() => void apply(() => resetMetaInputs(slot, strategyId))}
              className="text-[9px] font-bold uppercase tracking-wider text-amber-300 hover:text-amber-200"
            >
              reset all
            </button>
          )}
        </div>
      </div>
      <div className="grid grid-cols-2 gap-2">
        {st.declared.map((d) => (
          <Field
            key={d.name}
            decl={d}
            value={st.values[d.name] ?? d.def}
            edited={d.name in st.edited}
            busy={busy}
            onCommit={(v) => void apply(() => setMetaInputs(slot, strategyId, { [d.name]: v }))}
          />
        ))}
      </div>
      {st.dropped.length > 0 && (
        <p className="mt-1.5 text-[9px] text-amber-300/80">
          ignored (no longer valid for the script): {st.dropped.join(', ')}
        </p>
      )}
      {err && <p className="mt-1.5 text-[9px] text-rose-300">{err}</p>}
    </div>
  )
}
