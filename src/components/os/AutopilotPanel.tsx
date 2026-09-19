'use client'

// IQAIR//OS - Autopilot: fleet manager for autonomous strategy bots.
// Bots evaluate a registered strategy on every closed candle of their
// watchlist and execute through the broker; the global risk manager
// (kill switch, daily loss, max stake) always outranks them.

import { useMemo, useState } from 'react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Slider } from '@/components/ui/slider'
import { Switch } from '@/components/ui/switch'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import type { AssetRow, BotConfig, BotRow, OsMode, StrategyInfo, Timeframe, TradeKind } from '@/lib/os/client'
import { KIND_LABEL, TIMEFRAMES, fmtMoney, fmtTime, osPost } from '@/lib/os/client'

interface AutopilotPanelProps {
  bots: BotRow[]
  assets: AssetRow[]
  strategies: StrategyInfo[]
  mode: OsMode
  onChanged: () => void
  onError: (m: string) => void
}

const emptyDraft = (): BotConfig => ({
  id: '',
  name: '',
  enabled: false,
  watchlist: [],
  strategyId: 'confluence-core',
  tf: '1m',
  kind: 'binary',
  stake: 10,
  expiryBars: 1,
  minScore: 55,
  direction: 'both',
  regime: 'all',
  maxOpen: 3,
  cooldownSec: 60,
  dailyProfitTarget: 0,
  dailyLossLimit: 0,
})

