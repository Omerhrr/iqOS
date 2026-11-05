// IQAIR//OS - translates an AI Lab signals[] spec into Meta-Strategy
// Lab's own script language (MSL), so "the strategy lab is still using
// json... meta strategy language is the new language we are using" per
// direct instruction has a real answer even for a spec the LEARNER
// produced (signals[]/weights), not just one someone hand-writes: this
// generates an MSL script equivalent to evaluateCustomAt's own weighted-
// vote math, using the EXACT same signal functions
// trading-core/src/strategies/signalscript.ts resolves (candle/bar/ha/
// line/renko/pf/indicator/mtf/builtinSig/engine), so every saved spec -
// learned or hand-built - can be viewed, edited and saved as this ONE
// language from here on, with JSON as a fallback view rather than the
// default.
import type { LabSignalDef, LabSpec } from '@/lib/os/client'

function confFromWeight(weight: number): number {
  // weight is 1..50 (see CustomSpec's own doc comment); map onto a
  // 0-100 confidence the same proportional way the spec's own comment
  // describes the weight itself ("proportional to the measured edge").
  return Math.max(1, Math.min(100, Math.round((weight / 50) * 100)))
}

/** One signal -> its MSL function call text (see signalscript.ts for the
 * exact resolver these map to - argument order and names match exactly).
 * `group` is the one kind that ISN'T a function call - it's a boolean
 * combination of its members' `.active` fields, built inline. */
function callFor(s: LabSignalDef): string {
  const conf = confFromWeight(s.weight)
  switch (s.kind) {
    case 'candle':
      return `candle('${s.name.replace(/'/g, "\\'")}', ${s.dir}, ${conf}${s.series === 'heikin' ? ", 'heikin'" : ''})`
    case 'bar':
      return `bar('${s.variant}', ${s.dir}, ${conf}${s.atrK !== undefined ? `, ${s.atrK}` : ''})`
    case 'ha':
      return `ha('${s.variant}', ${s.dir}, ${conf}${s.len !== undefined ? `, ${s.len}` : ''})`
    case 'line':
      return `line('${s.variant}', ${s.dir}, ${conf}${s.lookback !== undefined ? `, ${s.lookback}` : ''})`
    case 'renko':
      return `renko('${s.variant}', ${s.dir}, ${conf}${s.len !== undefined ? `, ${s.len}` : ''})`
    case 'pf':
      return `pf('${s.variant}', ${s.dir}, ${conf}${s.reversalBoxes !== undefined ? `, ${s.reversalBoxes}` : ''})`
    case 'mtf':
      return `mtf(${s.factor}, ${s.dir}, ${conf})`
    case 'indicator': {
      const t2 = s.threshold2 !== undefined ? `, ${s.threshold2}` : ''
      if (s.type) return `indicatorType('${s.ind}', '${s.type}', '${s.op}', ${s.threshold}, ${s.dir}, ${conf}${t2})`
      const period = s.params?.period
      if (period !== undefined) return `indicatorPeriod('${s.ind}', ${period}, '${s.op}', ${s.threshold}, ${s.dir}, ${conf}${t2})`
      return `indicator('${s.ind}', '${s.op}', ${s.threshold}, ${s.dir}, ${conf}${t2})`
    }
    case 'builtin':
      return `builtinSig('${s.id}', ${s.dir}, ${conf})`
    case 'engine':
      return `engine('${s.engine}', ${s.dir}, ${conf})`
    case 'group':
      return `(${s.signals.map((m) => `${callFor(m)}.active`).join(s.op === 'and' ? ' and ' : ' or ')})`
  }
}

/** Faithful translation of evaluateCustomAt's own weighted-vote math:
 *   bullW = sum of active CALL signals' weights, bearW = same for PUT
 *   score = 100 * (bullW - bearW) / (bullW + bearW)     (0 when nothing fired)
 *   fires when |score| >= minScore AND the winning side has >= minVotes
 *   distinct active signals behind it (the confluence guard)
 * - same numbers the JSON spec always produced, just expressed as a
 * script instead of as weights baked into a signals[] array. */
export function signalsToScript(spec: LabSpec): string {
  if (!spec.signals.length) {
    return `# ${spec.name} - no signals to translate (empty spec)\ncall when false\nput when false\n`
  }
  const lines: string[] = [`# ${spec.name} - auto-generated from this spec's signals[] (same weighted-vote math evaluateCustomAt always used)`]
  const callNames: string[] = []
  const putNames: string[] = []
  spec.signals.forEach((s, i) => {
    const name = `sig${i}`
    lines.push(`let ${name} = ${callFor(s)}`)
    if (s.dir === 'call') callNames.push(name)
    else putNames.push(name)
  })
  const callWeighted = spec.signals
    .map((s, i) => ({ name: `sig${i}`, dir: s.dir, weight: s.weight }))
    .filter((x) => x.dir === 'call')
    .map((x) => `${x.name}.active * ${Math.max(1, Math.min(50, Math.round(x.weight)))}`)
  const putWeighted = spec.signals
    .map((s, i) => ({ name: `sig${i}`, dir: s.dir, weight: s.weight }))
    .filter((x) => x.dir === 'put')
    .map((x) => `${x.name}.active * ${Math.max(1, Math.min(50, Math.round(x.weight)))}`)
  lines.push(`let bullW = ${callWeighted.length ? `sum(${callWeighted.join(', ')})` : '0'}`)
  lines.push(`let bearW = ${putWeighted.length ? `sum(${putWeighted.join(', ')})` : '0'}`)
  lines.push(`let score = (bullW - bearW) / (bullW + bearW) * 100`)
  if (callNames.length) lines.push(`let bullVotes = count(${callNames.map((n) => `${n}.active`).join(', ')})`)
  if (putNames.length) lines.push(`let bearVotes = count(${putNames.map((n) => `${n}.active`).join(', ')})`)
  const minScore = spec.minScore
  const minVotes = spec.minVotes
  lines.push(
    `call when score >= ${minScore}${callNames.length ? ` and bullVotes >= ${minVotes}` : ''}`,
    `put when score <= -${minScore}${putNames.length ? ` and bearVotes >= ${minVotes}` : ''}`,
    `confidence = abs(score)`,
  )
  return lines.join('\n') + '\n'
}
