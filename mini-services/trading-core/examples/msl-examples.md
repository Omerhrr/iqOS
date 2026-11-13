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

## 7. MRC response-efficiency fade (the Phase 3 offline-validated finding)

Market Response Chart (`analytics/mrc.ts`) bars carry `responseRatio` -
how much displacement a bar's activity actually bought, relative to the
trailing average. Offline validation against real archived EURUSD history
(see `claude/market-response-chart-mrc.md`) found a real, if single-window,
signal: a below-average-response bar ("effort without full result") was
followed by a next-bar reversal 33.5% of the time (n=176) vs only 13.7%
(n=146) after an above-average-response bar. This script trades THAT
specific pattern directly - fades the last confirmed bar's own direction
only when its `responseRatio` is well below average, and explicitly stands
aside when that bar was `dataGap`-forced (a recording-hole artifact, not a
real market read - never trade off one of those, see the module's own
dead-time-guard note).

```
let d = mrc.directionalDelta(-1)
let rr = mrc.responseRatio(-1)
let isGap = mrc.gap(-1)
call when (not isGap) and rr < 0.6 and d < 0 and gate(0.55, payout.value, 0.0)
put when (not isGap) and rr < 0.6 and d > 0 and gate(0.55, payout.value, 0.0)
confidence = 55
expiry = 1
```

## 8. MRC clean-move continuation, confirmed by Effort Bricks

The opposite trade from #7 above, for the OTHER side of the same
response-efficiency idea: when the last confirmed MRC bar was a "clean,
low-resistance move" (`responseRatio >= 1.0` - real displacement per unit
of activity, not churn) AND Effort Bricks' own independently-built
participation-confirmation gate (`effort.ratio()`) agrees in the SAME
direction, both engines are reporting real, participation-backed movement
from two different lenses (adaptive-event-clock response efficiency vs.
brick-level volume confirmation) - a stronger confluence than either alone,
traded as continuation rather than fade.

```
let mrcUp = mrc.directionalDelta(-1) > 0
let mrcStrong = mrc.responseRatio(-1) >= 1.0
let ebBar = effort.ohlc(-1)
let ebConfirmed = effort.ratio(-1) >= 1.0
call when mrcUp and mrcStrong and ebConfirmed and (ebBar.c - ebBar.o) > 0 and gate(0.6, payout.value, 0.0)
put when (not mrcUp) and mrcStrong and ebConfirmed and (ebBar.c - ebBar.o) < 0 and gate(0.6, payout.value, 0.0)
confidence = 65
expiry = 1
```

## 9. Historical Outcome Memory, payout-gated

A fundamentally different kind of evidence from everything above: instead
of a model's score, `outcomeMemory` searches real past bars for the ones
that looked like THIS one (same session, similar momentum/volatility/run-
length) and reports how those specific historical cases actually settled -
`.value` is the empirical win-rate (pUp) drawn directly from that
comparable pool, not a fitted probability. Reads `none` outright when the
comparable pool is too thin to trust (see `analytics/outcomememory.ts`) -
this script leans on that honesty gate instead of adding its own sample-size
check on top. `gate()` still enforces a real edge over the account's actual
payout before either side fires.

```
configure memory.expiry = 1
let p = outcomeMemory.value
call when outcomeMemory.dir == call and gate(p, payout.value, 0.02)
put when outcomeMemory.dir == put and gate(1 - p, payout.value, 0.02)
confidence = outcomeMemory.conf
expiry = 1
```

**CORRECTED (strategy vet) - the first version of this example had two real
bugs, kept here so nobody reuses it.** It read
`put when outcomeMemory.value < 0.5 and gate(1 - outcomeMemory.value, ...)`
with no direction check. When Outcome Memory has NO read (thin pool, or pUp
inside its own coin-flip deadband) `.value` is 0 - so `value < 0.5` was true
and `gate(1 - 0, ...)` passed at a "100% win probability": the script called
PUT, at confidence 0, on every bar Memory was unsure about. Always test the
read's `.dir` before using its `.value`. Second, it traded a 1-bar expiry
off Memory's default **5-bar** settlement horizon - `configure memory.expiry`
now matches the two (and could not even be parsed before the same vet's
parser fix: a config key segment that spells a keyword, like `expiry`, used
to be rejected).

