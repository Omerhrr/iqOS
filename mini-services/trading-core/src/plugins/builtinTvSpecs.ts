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
# minConf was 45: on noisy data 45+ almost never happens; 30+ with a validated walk-forward record is the working gate (n.blocksText says why it stayed quiet)
let minConf = 30
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
  {
    id: 'meta:builtin-dao-wuwei',
    name: 'Builtin: dao (wu wei - act only when the way is clear)',
    script: `
# DAO / WU WEI. Nine lenses read how price is behaving (yin/yang, cause and effect, life and death of the trend, time, space, momentum, fate, phase) and the wu wei lens decides whether to act at all:
# it WAITS in a squeeze, when chasing an extended move, when fighting a strong prevailing move, when momentum stalls or pm and nm disagree. Most bars say WAIT by design.
# Run /dao_research on the pair first (does inaction actually help on this pair?). Descriptions, not forecasts: backtest before trusting.
input useWindow = true "Trade only inside the time window"
input startHour = 13 min 0 max 24 "Window start (hour, 13.5 = 13:30, your clock)"
input endHour = 16 min 0 max 24 "Window end (hour, your clock)"
input utcOffset = 0 min -12 max 14 "Your clock vs UTC (hours, e.g. 1 for UTC+1)"
input minFavour = 55 min 0 max 100 "Minimum favour"

# time window: only trade between startHour and endHour on YOUR clock (utcOffset hours from UTC); runs on bar time in a backtest, wall clock live
let nowMin = (timing.hour() * 60 + timing.minute() + utcOffset * 60 + 2880) % 1440
let inSess = true
if useWindow
  if startHour <= endHour
    inSess = nowMin >= startHour * 60 and nowMin < endHour * 60
  else
    inSess = nowMin >= startHour * 60 or nowMin < endHour * 60
  end
end
let d = dao.all()
let ok = d.ok and d.act and d.favour >= minFavour and inSess
call when ok and d.dir == "call"
put when ok and d.dir == "put"
expiry = 1
`,
  },
  {
    id: 'meta:builtin-chess',
    name: 'Builtin: chess (look ahead, act only on a clear line)',
    script: `
# CHESS. Pieces, position, tactics (trap, mating net, fork, sacrifice) and a small look-ahead (which level first, take or hold). Acts only when the best line clears 0.15R and the verdict holds up.
# A "mate" is a favourable setup, never a guarantee. Run /chess_research first (does each tactic beat its baseline on this pair?). Backtest before trusting.
let minStrength = 50
let c = chess.all()
let ok = c.ok and c.act and c.strength >= minStrength
call when ok and c.dir == "call"
put when ok and c.dir == "put"
expiry = 1
`,
  },
  {
    id: 'meta:builtin-pm-ha',
    name: 'Builtin: pm filtered by Heikin Ashi',
    script: `
# PM + HEIKIN ASHI FILTER. Takes the pm call only when the Heikin Ashi candle agrees (colour, not a doji). Change the mode to "predict" (learned next-candle odds lean the same way) or "both".
# HA lags and reads the same candles as pm, so it is NOT assumed to help: run /ha_filter_report on the pair first to see whether pm's calls do better with HA agreement than without.
let mode = "color"
let p = story.pm()
let ok = p.ok and p.direction != "none"
call when ok and p.direction == "call" and story.haFilter("call", mode).pass
put when ok and p.direction == "put" and story.haFilter("put", mode).pass
expiry = 1
`,
  },
  {
    id: 'meta:builtin-trading-plan',
    name: 'Builtin: plan setup + pm + Heikin Ashi filter',
    script: `
# TRADING PLAN SETUP + pm + HEIKIN ASHI FILTER. The plan is not the strategy: trading.plan() only says WHERE the conditions are favourable (a trend that has not gone too far, price away from the avoid zones,
# a stop and a target from its own levels). The strategy is pm, filtered by the Heikin Ashi candle: pm must point the same way as the plan's side, and the HA filter must let that side through.
# Best used with Omni / Meta Trader in pool mode "setups": the plan scan hands this script only the pairs in a favourable setup, and after each trade it rescans for a different market.
# HA mode: "color" (HA agrees, not a doji), "predict" (learned next-candle odds lean the same way) or "both". Run /plan_research and /ha_filter_report on the pair first.
let mode = "color"
let tp = trading.plan()
let p = story.pm()
let ready = tp.ok and tp.ready and tp.rr >= 1.2 and p.ok
call when ready and tp.allowCall and p.direction == "call" and story.haFilter("call", mode).pass
put when ready and tp.allowPut and p.direction == "put" and story.haFilter("put", mode).pass
pos.stop = tp.stop
pos.target = tp.target
expiry = 1
`,
  },
  {
    id: 'meta:builtin-trading-plan-otc',
    name: 'Builtin: plan setup + OTC pm + Heikin Ashi filter',
    script: `
# TRADING PLAN SETUP + OTC pm + HEIKIN ASHI FILTER, for OTC pairs. Same split as the real-market version: the plan (trading.plan) only says WHERE conditions are favourable (fresh trend, away from avoid zones, stop/target from its levels);
# the Heikin Ashi candle filters; story.otcpm (tick imbalance, path efficiency, run persistence, no volume) is what trades. OTC quotes are broker-generated, so none of this is proven to carry an edge:
# run /plan_research, /ha_filter_report and the OTC pm backtest on your recorded ticks per pair first. Use with poolMode "setups" so the plan scan hands it only favourable OTC pairs.
let mode = "color"
let minConf = 50
let tp = trading.plan()
let m = story.otcpm()
let setup = tp.ok and tp.ready and tp.rr >= 1.2
let ok = setup and m.ok and m.validated and m.bucketN >= 20 and m.strength >= minConf and m.alignment != "conflict"
call when ok and tp.allowCall and m.direction == "call" and not m.atResistance and story.haFilter("call", mode).pass
put when ok and tp.allowPut and m.direction == "put" and not m.atSupport and story.haFilter("put", mode).pass
pos.stop = tp.stop
pos.target = tp.target
expiry = 1
`,
  },
  {
    id: 'meta:builtin-timing-sage',
    name: 'Builtin: timing sage (pm + dip entry)',
    script: `
# TIMING SAGE on pm. pm is the signal; the sage decides WHEN to enter. After the signal it watches the first move: a straight move our way is taken at once (the strong ones are never skipped);
# a shallow dip is bought only after price has turned back AND the re-check still holds (pm still the same way, no conflict, Heikin Ashi lets the side through); a deep dip (0.5 ATR) is a reversal and aborts.
# Every taken / skipped case is resolved 60 s later (skipped ones counterfactually), so timing.sageText("sage-call") shows how the dip entries and the skipped signals really did; with 15+ resolved dip entries under 50% the sage stops buying dips on this scope.
# LIVE / replay only (needs the path after the signal): run /msl_replay with compare:true to see the value of the wait. Meta Trader polls fast while the sage is watching.
let minConf = 45
let p = story.pm()
let base = p.ok and p.validated and p.bucketN >= 15 and p.strength >= minConf
let sigCall = base and p.direction == "call" and not p.atResistance
let sigPut = base and p.direction == "put" and not p.atSupport
let okCall = p.ok and p.direction == "call" and p.alignment != "conflict" and story.haFilter("call", "color").pass
let okPut = p.ok and p.direction == "put" and p.alignment != "conflict" and story.haFilter("put", "color").pass
let goCall = timing.sage("sage-call", sigCall, 1, 30, 0.15, 0.5, okCall)
let goPut = timing.sage("sage-put", sigPut, -1, 30, 0.15, 0.5, okPut)
call when goCall == 1
put when goPut == 1
expiry = 1
`,
  },
  {
    id: 'meta:builtin-sage-limit',
    name: 'Builtin: sage limit order (pm + smart level)',
    script: `
# SAGE LIMIT ORDER on pm. Options have no limit order, so the sage fakes one: pm gives the side, then the sage RESTS at a smart level on the trade's side of price (SMC order block / breaker / FVG, supply-demand zone,
# support-resistance band, fresh Malaysian SNR level) and enters when price gets there AND is refused (a wick into the zone that turns back out by 0.1 ATR). It gives up when the signal goes, the time runs out (120 s),
# price breaks through the zone, or price runs 0.8 ATR our way without touching it (not chased; that miss is measured).
# Every taken / cancelled case is resolved 60 s later per level kind, so timing.limitText("lim-call") shows which kinds of level really pay; a kind with 15+ resolved entries under 50% is dropped on this scope.
# Use timing.limit(name, cond, dir, seconds, "touch") to enter the instant the level is touched, or a number as the 5th argument to rest at your own price. LIVE / replay only.
let p = story.pm()
let sigCall = p.ok and p.direction == "call" and not p.atResistance
let sigPut = p.ok and p.direction == "put" and not p.atSupport
let goCall = timing.limit("lim-call", sigCall, 1, 120, "auto", "reject")
let goPut = timing.limit("lim-put", sigPut, -1, 120, "auto", "reject")
call when goCall == 1
put when goPut == 1
expiry = 1
`,
  },
  {
    id: 'meta:builtin-sp',
    name: 'Builtin: shock & pressure (sp, ongoing candle)',
    script: `
# SHOCK & PRESSURE of the candle that is STILL FORMING. Pressure = the body moving slowly (a steady drift); shock = the body moving suddenly (a fast, long burst). Each has its own direction.
# 1 pressure up + shock up -> LOWER | 2 pressure down + shock down -> HIGHER. A shock against the pressure, or no shock, is no call (steady pressure without a shock is SSP, below).
# (Both cases go AGAINST the pressure; the shock decides whether the setup exists.) It reads the path from live ticks / the 5s chart, so it is LIVE / replay only. It acts in the middle of the candle (progress 0.5-0.9):
# earlier there is too little path, later too little time. story.spText() is the sentence.
input winFrom = 0.5 min 0 max 1 "Window start (candle progress 0-1)"
input winTo = 0.9 min 0 max 1 "Window end (candle progress 0-1)"
input expiryMin = 1 min 1 max 15 "Expiry (minutes)"
let s = story.sp()
let inWindow = s.ok and s.progress >= winFrom and s.progress <= winTo

if inWindow and s.case == 1
  put when true
elseif inWindow and s.case == 2
  call when true
end
expiry = expiryMin
`,
  },
  {
    id: 'meta:builtin-ssp',
    name: 'Builtin: SSP (steady pressure, with the trend)',
    script: `
# SSP = the old case 5 of shock & pressure, standalone. The forming candle drifts one way steadily (pressure) with NO shock, and price trades WITH THE TREND (EMA20 vs EMA50): CALL in an uptrend, PUT in a downtrend.
# Reads the path from live ticks / the 5s chart (LIVE / replay only). Acts in the middle of the candle (progress 0.5-0.9). story.ssp("5m") takes the trend from the 5m chart; story.sspText() is the sentence.
# On BTCUSD 1m the late-candle read looked good mostly because little of the minute is left: replay it against a plain "price moved up so call" baseline before trusting it.
input winFrom = 0.5 min 0 max 1 "Window start (candle progress 0-1)"
input winTo = 0.9 min 0 max 1 "Window end (candle progress 0-1)"
input expiryMin = 1 min 1 max 15 "Expiry (minutes)"
let s = story.ssp()
let inWindow = s.ok and s.progress >= winFrom and s.progress <= winTo

if inWindow and s.direction == "call"
  call when true
elseif inWindow and s.direction == "put"
  put when true
end
expiry = expiryMin
`,
  },
  {
    id: 'meta:builtin-ssp-any',
    name: 'Builtin: SSP any (six setups, whichever fires)',
    script: `
# NOT PROVEN: on clean 1-second BTC data SSP won about 49%; the 60-70% replays on sparse IQ data were fade-the-drift artifacts. Replay / paper-trade it before real money.
# SSP ANY: six SSP setups side by side, any one that fires trades (steady pressure, NO shock, traded WITH the trend).
# 1 ATR | 2 efficiency ratio | 3 regression | 4 ROC | 5 ATR with a fast period (5) | 6 ATR, trend taken from the 5m chart.
# Votes = how many setups fire; if two setups disagree on the side (a 5m trend against the chart trend), we stand aside.
let a = story.ssp()
let e = story.ssp("pressure=er")
let g = story.ssp("pressure=reg")
let r = story.ssp("pressure=roc")
let f = story.ssp(0.12, 10, 5)
let t = story.ssp("5m")


input winFrom = 0.6 min 0 max 1 "Window start (candle progress 0-1)"
input winTo = 0.9 min 0 max 1 "Window end (candle progress 0-1)"
input expiryMin = 1 min 1 max 15 "Expiry (minutes)"
let late = a.progress >= winFrom and a.progress <= winTo
let callVotes = if(a.direction == "call", 1, 0) + if(e.direction == "call", 1, 0) + if(g.direction == "call", 1, 0) + if(r.direction == "call", 1, 0) + if(f.direction == "call", 1, 0) + if(t.direction == "call", 1, 0)
let putVotes = if(a.direction == "put", 1, 0) + if(e.direction == "put", 1, 0) + if(g.direction == "put", 1, 0) + if(r.direction == "put", 1, 0) + if(f.direction == "put", 1, 0) + if(t.direction == "put", 1, 0)

if late and callVotes > 0 and putVotes == 0
  call when true
  confidence = min(95, 50 + 8 * callVotes)
elseif late and putVotes > 0 and callVotes == 0
  put when true
  confidence = min(95, 50 + 8 * putVotes)
end
expiry = expiryMin
`,
  },
  {
    id: 'meta:builtin-sp-any',
    name: 'Builtin: SP any (five measures, whichever fires)',
    script: `
# NOT PROVEN: on clean 1-second BTC data sp won about 50-52%; the perfect-looking replays on sparse IQ data were fade-the-drift artifacts. Replay / paper-trade it before real money.
# SP ANY: five sp setups side by side, the first one that fires trades.
# 1 ATR | 2 ROC | 3 z-score shock | 4 efficiency-ratio pressure | 5 regression pressure.
# Each one is the plain sp rule (case 1 = pressure up + shock up -> PUT, case 2 = pressure down + shock down -> CALL),
# measured a different way. Votes = how many setups fire on that side; if one side says PUT and another says CALL, we stand aside.
let a = story.sp()
let r = story.sp("shock=roc", "pressure=roc")
let z = story.sp("shock=z", 2)
let e = story.sp("pressure=er")
let g = story.sp("pressure=reg")


input winFrom = 0.6 min 0 max 1 "Window start (candle progress 0-1)"
input winTo = 0.9 min 0 max 1 "Window end (candle progress 0-1)"
input expiryMin = 1 min 1 max 15 "Expiry (minutes)"
let late = a.progress >= winFrom and a.progress <= winTo
let putVotes = if(a.case == 1, 1, 0) + if(r.case == 1, 1, 0) + if(z.case == 1, 1, 0) + if(e.case == 1, 1, 0) + if(g.case == 1, 1, 0)
let callVotes = if(a.case == 2, 1, 0) + if(r.case == 2, 1, 0) + if(z.case == 2, 1, 0) + if(e.case == 2, 1, 0) + if(g.case == 2, 1, 0)

if late and putVotes > 0 and callVotes == 0
  put when true
  confidence = min(95, 55 + 10 * putVotes)
elseif late and callVotes > 0 and putVotes == 0
  call when true
  confidence = min(95, 55 + 10 * callVotes)
end
expiry = expiryMin
`,
  },
  {
    id: 'meta:builtin-sp-any-inputs',
    name: 'Builtin: SP any + inputs (every threshold editable)',
    script: `
# NOT PROVEN: on clean 1-second BTC data sp won about 50-52%. Replay / paper-trade before real money.
# SP ANY with inputs: five sp setups side by side, the first one that fires trades.
# 1 ATR | 2 ROC | 3 z-score shock | 4 efficiency-ratio pressure | 5 regression pressure.
# Each is the plain sp rule (case 1 = pressure up + shock up -> PUT,
# case 2 = pressure down + shock down -> CALL), measured a different way.
# If one setup says PUT and another says CALL, we stand aside.

# ---- inputs (edit per bot / engine, the script itself stays as is) ----
input winFrom = 0.6 min 0 max 1 "Window start (candle progress)"
input winTo = 0.9 min 0 max 1 "Window end (candle progress)"
input expiryMin = 1 min 1 max 15 "Expiry (minutes)"
input minVotes = 1 min 1 max 5 "Setups that must agree"
input useAtr = true "Use setup 1: ATR"
input useRoc = true "Use setup 2: ROC"
input useZ = true "Use setup 3: z-score shock"
input useEr = true "Use setup 4: efficiency-ratio pressure"
input useReg = true "Use setup 5: regression pressure"
input atrShock = 0.30 min 0.05 max 3 "ATR: shock threshold"
input atrPressure = 0.12 min 0.02 max 2 "ATR: pressure threshold"
input rocShock = 0.03 min 0.005 max 1 "ROC: shock threshold (% of open)"
input rocPressure = 0.02 min 0.005 max 1 "ROC: pressure threshold (% of open)"
input zShock = 2 min 0.5 max 10 "Z: shock threshold (sigmas)"
input erPressure = 0.5 min 0.1 max 1 "ER: pressure threshold"
input regPressure = 0.7 min 0.1 max 1 "Regression: pressure threshold (R2)"
input baseConf = 65 min 1 max 90 "Confidence with one setup firing"
input stepConf = 10 min 0 max 30 "Confidence added per extra agreeing setup"

let a = story.sp(atrShock, atrPressure)
let r = story.sp("shock=roc", "pressure=roc", rocShock, rocPressure)
let z = story.sp("shock=z", zShock)
let e = story.sp("pressure=er", erPressure)
let g = story.sp("pressure=reg", regPressure)

let late = a.progress >= winFrom and a.progress <= winTo
let putVotes = if(useAtr and a.case == 1, 1, 0) + if(useRoc and r.case == 1, 1, 0) + if(useZ and z.case == 1, 1, 0) + if(useEr and e.case == 1, 1, 0) + if(useReg and g.case == 1, 1, 0)
let callVotes = if(useAtr and a.case == 2, 1, 0) + if(useRoc and r.case == 2, 1, 0) + if(useZ and z.case == 2, 1, 0) + if(useEr and e.case == 2, 1, 0) + if(useReg and g.case == 2, 1, 0)

if late and putVotes >= minVotes and callVotes == 0
  put when true
  confidence = min(95, baseConf + stepConf * (putVotes - 1))
elseif late and callVotes >= minVotes and putVotes == 0
  call when true
  confidence = min(95, baseConf + stepConf * (callVotes - 1))
end
expiry = expiryMin
`,
  },
  {
    id: 'meta:builtin-pm-inputs',
    name: 'Builtin: PM + inputs (timeframe, probability, strength)',
    script: `
# PM with inputs: the higher-timeframe prediction (story.pm) traded when it is aligned with the last candle.
# Set pmTf to "15s" for the 15-second version or "1m" for the 1-minute one (or any of the others).
# NOT PROVEN: pm showed no edge on clean 1-minute data. Replay / paper-trade before real money.

input pmTf = "15s" options "5s", "15s", "30s", "1m", "5m" "Prediction timeframe"
input minProb = 0.55 min 0.5 max 0.95 "Minimum probability"
input minStrength = 0 min 0 max 100 "Minimum strength (0 = off)"
input needAligned = true "Require alignment (aligned only)"
input expiryMin = 1 min 1 max 15 "Expiry (minutes)"

let p = story.pm(pmTf)
let okAlign = p.alignment == "aligned" or not needAligned
let strong = p.prob >= minProb and p.strength >= minStrength

if p.direction == "call" and okAlign and strong
  call when true
  confidence = p.strength
elseif p.direction == "put" and okAlign and strong
  put when true
  confidence = p.strength
end
expiry = expiryMin
`,
  },
  {
    id: 'meta:builtin-anchor-confluence',
    name: 'Builtin: Anchor confluence (stretch + 5 anchor votes, for binary options)',
    script: `
# ANCHOR CONFLUENCE (binary options): fade a stretched move away from the anchor, but only when several independent anchor reads agree.
# The anchor is the close of the last completed period. Every read below is the anchor's own (candle-derived, no look-ahead):
#   stretch   the gap from the anchor is at least \`stretch\` ATR (anchor.z), up = put, down = call (mode "follow" flips it)
# Confirmations, each one vote for the fade direction:
#   1 exhaustion      a rejection wick at a stretched gap (anchor.exhaust)
#   2 Kagi mixed      yin while still ABOVE the anchor (-2: fading) / yang while still BELOW it (+2: recovering) (anchor.kagiState)
#   3 shock/pressure  the anchor's own SP signal: steady drift then a burst, gap already stretched (anchor.spSignal)
#   4 higher anchor   the higher anchor is stretched the same way (anchor.z(longPer)), so the move is extended on both scales
#   5 failed break    price broke this period's high / low and closed back inside (anchor.trap)
# It trades only with at least \`minVotes\` confirmations and when ADX says the market is NOT trending (fading a strong trend loses).
# Confidence = baseConf + step per vote. NOT PROVEN: first-guess thresholds, nothing here is fitted; backtest per pair and walk-forward before trusting it.

input per = "1h" options "15m", "30m", "1h", "4h", "1d" "Anchor period"
input longPer = "4h" options "1h", "4h", "1d", "1w" "Higher anchor (vote 4)"
input mode = "fade" options "fade", "follow" "Direction"
input stretch = 1.5 min 0.5 max 5 "Stretch (ATR)"
input minVotes = 2 min 1 max 5 "Confirmations needed"
input adxMax = 25 min 10 max 60 "Skip when ADX is above"
input baseConf = 58 min 1 max 90 "Base confidence"
input step = 5 min 0 max 15 "Confidence per vote"
input expiryMin = 3 min 1 max 15 "Expiry (minutes)"
input useWindow = true "Trade only inside the time window"
input startHour = 13 min 0 max 24 "Window start (hour, 13.5 = 13:30, your clock)"
input endHour = 16 min 0 max 24 "Window end (hour, your clock)"
input utcOffset = 0 min -12 max 14 "Your clock vs UTC (hours, e.g. 1 for UTC+1)"

# time window: only trade between startHour and endHour on YOUR clock (utcOffset hours from UTC); runs on bar time in a backtest, wall clock live
let nowMin = (timing.hour() * 60 + timing.minute() + utcOffset * 60 + 2880) % 1440
let inSess = true
if useWindow
  if startHour <= endHour
    inSess = nowMin >= startHour * 60 and nowMin < endHour * 60
  else
    inSess = nowMin >= startHour * 60 or nowMin < endHour * 60
  end
end

let z = anchor.z(per)
let d = 0
if z >= stretch
  d = -1
elseif z <= -stretch
  d = 1
end

let st = anchor.kagiState(per)
let zl = anchor.z(longPer)
let v1 = if(anchor.exhaust(per) == d, 1, 0)
let v2 = if((d == -1 and st == -2) or (d == 1 and st == 2), 1, 0)
let v3 = if(anchor.spSignal(per) == d, 1, 0)
let v4 = if(zl * z > 0 and abs(zl) >= 0.5, 1, 0)
let v5 = if(anchor.trap(per) == d, 1, 0)
let votes = v1 + v2 + v3 + v4 + v5
let calm = anchor.adx(per) < adxMax
let dir = d
if mode == "follow"
  dir = -d
end
let fire = d != 0 and votes >= minVotes and calm and inSess

if fire and dir > 0
  call when true
  confidence = min(95, baseConf + step * votes)
elseif fire and dir < 0
  put when true
  confidence = min(95, baseConf + step * votes)
end
expiry = expiryMin
`,
  },
  {
    id: 'meta:builtin-anchor-trend',
    name: 'Builtin: Anchor trend continuation (structure break + ADX, for binary options)',
    script: `
# ANCHOR TREND CONTINUATION (binary options): trade WITH a fresh break of structure measured on the anchor path.
# Trigger: a break of structure (bos) or a DI cross on the gap path (price minus the anchor), in the direction of the break.
# Filters, all on the same anchor: ADX at least adxMin (a real trend), +DI/-DI agree, the higher anchor sits on the same side,
# and the move is not already stretched past maxStretch ATR (do not chase the end of a run).
# It is the opposite idea to the Anchor confluence script, which fades stretches. Compare them on the same data.
# NOT PROVEN, AND THE FIRST TEST WAS BAD: on ~3 days of BTC 1-minute candles (3-minute expiry) it scored 29-46% on only 7-41 trades depending on the settings, i.e. no edge seen. Fixed first-guess thresholds. Backtest across pairs before trusting it.

input per = "1h" options "15m", "30m", "1h", "4h", "1d" "Anchor period"
input longPer = "4h" options "1h", "4h", "1d", "1w" "Higher anchor (same side)"
input trigger = "bos" options "bos", "diCross" "Trigger"
input adxMin = 22 min 10 max 60 "ADX at least"
input maxStretch = 2.5 min 0.5 max 6 "Skip when stretched beyond (ATR)"
input needHigher = true "Higher anchor must agree"
input baseConf = 60 min 1 max 90 "Base confidence"
input step = 4 min 0 max 15 "Confidence per ADX 10 over minimum"
input expiryMin = 3 min 1 max 15 "Expiry (minutes)"
input useWindow = true "Trade only inside the time window"
input startHour = 13 min 0 max 24 "Window start (hour, 13.5 = 13:30, your clock)"
input endHour = 16 min 0 max 24 "Window end (hour, your clock)"
input utcOffset = 0 min -12 max 14 "Your clock vs UTC (hours, e.g. 1 for UTC+1)"

# time window: only trade between startHour and endHour on YOUR clock (utcOffset hours from UTC); runs on bar time in a backtest, wall clock live
let nowMin = (timing.hour() * 60 + timing.minute() + utcOffset * 60 + 2880) % 1440
let inSess = true
if useWindow
  if startHour <= endHour
    inSess = nowMin >= startHour * 60 and nowMin < endHour * 60
  else
    inSess = nowMin >= startHour * 60 or nowMin < endHour * 60
  end
end

let ev = anchor.bos(per)
if trigger == "diCross"
  ev = anchor.diCross(per)
end
let z = anchor.z(per)
let zl = anchor.z(longPer)
let strong = anchor.adx(per) >= adxMin
let notChased = abs(z) <= maxStretch
let higherOk = (not needHigher) or ev * zl > 0
let okSide = ev * z >= 0
let fire = ev != 0 and strong and notChased and higherOk and okSide and inSess
let conf = min(95, baseConf + step * (anchor.adx(per) - adxMin) / 10)
if fire and ev > 0
  call when true
  confidence = conf
elseif fire and ev < 0
  put when true
  confidence = conf
end
expiry = expiryMin
`,
  },
  {
    id: 'meta:builtin-anchor-zone',
    name: 'Builtin: Anchor zone reaction (supply/demand touch + rejection candle, for binary options)',
    script: `
# ANCHOR ZONE REACTION (binary options): trade a bounce off the anchor's own demand / supply zone.
# Zones are built on the gap path (price minus the anchor). A call needs a touch of a demand zone (or a support level),
# a put needs a touch of a supply zone (or a resistance level), plus a rejection candle (pin / reject / hammer / engulf)
# pointing the same way, so the trade waits for price to show it is turning. First touch only: the zone was tested at most once, counting this touch (untested zones are stronger).
# zoneOnly = false also allows the plain support / resistance levels of the anchor path.
# NOT PROVEN: on ~3 days of BTC 1-minute candles (3-minute expiry) the defaults scored 62% on only 32 trades; loosening the filters gave 49-55% on 67-291 trades, so the rejection candle plus first-touch is where any lean came from, and 32 trades is within luck. Backtest across pairs before trusting it.

input per = "1h" options "15m", "30m", "1h", "4h", "1d" "Anchor period"
input zoneOnly = true "Supply / demand zones only"
input freshOnly = true "First touch only (zone tested at most once)"
input needCandle = true "Need a rejection candle"
input adxMax = 30 min 10 max 60 "Skip when ADX is above"
input baseConf = 60 min 1 max 90 "Base confidence"
input step = 5 min 0 max 15 "Confidence bonus on a first touch"
input expiryMin = 3 min 1 max 15 "Expiry (minutes)"
input useWindow = true "Trade only inside the time window"
input startHour = 13 min 0 max 24 "Window start (hour, 13.5 = 13:30, your clock)"
input endHour = 16 min 0 max 24 "Window end (hour, your clock)"
input utcOffset = 0 min -12 max 14 "Your clock vs UTC (hours, e.g. 1 for UTC+1)"

# time window: only trade between startHour and endHour on YOUR clock (utcOffset hours from UTC); runs on bar time in a backtest, wall clock live
let nowMin = (timing.hour() * 60 + timing.minute() + utcOffset * 60 + 2880) % 1440
let inSess = true
if useWindow
  if startHour <= endHour
    inSess = nowMin >= startHour * 60 and nowMin < endHour * 60
  else
    inSess = nowMin >= startHour * 60 or nowMin < endHour * 60
  end
end

let dTouch = anchor.tapDemand(per) or anchor.inDemand(per)
let sTouch = anchor.tapSupply(per) or anchor.inSupply(per)
let dFresh = anchor.demandTests(per) <= 1
let sFresh = anchor.supplyTests(per) <= 1
let candleUp = anchor.pin(per) > 0 or anchor.reject(per) > 0 or anchor.hammer(per) > 0 or anchor.engulf(per) > 0
let candleDn = anchor.pin(per) < 0 or anchor.reject(per) < 0 or anchor.hammer(per) < 0 or anchor.engulf(per) < 0
let calm = anchor.adx(per) < adxMax
let callOk = dTouch and ((not freshOnly) or dFresh) and ((not needCandle) or candleUp) and calm and inSess
let putOk = sTouch and ((not freshOnly) or sFresh) and ((not needCandle) or candleDn) and calm and inSess
if callOk and putOk
  callOk = false
  putOk = false
end
if callOk
  call when true
  confidence = min(95, baseConf + if(dFresh, step, 0))
elseif putOk
  put when true
  confidence = min(95, baseConf + if(sFresh, step, 0))
end
expiry = expiryMin
`,
  },
  {
    id: 'meta:builtin-anchor-kagi',
    name: 'Builtin: Anchor Kagi flip (yin/yang turn on the gap path, for binary options)',
    script: `
# ANCHOR KAGI FLIP (binary options): trade the moment the Kagi line on the gap path (price minus the anchor) flips.
# kagiFlip is +1 when the line turns up (yin to yang side) and -1 when it turns down. A flip that happens against the side of the
# anchor (price below the anchor, line turns up) is a snap-back toward the anchor; a flip with the side is a continuation.
# kind picks which flips to trade: "snapback", "continuation" or "any". The higher anchor can be required to sit on the trade's side.
# NOT PROVEN, AND THE FIRST TEST SHOWED NO EDGE: on ~3 days of BTC 1-minute candles (3-minute expiry) snapback scored 47% (19 trades), continuation 49% (47), any flip 48.5% (66). Fixed first-guess thresholds. Backtest across pairs before trusting it.

input per = "1h" options "15m", "30m", "1h", "4h", "1d" "Anchor period"
input longPer = "4h" options "1h", "4h", "1d", "1w" "Higher anchor"
input kind = "snapback" options "snapback", "continuation", "any" "Flips to trade"
input needHigher = false "Higher anchor must agree"
input minZ = 0.5 min 0 max 5 "Minimum distance from the anchor (ATR)"
input adxMax = 35 min 10 max 60 "Skip when ADX is above"
input baseConf = 58 min 1 max 90 "Base confidence"
input step = 5 min 0 max 15 "Bonus when the line is thick (yang)"
input expiryMin = 3 min 1 max 15 "Expiry (minutes)"
input useWindow = true "Trade only inside the time window"
input startHour = 13 min 0 max 24 "Window start (hour, 13.5 = 13:30, your clock)"
input endHour = 16 min 0 max 24 "Window end (hour, your clock)"
input utcOffset = 0 min -12 max 14 "Your clock vs UTC (hours, e.g. 1 for UTC+1)"

# time window: only trade between startHour and endHour on YOUR clock (utcOffset hours from UTC); runs on bar time in a backtest, wall clock live
let nowMin = (timing.hour() * 60 + timing.minute() + utcOffset * 60 + 2880) % 1440
let inSess = true
if useWindow
  if startHour <= endHour
    inSess = nowMin >= startHour * 60 and nowMin < endHour * 60
  else
    inSess = nowMin >= startHour * 60 or nowMin < endHour * 60
  end
end

let f = anchor.kagiFlip(per)
let z = anchor.z(per)
let zl = anchor.z(longPer)
let against = f * z < 0
let withSide = f * z > 0
let kindOk = kind == "any" or (kind == "snapback" and against) or (kind == "continuation" and withSide)
let far = abs(z) >= minZ
let higherOk = (not needHigher) or f * zl > 0
let calm = anchor.adx(per) < adxMax
let fire = f != 0 and kindOk and far and higherOk and calm and inSess
let thick = anchor.kagiThick(per) * f > 0
let conf = min(95, baseConf + if(thick, step, 0))
if fire and f > 0
  call when true
  confidence = conf
elseif fire and f < 0
  put when true
  confidence = conf
end
expiry = expiryMin
`,
  },
  {
    id: 'meta:builtin-anchor-psych',
    name: 'Builtin: Anchor psychology snap-back (climax + stop hunt toward the anchor, for binary options)',
    script: `
# ANCHOR PSYCHOLOGY SNAP-BACK (binary options): trade the reversal after a crowd move away from the anchor runs out of steam.
# Setups, all read on the gap path (price minus the anchor), each already signed as the expected reversal (+1 call, -1 put):
#   capitulation  selling climax (+1) or buying climax (-1)
#   stopHunt      a wick that took out a level and snapped back
#   fomo          the crowd chasing a run (only used when fomoToo is on, signed against the run)
# The reversal must point back toward the anchor (price below it and a call, or above it and a put), the gap must be at least
# minZ ATR, and ADX must be below adxMax (a strong trend does not snap back). Votes add confidence.
# NOT PROVEN: on ~3 days of BTC 1-minute candles (3-minute expiry) climax + stop hunt scored 61% on 18 trades; with FOMO added 49% on 45; looser filters 50-53% on 46-73. 18 trades is luck-sized, and FOMO is off by default only because it is the noisier vote. Backtest across pairs before trusting it.

input per = "1h" options "15m", "30m", "1h", "4h", "1d" "Anchor period"
input fomoToo = false "Count FOMO as a reversal vote"
input minZ = 1 min 0 max 5 "Minimum distance from the anchor (ATR)"
input adxMax = 30 min 10 max 60 "Skip when ADX is above"
input minVotes = 1 min 1 max 3 "Setups that must agree"
input baseConf = 58 min 1 max 90 "Base confidence"
input step = 5 min 0 max 15 "Confidence per vote"
input expiryMin = 3 min 1 max 15 "Expiry (minutes)"
input useWindow = true "Trade only inside the time window"
input startHour = 13 min 0 max 24 "Window start (hour, 13.5 = 13:30, your clock)"
input endHour = 16 min 0 max 24 "Window end (hour, your clock)"
input utcOffset = 0 min -12 max 14 "Your clock vs UTC (hours, e.g. 1 for UTC+1)"

# time window: only trade between startHour and endHour on YOUR clock (utcOffset hours from UTC); runs on bar time in a backtest, wall clock live
let nowMin = (timing.hour() * 60 + timing.minute() + utcOffset * 60 + 2880) % 1440
let inSess = true
if useWindow
  if startHour <= endHour
    inSess = nowMin >= startHour * 60 and nowMin < endHour * 60
  else
    inSess = nowMin >= startHour * 60 or nowMin < endHour * 60
  end
end

let z = anchor.z(per)
let cap = anchor.capitulation(per)
let hunt = anchor.stopHunt(per)
let fm = 0
if fomoToo
  fm = -anchor.fomo(per)
end
let up = if(cap > 0, 1, 0) + if(hunt > 0, 1, 0) + if(fm > 0, 1, 0)
let dn = if(cap < 0, 1, 0) + if(hunt < 0, 1, 0) + if(fm < 0, 1, 0)
let calm = anchor.adx(per) < adxMax
let callOk = up >= minVotes and dn == 0 and z <= -minZ and calm and inSess
let putOk = dn >= minVotes and up == 0 and z >= minZ and calm and inSess
if callOk
  call when true
  confidence = min(95, baseConf + step * up)
elseif putOk
  put when true
  confidence = min(95, baseConf + step * dn)
end
expiry = expiryMin
`,
  },
  {
    id: 'meta:builtin-anchor-vwap',
    name: 'Builtin: Anchor VWAP reversion (stretch from the period VWAP, for binary options)',
    script: `
# ANCHOR VWAP REVERSION (binary options): the anchor is the volume-weighted average price of the current period, not a close.
# Price is measured from that VWAP in ATR units. When price is stretched far from where the volume traded, it tends to be pulled back,
# so the script fades the stretch once the last candle shows it is turning (closes back against the stretch).
# spec picks the reference: "vwap" (anchored VWAP of the period), "open" (the period open) or "close" (the previous period close, the plain anchor).
# Note: on 24/7 markets (crypto) the period open is almost the previous close, so "1h:open" and "1h" behave the same.
# NOT PROVEN: on ~3 days of BTC 1-minute candles (3-minute expiry) 1h VWAP scored 54.7% on 150 trades, 4h VWAP 52.8% on 290, no turn filter 56.9% on 445 (breakeven at 85% payout is about 54%); a 15m VWAP run hit 71% on only 42 trades, which is luck-sized. Backtest across pairs before trusting it.

input spec = "1h:vwap" options "15m:vwap", "30m:vwap", "1h:vwap", "4h:vwap", "1d:vwap", "1h:open", "4h:open", "1h", "4h" "Reference (period:vwap, period:open, or plain period close)"
input stretch = 1.5 min 0.5 max 5 "Stretch (ATR)"
input needTurn = true "Last candle must turn back"
input adxMax = 30 min 10 max 60 "Skip when ADX is above"
input baseConf = 58 min 1 max 90 "Base confidence"
input step = 5 min 0 max 15 "Confidence per ATR beyond the stretch"
input expiryMin = 3 min 1 max 15 "Expiry (minutes)"
input useWindow = true "Trade only inside the time window"
input startHour = 13 min 0 max 24 "Window start (hour, 13.5 = 13:30, your clock)"
input endHour = 16 min 0 max 24 "Window end (hour, your clock)"
input utcOffset = 0 min -12 max 14 "Your clock vs UTC (hours, e.g. 1 for UTC+1)"

# time window: only trade between startHour and endHour on YOUR clock (utcOffset hours from UTC); runs on bar time in a backtest, wall clock live
let nowMin = (timing.hour() * 60 + timing.minute() + utcOffset * 60 + 2880) % 1440
let inSess = true
if useWindow
  if startHour <= endHour
    inSess = nowMin >= startHour * 60 and nowMin < endHour * 60
  else
    inSess = nowMin >= startHour * 60 or nowMin < endHour * 60
  end
end

let z = anchor.z(spec)
let zPrev = anchor.z(-2, spec)
let turnDown = z < zPrev
let turnUp = z > zPrev
let calm = anchor.adx(spec) < adxMax
let extra = max(0, abs(z) - stretch)
let conf = min(95, baseConf + step * extra)
let putOk = z >= stretch and ((not needTurn) or turnDown) and calm and inSess
let callOk = z <= -stretch and ((not needTurn) or turnUp) and calm and inSess
if callOk
  call when true
  confidence = conf
elseif putOk
  put when true
  confidence = conf
end
expiry = expiryMin
`,
  },
  {
    id: 'meta:builtin-anchor-regime',
    name: 'Builtin: Anchor regime switch (fade in chop, follow pullbacks in trend, for binary options)',
    script: `
# ANCHOR REGIME SWITCH (binary options): one script, two behaviours, chosen by what the anchor path is doing.
# Regime comes from the anchor's own ADX: below chopMax the path is ranging, so a stretch is faded back toward the anchor;
# above trendMin the path is trending, so a pullback that has just ended is followed (price on the trend side of the anchor,
# came back toward it, and the last candle turned with the trend). Between the two it stays out.
# Direction of the trend = side of the +DI / -DI, and price must sit on that side of the anchor.
# NOT PROVEN: on ~3 days of BTC 1-minute candles (3-minute expiry) the defaults scored 54.3% on 127 trades (breakeven at 85% payout is about 54%). Almost all trades come from the ranging fade (122 of 127, 54.9%); the trend-pullback half fired 5 times, 2 wins, so it is untested. Backtest across pairs before trusting it.

input per = "1h" options "15m", "30m", "1h", "4h", "1d" "Anchor period"
input chopMax = 20 min 5 max 40 "Ranging when ADX is below"
input trendMin = 28 min 15 max 60 "Trending when ADX is above"
input stretch = 1.5 min 0.5 max 5 "Fade stretch (ATR)"
input pullDepth = 0.5 min 0.1 max 3 "Pullback depth to buy / sell (ATR from the anchor, at most)"
input baseConf = 58 min 1 max 90 "Base confidence"
input step = 4 min 0 max 15 "Confidence per ADX 10 beyond the regime line"
input expiryMin = 3 min 1 max 15 "Expiry (minutes)"
input useWindow = true "Trade only inside the time window"
input startHour = 13 min 0 max 24 "Window start (hour, 13.5 = 13:30, your clock)"
input endHour = 16 min 0 max 24 "Window end (hour, your clock)"
input utcOffset = 0 min -12 max 14 "Your clock vs UTC (hours, e.g. 1 for UTC+1)"

# time window: only trade between startHour and endHour on YOUR clock (utcOffset hours from UTC); runs on bar time in a backtest, wall clock live
let nowMin = (timing.hour() * 60 + timing.minute() + utcOffset * 60 + 2880) % 1440
let inSess = true
if useWindow
  if startHour <= endHour
    inSess = nowMin >= startHour * 60 and nowMin < endHour * 60
  else
    inSess = nowMin >= startHour * 60 or nowMin < endHour * 60
  end
end

let z = anchor.z(per)
let zPrev = anchor.z(-2, per)
let adx = anchor.adx(per)
let up = anchor.plusDI(per) > anchor.minusDI(per)
let dn = anchor.minusDI(per) > anchor.plusDI(per)
let side = 0
let bonus = 0
if adx < chopMax
  if z >= stretch and z < zPrev
    side = -1
  elseif z <= -stretch and z > zPrev
    side = 1
  end
  bonus = (chopMax - adx) / 10
elseif adx > trendMin
  if up and z > 0 and z <= pullDepth and z > zPrev
    side = 1
  elseif dn and z < 0 and z >= -pullDepth and z < zPrev
    side = -1
  end
  bonus = (adx - trendMin) / 10
end
let conf = min(95, baseConf + step * bonus)
if inSess and side > 0
  call when true
  confidence = conf
elseif inSess and side < 0
  put when true
  confidence = conf
end
expiry = expiryMin
`,
  },
  {
    id: 'meta:builtin-anchor-fade',
    name: 'Builtin: Anchor fade (gap from the 1h/4h/1d close, with inputs)',
    script: `
# ANCHOR FADE: trade against a stretched move away from an anchor (the close of the last completed 1h / 4h / 1d period).
# Each candle is measured from the anchor in ATR units (anchor.z). Three setups, pick one with \`setup\`:
#   "cross"  price just crossed the anchor from at least \`stretch\` ATR away  (the best-looking setup in the first BTC test)
#   "accel"  the gap is growing fast: rocAtr over the ROC lookback >= stretch, on the same side of the anchor
#   "gap"    plain stretch: the gap is at least \`stretch\` ATR from the anchor
# mode "fade" goes against the gap's side, "follow" goes with it (to compare; fading was the one that scored above 50%).
# NOT PROVEN: the evidence is ~3 days of BTC 1-minute candles, many variants tried, ~55-62% on 3-5 bar holds. Backtest across assets first.

input per = "1h" options "15m", "30m", "1h", "4h", "1d", "1w" "Anchor period"
input setup = "cross" options "cross", "accel", "gap" "Setup"
input mode = "fade" options "fade", "follow" "Direction"
input stretch = 1 min 0.1 max 10 "Stretch (ATR)"
input lookback = 15 min 2 max 100 "Lookback (bars)"
input expiryMin = 3 min 1 max 15 "Expiry (minutes)"
input baseConf = 60 min 1 max 95 "Confidence"
input useWindow = true "Trade only inside the time window"
input startHour = 13 min 0 max 24 "Window start (hour, 13.5 = 13:30, your clock)"
input endHour = 16 min 0 max 24 "Window end (hour, your clock)"
input utcOffset = 0 min -12 max 14 "Your clock vs UTC (hours, e.g. 1 for UTC+1)"

# time window: only trade between startHour and endHour on YOUR clock (utcOffset hours from UTC); runs on bar time in a backtest, wall clock live
let nowMin = (timing.hour() * 60 + timing.minute() + utcOffset * 60 + 2880) % 1440
let inSess = true
if useWindow
  if startHour <= endHour
    inSess = nowMin >= startHour * 60 and nowMin < endHour * 60
  else
    inSess = nowMin >= startHour * 60 or nowMin < endHour * 60
  end
end

configure anchor.rocPeriod = lookback

let z = anchor.z(per)
let zPrev = anchor.z(-1 - lookback, per)
let ra = anchor.rocAtr(per)
let side = 0
if setup == "cross" and zPrev * z < 0 and abs(zPrev) >= stretch
  side = z
elseif setup == "accel" and ra * z > 0 and abs(ra) >= stretch
  side = z
elseif setup == "gap" and abs(z) >= stretch
  side = z
end
let up = side > 0
let down = side < 0
if mode == "fade"
  put when up and inSess
  call when down and inSess
else
  call when up and inSess
  put when down and inSess
end
confidence = baseConf
expiry = expiryMin
`,
  },
  {
    id: 'meta:builtin-anchor-dwell',
    name: 'Builtin: Anchor dwell (trade the band whose own history leans)',
    script: `
# ANCHOR DWELL: trade the band price is in only when ITS OWN HISTORY leans one way.
# Price is measured from the anchor (close of the last completed 1h / 4h / 1d period) in ATR units and cut into bands (0.25 ATR wide by default).
# For the band the close is in now, look at every earlier visit whose outcome has already closed (never the forming candle): after \`h\` bars, what share went up?
# It only trades when there are at least \`minVisits\` such visits (anchor.ready needs 20) and the up share is >= \`lean\` (call) or <= 1 - lean (put).
# \`needAlike\` also requires visits that ARRIVED the same way (rising / falling) to lean the same way.
# NOT PROVEN: this reads statistics of the chart's own recent past; a lean can be luck. Backtest per pair (walk-forward) before trusting it.

input per = "4h" options "15m", "30m", "1h", "4h", "1d", "1w" "Anchor period"
input hz = "3" options "1", "3", "5" "Look-ahead (bars)"
input lean = 0.58 min 0.5 max 0.95 "Lean (share of visits)"
input minVisits = 20 min 20 max 500 "Minimum visits"
input needAlike = false "Same-arrival visits must agree"
input expiryMin = 3 min 1 max 15 "Expiry (minutes)"
input useWindow = true "Trade only inside the time window"
input startHour = 13 min 0 max 24 "Window start (hour, 13.5 = 13:30, your clock)"
input endHour = 16 min 0 max 24 "Window end (hour, your clock)"
input utcOffset = 0 min -12 max 14 "Your clock vs UTC (hours, e.g. 1 for UTC+1)"

# time window: only trade between startHour and endHour on YOUR clock (utcOffset hours from UTC); runs on bar time in a backtest, wall clock live
let nowMin = (timing.hour() * 60 + timing.minute() + utcOffset * 60 + 2880) % 1440
let inSess = true
if useWindow
  if startHour <= endHour
    inSess = nowMin >= startHour * 60 and nowMin < endHour * 60
  else
    inSess = nowMin >= startHour * 60 or nowMin < endHour * 60
  end
end

configure anchor.bandWidth = 0.25
configure anchor.window = 300

let ok = false
let u = 0.5
let n = 0
let ua = 0.5
let ra = false
if hz == "1"
  ok = anchor.ready(1, per)
  u = anchor.nextUp(1, per)
  n = anchor.visits(1, per)
  ra = anchor.alikeReady(1, per)
  ua = anchor.alikeUp(1, per)
elseif hz == "3"
  ok = anchor.ready(3, per)
  u = anchor.nextUp(3, per)
  n = anchor.visits(3, per)
  ra = anchor.alikeReady(3, per)
  ua = anchor.alikeUp(3, per)
else
  ok = anchor.ready(5, per)
  u = anchor.nextUp(5, per)
  n = anchor.visits(5, per)
  ra = anchor.alikeReady(5, per)
  ua = anchor.alikeUp(5, per)
end
let okAlike = not needAlike or ra
let go = ok and n >= minVisits and okAlike and inSess
let callAlike = not needAlike or ua >= lean
let putAlike = not needAlike or ua <= 1 - lean
call when go and u >= lean and callAlike
put when go and u <= 1 - lean and putAlike
confidence = round(abs(u - 0.5) * 200)
expiry = expiryMin
`,
  },
  {
    id: 'meta:builtin-adx-rsi',
    name: 'Builtin: ADX + RSI (trend pullback / extreme reversal, with inputs)',
    script: `
# ADX + RSI: ADX says HOW STRONG the trend is, RSI says how fast / stretched price has moved. Together they pick one of two plays:
#   TREND PULLBACK  (ADX >= adxStrong): the trend is strong, so wait for RSI to dip (uptrend) or pop (downtrend) and turn back WITH the trend.
#   EXTREME REVERSAL (ADX <= adxWeak, or a strong trend that is fading): no trend to fight, so fade RSI overbought / oversold once RSI turns.
# +DI / -DI give the trend direction. mode picks which play(s) run: "both", "trend" or "reversal".
# NOT PROVEN: indicator readings are functions of the same candles; nothing here was shown to beat break-even. Backtest per pair / timeframe before trusting it.

input mode = "both" options "both", "trend", "reversal" "Play"
input adxLen = 14 min 5 max 50 "ADX period"
input rsiLen = 14 min 3 max 50 "RSI period"
input adxStrong = 25 min 10 max 60 "ADX: strong trend from"
input adxWeak = 20 min 5 max 40 "ADX: weak / ranging up to"
input pullbackLevel = 40 min 20 max 50 "Trend pullback: RSI dips below this (uptrend); mirrored for downtrend"
input overbought = 70 min 55 max 95 "RSI overbought"
input oversold = 30 min 5 max 45 "RSI oversold"
input fadeFading = true "Also fade extremes when a strong trend is fading (ADX falling)"
input expiryMin = 3 min 1 max 15 "Expiry (minutes)"
input baseConf = 60 min 1 max 95 "Confidence"

let a = ind.adx(adxLen)
let adx = a.adx[-1]
let up = a.plusDI[-1] > a.minusDI[-1]
let rsi = ind.rsi(rsiLen)[-1]
let rsiPrev = ind.rsi(rsiLen)[-2]
let adxPrev = a.adx[-2]
let turningUp = rsi > rsiPrev
let turningDown = rsi < rsiPrev
let strong = adx >= adxStrong
let weak = adx <= adxWeak
let fading = strong and adx < adxPrev

let doTrend = mode == "both" or mode == "trend"
let doRev = mode == "both" or mode == "reversal"

let tCall = doTrend and strong and up and rsiPrev < pullbackLevel and turningUp
let tPut = doTrend and strong and not up and rsiPrev > 100 - pullbackLevel and turningDown
let revOk = weak or (fadeFading and fading)
let rCall = doRev and revOk and rsiPrev <= oversold and turningUp
let rPut = doRev and revOk and rsiPrev >= overbought and turningDown

call when tCall or rCall
put when tPut or rPut
confidence = min(95, baseConf + abs(adx - adxWeak) / 2)
expiry = expiryMin
`,
  },
  {
    id: 'meta:builtin-weiswave',
    name: 'Builtin: Weis wave (effort vs result)',
    script: `
# WEIS WAVE. Volume summed per price wave. A new high on LESS volume than the last up-wave (or big effort for little move, or shortening waves) = the wave is spent -> go the other way;
# a new extreme on MORE volume = fuel -> go with it. mode: "atr" cuts waves on an ATR reversal, "close" on close-to-close direction (change the word to compare).
# On feeds without real volume (many OTC) true range stands in (ww.volumeOk() is false). Describes disagreement only - backtest per pair before trusting it.
let ok = ww.ok("atr")
let d = ww.dir("atr")
let st = ww.strength("atr")
call when ok and d == "call" and st >= 40
put when ok and d == "put" and st >= 40
confidence = st
expiry = 3
`,
  },
  {
    id: 'meta:builtin-pm-weiswave',
    name: 'Builtin: pm + Weis wave',
    script: `
# PM + WEIS WAVE. pm says WHO is pushing (pure pm, ok is enough). The Weis wave says whether the volume behind the running wave backs that move or shows it is spent.
#   backed  = the Weis wave points the same way as pm (a new extreme on more volume, or a spent wave on the other side): take it.
#   spent   = the Weis wave points the OTHER way (pm calls up into a weak / absorbed / shortening up-wave, or the mirror): stand down.
#   silent  = the wave has no effort-vs-result signal: take pm on its own (set needBacking = 1 to insist on backing).
# ww.dir("atr") cuts waves on an ATR reversal; use "close" for close-to-close waves, ww.dir("atr", 1.5) for fewer longer waves, ww.dir("atr", 1, "5m") to read the wave on 5m.
# On pairs with no real volume (many OTC) true range stands in - check ww.volumeOk(). Describes where effort and result disagree, not a win probability: backtest it on your pair first.
let needBacking = 0
let minWave = 30
let m = story.pm()
let wOk = ww.ok("atr")
let pmCall = m.ok and m.direction != "none"
let backed = pmCall and wOk and ww.dir("atr") == m.direction and ww.strength("atr") >= minWave
let spent = pmCall and wOk and ww.dir("atr") != "none" and ww.dir("atr") != m.direction and ww.strength("atr") >= minWave
let take = pmCall and not spent and (needBacking == 0 or backed)
call when take and m.direction == "call"
put when take and m.direction == "put"
expiry = 3
`,
  },
  {
    id: 'meta:builtin-pmm',
    name: 'Builtin: pmm (pm + market structure)',
    script: `
# PMM. pm's predicted move, gated by MARKET STRUCTURE: swing highs/lows labelled HH/HL/LH/LL, the structure they spell, BOS / CHoCH, and the swing standing in the call's way.
# It will not call into a swing high (put into a swing low), will not fight a standing downtrend (uptrend) unless pm is strong enough or the structure just broke the other way, and will not buy the top / sell the bottom of the swing range.
# m.blocksText says why a pm call was held back, m.boostsText what supported it. Weights are judgement: run /pmm_report on the pair first (does the gate separate pm's good calls from its bad ones?).
let minConf = 45
let m = story.pmm()
let ok = m.ok and m.validated and m.strength >= minConf and m.alignment != "conflict"
call when ok and m.direction == "call"
put when ok and m.direction == "put"
expiry = 1
`,
  },
]
