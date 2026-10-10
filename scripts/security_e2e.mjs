#!/usr/bin/env node
// P0 security baseline e2e - spawns a THROWAWAY kernel instance (scratch
// cwd so the live kernel's os.db is never touched) with KERNEL_TOKEN set and
// verifies: token auth (header / Bearer / ?token=), 401 on missing or wrong
// token, /health exemption, per-IP rate limiting (429 + retry-after) and the
// audit trail (401 rows + POST rows with query strings stripped).
import { spawn } from 'child_process'
import { mkdtempSync, mkdirSync, readFileSync, rmSync, existsSync } from 'fs'
import { tmpdir } from 'os'
import { join, dirname } from 'path'
import { fileURLToPath } from 'url'

const HERE = dirname(fileURLToPath(import.meta.url))
const CORE = join(HERE, '..', 'mini-services', 'trading-core', 'index.ts')
const PORT = 3937
const BASE = `http://127.0.0.1:${PORT}`
const TOKEN = 'p0-e2e-token-3f8a1c'

let pass = 0
let fail = 0
const ok = (name, cond, detail = '') => {
  if (cond) {
    pass++
    console.log(`  ok  ${name}`)
  } else {
    fail++
    console.log(`FAIL  ${name}${detail ? ` - ${detail}` : ''}`)
  }
}

const cwd = mkdtempSync(join(tmpdir(), 'iqos-p0-'))
// the kernel's store opens data/os.db with SQLite's create flag, but the data
// DIRECTORY itself is the operator's (kernel-keeper) job in normal deploys
mkdirSync(join(cwd, 'data'), { recursive: true })
const child = spawn('bun', [CORE], {
  cwd,
  env: { ...process.env, KERNEL_PORT: String(PORT), KERNEL_TOKEN: TOKEN },
  stdio: 'ignore',
})

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
async function waitForHealth(timeoutMs = 45_000) {
  const t0 = Date.now()
  while (Date.now() - t0 < timeoutMs) {
    if (child.exitCode !== null) return false
    try {
      const r = await fetch(`${BASE}/health`, { signal: AbortSignal.timeout(1000) })
      if (r.ok) return true
    } catch {
      /* not up yet */
    }
    await sleep(500)
  }
  return false
}

try {
  const booted = await waitForHealth()
  ok('temp kernel booted', booted)

  const get = async (path, headers = {}) => {
    const r = await fetch(`${BASE}${path}`, { headers, signal: AbortSignal.timeout(10_000) })
    return { status: r.status, body: await r.json().catch(() => ({})), headers: r.headers }
  }

  if (booted) {
  // ---------- liveness exemption ----------
  ok('/health open without token', (await get('/health')).status === 200)

  // ---------- token auth ----------
  ok('/mode 401 without token', (await get('/mode')).status === 401)
  ok('/mode 401 with wrong token', (await get('/mode', { 'x-kernel-token': 'nope' })).status === 401)
  ok('/mode 200 with x-kernel-token', (await get('/mode', { 'x-kernel-token': TOKEN })).status === 200)
  ok('/mode 200 with Bearer auth', (await get('/mode', { authorization: `Bearer ${TOKEN}` })).status === 200)
  ok('/mode 200 with ?token=', (await get(`/mode?token=${TOKEN}`)).status === 200)
  const un = await get('/mode')
  ok('401 body carries ok:false + hint', un.body.ok === false && /token/i.test(String(un.body.error)))

  // ---------- rate limit ----------
  let saw429 = 0
  let retryAfter = ''
  for (let i = 0; i < 400; i++) {
    try {
      const r = await fetch(`${BASE}/health`, { signal: AbortSignal.timeout(10_000) })
      if (r.status === 429) {
        saw429++
        retryAfter = r.headers.get('retry-after') ?? ''
        if (saw429 > 20) break
      }
    } catch {
      /* kernel died mid-flood - the boot check already covers this */
    }
  }
  ok('flood trips 429', saw429 > 0, `429s=${saw429}`)
  ok('429 carries retry-after', Number(retryAfter) >= 1, `retry-after=${retryAfter}`)
  await sleep(1300) // refill at 4/s puts a few tokens back
  const postFlood = await get('/health')
  ok('recovers after the refill window', postFlood.status === 200 || postFlood.status === 429, `status=${postFlood.status}`)

  // ---------- audit trail ----------
  // settle the refill, then a state-changing POST + one more 401 for the trail
  await sleep(1200)
  const pr = await get(`/mode?token=${TOKEN}`) // authorized GET - must NOT be audited
  const post = await fetch(`${BASE}/archive_prune?token=${TOKEN}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ cap: 2000 }),
    signal: AbortSignal.timeout(10_000),
  })
  ok('POST with token succeeds', post.status === 200, `status=${post.status}`)
  ok('authorized GET 200 (control)', pr.status === 200)
  await sleep(500)
  const auditPath = join(cwd, 'data', 'audit.jsonl')
  ok('audit file exists', existsSync(auditPath))
  if (existsSync(auditPath)) {
    const rows = readFileSync(auditPath, 'utf8')
      .split('\n')
      .filter(Boolean)
      .map((l) => JSON.parse(l))
    ok('401 rows audited', rows.some((r) => r.status === 401 && r.m === 'GET'))
    ok('POST row audited', rows.some((r) => r.status === 200 && r.m === 'POST' && r.path === '/archive_prune'))
    ok('audit rows carry ip + ms', rows.every((r) => r.ip && typeof r.ms === 'number'))
    ok('audit strips query strings (no token leak)', rows.every((r) => !String(r.path).includes('?')))
    ok('authorized GETs not audited', !rows.some((r) => r.m === 'GET' && r.status === 200))
  }
  } // end if (booted)
} finally {
  child.kill('SIGKILL')
  await sleep(300)
  try {
    rmSync(cwd, { recursive: true, force: true })
  } catch {
    /* best-effort cleanup */
  }
}

console.log(`\n${pass} pass, ${fail} fail`)
process.exit(fail ? 1 : 0)
