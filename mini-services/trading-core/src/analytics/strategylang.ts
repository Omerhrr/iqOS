// IQAIR//OS - Meta Strategy Lab's own strategy language ("MSL")
//
// Per direct instruction: "i thought we build a way to write a strat using
// json in meta strategy... instead of using json, lets create our own
// strategy language, that we can use to achieve almost everything." The
// dropdown-built MetaStrategySpec (conditions[] + mode: all/any/weighted,
// see analytics/metastrategy.ts) stays the default, simple path - this
// module is the alternative, more expressive path: a small, safe, line-
// based language that reads the SAME panel verdicts (Oracle, HMA/ROC/
// Bull-Bear, Momentum Score, Accute, Renko, SMC's blended summary, SMC
// "now" aggregate and per-kind, and the Renko+SMC confluence) and combines
// them with real boolean/arithmetic logic instead of a fixed combine mode.
//
// Still deliberately NOT an arbitrary scripting language - same reasoning
// analytics/metastrategy.ts's own module header gives for the JSON spec:
// handing a live trading loop something that can do I/O, loop unboundedly,
// or reach outside its sandbox is a 1000x bigger blast radius than the
// payoff. This language can only read named sources' .dir/.conf/.active/
// .call/.put, combine them with and/or/not/comparisons/arithmetic, and
// assign the result to `call`/`put`/`confidence` - there is no loop, no
// function definition, no I/O, no way to reach anything but the `reads`
// map the caller hands in. Evaluation is pure and terminates in O(script
// length) - no unbounded recursion, no host object ever exposed.
//
// Grammar (line-oriented; '#' to end-of-line is a comment; blank lines
// ignored):
//   let <name> = <expr>          bind an intermediate value for reuse
//   call when <boolExpr>         sets the CALL verdict if true
//   put when <boolExpr>          sets the PUT verdict if true
//   confidence = <numExpr>       optional - overrides the default 0-100
//                                 confidence (clamped); may appear once
//   expiry = <numExpr>           optional - the expiry this script PREFERS
//                                 for its trade, whole minutes (clamped 1-60;
//                                 1/2/3/5/15 are the rungs the engines
//                                 actually price). Evaluated only when a side
//                                 actually fired, like confidence. Surfaces
//                                 as MslEvalResult.expiryMin for the caller.
//   configure <a.b> = <expr>     optional, repeatable - per-script overrides
//                                 for HOW a source computes its read (chart
//                                 engine knobs like renko.atrMult = 0.5,
//                                 pf.reversalBoxes = 4, tpo.periodSec = 900,
//                                 strategy param overrides like
//                                 strategy.ema-cross.fast = 5). Paths are
//                                 dotted identifiers (at least one dot); the
//                                 CALLER owns the whitelist - unknown keys or
//                                 out-of-range values are a script ERROR (fail
//                                 closed), never silently ignored. Collected
//                                 into MslEvalResult.configs (last write wins
//                                 per key).
//
// Expressions (standard precedence, low to high):
//   or  <  and  <  not  <  comparisons (== != >= <= > <)  <  + -  <  * /
//   <  unary -  <  atoms
// Atoms: number literals, true/false, call/put/none (direction literals,
// also valid as bare identifiers), string literal '...'/"...", identifier
// (a source key the caller provided in `reads`, or a `let` binding),
// identifier '.' field (field in dir/direction/conf/confidence/active/
// call/put/value - 'value' is the source's own headline NUMBER in its
// native scale, e.g. the next-expiry rung's pWin 0..1 or renko's signed
// streak; 0 when a source has none), '(' expr ')', func(args...) where
// func in {avg, sum, min, max, count, abs, if, clamp, round, floor, ceil,
// sign, sqrt, pow, mod}.
//
// Source identifiers may contain ':' (e.g. `smc:FVG`, `smc:now`) - the
// caller (plugins/metastrategy.ts) builds the `reads` map with exactly the
// keys a script is allowed to reference: 'oracle', 'hmaRocBullBear',
// 'momentumScore', 'accute', 'renko', 'pointFigure', 'rangeBars', 'candle',
// 'bar', 'heikinAshi', 'line', 'area', 'baseline', 'volumeBars', 'tick',
// 'footprint', 'tpo', 'ivHv', 'smc', 'smcNow', 'renkoSmc',
// 'renkoSmcMajority', the tick-desk engines 'tickSmc', 'tickOracle',
// 'tickTechnical', 'tickFootprint' (raw micro-tick reads), 'nextExpiry'
// (the Next-Expiry Oracle's best pick, honesty-floored) plus
// 'nextExpiry:<E>' for each ladder rung (nextExpiry:1/2/3/5/15 - same ':'
// convention), the pinned tick-desk buckets 'tickOracle:<SEC>' /
// 'tickTechnical:<SEC>' (SEC = one of 1/2/3/5/15/30/60/120/180/300), and
// 'smc:<KIND>' for each of the 15 SMC concepts (smcNowRead() per kind) -
// "any of the smcs" per direct instruction, without needing 15 new
// MetaConditionSource union members. 'pointFigure'/
// 'rangeBars' are the same "not just renko - p&f, range and all others as
// we see fit" instruction: every chart engine this codebase already keeps
// as its own pure module (analytics/renko.ts, pointfigure.ts, rangebars.ts)
// is reachable from a script the same way, so a new chart type only ever
// needs a new `reads` key here, never a language change.

