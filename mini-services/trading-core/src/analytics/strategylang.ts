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
//
// Expressions (standard precedence, low to high):
//   or  <  and  <  not  <  comparisons (== != >= <= > <)  <  + -  <  * /
//   <  unary -  <  atoms
// Atoms: number literals, true/false, call/put/none (direction literals,
// also valid as bare identifiers), string literal '...'/"...", identifier
// (a source key the caller provided in `reads`, or a `let` binding),
// identifier '.' field (field in dir/direction/conf/confidence/active/
// call/put), '(' expr ')', func(args...) where func in
// {avg, sum, min, max, count, abs}.
//
// Source identifiers may contain ':' (e.g. `smc:FVG`, `smc:now`) - the
// caller (plugins/metastrategy.ts) builds the `reads` map with exactly the
// keys a script is allowed to reference: 'oracle', 'hmaRocBullBear',
// 'momentumScore', 'accute', 'renko', 'pointFigure', 'rangeBars', 'candle',
// 'bar', 'heikinAshi', 'line', 'area', 'baseline', 'volumeBars', 'tick',
// 'footprint', 'tpo', 'ivHv', 'smc', 'smcNow', 'renkoSmc',
// 'renkoSmcMajority', and 'smc:<KIND>' for each of the 15 SMC concepts
// (smcNowRead() per kind) - "any of the smcs" per direct instruction,
// without needing 15 new MetaConditionSource union members. 'pointFigure'/
// 'rangeBars' are the same "not just renko - p&f, range and all others as
// we see fit" instruction: every chart engine this codebase already keeps
// as its own pure module (analytics/renko.ts, pointfigure.ts, rangebars.ts)
// is reachable from a script the same way, so a new chart type only ever
// needs a new `reads` key here, never a language change.

export type MslValue = number | boolean | string

export interface MslSourceRead {
  direction: 'call' | 'put' | 'none'
  confidence: number // 0..100
}

export interface MslEvalResult {
  direction: 'call' | 'put' | 'none'
  confidence: number // 0..100
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
  | 'and' | 'or' | 'not' | 'let' | 'call_kw' | 'put_kw' | 'when' | 'confidence_kw' | 'eof'

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
}

class MslSyntaxError extends Error {}

function tokenize(src: string): Token[] {
  const lines = src.split('\n')
  const toks: Token[] = []
  for (let li = 0; li < lines.length; li++) {
    const line = lines[li].split('#')[0] // '#' starts a comment - rest of the line is dropped
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
        toks.push({ kind: 'num', value: line.slice(i, j), line: li + 1 })
        i = j
        continue
      }
      if (c === "'" || c === '"') {
        const quote = c
        let j = i + 1
        while (j < line.length && line[j] !== quote) j++
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
  | { t: 'field'; obj: string; field: string }
  | { t: 'unary'; op: 'not' | 'neg'; e: Expr }
  | { t: 'bin'; op: 'and' | 'or' | '==' | '!=' | '>=' | '<=' | '>' | '<' | '+' | '-' | '*' | '/'; l: Expr; r: Expr }
  | { t: 'call'; fn: string; args: Expr[] }

type Stmt = { kind: 'let'; name: string; expr: Expr } | { kind: 'call'; expr: Expr } | { kind: 'put'; expr: Expr } | { kind: 'confidence'; expr: Expr }

export interface MslAst {
  stmts: Stmt[]
}

const FIELDS = new Set(['dir', 'direction', 'conf', 'confidence', 'active', 'call', 'put'])
const FUNCS = new Set(['avg', 'sum', 'min', 'max', 'count', 'abs'])

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
    throw new MslSyntaxError(`line ${t.line}: expected "let", "call when", "put when" or "confidence =", got "${t.value}"`)
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
  private parseAtom(): Expr {
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
      if (FUNCS.has(t.value) && this.peek().kind === 'lparen') {
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
      if (this.peek().kind === 'dot') {
        this.next()
        const field = this.expect('ident')
        if (!FIELDS.has(field.value)) throw new MslSyntaxError(`line ${field.line}: unknown field ".${field.value}" - use dir/direction/conf/confidence/active/call/put`)
        return { t: 'field', obj: t.value, field: field.value }
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
  if (typeof v === 'boolean') return v
  if (typeof v === 'number') return v !== 0
  return v !== 'none' && v !== ''
}

function asNum(v: MslValue): number {
  if (typeof v === 'number') return v
  if (typeof v === 'boolean') return v ? 1 : 0
  throw new MslRuntimeError(`expected a number, got "${v}"`)
}

function evalExpr(e: Expr, env: Record<string, MslValue>, reads: Record<string, MslSourceRead>): MslValue {
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
      if (e.name in env) return env[e.name]
      throw new MslRuntimeError(`unknown identifier "${e.name}" - not a let-binding, and not a known source (did you mean to add ".dir" or ".conf"?)`)
    }
    case 'field': {
      const read = reads[e.obj]
      if (!read) throw new MslRuntimeError(`unknown source "${e.obj}" - available sources are set by the Meta Strategy Lab (oracle, hmaRocBullBear, momentumScore, accute, renko, pointFigure, rangeBars, candle, bar, heikinAshi, line, area, baseline, volumeBars, tick, footprint, tpo, ivHv, smc, smcNow, renkoSmc, renkoSmcMajority, smc:<KIND>)`)
      switch (e.field) {
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
        default:
          throw new MslRuntimeError(`unknown field ".${e.field}"`)
      }
    }
    case 'unary': {
      const v = evalExpr(e.e, env, reads)
      if (e.op === 'not') return !truthy(v)
      return -asNum(v)
    }
    case 'bin': {
      if (e.op === 'and') return truthy(evalExpr(e.l, env, reads)) && truthy(evalExpr(e.r, env, reads))
      if (e.op === 'or') return truthy(evalExpr(e.l, env, reads)) || truthy(evalExpr(e.r, env, reads))
      const l = evalExpr(e.l, env, reads)
      const r = evalExpr(e.r, env, reads)
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
      const args = e.args.map((a) => evalExpr(a, env, reads))
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
        default:
          throw new MslRuntimeError(`unknown function "${e.fn}"`)
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
export function evaluateStrategyScript(ast: MslAst, reads: Record<string, MslSourceRead>): MslEvalResult {
  const env: Record<string, MslValue> = {}
  const trace: string[] = []
  let callFired = false
  let putFired = false
  let confidenceExpr: Expr | null = null
  try {
    for (const stmt of ast.stmts) {
      if (stmt.kind === 'let') {
        env[stmt.name] = evalExpr(stmt.expr, env, reads)
        continue
      }
      if (stmt.kind === 'call') {
        const v = truthy(evalExpr(stmt.expr, env, reads))
        if (v) callFired = true
        trace.push(`call when ... -> ${v}`)
        continue
      }
      if (stmt.kind === 'put') {
        const v = truthy(evalExpr(stmt.expr, env, reads))
        if (v) putFired = true
        trace.push(`put when ... -> ${v}`)
        continue
      }
      if (stmt.kind === 'confidence') {
        confidenceExpr = stmt.expr // evaluated below, only if a side actually fired
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
      confidence = Math.max(0, Math.min(100, Math.round(asNum(evalExpr(confidenceExpr, env, reads)))))
    } catch (err) {
      return { direction: 'none', confidence: 0, trace, error: `confidence expression failed: ${err instanceof Error ? err.message : String(err)}` }
    }
  } else {
    trace.push('no "confidence = ..." statement - defaulted to 65 (set one explicitly for a real number)')
  }
  return { direction, confidence, trace }
}
