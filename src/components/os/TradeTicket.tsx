'use client'

// IQAIR//OS - Trade ticket (paper execution + LIVE via iqair when connected)
import { useState } from 'react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import type { AccountState, AssetRow, Position, Timeframe } from '@/lib/os/client'
import { fmtMoney, fmtPrice, osPost } from '@/lib/os/client'

interface Props {
  asset: AssetRow | undefined
  tf: Timeframe
  price: number
  account: AccountState | null
  onPlaced: (p: Position) => void
  onError: (msg: string) => void
}

export default function TradeTicket({ asset, tf, price, account, onPlaced, onError }: Props) {
  const [kind, setKind] = useState<'binary' | 'spot'>('binary')
  const [side, setSide] = useState<'call' | 'put' | null>(null)
  const [amount, setAmount] = useState('25')
  const [expiryBars, setExpiryBars] = useState('1')
  const [tp, setTp] = useState('0.4')
  const [sl, setSl] = useState('0.25')
  const [busy, setBusy] = useState(false)

  const amt = Math.max(0, Number(amount) || 0)
  const payout = asset?.payout ?? 0.85
  const profit = kind === 'binary' ? amt * payout : amt * (Number(tp) / 100)
  const riskAmt = kind === 'binary' ? amt : amt * (Number(sl) / 100)

  const place = async (s: 'call' | 'put') => {
    setSide(s)
    setBusy(true)
    try {
      const res = await osPost<{ ok: boolean; position?: Position; error?: string }>('/trade', {
        asset: asset?.ticker,
        tf,
        side: s,
        kind,
        amount: amt,
        expiryBars: kind === 'binary' ? Number(expiryBars) : undefined,
        tp: kind === 'spot' ? Number(tp) : undefined,
        sl: kind === 'spot' ? Number(sl) : undefined,
        mode: 'paper',
      })
      if (res.ok && res.position) onPlaced(res.position)
      else onError(res.error ?? 'order rejected')
    } catch (err) {
      onError((err as Error).message)
    } finally {
      setBusy(false)
      setTimeout(() => setSide(null), 700)
    }
  }

  const chips = [10, 25, 50, 100, 250]

  return (
    <div className="flex flex-col gap-3 rounded-lg border border-[#1c2739] bg-[#0b111c] p-3">
      <div className="flex items-center justify-between">
        <h3 className="text-[11px] font-semibold uppercase tracking-[0.18em] text-[#7c8aa5]">Trade Ticket</h3>
        <span className="rounded border border-cyan-500/40 bg-cyan-500/10 px-1.5 py-0.5 text-[9px] font-bold uppercase tracking-wider text-cyan-300">
          PAPER
        </span>
      </div>

      {/* kind toggle */}
      <div className="grid grid-cols-2 gap-1 rounded-md bg-[#101828] p-1">
        {(['binary', 'spot'] as const).map((k) => (
          <button
            key={k}
            onClick={() => setKind(k)}
            className={`rounded py-1 text-[11px] font-semibold uppercase tracking-wider transition-colors ${
              kind === k ? 'bg-[#1c2739] text-cyan-300' : 'text-[#4b5a72] hover:text-[#aab6cc]'
            }`}
          >
            {k === 'binary' ? 'Binary' : 'Spot (TP/SL)'}
          </button>
        ))}
      </div>

      <div className="grid grid-cols-2 gap-2 font-mono text-[11px]">
        <div>
          <div className="mb-1 text-[9px] uppercase tracking-wider text-[#4b5a72]">Stake $</div>
          <Input
            value={amount}
            onChange={(e) => setAmount(e.target.value.replace(/[^0-9.]/g, ''))}
            className="h-8 border-[#1c2739] bg-[#101828] text-right text-[12px] text-[#e2e8f0]"
          />
        </div>
        {kind === 'binary' ? (
          <div>
            <div className="mb-1 text-[9px] uppercase tracking-wider text-[#4b5a72]">Expiry (bars of {tf})</div>
            <Input
              value={expiryBars}
              onChange={(e) => setExpiryBars(e.target.value.replace(/[^0-9]/g, ''))}
              className="h-8 border-[#1c2739] bg-[#101828] text-right text-[12px] text-[#e2e8f0]"
            />
          </div>
        ) : (
          <div className="grid grid-cols-2 gap-1">
            <div>
              <div className="mb-1 text-[9px] uppercase tracking-wider text-[#4b5a72]">TP %</div>
              <Input value={tp} onChange={(e) => setTp(e.target.value.replace(/[^0-9.]/g, ''))} className="h-8 border-[#1c2739] bg-[#101828] px-1 text-right text-[12px] text-emerald-400" />
            </div>
            <div>
              <div className="mb-1 text-[9px] uppercase tracking-wider text-[#4b5a72]">SL %</div>
              <Input value={sl} onChange={(e) => setSl(e.target.value.replace(/[^0-9.]/g, ''))} className="h-8 border-[#1c2739] bg-[#101828] px-1 text-right text-[12px] text-rose-400" />
            </div>
          </div>
        )}
      </div>

      <div className="flex gap-1">
        {chips.map((c) => (
          <button
            key={c}
            onClick={() => setAmount(String(c))}
            className="flex-1 rounded border border-[#1c2739] bg-[#0d1420] py-1 text-[10px] font-mono text-[#7c8aa5] transition-colors hover:border-cyan-500/40 hover:text-cyan-300"
          >
            {c}
          </button>
        ))}
      </div>

      <div className="flex justify-between rounded-md bg-[#101828] px-2.5 py-1.5 font-mono text-[10px]">
        <span className="text-[#4b5a72]">
          entry <span className="text-[#aab6cc]">{fmtPrice(price, asset?.ticker)}</span>
        </span>
        <span className="text-emerald-400">win +{fmtMoney(profit)}</span>
        <span className="text-rose-400">risk -{fmtMoney(riskAmt)}</span>
      </div>

      <div className="grid grid-cols-2 gap-2">
        <Button
          disabled={busy || account?.killSwitch}
          onClick={() => place('call')}
          className="h-11 bg-emerald-600 font-bold tracking-wider text-white hover:bg-emerald-500 disabled:opacity-40"
        >
          {side === 'call' ? '…' : '▲ CALL'}
        </Button>
        <Button
          disabled={busy || account?.killSwitch}
          onClick={() => place('put')}
          className="h-11 bg-rose-600 font-bold tracking-wider text-white hover:bg-rose-500 disabled:opacity-40"
        >
          {side === 'put' ? '…' : '▼ PUT'}
        </Button>
      </div>
      {account?.killSwitch && (
        <div className="rounded border border-rose-500/40 bg-rose-500/10 px-2 py-1.5 text-center text-[10px] font-bold uppercase tracking-wider text-rose-400">
          Kill switch engaged - trading halted
        </div>
      )}
    </div>
  )
}