export interface MslSourceRead {
  direction: 'call' | 'put' | 'none'
  confidence: number // 0..100
  /** OPTIONAL: the source's own headline numeric metric, in its native scale
   * (documented per source by whoever builds the reads map - e.g. a
   * next-expiry rung reports pWin 0..1, the tick oracle its walk-forward
   * score, renko its signed streak). Exposed to scripts as the `.value`
   * field; a source without a headline number omits it and `.value`
   * honestly reads 0. */
  value?: number
}

/** A source read, tagged so it's distinguishable from a plain string at
 * runtime (MslValue has no other object variant). Both the caller's static
 * `reads` map AND a signal-function call (see MslSignalResolver below) now
 * produce this SAME shape, so `.dir`/`.conf`/etc. work identically either
 * way - "oracle.dir" and "candle('Bullish Engulfing', call).dir" are the
 * same kind of thing to the evaluator. */
export interface MslReadValue extends MslSourceRead {
  readonly __mslRead: true
}

function readValue(r: MslSourceRead): MslReadValue {
  return {
    __mslRead: true,
    direction: r.direction,
    confidence: r.confidence,
    ...(r.value !== undefined && Number.isFinite(r.value) ? { value: r.value } : {}),
  }
}

function isReadValue(v: unknown): v is MslReadValue {
  return typeof v === 'object' && v !== null && (v as MslReadValue).__mslRead === true
}

export type MslValue = number | boolean | string | MslReadValue

/** Resolves a function call the core language doesn't itself know (i.e.
 * not one of avg/sum/min/max/count/abs) into a source read - this is how
 * AI Lab's signal vocabulary (candle/bar/ha/line/renko/pf/indicator/...,
 * see strategies/signalscript.ts) plugs into the SAME language Meta-
 * Strategy already uses, without this module needing to know anything
 * about candles, indicators, or any other domain - it just asks the
 * caller "what does this call resolve to right now" and gets back a
 * direction+confidence, exactly like a named `reads` entry. Args are
 * already-evaluated plain values (never another read - see the guard in
 * evalExpr's 'call' case); the resolver throws to fail the whole script
 * evaluation (caught the same way any other runtime error is), or returns
 * a read normally. */
export type MslSignalResolver = (fn: string, args: (number | boolean | string)[]) => MslSourceRead

export interface MslEvalResult {
  direction: 'call' | 'put' | 'none'
  confidence: number // 0..100
  /** set by an "expiry = <minutes>" statement (whole minutes, clamped 1-60)
   * - the caller decides what to do with the script's preferred horizon
   * (Meta Trader surfaces it in its eval result; the engines' own honesty
   * gates still apply on top of it). */
  expiryMin?: number
  /** collected "configure <key> = <value>" statements (last write wins) -
   * the CALLER validates every key against its own whitelist and applies
   * them when building the reads; unknown keys fail the script closed. */
  configs?: Record<string, number | boolean | string>
  /** human-readable evaluation trace - which when-clauses fired, final
   * confidence source - surfaced in the Meta Strategy Lab's test panel so
   * a script's behavior is inspectable, not a black box. */
  trace: string[]
  error?: string
}

// ---------- tokenizer ----------

type TokKind =
  | 'num' | 'str' | 'ident' | 'dot' | 'comma' | 'lparen' | 'rparen' | 'eq_assign'
  | 'eqeq' | 'neq' | 'gte' | 'lte' | 'gt' | 'lt' | 'plus' | 'minus' | 'star' | 'slash'
  | 'and' | 'or' | 'not' | 'let' | 'call_kw' | 'put_kw' | 'when' | 'confidence_kw'
  | 'expiry_kw' | 'configure_kw' | 'eof'

interface Token {
  kind: TokKind
  value: string
  line: number
}

const KEYWORDS: Record<string, TokKind> = {
  and: 'and',
  or: 'or',
  not: 'not',
  let: 'let',
  call: 'call_kw',
  put: 'put_kw',
  when: 'when',
  confidence: 'confidence_kw',
  expiry: 'expiry_kw',
  configure: 'configure_kw',
}

