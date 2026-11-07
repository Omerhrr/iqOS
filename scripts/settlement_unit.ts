// Broker settlement decision table - deterministic unit (bun, in-process).
// Locks the contract added with the stuck-settlement fix (live binary 14425223607
// polling "awaiting IQ confirmation" for 11h+ while IQ had closed the trade):
//   - analytics/brokersettle.ts brokerSettleDecision is the ONE answer shared
//     by the 1s poll loop AND the operator's force-close:
//       * IQ's own closed row + readable pnl  -> 'settle-broker' (the only
//         figure that may ever be recorded)
//       * IQ's closed row but pnl unreadable  -> 'settle-flat-unverified'
//         (honestly-labeled $0 flat, never an infinite hang on a visible row)
//       * null / error / not-found / still-open / missing marker -> 'wait'
//   - pnl edge shapes: NaN/undefined never count as readable; 0 IS readable
//     (an ATM refund / push), negative and fractional figures flow through
import { brokerSettleDecision } from '../mini-services/trading-core/src/analytics/brokersettle'

let pass = 0
let fail = 0
function ok(cond: boolean, name: string, detail = '') {
  if (cond) {
    pass++
    console.log('  ok', name)
  } else {
    fail++
    console.log('  FAIL', name, detail)
  }
}

// ---- the wait family (never guess, keep polling) ----
ok(brokerSettleDecision(null) === 'wait', 'null sidecar answer -> wait (no guess)')
ok(brokerSettleDecision({ found: false }) === 'wait', 'not found -> wait')
ok(brokerSettleDecision({ found: false, status: 'unknown' }) === 'wait', 'unknown status -> wait')
ok(brokerSettleDecision({ found: true, status: 'open' }) === 'wait', 'broker says still open -> wait')
ok(brokerSettleDecision({ found: false, error: 'all broker lookups failed (session/network)' }) === 'wait', 'lookup error -> wait (surfaced elsewhere, never settled)')
ok(brokerSettleDecision({ found: true, status: 'closed' }) === 'wait', 'closed row without pnl AND without the unreadable marker (outdated sidecar) -> wait')
ok(brokerSettleDecision({ found: true, status: 'closed', pnl: Number.NaN }) === 'wait', 'NaN pnl is not a readable figure -> wait')

// ---- settle from the broker's own figure ----
ok(brokerSettleDecision({ found: true, status: 'closed', pnl: 8.5 }) === 'settle-broker', 'closed + positive pnl -> settle-broker')
ok(brokerSettleDecision({ found: true, status: 'closed', pnl: -10 }) === 'settle-broker', 'closed + negative pnl -> settle-broker (losses settle from IQ too)')
ok(brokerSettleDecision({ found: true, status: 'closed', pnl: 0 }) === 'settle-broker', 'closed + pnl 0 -> settle-broker (ATM refund/push; the kernel maps it to push)')

// ---- the unreadable-pnl verdict (the eternal-hang breaker) ----
ok(
  brokerSettleDecision({ found: true, status: 'closed', pnlUnreadable: true }) === 'settle-flat-unverified',
  'closed row + pnl_unreadable marker -> settle-flat-unverified ($0 flat under a loud alert, never an infinite hang)',
)
ok(
  brokerSettleDecision({ found: true, status: 'closed', pnl: Number.NaN, pnlUnreadable: true }) === 'settle-flat-unverified',
  'unreadable marker wins over an unparseable pnl field',
)
ok(
  brokerSettleDecision({ found: true, status: 'closed', pnlUnreadable: true, error: undefined }) === 'settle-flat-unverified',
  'unreadable verdict unaffected by an empty error field',
)

// ---- error beats everything (an errored lookup never settles anything) ----
ok(
  brokerSettleDecision({ found: true, status: 'closed', pnl: 8.5, error: 'session down' }) === 'wait',
  'an error field on the response -> wait even if a stale figure rode along',
)

console.log(`settlement_unit: ${pass} ok, ${fail} fail`)
process.exit(fail ? 1 : 0)
