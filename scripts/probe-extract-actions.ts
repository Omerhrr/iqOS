// unit probe for extractActions + ui_control arg tolerance (mirrors route logic)
const CHART_TYPES = ['candles', 'hollow', 'bars', 'line', 'area', 'baseline', 'heikin-ashi', 'renko']

function topJsonObjects(text: string): string[] {
  const out: string[] = []
  let depth = 0
  let start = -1
  let inStr = false
  let esc = false
  for (let i = 0; i < text.length; i++) {
    const c = text[i]
    if (inStr) {
      if (esc) esc = false
      else if (c === '\\') esc = true
      else if (c === '"') inStr = false
      continue
    }
    if (c === '"') {
      if (depth > 0) inStr = true
      continue
    }
    if (c === '{') {
      if (depth === 0) start = i
      depth++
    } else if (c === '}') {
      depth--
      if (depth === 0 && start >= 0) {
        out.push(text.slice(start, i + 1))
        start = -1
      }
    }
  }
  return out
}

type Action = { action: string; args?: Record<string, unknown>; say?: string }

function extractActions(text: string): Action[] {
  const cleaned = text.replace(/```json|```/g, '')
  const res: Action[] = []
  for (const s of topJsonObjects(cleaned)) {
    try {
      const p = JSON.parse(s) as Record<string, unknown>
      if (!p || typeof p !== 'object' || typeof p.action !== 'string') continue
      const { action, args: a, say, ...rest } = p
      let args: Record<string, unknown>
      if (typeof a === 'string') {
        try {
          const parsed = JSON.parse(a) as unknown
          args = parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? (parsed as Record<string, unknown>) : { value: a }
        } catch {
          args = { value: a }
        }
      } else if (a && typeof a === 'object' && !Array.isArray(a)) {
        args = { ...rest, ...(a as Record<string, unknown>) }
      } else if (rest && Object.keys(rest).length) {
        args = rest
      } else {
        args = {}
      }
      res.push({ action: action as string, args, say: typeof say === 'string' ? say : undefined })
    } catch {
      /* skip */
    }
  }
  return res
}

// --- the exact raw replies observed from the model ---
const cases = [
  // 1: flat args (observed bug)
  '\n{"action":"ui_control","cmd":"set_tf","tf":"15m"}',
  // 2: batch of nested + flat
  '{"action": "ui_control", "args": {"cmd": "set_asset", "asset": "BTCUSD"}, "say": "Switching"}\n{"action":"ui_control","cmd":"set_chart_type","chartType":"heikin ashi"}',
  // 3: stringified args
  '{"action":"ui_control","args":"{\\"cmd\\":\\"add_indicator\\",\\"id\\":\\"macd\\",\\"pane\\":\\"sub\\"}"}',
  // 4: missing cmd but inferable
  '{"action":"ui_control","asset":"BTCUSD","tf":"5m"}',
  // 5: say containing escaped braces must not confuse scanner
  '{"action": "final", "say": "use {\\"cmd\\": \\"x\\"} carefully"}',
  // 6: markdown fence + prose
  'Here you go:\n```json\n{"action":"ui_control","cmd":"clear_indicators"}\n```',
]

for (const [i, c] of cases.entries()) {
  const acts = extractActions(c)
  console.log(`case ${i + 1}:`, JSON.stringify(acts))
}

// assertions
const a1 = extractActions(cases[0])[0]
console.assert(a1?.action === 'ui_control' && (a1?.args as any)?.cmd === 'set_tf' && (a1?.args as any)?.tf === '15m', 'case1 FAIL')
const a2 = extractActions(cases[1])
console.assert(a2.length === 2 && a2[0].args?.asset === 'BTCUSD' && a2[1].args?.chartType === 'heikin ashi', 'case2 FAIL')
const a3 = extractActions(cases[2])[0]
console.assert(a3?.args?.id === 'macd' && a3?.args?.pane === 'sub', 'case3 FAIL')
const a4 = extractActions(cases[3])[0]
console.assert(a4?.args?.asset === 'BTCUSD' && a4?.args?.tf === '5m', 'case4 FAIL')
const a5 = extractActions(cases[4])
console.assert(a5.length === 1 && a5[0].action === 'final' && a5[0].say?.includes('"cmd"'), 'case5 FAIL: ' + JSON.stringify(a5))
const a6 = extractActions(cases[5])
console.assert(a6.length === 1 && a6[0].args?.cmd === 'clear_indicators', 'case6 FAIL')
console.log('all parser cases done')
