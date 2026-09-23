import { NextResponse } from 'next/server'
import { spawn, execSync } from 'child_process'
import path from 'path'

// IQAIR//OS - kernel keeper
// The trading-core kernel (bun, :3030) is the heart of the OS. In managed
// deployments the dev server is the long-lived process, so this endpoint
// anchors the kernel to it: if :3030 is unreachable, spawn it detached as a
// child of THIS server (it outlives whatever started the request). The OS
// shell calls /api/kernel on boot and whenever the socket feed drops, which
// gives the whole system self-healing semantics without a system supervisor.

const CORE_DIR = path.join(process.cwd(), 'mini-services', 'trading-core')

let spawning = false
let lastSpawnTs = 0

async function coreAlive(timeoutMs = 1500): Promise<boolean> {
  try {
    const ctrl = new AbortController()
    const t = setTimeout(() => ctrl.abort(), timeoutMs)
    const res = await fetch('http://127.0.0.1:3030/health', { signal: ctrl.signal, cache: 'no-store' })
    clearTimeout(t)
    return res.ok
  } catch {
    return false
  }
}

function resolveBun(): string {
  for (const p of ['bun', '/usr/local/bin/bun', '/usr/bin/bun', '/root/.bun/bin/bun']) {
    try {
      const which = execSync(`command -v ${p}`, { stdio: 'pipe' }).toString().trim()
      if (which) return which
    } catch {
      /* keep looking */
    }
  }
  return 'bun'
}

export async function GET() {
  if (await coreAlive()) {
    return NextResponse.json({ ok: true, kernel: 'running' })
  }
  if (spawning || Date.now() - lastSpawnTs < 4000) {
    return NextResponse.json({ ok: false, kernel: 'spawning' }, { status: 202 })
  }
  spawning = true
  lastSpawnTs = Date.now()
  try {
    const bun = resolveBun()
    const child = spawn(bun, ['index.ts'], {
      cwd: CORE_DIR,
      detached: true,
      stdio: 'ignore',
      env: { ...process.env, IQAIR_KEEPER: 'next-dev' },
    })
    child.unref()
    // wait briefly for the kernel to open :3030
    for (let i = 0; i < 20; i++) {
      await new Promise((r) => setTimeout(r, 500))
      if (await coreAlive(800)) {
        return NextResponse.json({ ok: true, kernel: 'spawned', pid: child.pid })
      }
      if (child.exitCode !== null) break
    }
    return NextResponse.json({ ok: false, kernel: 'spawn-failed' }, { status: 502 })
  } catch (err) {
    return NextResponse.json({ ok: false, error: (err as Error).message }, { status: 500 })
  } finally {
    spawning = false
  }
}
