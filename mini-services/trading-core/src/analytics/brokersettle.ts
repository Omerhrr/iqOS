// IQAIR//OS - Broker settlement decision table (pure engine).
//
// The single answer to "what settles a LIVE option position", shared by the
// 1s poll loop (plugins/execution.ts settleLiveExpiry) AND the operator's
// force-close (forceCloseLiveOption). Kept as a pure module so the unit
// suite can pin the contract without booting the execution service.

/** What the sidecar's /order_result can report about one live order - the
 * kernel's ONLY authoritative settlement input. */
export interface BrokerLookupResult {
  found: boolean
  status?: string
  pnl?: number
  closePrice?: number
  closeTime?: number
  /** IQ's own history row EXISTS and confirms the trade closed, but its pnl
   * figure could not be parsed (field renamed / string format) - see
   * brokerSettleDecision's 'settle-flat-unverified'. */
  pnlUnreadable?: boolean
  error?: string
}

/**  - 'settle-broker': IQ's own closed row WITH a readable pnl - the only
 *    figure that may ever be recorded.
 *  - 'settle-flat-unverified': IQ's closed row exists but its pnl could not
 *    be parsed - record $0 flat under a loud reconciliation alert rather
 *    than hang forever on a row we can literally see.
 *  - 'wait': everything else (no answer, lookup error, broker still open,
 *    not found yet) - keep polling, never guess a win/loss. */
export function brokerSettleDecision(result: BrokerLookupResult | null): 'settle-broker' | 'settle-flat-unverified' | 'wait' {
  if (!result || result.error) return 'wait'
  if (!result.found) return 'wait'
  if (result.status === 'open') return 'wait'
  if (Number.isFinite(result.pnl)) return 'settle-broker'
  if (result.pnlUnreadable) return 'settle-flat-unverified'
  // closed row with neither a readable pnl nor the unreadable marker: the
  // sidecar contract guarantees the marker on every matched closed row;
  // absence means an outdated sidecar - wait rather than invent anything.
  return 'wait'
}
