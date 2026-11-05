'use client'

// IQAIR//OS - Meta-strategy builder panel.
// Build a strategy OUT OF the panels directly - "Next-Candle Oracle says
// call AND HMA/ROC/Bull-Bear says call AND Accute says call AND Renko says
// call" - instead of out of raw candles (that's strategies/custom.ts's
// job, via the AI Lab). Two ways to build a spec, per direct instruction
// ("instead of using json, lets create our own strategy language, that we
// can use to achieve almost everything"):
//   - dropdown builder (below) - a plain list of conditions (source +
//     required direction + optional minimum confidence/weight, plus a
//     per-kind SMC pick on the 'smcNow' source) and one combine rule
//     (all/any/weighted). The simple, default path.
//   - code editor - the Meta Strategy Lab's own strategy language
//     (trading-core/src/analytics/strategylang.ts): real boolean/
//     arithmetic logic over the same named panel reads, plus any of the
//     15 SMC concepts individually via `smc:<KIND>` - see that module's
//     header for the full grammar. Still sandboxed: no loops, no
//     function definitions, no I/O, no raw candle access.
// See trading-core/src/analytics/metastrategy.ts's header for the full
// design reasoning on the dropdown path.
//
// Once saved, a spec can be picked as the auto-trader's signal source
// (AutopilotPanel's signalSource = 'meta-strategy', metaStrategyId = this
// spec's id) - this panel is for building/testing specs, not for arming
// the auto-trader itself.
import { useEffect, useState } from 'react'
import type { MetaCondition, MetaConditionSource, MetaStrategyEvalResponse, MetaStrategyScriptTestResponse, MetaStrategySpec, Timeframe } from '@/lib/os/client'
import {
  ALL_SMC_KINDS,
  META_CONDITION_SOURCE_LABELS,
  deleteMetaStrategy,
  evalMetaStrategy,
  getMetaStrategies,
  getMetaStrategySources,
  saveMetaStrategy,
  testMetaStrategyScript,
} from '@/lib/os/client'

interface MetaStrategyPanelProps {
  asset: string
  tf: Timeframe
  onError: (m: string) => void
}

const ALL_SOURCES: MetaConditionSource[] = ['oracle', 'hmaRocBullBear', 'momentumScore', 'accute', 'renko', 'smc', 'smcNow', 'renkoSmc']

const SCRIPT_PLACEHOLDER = `# Meta Strategy Lab script - combine any panel read with real logic.
# Sources: oracle, hmaRocBullBear, momentumScore, accute, renko, smc,
# smcNow, renkoSmc, and smc:<KIND> for any of the 15 SMC concepts
# (e.g. smc:FVG, smc:BOS, smc:ORDER_BLOCK...).
# Fields: .dir (call/put/none), .conf (0-100), .active, .call, .put

let strong = smc:FVG.conf >= 60
call when oracle.dir == call and renkoSmc.dir == call and strong
put when oracle.dir == put and renkoSmc.dir == put
confidence = avg(oracle.conf, renkoSmc.conf)
`

function emptyCondition(): MetaCondition {
  return { source: 'oracle', direction: 'either', minConfidence: 50, weight: 1 }
}

function dirColor(d: 'call' | 'put' | 'none'): string {
  if (d === 'call') return 'text-emerald-300'
  if (d === 'put') return 'text-rose-300'
  return 'text-[#4b5a72]'
}

