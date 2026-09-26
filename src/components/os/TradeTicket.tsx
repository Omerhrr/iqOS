'use client'

// IQAIR//OS - Trade ticket: Binary / Turbo / Digital / CFD (paper + LIVE via iqair)
import { useState } from 'react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import type { AccountState, AssetRow, Position, Timeframe, TradeKind } from '@/lib/os/client'
import { KIND_LABEL, fmtMoney, fmtPrice, osPost } from '@/lib/os/client'

interface Props {
  asset: AssetRow | undefined
  tf: Timeframe
  price: number
  account: AccountState | null
  onPlaced: (p: Position) => void
  onError: (msg: string) => void
}

const DIGITAL_EXPIRIES = [
  { sec: 300, label: '5m' },
  { sec: 900, label: '15m' },
  { sec: 1800, label: '30m' },
]

export default function TradeTicket({ asset, tf, price, account, onPlaced, onError }: Props) {
  const [kind, setKind] = useState<TradeKind>('binary')
  const [side, setSide] = useState<'call' | 'put' | null>(null)
  const [amount, setAmount] = useState('1')
  const [expiryBars, setExpiryBars] = useState('1')
  const [digitalExpiry, setDigitalExpiry] = useState(300)
  const [strikeOffset, setStrikeOffset] = useState('0')
  const [leverage, setLeverage] = useState(String(asset?.leverage ?? 10))
  const [tp, setTp] = useState('0.4')
  const [sl, setSl] = useState('0.25')
  const [busy, setBusy] = useState(false)

  const amt = Math.max(0, Number(amount) || 0)
  const payout =
    kind === 'turbo'
      ? asset?.turboPayout ?? (asset?.payout ?? 0.85) - 0.02
      : kind === 'digital'
        ? asset?.digitalPayout ?? (asset?.payout ?? 0.85) + 0.05
        : asset?.payout ?? 0.85
  const lev = Math.max(1, Number(leverage) || 1)
  const notional = kind === 'cfd' ? amt * lev : 0
  const win = kind === 'cfd' ? notional * (Number(tp) / 100) : kind === 'binary' || kind === 'turbo' || kind === 'digital' ? amt * payout : amt * (Number(tp) / 100)
  const riskAmt = kind === 'cfd' ? Math.min(amt, notional * (Number(sl) / 100)) : amt

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
        ...(kind === 'binary' || kind === 'turbo' ? { expiryBars: Number(expiryBars) || 1 } : {}),
        ...(kind === 'digital' ? { expirySec: digitalExpiry, strikeOffsetPct: Number(strikeOffset) || 0 } : {}),
        ...(kind === 'cfd' ? { leverage: lev, tp: Number(tp), sl: Number(sl) } : {}),
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

  const chips = [1, 5, 10, 25, 50, 100]

  return (
    <div className="flex flex-col gap-3 rounded-lg border border-[#1c2739] bg-[#0b111c] p-3">
      <div className="flex items-center justify-between">
        <h3 className="text-[11px] font-semibold uppercase tracking-[0.18em] text-[#7c8aa5]">Trade Ticket</h3>
        <div className="flex items-center gap-1">
          <span className="rounded border border-cyan-500/40 bg-cyan-500/10 px-1.5 py-0.5 text-[9px] font-bold uppercase tracking-wider text-cyan-300">
            PAPER
          </span>
          {asset && (
            <span className="font-mono text-[9px] text-[#4b5a72]">{asset.open ? 'open' : 'closed'}</span>
          )}
        </div>
      </div>

      {/* kind selector */}
      <div className="grid grid-cols-4 gap-1 rounded-md bg-[#101828] p-1">
        {(['binary', 'turbo', 'digital', 'cfd'] as TradeKind[]).map((k) => (
          <button
            key={k}
            onClick={() => setKind(k)}
            className={`rounded py-1 text-[10px] font-bold uppercase tracking-wider transition-colors ${
              kind === k ? 'bg-[#1c2739] text-cyan-300' : 'text-[#4b5a72] hover:text-[#aab6cc]'
            }`}
          >
            {KIND_LABEL[k]}
          </button>
        ))}
      </div>

      <div className="grid grid-cols-2 gap-2 font-mono text-[11px]">
        <div>
          <div className="mb-1 text-[9px] uppercase tracking-wider text-[#4b5a72]">
            {kind === 'cfd' ? 'Margin $' : 'Stake $'}
          </div>
          <Input
            value={amount}
            onChange={(e) => setAmount(e.target.value.replace(/[^0-9.]/g, ''))}
            className="h-8 border-[#1c2739] bg-[#101828] text-right text-[12px] text-[#e2e8f0]"
          />
        </div>

        {kind === 'binary' && (
          <div>
            <div className="mb-1 text-[9px] uppercase tracking-wider text-[#4b5a72]">Expiry (bars of {tf})</div>
            <Input
              value={expiryBars}
              onChange={(e) => setExpiryBars(e.target.value.replace(/[^0-9]/g, ''))}
              className="h-8 border-[#1c2739] bg-[#101828] text-right text-[12px] text-[#e2e8f0]"
            />
          </div>
        )}

        {kind === 'turbo' && (
          <div>
            <div className="mb-1 text-[9px] uppercase tracking-wider text-[#4b5a72]">Expiry (bars, min 30s)</div>
            <Input
              value={expiryBars}
              onChange={(e) => setExpiryBars(e.target.value.replace(/[^0-9]/g, ''))}
              className="h-8 border-[#1c2739] bg-[#101828] text-right text-[12px] text-[#e2e8f0]"
            />
          </div>
        )}

        {kind === 'digital' && (
          <div>
            <div className="mb-1 text-[9px] uppercase tracking-wider text-[#4b5a72]">Expiry</div>
            <div className="grid grid-cols-3 gap-1">
              {DIGITAL_EXPIRIES.map((d) => (
                <button
                  key={d.sec}
                  onClick={() => setDigitalExpiry(d.sec)}
                  className={`rounded border py-1 text-[10px] font-mono transition-colors ${
                    digitalExpiry === d.sec ? 'border-violet-500/50 bg-violet-500/10 text-violet-300' : 'border-[#1c2739] bg-[#101828] text-[#7c8aa5]'
                  }`}
                >
                  {d.label}
                </button>
              ))}
            </div>
          </div>
        )}

        {kind === 'cfd' && (
          <div>
            <div className="mb-1 text-[9px] uppercase tracking-wider text-[#4b5a72]">
              Leverage (max 1:{asset?.leverage ?? 30})
            </div>
            <Input
              value={leverage}
              onChange={(e) => setLeverage(e.target.value.replace(/[^0-9]/g, ''))}
              className="h-8 border-[#1c2739] bg-[#101828] text-right text-[12px] text-[#e2e8f0]"
            />
          </div>
        )}
      </div>

      {kind === 'digital' && (
        <div className="grid grid-cols-2 gap-2 font-mono text-[11px]">
          <div>
            <div className="mb-1 text-[9px] uppercase tracking-wider text-[#4b5a72]">Strike offset % (0 = ATM)</div>
            <Input
              value={strikeOffset}
              onChange={(e) => setStrikeOffset(e.target.value.replace(/[^0-9.]/g, ''))}
              className="h-8 border-[#1c2739] bg-[#101828] text-right text-[12px] text-[#e2e8f0]"
            />
          </div>
          <div className="flex items-end">
            <div className="w-full rounded bg-[#101828] px-2 py-1.5 text-[10px]">
              <span className="text-[#4b5a72]">strike </span>
              <span className="text-violet-300">
                {fmtPrice(
                  asset ? (side === 'put' ? price * (1 - (Number(strikeOffset) || 0) / 100) : price * (1 + (Number(strikeOffset) || 0) / 100)) : price,
                  asset?.ticker
                )}
              </span>
            </div>
          </div>
        </div>
      )}

      {/* TP/SL are CFD-only mechanics. Binary/turbo/digital options are
          fixed-payout, fixed-expiry contracts: the stake is the risk and the
          payout is the win - there is nothing to take-profit or stop-out. */}
      {kind === 'cfd' && (
        <div className="grid grid-cols-2 gap-2 font-mono text-[11px]">
          <div>
            <div className="mb-1 text-[9px] uppercase tracking-wider text-[#4b5a72]">TP %</div>
            <Input
              value={tp}
              onChange={(e) => setTp(e.target.value.replace(/[^0-9.]/g, ''))}
              className="h-8 border-[#1c2739] bg-[#101828] px-1 text-right text-[12px] text-emerald-400"
            />
          </div>
          <div>
            <div className="mb-1 text-[9px] uppercase tracking-wider text-[#4b5a72]">SL %</div>
            <Input
              value={sl}
              onChange={(e) => setSl(e.target.value.replace(/[^0-9.]/g, ''))}
              className="h-8 border-[#1c2739] bg-[#101828] px-1 text-right text-[12px] text-rose-400"
            />
          </div>
        </div>
      )}

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
        {kind === 'cfd' ? (
          <span className="text-[#4b5a72]">
            notional <span className="text-emerald-400">{fmtMoney(notional)}</span>
          </span>
        ) : (
          <span className="text-emerald-400">payout {(payout * 100).toFixed(0)}%</span>
        )}
        <span className="text-emerald-400">win +{fmtMoney(win)}</span>
        <span className="text-rose-400">risk -{fmtMoney(riskAmt)}</span>
      </div>

      <div className="grid grid-cols-2 gap-2">
        <Button
          disabled={busy || account?.killSwitch || asset?.open === false}
          onClick={() => place('call')}
          className="h-11 bg-emerald-600 font-bold tracking-wider text-white hover:bg-emerald-500 disabled:opacity-40"
        >
          {side === 'call' ? '…' : kind === 'cfd' ? '▲ BUY' : '▲ HIGHER'}
        </Button>
        <Button
          disabled={busy || account?.killSwitch || asset?.open === false}
          onClick={() => place('put')}
          className="h-11 bg-rose-600 font-bold tracking-wider text-white hover:bg-rose-500 disabled:opacity-40"
        >
          {side === 'put' ? '…' : kind === 'cfd' ? '▼ SELL' : '▼ LOWER'}
        </Button>
      </div>
      {account?.killSwitch && (
        <div className="rounded border border-rose-500/40 bg-rose-500/10 px-2 py-1.5 text-center text-[10px] font-bold uppercase tracking-wider text-rose-400">
          Kill switch engaged - trading halted
        </div>
      )}
      {!account?.killSwitch && asset?.open === false && (
        <div className="rounded border border-amber-500/40 bg-amber-500/10 px-2 py-1.5 text-center text-[10px] font-bold uppercase tracking-wider text-amber-400">
          Market closed for {asset.ticker} - trading disabled
        </div>
      )}
      {kind === 'digital' && (
        <div className="text-center font-mono text-[9px] text-[#4b5a72]">
          digital: price must finish beyond the strike at expiry - ATM pays full rate
        </div>
      )}
    </div>
  )
}