export default function AutopilotPanel({ bots, assets, strategies, mode, onChanged, onError }: AutopilotPanelProps) {
  const [editorOpen, setEditorOpen] = useState(false)
  const [draft, setDraft] = useState<BotConfig>(emptyDraft())
  const [busy, setBusy] = useState(false)
  const [filter, setFilter] = useState('')

  const fleet = useMemo(() => {
    const running = bots.filter((b) => b.bot.enabled).length
    const pnlToday = bots.reduce((s, b) => s + b.stats.pnlToday, 0)
    const trades = bots.reduce((s, b) => s + b.stats.trades, 0)
    const wins = bots.reduce((s, b) => s + b.stats.wins, 0)
    const open = bots.reduce((s, b) => s + b.stats.openCount, 0)
    return { running, pnlToday, trades, wins, winRate: trades ? wins / trades : 0, open }
  }, [bots])

  const visible = bots.filter((b) => {
    const q = filter.trim().toLowerCase()
    if (!q) return true
    return (
      b.bot.name.toLowerCase().includes(q) ||
      b.bot.strategyId.includes(q) ||
      b.bot.watchlist.some((w) => w.toLowerCase().includes(q))
    )
  })

  const openNew = () => {
    setDraft(emptyDraft())
    setEditorOpen(true)
  }

  const openEdit = (row: BotRow) => {
    setDraft({ ...row.bot })
    setEditorOpen(true)
  }

  const save = async () => {
    setBusy(true)
    try {
      const res = await osPost<{ ok: boolean; error?: string }>('/bot_save', { ...draft })
      if (res.ok) {
        setEditorOpen(false)
        onChanged()
      } else onError(res.error ?? 'bot rejected')
    } catch (err) {
      onError((err as Error).message)
    } finally {
      setBusy(false)
    }
  }

  const toggle = async (row: BotRow) => {
    try {
      await osPost('/bot_toggle', { id: row.bot.id, enabled: !row.bot.enabled })
      onChanged()
    } catch (err) {
      onError((err as Error).message)
    }
  }

  const remove = async (row: BotRow) => {
    try {
      await osPost('/bot_delete', { id: row.bot.id })
      onChanged()
    } catch (err) {
      onError((err as Error).message)
    }
  }

  const draftStrategy = strategies.find((s) => s.id === draft.strategyId)
  const patch = (p: Partial<BotConfig>) => setDraft((d) => ({ ...d, ...p }))

  return (
    <div className="flex h-full min-h-0 flex-col gap-2 rounded-lg border border-[#1c2739] bg-[#0b111c] p-2.5">
      {/* mode gate banner - HUMAN mode suspends bot autonomy */}
      {mode === 'human' && (
        <div className="flex shrink-0 items-center justify-between gap-2 rounded border border-cyan-500/30 bg-cyan-500/5 px-2.5 py-1.5">
          <p className="text-[10px] leading-snug text-[#7c8aa5]">
            <span className="font-bold uppercase tracking-wider text-cyan-300">Human-in-the-loop:</span> bot orders are
            suspended by the mode gate. Switch the OS to <span className="text-amber-300">NO-HUMAN</span> mode (menu bar) to
            run autonomy.
          </p>
        </div>
      )}
      {/* header */}
      <div className="flex shrink-0 items-center justify-between">
        <h3 className="flex items-center gap-2 text-[11px] font-semibold uppercase tracking-[0.18em] text-[#7c8aa5]">
          Autopilot
          <span
            className={`h-1.5 w-1.5 rounded-full ${fleet.running ? 'animate-pulse bg-emerald-400' : 'bg-[#2a3850]'}`}
          />
          <span className="font-mono text-[9px] normal-case tracking-normal text-[#4b5a72]">
            {fleet.running}/{bots.length} armed
          </span>
        </h3>
        <Button
          size="sm"
          onClick={openNew}
          className="h-6 rounded bg-cyan-500/15 px-2.5 text-[10px] font-bold uppercase tracking-wider text-cyan-300 hover:bg-cyan-500/25"
        >
          + New Bot
        </Button>
      </div>

      {/* fleet summary */}
      <div className="grid shrink-0 grid-cols-4 gap-1.5 font-mono text-[10px]">
        <FleetStat label="bot P&L today" value={fmtMoney(fleet.pnlToday)} tone={fleet.pnlToday >= 0 ? 'up' : 'down'} />
        <FleetStat label="bot trades" value={String(fleet.trades)} tone="neutral" />
        <FleetStat label="win rate" value={`${Math.round(fleet.winRate * 100)}%`} tone={fleet.winRate >= 0.5 ? 'up' : 'neutral'} />
        <FleetStat label="open" value={String(fleet.open)} tone="neutral" />
      </div>

      <Input
        value={filter}
        onChange={(e) => setFilter(e.target.value)}
        placeholder="filter bots…"
        className="h-7 shrink-0 border-[#1c2739] bg-[#101828] text-[11px] text-[#e2e8f0] placeholder:text-[#3d4c66]"
      />

      {/* fleet list */}
      <div className="min-h-0 flex-1 space-y-1.5 overflow-y-auto pr-0.5">
        {!bots.length && (
          <div className="flex h-full flex-col items-center justify-center gap-2 py-8 text-center">
            <p className="font-mono text-[11px] text-[#4b5a72]">No bots yet.</p>
            <p className="max-w-[280px] text-[10px] leading-relaxed text-[#3d4c66]">
              Create a bot, give it a strategy, watchlist and limits — it will trade every qualifying signal
              automatically, under the OS risk manager.
            </p>
            <Button
              size="sm"
              onClick={openNew}
              className="mt-1 h-7 rounded border border-cyan-500/40 bg-transparent px-3 text-[10px] font-bold uppercase tracking-wider text-cyan-300 hover:bg-cyan-500/10"
            >
              Deploy first bot
            </Button>
          </div>
        )}
        {visible.map((row) => (
          <BotCard key={row.bot.id} row={row} onToggle={() => toggle(row)} onEdit={() => openEdit(row)} onDelete={() => remove(row)} />
        ))}
        {bots.length > 0 && !visible.length && (
          <p className="py-6 text-center font-mono text-[10px] text-[#4b5a72]">no bots match &quot;{filter}&quot;</p>
        )}
      </div>

      {/* editor */}
      <Dialog open={editorOpen} onOpenChange={setEditorOpen}>
        <DialogContent className="max-h-[85vh] overflow-y-auto border-[#1c2739] bg-[#0b111c] font-mono text-[#dbe4f0] sm:max-w-[560px]">
          <DialogHeader>
            <DialogTitle className="text-[13px] uppercase tracking-[0.18em] text-cyan-300">
              {draft.id ? `Edit ${draft.name}` : 'Deploy new bot'}
            </DialogTitle>
            <DialogDescription className="text-[10px] text-[#4b5a72]">
              The bot fires on candle close when its strategy signal passes every filter below. Global risk limits always apply.
            </DialogDescription>
          </DialogHeader>

          <div className="grid grid-cols-2 gap-3">
            <div className="col-span-2">
              <Label className="text-[9px] uppercase tracking-wider text-[#4b5a72]">Name</Label>
              <Input
                value={draft.name}
                onChange={(e) => patch({ name: e.target.value.slice(0, 32) })}
                placeholder="e.g. EUR scalp"
                className="h-8 border-[#1c2739] bg-[#101828] text-[12px] text-[#e2e8f0]"
              />
            </div>

            <div>
              <Label className="text-[9px] uppercase tracking-wider text-[#4b5a72]">Strategy</Label>
              <select
                value={draft.strategyId}
                onChange={(e) => patch({ strategyId: e.target.value })}
                className="h-8 w-full rounded border border-[#1c2739] bg-[#101828] px-2 text-[11px] text-[#e2e8f0] outline-none focus:border-cyan-500/50"
              >
                {strategies.map((s) => (
                  <option key={s.id} value={s.id}>
                    {s.name}
                  </option>
                ))}
              </select>
            </div>

            <div>
              <Label className="text-[9px] uppercase tracking-wider text-[#4b5a72]">Timeframe</Label>
              <select
                value={draft.tf}
                onChange={(e) => patch({ tf: e.target.value as Timeframe })}
                className="h-8 w-full rounded border border-[#1c2739] bg-[#101828] px-2 text-[11px] text-[#e2e8f0] outline-none focus:border-cyan-500/50"
              >
                {TIMEFRAMES.map((t) => (
                  <option key={t} value={t}>
                    {t}
                  </option>
                ))}
              </select>
            </div>

            <div className="col-span-2">
              <Label className="text-[9px] uppercase tracking-wider text-[#4b5a72]">
                Watchlist ({draft.watchlist.length}/12)
              </Label>
              <WatchlistPicker assets={assets} selected={draft.watchlist} onChange={(w) => patch({ watchlist: w })} />
            </div>

            <div>
              <Label className="text-[9px] uppercase tracking-wider text-[#4b5a72]">Instrument type</Label>
              <select
                value={draft.kind}
                onChange={(e) => patch({ kind: e.target.value as TradeKind })}
                className="h-8 w-full rounded border border-[#1c2739] bg-[#101828] px-2 text-[11px] text-[#e2e8f0] outline-none focus:border-cyan-500/50"
              >
                {(['binary', 'turbo', 'digital', 'cfd'] as TradeKind[]).map((k) => (
                  <option key={k} value={k}>
                    {KIND_LABEL[k]}
                  </option>
                ))}
              </select>
            </div>

            <div>
              <Label className="text-[9px] uppercase tracking-wider text-[#4b5a72]">Stake $</Label>
              <Input
                value={String(draft.stake)}
                onChange={(e) => patch({ stake: Number(e.target.value.replace(/[^0-9.]/g, '')) || 0 })}
                className="h-8 border-[#1c2739] bg-[#101828] text-right text-[12px] text-[#e2e8f0]"
              />
            </div>

            <div className="col-span-2">
              <div className="flex items-center justify-between">
                <Label className="text-[9px] uppercase tracking-wider text-[#4b5a72]">Min signal score</Label>
                <span className="font-mono text-[10px] text-cyan-300">{draft.minScore}</span>
              </div>
              <Slider
                value={[draft.minScore]}
                min={0}
                max={90}
                step={5}
                onValueChange={([v]) => patch({ minScore: v })}
                className="mt-2 [&_[data-slot=slider-range]]:bg-cyan-400 [&_[data-slot=slider-thumb]]:border-cyan-400"
              />
            </div>

            <Segmented
              label="Direction"
              options={[
                { v: 'both', label: 'Both' },
                { v: 'call', label: 'Call only' },
                { v: 'put', label: 'Put only' },
              ]}
              value={draft.direction}
              onChange={(v) => patch({ direction: v as BotConfig['direction'] })}
            />
            <Segmented
              label="Regime filter"
              options={[
                { v: 'all', label: 'All' },
                { v: 'trend', label: 'Trend' },
                { v: 'range', label: 'Range' },
              ]}
              value={draft.regime}
              onChange={(v) => patch({ regime: v as BotConfig['regime'] })}
            />

            <NumField label="Max open positions" value={draft.maxOpen} onChange={(v) => patch({ maxOpen: v })} />
            <NumField label="Cooldown between trades (s)" value={draft.cooldownSec} onChange={(v) => patch({ cooldownSec: v })} />
            <NumField
              label="Daily profit target $ (0 = off)"
              value={draft.dailyProfitTarget ?? 0}
              onChange={(v) => patch({ dailyProfitTarget: v })}
            />
            <NumField
              label="Daily loss limit $ (0 = off)"
              value={draft.dailyLossLimit ?? 0}
              onChange={(v) => patch({ dailyLossLimit: v })}
            />

            {draft.kind === 'binary' || draft.kind === 'turbo' ? (
              <NumField label="Expiry (bars)" value={draft.expiryBars} onChange={(v) => patch({ expiryBars: v })} />
            ) : null}

            {draftStrategy && draftStrategy.params.length > 0 && (
              <div className="col-span-2 rounded border border-[#1c2739] bg-[#101828] p-2">
                <div className="mb-1.5 text-[9px] uppercase tracking-wider text-[#4b5a72]">
                  {draftStrategy.name} parameters
                </div>
                <div className="grid grid-cols-2 gap-2">
                  {draftStrategy.params.map((p) => (
                    <div key={p.key}>
                      <div className="mb-0.5 truncate text-[9px] text-[#4b5a72]">{p.label}</div>
                      <Input
                        value={String(draft.params?.[p.key] ?? p.default)}
                        onChange={(e) => {
                          const raw = e.target.value.replace(/[^0-9.\-]/g, '')
                          const next = { ...(draft.params ?? {}) }
                          if (raw === '' ) delete next[p.key]
                          else next[p.key] = Number(raw)
                          patch({ params: next })
                        }}
                        className="h-7 border-[#1c2739] bg-[#0b111c] text-[11px] text-[#e2e8f0]"
                      />
                    </div>
                  ))}
                </div>
              </div>
            )}

            <div className="col-span-2 flex items-center justify-between rounded border border-[#1c2739] bg-[#101828] px-3 py-2">
              <div>
                <div className="text-[11px] font-bold text-[#e2e8f0]">Arm immediately</div>
                <div className="text-[9px] text-[#4b5a72]">bot starts evaluating on the next candle close</div>
              </div>
              <Switch checked={draft.enabled} onCheckedChange={(v) => patch({ enabled: v })} />
            </div>
          </div>

          <DialogFooter className="gap-2">
            <Button
              variant="ghost"
              onClick={() => setEditorOpen(false)}
              className="h-8 rounded text-[11px] text-[#7c8aa5] hover:bg-[#101828] hover:text-[#dbe4f0]"
            >
              Cancel
            </Button>
            <Button
              onClick={save}
              disabled={busy || !draft.watchlist.length}
              className="h-8 rounded bg-cyan-500/20 text-[11px] font-bold uppercase tracking-wider text-cyan-200 hover:bg-cyan-500/30"
            >
              {busy ? 'Saving…' : draft.id ? 'Save bot' : 'Deploy bot'}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  )
}

