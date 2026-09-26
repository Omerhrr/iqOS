'use client'

// IQAIR//OS - Indicator readout panel
import { useState } from 'react'
import type { AnalysisResult } from '@/lib/os/client'
import { fmtPrice } from '@/lib/os/client'
import { FullscreenBackdrop, FullscreenButton } from './FullscreenButton'

interface Row {
  label: string
  value: string
  bias: 'up' | 'down' | 'flat'
  note?: string
}

function rsiRow(v: number): Row {
  const bias = v > 70 ? 'down' : v < 30 ? 'up' : v > 50 ? 'up' : 'down'
  return { label: 'RSI (14)', value: v.toFixed(1), bias, note: v > 70 ? 'overbought' : v < 30 ? 'oversold' : '' }
}

export default function IndicatorPanel({ analysis }: { analysis: AnalysisResult | null }) {
  const [full, setFull] = useState(false)
  if (!analysis) return null
  const i = analysis.indicators
  const rows: Row[] = [
    rsiRow(i.rsi),
    { label: 'Stoch K/D', value: `${i.stochK.toFixed(0)}/${i.stochD.toFixed(0)}`, bias: i.stochK > i.stochD ? 'up' : 'down', note: i.stochK > 80 ? 'OB zone' : i.stochK < 20 ? 'OS zone' : '' },
    { label: 'MACD hist', value: i.macdHist.toFixed(4), bias: i.macdHist > 0 ? 'up' : 'down' },
    { label: 'ADX (14)', value: i.adx.toFixed(1), bias: i.adx > 25 ? (i.plusDI > i.minusDI ? 'up' : 'down') : 'flat', note: `${i.adx > 25 ? 'trending' : 'weak'} · DI ${i.plusDI.toFixed(0)}/${i.minusDI.toFixed(0)}` },
    { label: 'Boll %B', value: (i.bbPercentB * 100).toFixed(0) + '%', bias: i.bbPercentB > 0.95 ? 'down' : i.bbPercentB < 0.05 ? 'up' : 'flat', note: `width ${i.bbWidth.toFixed(2)}%` },
    { label: 'EMA 20/50', value: `${fmtPrice(i.ema20, analysis.asset)} / ${fmtPrice(i.ema50, analysis.asset)}`, bias: i.ema20 > i.ema50 ? 'up' : 'down' },
    { label: 'EMA 200', value: fmtPrice(i.ema200, analysis.asset), bias: analysis.price > i.ema200 ? 'up' : 'down' },
    { label: 'Supertrend', value: fmtPrice(i.supertrend, analysis.asset), bias: i.supertrendDir > 0 ? 'up' : 'down', note: i.supertrendDir > 0 ? 'bull regime' : 'bear regime' },
    { label: 'ATR', value: `${i.atr.toFixed(4)} (${i.atrPct.toFixed(2)}%)`, bias: 'flat', note: i.atrPct > analysis.quant.annualizedVol / 100 / 40 ? 'elevated' : 'normal' },
    { label: 'CCI (20)', value: i.cci.toFixed(0), bias: i.cci > 100 ? 'down' : i.cci < -100 ? 'up' : i.cci > 0 ? 'up' : 'down' },
    { label: 'Williams %R', value: i.williamsR.toFixed(0), bias: i.williamsR < -80 ? 'up' : i.williamsR > -20 ? 'down' : 'flat' },
    { label: 'MFI (14)', value: i.mfi.toFixed(0), bias: i.mfi > 80 ? 'down' : i.mfi < 20 ? 'up' : 'flat' },
    { label: 'VWAP', value: fmtPrice(i.vwap, analysis.asset), bias: analysis.price > i.vwap ? 'up' : 'down' },
    { label: 'ROC (12)', value: `${i.roc >= 0 ? '+' : ''}${i.roc.toFixed(2)}%`, bias: i.roc > 0 ? 'up' : 'down' },
    { label: 'Ichimoku T/K', value: `${fmtPrice(i.tenkan, analysis.asset)} / ${fmtPrice(i.kijun, analysis.asset)}`, bias: i.tenkan > i.kijun ? 'up' : 'down' },
    { label: 'Donchian 20', value: `${fmtPrice(i.donchianLower, analysis.asset)} – ${fmtPrice(i.donchianUpper, analysis.asset)}`, bias: 'flat' },
  ]

  return (
    <>
      {full && <FullscreenBackdrop onClose={() => setFull(false)} />}
      <div
        className={
          full
            ? 'fixed inset-4 z-50 flex flex-col overflow-auto rounded-lg border border-[#1c2739] bg-[#0b111c] p-4 shadow-2xl'
            : 'flex h-full flex-col rounded-lg border border-[#1c2739] bg-[#0b111c] p-3'
        }
      >
        <div className="mb-2 flex items-center justify-between">
          <h3 className="text-[11px] font-semibold uppercase tracking-[0.18em] text-[#7c8aa5]">Indicators</h3>
          <FullscreenButton active={full} onToggle={() => setFull((f) => !f)} />
        </div>
        <div className="min-h-0 flex-1 space-y-px overflow-y-auto pr-1">
          {rows.map((r) => (
            <div key={r.label} className="flex items-center justify-between rounded px-1 py-1 text-[11px] font-mono hover:bg-[#101828]">
              <span className="text-[#7c8aa5]">{r.label}</span>
              <span className="flex items-center gap-1.5">
                {r.note && <span className="text-[9px] text-[#4b5a72]">{r.note}</span>}
                <span
                  className={
                    r.bias === 'up' ? 'text-emerald-400' : r.bias === 'down' ? 'text-rose-400' : 'text-[#aab6cc]'
                  }
                >
                  {r.value}
                </span>
              </span>
            </div>
          ))}
        </div>
      </div>
    </>
  )
}
