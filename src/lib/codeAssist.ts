// IQAIR//OS - shared backend for "invoke the AI" in every code editor
// (Meta Strategy Lab's script editor, Meta Strategy's built-in-source
// editor, the Strategy Lab's builtin.ts editor, AI Lab's script editor).
// Per direct instruction: "we should be able to invoke the ai and describe
// it so it will build the strat, also we can build ourself, if any error,
// we can have the ai scan and fix" - one shared prompt-building module, one
// API route (src/app/api/code_assist/route.ts), one small UI component
// (components/os/CodeAssistBar.tsx) reused by all four editors, each just
// passing its own `kind` so the system prompt matches the exact language/
// shape that editor actually edits. Two modes:
//   'build' - describe what you want in plain English, get a full
//             replacement for the editor's contents
//   'fix'   - hand back the editor's current (broken) contents plus the
//             error message a test/save just produced, get a corrected
//             version
// Never auto-saves anything - every result lands back in the SAME editor
// textarea the user was already looking at, so the existing test/save
// buttons (and the safety nets behind them: MSL's own parser, Bun.
// Transpiler's syntax check for the two real-TypeScript kinds) are still
// the thing that actually validates and persists it.
import type { ChatMessage } from './llm'

export type CodeAssistKind = 'msl' | 'ai_lab_script' | 'builtin_strategy_ts' | 'meta_source_ts'

export interface CodeAssistRequest {
  kind: CodeAssistKind
  mode: 'build' | 'fix'
  /** What the user wants built/changed (mode 'build'), or left as extra
   * guidance alongside the error (mode 'fix', optional either way). */
  instruction?: string
  /** The editor's current contents - the thing being extended/fixed. */
  currentCode?: string
  /** The error message a test/save call just returned (mode 'fix'). */
  error?: string
  /** Free-form context the caller already has handy (asset/tf/method name/
   * strategy id/etc.) - folded into the user message, not the system
   * prompt, so it reads as "here's what I'm working with" rather than
   * changing the rules for the kind. */
  context?: Record<string, string | number | undefined>
}

const MSL_GRAMMAR = `Meta Strategy Lab's own script language ("MSL") - a small, safe, line-oriented language, NOT general-purpose code:
  let <name> = <expr>          bind an intermediate value for reuse
  call when <boolExpr>         sets the CALL verdict if true (REQUIRED - every script needs this line)
  put when <boolExpr>          sets the PUT verdict if true (REQUIRED)
  confidence = <numExpr>       overrides the default confidence, clamped 0-100 (REQUIRED)
'#' starts a comment to end-of-line. Blank lines ignored.
Expressions (low to high precedence): or < and < not < comparisons (== != >= <= > <) < + - < * / < unary - < atoms.
Atoms: number literals, true/false, call/put/none (direction literals), string literal '...'/"...", an identifier (a source name or a let-binding), identifier.field, '(' expr ')', a function call.
Functions: avg(...) sum(...) min(...) max(...) count(...) abs(x) - all take 1+ numeric/boolean args.
Field access on any source or function-call result: .dir / .direction (call/put/none), .conf / .confidence (0-100), .active (true if dir != none), .call / .put (true if dir equals that side).
Sandboxed on purpose: no loops, no function definitions, no I/O, no raw candle access - only reads, and/or/not/comparisons/arithmetic, and assignment to call/put/confidence.`

const MSL_SOURCES = `Named sources this script can read (each exposes .dir/.conf/.active/.call/.put): oracle, hmaRocBullBear, momentumScore, accute, renko, pointFigure, rangeBars, candle, bar, heikinAshi, line, area, baseline, volumeBars, tick, footprint, tpo, ivHv, smc (aggregate across all 15 SMC concepts, "now" only), smcNow (same aggregate, explicit name), renkoSmc (renko trend + any one SMC concept agreeing), renkoSmcMajority (renko trend + SMC's own majority verdict agreeing), and smc:<KIND> for one specific SMC concept by name (e.g. smc:FVG, smc:BOS, smc:ORDER_BLOCK, smc:LIQUIDITY_SWEEP - KIND is written directly after the colon, not quoted, not a function argument). Every one of these reads a live PANEL VERDICT - it never recomputes from raw candles itself.`

