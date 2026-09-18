// IQAIR//OS - Store plugin (persistence, must start first)
import { join } from 'path'
import type { Plugin } from '../kernel'
import { Store } from '../store'

let active: Store | null = null

export const storePlugin: Plugin = {
  name: 'store',
  start(ctx) {
    const dbPath = process.env.IQAIR_OS_DB ?? join(process.cwd(), 'data', 'os.db')
    const store = new Store(dbPath)
    active = store
    // expose both the typed Store and a raw alias for index.ts convenience
    ctx.provide('store', store)
    ctx.provide('storeRaw', store)
    console.log(`[store] sqlite at ${dbPath}`)
  },
  stop() {
    active = null
  },
}