class MslSyntaxError extends Error {}

/** AUDIT: strip a '#' comment to end-of-line WITHOUT cutting '#' inside a
 * string literal (`candle('Bull #3', call)` used to lose the tail of its
 * own first argument to the comment pass, then fail to parse). Quote-aware
 * scan: a '#' opens a comment only outside '...' / "...". */
function stripComment(line: string): string {
  let quote: string | null = null
  for (let i = 0; i < line.length; i++) {
    const c = line[i]
    if (quote) {
      if (c === quote) quote = null
      continue
    }
    if (c === "'" || c === '"') quote = c
    else if (c === '#') return line.slice(0, i)
  }
  return line
}

function tokenize(src: string): Token[] {
  const lines = src.split('\n')
  const toks: Token[] = []
  for (let li = 0; li < lines.length; li++) {
    const line = stripComment(lines[li]) // '#' starts a comment - rest of the line is dropped
    let i = 0
    while (i < line.length) {
      const c = line[i]
      if (c === ' ' || c === '\t' || c === '\r') {
        i++
        continue
      }
      if (/[0-9]/.test(c) || (c === '.' && /[0-9]/.test(line[i + 1] ?? ''))) {
        let j = i
        while (j < line.length && /[0-9.]/.test(line[j])) j++
        const word = line.slice(i, j)
        // AUDIT: a multi-dot token like "1.2.3" used to tokenize happily and
        // Number() to NaN - a NaN atom that flowed through arithmetic into
        // confidence (Math.max/min pass NaN straight through) and OUT of the
        // evaluator as a tradeable decision. Reject at the source instead:
        // the parser only ever sees finite literals now.
        const numVal = Number(word)
        if (!Number.isFinite(numVal)) throw new MslSyntaxError(`line ${li + 1}: malformed number "${word}"`)
        toks.push({ kind: 'num', value: word, line: li + 1 })
        i = j
        continue
      }
      if (c === "'" || c === '"') {
        const quote = c
        let j = i + 1
        while (j < line.length && line[j] !== quote) j++
        // AUDIT: an unterminated string used to be silently accepted as the
        // rest-of-line (a typo like 'Bullish Engulfing without its closing
        // quote changed the script's meaning instead of failing at save).
        if (j >= line.length) throw new MslSyntaxError(`line ${li + 1}: unterminated string literal - missing closing ${quote}`)
        toks.push({ kind: 'str', value: line.slice(i + 1, j), line: li + 1 })
        i = j + 1
        continue
      }
      if (/[A-Za-z_]/.test(c)) {
        let j = i
        while (j < line.length && /[A-Za-z0-9_:\-]/.test(line[j])) j++
        const word = line.slice(i, j)
        const kw = KEYWORDS[word]
        toks.push({ kind: kw ?? 'ident', value: word, line: li + 1 })
        i = j
        continue
      }
      if (c === '.') {
        toks.push({ kind: 'dot', value: '.', line: li + 1 })
        i++
        continue
      }
      if (c === ',') {
        toks.push({ kind: 'comma', value: ',', line: li + 1 })
        i++
        continue
      }
      if (c === '(') {
        toks.push({ kind: 'lparen', value: '(', line: li + 1 })
        i++
        continue
      }
      if (c === ')') {
        toks.push({ kind: 'rparen', value: ')', line: li + 1 })
        i++
        continue
      }
      if (c === '=' && line[i + 1] === '=') {
        toks.push({ kind: 'eqeq', value: '==', line: li + 1 })
        i += 2
        continue
      }
      if (c === '!' && line[i + 1] === '=') {
        toks.push({ kind: 'neq', value: '!=', line: li + 1 })
        i += 2
        continue
      }
      if (c === '>' && line[i + 1] === '=') {
        toks.push({ kind: 'gte', value: '>=', line: li + 1 })
        i += 2
        continue
      }
      if (c === '<' && line[i + 1] === '=') {
        toks.push({ kind: 'lte', value: '<=', line: li + 1 })
        i += 2
        continue
      }
      if (c === '>') {
        toks.push({ kind: 'gt', value: '>', line: li + 1 })
        i++
        continue
      }
      if (c === '<') {
        toks.push({ kind: 'lt', value: '<', line: li + 1 })
        i++
        continue
      }
      if (c === '=') {
        toks.push({ kind: 'eq_assign', value: '=', line: li + 1 })
        i++
        continue
      }
      if (c === '+') {
        toks.push({ kind: 'plus', value: '+', line: li + 1 })
        i++
        continue
      }
      if (c === '-') {
        toks.push({ kind: 'minus', value: '-', line: li + 1 })
        i++
        continue
      }
      if (c === '*') {
        toks.push({ kind: 'star', value: '*', line: li + 1 })
        i++
        continue
      }
      if (c === '/') {
        toks.push({ kind: 'slash', value: '/', line: li + 1 })
        i++
        continue
      }
      throw new MslSyntaxError(`line ${li + 1}: unexpected character "${c}"`)
    }
    toks.push({ kind: 'eof', value: '\\n', line: li + 1 }) // line terminator, reused as a statement separator below
  }
  toks.push({ kind: 'eof', value: '', line: lines.length })
  return toks
}

