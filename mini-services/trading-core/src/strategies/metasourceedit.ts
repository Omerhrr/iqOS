// IQAIR//OS - Live source editing for Meta Trader's own built-in signal
// sources (plugins/metatrader.ts's pickCandidates() dispatcher and its
// pickXxx() private methods: meta-strategy/oracle/accute/smc/renko-smc/
// renko-smc-majority, plus every smc-<KIND> variant, which all share
// pickSmc() - it dispatches on `kind`).
//
// Per direct instruction ("let the strategy lab be fully functional" +
// "we should be able to edit and save the builtin meta strategies") - these
// sources are real compiled TypeScript methods on MetaTraderService, not
// data (unlike a saved MetaStrategySpec, which is already just JSON/script
// in data/meta_strategies.json and was always fully editable/savable via
// /meta_strategy_save - there IS no "builtin, read-only" MetaStrategySpec;
// the thing that actually was read-only was these hardcoded dispatcher
// methods). Mirrors strategies/sourceedit.ts's approach exactly, just
// keyed by METHOD NAME instead of an `id:` field inside an array literal
// (metatrader.ts's pick methods are class members, not array entries):
//   - scoped to exactly ONE method's body (brace-matched, string/template/
//     comment-aware, so braces inside strings/comments can't desync it)
//   - rejects a save whose edited text no longer starts with
//     `private <methodName>(` (no silent renames - pickCandidates()'s own
//     dispatch table calls these methods by name)
//   - syntax-checked (Bun.Transpiler) on the WHOLE resulting file before
//     anything is written
//   - backed up first (data/strategy_backups/metatrader.<method>.<ts>.bak.ts)
//   - takes effect only after the kernel restarts, same caveat as builtin.ts
import { readFileSync, writeFileSync, chmodSync, statSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'

const METATRADER_PATH = join(import.meta.dir, '..', 'plugins', 'metatrader.ts')
const BACKUP_DIR = join(import.meta.dir, '..', '..', 'data', 'strategy_backups')

/** Every Meta Trader built-in source id the UI shows, mapped to the
 * pickXxx() method that actually implements it. Every individual SMC
 * concept (smc-FVG, smc-BOS, ...) and the bare 'smc' source all share the
 * ONE pickSmc(kind) method (it dispatches on `kind` internally) - editing
 * it changes every SMC-kind source at once, which the UI makes explicit
 * rather than pretending each smc-<KIND> has its own isolated method. */
const METHOD_FOR_ID: Record<string, string> = {
  'meta-strategy': 'pickMetaStrategy',
  oracle: 'pickOracle',
  accute: 'pickAccute',
  smc: 'pickSmc',
  'renko-smc': 'pickRenkoSmc',
  'renko-smc-majority': 'pickRenkoSmcMajority',
}

export function methodNameForSourceId(id: string): string | null {
  if (METHOD_FOR_ID[id]) return METHOD_FOR_ID[id]
  if (id.startsWith('smc-')) return 'pickSmc'
  return null
}

function matchBrace(text: string, from: number): number | null {
  if (text[from] !== '{') return null
  let depth = 0
  let i = from
  while (i < text.length) {
    const ch = text[i]
    if (ch === '{') {
      depth++
      i++
      continue
    }
    if (ch === '}') {
      depth--
      i++
      if (depth === 0) return i
      continue
    }
    if (ch === '/' && text[i + 1] === '/') {
      const nl = text.indexOf('\n', i)
      i = nl === -1 ? text.length : nl + 1
      continue
    }
    if (ch === '/' && text[i + 1] === '*') {
      const end = text.indexOf('*/', i + 2)
      i = end === -1 ? text.length : end + 2
      continue
    }
    if (ch === "'" || ch === '"') {
      const quote = ch
      i++
      while (i < text.length && text[i] !== quote) {
        if (text[i] === '\\') i++
        i++
      }
      i++
      continue
    }
    if (ch === '`') {
      i++
      while (i < text.length && text[i] !== '`') {
        if (text[i] === '\\') i++
        i++
      }
      i++
      continue
    }
    i++
  }
  return null
}

/** Finds `private <methodName>(...): <ReturnType> { ... }`'s exact
 * [start, end) span (signature line through the closing brace), anchored
 * on the 2-space (class-member) indented signature so it can't land on a
 * nested brace or a same-named local inside another method. */
function findMethodBlock(fileText: string, methodName: string): { start: number; end: number } | null {
  const sigRe = new RegExp(`\\n(  private ${methodName}\\([^\\n{]*\\{)`)
  const m = sigRe.exec(fileText)
  if (!m) return null
  const start = m.index + 1 // skip the leading "\n", land on the 2 indent spaces
  const braceIdx = start + m[1].length - 1 // position of the "{" itself
  const end = matchBrace(fileText, braceIdx)
  if (end === null) return null
  return { start, end }
}

export function readBuiltinMetaSourceCode(id: string): { ok: true; source: string; method: string } | { ok: false; error: string } {
  const method = methodNameForSourceId(id)
  if (!method) return { ok: false, error: `"${id}" isn't a built-in Meta Trader source with editable code` }
  let text: string
  try {
    text = readFileSync(METATRADER_PATH, 'utf8')
  } catch (err) {
    return { ok: false, error: `could not read metatrader.ts: ${String(err instanceof Error ? err.message : err)}` }
  }
  const block = findMethodBlock(text, method)
  if (!block) return { ok: false, error: `${method}() not found in metatrader.ts (or its shape changed - edit it by hand instead)` }
  return { ok: true, source: text.slice(block.start, block.end), method }
}

export function saveBuiltinMetaSourceCode(id: string, newSource: string): { ok: true; backup: string; method: string } | { ok: false; error: string } {
  const method = methodNameForSourceId(id)
  if (!method) return { ok: false, error: `"${id}" isn't a built-in Meta Trader source with editable code` }
  const trimmed = newSource.trim()
  if (!trimmed) return { ok: false, error: 'empty source' }
  if (!new RegExp(`^private\\s+${method}\\s*\\(`).test(trimmed)) {
    return { ok: false, error: `the edited block must still start with "private ${method}(" - renaming this method isn't supported here (pickCandidates()'s dispatch table calls it by name).` }
  }

  let text: string
  try {
    text = readFileSync(METATRADER_PATH, 'utf8')
  } catch (err) {
    return { ok: false, error: `could not read metatrader.ts: ${String(err instanceof Error ? err.message : err)}` }
  }
  const block = findMethodBlock(text, method)
  if (!block) return { ok: false, error: `${method}() not found in metatrader.ts` }

  // Re-indent the first line to match the 2-space class-member convention
  // (the UI's textarea round-trips the stored text verbatim, which already
  // starts flush-left rather than indented - put the indent back).
  const indented = `  ${trimmed}`
  const nextText = text.slice(0, block.start) + indented + text.slice(block.end)

  try {
    const transpiler = new Bun.Transpiler({ loader: 'tsx' })
    transpiler.transformSync(nextText)
  } catch (err) {
    return { ok: false, error: `syntax error in edited source: ${String(err instanceof Error ? err.message : err)}` }
  }

  let backupPath = ''
  try {
    mkdirSync(BACKUP_DIR, { recursive: true })
    backupPath = join(BACKUP_DIR, `metatrader.${method}.${Date.now()}.bak.ts`)
    writeFileSync(backupPath, text, 'utf8')
  } catch (err) {
    return { ok: false, error: `could not write backup before saving - aborted, nothing changed: ${String(err instanceof Error ? err.message : err)}` }
  }

  try {
    let mode: number | undefined
    try {
      mode = statSync(METATRADER_PATH).mode
      chmodSync(METATRADER_PATH, 0o644)
    } catch {
      /* best-effort */
    }
    writeFileSync(METATRADER_PATH, nextText, 'utf8')
    if (mode !== undefined) {
      try {
        chmodSync(METATRADER_PATH, mode)
      } catch {
        /* non-fatal */
      }
    }
  } catch (err) {
    return { ok: false, error: `write failed (backup kept at ${backupPath}): ${String(err instanceof Error ? err.message : err)}` }
  }

  return { ok: true, backup: backupPath, method }
}