// ---------- pieces ----------

function FleetStat({ label, value, tone }: { label: string; value: string; tone: 'up' | 'down' | 'neutral' }) {
  return (
    <div className="rounded border border-[#1c2739] bg-[#101828] px-2 py-1.5">
      <div className="text-[8px] uppercase tracking-wider text-[#4b5a72]">{label}</div>
      <div
        className={`text-[12px] font-bold ${
          tone === 'up' ? 'text-emerald-400' : tone === 'down' ? 'text-rose-400' : 'text-[#dbe4f0]'
        }`}
      >
        {value}
      </div>
    </div>
  )
}

function BotCard({
  row,
  onToggle,
  onEdit,
  onDelete,
}: {
  row: BotRow
  onToggle: () => void
  onEdit: () => void
  onDelete: () => void
}) {
  const { bot, stats } = row
  const winRate = stats.trades ? stats.wins / stats.trades : null
  return (
    <div
      className={`rounded-md border p-2 transition-colors ${
        bot.enabled ? 'border-emerald-500/30 bg-[#0d151f]' : 'border-[#1c2739] bg-[#0d121d]'
      }`}
    >
      <div className="flex items-center justify-between gap-2">
        <div className="flex min-w-0 items-center gap-2">
          <span className={`h-2 w-2 shrink-0 rounded-full ${bot.enabled ? 'animate-pulse bg-emerald-400' : 'bg-[#2a3850]'}`} />
          <span className="truncate text-[12px] font-bold text-[#e2e8f0]">{bot.name}</span>
          {stats.openCount > 0 && (
            <span className="shrink-0 rounded bg-amber-500/15 px-1 py-px text-[8px] font-bold uppercase text-amber-300">
              {stats.openCount} open
            </span>
          )}
        </div>
        <div className="flex shrink-0 items-center gap-1">
          <button
            onClick={onToggle}
            className={`rounded px-2 py-0.5 text-[9px] font-bold uppercase tracking-wider transition-colors ${
              bot.enabled
                ? 'bg-rose-500/15 text-rose-300 hover:bg-rose-500/25'
                : 'bg-emerald-500/15 text-emerald-300 hover:bg-emerald-500/25'
            }`}
          >
            {bot.enabled ? 'Stop' : 'Start'}
          </button>
          <button
            onClick={onEdit}
            className="rounded px-1.5 py-0.5 text-[9px] font-bold uppercase tracking-wider text-[#7c8aa5] hover:bg-[#1c2739] hover:text-cyan-300"
          >
            Edit
          </button>
          <button
            onClick={onDelete}
            className="rounded px-1.5 py-0.5 text-[9px] font-bold uppercase tracking-wider text-[#7c8aa5] hover:bg-rose-500/15 hover:text-rose-300"
          >
            Del
          </button>
        </div>
      </div>

      <div className="mt-1 flex flex-wrap items-center gap-1 font-mono text-[9px] text-[#4b5a72]">
        <span className="rounded bg-[#101828] px-1 py-px text-cyan-300/80">{bot.strategyId}</span>
        <span className="rounded bg-[#101828] px-1 py-px">{bot.tf}</span>
        <span className="rounded bg-[#101828] px-1 py-px">{KIND_LABEL[bot.kind]}</span>
        <span className="rounded bg-[#101828] px-1 py-px">min {bot.minScore}</span>
        <span className="rounded bg-[#101828] px-1 py-px">${bot.stake}</span>
        {bot.direction !== 'both' && <span className="rounded bg-[#101828] px-1 py-px">{bot.direction} only</span>}
        {bot.regime !== 'all' && <span className="rounded bg-[#101828] px-1 py-px">{bot.regime} regime</span>}
      </div>

      <div className="mt-1 flex items-center justify-between font-mono text-[9px]">
        <span className="truncate text-[#3d4c66]">{bot.watchlist.join(' · ')}</span>
        <div className="flex shrink-0 items-center gap-2">
          <span className={stats.pnlToday >= 0 ? 'text-emerald-400' : 'text-rose-400'}>
            today {stats.pnlToday >= 0 ? '+' : ''}{fmtMoney(stats.pnlToday)}
          </span>
          {winRate !== null && <span className="text-[#7c8aa5]">{Math.round(winRate * 100)}% win</span>}
          {stats.streak !== 0 && (
            <span className={stats.streak > 0 ? 'text-emerald-400/70' : 'text-rose-400/70'}>
              {stats.streak > 0 ? `+${stats.streak}` : stats.streak}
            </span>
          )}
          {stats.lastTradeTs > 0 && <span className="text-[#3d4c66]">last {fmtTime(stats.lastTradeTs)}</span>}
        </div>
      </div>
    </div>
  )
}