const AI_LAB_FUNCS = `This editor speaks the SAME MSL grammar (let/call when/put when/confidence, same operators, same field access), but instead of named panel-read sources it calls SIGNAL FUNCTIONS over raw candle patterns/indicators - the AI Lab's own vocabulary, each one returning a read you field-access exactly like a named source (e.g. candle('Bullish Engulfing', call, 70).active). Every function's args end with an optional confidence (0-100, default 65) and the read reports .dir 'none' when the signal didn't fire on the current bar:
  candle(name, dir, conf?, series?)              - a candlestick pattern by its library name (e.g. 'Bullish Engulfing', 'Bearish Engulfing', 'Doji', 'Hammer'...), series 'heikin' reads it on the Heikin-Ashi transform instead of raw candles
  bar('wide-bull'|'wide-bear', dir, conf?, atrK?) - a wide-range bar (atrK = ATR multiple that counts as "wide", default per the builtin)
  ha(variant, dir, conf?, len?)                  - a Heikin-Ashi structure: variant one of flip-up|flip-down|streak-up|streak-down|strong-bull|strong-bear
  line(variant, dir, conf?, lookback?)           - variant one of breakout-up|breakout-down|hh-hl|lh-ll (Donchian breakout / higher-highs-lows run)
  renko(variant, dir, conf?, len?)               - variant one of flip-up|flip-down|streak-up|streak-down (young brick-trend reversal vs N same-color streak)
  pf(variant, dir, conf?, reversalBoxes?)        - variant one of double-top-breakout|double-bottom-breakdown|triple-top-breakout|triple-bottom-breakdown (Point & Figure breakout, fires only on the box-painting bar)
  mtf(5|15, dir, conf?)                          - multi-timeframe EMA(8/21) alignment resampled to that factor (ONLY 5 or 15 are valid)
  indicator(ind, op, threshold, dir, conf?, threshold2?) - ind one of rsi|bbpos|zscore|donchianpos|macdz|slope|streak|wickbias|emasign|hadist|bodypos|psar|fractal, op '>' or '<'
  indicatorType(ind, type, op, threshold, dir, conf?, threshold2?) - ind one of the 8 generic families (madist|osc0100|oscpm100|oscz|trenddist|bandpos|volflow|levels), type picks the specific indicator inside that family (e.g. madist+'hma', osc0100+'stochk', trenddist+'supertrend')
  indicatorPeriod(ind, period, op, threshold, dir, conf?, threshold2?) - same ind set as indicator(), with an explicit lookback period
  builtinSig(id, dir, conf?)                     - votes an entire builtin.ts strategy (by its id) as one signal
  engine(engineId, dir, conf?)                   - a chart-engine committee vote
Field access on every one of these calls: .dir, .conf, .active, .call, .put - identical to a named Meta-Strategy source.`

