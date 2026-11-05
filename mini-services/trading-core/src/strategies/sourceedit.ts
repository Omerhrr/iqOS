// IQAIR//OS - Live source editing for the built-in Strategy Lab catalog.
//
// Per direct instruction ("the strategy lab should not be read only then,
// let it be fully functional"): builtin.ts's STRATEGIES array holds real
// compiled TypeScript, not data (unlike Meta-Strategy's specs or the AI
// Lab's CustomSpec JSON) - so "view as code, edit, and save" here means
// literally reading/rewriting a slice of this kernel's own source file on
// disk. That is inherently riskier than a JSON edit, so every write here:
//   - is scoped to exactly ONE strategy's object-literal block (matched by
//     brace-depth, string/comment-aware so a brace inside a template
//     literal or comment can't desync the scan) - every other byte of the
//     file is untouched.
//   - is rejected if the edited block's own `id:` no longer matches (no
//     silent renames - that would orphan the old id from anything already
//     referencing it (bots, backtests) while minting an unreachable dupe).
//   - is syntax-checked (via Bun's own built-in transpiler - no new
//     dependency) on the FULL resulting file text before anything is
//     written, so a typo can never land on disk.
//   - is backed up first (data/strategy_backups/<id>.<ts>.bak.ts) so a bad
//     edit that somehow still "looks" valid can always be rolled back by
//     hand.
//   - takes effect only after the kernel is restarted (Bun doesn't hot-
//     swap a strategy's own module-level array) - the save response says
//     so explicitly; this module never restarts the process itself.
import { readFileSync, writeFileSync, chmodSync, statSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'

const BUILTIN_PATH = join(import.meta.dir, 'builtin.ts')
const BACKUP_DIR = join(import.meta.dir, '..', '..', 'data', 'strategy_backups')

function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

/** Scans forward from `from` tracking brace depth, string/template-literal
 * and comment awareness (so a `{`/`}` inside a string, template
 * interpolation, or comment never desyncs the count) - returns the index
 * JUST PAST the `}` that closes the brace opened at `from` (which must
 * itself be a `{`), or null if the file ends first (malformed/truncated). */
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
      // line comment - skip to end of line
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
      // template literal - treat the WHOLE thing (including any ${...}
      // interpolation) as opaque text. Every `${}` in this codebase's
      // strategy bodies only interpolates simple expressions (no nested
      // object literals), so this is safe in practice; even if it weren't,
      // the full-file transpile check below still catches any resulting
      // syntax break before anything is written.
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
  return null // ran off the end - unbalanced
}

/** Finds the `{ ... }` object-literal block for one STRATEGIES entry by
 * its `id: '<id>'` field, returning the exact [start, end) span of the
 * WHOLE object literal (including its own opening/closing braces, nothing
 * outside them - the surrounding `,`/newlines in the array are untouched
 * on a save). */
