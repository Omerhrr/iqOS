// IQAIR//OS trading-core - "use the same [LLM config] as copilot" per direct
// instruction. Bun auto-loads a .env from its OWN cwd (mini-services/
// trading-core when started as `bun index.ts` there), which is why the AI
// Trader couldn't see any USE_<PROVIDER>/ *_API_KEY values before this: the
// Next.js app's .env lives at the REPO ROOT (one level up), a file Bun never
// looks at from inside trading-core's own directory. Rather than asking the
// operator to duplicate every LLM key into a second .env, trading-core now
// also loads the root .env directly at boot - same file, same values, same
// provider Copilot already uses, zero extra config.
//
// Deliberately only fills keys NOT already set: a real OS-level env var, or
// a value trading-core's OWN .env already set, always wins over the shared
// root file - this is additive, never an override.

import { readFileSync } from 'node:fs'
import { join } from 'node:path'

/** Minimal KEY=VALUE parser - good enough for a conventional .env (comments,
 * blank lines, optional quotes, no multiline values, no ${VAR} expansion).
 * Anything more exotic than that is unusual for this kind of file and not
 * worth a dependency for. */
function parseEnvFile(text: string): Record<string, string> {
  const out: Record<string, string> = {}
  // strip a UTF-8 BOM - Windows editors (Notepad included) commonly save
  // .env files with one, which would otherwise corrupt the very first key
  // on the first line (it'd read as "﻿USE_ZAI" and never match).
  const clean = text.charCodeAt(0) === 0xfeff ? text.slice(1) : text
  for (const rawLine of clean.split(/\r?\n/)) {
    const line = rawLine.trim()
    if (!line || line.startsWith('#')) continue
    const eq = line.indexOf('=')
    if (eq === -1) continue
    const key = line.slice(0, eq).trim()
    if (!key) continue
    let val = line.slice(eq + 1).trim()
    if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) {
      val = val.slice(1, -1)
    }
    out[key] = val
  }
  return out
}

/** Load one .env-shaped file and apply it to process.env, filling only keys
 * that aren't already set. Missing file is silently fine - trading-core ran
 * without a root .env before this existed, and should keep working the same
 * way if the repo layout ever changes. */
function loadInto(path: string): { found: boolean; parsed: number; applied: number; keys: string[] } {
  try {
    const raw = readFileSync(path, 'utf8')
    const parsed = parseEnvFile(raw)
    const keys: string[] = []
    let applied = 0
    for (const [k, v] of Object.entries(parsed)) {
      if (process.env[k] === undefined) {
        process.env[k] = v
        applied += 1
        keys.push(k)
      }
    }
    return { found: true, parsed: Object.keys(parsed).length, applied, keys }
  } catch {
    // file doesn't exist (or isn't readable) - nothing to load
    return { found: false, parsed: 0, applied: 0, keys: [] }
  }
}

/** Call once, as early as possible in index.ts - before any module-scope
 * `process.env.*` read (KERNEL_PORT etc) and before the first LLM call.
 * Loads trading-core's own .env (Bun already did this automatically from
 * its cwd - re-applying here is a harmless no-op for those keys since they're
 * already set) and then the REPO ROOT .env, two directories up from this
 * file (src/lib/envfile.ts -> src/lib -> src -> trading-core -> repo root),
 * matching the Next.js app's own .env location one level above
 * mini-services/trading-core. */
export function loadSharedEnv(): void {
  // import.meta.dir (Bun-specific) is this file's own directory:
  // mini-services/trading-core/src/lib - four levels up is the repo root.
  const repoRoot = join(import.meta.dir, '..', '..', '..', '..')
  const rootEnvPath = join(repoRoot, '.env')
  const result = loadInto(rootEnvPath)
  // ALWAYS log the outcome (not just "> 0 applied") - a silent no-op here is
  // exactly the kind of thing that leaves an operator staring at "no LLM
  // provider available" with no way to tell whether the file was even found,
  // found-but-empty, or found-but-every-key-already-set.
  if (!result.found) {
    console.log(`[trading-core] no repo-root .env found at ${rootEnvPath} - AI Trader will rely on trading-core's own .env / real OS env vars only`)
  } else if (result.applied === 0) {
    console.log(`[trading-core] repo-root .env found at ${rootEnvPath} (${result.parsed} key(s) parsed) but none applied - every key it defines was already set in this process' own env`)
  } else {
    console.log(`[trading-core] loaded ${result.applied}/${result.parsed} env var(s) from the repo root .env (shared with the Next.js app / Copilot): ${result.keys.join(', ')}`)
  }
}