// ---------- AST ----------

type Expr =
  | { t: 'num'; v: number }
  | { t: 'str'; v: string }
  | { t: 'bool'; v: boolean }
  | { t: 'dir'; v: 'call' | 'put' | 'none' }
  | { t: 'ident'; name: string }
  | { t: 'field'; obj: Expr; field: string }
  | { t: 'unary'; op: 'not' | 'neg'; e: Expr }
  | { t: 'bin'; op: 'and' | 'or' | '==' | '!=' | '>=' | '<=' | '>' | '<' | '+' | '-' | '*' | '/'; l: Expr; r: Expr }
  | { t: 'call'; fn: string; args: Expr[] }

type Stmt =
  | { kind: 'let'; name: string; expr: Expr }
  | { kind: 'call'; expr: Expr }
  | { kind: 'put'; expr: Expr }
  | { kind: 'confidence'; expr: Expr }
  | { kind: 'expiry'; expr: Expr }
  | { kind: 'configure'; path: string; expr: Expr }

export interface MslAst {
  stmts: Stmt[]
}

const FIELDS = new Set(['dir', 'direction', 'conf', 'confidence', 'active', 'call', 'put', 'value'])
// Core arithmetic funcs (avg/sum/min/max/count/abs) are no longer special-
// cased at PARSE time - any identifier followed by "(" parses as a call
// (see parsePrimary's doc comment). evalExpr's 'call' case still handles
// those six itself; every other name falls through to a caller-supplied
// resolver (signal functions, etc - see MslSignalResolver above).

// ---------- parser (recursive descent, one statement per source line) ----------

class Parser {
  private pos = 0
  constructor(private toks: Token[]) {}

  private peek(): Token {
    return this.toks[this.pos]
  }
  private next(): Token {
    return this.toks[this.pos++]
  }
  private expect(kind: TokKind): Token {
    const t = this.next()
    if (t.kind !== kind) throw new MslSyntaxError(`line ${t.line}: expected ${kind}, got "${t.value}"`)
    return t
  }
  private skipLineBreaks(): void {
    while (this.peek().kind === 'eof' && this.toks[this.pos + 1] && this.toks[this.pos + 1].kind !== 'eof') {
      // 'eof' tokens inserted per source line double as line breaks; the
      // true end-of-input is the LAST token in the stream.
      if (this.pos === this.toks.length - 1) break
      this.pos++
    }
  }

  parseProgram(): MslAst {
    const stmts: Stmt[] = []
    this.skipLineBreaks()
    while (this.peek().kind !== 'eof' || this.pos < this.toks.length - 1) {
      if (this.peek().kind === 'eof') {
        this.pos++
        continue
      }
      stmts.push(this.parseStatement())
      // a statement must end at a line-break ('eof' token) or real eof
      if (this.peek().kind !== 'eof') throw new MslSyntaxError(`line ${this.peek().line}: unexpected "${this.peek().value}" after statement`)
    }
    return { stmts }
  }

  private parseStatement(): Stmt {
    const t = this.peek()
    if (t.kind === 'let') {
      this.next()
      const name = this.expect('ident').value
      this.expect('eq_assign')
      const expr = this.parseOr()
      return { kind: 'let', name, expr }
    }
    if (t.kind === 'call_kw') {
      this.next()
      this.expectWord('when')
      return { kind: 'call', expr: this.parseOr() }
    }
    if (t.kind === 'put_kw') {
      this.next()
      this.expectWord('when')
      return { kind: 'put', expr: this.parseOr() }
    }
    if (t.kind === 'confidence_kw') {
      this.next()
      this.expect('eq_assign')
      return { kind: 'confidence', expr: this.parseOr() }
    }
    if (t.kind === 'expiry_kw') {
      this.next()
      this.expect('eq_assign')
      return { kind: 'expiry', expr: this.parseOr() }
    }
    if (t.kind === 'configure_kw') {
      // configure <ident>(.<ident>)+ = <expr> - the path is collected as a
      // dotted string; which keys are legal (and their ranges) is the
      // CALLER's whitelist (plugins/metastrategy.ts), applied at eval time
      // so a stale parser can never bless a key the kernel no longer honors.
      this.next()
      let path = this.expect('ident').value
      while (this.peek().kind === 'dot') {
        this.next()
        path += `.${this.expect('ident').value}`
      }
      if (!path.includes('.')) throw new MslSyntaxError(`line ${t.line}: "configure" needs a dotted key like configure renko.atrMult = 0.5 (got "${path}")`)
      this.expect('eq_assign')
      return { kind: 'configure', path, expr: this.parseOr() }
    }
    throw new MslSyntaxError(`line ${t.line}: expected "let", "call when", "put when", "confidence =", "expiry =" or "configure ... =", got "${t.value}"`)
  }