function WatchlistPicker({
  assets,
  selected,
  onChange,
}: {
  assets: AssetRow[]
  selected: string[]
  onChange: (w: string[]) => void
}) {
  const [q, setQ] = useState('')
  const options = useMemo(() => {
    const query = q.trim().toLowerCase()
    const list = query
      ? assets.filter((a) => a.ticker.toLowerCase().includes(query) || a.name.toLowerCase().includes(query))
      : assets
    return list.slice(0, 60)
  }, [assets, q])

  const toggle = (t: string) => {
    onChange(selected.includes(t) ? selected.filter((x) => x !== t) : [...selected, t].slice(0, 12))
  }

  return (
    <div>
      {selected.length > 0 && (
        <div className="mb-1 flex flex-wrap gap-1">
          {selected.map((t) => (
            <button
              key={t}
              onClick={() => toggle(t)}
              className="rounded bg-cyan-500/15 px-1.5 py-px font-mono text-[9px] text-cyan-300 hover:bg-rose-500/20 hover:text-rose-300"
            >
              {t} ×
            </button>
          ))}
        </div>
      )}
      <Input
        value={q}
        onChange={(e) => setQ(e.target.value)}
        placeholder="search instruments…"
        className="h-7 border-[#1c2739] bg-[#0b111c] text-[11px] text-[#e2e8f0] placeholder:text-[#3d4c66]"
      />
      <div className="mt-1 flex max-h-24 flex-wrap gap-1 overflow-y-auto">
        {options.map((a) => (
          <button
            key={a.ticker}
            onClick={() => toggle(a.ticker)}
            className={`rounded px-1.5 py-px font-mono text-[9px] transition-colors ${
              selected.includes(a.ticker)
                ? 'bg-cyan-500/25 text-cyan-200'
                : 'bg-[#101828] text-[#7c8aa5] hover:bg-[#1c2739] hover:text-[#dbe4f0]'
            }`}
          >
            {a.ticker}
          </button>
        ))}
      </div>
    </div>
  )
}