const BUILTIN_STRATEGY_SHAPE = `trading-core/src/strategies/builtin.ts - ONE array-element object literal from the STRATEGIES: StrategyDef[] array (real compiled TypeScript, NOT a sandboxed language). The shape (every field required):
  {
    id: 'kebab-case-unique-id',       // NEVER change this on a fix - renaming orphans anything already trading the old id
    name: 'Human Readable Name',
    description: 'One sentence describing the entry/exit logic in plain English.',
    params: [ { key: 'period', label: 'RSI period', type: 'number', min: 5, max: 40, default: 14 }, /* ...more */ ],
    evaluate: (candles, p, hints?) => {
      // candles: Candle[] ({time, open, high, low, close, volume}), oldest-first, p: Record<string, number|string> (the resolved params)
      // return { direction: 'call'|'put'|'none', score: number (0-100), notes: string }
      return { direction: 'none', score: 0, notes: '...' }
    },
  }
Only use functions/helpers that are ALREADY imported at the top of builtin.ts (ta.* from analytics/indicators, plus quant/patterns/kalman/vsk/tsk/engine/chart-patterns/orderflow/renko/pointfigure/rangebars/volumebars/footprint/tpo/ivhv/chartsignals helpers already imported there - assume the common ones like ta.rsi/ta.ema/ta.macd/ta.bollinger/ta.adx exist, same as the examples below) plus a local num(p, key, fallback) / clamp(v, lo, hi) / last(arr) convention already used throughout the file - NEVER invent a new top-level import, this is a single extracted block spliced back into the middle of an existing file verbatim. Two real examples from the same file, to match style exactly:
{
  id: 'rsi-reversion',
  name: 'RSI Mean Reversion',
  description: 'Fades RSI extremes: CALL when RSI dips below the oversold threshold, PUT above overbought.',
  params: [
    { key: 'period', label: 'RSI period', type: 'number', min: 5, max: 40, default: 14 },
    { key: 'oversold', label: 'Oversold level', type: 'number', min: 10, max: 45, default: 30 },
    { key: 'overbought', label: 'Overbought level', type: 'number', min: 55, max: 90, default: 70 },
  ],
  evaluate: (candles, p) => {
    const r = last(ta.rsi(candles.map((c) => c.close), num(p, 'period', 14)))
    const os = num(p, 'oversold', 30)
    const ob = num(p, 'overbought', 70)
    if (r < os) return { direction: 'call', score: clamp((os - r) * 4, 40, 100), notes: \`RSI \${r.toFixed(1)} below \${os}\` }
    if (r > ob) return { direction: 'put', score: clamp((r - ob) * 4, 40, 100), notes: \`RSI \${r.toFixed(1)} above \${ob}\` }
    return { direction: 'none', score: 0, notes: \`RSI \${r.toFixed(1)} neutral\` }
  },
},
{
  id: 'ema-trend',
  name: 'EMA Trend Rider',
  description: 'Trades with the trend when fast EMA is over slow EMA and ADX confirms strength.',
  params: [
    { key: 'fast', label: 'Fast EMA', type: 'number', min: 5, max: 30, default: 9 },
    { key: 'slow', label: 'Slow EMA', type: 'number', min: 15, max: 100, default: 21 },
    { key: 'adx', label: 'ADX filter', type: 'number', min: 10, max: 40, default: 20 },
  ],
  evaluate: (candles, p) => {
    const c = candles.map((k) => k.close)
    const fast = last(ta.ema(c, num(p, 'fast', 9)))
    const slow = last(ta.ema(c, num(p, 'slow', 21)))
    const adxV = last(ta.adx(candles.map((k) => k.high), candles.map((k) => k.low), c).adx)
    if (Number.isNaN(fast) || Number.isNaN(slow) || Number.isNaN(adxV)) return { direction: 'none', score: 0, notes: 'warming up' }
    const bull = fast > slow
    return { direction: bull ? 'call' : 'put', score: clamp(40 + adxV, 40, 95), notes: \`\${bull ? 'Bull' : 'Bear'} stack, ADX \${adxV.toFixed(1)}\` }
  },
},`

const META_SOURCE_SHAPE = `trading-core/src/plugins/metatrader.ts - ONE private method on the MetaTraderService class (real compiled TypeScript, NOT a sandboxed language), of the exact shape \`private pickXxx(): MetaTraderRow[] { ... }\` (some variants, like pickSmc, take one typed param). MetaTraderRow is \`{ asset: string; name: string; category: AssetCategory; otc: boolean; price: number; direction: 'call'|'put'; confidence: number; note: string }\`. Available on \`this\` inside the class (already used throughout the file - do not invent anything new): this.candidatePool() (iterable of asset tickers to scan), this.config (the live MetaTraderConfig: tf, minConfidence, direction, etc.), this.ctx.use<SomeService>('serviceName') (reach another plugin, wrapped in try/catch since it may not be loaded), this.rowFrom(asset, direction, confidence, price, note) (builds a MetaTraderRow, returns null if the asset/price lookup fails), this.rankRows(rows) (confidence-desc, least-recently-traded tiebreak) or this.rankByRecency(rows) (for SMC-flavored sources, which don't have a reliable confidence to rank by), this.assetInfo(asset), finGte(a, b) (a top-level helper, finite->=). A real example from the same file, to match style exactly:
private pickOracle(): MetaTraderRow[] {
  let oracle: NextCandleService
  try {
    oracle = this.ctx.use<NextCandleService>('nextcandle')
  } catch {
    return []
  }
  const out: MetaTraderRow[] = []
  for (const asset of this.candidatePool()) {
    try {
      const pred = oracle.predict(asset, this.config.tf)
      if (!pred || pred.direction === 'none') continue
      if (this.config.direction !== 'both' && pred.direction !== this.config.direction) continue
      if (!finGte(pred.confidence, this.config.minConfidence)) continue
      const row = this.rowFrom(asset, pred.direction, pred.confidence, pred.price, \`oracle: pUp \${(pred.pUp * 100).toFixed(0)}%\`)
      if (row) out.push(row)
    } catch {
      /* thin history - try the next */
    }
  }
  return this.rankRows(out)
}
NEVER rename the method - whatever name the current code (or the context) says this method must keep, keep it exactly; pickCandidates()'s own dispatch table calls these methods by name.`

