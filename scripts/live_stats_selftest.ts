// Self-test: per-mode live P/L baselines (live_stats table).
// Run: bun scripts/live_stats_selftest.ts
import { Store } from '../mini-services/trading-core/src/store'
import { mkdtempSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

const dir = mkdtempSync(join(tmpdir(), 'iqos-livestats-'))
const db = join(dir, 'test.db')
let pass = 0
let fail = 0
function check(name: string, cond: boolean, detail = ''): void {
  if (cond) {
    pass++
    console.log(`  PASS ${name}`)
  } else {
    fail++
    console.log(`  FAIL ${name} ${detail}`)
  }
}

try {
  const s = new Store(db)

  // paper account untouched by all of this
  const paperAcct = s.getAccount()
  check('paper dayPnl stays ledger-based', paperAcct.dayPnl === 0 && paperAcct.totalPnl === 0)

  // 1. first PRACTICE observation -> both baselines = balance
  s.setLiveBalance(10500, 'PRACTICE')
  let st = s.getLiveStat('PRACTICE')!
  check('practice snapshot created', !!st)
  check('practice start=10500', st.startBalance === 10500, `got ${st.startBalance}`)
  check('practice dayStart=10500', st.dayStart === 10500, `got ${st.dayStart}`)

  // 2. same-day sync with a moved balance: baselines must NOT move
  s.setLiveBalance(10620, 'PRACTICE')
  st = s.getLiveStat('PRACTICE')!
  check('same-day sync keeps start', st.startBalance === 10500, `got ${st.startBalance}`)
  check('same-day sync keeps dayStart', st.dayStart === 10500, `got ${st.dayStart}`)

  // derived P/L math (what execution.account() computes)
  check('dayPnl math', 10620 - st.dayStart === 120)
  check('totalPnl math', 10620 - st.startBalance === 120)

  // 3. day roll: pretend the row was written yesterday -> next sync rolls dayStart only
  ;(s as unknown as { db: { run: (q: string, ...p: unknown[]) => void } }).db.run(
    "UPDATE live_stats SET day_key = '2000-01-01' WHERE mode = 'PRACTICE'"
  )
  s.setLiveBalance(10440, 'PRACTICE')
  st = s.getLiveStat('PRACTICE')!
  check('day roll: dayStart moves', st.dayStart === 10440, `got ${st.dayStart}`)
  check('day roll: start stays', st.startBalance === 10500, `got ${st.startBalance}`)

  // 4. REAL is a fully independent baseline
  s.setLiveBalance(9800, 'REAL')
  const real = s.getLiveStat('REAL')!
  check('real snapshot independent', real.startBalance === 9800 && real.dayStart === 9800, JSON.stringify(real))
  check('practice row untouched by real', s.getLiveStat('PRACTICE')!.startBalance === 10500)

  // 5. live_balance/live_mode on the account row still work
  const acct = s.getAccount()
  check('account.liveBalance updated', acct.liveBalance === 9800, `got ${acct.liveBalance}`)
  check('account.balanceMode updated', acct.balanceMode === 'REAL', `got ${acct.balanceMode}`)

  console.log(`\n${pass} pass / ${fail} fail`)
  if (fail > 0) process.exit(1)
} finally {
  rmSync(dir, { recursive: true, force: true })
}
