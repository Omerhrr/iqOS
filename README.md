# IQAIR//OS — Trading Operating System

A trading OS built around the [iqair](https://github.com/Omerhrr/iqair) IQ Option library, with a kernel architecture repurposed from [deepseek-harness](https://github.com/deepseek-ai/deepseek-harness): everything is a plugin, plugins talk over an event bus, and an LLM copilot drives the whole system through a tool-calling harness.

```
┌────────────────────────────  IQAIR//OS  ────────────────────────────┐
│                                                                     │
│  Next.js 16 OS shell ── REST + socket.io ──►  trading-core kernel   │
│  (chart, panels, copilot UI)                  (bun, KERNEL_URL)     │
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

Three independent services: the Next.js **web** shell, the bun **kernel**
(`trading-core`), and the optional Python **sidecar** (`live/`) used only
when LIVE (real IQ Option) mode is turned on. They talk to each other over
HTTP/REST + socket.io using a configurable `KERNEL_URL`/sidecar URL rather
than anything hardcoded, so the same code runs unmodified on a single
Windows/WSL dev machine or as three separate Docker containers.

## Features

**Market data**
- SIM engine: regime-switching geometric brownian motion, **115 instruments** — 35 forex pairs + 10 OTC (24/7) + 18 crypto + 8 commodities + 32 stocks + 12 indices — with 1-second ticks and lazy-seeded 760-candle history per timeframe
- **11 timeframes**: `5s` `15s` `30s` `1m` `2m` `5m` `15m` `30m` `1h` `4h` `1d`
- LIVE mode: polls the iqair sidecar for real IQ Option candles/prices (all instrument ids mapped: `OIL_BRENT`, `NSDQ100`, `EURUSD_otc`, …) and merges them into the same series — the rest of the OS never knows the difference

**Analytics (all implemented from scratch, no TA lib dependency)**
- **101-indicator registry** with params, panes and per-category browsing: 27 overlap (incl. KAMA/HMA/T3/ZLEMA/McGinley/MA-ribbon/Alligator + EMA/SMA presets), 24 momentum (RSI/MACD/StochRSI/TSI/UO/KST/RVI/Fisher/Schaff TC/…), 13 volume (OBV/MFI/CMF/Klinger/EOM/…), 13 volatility (ATR/Bollinger/Keltner/Donchian/Ulcer/Chandelier/…), 16 trend (ADX/Aroon/Supertrend/PSAR/Ichimoku/Vortex/ZigZag/Gann HiLo/…), cycle + statistic (Hilbert sine, z-score, variance, linreg slope)
- **35 candlestick pattern detectors** (engulfing, harami family, inside/outside, doji stars, 3 soldiers/crows, 3 methods, kicker, abandoned baby, …) with reliability scoring
- **Chart pattern engine**: pivot-based double top/bottom, head & shoulders, triangles, wedges, flags, ranges
- Quantitative models: first-order **Markov chain** (vol-scaled states, Laplace-smoothed transition matrix, stationary distribution, next-move forecast, entropy, regime classification), **Monte Carlo** (GBM + bootstrap, VaR95/CVaR95, percentile fans), **Hurst exponent** (rescaled range), autocorrelation with significance, EWMA + **GARCH(1,1)** volatility (grid-fit), regression channels, S/R zone clustering
- 13-factor weighted composite confluence signal (trend + momentum + mean-reversion + statistical + patterns)

**Strategy engine**
- 10 built-in strategies incl. `markov-edge` (trades the fitted transition matrix) and `confluence-core` (the composite signal itself)
- Backtester: binary (payout-based) and spot (TP/SL) settlement models — win rate, profit factor, max drawdown, Sharpe, expectancy, equity curve

**Research lab (Backtest Lab → Optimizer / Walk-Forward / Asset Sweep)**
- **Grid optimizer**: sweep any strategy params (from/to/step per param, cartesian or sampled to a combo cap), rank by objective (net P&L, Sharpe, profit factor, win rate, expectancy) with a min-trades guard, a **robustness heatmap** over the two dominant swept params, and the top-3 finalists **re-verified through the full settlement engine** so their numbers match the single-run lab exactly
- **Walk-forward validation**: splits history into folds, optimizes params in-sample per fold, then settles the fold winner **out-of-sample with the real binary engine** — OOS net, consistency (profitable folds), IS→OOS efficiency; the honest overfit check before deploying a bot
- **Asset sweep**: run one strategy/param set across the instrument universe (per category, open-only, capped) and rank where the edge actually holds; click a row to load the asset in the chart
- **Promote-to-bot**: any optimizer row or walk-forward robust config converts into an autopilot bot in one click (created **disarmed**, with the researched params, stake and expiry pre-filled)
- Copilot gained the same workflow as tools (`optimize_strategy`, `walkforward`, `asset_sweep`) and is instructed to sweep → optimize → walk-forward → promote before deploying bots

**Discovery layer (screener + alert rules)**
- **Universe screener**: a background scanner walks every open instrument × configured timeframes (1m/5m/15m by default) with a lightweight snapshot of the composite engine — ranked opportunity feed with signal score, confidence, Markov regime, RSI/ADX/ATR, Hurst, P(up), top candlestick pattern and payout. Rows auto-refresh on candle close (stale invalidation over the event bus), filter by timeframe/category/direction/min-score/symbol, click a row to load the setup into the chart workspace, or hit the bell to convert it into a standing alert
- **Alert rules**: programmable market watchers persisted in SQLite — price cross (tick-accurate), composite score strength (call/put/either), RSI extremes, ADX trend ignition, ATR% volatility bursts, Markov regime shifts and bullish/bearish candle patterns; per-rule cooldown, one-shot auto-disarm, fire counters, armed/paused state — all surfaced as OS alerts (toast + feed)
- **Kernel keeper**: in local/dev use, the Next.js server self-heals the trading-core kernel (`/api/kernel` spawns it detached when it's dark and re-checks on every boot/reconnect). Set `KERNEL_MANAGED=false` (the Docker deployment does this) to disable the spawn and just report status — Docker's own restart policy/healthcheck owns recovery there instead.

**Execution & risk**
- Paper broker with **4 trade kinds** on every instrument: **binary** (expiry in bars), **turbo** (short expiry, min 30s), **digital** (strike from spot ± offset, 5m/15m/30m expiries, ITM/OTM settlement), **CFD** (margin × leverage notional, TP/SL, 100%-margin stop-out)
- Risk manager: kill switch, daily loss limit, max stake, max concurrent positions, loss-streak cooldown
- **Adaptive confidence gate**: an optional per-bot meta-strategy layer that gates live/paper execution on the strategy's OWN realized historical record for the exact (asset, timeframe, strategy, side, score-bucket, regime) combination — using the Wilson score lower bound rather than the raw win-rate ratio, so a short lucky streak isn't mistaken for an edge. It only lets a bot fire when its actual track record in that specific bucket clears a configurable confidence threshold; toggled per bot in the Autopilot panel.
- LIVE adapter: forwards orders to the iqair sidecar — binary/turbo/digital options plus forex/crypto/stock/index/commodity CFDs

**Chart workspace**
- **8 chart types**: candles, hollow candles, Heikin Ashi, bars, line, area, baseline, Renko
- Built-in overlays (EMA 20/50/200, Bollinger, Supertrend, VWAP) + any registry indicator as an on-chart overlay or a stacked oscillator sub-pane, added via the indicator library dialog (search, category tabs, param editing)

**AI copilot (harness)**
- LLM agent with a 68-tool JSON action loop covering essentially the whole OS: market analysis, any-registry indicator series, chart/candle patterns, key levels, confluence reads, Markov/Monte Carlo/VSK/TSK models, correlate, session clock, regime playbook, strategy backtests/optimizer/walk-forward/tournament, asset sweep, calibration report, trade plans, paper trades (all 4 kinds), position/account management, autopilot fleet control (bot create/toggle/restart/delete, compound plan, autotrader config), strategy lab (learn/backtest/save/list/delete), journal stats, screener queries, alert-rule management, sentinel + watchdog safety controls (incl. panic-close-all), OS mode, memory gate (save/recall/forget), web search, and direct UI control — every call traced in the UI

## Repo layout

```
src/                        Next.js 16 OS shell (UI + agent API route)
  app/page.tsx              the OS desktop
  app/api/agent/route.ts    LLM tool-calling harness (talks to KERNEL_URL)
  app/api/kernel/route.ts   kernel keeper (auto-spawn trading-core, unless KERNEL_MANAGED=false)
  components/os/            chart, panels, blotter, copilot, autopilot (incl. adaptive gate toggle)
  lib/os/client.ts          REST + socket client
mini-services/trading-core/ the kernel (bun)
  Dockerfile                 kernel container image
  src/kernel.ts             event bus + plugin lifecycle
  src/plugins/              market-data / analytics / execution / store / autopilot / adaptive / screener / alert-rules
  src/universe.ts           full IQ Option instrument catalog (115)
  src/analytics/            indicators / registry / patterns / chart-patterns / quant / engine
  src/strategies/           builtin strategies + backtester
live/                       Python bridge to your iqair library
  iqair_sidecar.py          LIVE trading sidecar (SIDECAR_HOST/SIDECAR_PORT env vars)
  Dockerfile                 sidecar container image
scripts/*-supervisor.sh     self-healing daemons for core + dev server (local/dev use)
Dockerfile                  web app container image
docker-compose.yml          all three services wired together for VPS deployment
deploy/                     Caddy reverse-proxy snippet + full deployment README
```

## Quickstart (local dev)

Requires [bun](https://bun.sh) and Python 3 (for live trading only).

```bash
# 1. OS shell (Next.js)
bun install
bun run dev                 # http://localhost:3000 (webpack dev bundler - see next.config.ts)

# 2. Kernel (separate terminal)
cd mini-services/trading-core
bun install
bun index.ts                # http://localhost:3030

# 3. (optional) LIVE trading via your iqair library
pip install -e /path/to/iqair
python live/iqair_sidecar.py   # listens on 127.0.0.1:8788
```

Then in the OS: **⚙ Settings → LIVE broker** → sidecar URL + your IQ Option credentials → **Connect LIVE**.

> In production/sandbox deployments where the browser talks to the services through a gateway on one host, requests carry `?XTransformPort=3030`; the included `Caddyfile` implements that routing. Running locally on one machine you can also hit `:3030` directly. This gateway is **not** used by the Docker deployment below — there, the browser only ever talks to the web container, which resolves the kernel itself via `KERNEL_URL`.

## Docker deployment (VPS)

The whole stack also runs as three Docker containers — see **`docker-compose.yml`** and **`deploy/README.md`** for the full walkthrough (cloning into `/opt/`, wiring into an existing Caddy-as-a-container reverse proxy, Cloudflare DNS, etc).

```bash
cp .env.example .env        # fill in your LLM provider key(s)
docker compose up -d --build
```

- `iqos-web` (Next.js), `iqos-kernel` (trading-core), `iqos-sidecar` (LIVE bridge, optional — comment it out if you never use LIVE mode)
- Cross-container calls use `KERNEL_URL=http://iqos-kernel:47312` and, for LIVE mode, sidecar URL `http://iqos-sidecar:47313` — Docker's internal DNS, not `localhost`
- Deliberately unusual internal ports (`47311`/`47312`/`47313`) so they don't collide with other projects' `3000`/`8080`/etc conventions on a shared host; none of them are published to the internet except through your reverse proxy
- Kernel SQLite data and the sidecar's persisted broker session each live in their own named Docker volume, so they survive rebuilds/redeploys

## Safety

- The paper account ($10,000) is the default and everything works without credentials.
- The sidecar connects to **PRACTICE** by default; REAL requires an explicit toggle and prints a warning.
- This is an unofficial community tool, not affiliated with or endorsed by IQ Option. IQ Option's API is undocumented and can change without notice. Trading involves substantial risk — trade responsibly.
