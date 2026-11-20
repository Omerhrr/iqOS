// Builtin meta-strategy specs ported from TradingView scripts (Daveatt BEST template + Bj Bot, KivancOzbilgic PMax Explorer, LuxAlgo Smart Money Concepts, Hull Suite) and the swing-engine strategies (Elliott, S/R, retracement, trendline).
// Generated from mini-services/trading-core/examples/*.msl - the examples stay the readable source; seedBuiltinExamples() in metastrategy.ts saves these on start (idempotent).
export const BUILTIN_TV_SPECS: { id: string; name: string; script: string }[] = [
  {
    id: 'meta:builtin-tv-ma-cross-bot',
    name: 'Builtin TV: MA cross bot (Bj Bot / Daveatt)',
    script: `
# MSL version of TradingView "Bj Bot" (3Commas) - moving-average cross entry.
# Stops/targets/trailing/flip/3Commas JSON do not apply to a binary option: the expiry settles the trade. What carries over is the ENTRY and the FILTERS.
# MA types (TradingView getMA): "ema" "hema" "sma" "hma" "wma" "dema" "vwma" "vwap" "t3" (plus "kama")
let fast = ind.ma("ema", 21)
let slow = ind.ma("ema", 50)

let crossUp = fast.crossed("up", slow)
let crossDn = fast.crossed("down", slow)
let haveAtr = ind.atr(14)[-1] > 0

# Filters (switch a line off by deleting it from the \`and\` chain)
let timeOk = not session.inWindow("00:00", "03:00")      # useTimeFilter: ignore 00:00-03:00 UTC
let dateOk = session.inDates("2026-01-01", "2026-12-30")  # start / end filter (UTC)

call when crossUp and haveAtr and timeOk and dateOk      # longTrades
put  when crossDn and haveAtr and timeOk and dateOk      # shortTrades
expiry = 3
`,
  },
  {
    id: 'meta:builtin-tv-strategy-template',
    name: 'Builtin TV: BEST strategy template (Daveatt)',
    script: `
# MSL version of TradingView "BEST Strategy Template" (Daveatt): ANY signal + the whole risk-management shell around it.
# In the original the signal came from another indicator (+1 bull / -1 bear). Here it is any MSL condition - replace the two \`let\` lines.
# Not applicable to binary options (the expiry settles every trade): stop loss, take profit, trailing stop, close-on-opposite, pyramiding, custom close.
# risk.* reads your own results: live = Meta Trader trades since the kernel started; test it with the replay tester (/msl_replay) - the plain candle backtester has no trade clock.

# ---- 1. THE SIGNAL (replace with yours) ----
let bull = ind.ma("ema", 9).crossed("up", ind.ma("ema", 21))
let bear = ind.ma("ema", 9).crossed("down", ind.ma("ema", 21))

# ---- 2. THE SHELL ----
let inSession   = session.inWindow("07:00", "21:00")             # Trading Session (UTC)
let inDates     = session.inDates("2026-01-01", "2026-12-30")    # Date Range Filtering
let lossStreak  = risk.losses() < 15                              # Max consecutive losing trades
let winStreak   = risk.wins() < 15                                # Max consecutive winning trades
let lossDays    = risk.lossDays() < 3                             # Max consecutive days with a loss
let drawdown    = risk.drawdownAll() < 10                         # Max total drawdown (in stakes: 1 stake = 1 trade's amount)
let dayLoss     = risk.todayPnl() > -3                            # Max intraday loss (stakes)
let dayTrades   = risk.trades() < 10                              # Max trades per day
let weekTrades  = risk.tradesWeek() < 50                          # Max trades per week
let allowed = inSession and inDates and lossStreak and winStreak and lossDays and drawdown and dayLoss and dayTrades and weekTrades

call when bull and allowed    # OpenDirection ALL / LONG
put  when bear and allowed    # OpenDirection ALL / SHORT
expiry = 3
`,
  },
  {
    id: 'meta:builtin-tv-pmax-explorer',
    name: 'Builtin TV: PMax Explorer (KivancOzbilgic)',
    script: `
# MSL version of TradingView "PMax Explorer" (Kivanc Ozbilgic) - the STRATEGY half.
# PMax = a SuperTrend-style trailing line built on a MOVING AVERAGE (not on price) with ATR-distance bands.
# ind.pmax(maType, maLen, atrLen, mult, src, wilderAtr):
#   maType  "sma" "ema" "wma" "tma" "var" "wwma" "zlema" "tsf"   (the original's dropdown)
#   src     "hl2" (original default) "hlc3" "ohlc4" "close" "open" "high" "low"
#   wilderAtr 1 = atr() [original default "Change ATR calculation method" on], 0 = sma(tr)
# Fields: .line (PMax) .ma (the moving average) .dir (+1 up / -1 down) .atr ; .trend/.tsl = the screener's own recursion
let pm = ind.pmax("ema", 10, 10, 3, "hl2", 1)

# the original's entries: MA crossing PMax (strategy.entry long / short). A binary option settles at expiry, so "reverse the position" becomes "take the next signal".
let buyK  = pm.ma.crossed("up", pm.line)
let sellK = pm.ma.crossed("down", pm.line)

# optional: the original also offers PRICE crossing PMax instead of the MA. Close-vs-line version:
#   let buyP  = ohlc(-1).c > pm.line[-1] and ohlc(-2).c <= pm.line[-2]
#   let sellP = ohlc(-1).c < pm.line[-1] and ohlc(-2).c >= pm.line[-2]
let dateOk = session.inDates("2026-01-01", "2026-12-30")   # the original's From/To day-month-year filter (UTC)

call when buyK and dateOk
put  when sellK and dateOk
expiry = 3
`,
  },
  {
    id: 'meta:builtin-tv-pmax-screener',
    name: 'Builtin TV: PMax screener',
    script: `
# The SCREENER half of "PMax Explorer": which assets just reversed / are in a trend. The original hard-coded 20 symbols and drew a text label.
# Here you run ONE script across ALL assets with the scan-all button (Meta Strategy panel) or /msl_scan - each script below is one list.
#
# 1) POTENTIAL REVERSAL (the trend flipped on the bar that just closed)  - the original's "Potential Reversal"
#    call = flipped up, put = flipped down
let pm = ind.pmax("ema", 10, 10, 3, "hl2", 1)
call when pm.trend[-1] == 1 and pm.trend[-2] == -1
put  when pm.trend[-1] == -1 and pm.trend[-2] == 1
#
# 2) CONFIRMED REVERSAL (it flipped one bar ago and has held)            - replace the two lines above with:
#    call when pm.trend[-2] == 1 and pm.trend[-3] == -1 and pm.trend[-1] == 1
#    put  when pm.trend[-2] == -1 and pm.trend[-3] == 1 and pm.trend[-1] == -1
#
# 3) UPTREND / DOWNTREND LISTS (every asset currently in that trend)     - replace with:
#    call when pm.trend[-1] == 1
#    put  when pm.trend[-1] == -1
`,
  },
  {
    id: 'meta:builtin-tv-luxalgo-smc',
    name: 'Builtin TV: LuxAlgo Smart Money Concepts',
    script: `
# MSL version of TradingView "Smart Money Concepts [LuxAlgo]" - an INDICATOR (it draws structure, it has no entries of its own), so here it is as ind.lux(...)
# plus three ready strategies built from its alert conditions. Fields are per-bar series: lx.field[-1] = latest closed bar. Event fields are 1 on the bar they fire.
# ind.lux(swingLen=50, internalLen=5, eqLen=3, eqThr=0.1, obRange=0, obClose=0, confluence=0, fvgAuto=1)   (= the TradingView inputs, same defaults)
#   obRange 0 = ATR volatility filter, 1 = cumulative mean range;  obClose 0 = mitigate order blocks by high/low, 1 = by close;  confluence 1 = internal-structure confluence filter
# Needs ~200+ bars (the script's ATR200). On a 1m chart a swing length of 50 is slow - try ind.lux(20, 5) as well and sweep it.
let lx = ind.lux()

# --- STRATEGY 1: pullback continuation --------------------------------------------------------------------------------------------------------
# the SWING trend is up, price pulled back into the discount half of the trailing range, and the INTERNAL structure just turned bullish again (internal CHoCH)
# (a swing CHoCH itself fires when price breaks out, i.e. near the TOP of the range, so "swing CHoCH + discount" can never happen - that is why this uses the internal one)
let longPb  = lx.swingTrend[-1] == 1  and lx.pos[-1] < 0.5 and lx.internalBullChoch[-1] == 1
let shortPb = lx.swingTrend[-1] == -1 and lx.pos[-1] > 0.5 and lx.internalBearChoch[-1] == 1
call when longPb
put  when shortPb

# --- STRATEGY 2: order-block retest (swap in for the two lines above) ---------------------------------------------------------------------------
#   price closes back inside a fresh bullish swing order block while the swing trend is still up (and the reverse for bearish)
#   call when lx.swingObBullIn[-1] == 1 and lx.swingTrend[-1] == 1 and lx.swingObBullBreak[-1] == 0
#   put  when lx.swingObBearIn[-1] == 1 and lx.swingTrend[-1] == -1 and lx.swingObBearBreak[-1] == 0

# --- STRATEGY 3: equal-highs / equal-lows liquidity grab fade -----------------------------------------------------------------------------------
#   equal highs were just detected (a pool of stops above): fade a close back below them. EQH level = lx.eqhLevel
#   put  when lx.eqh[-1] == 1 and lx.swingTrend[-1] == -1
#   call when lx.eql[-1] == 1 and lx.swingTrend[-1] == 1

# --- other alerts available: internal structure (internalBullBos ...), fair value gaps (fvgBull / fvgBullIn ...), order-block breaks (swingObBullBreak ...),
#     strong/weak high-low (lx.strongHigh[-1] is a price or NaN), previous day/week/month levels (lx.pdh[-1], lx.pwl[-1] ...)
expiry = 3
`,
  },
  {
    id: 'meta:builtin-tv-hull-suite',
    name: 'Builtin TV: Hull Suite strategy',
    script: `
# MSL version of TradingView "Hull Suite Strategy" (InSilico indicator, DashTrader strategy).
# The Hull moving average, three variations: "hma" (WMA based), "ehma" (EMA based), "thma" (triple, evaluated at len/2 exactly like the script's Mode() switch).
# ind.hull(mode, len, src):  src = "close" "hl2" "hlc3" "ohlc4" "open" "high" "low".   The script's HULL[0] is h[-1] here and HULL[2] is h[-3] (series index -1 = latest closed bar).
# Original rule: long while HULL[0] > HULL[2], short while HULL[0] < HULL[2]. A binary option settles at expiry, so the trade fires on the FLIP (the bar the Hull turns), not every bar.
let h = ind.hull("hma", 55, "close")      # 55 = swing entries, 180-200 = floating support/resistance (the original's note)

let turnUp   = h[-1] > h[-3] and h[-2] <= h[-4]
let turnDown = h[-1] < h[-3] and h[-2] >= h[-4]
let dateOk   = session.inDates("2026-01-01", "2030-12-30")    # the original's backtest start/stop dates (UTC)

# "Strategy Direction": keep both lines for "all", or delete one for "long" / "short"
call when turnUp and dateOk
put  when turnDown and dateOk
expiry = 3
`,
  },
  {
    id: 'meta:builtin-ew-wave3',
    name: 'Builtin: Elliott wave-3 entry',
    script: `
# Elliott: wave 2 just completed (point 2 confirmed, wave 3 under way). Take the wave-3 entry if wave 2 retraced 50-78.6% of wave 1
let ok = ew2.ok() and ew2.wave() == 3 and ew2.ratio(2) >= 0.5 and ew2.ratio(2) <= 0.786
call when ok and ew2.dir() == 1 and px.close[-1] > px.high[-2]
put when ok and ew2.dir() == -1 and px.close[-1] < px.low[-2]
expiry = 5
`,
  },
  {
    id: 'meta:builtin-ew-abc-reversal',
    name: 'Builtin: Elliott wave-5 end / ABC fade',
    script: `
# Elliott: a finished 5-wave rise (wave 5 confirmed, correction just starting) -> fade the top; mirrored for a falling impulse
put when ew2.ok() and ew2.dir() == -1 and ew2.wave() == 6 and ew2.rule(3) and px.close[-1] < px.low[-2]
call when ew2.ok() and ew2.dir() == 1 and ew2.wave() == 6 and ew2.rule(3) and px.close[-1] > px.high[-2]
expiry = 5
`,
  },
  {
    id: 'meta:builtin-sr-swing-bounce',
    name: 'Builtin: S/R swing bounce',
    script: `
# S&R from swing pivots: bounce off the latest swing low / rejection at the latest swing high (within 0.5 ATR)
call when near(px.low[-1], sw.low(1), 0.5) and px.close[-1] > px.open[-1]
put when near(px.high[-1], sw.high(1), 0.5) and px.close[-1] < px.open[-1]
expiry = 3
`,
  },
  {
    id: 'meta:builtin-fib-retracement',
    name: 'Builtin: Fibonacci pullback continuation',
    script: `
# Retracement: trade the trend continuation when the pullback reaches the 0.5-0.618 zone of the last leg
let up = sw.dir() == -1 and sw.leg(1) > 0
let z = sw.retr()
call when sw.pivotType(1) == 1 and sw.leg(1) > 3 and z >= 0.5 and z <= 0.618 and px.close[-1] > px.close[-2]
put when sw.pivotType(1) == -1 and sw.leg(1) < -3 and z >= 0.5 and z <= 0.618 and px.close[-1] < px.close[-2]
expiry = 5
`,
  },
  {
    id: 'meta:builtin-trendline-touch',
    name: 'Builtin: Trendline touch',
    script: `
# Trendline from the last two swing lows (barsAgo from sw.lowAge): buy a touch from above
let tl = lineAt(sw.low(2), sw.lowAge(2), sw.low(1), sw.lowAge(1), 0)
call when near(px.low[-1], tl, 0.4) and px.close[-1] > tl and sw.low(1) > sw.low(2)
expiry = 3
`,
  },
  {
    id: 'meta:builtin-sr-bounce-hold20',
    name: 'Builtin: S/R swing bounce + 20s confirmation hold',
    script: `
# S/R swing bounce, variation 1: when the setup fires, DO NOT act - hold 20 s and only fire if price has moved WITH the trade by then
# (timing.hold: aborts early if price goes against it by 0.3 ATR, aborts if the setup disappears, cancels if it "went nowhere"). LIVE only (Omni / Meta Trader); not backtestable.
let holdSec = 20          # confirmation window
let minMove = 0.05        # ATR the price must have moved in the trade direction when the time is up
let maxAgainst = 0.30     # ATR against the trade that cancels it early
let setupCall = near(px.low[-1], sw.low(1), 0.5) and px.close[-1] > px.open[-1]
let setupPut = near(px.high[-1], sw.high(1), 0.5) and px.close[-1] < px.open[-1]
# the holds are evaluated OUTSIDE any if so they keep seeing their condition every poll
let goCall = timing.hold("srb-call", setupCall, 1, holdSec, minMove, maxAgainst)
let goPut = timing.hold("srb-put", setupPut, -1, holdSec, minMove, maxAgainst)
call when goCall == 1
put when goPut == 1
expiry = 3
`,
  },
  {
    id: 'meta:builtin-sr-bounce-hold20-bodyveto',
    name: 'Builtin: S/R swing bounce + 20s hold + big-body stand-down',
    script: `
# S/R swing bounce, variation 2: same setup and the same 20 s hold, but even if price went the right way, STAND DOWN when the move was too big
# (the forming candle's body, or the move since the signal, is already large - the entry would be chasing an extended bar). Needs the Omni Trader (live() = the forming bar). LIVE only.
let holdSec = 20
let minMove = 0.05        # ATR with the trade, required at the end of the hold
let maxAgainst = 0.30
let maxBody = 0.80        # forming-candle body above this many ATR = too big, stand down
let maxChase = 0.60       # move since the signal above this many ATR = already ran, stand down
let atr = ind.atr(14)[-1]
let setupCall = near(px.low[-1], sw.low(1), 0.5) and px.close[-1] > px.open[-1]
let setupPut = near(px.high[-1], sw.high(1), 0.5) and px.close[-1] < px.open[-1]
let goCall = timing.hold("srb2-call", setupCall, 1, holdSec, minMove, maxAgainst)
let goPut = timing.hold("srb2-put", setupPut, -1, holdSec, minMove, maxAgainst)
# the hold is already consumed when it fires, so a veto here cancels that signal for good
let tooBig = live().body > maxBody * atr
call when goCall == 1 and not tooBig and timing.move("srb2-call") <= maxChase
put when goPut == 1 and not tooBig and timing.move("srb2-put") <= maxChase
expiry = 3
`,
  },
  {
    id: 'meta:builtin-sr-bounce-nc',
    name: 'Builtin: S/R swing bounce + next-candle oracle agrees',
    script: `
# S/R swing bounce, variation 3: the next-candle oracle must AGREE with the setup's direction (nc.side()), otherwise no trade.
# Candle-derived, so it BACKTESTS (needs 320+ closed bars). Raise ncMinConf to also demand a confident oracle.
let ncMinConf = 0         # 0 = direction only; e.g. 55 = the oracle must also be at least 55% confident
let setupCall = near(px.low[-1], sw.low(1), 0.5) and px.close[-1] > px.open[-1]
let setupPut = near(px.high[-1], sw.high(1), 0.5) and px.close[-1] < px.open[-1]
call when setupCall and nc.ok() and nc.side() == "call" and nc.conf() >= ncMinConf
put when setupPut and nc.ok() and nc.side() == "put" and nc.conf() >= ncMinConf
expiry = 3
`,
  },
  {
    id: 'meta:builtin-sr-bounce-nc-hold20',
    name: 'Builtin: S/R swing bounce + oracle agrees + 20s hold',
    script: `
# S/R swing bounce, variation 4: oracle agreement + the 20 s confirmation hold. The oracle must agree to ARM the timer, and if it stops agreeing
# during the wait the hold aborts. Fires only if price then moved WITH the trade. LIVE only (timing.hold is not backtestable).
let holdSec = 20
let minMove = 0.05        # ATR with the trade when the 20 s are up
let maxAgainst = 0.30     # ATR against the trade that cancels it early
let ncMinConf = 0
let setupCall = near(px.low[-1], sw.low(1), 0.5) and px.close[-1] > px.open[-1] and nc.ok() and nc.side() == "call" and nc.conf() >= ncMinConf
let setupPut = near(px.high[-1], sw.high(1), 0.5) and px.close[-1] < px.open[-1] and nc.ok() and nc.side() == "put" and nc.conf() >= ncMinConf
let goCall = timing.hold("srnc-call", setupCall, 1, holdSec, minMove, maxAgainst)
let goPut = timing.hold("srnc-put", setupPut, -1, holdSec, minMove, maxAgainst)
call when goCall == 1
put when goPut == 1
expiry = 3
`,
  },
  {
    id: 'meta:builtin-sr-bounce-nc-hold20-bodyveto',
    name: 'Builtin: S/R swing bounce + oracle + 20s hold + body check',
    script: `
# S/R swing bounce, variation 5: oracle agreement + 20 s hold + body check. After the hold confirms, STAND DOWN if the forming candle's body or the move
# since the signal is already big (entry would chase an extended bar). Needs the Omni Trader (live() = the forming bar). LIVE only.
let holdSec = 20
let minMove = 0.05
let maxAgainst = 0.30
let maxBody = 0.80        # forming-candle body above this many ATR = too big
let maxChase = 0.60       # move since the signal above this many ATR = already ran
let ncMinConf = 0
let atr = ind.atr(14)[-1]
let setupCall = near(px.low[-1], sw.low(1), 0.5) and px.close[-1] > px.open[-1] and nc.ok() and nc.side() == "call" and nc.conf() >= ncMinConf
let setupPut = near(px.high[-1], sw.high(1), 0.5) and px.close[-1] < px.open[-1] and nc.ok() and nc.side() == "put" and nc.conf() >= ncMinConf
let goCall = timing.hold("srnc2-call", setupCall, 1, holdSec, minMove, maxAgainst)
let goPut = timing.hold("srnc2-put", setupPut, -1, holdSec, minMove, maxAgainst)
let tooBig = live().body > maxBody * atr
call when goCall == 1 and not tooBig and timing.move("srnc2-call") <= maxChase
put when goPut == 1 and not tooBig and timing.move("srnc2-put") <= maxChase
expiry = 3
`,
  },
  {
    id: 'meta:builtin-trend-pullback-nc-timing',
    name: 'Builtin: trend pullback + oracle agrees + early-bar 15s hold',
    script: `
# Trend pullback + next-candle oracle + timing. Three gates, all live-only (timing.hold cannot be backtested):
#  1. TREND   : ind.ema(8) vs ind.ema(21) gives the side; the last closed candle was a counter-trend pullback that still closed on the right side of the slow ema.
#  2. ORACLE  : the next-candle oracle nc must agree with the trend side (and keep agreeing - if it flips during the wait the hold aborts).
#  3. TIMING  : only ARM in the first armWindow seconds of a new bar (so the trade is placed early, while the signal is fresh), then hold
#               holdSec seconds and fire only if price moved WITH the trade by >= minMove ATR; abort early at maxAgainst ATR against.
let armWindow = 25        # seconds after the bar opens during which a setup may arm
let holdSec = 15
let minMove = 0.05        # ATR with the trade when the hold ends
let maxAgainst = 0.30     # ATR against the trade that cancels it early
let ncMinConf = 0
let early = timing.barAge() < armWindow
let fast = ind.ema(8)[-1]
let slow = ind.ema(21)[-1]
let up = fast > slow and px.close[-1] > slow
let down = fast < slow and px.close[-1] < slow
let pullUp = up and px.close[-1] < px.open[-1]       # red candle inside an uptrend
let pullDown = down and px.close[-1] > px.open[-1]   # green candle inside a downtrend
let agreeCall = nc.ok() and nc.side() == "call" and nc.conf() >= ncMinConf
let agreePut = nc.ok() and nc.side() == "put" and nc.conf() >= ncMinConf
# once armed, the hold keeps the setup alive through the wait even after the arm window has passed: only the ARM is time-gated
let armCall = pullUp and agreeCall
let armPut = pullDown and agreePut
let goCall = timing.hold("tpnc-call", armCall and (early or timing.state("tpnc-call") == "waiting"), 1, holdSec, minMove, maxAgainst)
let goPut = timing.hold("tpnc-put", armPut and (early or timing.state("tpnc-put") == "waiting"), -1, holdSec, minMove, maxAgainst)
call when goCall == 1
put when goPut == 1
expiry = 3
`,
  },
  {
    id: 'meta:builtin-nc-pure-hold',
    name: 'Builtin: pure next-candle oracle + 20s direction hold',
    script: `
# Pure next-candle oracle + a timing confirmation. No other setup: whatever side nc calls ARMS a hold; if price then moves WITH that side
# the trade fires, otherwise it is cancelled. LIVE only (timing.hold cannot be backtested).
#  - if nc stops agreeing (or flips) during the wait, the hold aborts
#  - once a hold ends (fired or cancelled) it stays latched until nc has stopped calling that side, so one lingering call cannot re-arm in a loop
let holdSec = 20
let minMove = 0.05        # ATR with the trade when the hold ends
let maxAgainst = 0.30     # ATR against the trade that cancels it early
let ncMinConf = 0         # raise to only arm on a confident oracle
let armCall = nc.ok() and nc.side() == "call" and nc.conf() >= ncMinConf
let armPut = nc.ok() and nc.side() == "put" and nc.conf() >= ncMinConf
let goCall = timing.hold("nc-call", armCall, 1, holdSec, minMove, maxAgainst)
let goPut = timing.hold("nc-put", armPut, -1, holdSec, minMove, maxAgainst)
call when goCall == 1
put when goPut == 1
expiry = 3
`,
  },
  {
    id: 'meta:builtin-mtf-story-bias',
    name: 'Builtin: multi-timeframe story bias (4h + 15m -> this timeframe)',
    script: `
# MULTI-TIMEFRAME STORY BIAS. The 4h (session) and 15m candles are each read through their candle story, 14-bar window, 21-bar swing structure and their Renko, Kagi, Baseline and
# Heikin Ashi equivalents; every reading is a vote, the frames are blended into a context lean, and THIS timeframe's own story is the trigger. A direction exists only when they agree.
# Candle-derived, so it backtests (the higher frames are aggregated from this chart's candles). The votes and weights are judgement, not fitted: backtest before trusting minStrength.
let minStrength = 55      # 0-100 alignment strength required (NOT a win probability)
let m = story.mtf("4h", "15m")
call when m.direction == "call" and m.strength >= minStrength
put when m.direction == "put" and m.strength >= minStrength
expiry = 3
`,
  },
  {
    id: 'meta:builtin-mtf-story-bias-hold20',
    name: 'Builtin: multi-timeframe story bias + 20s hold',
    script: `
# Same multi-timeframe story bias, plus the 20 s confirmation hold: when the bigger picture and this timeframe agree, wait 20 s and fire only if price then moved WITH the trade.
# LIVE only (timing.hold cannot be backtested).
let minStrength = 55
let holdSec = 20
let minMove = 0.05        # ATR with the trade when the hold ends
let maxAgainst = 0.30     # ATR against the trade that cancels it early
let m = story.mtf("4h", "15m")
let armCall = m.direction == "call" and m.strength >= minStrength
let armPut = m.direction == "put" and m.strength >= minStrength
let goCall = timing.hold("mtf-call", armCall, 1, holdSec, minMove, maxAgainst)
let goPut = timing.hold("mtf-put", armPut, -1, holdSec, minMove, maxAgainst)
call when goCall == 1
put when goPut == 1
expiry = 3
`,
  },
  {
    id: 'meta:builtin-cause-effect-pm',
    name: 'Builtin: cause-effect predicted move',
    script: `
# CAUSE -> EFFECT PREDICTED MOVE. Cause = volume + footprint (estimated) + ticks (when available) + MFI + A/D slope; effect = the candle, wick psychology, ROC and CCI.
# The model looks up what the NEXT candle did after the same kind of cause in the past, tilts it by the live cause and by support/resistance retests, and reports a probability.
# The same model on the 5m chart is blended in (story.pm("15m") picks another): opposite frames = no call.
# It only trades when the walk-forward track record (each past call made with only the bars before it) beat 50%. A judgement-weighted model, not a fitted one: backtest before trusting it.
let minConf = 45
let maxAge = 12          # seconds into the new candle after which the read is STALE (it describes the candle that just closed) - skip the signal
let m = story.pm()
let fresh = timing.barAge() < maxAge     # the prediction is for the candle that just opened; late in it, the read is old news
let ok = fresh and m.ok and m.validated and m.bucketN >= 15 and m.strength >= minConf and m.alignment != "conflict"
call when ok and m.direction == "call" and not m.atResistance
put when ok and m.direction == "put" and not m.atSupport
expiry = 1
`,
  },
  {
    id: 'meta:builtin-cfd-pm',
    name: 'Builtin: CFD predicted move + SL/TP plan',
    script: `
# CFD PLAN. story.cfd() turns the cause->effect predicted move into a full trade plan: entry, stop (beyond the nearest support/resistance, else ATR), target (the next level, else a minimum reward:risk),
# plus the reward:risk and expected value in R. The CFD Trader sizes it (risk % or fixed margin) and places it with these exact levels.
# The 5m chart is blended in (story.cfd("15m") picks another). A judgement-weighted model, not a fitted one: backtest before trusting it.
let minConf = 45
let minRR = 1.5
let c = story.cfd("5m", minRR)
let ok = c.ok and c.strength >= minConf and c.rr >= minRR and c.ev > 0 and c.alignment != "conflict"
call when ok and c.direction == "call"
put when ok and c.direction == "put"
pos.stop = c.stop
pos.target = c.target
pos.breakeven = c.riskDist
`,
  },
  {
    id: 'meta:builtin-otc-pm',
    name: 'Builtin: OTC predicted move (no volume)',
    script: `
# OTC PREDICTED MOVE. OTC quotes are broker-generated, so there is no real volume. The cause is built from tick imbalance, tick path efficiency, run persistence, range expansion and the
# close location; volume, MFI and A/D are dropped. The validation bar is higher than the real-market version (40+ walk-forward calls, 55%+ hit). Whether an OTC feed has ANY
# exploitable structure is unproven: backtest per pair on your recorded ticks first.
let minConf = 50
let m = story.otcpm()
let ok = m.ok and m.validated and m.bucketN >= 20 and m.strength >= minConf and m.alignment != "conflict"
call when ok and m.direction == "call" and not m.atResistance
put when ok and m.direction == "put" and not m.atSupport
expiry = 1
`,
  },
  {
    id: 'meta:builtin-next-move',
    name: 'Builtin: next move (price map + path)',
    script: `
# NEXT MOVE. Price's own map (yesterday/today levels, gap, session, last session), causes (zones, regression, bull/bear structure) and what the closest historical fingerprints did next.
# Trades only when the walk-forward record beat chance (validated), the call agrees with the pm cause->effect read (or pm has no view), and the level above/below is not the likelier first target.
# A count of what followed similar-looking moments, not an understanding of why: backtest per pair first.
let minConf = 45
let n = story.nm(5)
let ok = n.ok and n.validated and n.strength >= minConf and n.pmAlignment != "conflict"
call when ok and n.direction == "call" and n.pUpFirst >= n.pDownFirst
put when ok and n.direction == "put" and n.pDownFirst >= n.pUpFirst
expiry = 1
`,
  },
  {
    id: 'meta:builtin-story-editor',
    name: 'Builtin: story editor (pm + nm + weather)',
    script: `
# THE EDITOR. One verdict from pm (who is pushing), nm (where price is and what followed from here) and the weather (trend/range/squeeze/dead). Trades only when the blend is strong, at least one
# model has a validated walk-forward record, and the market is not dead. The stop is the invalidation level (the price that would prove the call wrong). Agreement of models that read the same candles
# is weaker evidence than it looks: run /story_editor_report on the pair first to see whether agreement actually beat the better single model.
let minConf = 50
let e = story.editor("5m")
let ok = e.ok and e.tradeNow and e.strength >= minConf and e.tradeable
call when ok and e.direction == "call"
put when ok and e.direction == "put"
expiry = 1
`,
  },
]