function systemPromptFor(kind: CodeAssistKind): string {
  const shared =
    'You are a precise code-generation assistant embedded in a trading platform\'s live code editor. You write ONLY the one code block the editor holds - never a whole file, never surrounding context, never markdown fences around it. Respond with a single JSON object: {"code": "<the complete replacement text for the editor, exactly as it should be pasted in>", "explanation": "<one or two plain-English sentences on what you built/changed, for the user>"}. No other text outside that JSON object.'
  if (kind === 'msl') return `${shared}\n\n${MSL_GRAMMAR}\n\n${MSL_SOURCES}\n\nWrite a complete script: it MUST include at least one \`call when\`, one \`put when\`, and a \`confidence =\` line, using \`let\` bindings for readability when the logic has more than one or two pieces.`
  if (kind === 'ai_lab_script') return `${shared}\n\n${MSL_GRAMMAR}\n\n${AI_LAB_FUNCS}\n\nWrite a complete script: it MUST include at least one \`call when\`, one \`put when\`, and a \`confidence =\` line.`
  if (kind === 'builtin_strategy_ts') return `${shared}\n\n${BUILTIN_STRATEGY_SHAPE}\n\nWrite exactly one such object literal (including its own braces), nothing else - it gets spliced back into the array in place of whatever was there.`
  return `${shared}\n\n${META_SOURCE_SHAPE}\n\nWrite exactly one such method (signature through its closing brace), nothing else - it gets spliced back into the class in place of whatever was there.`
}

export function buildCodeAssistMessages(req: CodeAssistRequest): ChatMessage[] {
  const system = systemPromptFor(req.kind)
  const ctxLines = Object.entries(req.context ?? {})
    .filter(([, v]) => v !== undefined && v !== '')
    .map(([k, v]) => `${k}: ${v}`)
  const parts: string[] = []
  if (ctxLines.length) parts.push(`Context:\n${ctxLines.join('\n')}`)
  if (req.mode === 'fix') {
    parts.push(
      `The user's current code produced an error when tested/saved. Find and fix the bug(s) - keep everything else about their intent intact (same ids/method names/overall approach) unless the error itself forces a structural change.`,
    )
    parts.push(`Current code:\n${req.currentCode ?? '(empty)'}`)
    parts.push(`Error:\n${req.error ?? '(no error message given)'}`)
    if (req.instruction?.trim()) parts.push(`Additional guidance from the user:\n${req.instruction.trim()}`)
  } else {
    parts.push(`Build/update this code to do the following:\n${req.instruction?.trim() || '(no description given - use the context above to make a reasonable, useful strategy)'}`)
    if (req.currentCode?.trim()) parts.push(`Current code to start from/modify (empty if starting fresh):\n${req.currentCode}`)
  }
  return [
    { role: 'system', content: system },
    { role: 'user', content: parts.join('\n\n') },
  ]
}

export function parseCodeAssistReply(raw: string): { code: string; explanation: string } {
  const trimmed = raw.trim()
  try {
    const parsed = JSON.parse(trimmed) as { code?: unknown; explanation?: unknown }
    if (typeof parsed.code === 'string') {
      return { code: parsed.code, explanation: typeof parsed.explanation === 'string' ? parsed.explanation : '' }
    }
  } catch {
    /* model didn't return clean JSON - fall through to a best-effort salvage below */
  }
  // Best-effort salvage: the model sometimes wraps JSON in a markdown fence,
  // or (rarely) ignores the JSON instruction and returns the code directly
  // (possibly itself fenced). Try a fenced JSON block first, then a fenced
  // code block, then give up and treat the whole reply as the code.
  const fencedJson = /```(?:json)?\s*([\s\S]*?)```/.exec(trimmed)
  if (fencedJson) {
    try {
      const parsed = JSON.parse(fencedJson[1].trim()) as { code?: unknown; explanation?: unknown }
      if (typeof parsed.code === 'string') {
        return { code: parsed.code, explanation: typeof parsed.explanation === 'string' ? parsed.explanation : '' }
      }
    } catch {
      /* not JSON either - the fenced block itself is probably the code */
      return { code: fencedJson[1].trim(), explanation: '' }
    }
  }
  const anyFence = /```[a-z]*\n?([\s\S]*?)```/.exec(trimmed)
  if (anyFence) return { code: anyFence[1].trim(), explanation: '' }
  return { code: trimmed, explanation: '' }
}