function Segmented({
  label,
  options,
  value,
  onChange,
}: {
  label: string
  options: { v: string; label: string }[]
  value: string
  onChange: (v: string) => void
}) {
  return (
    <div>
      <Label className="mb-1 text-[9px] uppercase tracking-wider text-[#4b5a72]">{label}</Label>
      <div className="grid grid-cols-3 gap-0.5 rounded bg-[#101828] p-0.5">
        {options.map((o) => (
          <button
            key={o.v}
            onClick={() => onChange(o.v)}
            className={`rounded py-1 text-[9px] font-bold uppercase tracking-wide transition-colors ${
              value === o.v ? 'bg-[#1c2739] text-cyan-300' : 'text-[#4b5a72] hover:text-[#aab6cc]'
            }`}
          >
            {o.label}
          </button>
        ))}
      </div>
    </div>
  )
}

function NumField({ label, value, onChange }: { label: string; value: number; onChange: (v: number) => void }) {
  return (
    <div>
      <Label className="text-[9px] uppercase tracking-wider text-[#4b5a72]">{label}</Label>
      <Input
        value={String(value)}
        onChange={(e) => onChange(Number(e.target.value.replace(/[^0-9.]/g, '')) || 0)}
        className="h-8 border-[#1c2739] bg-[#101828] text-right text-[12px] text-[#e2e8f0]"
      />
    </div>
  )
}