function findStrategyBlock(fileText: string, id: string): { start: number; end: number } | null {
  const idRe = new RegExp(`id:\\s*['"]${escapeRegex(id)}['"]`)
  const idMatch = idRe.exec(fileText)
  if (!idMatch) return null
  // Walk backward from the id field to the nearest "{" that opens a line
  // by itself at 2-space (array-element) indentation - every STRATEGIES
  // entry is formatted exactly `\n  {\n` per the file's own convention
  // (confirmed against the live file), so this is a precise anchor rather
  // than "the nearest brace", which could land on a NESTED brace instead.
  const openRe = /\n  \{\r?\n/g
  let start = -1
  let m: RegExpExecArray | null
  while ((m = openRe.exec(fileText.slice(0, idMatch.index))) !== null) {
    start = m.index + 3 // skip the leading "\n" + the two indent spaces to land on "{" itself
  }
  if (start === -1) return null
  const end = matchBrace(fileText, start)
  if (end === null) return null
  return { start, end }
}

export function readBuiltinStrategySource(id: string): { ok: true; source: string } | { ok: false; error: string } {
  let text: string
  try {
    text = readFileSync(BUILTIN_PATH, 'utf8')
  } catch (err) {
    return { ok: false, error: `could not read builtin.ts: ${String(err instanceof Error ? err.message : err)}` }
  }
  const block = findStrategyBlock(text, id)
  if (!block) return { ok: false, error: `strategy "${id}" not found in builtin.ts (or its block isn't in the expected shape - edit it by hand instead)` }
  return { ok: true, source: text.slice(block.start, block.end) }
}

export function saveBuiltinStrategySource(id: string, newSource: string): { ok: true; backup: string } | { ok: false; error: string } {
  const trimmed = newSource.trim()
  if (!trimmed) return { ok: false, error: 'empty source' }
  if (!/id:\s*['"]/.test(trimmed)) return { ok: false, error: 'edited block has no id: field - every strategy entry needs one' }
  const idMatch = new RegExp(`id:\\s*['"]${escapeRegex(id)}['"]`).exec(trimmed)
  if (!idMatch) {
    return { ok: false, error: `the edited block's id no longer matches "${id}" - renaming a strategy's id isn't supported here (it would orphan anything already trading the old id). Delete and recreate instead if you need a new id.` }
  }

  let text: string
  try {
    text = readFileSync(BUILTIN_PATH, 'utf8')
  } catch (err) {
    return { ok: false, error: `could not read builtin.ts: ${String(err instanceof Error ? err.message : err)}` }
  }
  const block = findStrategyBlock(text, id)
  if (!block) return { ok: false, error: `strategy "${id}" not found in builtin.ts` }

  const nextText = text.slice(0, block.start) + trimmed + text.slice(block.end)

  // Syntax-check the WHOLE resulting file (not just the pasted block) via
  // Bun's own built-in transpiler - catches anything that breaks the
  // surrounding array/file shape (stray comma, unbalanced bracket) before
  // a single byte hits disk. This is a syntax check only, not a type
  // check - a logic bug that still type-checks can still ship, same as
  // any other code change; that's the tradeoff of live-editing real code
  // from a text box instead of going through a PR.
  try {
    const transpiler = new Bun.Transpiler({ loader: 'tsx' })
    transpiler.transformSync(nextText)
  } catch (err) {
    return { ok: false, error: `syntax error in edited strategy: ${String(err instanceof Error ? err.message : err)}` }
  }

  // Backup before touching the live file.
  let backupPath = ''
  try {
    mkdirSync(BACKUP_DIR, { recursive: true })
    backupPath = join(BACKUP_DIR, `${id.replace(/[^a-z0-9-]+/gi, '_')}.${Date.now()}.bak.ts`)
    writeFileSync(backupPath, text, 'utf8')
  } catch (err) {
    return { ok: false, error: `could not write backup before saving - aborted, nothing changed: ${String(err instanceof Error ? err.message : err)}` }
  }

  try {
    // builtin.ts ships read-only (chmod 444) as a light tripwire against
    // accidental edits - lift it just long enough to write, then restore
    // whatever mode it had going in.
    let mode: number | undefined
    try {
      mode = statSync(BUILTIN_PATH).mode
      chmodSync(BUILTIN_PATH, 0o644)
    } catch {
      /* best-effort - some filesystems (notably the Windows-mounted desktop
       * path this syncs to) don't enforce unix mode bits at all */
    }
    writeFileSync(BUILTIN_PATH, nextText, 'utf8')
    if (mode !== undefined) {
      try {
        chmodSync(BUILTIN_PATH, mode)
      } catch {
        /* non-fatal - the write itself already succeeded */
      }
    }
  } catch (err) {
    return { ok: false, error: `write failed (backup kept at ${backupPath}): ${String(err instanceof Error ? err.message : err)}` }
  }

  return { ok: true, backup: backupPath }
}
