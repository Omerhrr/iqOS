// Timer probe: wraps setTimeout/setInterval so any callback that runs synchronously for more than 400 ms is logged AFTER it returns, with the
// start of its source text and where it was scheduled from. A 4-minute event-loop freeze with no request in flight is by definition a timer (or a
// promise continuation started by one); this names it. Must be the FIRST import of index.ts so it patches the timers before any plugin schedules one.
const SLOW_MS = 400
type Fn = (...a: unknown[]) => unknown
const g = globalThis as unknown as { setTimeout: Fn; setInterval: Fn; __probePatched?: boolean }
if (!g.__probePatched) {
  g.__probePatched = true
  const wrap = (cb: unknown): unknown => {
    if (typeof cb !== 'function') return cb
    const where = (new Error().stack ?? '').split('\n').slice(3, 6).map((l) => l.trim().replace(/^at /, '')).join(' < ')
    return function probed(this: unknown, ...a: unknown[]) {
      const t = Date.now()
      try { return (cb as Fn).apply(this, a) } finally {
        const d = Date.now() - t
        if (d > SLOW_MS) console.warn(`[slow-timer] ${d}ms | ${String((cb as Fn).toString()).replace(/\s+/g, ' ').slice(0, 140)} | scheduled at ${where}`)
      }
    }
  }
  for (const name of ['setTimeout', 'setInterval'] as const) {
    const orig = g[name]
    g[name] = ((cb: unknown, ...rest: unknown[]) => (orig as Fn)(wrap(cb), ...rest)) as Fn
  }
}
export {}
