# IQAIR//OS — Trading Operating System

A trading OS built around the [iqair](https://github.com/Omerhrr/iqair) IQ Option library, with a kernel architecture repurposed from [deepseek-harness](https://github.com/deepseek-ai/deepseek-harness): everything is a plugin, plugins talk over an event bus, and an LLM copilot drives the whole system through a tool-calling harness.

```
┌────────────────────────────  IQAIR//OS  ────────────────────────────┐
│                                                                     │
│  Next.js 16 OS shell ── REST + socket.io ──►  trading-core kernel   │
│  (chart, panels, copilot UI)                  (port 3030, bun)      │
│                                                    │                │
│                     ┌──────────────────────────────┼─────────┐      │
│                     │  market-data  │  analytics   │ execution│      │
│                     │  SIM engine   │  TA + quant  │ broker + │      │
│                     │  or LIVE ─────┼─► Markov …   │ risk mgr │      │
│                     └───────────────┼──────────────┼─────────┘      │
│                                     │              │                │
│                      iqair sidecar (Python)   SQLite (os.db)         │
│                      ► your iqair library ►  IQ Option              │
└─────────────────────────────────────────────────────────────────────┘
```

## Features

**Market data**
- SIM engine: regime-switching geometric brownian motion, 10 assets (forex / crypto / commodities / stocks / index), 5 timeframes (`5s` → `15m`), 1-second ticks, seeded 760-candle history per timeframe
- LIVE mode: polls the iqair sidecar for real IQ Option candles/prices and merges them into the same series — the rest of the OS never knows the difference

**Analytics (all implemented from scratch, no TA lib dependency)**
- 25+ indicators: SMA, EMA, WMA, RSI, MACD, Stochastic, Bollinger, Keltner, Donchian, ATR, ADX/±DI, CCI, Williams %R, MFI, OBV, VWAP, ROC, Supertrend, Ichimoku, Parabolic SAR, pivot points, Fibonacci, linear regression
- 17 candlestick pattern detectors (engulfing, stars, soldiers/crows, marubozu, tweezers, …) with reliability scoring
- Quantitative models: first-order **Markov chain** (vol-scaled states, Laplace-smoothed transition matrix, stationary distribution, next-move forecast, entropy, regime classification), **Monte Carlo** (GBM + bootstrap, VaR95/CVaR95, percentile fans), **Hurst exponent** (rescaled range), autocorrelation with significance, EWMA + **GARCH(1,1)** volatility (grid-fit), regression channels, S/R zone clustering
- 13-factor weighted composite confluence signal (trend + momentum + mean-reversion + statistical + patterns)

**Strategy engine**
- 10 built-in strategies incl. `markov-edge` (trades the fitted transition matrix) and `confluence-core` (the composite signal itself)
- Backtester: binary (payout-based) and spot (TP/SL) settlement models — win rate, profit factor, max drawdown, Sharpe, expectancy, equity curve

**Execution & risk**
- Paper broker: binary options (expiry in bars) and spot (TP/SL), settled automatically on candle closes
- Risk manager: kill switch, daily loss limit, max stake, max concurrent positions, loss-streak cooldown
- LIVE adapter: forwards orders to the iqair sidecar (turbo/binary/forex/crypto/CFD)

**AI copilot (harness)**
- LLM agent with a 13-tool JSON action loop: full analysis, Markov matrix, Monte Carlo, backtests, strategy evaluation, paper trades, position management — every call traced in the UI

## Repo layout

```
src/                        Next.js 16 OS shell (UI + agent API route)
  app/page.tsx              the OS desktop
  app/api/agent/route.ts    LLM tool-calling harness
  components/os/            chart, panels, blotter, copilot
  lib/os/client.ts          REST + socket client
mini-services/trading-core/ the kernel (bun)
  src/kernel.ts             event bus + plugin lifecycle
  src/plugins/              market-data / analytics / execution / store
  src/analytics/            indicators / patterns / quant / engine
  src/strategies/           builtin strategies + backtester
live/iqair_sidecar.py       Python bridge to your iqair library
```

## Quickstart

Requires [bun](https://bun.sh) and Python 3 (for live trading only).

```bash
# 1. OS shell (Next.js)
bun install
bun run dev                 # http://localhost:3000

# 2. Kernel (separate terminal)
cd mini-services/trading-core
bun install
bun index.ts                # http://localhost:3030

# 3. (optional) LIVE trading via your iqair library
pip install -e /path/to/iqair
python live/iqair_sidecar.py   # listens on 127.0.0.1:8788
```

Then in the OS: **⚙ Settings → LIVE broker** → sidecar URL + your IQ Option credentials → **Connect LIVE**.

> In production/sandbox deployments where the browser talks to the services through a gateway, requests carry `?XTransformPort=3030`; the included `Caddyfile` implements that routing. Running locally on one machine you can also hit `:3030` directly.

## Safety

- The paper account ($10,000) is the default and everything works without credentials.
- The sidecar connects to **PRACTICE** by default; REAL requires an explicit toggle and prints a warning.
- This is an unofficial community tool, not affiliated with or endorsed by IQ Option. IQ Option's API is undocumented and can change without notice. Trading involves substantial risk — trade responsibly.
