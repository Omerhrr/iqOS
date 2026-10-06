// IQAIR//OS - Randomness audit
// Pure descriptive statistics for characterizing an OTC (synthetic) price
// feed's empirical behavior: how big a typical step is, how its returns are
// distributed (normal-ish vs fat-tailed), and how often new data actually
// arrives. This is NOT an attempt to predict any specific future value or to
// infer anything about a broker's internal RNG/seed - it is the same kind of
// descriptive summary any quant would compute on any observable price series
// (mean step, std dev, skew, kurtosis, inter-arrival timing), reused here on
// IQ Option OTC data purely to describe what the feed looks like statistically.

export interface PricePoint {
  time: number // unix seconds (fractional allowed)
  price: number
}

export interface StepStats {
  meanAbsStep: number
  stdDevReturns: number
  skewness: number
  excessKurtosis: number
  n: number
}

export interface IntervalStats {
  meanIntervalMs: number
  medianIntervalMs: number
  updatesPerSecond: number
  jitterStdDevMs: number
  n: number
}

/**
 * computeStepStats
 * -----------------
 * Returns are computed as simple relative price changes:
 *   r[i] = (price[i] - price[i-1]) / price[i-1]
 * (relative returns, not raw price differences) because OTC instruments on
 * IQ Option span wildly different price scales (e.g. a sub-1 FX cross vs a
 * four-digit index/crypto OTC) - raw differences would make "step size"
 * incomparable across assets, while relative returns are scale-free and are
 * the standard convention for volatility/kurtosis analysis in quant finance.
 *
 * Average Step Size is reported as the MEAN ABSOLUTE RAW price difference
 * (|price[i]-price[i-1]|, not the return) per the spec - this is the
 * intuitive "how many price units does it typically move" figure, kept
 * alongside (not instead of) the scale-free return statistics below.
 *
 * Formulas (standard):
 *   mean(x)              = (1/n) * sum(x_i)
 *   variance(x)          = (1/n) * sum((x_i - mean)^2)            [population]
 *   stdDev(x)             = sqrt(variance)
 *   skewness(x)           = (1/n) * sum(((x_i - mean)/stdDev)^3)
 *   excessKurtosis(x)     = (1/n) * sum(((x_i - mean)/stdDev)^4) - 3
 *     (subtracting 3 makes a normal distribution read ~0; "excess" kurtosis)
 */
export function computeStepStats(series: PricePoint[]): StepStats {
  const n = series.length
  if (n < 3) return { meanAbsStep: 0, stdDevReturns: 0, skewness: 0, excessKurtosis: 0, n: Math.max(0, n) }

  const absSteps: number[] = []
  const returns: number[] = []
  for (let i = 1; i < n; i++) {
    const prev = series[i - 1].price
    const cur = series[i].price
    absSteps.push(Math.abs(cur - prev))
    if (prev !== 0) returns.push((cur - prev) / prev)
  }

  const mean = (xs: number[]) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : 0)
  const meanAbsStep = mean(absSteps)

  const m = mean(returns)
  const variance = returns.length ? mean(returns.map((r) => (r - m) ** 2)) : 0
  const stdDevReturns = Math.sqrt(variance)

  let skewness = 0
  let excessKurtosis = 0
  if (stdDevReturns > 0 && returns.length > 0) {
    const z = returns.map((r) => (r - m) / stdDevReturns)
    skewness = mean(z.map((v) => v ** 3))
    excessKurtosis = mean(z.map((v) => v ** 4)) - 3
  }

  return { meanAbsStep, stdDevReturns, skewness, excessKurtosis, n }
}

/**
 * computeIntervalStats
 * ---------------------
 * Measures how often new data points actually arrive, from REAL consecutive
 * timestamps (never assumed/fixed). `jitterStdDevMs` is the standard
 * deviation of the inter-arrival intervals: near-zero means the feed updates
 * on a near-perfectly metronomic schedule (suggestive of a scheduled/timed
 * generator); a large value relative to the mean means arrival timing is
 * naturally variable (closer to what an organic, event-driven feed looks
 * like).
 */
export function computeIntervalStats(series: PricePoint[]): IntervalStats {
  const n = series.length
  if (n < 2) return { meanIntervalMs: 0, medianIntervalMs: 0, updatesPerSecond: 0, jitterStdDevMs: 0, n: Math.max(0, n) }

  const intervalsMs: number[] = []
  for (let i = 1; i < n; i++) {
    const dt = (series[i].time - series[i - 1].time) * 1000
    if (dt > 0) intervalsMs.push(dt)
  }
  if (!intervalsMs.length) return { meanIntervalMs: 0, medianIntervalMs: 0, updatesPerSecond: 0, jitterStdDevMs: 0, n }

  const sorted = [...intervalsMs].sort((a, b) => a - b)
  const mid = Math.floor(sorted.length / 2)
  const medianIntervalMs = sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2

  const meanIntervalMs = intervalsMs.reduce((a, b) => a + b, 0) / intervalsMs.length
  const variance = intervalsMs.reduce((a, b) => a + (b - meanIntervalMs) ** 2, 0) / intervalsMs.length
  const jitterStdDevMs = Math.sqrt(variance)
  const updatesPerSecond = meanIntervalMs > 0 ? 1000 / meanIntervalMs : 0

  return { meanIntervalMs, medianIntervalMs, updatesPerSecond, jitterStdDevMs, n: intervalsMs.length + 1 }
}