  private expectWord(word: string): void {
    const t = this.next()
    if (t.kind !== 'when') throw new MslSyntaxError(`line ${t.line}: expected "${word}", got "${t.value}"`)
  }

  private parseOr(): Expr {
    let l = this.parseAnd()
    while (this.peek().kind === 'or') {
      this.next()
      l = { t: 'bin', op: 'or', l, r: this.parseAnd() }
    }
    return l
  }
  private parseAnd(): Expr {
    let l = this.parseNot()
    while (this.peek().kind === 'and') {
      this.next()
      l = { t: 'bin', op: 'and', l, r: this.parseNot() }
    }
    return l
  }
  private parseNot(): Expr {
    if (this.peek().kind === 'not') {
      this.next()
      return { t: 'unary', op: 'not', e: this.parseNot() }
    }
    return this.parseCompare()
  }
  private parseCompare(): Expr {
    const l = this.parseAdd()
    const k = this.peek().kind
    const cmp: Record<string, string> = { eqeq: '==', neq: '!=', gte: '>=', lte: '<=', gt: '>', lt: '<' }
    if (cmp[k]) {
      this.next()
      const r = this.parseAdd()
      return { t: 'bin', op: cmp[k] as '==' | '!=' | '>=' | '<=' | '>' | '<', l, r }
    }
    return l
  }
  private parseAdd(): Expr {
    let l = this.parseMul()
    while (this.peek().kind === 'plus' || this.peek().kind === 'minus') {
      const op = this.next().kind === 'plus' ? '+' : '-'
      l = { t: 'bin', op, l, r: this.parseMul() }
    }
    return l
  }
  private parseMul(): Expr {
    let l = this.parseUnary()
    while (this.peek().kind === 'star' || this.peek().kind === 'slash') {
      const op = this.next().kind === 'star' ? '*' : '/'
      l = { t: 'bin', op, l, r: this.parseUnary() }
    }
    return l
  }
  private parseUnary(): Expr {
    if (this.peek().kind === 'minus') {
      this.next()
      return { t: 'unary', op: 'neg', e: this.parseUnary() }
    }
    return this.parseAtom()
  }
  // Postfix ".field" is now generic: it applies to ANY primary expression
  // (a bare source identifier, same as always, OR a function call like
  // `candle('Bullish Engulfing', call).dir` - see MslSignalResolver's doc
  // comment above for why calls can now produce field-able values too).
  private parseAtom(): Expr {
    let e = this.parsePrimary()
    while (this.peek().kind === 'dot') {
      this.next()
      // AUDIT FIX (caught by scripts/msl_unit.ts): `.call` / `.put` are
      // documented FIELDS (fieldOf implements them, the grammar comment
      // lists them), but `call`/`put` tokenize as KEYWORDS everywhere - so
      // expect('ident') here rejected them and EVERY script using the
      // documented `oracle.call` / `accute.put` shape failed to parse.
      // Accept the two direction keywords as field names; the value slot
      // carries the literal word either way.
      const ft = this.next()
      const fieldKw = ft.kind === 'call_kw' || ft.kind === 'put_kw'
      if (ft.kind !== 'ident' && !fieldKw)
        throw new MslSyntaxError(`line ${ft.line}: unknown field ".${ft.value}" - use dir/direction/conf/confidence/active/call/put/value`)
      if (!FIELDS.has(ft.value)) throw new MslSyntaxError(`line ${ft.line}: unknown field ".${ft.value}" - use dir/direction/conf/confidence/active/call/put/value`)
      e = { t: 'field', obj: e, field: ft.value }
    }
    return e
  }

