// IQAIR//OS - MSL sense of time (`timing.*`).
//
// HOLD (confirmation window): "my condition is met - do NOT act yet; for N seconds watch whether price actually moves the way the analysis says, then act or abort".
//   timing.hold(name, cond, dir, seconds [, minAtr = 0.05 [, abortAtr = 0.30]])  -> 1 on the ONE evaluation where the setup is CONFIRMED, else 0
//   - idle    : cond true (and the latch is clear)  -> ARM: remember the time, the price and the direction; state = waiting
//   - waiting : cond turns false                    -> abort ("analysis gone")
//               price moves AGAINST dir by abortAtr -> abort ("went the wrong way", early - does not wait out the clock)
//               seconds elapsed                     -> confirmed if price moved WITH dir by >= minAtr, else abort ("went nowhere")
//   - after a confirm / abort the name is LATCHED until cond has been false at least once, so one lingering condition cannot re-arm in a loop.
//   Moves are measured in ATR14 of the chart the script runs on; the price is the newest tick, else the newest 5s close, else the last closed bar.
//   `dir` is +1/-1 or "call"/"put". The name is yours - one name = one independent timer.
//   TIMING RESOLUTION = how often the script is evaluated (Meta Trader polls every 10 s): a 20 s hold is checked at ~10 s steps, so it resolves between 20 and 30 s.
//   The hold needs a real clock, so it is LIVE-ONLY: in a backtest it throws (a backtest cannot replay "what the price did in the 20 seconds after the signal" from 1m bars).
// STATE reads (all by name): timing.state(name) text idle|waiting|confirmed|aborted, timing.waited(name) s, timing.left(name) s, timing.move(name) ATR in dir, timing.why(name) text.
// CLOCK reads (stateless, candle-derived so they ALSO replay in a backtest on the bar's own time): timing.barAge() seconds since the current bar opened, timing.barLeft() seconds until it
//   closes, timing.second() / minute() / hour() UTC, timing.dow() (0 = Sunday). Live these use the real clock, in a backtest the evaluated bar's close time.
export type HoldState = 'idle' | 'waiting' | 'confirmed' | 'aborted'
export interface HoldRec { state: HoldState; armedMs: number; entry: number; dir: number; atr: number; latched: boolean; doneMs: number; why: string; move: number; seconds: number; confirmedOut: boolean }
const store = new Map<string, HoldRec>()
export const holdKey = (prefix: string, name: string): string => `${prefix}|hold|${name}`
export function clearHolds(prefix: string): void { for (const k of store.keys()) if (k.startsWith(`${prefix}|hold|`)) store.delete(k) }
/** true while any hold under this key prefix is armed and counting down - lets a slow-polling trader re-check fast only when it matters */
export function hasWaitingHold(prefix: string): boolean { for (const [k, r] of store) if (r.state === 'waiting' && k.startsWith(`${prefix}|`) && k.includes('|hold|')) return true; return false }
export function holdRec(key: string): HoldRec | undefined { return store.get(key) }

export interface HoldInput { key: string; cond: boolean; dir: number; seconds: number; minAtr: number; abortAtr: number; nowMs: number; price: number; atr: number }
/** pure state machine - exported so tests can drive it with an explicit clock */
export function stepHold(i: HoldInput): { fire: boolean; rec: HoldRec } {
  let r = store.get(i.key)
  if (!r) { r = { state: 'idle', armedMs: 0, entry: NaN, dir: i.dir, atr: i.atr, latched: false, doneMs: 0, why: '', move: 0, seconds: i.seconds, confirmedOut: false }; store.set(i.key, r) }
  // idempotent within one instant: an evaluation pass that is simply run twice (config two-pass) must see the same answer
  if (r.state === 'confirmed' && i.nowMs - r.doneMs < 1000) return { fire: true, rec: r }
  if (r.state === 'confirmed' || r.state === 'aborted') { if (!i.cond) r.latched = false; if (r.state === 'confirmed' || r.state === 'aborted') { if (i.nowMs - r.doneMs >= 1000) { r.state = 'idle'; r.confirmedOut = false } } }
  if (r.state === 'idle') {
    if (!i.cond) r.latched = false
    if (i.cond && !r.latched && Number.isFinite(i.price) && i.dir !== 0) {
      Object.assign(r, { state: 'waiting' as HoldState, armedMs: i.nowMs, entry: i.price, dir: i.dir, atr: i.atr, why: 'armed', move: 0, seconds: i.seconds })
    }
    return { fire: false, rec: r }
  }
  if (r.state === 'waiting') {
    const move = r.dir * (i.price - r.entry) / r.atr
    r.move = move
    const done = (state: HoldState, why: string) => { r!.state = state; r!.why = why; r!.doneMs = i.nowMs; r!.latched = true }
    if (!i.cond) { done('aborted', 'analysis gone'); return { fire: false, rec: r } }
    if (move <= -i.abortAtr) { done('aborted', `price went the wrong way (${move.toFixed(2)} ATR)`); return { fire: false, rec: r } }
    if ((i.nowMs - r.armedMs) / 1000 >= r.seconds) {
      if (move >= i.minAtr) { done('confirmed', `price moved ${move.toFixed(2)} ATR with the call`); return { fire: true, rec: r } }
      done('aborted', `went nowhere (${move.toFixed(2)} ATR)`)
      return { fire: false, rec: r }
    }
  }
  return { fire: false, rec: r }
}

// REPLAY MODE - the replay tester (mslbacktest.ts replayMslScript) walks real 5s bars with an explicit clock, so `hold` becomes replayable there. `bypass` turns every hold into "act at
// arm time" (cond true and not latched -> fire once, latch until cond is false) = the SAME script WITHOUT the wait, for a fair with/without comparison on identical data.
let replayOn = false
let replayBypass = false
export function setReplayMode(on: boolean, bypass = false): void { replayOn = on; replayBypass = on && bypass }
export const inReplay = (): boolean => replayOn
export const replayBypassOn = (): boolean => replayBypass
const bypassLatch = new Map<string, boolean>()
export function stepBypass(key: string, cond: boolean): boolean {
  const latched = bypassLatch.get(key) ?? false
  if (!cond) { bypassLatch.set(key, false); return false }
  if (latched) return false
  bypassLatch.set(key, true)
  return true
}
export function clearBypass(prefix: string): void { for (const k of bypassLatch.keys()) if (k.startsWith(`${prefix}|hold|`)) bypassLatch.delete(k) }