**Honesty note, measured:** on a driftless random walk (where the true win
rate is 50% by construction) this script still fires on roughly a third of
all bars while reporting pUp of 60-70% - and wins 50.5%. Twenty nearest
neighbours is a small, overlapping sample: its raw frequency is a
description of the past, NOT a calibrated win probability, and `gate()` on
it is not proof of an edge. Treat this as a hypothesis generator and
walk-forward it on real history before trusting it.

## 10. Pulse-Vector exhaustion fade

Pulse-Vector bars (`analytics/pulsebars.ts`) bundle real tick density,
velocity and acceleration into one object per fixed micro-interval
(default 5s), plus `exhaustionScore` - how far a bar's velocity has fallen
from its own same-direction run's peak. This is the exact "thick base that
thins out at the top, color fading to pale" signature the Pulse-Vector
concept was built around: a surge that's still extending in the same
direction but whose own speed has fallen well off its peak is read as
exhausted, traded as a reversal rather than continuation. Skips sparse bars
(too few real ticks to trust the density read) and still demands a real
payout edge via `gate()`.

```
let dir = pulse.displacement(-1)
let ex = pulse.exhaustion(-1)
let sparse = pulse.sparse(-1)
call when (not sparse) and dir < 0 and ex >= 0.6 and gate(0.55, payout.value, 0.0)
put when (not sparse) and dir > 0 and ex >= 0.6 and gate(0.55, payout.value, 0.0)
confidence = 55
expiry = 1
```

## 11. Liquidity Spring reversion, payout-gated

Liquidity Spring (`analytics/liquidityspring.ts`) fires `.snap()` only when
price has stretched far from its own fast EMA core (a high `.tension()`
z-score) AND real participation is falling off at the same time
(`.decelerating()`) - "max stretch, running out of gas." This script fades
the stretch direction on a fresh snap, demanding a real payout edge.

```
let snap = spring.snap(-1)
let stretchedUp = spring.deviation(-1) > 0
call when snap and (not stretchedUp) and gate(0.55, payout.value, 0.0)
put when snap and stretchedUp and gate(0.55, payout.value, 0.0)
confidence = 55
expiry = 1
```

## 12. Volatility Echo coil-then-break continuation

Volatility Echo (`analytics/volatilityecho.ts`) flags `.squeeze()` when its
own statistical band has pinched tighter than its recent average width
("coiling") and `.pierced()` when price breaks back outside the band -
the classic "wait for the break" pattern. This script only trades a pierce
that happened on the SAME bar the band was still squeezed one bar earlier,
the "coil then break" signature the design doc called out, trading WITH
the breakout direction (continuation, not fade).

```
let pierced = echo.pierced(-1)
let wasSqueezed = echo.squeeze(-2)
call when pierced == "up" and wasSqueezed and gate(0.55, payout.value, 0.0)
put when pierced == "down" and wasSqueezed and gate(0.55, payout.value, 0.0)
confidence = 58
expiry = 1
```

## 13. Response-Efficiency Continuation, regime- and participation-confirmed

**CORRECTED - the first version of this example (committed, then reported
by the user as losing more than it won in real use) was built on a real
arithmetic mistake, kept here so nobody reuses it:** the Phase 3 finding
(`claude/market-response-chart-mrc.md`) is "a low-response bar reverses
next-bar **33.5%** of the time (n=176) vs **13.7%** for a high-response bar
(n=146)." The original #13 read that as license to FADE every low-response
bar - but 33.5% is not a win probability over 50%. It means a low-response
bar still CONTINUES 66.5% of the time; it is merely *less* continuation-
biased than a high-response bar (86.3% continuation). Betting on the 33.5%
minority outcome is a structurally losing bet, which is exactly the result
reported. The ~2.4x gap (33.5 vs 13.7) is a REAL, if single-window,
difference in how confidently you should trust continuation - not a signal
to bet against it.

