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
import { Button } from '@/components/ui/button'
import CodeAssistBar from './CodeAssistBar'
import type { MetaCondition, MetaConditionSource, MetaStrategyEvalResponse, MetaStrategyScriptTestResponse, MetaStrategySpec, MetaTraderSource, Timeframe } from '@/lib/os/client'
import {
  ALL_META_TRADER_SOURCES,
  ALL_SMC_KINDS,
  META_CONDITION_SOURCE_LABELS,
  META_TRADER_SOURCE_LABELS,
  deleteMetaStrategy,
  evalMetaStrategy,
  getMetaSourceCode,
  getMetaStrategies,
  getMetaStrategySources,
  saveMetaSourceCode,
  saveMetaStrategy,
  testMetaStrategyScript,
} from '@/lib/os/client'

interface MetaStrategyPanelProps {
  asset: string
  tf: Timeframe
  onError: (m: string) => void
}

const ALL_SOURCES: MetaConditionSource[] = [
  'oracle',
  'hmaRocBullBear',
  'momentumScore',
  'nextExpiry',
  'accute',
  'renko',
  'pointFigure',
  'rangeBars',
  'candle',
  'bar',
  'heikinAshi',
  'line',
  'area',
  'baseline',
  'volumeBars',
  'tick',
  'footprint',
  'tpo',
  'ivHv',
  'smc',
  'smcNow',
  'renkoSmc',
  'renkoSmcMajority',
  'tickSmc',
  'tickOracle',
  'tickTechnical',
  'tickFootprint',
]

/** Tick-bucket lengths the tick-desk sources can be pinned to - the same
 * ladder the tick oracle panel renders (1s..5m). Only shown for tick*
 * sources; blank = each engine's own default (SMC 15s, oracle best bucket,
 * technical best-rated bucket, footprint 60s). */
const TICK_BUCKET_CHOICES: { sec: number; label: string }[] = [
  { sec: 1, label: '1s buckets' },
  { sec: 2, label: '2s buckets' },
  { sec: 3, label: '3s buckets' },
  { sec: 5, label: '5s buckets' },
  { sec: 15, label: '15s buckets' },
  { sec: 30, label: '30s buckets' },
  { sec: 60, label: '1m buckets' },
  { sec: 120, label: '2m buckets' },
  { sec: 180, label: '3m buckets' },
  { sec: 300, label: '5m buckets' },
]
const isTickSource = (s: MetaConditionSource): boolean => s === 'tickSmc' || s === 'tickOracle' || s === 'tickTechnical' || s === 'tickFootprint'

const OPS = ['>=', '>', '<=', '<', '==', '!='] as const

const SCRIPT_PLACEHOLDER = `# Meta Strategy Lab script - combine any panel read with real logic.
# Sources: oracle, hmaRocBullBear, momentumScore, accute, renko,
# pointFigure, rangeBars, candle, bar, heikinAshi, line, area, baseline,
# volumeBars, tick, footprint, tpo, ivHv, smc, smcNow, renkoSmc
# (confluence: any SMC concept agrees with renko), renkoSmcMajority
# (confluence: SMC's own majority verdict must agree with renko),
# nextExpiry (the Next-Expiry Oracle's best pick, honesty-floored),
# nextExpiry:<E> for a pinned rung (nextExpiry:1 / nextExpiry:2 /
# nextExpiry:3 / nextExpiry:5 / nextExpiry:15), and
# smc:<KIND> for any of the 15 SMC concepts (e.g. smc:FVG, smc:BOS,
# smc:ORDER_BLOCK...), plus the TICK-DESK engines: tickSmc, tickOracle,
# tickTechnical, tickFootprint (the raw micro-tick stream, not the
# close-proxy 'tick'/'footprint'), with tickOracle:<SEC> and
# tickTechnical:<SEC> pinned-bucket keys (tickOracle:15, tickTechnical:60...).
# Fields: .dir (call/put/none), .conf (0-100), .active, .call, .put

let strong = smc:FVG.conf >= 60
let chartsAgree = renko.dir == pointFigure.dir and renko.dir == rangeBars.dir
call when oracle.dir == call and chartsAgree and renko.dir == call and strong
put when oracle.dir == put and chartsAgree and renko.dir == put
confidence = avg(oracle.conf, renko.conf, pointFigure.conf, rangeBars.conf)

# Branching (optional): if <cond> / elseif <cond> / else / end, statements on the lines between.
# The first true branch runs. Example:
#   if oracle.conf >= 70
#     call when oracle.dir == call
#   elseif oracle.conf >= 55
#     call when oracle.dir == call and renko.dir == call
#   end
`

