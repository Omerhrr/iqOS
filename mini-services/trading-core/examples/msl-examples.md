# MSL example scripts

Item 6 of the footprint-completion sweep ("a dedicated automated test
SUITE" was item 6 of the *previous* sweep; this is item 6 of the follow-up
sweep's own list - "runnable MSL example scripts demonstrating combined
engines/expiry-aware strategies" - flagged as still open in both
`claude/chart-engine-roadmap-progress.md` and `claude/msl-capability-matrix.md`
since Phase 9).

These are not meant to be traded as-is - they're worked examples showing
how to combine two or more of the namespaces this project has built across
every phase, in the real MSL syntax, each one verified by actually running
it through `evaluateStrategyScript()` against synthetic candle/tick data
(not just eyeballed for plausible-looking syntax). Paste any of them into
`meta_strategy_test_script` or the Meta Strategy Lab's script editor to see
it evaluate against a real pair; `meta_strategy_backtest` is the next step
after that (remember its own honest-scope rule: only the raw namespace
calls below replay in a backtest, not any bare verdict-source identifier -
none of these examples lean on a bare source for exactly that reason, every
condition reads a raw namespace or a VALUE-ONLY read).

## 1. Renko trend + Volume Profile POC distance, payout-gated

Trades WITH the Renko brick trend only when price has also moved away from
the volume-weighted POC in that same direction (a confluence check: a brick
trend with no POC separation yet is often just noise at the point of
inflection), and only when the account's real payout clears a 0% minimum
edge at 60% assumed win probability (`gate()` - raise the `0.0` floor to
demand a real edge, not just breakeven).

```
let renkoUp = renko.bricks(1)[-1] > 0
let distFromPoc = ohlc(-1).c - vp.poc()
call when renkoUp and distFromPoc > 0 and gate(0.6, payout.value, 0.0)
put when (not renkoUp) and distFromPoc < 0 and gate(0.6, payout.value, 0.0)
confidence = 65
```

## 2. Delta Profile skew confirms a Volume Profile value-area breakout

A classic VAH/VAL breakout filtered by WHO is actually doing the buying or
selling at that moment (Delta Profile's `deltaSkew()` is net buy-vs-sell
delta as a fraction of total volume, CLV proxy, `estimated` not
`measured`) - a breakout above VAH with negative delta skew is exactly the
kind of thin, unconfirmed move this condition is built to reject.

```
let aboveVah = ohlc(-1).c > vp.vah()
let bullSkew = dp.deltaSkew() > 0.1
call when aboveVah and bullSkew
let belowVal = ohlc(-1).c < vp.val()
let bearSkew = dp.deltaSkew() < -0.1
put when belowVal and bearSkew
confidence = 60
```

## 3. Expiry-aligned momentum, gated by stagnation/exhaustion

`nearExpiry.*` (Section 9's binary-options intelligence namespace) reading
momentum over the last 5 bars, but only when the engine's own
stagnation/exhaustion read says the move ISN'T already running out of
steam - the exact "don't buy the end of the move" gate Section 9 asked for.

```
let mom = nearExpiry.momentum(5)
let stagOk = not nearExpiry.stagnation(5)
call when mom > 0.1 and stagOk
put when mom < -0.1 and stagOk
confidence = 55
```

## 4. OTC weekend-session guard around a baseline deviation fade

The OTC/weekend-session awareness primitives (`otc`/`session`, closing the
gap flagged since Phase 8) gating a mean-reversion fade against the
Baseline chart's own deviation - deliberately scoped to ONLY fire when
both the asset is the synthetic OTC generator AND it's a UTC weekend,
since that is precisely the regime where a real-market momentum read would
be meaningless but a synthetic-generator mean-reversion read is more
trustworthy (the generator is mean-reverting by construction on many OTC
instruments - this script states that assumption explicitly rather than
leaving it implicit).

```
let weekendOtc = otc.value == 1 and session.value == 1
let dev = baseline.deviationPct()
call when weekendOtc and dev < -1.5
put when weekendOtc and dev > 1.5
confidence = 50
```

## 5. Footprint absorption fade, filtered by a Kagi trend check

`foot.absorption()` names the side whose aggression got absorbed (an
explicit documented heuristic, not a textbook formula - see
`otcfootprint.ts#footprintAbsorption`'s own header) - this script only
fades that absorption when Kagi's own trend direction already agrees with
the fade, a structural confirmation leg on top of the tick-level read.

```
let absorbedBuy = foot.absorption() == "buy"
let kagiDown = kagi.direction() < 0
put when absorbedBuy and kagiDown
let absorbedSell = foot.absorption() == "sell"
let kagiUp = kagi.direction() > 0
call when absorbedSell and kagiUp
confidence = 55
```

## 6. Candle-completion probability as the primary edge, EV-gated

`nearExpiry.completionProb()`/`.completionDir()` model the remaining bar
time as a driftless random walk (an EXPLICIT documented heuristic, not a
measured probability - always relay this when reporting it) - this script
uses that probability directly as BOTH the entry gate (via `gate()`,
demanding a real 1% edge over breakeven at the account's real payout) and
the reported confidence, rather than a separately-tuned confidence number
disconnected from the probability that actually drove the trade.

```
let prob = nearExpiry.completionProb(0.5)
let dir = nearExpiry.completionDir(0.5)
call when dir == "call" and gate(prob, payout.value, 0.01)
put when dir == "put" and gate(prob, payout.value, 0.01)
confidence = prob * 100
```

---

All 6 of the above were verified by parsing and evaluating each one with
`evaluateStrategyScript()` against synthetic candle series and a synthetic
tick buffer (the same smoke-test discipline this project uses before any
primitive ships), confirming each one parses, evaluates without a runtime
error, and produces a sane direction/confidence - not just that the syntax
looks plausible.