The corrected version trades CONTINUATION (same direction as the mrc bar
itself, matching #8's already-correctly-signed logic above), gated on the
HIGH-response side of the same measurement (`responseRatio >= 1.0`, the
86.3%-continuation bucket) - never the low-response side - with the two
filters this session's work actually put in place layered on top, each
closing a real way even a correctly-signed continuation bet can go wrong:

1. **Kagi regime != "choppy"** (`kagi.regime()`, this session's build) -
   skip whenever Kagi's own reversal density says the tape is whipsawing -
   the regime classifier's whole job is flagging "too much noise for
   structure to mean anything."
2. **Effort Bricks independently confirms the SAME direction**
   (`effort.confirmed(-1)`/`effort.ratio(-1)`/`effort.ohlc(-1)`) - two
   engines reading real participation from two different lenses
   (displacement-per-activity vs brick-level volume) agreeing is a
   materially stronger confluence than either alone, same logic #8 already
   uses.

Still demands a real payout edge via `gate()`. Honesty note carried over
from the Phase 3 finding itself: single asset, single window, no
significance test - a real, encouraging number, not proof; this script
leans on it as a confirmation layer alongside Effort Bricks, not as a
sole signal.

```
let d = mrc.directionalDelta(-1)
let rr = mrc.responseRatio(-1)
let isGap = mrc.gap(-1)
let regime = kagi.regime()
let choppy = regime == "choppy"
let ebBar = effort.ohlc(-1)
let ebDir = ebBar.c - ebBar.o
let ebConfirmed = effort.confirmed(-1) and effort.ratio(-1) >= 1.0
let ebBacksSameWay = ebConfirmed and ((d > 0 and ebDir > 0) or (d < 0 and ebDir < 0))
let cleanMove = rr >= 1.0
call when (not isGap) and (not choppy) and cleanMove and d > 0 and ebBacksSameWay and gate(0.6, payout.value, 0.0)
put when (not isGap) and (not choppy) and cleanMove and d < 0 and ebBacksSameWay and gate(0.6, payout.value, 0.0)
confidence = 62
expiry = 1
```

Verified by parsing and evaluating against a deliberately noisy synthetic
series across 60 seeds - fires selectively on both sides, no runtime
errors. A synthetic series proves the script discriminates correctly
between conditions; it CANNOT prove the underlying edge is profitable
(that's exactly the kind of claim the original, broken version of this
example made without justification) - only real/replayed history can.

## 14. Next-Expiry Oracle, 5-minute rung, structure- and participation-confirmed

Purpose-built for exactly this job: `nextExpiry:5` reads the Next-Expiry
Oracle's (`analytics/nextexpiry.ts`) fused 5-minute-horizon model (Markov
H-E transitions, variance-ratio, OU half-life fade, run-length exhaustion,
session drift - regime-weighted, not just averaged), with its own live
per-(asset, 5m) calibration discount already applied to the confidence it
reports - an oracle that's been wrong trading THIS pair at a 5-minute
expiry specifically speaks more humbly about this pair at 5 minutes,
without a script having to know that discount happened. `.value` is a real
win probability (`pWin`), not a proxy - feeds `gate()` directly.

Two filters layered on top, for the same reason longer holds need more
structural confirmation than a 1-minute scalp: a 5-minute hold has to
survive a lot more can-happen-in-between than a 1-minute one does.

1. **Kagi regime != "choppy"** - skip whenever the tape's reversal density
   says there's too much whipsaw for a 5-minute directional hold to have a
   fair run.
2. **Effort Bricks agrees** - the oracle's own statistical read and an
   independent volume-confirmation engine pointing the same way is real
   confluence from two different lenses, not just one model being
   confident in itself.

```
let oracleDir = nextExpiry:5.direction
let oracleConf = nextExpiry:5.conf
let pWin = nextExpiry:5.value
let regime = kagi.regime()
let notChoppy = regime != "choppy"
let ebBar = effort.ohlc(-1)
let ebDir = ebBar.c - ebBar.o
let ebConfirmed = effort.confirmed(-1) and effort.ratio(-1) >= 1.0
let ebAgrees = ebConfirmed and ((oracleDir == call and ebDir > 0) or (oracleDir == put and ebDir < 0))
call when oracleDir == call and notChoppy and ebAgrees and gate(pWin, payout.value, 0.02)
put when oracleDir == put and notChoppy and ebAgrees and gate(pWin, payout.value, 0.02)
confidence = oracleConf
expiry = 5
```

**Honesty note, stated plainly because it's the one real tradeoff here**:
`nextExpiry:5` is a bare verdict-source identifier, not a raw namespace
call - per this project's own backtest-mechanism rule (`claude/chart-
engine-roadmap-progress.md`), `meta_strategy_backtest`/`mslbacktest.ts`
never replays a bare source at all, so this script can only be read LIVE,
never walked bar-by-bar through the ordinary MSL backtester. The Oracle has
its own SEPARATE offline-validation path (the Expiry Probability Surface's
walk-forward replay, `claude/expiry-probability-surface-chart.md`) for
judging its own historical accuracy - that's the right tool for validating
this script's core signal, not `meta_strategy_backtest`.

Verified by parsing and evaluating against a synthetic series and a
synthetic `nextExpiry:5` reads-map stub across 40 seeds - fires correctly
on `call`, correctly stands aside when regime/effort/gate don't clear, no
runtime errors.

## 15. Trend + Pullback, SMC/MRC/candle/2-min-expiry confluence

User-specified logic, translated directly: find the trend, trade only the
pullback within it (never the breakout, never a ranging/choppy tape), and
require four independent confirmations to agree before firing.

- **Trend + direction** - `kagi.regime() == "trending"` gates out
  ranging/choppy entirely; `kagi.direction()` gives the signed trend (1 up,
  -1 down).
- **Pullback** - `mrc.directionalDelta(-1)` moving *against* the trend
  direction on the latest bar is the dip (in an uptrend) or bounce (in a
  downtrend) being bought/faded back toward trend.
- **Entry confirmation**: SMC's aggregate direction (`smc.dir`) agrees with
  the *trend* direction (not the pullback - the bet is the pullback resolves
  back toward trend); MRC's response ratio is >= 1.0, the high-continuation
  bucket this project corrected example #13 onto rather than the
  low-response/fade side; a reversal-type candle pattern (Hammer/Bullish
  Engulfing for the up case, Shooting Star/Bearish Engulfing for the down
  case) confirms right at the pullback extreme; and the 2-minute Next-Expiry
  Oracle rung (`nextExpiry:2`) agrees with real probability mass
  (`.value > 0.5`) in the same direction.
- **BOS/CHoCH filters** (added after a "how do we avoid wrong ones" chat -
  see below): `smc:BOS` is read apart from the blended `smc` aggregate and
  required to agree with trend direction as a SECOND, independent
  trend-confirmation vote, but only after three false-positive filters pass
  it; `smc:CHOCH` firing against the trade is an outright veto unless a
  liquidity sweep explains it away.

```
let regime = kagi.regime()
let trending = regime == "trending"
let trendDir = kagi.direction()

let d = mrc.directionalDelta(-1)
let rr = mrc.responseRatio(-1)

let pullbackDown = trendDir == 1 and d < 0
let pullbackUp = trendDir == -1 and d > 0

# --- BOS confirmation, filtered against the three common false-BOS causes ---
let bosUp = smc:BOS.dir == call
let bosDown = smc:BOS.dir == put
let bosDisplaced = ohlc(-1).range >= ind.atr(14)[-1] * 1.0        # real displacement, not a wick clip
let bosParticipation = effort.confirmed(-1) and effort.ratio(-1) >= 1.0  # real volume behind the break
let ebBar = effort.ohlc(-1)
let ebDir = ebBar.c - ebBar.o
let bosConfirmedUp = bosUp and bosDisplaced and bosParticipation and ebDir > 0
let bosConfirmedDown = bosDown and bosDisplaced and bosParticipation and ebDir < 0
let bosHeldUp = since(smc:BOS.dir == call) >= 1    # held at least one closed bar, not an instant rejection
let bosHeldDown = since(smc:BOS.dir == put) >= 1

# --- CHoCH veto, unless a liquidity sweep explains it (stop-hunt, not a real flip) ---
let chochAgainstUp = smc:CHOCH.active and smc:CHOCH.dir == put
let chochAgainstDown = smc:CHOCH.active and smc:CHOCH.dir == call
let sweepAgainstUp = smc:LIQUIDITY_SWEEP.active and smc:LIQUIDITY_SWEEP.dir == put
let sweepAgainstDown = smc:LIQUIDITY_SWEEP.active and smc:LIQUIDITY_SWEEP.dir == call
let chochVetoUp = chochAgainstUp and not sweepAgainstUp
let chochVetoDown = chochAgainstDown and not sweepAgainstDown

let smcUp = smc.dir == call
let smcDown = smc.dir == put

let bullPattern = candle('Hammer', call).active or candle('Bullish Engulfing', call).active
let bearPattern = candle('Shooting Star', put).active or candle('Bearish Engulfing', put).active

let exp2Up = nextExpiry:2.direction == call and nextExpiry:2.value > 0.5
let exp2Down = nextExpiry:2.direction == put and nextExpiry:2.value > 0.5

let respOk = rr >= 1.0

call when trending and trendDir == 1 and pullbackDown and smcUp and bosConfirmedUp and bosHeldUp and not chochVetoUp and respOk and bullPattern and exp2Up and gate(0.55, payout.value, 0.0)
put when trending and trendDir == -1 and pullbackUp and smcDown and bosConfirmedDown and bosHeldDown and not chochVetoDown and respOk and bearPattern and exp2Down and gate(0.55, payout.value, 0.0)

confidence = 62
expiry = 2
```

**Why these specific filters**: BOS (Break of Structure, a swing point taken
out WITH the trend) and CHoCH (Change of Character, taken out AGAINST the
trend) are both part of the blended `smc` aggregate already, but blended
away the distinction that matters here - a BOS should reinforce the trend
read, while a live CHoCH is a warning the "trend" we're pulling back within
may already be ending. Read separately via `smc:BOS`/`smc:CHOCH` (and
`smc:LIQUIDITY_SWEEP`), three failure modes get filtered:

1. **Wick-clip false break** - `bosDisplaced` requires the breaking bar's
   range be at least one ATR, so a thin spike through a swing point doesn't
   count as a real break.
2. **No-participation break** - `bosParticipation` requires Effort Bricks
   confirm real volume behind the move in the break's direction - a
   structural break nobody traded into is the classic liquidity-grab trap,
   not a real BOS.
3. **Instant-rejection break** - `bosHeldUp`/`bosHeldDown` use `since()` to
   require the break has held for at least one full closed bar rather than
   acting on the very bar it first prints, so a break-then-snap-back doesn't
   get traded as confirmed structure.

And one veto: a `smc:CHOCH` firing against the trade kills it outright
UNLESS `smc:LIQUIDITY_SWEEP` fired the same way first - a CHoCH that's
really just the aftermath of a stop-hunt sweep is a known SMC false flag,
not a genuine character change, so the sweep context un-vetoes it.

**Bug caught while verifying this, worth keeping visible**: the first draft
wrote `candle('Hammer', call) or candle('Bullish Engulfing', call)` with no
`.active`. Every `SIGNAL_FUNCS` call (`candle()` included) returns a
composite read object, not a raw boolean - `and`/`or` reject a composite
unconditionally (`truthy()` throws). Fixed by adding `.active` to both
pattern checks; this exact gotcha is now documented in `claude/msl-full-
reference.md` §5.5b/§5.11, whose own worked example had the same bug until
this fix prompted a correction there too.

**Honesty note**: like example #14, this script is live-only. `smc`,
`smc:BOS`, `smc:CHOCH`, `smc:LIQUIDITY_SWEEP`, and `nextExpiry:2` are all
bare verdict-source identifiers, and per this project's backtest-mechanism
rule, `meta_strategy_backtest`/`mslbacktest.ts` never replays a bare source,
regardless of what backs it - so this can be read live but not walked
bar-by-bar through the ordinary MSL backtester.

Verified by parsing and evaluating against a synthetic candle series and a
synthetic reads-map stub (providing `smc`/`smc:BOS`/`smc:CHOCH`/
`smc:LIQUIDITY_SWEEP`/`nextExpiry:2`/pattern reads) across 60 seeds, with
the `since()` bar-close state tracker wired in (`state: { keyPrefix,
barTimeSec }`) so the hold-confirmation filter actually exercises real
state rather than failing closed - zero runtime errors. Zero call/put fires
in the synthetic run is expected and not a logic defect: the synthetic
series rarely produces `kagi.regime() == "trending"` simultaneously with
every confirmation AND every false-positive filter AND no veto, which is
the point of stacking this many independent checks - the test's purpose
(proving no runtime errors, correct field access, correct `since()` wiring)
was achieved.

## 16. Calibrated Regime Edge (payout-proven, self-calibrating)

The strategy vet's answer to "which of these should I actually trade?" -
and the reason it is built the way it is was measured, not argued. Every
builtin strategy was run over three synthetic markets: a driftless random
walk, one with planted lag-1 momentum, one with planted lag-1 mean
reversion. On the random walk all of them settle at ~50% (no look-ahead
anywhere). On the other two almost every rule turned out to be
**fixed-polarity**: the trend-followers that won 57-63% in the momentum
market lost at 35-44% in the reverting one, and the faders did the exact
opposite. A fixed rule has no edge of its own - it borrows its sign from
whichever regime the pair is in and pays the house when the regime flips.

`calibrated-edge` (`analytics/calibratededge.ts`, a builtin strategy) does
not assume either. On the pair's own trailing closed bars it looks up one
number - *after a bar that moved about this hard (quiet / normal / impulse),
how often did price keep going?* - and trades continuation, or the fade,
only when ALL of these hold:

1. the **Wilson lower bound** of that rate (not the raw ratio - 9/12 is not
   "75% proven") clears this trade's breakeven `1/(1+payout)` plus a
   cushion;
2. the same side leads in **both halves** of the window;
3. the same side still leads in the **newest fifth** of the samples.

Otherwise it stands aside. This wrapper feeds the pair's REAL live payout
into the breakeven gate, which the builtin's fixed `payoutPct` param cannot
do on its own.

```
configure strategy.calibrated-edge.payoutPct = if(payout.value > 0, payout.value * 100, 85)
configure strategy.calibrated-edge.window = 230
configure strategy.calibrated-edge.zConf = 2
configure strategy.calibrated-edge.horizon = 1
call when builtinSig('calibrated-edge', call).active
put when builtinSig('calibrated-edge', put).active
confidence = 70
expiry = 1
```

`window = 230` is deliberate, not a tuning choice: a live MSL script only
sees the last 240 closed bars. Arming the builtin `calibrated-edge`
directly on a Bot or the Auto Trader (`strategy` source) runs it on 1500
bars with its full 600-bar window - that is the stronger way to run it, and
the only one with the research gate, payout floor and streak breaker in
front of it. Keep `horizon` equal to the expiry in bars.

Measured on synthetic data (next-bar settlement, 85% payout, breakeven
54.1%), full 600-bar window:

| market | trades / 13k bars | win rate |
| --- | --- | --- |
| driftless random walk | 0 | - |
| planted momentum (+0.20) | 1355 | 63.0% |
| planted reversion (-0.20) | 1834 | 62.5% |
| weak momentum (+0.10) | 217 | 58.1% |
| regime flipping every 400 bars | 1 | - |

**What that table does and does not show.** It shows the gate is honest: no
trades where there is nothing to find, the right side in both regimes, and
silence when the regime is too unstable to prove. It does NOT show that
real pairs carry a persistent enough regime for it to fire profitably -
only this pair's own walk-forward on real history can show that. Its known
failure mode is a regime that flips faster than the calibration window: the
evidence then peaks exactly as the regime ends (with a 600-bar window and
the looser z = 1.64, the 400-bar-flip market produced 49 trades at 26.5%).
`z = 2` is the default for that reason; the engine-level streak breaker and
daily loss limit are the backstop, not this script.

---

#16 was verified differently, because it is the one meant to be traded: end to
end through the real `MetaStrategyService.evaluate()` path (live payout read,
two-pass `configure`, `builtinSig()` resolver) on the three synthetic markets
above, plus the regression tests in `tests/msl.test.ts`.

The first 15 were verified by parsing and evaluating each one with
`evaluateStrategyScript()` against synthetic candle series and a synthetic
tick buffer (the same smoke-test discipline this project uses before any
primitive ships), confirming each one parses, evaluates without a runtime
error, and produces a sane direction/confidence - not just that the syntax
looks plausible.