function emptyCondition(): MetaCondition {
  return { source: 'oracle', direction: 'either', minConfidence: 50, weight: 1 }
}

/** The MSL source key a condition reads, used by the pseudo-script
 * generator: a pinned smcKind becomes `smc:<KIND>`, a pinned expiry rung
 * becomes `nextExpiry:<E>` - both are real script identifiers (same ':')
 * the evaluator's reads map actually carries, so a promoted dropdown spec
 * behaves identically after the promotion. */
function mslRefFor(c: MetaCondition): string {
  if (c.source === 'smcNow' && c.smcKind) return `smc:${c.smcKind}`
  if (c.source === 'nextExpiry' && c.expiryMin) return `nextExpiry:${c.expiryMin}`
  if (isTickSource(c.source) && c.tickBucketSec && (c.source === 'tickOracle' || c.source === 'tickTechnical')) return `${c.source}:${c.tickBucketSec}`
  return c.source
}

/** "all the strats we have in meta trader signal source should also
 * appear" per direct instruction - these are NOT saved MetaStrategySpecs,
 * they're the kernel's own hardcoded signal sources (plugins/
 * metatrader.ts's pickCandidates() dispatcher/pickXxx() methods) that
 * Meta Trader's own signalSource dropdown already picks from. No stored
 * script or conditions exist for them, so this is a hand-written, honest
 * explanation of each one's actual logic (mirrors that file's own doc
 * comments) rather than a generated pseudo-script. */
function builtinSourceExplainer(source: MetaTraderSource): string {
  if (source === 'meta-strategy') {
    return [
      '# built-in Meta Trader source: meta-strategy',
      "# Delegates entirely to a saved Meta-Strategy spec (metaStrategyId),",
      '# evaluated per-candidate the same way the "test" button above does -',
      "# see that spec's own \"source\" for its actual logic.",
    ].join('\n')
  }
  if (source === 'oracle') {
    return [
      '# built-in Meta Trader source: oracle',
      "# Reads the Next-Candle Oracle's multi-model fusion prediction",
      '# directly (same read the oracle condition source uses).',
      'call when oracle.dir == call and oracle.conf >= minConfidence',
      'put when oracle.dir == put and oracle.conf >= minConfidence',
    ].join('\n')
  }
  if (source === 'accute') {
    return [
      '# built-in Meta Trader source: accute',
      "# Reads Accute's own signal() verdict directly.",
      'call when accute.dir == call and accute.conf >= minConfidence',
      'put when accute.dir == put and accute.conf >= minConfidence',
    ].join('\n')
  }
  if (source === 'smc') {
    return [
      '# built-in Meta Trader source: smc',
      '# smcNowRead() aggregate across ALL "now" concepts (barsAgo===0,',
      '# excludes Support & Resistance) - majority/tie-broken winner.',
      '# NOTE: minConfidence is NOT applied to any smc-flavored source -',
      '# the "now" confidence has no honesty-loop/resolved-outcome backing,',
      '# so any concept firing now qualifies, ranked by recency not score.',
      'call when smcNow.dir == call',
      'put when smcNow.dir == put',
    ].join('\n')
  }
  if (source === 'renko-smc' || source === 'renko-smc-majority') {
    const majority = source === 'renko-smc-majority'
    return [
      `# built-in Meta Trader source: ${source}`,
      '# "if renko is green and smc now says up, trade up, but if renko is',
      '#  red and smc now says down, trade down" per direct instruction.',
      'let renkoDir = renko.dir   # streak-based trend, confidence = 40+streak*12 capped 100',
      majority
        ? "let confluence = smcNow.dir == renkoDir   # SMC's OWN MAJORITY verdict must match renko"
        : 'let confluence = any(smc:<KIND>.dir == renkoDir for KIND in ALL_SMC_KINDS except SUPPORT_RESISTANCE)   # ANY one concept agreeing is enough',
      'call when renkoDir == call and confluence',
      'put when renkoDir == put and confluence',
      'confidence = avg(renko.conf, smc-agreement-ratio)',
    ].join('\n')
  }
  if (source === 'next-expiry') {
    return [
      '# built-in Meta Trader source: next-expiry',
      "# Reads the Next-Expiry Oracle's fused BEST PICK across the 1/2/3/5/15m",
      '# ladder directly (same read the nextExpiry condition source uses; the',
      '# oracle is minute-native so the panel tf is ignored). Its pWin>=56%',
      '# and conf>=25 honesty floors are already applied by the engine - a',
      '# null best ("wait") yields no candidate. FRESH-EDGE GATED like oracle:',
      '# the pick is window-anchored, so arming never trades a stale middle.',
      'call when nextExpiry.dir == call and nextExpiry.conf >= minConfidence',
      'put when nextExpiry.dir == put and nextExpiry.conf >= minConfidence',
    ].join('\n')
  }
  // the 15 individual smc-<kind> sources - same shape, just pinned to one concept
  const kind = source.replace(/^smc-/, '').toUpperCase().replace(/-/g, '_')
  return [
    `# built-in Meta Trader source: ${source}`,
    `# smcNowRead() pinned to ONE concept (smcKind='${kind}') instead of the`,
    '# aggregate across all of them - fires the instant THIS concept hits,',
    '# "now" only (barsAgo===0). minConfidence not applied (see smc above).',
    `call when smc:${kind}.dir == call`,
    `put when smc:${kind}.dir == put`,
  ].join('\n')
}

