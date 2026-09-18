# Worklog

---
Task ID: 1
Agent: Super Z (main agent)
Task: Build IQAIR//OS - a full trading operating system centered on the user's iqair library (https://github.com/Omerhrr/iqair), repurposing the deepseek-harness (https://github.com/deepseek-ai/deepseek-harness) architecture.

Work Log:
- Cloned both reference repos into /home/z/my-project/refs/ (iqair + deepseek-harness) and read their architecture docs (README, AGENT.md, USAGE.md, harness architecture/plugin docs).
- Analyzed iqair: IQOptionClient (6 trading modes, live-verified), api.broker OOP wrapper, api.stream, and the iqair.agent JSON tool layer (call_tool dispatcher + HTTP server).
- Analyzed deepseek-harness: "everything is a plugin" Cordis architecture - kernel context, event bus, lifecycle-managed services, LLM tool-calling loop.
- Initialized fullstack Next.js 16 environment; installed lightweight-charts 5, socket.io.
- Built mini-services/trading-core (port 3030, bun): a repurposed harness kernel:
  - src/kernel.ts: EventBus + plugin lifecycle (register/start/stop, service registry)
  - src/plugins/store.ts + src/store.ts: bun:sqlite persistence (account, positions, alerts, agent chat)
  - src/plugins/market-data.ts: regime-switching GBM sim engine (10 assets, 5 timeframes, 1s ticks, seeded 760-candle history per tf) + iqair LIVE bridge (connectLive/pollLive)
  - src/analytics/indicators.ts: 25+ indicators (SMA/EMA/WMA, RSI, MACD, Stochastic, Bollinger, Keltner, Donchian, ATR, ADX/DI, CCI, Williams %R, MFI, OBV, VWAP, ROC, Supertrend, Ichimoku, PSAR, pivots, fib, linreg)
  - src/analytics/patterns.ts: 17 candlestick pattern detectors + bias score
  - src/analytics/quant.ts: first-order Markov chain (vol-scaled states, Laplace-smoothed matrix, stationary dist, entropy, regime), Monte Carlo (GBM+bootstrap, VaR95/CVaR95), Hurst exponent (R/S), autocorrelation, EWMA + GARCH(1,1) grid-fit, regression channel, S/R zone clustering
  - src/analytics/engine.ts: full analysis pipeline + 13-factor weighted composite signal
  - src/strategies/builtin.ts: 10 data-driven strategies (incl. Markov Regime Edge and Confluence Core)
  - src/strategies/backtest.ts: binary + spot backtester (win rate, PF, maxDD, Sharpe, expectancy, equity curve)
  - src/plugins/execution.ts: paper broker (binary expiry + spot TP/SL settlement on candle closes), risk manager (kill switch, daily loss limit, max stake, max open, loss-streak cooldown), iqair live order adapter
  - index.ts: REST surface + socket.io (room-scoped candle feeds, global ticks/account/alerts)
- Built live/iqair_sidecar.py: Python bridge that runs the user's iqair library (connect, balance, candles, price, turbo/binary/forex/crypto/CFD trades, positions, history) on 127.0.0.1:8788; the OS switches from SIM to LIVE through it.
- Built src/app/api/agent/route.ts: LLM agent harness (z-ai-web-dev-sdk) with a 13-tool JSON action loop (analyze_market, markov_chain, monte_carlo, backtest, place_trade, close_position, positions, account, set_active_asset, ...), trace persisted, raw-JSON reply sanitization, tool budget synthesis.
- Built the OS UI (dark terminal aesthetic): page.tsx shell + MenuBar (account metrics, kill switch, settings dialog with risk config + LIVE connect), MarketWatch, ChartPanel (lightweight-charts v5 candles + EMA/Boll/Supertrend/VWAP overlays + volume), IndicatorPanel, SignalPanel (confluence gauge + factor votes), MarkovPanel (5x5 heatmap + next-move forecast), QuantPanel (MC fan SVG, ACF strip, stats), TradeTicket (binary/spot, CALL/PUT), Copilot (chat + tool trace), BottomTabs (positions blotter, history, Backtest Lab, Strategy Lab, patterns, alerts).
- Fixed bugs found during verification: socket.io path collision (REST swallowed), store db path, double-slash fetch URLs, SSR clock hydration mismatch, missing fmtPct import, agent raw-JSON reply leak.
- Verified end-to-end with agent-browser through the Caddy gateway (:81): boot screen, live streaming ticks, chart, analysis panels, UI trade placement -> automatic settlement (toasts), backtest lab, copilot tool-calling with quant read-out, kill switch engage/release, mobile layout.

Stage Summary:
- Deliverable: fully functional trading OS at / (Next.js UI) + trading-core kernel on :3030 + iqair sidecar for live IQ Option trading.
- Verified flows: sim market streaming, full TA + quant analytics, 10 strategies + backtesting, paper trading with risk manager, AI copilot driving the kernel, iqair LIVE bridge ready (needs user credentials + sidecar run locally).
- All user-facing state persisted in mini-services/trading-core/data/os.db (SQLite).
