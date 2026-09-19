"use client";

// IQAIR//OS - Markov chain panel: transition matrix heatmap + next-step forecast
import type { MarkovResult } from "@/lib/os/client";

const STATE_LABELS: Record<string, string> = {
  big_down: "BIG▼",
  down: "DOWN",
  flat: "FLAT",
  up: "UP",
  big_up: "BIG▲",
};

const REGIME_STYLE: Record<MarkovResult["regime"], { c: string; t: string }> = {
  bull: { c: "#10b981", t: "BULL" },
  bear: { c: "#f43f5e", t: "BEAR" },
  range: { c: "#38bdf8", t: "RANGE" },
  chop: { c: "#eab308", t: "CHOP" },
};

function heat(p: number): string {
  const alpha = Math.min(0.92, 0.06 + p * 1.6);
  return `rgba(56,189,248,${alpha.toFixed(2)})`;
}

export default function MarkovPanel({
  markov,
}: {
  markov: MarkovResult | null;
}) {
  if (!markov) return null;
  const r = REGIME_STYLE[markov.regime];

  return (
    <div className="flex h-full min-h-0 flex-col gap-3 overflow-hidden rounded-lg border border-[#1c2739] bg-[#0b111c] p-3">
      <div className="flex items-center justify-between">
        <h3 className="text-[11px] font-semibold uppercase tracking-[0.18em] text-[#7c8aa5]">
          Markov Chain
        </h3>
        <span
          className="rounded px-2 py-0.5 text-[10px] font-bold uppercase tracking-wider"
          style={{
            color: r.c,
            background: `${r.c}1a`,
            border: `1px solid ${r.c}55`,
          }}
        >
          {r.t}
        </span>
      </div>

      {/* matrix + forecast + stats (scrollable) */}
      <div className="min-h-0 flex-1 space-y-3 overflow-y-auto pr-0.5">
        <div className="overflow-x-auto">
          <table className="w-full border-collapse font-mono text-[9px]">
            <thead>
              <tr>
                <th className="p-0.5 text-left text-[#4b5a72]">t\t+1</th>
                {markov.states.map((s) => (
                  <th key={s} className="p-0.5 text-[#4b5a72]">
                    {STATE_LABELS[s]}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {markov.matrix.map((row, i) => (
                <tr key={markov.states[i]}>
                  <td
                    className="p-0.5 pr-1 text-right font-semibold"
                    style={{
                      color: i === markov.lastState ? "#e2e8f0" : "#4b5a72",
                    }}
                  >
                    {STATE_LABELS[markov.states[i]]}
                    {i === markov.lastState ? " ←" : ""}
                  </td>
                  {row.map((p, j) => (
                    <td key={j} className="p-0.5">
                      <div
                        className="rounded-sm py-0.5 text-center"
                        style={{
                          background: heat(p),
                          color: p > 0.45 ? "#04121f" : "#9db2cc",
                          outline:
                            i === markov.lastState
                              ? "1px solid rgba(226,232,240,0.6)"
                              : "none",
                        }}
                      >
                        {(p * 100).toFixed(0)}
                      </div>
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>

        {/* next move forecast */}
        <div className="space-y-1">
          <div className="flex justify-between text-[10px] font-mono text-[#4b5a72]">
            <span>
              P(next move) from {STATE_LABELS[markov.states[markov.lastState]]}
            </span>
            <span>n={markov.sampleSize}</span>
          </div>
          {(
            [
              ["UP", markov.probUp, "#10b981"],
              ["FLAT", markov.probFlat, "#4b5a72"],
              ["DOWN", markov.probDown, "#f43f5e"],
            ] as [string, number, string][]
          ).map(([label, p, color]) => (
            <div
              key={label}
              className="flex items-center gap-2 text-[10px] font-mono"
            >
              <span className="w-9" style={{ color }}>
                {label}
              </span>
              <div className="h-1.5 flex-1 overflow-hidden rounded bg-[#101828]">
                <div
                  className="h-full rounded transition-all duration-500"
                  style={{ width: `${p * 100}%`, background: color }}
                />
              </div>
              <span className="w-10 text-right text-[#aab6cc]">
                {(p * 100).toFixed(1)}%
              </span>
            </div>
          ))}
        </div>

        {/* model stats */}
        <div className="grid grid-cols-3 gap-1.5 border-t border-[#1c2739] pt-2 text-center font-mono text-[10px]">
          <div>
            <div className="text-[#4b5a72]">TRENDY</div>
            <div className="text-[#aab6cc]">
              {(markov.trendiness * 100).toFixed(0)}%
            </div>
          </div>
          <div>
            <div className="text-[#4b5a72]">ENTROPY</div>
            <div className="text-[#aab6cc]">
              {(markov.entropy * 100).toFixed(0)}%
            </div>
          </div>
          <div>
            <div className="text-[#4b5a72]">E[rₜ₊₁]</div>
            <div
              className={
                markov.expectedReturn >= 0
                  ? "text-emerald-400"
                  : "text-rose-400"
              }
            >
              {(markov.expectedReturn * 100).toFixed(3)}%
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
