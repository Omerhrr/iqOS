// Self-test for the copilot memory gate (temp DBs, no real data touched)
import { MemoryGateService } from '../mini-services/trading-core/src/plugins/memory-gate'
import { Store } from '../mini-services/trading-core/src/store'

let pass = 0
let fail = 0
const assert = (cond: boolean, name: string) => {
  if (cond) {
    pass++
    console.log(`  ok  ${name}`)
  } else {
    fail++
    console.log(`FAIL  ${name}`)
  }
}

function makeGate() {
  const store = new Store(`/tmp/memory-gate-test-${Date.now()}-${Math.random().toString(36).slice(2, 6)}.db`)
  const ctx = {
    use: (name: string) => {
      if (name !== 'storeRaw') throw new Error(`unexpected service ${name}`)
      return store
    },
    log: () => {},
    provide: () => {},
    bus: { emit: () => {} },
    services: new Map(),
  }
  return { gate: new MemoryGateService(ctx as never), store }
}

const DAY = ['sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday'][new Date().getUTCDay()]

// ---------- store A: stake + day rules ----------
{
  const { gate, store } = makeGate()

  // 1. empty gate allows everything
  store.saveNote('preference', 'user likes tea')
  let r = gate.check('EURUSD-OTC', 10)
  assert(r.ok, 'empty gate allows order')

  // 2. max-stake rule (status() force-refreshes the 30s cache - the same path
  // prod takes when a rule note lands via the copilot)
  store.saveNote('rule', 'max-stake: 1')
  gate.status()
  r = gate.check('EURUSD-OTC', 10)
  assert(!r.ok && (r.reason ?? '').includes('caps stake'), `max-stake blocks $10 order (${r.reason})`)
  r = gate.check('EURUSD-OTC', 0.5)
  assert(r.ok, 'max-stake allows $0.50 order')

  // 3. no-trade-days with 3-letter day name
  store.saveNote('rule', 'no-trade-days: mon')
  gate.status()
  r = gate.check('EURUSD-OTC', 0.5)
  if (DAY === 'monday') assert(!r.ok && (r.reason ?? '').includes('monday'), `no-trade-days blocks today (${DAY})`)
  else assert(r.ok, `no-trade-days mon does not block today (${DAY})`)
}

// ---------- store B: asset rules (no day rule so ordering stays clean) ----------
{
  const { gate, store } = makeGate()

  // whitelist: -OTC suffix normalized
  store.saveNote('rule', 'asset-whitelist: BTCUSD')
  gate.status()
  let r = gate.check('EURUSD-OTC', 5)
  assert(!r.ok && (r.reason ?? '').includes('restricts autonomy'), `whitelist blocks non-listed asset (${r.reason})`)
  r = gate.check('BTCUSD-OTC', 5)
  assert(r.ok, 'whitelist allows listed asset (OTC suffix normalized)')

  // blacklist
  store.saveNote('rule', 'asset-blacklist: DOGEUSD')
  gate.status()
  r = gate.check('DOGEUSD', 5)
  assert(!r.ok && (r.reason ?? '').includes('excludes'), `blacklist blocks DOGEUSD (${r.reason})`)
  // blacklist outranks whitelist
  store.saveNote('rule', 'asset-whitelist: DOGEUSD')
  gate.status()
  r = gate.check('DOGEUSD', 5)
  assert(!r.ok && (r.reason ?? '').includes('excludes'), 'blacklist outranks whitelist')
}

// ---------- store C: status descriptions ----------
{
  const { gate, store } = makeGate()
  store.saveNote('rule', 'no-trade-days: Friday, Saturday\nmax-trades-per-hour: 3')
  const st = gate.status()
  assert(st.active, 'status active with rules')
  assert(st.descriptions.length >= 2, `status descriptions (${st.descriptions.length})`)
  assert(st.rules.noTradeDays.includes('friday') && st.rules.noTradeDays.includes('saturday'), 'day list parsed')
  assert(st.rules.maxTradesPerHour === 3, 'rate rule parsed')
  console.log('  status:', st.descriptions.join(' | '))
}

console.log(`\n${pass} passed, ${fail} failed`)
process.exit(fail ? 1 : 0)