  private parsePrimary(): Expr {
    const t = this.next()
    if (t.kind === 'num') return { t: 'num', v: Number(t.value) }
    if (t.kind === 'str') return { t: 'str', v: t.value }
    if (t.kind === 'lparen') {
      const e = this.parseOr()
      this.expect('rparen')
      return e
    }
    if (t.kind === 'ident') {
      if (t.value === 'true') return { t: 'bool', v: true }
      if (t.value === 'false') return { t: 'bool', v: false }
      if (t.value === 'none') return { t: 'dir', v: 'none' }
      // Any identifier immediately followed by "(" is a function call -
      // the core arithmetic funcs (avg/sum/min/max/count/abs) and any
      // signal function a caller's resolver understands (candle/bar/ha/
      // renko/pf/indicator/...) are syntactically identical; which bucket
      // a name falls into is decided at EVAL time (evalExpr's 'call'
      // case), not at parse time - a new signal vocabulary never needs a
      // parser/grammar change, only a new resolver entry.
      if (this.peek().kind === 'lparen') {
        this.next()
        const args: Expr[] = []
        if (this.peek().kind !== 'rparen') {
          args.push(this.parseOr())
          while (this.peek().kind === 'comma') {
            this.next()
            args.push(this.parseOr())
          }
        }
        this.expect('rparen')
        return { t: 'call', fn: t.value, args }
      }
      return { t: 'ident', name: t.value }
    }
    if (t.kind === 'call_kw') return { t: 'dir', v: 'call' }
    if (t.kind === 'put_kw') return { t: 'dir', v: 'put' }
    throw new MslSyntaxError(`line ${t.line}: unexpected token "${t.value}"`)
  }
}

export function parseStrategyScript(src: string): { ok: true; ast: MslAst } | { ok: false; error: string } {
  try {
    const toks = tokenize(src)
    const ast = new Parser(toks).parseProgram()
    if (!ast.stmts.some((s) => s.kind === 'call') && !ast.stmts.some((s) => s.kind === 'put')) {
      return { ok: false, error: 'a strategy script needs at least one "call when ..." or "put when ..." statement' }
    }
    return { ok: true, ast }
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) }
  }
}

// ---------- evaluator ----------

class MslRuntimeError extends Error {}

function truthy(v: MslValue): boolean {
  if (isReadValue(v)) throw new MslRuntimeError('a source/signal value can\'t be used directly - access .dir/.conf/.active/.call/.put instead')
  if (typeof v === 'boolean') return v
  if (typeof v === 'number') return v !== 0
  return v !== 'none' && v !== ''
}

function asNum(v: MslValue): number {
  if (isReadValue(v)) throw new MslRuntimeError('a source/signal value can\'t be used directly - access .conf (or .dir/.active/.call/.put) instead')
  if (typeof v === 'number') return v
  if (typeof v === 'boolean') return v ? 1 : 0
  throw new MslRuntimeError(`expected a number, got "${v}"`)
}

function fieldOf(read: MslSourceRead, field: string): MslValue {
  switch (field) {
    case 'dir':
    case 'direction':
      return read.direction
    case 'conf':
    case 'confidence':
      return read.confidence
    case 'active':
      return read.direction !== 'none'
    case 'call':
      return read.direction === 'call'
    case 'put':
      return read.direction === 'put'
    case 'value':
      // the source's own headline number in its native scale; a source
      // without one honestly reads 0 (documented per source in the reads
      // map builder - never a fabricated default)
      return read.value !== undefined && Number.isFinite(read.value) ? read.value : 0
    default:
      throw new MslRuntimeError(`unknown field ".${field}"`)
  }
}

