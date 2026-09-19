// IQAIR//OS - Kernel
// Repurposed from the deepseek-harness "everything is a plugin" architecture:
// a tiny context that owns an event bus and lifecycle-managed plugins.
// Plugins declare start(ctx) / stop() and talk ONLY through the bus + services.

import type { BusEvents } from './types'

type Handler<T> = (payload: T) => void
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AnyHandler = Handler<any>

export class EventBus {
  private handlers = new Map<string, Set<AnyHandler>>()

  on<K extends keyof BusEvents>(event: K, fn: Handler<BusEvents[K]>): () => void {
    let set = this.handlers.get(event as string)
    if (!set) {
      set = new Set()
      this.handlers.set(event as string, set)
    }
    set.add(fn as AnyHandler)
    return () => this.off(event, fn)
  }

  off<K extends keyof BusEvents>(event: K, fn: Handler<BusEvents[K]>): void {
    this.handlers.get(event as string)?.delete(fn as AnyHandler)
  }

  emit<K extends keyof BusEvents>(event: K, payload: BusEvents[K]): void {
    const set = this.handlers.get(event as string)
    if (!set) return
    for (const fn of set) {
      try {
        fn(payload)
      } catch (err) {
        console.error(`[bus] handler error on ${String(event)}:`, err)
      }
    }
  }
}

export interface Plugin {
  name: string
  start: (ctx: KernelContext) => void | Promise<void>
  stop?: () => void | Promise<void>
}

export interface KernelContext {
  bus: EventBus
  services: Map<string, unknown>
  provide<T>(name: string, svc: T): void
  use<T>(name: string): T
  log(scope: string, ...args: unknown[]): void
}

export class Kernel {
  private bus = new EventBus()
  private services = new Map<string, unknown>()
  private plugins: Plugin[] = []
  private started = false

  context(): KernelContext {
    const svcMap = this.services
    return {
      bus: this.bus,
      services: svcMap,
      provide: <T,>(name: string, svc: T) => {
        svcMap.set(name, svc)
      },
      use: <T,>(name: string) => {
        const svc = svcMap.get(name)
        if (!svc) throw new Error(`[kernel] service '${name}' not registered`)
        return svc as T
      },
      log: (scope: string, ...args: unknown[]) => console.log(`[${scope}]`, ...args),
    }
  }

  register(plugin: Plugin): this {
    if (this.started) throw new Error('[kernel] cannot register after start')
    this.plugins.push(plugin)
    return this
  }

  async start(): Promise<void> {
    if (this.started) return
    const ctx = this.context()
    for (const p of this.plugins) {
      await p.start(ctx)
      console.log(`[kernel] plugin started: ${p.name}`)
    }
    this.started = true
  }

  async stop(): Promise<void> {
    for (const p of [...this.plugins].reverse()) {
      try {
        await p.stop?.()
        console.log(`[kernel] plugin stopped: ${p.name}`)
      } catch (err) {
        console.error(`[kernel] plugin stop error: ${p.name}`, err)
      }
    }
    this.started = false
  }

  on<K extends keyof BusEvents>(event: K, fn: Handler<BusEvents[K]>) {
    return this.bus.on(event, fn)
  }

  emit<K extends keyof BusEvents>(event: K, payload: BusEvents[K]) {
    this.bus.emit(event, payload)
  }
}