function ConditionRow({
  cond,
  mode,
  onChange,
  onRemove,
}: {
  cond: MetaCondition
  mode: 'all' | 'any' | 'weighted'
  onChange: (c: MetaCondition) => void
  onRemove: () => void
}) {
  return (
    <div className="flex flex-wrap items-center gap-1.5 rounded border border-[#1c2739] bg-[#0b111c] p-1.5">
      <select
        value={cond.source}
        onChange={(e) => onChange({ ...cond, source: e.target.value as MetaConditionSource })}
        className="rounded border border-[#1c2739] bg-[#0b111c] px-1 py-0.5 font-mono text-[9px] text-[#dbe4f0]"
      >
        {ALL_SOURCES.map((s) => (
          <option key={s} value={s}>
            {META_CONDITION_SOURCE_LABELS[s]}
          </option>
        ))}
      </select>
      {cond.source === 'smcNow' && (
        <select
          value={cond.smcKind ?? ''}
          onChange={(e) => onChange({ ...cond, smcKind: e.target.value || undefined })}
          className="rounded border border-[#1c2739] bg-[#0b111c] px-1 py-0.5 font-mono text-[9px] text-[#dbe4f0]"
          title="which SMC concept to read 'now' - blank = aggregate across all 14 (excludes Support & Resistance)"
        >
          <option value="">aggregate (all concepts)</option>
          {ALL_SMC_KINDS.map((k) => (
            <option key={k} value={k}>
              {k}
            </option>
          ))}
        </select>
      )}
      <select
        value={cond.direction}
        onChange={(e) => onChange({ ...cond, direction: e.target.value as MetaCondition['direction'] })}
        className="rounded border border-[#1c2739] bg-[#0b111c] px-1 py-0.5 font-mono text-[9px] text-[#dbe4f0]"
        title="'either' = this source just needs to be active, in whatever direction it leans"
      >
        <option value="call">must say CALL</option>
        <option value="put">must say PUT</option>
        <option value="either">either (active)</option>
      </select>
      <label className="flex items-center gap-1 font-mono text-[9px] text-[#7c8aa5]">
        min conf
        <input
          type="number"
          min={0}
          max={100}
          value={cond.minConfidence ?? 0}
          onChange={(e) => onChange({ ...cond, minConfidence: Math.max(0, Math.min(100, Number(e.target.value) || 0)) })}
          className="w-12 rounded border border-[#1c2739] bg-[#0b111c] px-1 py-0.5 font-mono text-[9px] text-[#dbe4f0]"
        />
        %
      </label>
      {mode === 'weighted' && (
        <label className="flex items-center gap-1 font-mono text-[9px] text-[#7c8aa5]">
          weight
          <input
            type="number"
            min={0}
            step={0.5}
            value={cond.weight ?? 1}
            onChange={(e) => onChange({ ...cond, weight: Math.max(0, Number(e.target.value) || 0) })}
            className="w-12 rounded border border-[#1c2739] bg-[#0b111c] px-1 py-0.5 font-mono text-[9px] text-[#dbe4f0]"
          />
        </label>
      )}
      <button type="button" onClick={onRemove} className="ml-auto rounded px-1.5 py-0.5 font-mono text-[9px] text-rose-400 hover:bg-rose-500/10">
        remove
      </button>
    </div>
  )
}