function evalExpr(e: Expr, env: Record<string, MslValue>, reads: Record<string, MslSourceRead>, resolve?: MslSignalResolver): MslValue {
  switch (e.t) {
    case 'num':
      return e.v
    case 'str':
      return e.v
    case 'bool':
      return e.v
    case 'dir':
      return e.v
    case 'ident': {
      // let-bindings take priority (a script can shadow a source name with
      // its own intermediate value); a name that isn't bound falls back to
      // the static `reads` map the caller supplied, wrapped into the SAME
      // read shape a signal-function call produces, so e.g. `oracle.dir`
      // and `let o = oracle; o.dir` behave identically.
      if (e.name in env) return env[e.name]
      if (e.name in reads) return readValue(reads[e.name])
      throw new MslRuntimeError(`unknown identifier "${e.name}" - not a let-binding, and not a known source (did you mean to add ".dir" or ".conf"?)`)
    }
    case 'field': {
      const val = evalExpr(e.obj, env, reads, resolve)
      if (!isReadValue(val)) throw new MslRuntimeError(`".${e.field}" needs a source or signal value, not "${val}"`)
      return fieldOf(val, e.field)
    }
    case 'unary': {
      const v = evalExpr(e.e, env, reads, resolve)
      if (e.op === 'not') return !truthy(v)
      return -asNum(v)
    }
    case 'bin': {
      if (e.op === 'and') return truthy(evalExpr(e.l, env, reads, resolve)) && truthy(evalExpr(e.r, env, reads, resolve))
      if (e.op === 'or') return truthy(evalExpr(e.l, env, reads, resolve)) || truthy(evalExpr(e.r, env, reads, resolve))
      const l = evalExpr(e.l, env, reads, resolve)
      const r = evalExpr(e.r, env, reads, resolve)
      if ((e.op === '==' || e.op === '!=') && (isReadValue(l) || isReadValue(r))) {
        throw new MslRuntimeError('a source/signal value can\'t be compared directly - access .dir/.conf/.active/.call/.put instead')
      }
      switch (e.op) {
        case '==':
          return l === r
        case '!=':
          return l !== r
        case '>=':
          return asNum(l) >= asNum(r)
        case '<=':
          return asNum(l) <= asNum(r)
        case '>':
          return asNum(l) > asNum(r)
        case '<':
          return asNum(l) < asNum(r)
        case '+':
          return asNum(l) + asNum(r)
        case '-':
          return asNum(l) - asNum(r)
        case '*':
          return asNum(l) * asNum(r)
        case '/':
          return asNum(r) === 0 ? 0 : asNum(l) / asNum(r)
      }
      break
    }
    case 'call': {
      // 'if' is LAZY - only the taken branch is evaluated (so a branch that
      // would throw on this bar's data, e.g. reading a warming source, is
      // never touched when the condition picks the other one).
      if (e.fn === 'if') {
        if (e.args.length !== 3) throw new MslRuntimeError(`if(cond, then, else) takes exactly 3 arguments, got ${e.args.length}`)
        return truthy(evalExpr(e.args[0], env, reads, resolve)) ? evalExpr(e.args[1], env, reads, resolve) : evalExpr(e.args[2], env, reads, resolve)
      }
      const args = e.args.map((a) => evalExpr(a, env, reads, resolve))
      switch (e.fn) {
        case 'avg':
          return args.length ? args.reduce((s: number, a) => s + asNum(a), 0) / args.length : 0
        case 'sum':
          return args.reduce((s: number, a) => s + asNum(a), 0)
        case 'min':
          return args.length ? Math.min(...args.map(asNum)) : 0
        case 'max':
          return args.length ? Math.max(...args.map(asNum)) : 0
        case 'count':
          return args.filter(truthy).length
        case 'abs':
          return Math.abs(asNum(args[0] ?? 0))
        case 'clamp': {
          if (args.length !== 3) throw new MslRuntimeError(`clamp(x, lo, hi) takes exactly 3 arguments, got ${args.length}`)
          const [x, lo, hi] = args.map(asNum)
          return Math.max(lo, Math.min(hi, x))
        }
        case 'round':
          return Math.round(asNum(args[0] ?? 0))
        case 'floor':
          return Math.floor(asNum(args[0] ?? 0))
        case 'ceil':
          return Math.ceil(asNum(args[0] ?? 0))
        case 'sign':
          return Math.sign(asNum(args[0] ?? 0))
        case 'sqrt': {
          const v = asNum(args[0] ?? 0)
          if (v < 0) throw new MslRuntimeError('sqrt() of a negative number - would produce NaN confidence')
          return Math.sqrt(v)
        }
        case 'pow': {
          if (args.length !== 2) throw new MslRuntimeError(`pow(base, exp) takes exactly 2 arguments, got ${args.length}`)
          return Math.pow(asNum(args[0]), asNum(args[1]))
        }
        case 'mod': {
          if (args.length !== 2) throw new MslRuntimeError(`mod(a, b) takes exactly 2 arguments, got ${args.length}`)
          const b = asNum(args[1])
          if (b === 0) throw new MslRuntimeError('mod(a, 0) - divide by zero')
          return asNum(args[0]) % b
        }
        default: {
          // Not a core arithmetic func - ask the caller's resolver (AI
          // Lab's signal vocabulary plugs in exactly here, see
          // strategies/signalscript.ts). Args to a signal function are
          // always plain config values (names/numbers/flags), never
          // another source/signal - asPlainArg enforces that so a
          // resolver never has to guard against receiving a read object.
          if (!resolve) throw new MslRuntimeError(`unknown function "${e.fn}"`)
          const plainArgs = args.map((a) => {
            if (isReadValue(a)) throw new MslRuntimeError(`"${e.fn}(...)" got a source/signal value as an argument - pass plain values (numbers, 'call'/'put', strings) instead`)
            return a
          })
          return readValue(resolve(e.fn, plainArgs))
        }
      }
    }
  }
  throw new MslRuntimeError('unreachable expression node')
}