/** "a place to see all the strats... view their source code" per direct
 * instruction - a script-built spec's source IS its script (shown as-is);
 * a dropdown-built spec has no stored script, so this renders an
 * equivalent, readable pseudo-script from its conditions/mode/threshold -
 * same grammar strategylang.ts understands, so it also doubles as a
 * starting point for "promoting" a dropdown spec into the code editor. */
function specSourceCode(s: MetaStrategySpec): string {
  if (s.script) return s.script
  const lines: string[] = [`# ${s.name} - auto-generated from the dropdown builder (mode: ${s.mode})`]
  if (!s.conditions.length) {
    lines.push('# (no conditions)')
    return lines.join('\n')
  }
  const condExpr = (c: MetaCondition, i: number) => {
    const ref = mslRefFor(c)
    const dirPart = c.direction === 'either' ? `${ref}.active` : `${ref}.dir == ${c.direction}`
    const op = c.op ?? '>='
    const confPart = c.minConfidence ? ` and ${ref}.conf ${op} ${c.minConfidence}` : ''
    return `cond${i} = ${dirPart}${confPart}`
  }
  s.conditions.forEach((c, i) => lines.push(condExpr(c, i)))
  const names = s.conditions.map((_, i) => `cond${i}`)
  if (s.mode === 'all') {
    lines.push(`call when ${names.join(' and ')} and ${s.conditions.map((c) => `${mslRefFor(c)}.dir == call`).join(' and ')}`)
    lines.push(`put when ${names.join(' and ')} and ${s.conditions.map((c) => `${mslRefFor(c)}.dir == put`).join(' and ')}`)
  } else if (s.mode === 'any') {
    lines.push(`# fires on majority-side agreement among: ${names.join(', ')}`)
    lines.push(`call when (${names.join(' or ')}) and count(${s.conditions.map((c) => `${mslRefFor(c)}.dir == call`).join(', ')}) > count(${s.conditions.map((c) => `${mslRefFor(c)}.dir == put`).join(', ')})`)
    lines.push(`put when (${names.join(' or ')}) and count(${s.conditions.map((c) => `${mslRefFor(c)}.dir == put`).join(', ')}) > count(${s.conditions.map((c) => `${mslRefFor(c)}.dir == call`).join(', ')})`)
  } else {
    lines.push(`# weighted score, threshold ${s.threshold ?? 60}% - each condition votes weight(${s.conditions.map((c) => c.weight ?? 1).join(',')}) * its own confidence`)
    lines.push(`confidence = avg(${s.conditions.map((c) => `${mslRefFor(c)}.conf`).join(', ')})`)
  }
  return lines.join('\n')
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
      {cond.source === 'nextExpiry' && (
        <select
          value={cond.expiryMin ? String(cond.expiryMin) : ''}
          onChange={(e) => onChange({ ...cond, expiryMin: e.target.value ? Number(e.target.value) || undefined : undefined })}
          className="rounded border border-[#1c2739] bg-[#0b111c] px-1 py-0.5 font-mono text-[9px] text-[#dbe4f0]"
          title="which expiry rung to read - blank = the oracle's own best pick (already gated by its pWin/confidence honesty floors); a pinned rung still warming up reads as none"
        >
          <option value="">best pick (oracle's own)</option>
          {[1, 2, 3, 5, 15].map((m) => (
            <option key={m} value={String(m)}>
              {m}m rung
            </option>
          ))}
        </select>
      )}
      {isTickSource(cond.source) && (
        <select
          value={cond.tickBucketSec ? String(cond.tickBucketSec) : ''}
          onChange={(e) => onChange({ ...cond, tickBucketSec: e.target.value ? Number(e.target.value) || undefined : undefined })}
          className="rounded border border-[#1c2739] bg-[#0b111c] px-1 py-0.5 font-mono text-[9px] text-[#dbe4f0]"
          title="which tick-bucket length to read - blank = each engine's own default (SMC 15s, oracle best bucket, technical best-rated bucket, footprint 60s); a bucket still warming up reads as none"
        >
          <option value="">default bucket</option>
          {TICK_BUCKET_CHOICES.map((b) => (
            <option key={b.sec} value={String(b.sec)}>
              {b.label}
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
        conf
        <select
          value={cond.op ?? '>='}
          onChange={(e) => onChange({ ...cond, op: e.target.value as MetaCondition['op'] })}
          className="rounded border border-[#1c2739] bg-[#0b111c] px-1 py-0.5 font-mono text-[9px] text-[#dbe4f0]"
          title="comparison applied between this source's live confidence and the number below - 'a wide range of conditions' (e.g. fire only while confidence is BELOW a value)"
        >
          {OPS.map((o) => (
            <option key={o} value={o}>
              {o}
            </option>
          ))}
        </select>
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

  // "a place to see all the strats we currently have... and view their
  // source code" per direct instruction - toggled per saved strategy row.
  const [viewSourceId, setViewSourceId] = useState<string | null>(null)

  // "all the strats we have in meta trader signal source should also
  // appear" per direct instruction - built-in sources get their own
  // (collapsed by default - there are 21 of them) section + per-row
  // explainer toggle, same shape as the saved-spec list above.
  const [showBuiltins, setShowBuiltins] = useState(false)
  const [builtinSourceId, setBuiltinSourceId] = useState<MetaTraderSource | null>(null)

  // "we should be able to edit and save the builtin meta strategies" per
  // direct instruction - these built-in sources are real pickXxx() methods
  // on MetaTraderService (not a saved spec), so "view as code" here means
  // literally reading/rewriting that method in metatrader.ts (same safety
  // story as the Strategy Lab's builtin.ts editor: brace-matched extraction,
  // syntax-checked, backed up - see metasourceedit.ts). Note editing 'smc'
  // or any smc-<KIND> id edits the ONE shared pickSmc() method underneath.
  const [codeViewId, setCodeViewId] = useState<MetaTraderSource | null>(null)
  const [codeText, setCodeText] = useState('')
  const [codeLoading, setCodeLoading] = useState(false)
  const [codeError, setCodeError] = useState<string | null>(null)
  const [codeEditingId, setCodeEditingId] = useState<MetaTraderSource | null>(null)
  const [codeSaving, setCodeSaving] = useState(false)
  const [codeSaveNote, setCodeSaveNote] = useState<string | null>(null)
  const [codeMethod, setCodeMethod] = useState<string | null>(null)

  const loadSourceCode = (src: MetaTraderSource) => {
    if (codeViewId === src) {
      setCodeViewId(null)
      setCodeEditingId(null)
      return
    }
    setCodeViewId(src)
    setCodeEditingId(null)
    setCodeError(null)
    setCodeSaveNote(null)
    setCodeLoading(true)
    getMetaSourceCode(src)
      .then((r) => {
        if (!r.ok) throw new Error(r.error ?? 'could not read source')
        setCodeText(r.source ?? '')
        setCodeMethod(r.method ?? null)
      })
      .catch((e: Error) => setCodeError(e.message))
      .finally(() => setCodeLoading(false))
  }

  const saveSourceCode = (src: MetaTraderSource) => {
    setCodeSaving(true)
    setCodeError(null)
    saveMetaSourceCode(src, codeText)
      .then((r) => {
        if (!r.ok) throw new Error(r.error ?? 'save failed')
        setCodeSaveNote(r.message ?? 'saved')
        setCodeEditingId(null)
      })
      .catch((e: Error) => setCodeError(e.message))
      .finally(() => setCodeSaving(false))
  }

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
              <CodeAssistBar
                kind="msl"
                currentCode={script}
                onApply={setScript}
                lastError={scriptTestResult && !scriptTestResult.ok ? scriptTestResult.error ?? null : null}
                context={{ asset, tf }}
                className="mt-2"
              />
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
                  <button
                    type="button"
                    onClick={() => setViewSourceId((prev) => (prev === s.id ? null : s.id))}
                    className={`rounded px-1.5 py-0.5 font-mono text-[9px] hover:bg-violet-500/10 ${viewSourceId === s.id ? 'text-violet-300' : 'text-[#aab6cc]'}`}
                  >
                    source
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
                      {c.minConfidence ? ` ${c.op ?? '>='}${c.minConfidence}%` : ''}
                      {s.mode === 'weighted' ? ` w${c.weight ?? 1}` : ''}
                    </span>
                  ))
                )}
              </div>

              {viewSourceId === s.id && (
                <div className="mt-1.5 rounded border border-violet-500/30 bg-[#0b111c] p-1.5">
                  <div className="mb-1 font-mono text-[8px] uppercase tracking-wider text-violet-300">
                    {s.script ? 'source (script-built)' : 'source (auto-generated from dropdown builder)'}
                  </div>
                  <pre className="overflow-x-auto whitespace-pre-wrap font-mono text-[9px] leading-relaxed text-[#aab6cc]">{specSourceCode(s)}</pre>
                </div>
              )}

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

        {/* ---------- built-in Meta Trader sources ---------- */}
        <div className="rounded border border-[#1c2739] bg-[#070c15] p-2">
          <button
            type="button"
            onClick={() => setShowBuiltins((v) => !v)}
            className="flex w-full items-center gap-1.5 text-left"
          >
            <span className="text-[9px] font-bold uppercase tracking-wider text-[#aab6cc]">
              Meta Trader built-in signal sources ({ALL_META_TRADER_SOURCES.length})
            </span>
            <span className="font-mono text-[8.5px] text-[#4b5a72]">
              not saved specs - the hardcoded sources Meta Trader&apos;s own signalSource picker already offers
            </span>
            <span className="ml-auto font-mono text-[9px] text-[#4b5a72]">{showBuiltins ? '▾ hide' : '▸ show'}</span>
          </button>
          {showBuiltins && (
            <div className="mt-2 space-y-1">
              {ALL_META_TRADER_SOURCES.map((src) => (
                <div key={src} className="rounded border border-[#1c2739] bg-[#0b111c] p-1.5">
                  <div className="flex flex-wrap items-center gap-1.5">
                    <span className="font-mono text-[9.5px] font-bold text-[#dbe4f0]">{META_TRADER_SOURCE_LABELS[src]}</span>
                    <span className="rounded border border-amber-500/40 bg-amber-500/10 px-1 py-px font-mono text-[8px] uppercase text-amber-300">built-in</span>
                    <span className="font-mono text-[8px] text-[#4b5a72]">{src}</span>
                    <button
                      type="button"
                      onClick={() => setBuiltinSourceId((prev) => (prev === src ? null : src))}
                      className={`rounded px-1.5 py-0.5 font-mono text-[9px] hover:bg-violet-500/10 ${builtinSourceId === src ? 'text-violet-300' : 'text-[#aab6cc]'}`}
                    >
                      explain
                    </button>
                    <button
                      type="button"
                      onClick={() => loadSourceCode(src)}
                      className={`ml-auto rounded px-1.5 py-0.5 font-mono text-[9px] hover:bg-amber-500/10 ${codeViewId === src ? 'text-amber-300' : 'text-[#aab6cc]'}`}
                    >
                      {codeViewId === src ? 'close code' : 'view/edit code'}
                    </button>
                  </div>
                  {builtinSourceId === src && (
                    <pre className="mt-1.5 overflow-x-auto whitespace-pre-wrap rounded border border-violet-500/30 bg-[#070c15] p-1.5 font-mono text-[9px] leading-relaxed text-[#aab6cc]">
                      {builtinSourceExplainer(src)}
                    </pre>
                  )}
                  {codeViewId === src && (
                    <div className="mt-1.5 rounded border border-amber-500/30 bg-[#070c15] p-1.5">
                      {codeLoading ? (
                        <p className="font-mono text-[9px] text-[#7c8aa5]">loading...</p>
                      ) : codeError && codeEditingId !== src ? (
                        <p className="font-mono text-[9px] text-rose-300">{codeError}</p>
                      ) : (
                        <>
                          {codeMethod && (src === 'smc' || src.startsWith('smc-')) && (
                            <p className="mb-1 font-mono text-[8.5px] text-amber-300">
                              every smc-flavored source shares this ONE method ({codeMethod}()) - editing it changes all of them, not just &quot;{META_TRADER_SOURCE_LABELS[src]}&quot;
                            </p>
                          )}
                          {codeEditingId === src ? (
                            <>
                              <CodeAssistBar
                                kind="meta_source_ts"
                                currentCode={codeText}
                                onApply={setCodeText}
                                lastError={codeError}
                                context={{ id: src, method: codeMethod ?? undefined }}
                                className="mb-1.5"
                              />
                              <textarea
                                value={codeText}
                                onChange={(e) => setCodeText(e.target.value)}
                                rows={16}
                                spellCheck={false}
                                className="w-full resize-y rounded border border-[#1c2739] bg-[#0b111c] p-2 font-mono text-[9.5px] leading-relaxed text-[#dbe4f0] outline-none focus:border-amber-500/40"
                              />
                              {codeError && <p className="mt-1 font-mono text-[9px] text-rose-300">{codeError}</p>}
                              <div className="mt-1.5 flex items-center gap-1.5">
                                <Button
                                  size="sm"
                                  disabled={codeSaving}
                                  className="h-6 bg-amber-600 px-2 text-[9px] font-bold uppercase tracking-wider text-white hover:bg-amber-500 disabled:opacity-50"
                                  onClick={() => saveSourceCode(src)}
                                >
                                  {codeSaving ? 'saving...' : 'save changes'}
                                </Button>
                                <Button
                                  variant="outline"
                                  size="sm"
                                  className="h-6 border-[#1c2739] px-2 text-[9px] uppercase text-[#7c8aa5]"
                                  onClick={() => {
                                    setCodeEditingId(null)
                                    setCodeError(null)
                                  }}
                                >
                                  cancel
                                </Button>
                                <span className="font-mono text-[8.5px] text-[#4b5a72]">takes effect after the kernel restarts - backed up first</span>
                              </div>
                            </>
                          ) : (
                            <>
                              <pre className="max-h-64 overflow-auto font-mono text-[9.5px] leading-relaxed text-[#dbe4f0]">{codeText}</pre>
                              <div className="mt-1.5 flex items-center gap-1.5">
                                <Button
                                  variant="outline"
                                  size="sm"
                                  className="h-6 border-amber-500/40 px-2 text-[9px] uppercase text-amber-300 hover:bg-amber-500/10"
                                  onClick={() => {
                                    setCodeEditingId(src)
                                    setCodeSaveNote(null)
                                  }}
                                >
                                  edit
                                </Button>
                                {codeSaveNote && <span className="font-mono text-[8.5px] text-emerald-300">{codeSaveNote}</span>}
                              </div>
                            </>
                          )}
                        </>
                      )}
                    </div>
                  )}
                </div>
              ))}
            </div>
          )}
        </div>
      </div>

      <p className="border-t border-[#1c2739] px-2 py-1 text-[8.5px] leading-relaxed text-[#3d4d66]">
        Reads each panel&apos;s own current verdict (Oracle/HMA-ROC-Bull-Bear/Momentum Score/Accute, every chart engine - Renko/Point &amp; Figure/Range Bars - and SMC,
        including per-kind SMC &quot;now&quot; reads and the Renko+SMC confluence) - never recomputes from candles itself, it only reads what each engine already
        computed. Build with the dropdown builder or the code editor (Meta Strategy Lab&apos;s own strategy language - sandboxed, no loops/I-O/raw candles). Pick a
        saved strategy as the auto-trader&apos;s signal source (Autopilot panel → Meta-Strategy) to trade it live.
      </p>
    </div>
  )
}