export default function MetaStrategyPanel({ asset, tf, onError }: MetaStrategyPanelProps) {
  const [strategies, setStrategies] = useState<MetaStrategySpec[]>([])
  const [busy, setBusy] = useState(false)

  const [builderMode, setBuilderMode] = useState<'dropdown' | 'script'>('dropdown')
  const [name, setName] = useState('')
  const [mode, setMode] = useState<'all' | 'any' | 'weighted'>('all')
  const [threshold, setThreshold] = useState(60)
  const [conditions, setConditions] = useState<MetaCondition[]>([emptyCondition()])
  const [script, setScript] = useState(SCRIPT_PLACEHOLDER)
  const [editingId, setEditingId] = useState<string | null>(null)

  const [testId, setTestId] = useState<string | null>(null)
  const [testResult, setTestResult] = useState<MetaStrategyEvalResponse | null>(null)
  const [testBusy, setTestBusy] = useState(false)

  const [scriptTestResult, setScriptTestResult] = useState<MetaStrategyScriptTestResponse | null>(null)
  const [scriptTestBusy, setScriptTestBusy] = useState(false)

  const refresh = () => {
    getMetaStrategies()
      .then((d) => setStrategies(d.strategies))
      .catch((e: Error) => onError(e.message.slice(0, 180)))
  }

  useEffect(() => {
    refresh()
    // sources endpoint exists for forward-compat (server-defined list) -
    // the static ALL_SOURCES above already matches it; fetching once just
    // guards against drift without adding a loading state to the builder.
    getMetaStrategySources().catch(() => {})
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  const resetBuilder = () => {
    setEditingId(null)
    setName('')
    setMode('all')
    setThreshold(60)
    setConditions([emptyCondition()])
    setScript(SCRIPT_PLACEHOLDER)
    setBuilderMode('dropdown')
    setScriptTestResult(null)
  }

  const loadForEdit = (spec: MetaStrategySpec) => {
    setEditingId(spec.id)
    setName(spec.name)
    setMode(spec.mode)
    setThreshold(spec.threshold ?? 60)
    setConditions(spec.conditions.length ? spec.conditions.map((c) => ({ ...c })) : [emptyCondition()])
    if (spec.script) {
      setScript(spec.script)
      setBuilderMode('script')
    } else {
      setScript(SCRIPT_PLACEHOLDER)
      setBuilderMode('dropdown')
    }
    setScriptTestResult(null)
  }

  const save = () => {
    if (!name.trim()) return onError('name the strategy first')
    if (builderMode === 'script') {
      if (!script.trim()) return onError('write a script first')
    } else if (!conditions.length) {
      return onError('add at least one condition')
    }
    setBusy(true)
    saveMetaStrategy({
      id: editingId ?? undefined,
      name: name.trim(),
      mode,
      threshold: mode === 'weighted' ? threshold : undefined,
      conditions: builderMode === 'script' ? [] : conditions,
      script: builderMode === 'script' ? script : undefined,
    })
      .then((r) => {
        if (!r.ok) throw new Error(r.error ?? 'save failed')
        resetBuilder()
        refresh()
      })
      .catch((e: Error) => onError(e.message.slice(0, 180)))
      .finally(() => setBusy(false))
  }

  const runScriptTest = () => {
    setScriptTestBusy(true)
    setScriptTestResult(null)
    testMetaStrategyScript(script, asset, tf)
      .then((r) => setScriptTestResult(r))
      .catch((e: Error) => onError(e.message.slice(0, 180)))
      .finally(() => setScriptTestBusy(false))
  }

  const remove = (id: string) => {
    deleteMetaStrategy(id)
      .then((r) => {
        if (!r.ok) throw new Error(r.error ?? 'delete failed')
        if (editingId === id) resetBuilder()
        if (testId === id) {
          setTestId(null)
          setTestResult(null)
        }
        refresh()
      })
      .catch((e: Error) => onError(e.message.slice(0, 180)))
  }

  const runTest = (id: string) => {
    setTestId(id)
    setTestBusy(true)
    evalMetaStrategy(id, asset, tf)
      .then((r) => setTestResult(r))
      .catch((e: Error) => onError(e.message.slice(0, 180)))
      .finally(() => setTestBusy(false))
  }

  return (
    <div className="flex h-full min-h-0 flex-col rounded-lg border border-[#1c2739] bg-[#0b111c]">
      <div className="flex flex-wrap items-center gap-1.5 border-b border-[#1c2739] px-2 py-1.5">
        <span className="text-[10px] font-bold uppercase tracking-wider text-cyan-300">Meta-Strategy</span>
        <span className="rounded border border-cyan-500/40 bg-cyan-500/10 px-1 py-px font-mono text-[8px] font-bold uppercase text-cyan-300">
          {asset} · {tf}
        </span>
        <span className="font-mono text-[8.5px] text-[#4b5a72]">build a strategy out of the panels, not raw candles</span>
      </div>

      <div className="min-h-0 flex-1 overflow-auto p-2 space-y-3">
        {/* ---------- builder ---------- */}
        <div className="rounded border border-[#1c2739] bg-[#070c15] p-2">
          <div className="flex flex-wrap items-center gap-1.5">
            <input
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="strategy name"
              className="min-w-[140px] flex-1 rounded border border-[#1c2739] bg-[#0b111c] px-1.5 py-1 font-mono text-[10px] text-[#dbe4f0]"
            />
            <div className="flex items-center gap-px rounded border border-[#1c2739] p-0.5">
              {(['dropdown', 'script'] as const).map((m) => (
                <button
                  key={m}
                  type="button"
                  onClick={() => setBuilderMode(m)}
                  className={`rounded px-2 py-1 font-mono text-[9px] font-bold uppercase tracking-wider transition-colors ${
                    builderMode === m ? 'bg-violet-500/20 text-violet-300' : 'text-[#4b5a72] hover:text-[#aab6cc]'
                  }`}
                  title={m === 'dropdown' ? 'build from conditions (source/direction/min confidence)' : 'write a Meta Strategy Lab script (strategylang.ts) - real boolean/arithmetic logic over the same panel reads'}
                >
                  {m === 'dropdown' ? 'builder' : 'code'}
                </button>
              ))}
            </div>
            {builderMode === 'dropdown' && (
              <select
                value={mode}
                onChange={(e) => setMode(e.target.value as 'all' | 'any' | 'weighted')}
                className="rounded border border-[#1c2739] bg-[#0b111c] px-1.5 py-1 font-mono text-[9px] text-[#dbe4f0]"
                title="all = every condition must agree. any = at least one, majority side wins. weighted = each condition votes by weight*confidence, fires past the threshold."
              >
                <option value="all">ALL must agree</option>
                <option value="any">ANY (majority)</option>
                <option value="weighted">WEIGHTED score</option>
              </select>
            )}
            {builderMode === 'dropdown' && mode === 'weighted' && (
              <label className="flex items-center gap-1 font-mono text-[9px] text-[#7c8aa5]">
                threshold
                <input
                  type="number"
                  min={0}
                  max={100}
                  value={threshold}
                  onChange={(e) => setThreshold(Math.max(0, Math.min(100, Number(e.target.value) || 0)))}
                  className="w-12 rounded border border-[#1c2739] bg-[#0b111c] px-1 py-0.5 font-mono text-[9px] text-[#dbe4f0]"
                />
              </label>
            )}
          </div>

          {builderMode === 'dropdown' ? (
            <>
              <div className="mt-2 space-y-1">
                {conditions.map((c, i) => (
                  <ConditionRow
                    key={i}
                    cond={c}
                    mode={mode}
                    onChange={(next) => setConditions((prev) => prev.map((p, j) => (j === i ? next : p)))}
                    onRemove={() => setConditions((prev) => prev.filter((_, j) => j !== i))}
                  />
                ))}
              </div>
              <div className="mt-2 flex items-center gap-1.5">
                <button
                  type="button"
                  onClick={() => setConditions((prev) => [...prev, emptyCondition()])}
                  className="rounded border border-[#1c2739] px-2 py-1 font-mono text-[9px] text-[#aab6cc] hover:border-cyan-500/40 hover:text-cyan-300"
                >
                  + condition
                </button>
                <button
                  type="button"
                  disabled={busy}
                  onClick={save}
                  className="rounded border border-cyan-500/40 bg-cyan-500/10 px-2 py-1 font-mono text-[9px] font-bold uppercase text-cyan-300 hover:bg-cyan-500/20 disabled:opacity-50"
                >
                  {editingId ? 'save changes' : 'save strategy'}
                </button>
                {editingId && (
                  <button type="button" onClick={resetBuilder} className="rounded px-2 py-1 font-mono text-[9px] text-[#4b5a72] hover:text-[#aab6cc]">
                    cancel edit
                  </button>
                )}
              </div>
            </>
          ) : (
            <>
              <textarea
                value={script}
                onChange={(e) => setScript(e.target.value)}
                rows={10}
                spellCheck={false}
                className="mt-2 w-full resize-y rounded border border-[#1c2739] bg-[#0b111c] p-2 font-mono text-[10px] leading-relaxed text-[#dbe4f0] outline-none focus:border-violet-500/40"
              />
              <div className="mt-2 flex items-center gap-1.5">
                <button
                  type="button"
                  disabled={scriptTestBusy}
                  onClick={runScriptTest}
                  className="rounded border border-violet-500/40 bg-violet-500/10 px-2 py-1 font-mono text-[9px] font-bold uppercase text-violet-300 hover:bg-violet-500/20 disabled:opacity-50"
                >
                  {scriptTestBusy ? 'testing…' : `test on ${asset}`}
                </button>
                <button
                  type="button"
                  disabled={busy}
                  onClick={save}
                  className="rounded border border-cyan-500/40 bg-cyan-500/10 px-2 py-1 font-mono text-[9px] font-bold uppercase text-cyan-300 hover:bg-cyan-500/20 disabled:opacity-50"
                >
                  {editingId ? 'save changes' : 'save strategy'}
                </button>
                {editingId && (
                  <button type="button" onClick={resetBuilder} className="rounded px-2 py-1 font-mono text-[9px] text-[#4b5a72] hover:text-[#aab6cc]">
                    cancel edit
                  </button>
                )}
              </div>
              {scriptTestResult && (
                <div className="mt-2 rounded border border-[#1c2739] bg-[#0b111c] p-1.5">
                  {scriptTestResult.ok ? (
                    <>
                      <div className="flex items-center gap-1.5">
                        <span className={`font-mono text-[10px] font-bold uppercase ${dirColor(scriptTestResult.direction ?? 'none')}`}>
                          {scriptTestResult.direction === 'none' ? 'no fire' : `${scriptTestResult.direction} signal`}
                        </span>
                        {scriptTestResult.direction !== 'none' && (
                          <span className="font-mono text-[9px] text-[#7c8aa5]">conf {scriptTestResult.confidence}%</span>
                        )}
                        <span className="font-mono text-[9px] text-[#4b5a72]">price {scriptTestResult.price}</span>
                      </div>
                      <div className="mt-1 space-y-0.5">
                        {(scriptTestResult.trace ?? []).map((line, i) => (
                          <p key={i} className="font-mono text-[8.5px] text-[#7c8aa5]">
                            {line}
                          </p>
                        ))}
                      </div>
                    </>
                  ) : (
                    <p className="font-mono text-[9px] text-rose-300">{scriptTestResult.error}</p>
                  )}
                </div>
              )}
            </>
          )}
        </div>

        {/* ---------- saved list ---------- */}
        <div className="space-y-1.5">
          {strategies.length === 0 && <div className="p-1 text-[10px] text-[#4b5a72]">No meta-strategies saved yet - build one above.</div>}
          {strategies.map((s) => (
            <div key={s.id} className="rounded border border-[#1c2739] bg-[#070c15] p-1.5">
              <div className="flex flex-wrap items-center gap-1.5">
                <span className="font-mono text-[10px] font-bold text-[#dbe4f0]">{s.name}</span>
                <span className="rounded border border-[#1c2739] px-1 py-px font-mono text-[8px] uppercase text-[#7c8aa5]">{s.mode}</span>
                <span className="font-mono text-[8px] text-[#4b5a72]">{s.id}</span>
                <div className="ml-auto flex items-center gap-1">
                  <button type="button" onClick={() => runTest(s.id)} className="rounded px-1.5 py-0.5 font-mono text-[9px] text-cyan-300 hover:bg-cyan-500/10">
                    test
                  </button>
                  <button type="button" onClick={() => loadForEdit(s)} className="rounded px-1.5 py-0.5 font-mono text-[9px] text-[#aab6cc] hover:bg-[#1c2739]">
                    edit
                  </button>
                  <button type="button" onClick={() => remove(s.id)} className="rounded px-1.5 py-0.5 font-mono text-[9px] text-rose-400 hover:bg-rose-500/10">
                    delete
                  </button>
                </div>
              </div>
              <div className="mt-1 flex flex-wrap gap-1">
                {s.script ? (
                  <span className="rounded border border-violet-500/40 bg-violet-500/10 px-1 py-px font-mono text-[8px] uppercase text-violet-300">script</span>
                ) : (
                  s.conditions.map((c, i) => (
                    <span key={i} className="rounded border border-[#1c2739] px-1 py-px font-mono text-[8px] text-[#7c8aa5]">
                      {META_CONDITION_SOURCE_LABELS[c.source]}
                      {c.smcKind ? `:${c.smcKind}` : ''}:{c.direction}
                      {c.minConfidence ? ` ≥${c.minConfidence}%` : ''}
                      {s.mode === 'weighted' ? ` w${c.weight ?? 1}` : ''}
                    </span>
                  ))
                )}
              </div>

              {testId === s.id && (
                <div className="mt-1.5 rounded border border-[#1c2739] bg-[#0b111c] p-1.5">
                  {testBusy && <div className="font-mono text-[9px] text-[#4b5a72]">evaluating on {asset} · {tf}…</div>}
                  {!testBusy && testResult && testResult.spec.id === s.id && (
                    <>
                      <div className="flex items-center gap-1.5">
                        <span className={`font-mono text-[10px] font-bold uppercase ${dirColor(testResult.result.direction)}`}>
                          {testResult.result.direction === 'none' ? 'no fire' : `${testResult.result.direction} signal`}
                        </span>
                        {testResult.result.direction !== 'none' && (
                          <span className="font-mono text-[9px] text-[#7c8aa5]">score {testResult.result.score} · conf {testResult.result.confidence}%</span>
                        )}
                        <span className="font-mono text-[9px] text-[#4b5a72]">price {testResult.price}</span>
                      </div>
                      <p className="mt-0.5 text-[9px] leading-snug text-[#7c8aa5]">{testResult.result.notes}</p>
                      <div className="mt-1 space-y-0.5">
                        {testResult.result.conditions.map((cr, i) => (
                          <div key={i} className="flex items-center gap-1.5 font-mono text-[8.5px]">
                            <span className={cr.passed ? 'text-emerald-300' : 'text-[#4b5a72]'}>{cr.passed ? '✓' : '✗'}</span>
                            <span className="text-[#aab6cc]">{META_CONDITION_SOURCE_LABELS[cr.condition.source]}</span>
                            <span className={dirColor(cr.read.direction)}>{cr.read.label}</span>
                          </div>
                        ))}
                      </div>
                    </>
                  )}
                </div>
              )}
            </div>
          ))}
        </div>
      </div>

      <p className="border-t border-[#1c2739] px-2 py-1 text-[8.5px] leading-relaxed text-[#3d4d66]">
        Reads each panel&apos;s own current verdict (Oracle/HMA-ROC-Bull-Bear/Momentum Score/Accute/Renko/SMC, including per-kind SMC &quot;now&quot; reads and the Renko+SMC
        confluence) - never recomputes from candles. Build with the dropdown builder or the code editor (Meta Strategy Lab&apos;s own strategy language - sandboxed, no
        loops/I-O/raw candles). Pick a saved strategy as the auto-trader&apos;s signal source (Autopilot panel → Meta-Strategy) to trade it live.
      </p>
    </div>
  )
}