/** Run a parsed script against one asset+tf's current source reads.
 * Fail-closed, same convention every other strategy evaluator in this
 * codebase uses: a runtime error (unknown source, a thin-history source
 * that never got a slot in `reads`) resolves to 'none' with the error
 * message attached, never a thrown exception into the trading loop. */
export function evaluateStrategyScript(ast: MslAst, reads: Record<string, MslSourceRead>, resolve?: MslSignalResolver): MslEvalResult {
  const env: Record<string, MslValue> = {}
  const trace: string[] = []
  const configs: Record<string, number | boolean | string> = {}
  let callFired = false
  let putFired = false
  let confidenceExpr: Expr | null = null
  let expiryExpr: Expr | null = null
  try {
    for (const stmt of ast.stmts) {
      if (stmt.kind === 'let') {
        env[stmt.name] = evalExpr(stmt.expr, env, reads, resolve)
        continue
      }
      if (stmt.kind === 'call') {
        const v = truthy(evalExpr(stmt.expr, env, reads, resolve))
        if (v) callFired = true
        trace.push(`call when ... -> ${v}`)
        continue
      }
      if (stmt.kind === 'put') {
        const v = truthy(evalExpr(stmt.expr, env, reads, resolve))
        if (v) putFired = true
        trace.push(`put when ... -> ${v}`)
        continue
      }
      if (stmt.kind === 'confidence') {
        confidenceExpr = stmt.expr // evaluated below, only if a side actually fired
        continue
      }
      if (stmt.kind === 'expiry') {
        expiryExpr = stmt.expr // evaluated below, only if a side actually fired
        continue
      }
      if (stmt.kind === 'configure') {
        // config values are PLAIN numbers/booleans/strings - a read object
        // here is almost certainly a typo ("configure renko = ..." without
        // the key), so it fails the script loudly instead of poisoning the
        // caller's whitelist lookup.
        const v = evalExpr(stmt.expr, env, reads, resolve)
        if (isReadValue(v)) throw new MslRuntimeError(`"configure ${stmt.path}" got a source/signal value - the value must be a plain number/boolean/string`)
        configs[stmt.path] = v as number | boolean | string
        trace.push(`configure ${stmt.path} = ${String(v)}`)
        continue
      }
    }
  } catch (err) {
    return { direction: 'none', confidence: 0, trace, error: err instanceof Error ? err.message : String(err) }
  }

  if (callFired && putFired) {
    trace.push('both "call when" and "put when" fired - conflicting, reads as none')
    return { direction: 'none', confidence: 0, trace }
  }
  if (!callFired && !putFired) {
    return { direction: 'none', confidence: 0, trace }
  }
  const direction: 'call' | 'put' = callFired ? 'call' : 'put'
  let confidence = 65 // same "lone signal, no honesty-loop number to lean on" flat default smcNowRead() uses
  if (confidenceExpr) {
    try {
      const raw = asNum(evalExpr(confidenceExpr, env, reads, resolve))
      // AUDIT: Math.max/Math.min/round all pass NaN straight through, so an
      // expression that reached +/-Infinity (huge-literal overflow) and then
      // Infinity - Infinity in a let-binding used to exit here as a NaN
      // confidence on a live direction. Fail closed instead: a non-finite
      // confidence is an error, and an error resolves to none/0 (below).
      if (!Number.isFinite(raw)) throw new MslRuntimeError('confidence expression produced a non-finite value (check for divide-by-zero-style arithmetic on huge literals)')
      confidence = Math.max(0, Math.min(100, Math.round(raw)))
    } catch (err) {
      return { direction: 'none', confidence: 0, trace, error: `confidence expression failed: ${err instanceof Error ? err.message : String(err)}` }
    }
  } else {
    trace.push('no "confidence = ..." statement - defaulted to 65 (set one explicitly for a real number)')
  }
  // expiry statement: whole minutes 1-60, evaluated ONLY when a side fired
  // (same laziness contract as confidence) - a non-finite result fails the
  // whole script closed, same as a bad confidence.
  let expiryMin: number | undefined
  if (expiryExpr) {
    try {
      const raw = asNum(evalExpr(expiryExpr, env, reads, resolve))
      if (!Number.isFinite(raw)) throw new MslRuntimeError('expiry expression produced a non-finite value')
      expiryMin = Math.max(1, Math.min(60, Math.round(raw)))
      if (expiryMin !== raw) trace.push(`expiry = ${raw} clamped/rounded to ${expiryMin} (whole minutes 1-60)`)
    } catch (err) {
      return { direction: 'none', confidence: 0, trace, error: `expiry expression failed: ${err instanceof Error ? err.message : String(err)}` }
    }
  }
  return { direction, confidence, trace, ...(expiryMin !== undefined ? { expiryMin } : {}), ...(Object.keys(configs).length ? { configs } : {}) }
}
