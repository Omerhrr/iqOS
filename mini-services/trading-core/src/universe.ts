// IQAIR//OS - Instrument universe
// Full IQ Option tradable universe: forex (+OTC), crypto, commodities, stocks, indices.
// Every instrument carries the metadata the whole OS runs on: precision, volatility,
// payouts per trade kind, leverage, schedule and the live iqair instrument id.

import type { AssetCategory, AssetInfo } from './types'

type Row = [
  ticker: string,
  name: string,
  category: AssetCategory,
  base: number,
  pip: number,
  vol: number, // per-second sigma for the sim engine
  payout: number, // binary
  leverage: number,
  schedule: '24/7' | '24/5' | 'market',
]

// payout helper: turbo runs ~0.02 below binary, digital ~0.05 above (capped 0.97)
const payouts = (b: number): { turbo: number; digital: number } => ({
  turbo: Math.round((b - 0.02) * 100) / 100,
  digital: Math.min(0.97, Math.round((b + 0.05) * 100) / 100),
})

const FX: Row[] = [
  ['EURUSD', 'Euro / US Dollar', 'forex', 1.0854, 5, 0.000045, 0.85, 30, '24/5'],
  ['GBPUSD', 'Pound / US Dollar', 'forex', 1.2702, 5, 0.000055, 0.84, 30, '24/5'],
  ['USDJPY', 'US Dollar / Yen', 'forex', 151.24, 3, 0.00006, 0.85, 30, '24/5'],
  ['USDCHF', 'US Dollar / Swiss Franc', 'forex', 0.8818, 5, 0.000042, 0.83, 30, '24/5'],
  ['USDCAD', 'US Dollar / Canadian Dollar', 'forex', 1.3562, 5, 0.000044, 0.83, 30, '24/5'],
  ['AUDUSD', 'Australian Dollar / US Dollar', 'forex', 0.6592, 5, 0.00005, 0.84, 30, '24/5'],
  ['NZDUSD', 'New Zealand Dollar / US Dollar', 'forex', 0.6021, 5, 0.000052, 0.83, 30, '24/5'],
  ['EURJPY', 'Euro / Yen', 'forex', 164.12, 3, 0.000065, 0.84, 30, '24/5'],
  ['GBPJPY', 'Pound / Yen', 'forex', 192.05, 3, 0.00008, 0.84, 30, '24/5'],
  ['EURGBP', 'Euro / Pound', 'forex', 0.8546, 5, 0.000038, 0.82, 30, '24/5'],
  ['AUDJPY', 'Australian Dollar / Yen', 'forex', 99.68, 3, 0.00007, 0.83, 30, '24/5'],
  ['CADJPY', 'Canadian Dollar / Yen', 'forex', 111.52, 3, 0.000066, 0.83, 30, '24/5'],
  ['CHFJPY', 'Swiss Franc / Yen', 'forex', 171.45, 3, 0.000068, 0.83, 30, '24/5'],
  ['NZDJPY', 'New Zealand Dollar / Yen', 'forex', 91.07, 3, 0.000067, 0.82, 30, '24/5'],
  ['EURAUD', 'Euro / Australian Dollar', 'forex', 1.6472, 5, 0.000055, 0.82, 20, '24/5'],
  ['EURCAD', 'Euro / Canadian Dollar', 'forex', 1.4712, 5, 0.00005, 0.82, 20, '24/5'],
  ['EURCHF', 'Euro / Swiss Franc', 'forex', 0.9571, 5, 0.000034, 0.8, 20, '24/5'],
  ['EURNZD', 'Euro / New Zealand Dollar', 'forex', 1.8024, 5, 0.00006, 0.82, 20, '24/5'],
  ['GBPAUD', 'Pound / Australian Dollar', 'forex', 1.9275, 5, 0.000065, 0.82, 20, '24/5'],
  ['GBPCAD', 'Pound / Canadian Dollar', 'forex', 1.7224, 5, 0.00006, 0.82, 20, '24/5'],
  ['GBPCHF', 'Pound / Swiss Franc', 'forex', 1.1202, 5, 0.000052, 0.8, 20, '24/5'],
  ['GBPNZD', 'Pound / New Zealand Dollar', 'forex', 2.1103, 5, 0.00007, 0.82, 20, '24/5'],
  ['AUDCAD', 'Australian Dollar / Canadian Dollar', 'forex', 0.8938, 5, 0.000042, 0.81, 20, '24/5'],
  ['AUDCHF', 'Australian Dollar / Swiss Franc', 'forex', 0.5812, 5, 0.000045, 0.8, 20, '24/5'],
  ['AUDNZD', 'Australian Dollar / NZ Dollar', 'forex', 1.0948, 5, 0.000036, 0.79, 20, '24/5'],
  ['CADCHF', 'Canadian Dollar / Swiss Franc', 'forex', 0.6508, 5, 0.00004, 0.8, 20, '24/5'],
  ['NZDCAD', 'NZ Dollar / Canadian Dollar', 'forex', 0.8168, 5, 0.00004, 0.8, 20, '24/5'],
  ['NZDCHF', 'NZ Dollar / Swiss Franc', 'forex', 0.5312, 5, 0.000042, 0.79, 20, '24/5'],
  ['USDZAR', 'US Dollar / South African Rand', 'forex', 18.152, 4, 0.0002, 0.78, 10, '24/5'],
  ['USDTRY', 'US Dollar / Turkish Lira', 'forex', 34.215, 4, 0.00025, 0.75, 10, '24/5'],
  ['USDMXN', 'US Dollar / Mexican Peso', 'forex', 17.052, 4, 0.00016, 0.77, 10, '24/5'],
  ['USDSGD', 'US Dollar / Singapore Dollar', 'forex', 1.3402, 5, 0.000035, 0.78, 20, '24/5'],
  ['USDCNH', 'US Dollar / Offshore Yuan', 'forex', 7.2402, 5, 0.000035, 0.76, 20, '24/5'],
  ['USDINR', 'US Dollar / Indian Rupee', 'forex', 83.41, 3, 0.00006, 0.72, 10, '24/5'],
  ['USDBRL', 'US Dollar / Brazilian Real', 'forex', 5.452, 4, 0.00018, 0.7, 10, '24/5'],
]

const OTC: Row[] = [
  ['EURUSD-OTC', 'Euro / US Dollar OTC', 'forex', 1.0858, 5, 0.00006, 0.94, 30, '24/7'],
  ['GBPUSD-OTC', 'Pound / US Dollar OTC', 'forex', 1.2696, 5, 0.00007, 0.93, 30, '24/7'],
  ['USDJPY-OTC', 'US Dollar / Yen OTC', 'forex', 151.42, 3, 0.000075, 0.94, 30, '24/7'],
  ['USDCHF-OTC', 'US Dollar / Swiss Franc OTC', 'forex', 0.8824, 5, 0.000055, 0.92, 30, '24/7'],
  ['USDCAD-OTC', 'US Dollar / CAD OTC', 'forex', 1.3558, 5, 0.000058, 0.92, 30, '24/7'],
  ['AUDCAD-OTC', 'AUD / CAD OTC', 'forex', 0.8934, 5, 0.000055, 0.92, 20, '24/7'],
  ['EURJPY-OTC', 'Euro / Yen OTC', 'forex', 164.25, 3, 0.00008, 0.93, 30, '24/7'],
  ['EURGBP-OTC', 'Euro / Pound OTC', 'forex', 0.8551, 5, 0.000048, 0.92, 30, '24/7'],
  ['GBPJPY-OTC', 'Pound / Yen OTC', 'forex', 192.24, 3, 0.00009, 0.93, 30, '24/7'],
  ['NZDUSD-OTC', 'NZ Dollar / US Dollar OTC', 'forex', 0.6018, 5, 0.000062, 0.92, 30, '24/7'],
]

const CRYPTO: Row[] = [
  ['BTCUSD', 'Bitcoin / US Dollar', 'crypto', 97240, 1, 0.00035, 0.9, 2, '24/7'],
  ['ETHUSD', 'Ethereum / US Dollar', 'crypto', 3412, 2, 0.00042, 0.9, 2, '24/7'],
  ['SOLUSD', 'Solana / US Dollar', 'crypto', 196.4, 2, 0.0006, 0.88, 2, '24/7'],
  ['XRPUSD', 'Ripple / US Dollar', 'crypto', 2.412, 4, 0.00055, 0.88, 2, '24/7'],
  ['BNBUSD', 'BNB / US Dollar', 'crypto', 642.5, 2, 0.00045, 0.87, 2, '24/7'],
  ['ADAUSD', 'Cardano / US Dollar', 'crypto', 0.9482, 4, 0.00058, 0.87, 2, '24/7'],
  ['DOGEUSD', 'Dogecoin / US Dollar', 'crypto', 0.3512, 5, 0.00068, 0.86, 2, '24/7'],
  ['LTCUSD', 'Litecoin / US Dollar', 'crypto', 105.3, 2, 0.00048, 0.86, 2, '24/7'],
  ['BCHUSD', 'Bitcoin Cash / US Dollar', 'crypto', 462.1, 2, 0.0005, 0.85, 2, '24/7'],
  ['DOTUSD', 'Polkadot / US Dollar', 'crypto', 7.24, 3, 0.00058, 0.85, 2, '24/7'],
  ['AVAXUSD', 'Avalanche / US Dollar', 'crypto', 38.42, 3, 0.00062, 0.85, 2, '24/7'],
  ['LINKUSD', 'Chainlink / US Dollar', 'crypto', 22.18, 3, 0.0006, 0.85, 2, '24/7'],
  ['TRXUSD', 'Tron / US Dollar', 'crypto', 0.2412, 5, 0.00045, 0.84, 2, '24/7'],
  ['XLMUSD', 'Stellar / US Dollar', 'crypto', 0.4212, 5, 0.00055, 0.84, 2, '24/7'],
  ['ETCUSD', 'Ethereum Classic / US Dollar', 'crypto', 26.35, 3, 0.00055, 0.84, 2, '24/7'],
  ['ATOMUSD', 'Cosmos / US Dollar', 'crypto', 6.82, 3, 0.0006, 0.83, 2, '24/7'],
  ['NEOUSD', 'NEO / US Dollar', 'crypto', 14.22, 3, 0.00058, 0.83, 2, '24/7'],
  ['UNIUSD', 'Uniswap / US Dollar', 'crypto', 12.48, 3, 0.00065, 0.83, 2, '24/7'],
]

const COMMODITIES: Row[] = [
  ['XAUUSD', 'Gold / US Dollar', 'commodity', 2641.5, 2, 0.00009, 0.82, 20, '24/5'],
  ['XAGUSD', 'Silver / US Dollar', 'commodity', 30.82, 3, 0.00019, 0.8, 10, '24/5'],
  ['XPTUSD', 'Platinum / US Dollar', 'commodity', 962.4, 2, 0.00016, 0.78, 10, '24/5'],
  ['XPDUSD', 'Palladium / US Dollar', 'commodity', 1018.2, 2, 0.00022, 0.75, 10, '24/5'],
  ['UKBrent', 'Brent Oil', 'commodity', 73.52, 2, 0.00022, 0.82, 20, '24/5'],
  ['USCrude', 'WTI Crude Oil', 'commodity', 69.84, 2, 0.00024, 0.82, 20, '24/5'],
  ['NGAS', 'Natural Gas', 'commodity', 2.854, 3, 0.00035, 0.78, 10, '24/5'],
  ['COPPER', 'Copper', 'commodity', 4.252, 3, 0.00018, 0.76, 10, '24/5'],
]

const STOCKS: Row[] = [
  ['AAPL', 'Apple Inc.', 'stock', 232.4, 2, 0.00016, 0.8, 5, 'market'],
  ['TSLA', 'Tesla Inc.', 'stock', 411.2, 2, 0.00032, 0.82, 5, 'market'],
  ['NVDA', 'NVIDIA Corp.', 'stock', 135.6, 2, 0.0003, 0.82, 5, 'market'],
  ['AMZN', 'Amazon.com Inc.', 'stock', 205.8, 2, 0.0002, 0.8, 5, 'market'],
  ['MSFT', 'Microsoft Corp.', 'stock', 426.3, 2, 0.00015, 0.8, 5, 'market'],
  ['GOOG', 'Alphabet Inc.', 'stock', 178.4, 2, 0.00017, 0.8, 5, 'market'],
  ['META', 'Meta Platforms Inc.', 'stock', 586.2, 2, 0.00024, 0.8, 5, 'market'],
  ['NFLX', 'Netflix Inc.', 'stock', 782.5, 2, 0.00024, 0.8, 5, 'market'],
  ['AMD', 'Advanced Micro Devices', 'stock', 155.3, 2, 0.00028, 0.8, 5, 'market'],
  ['INTC', 'Intel Corp.', 'stock', 24.18, 2, 0.00026, 0.78, 5, 'market'],
  ['BABA', 'Alibaba Group', 'stock', 88.42, 2, 0.00026, 0.78, 5, 'market'],
  ['JPM', 'JPMorgan Chase', 'stock', 235.4, 2, 0.00015, 0.78, 10, 'market'],
  ['V', 'Visa Inc.', 'stock', 305.2, 2, 0.00013, 0.78, 10, 'market'],
  ['WMT', 'Walmart Inc.', 'stock', 88.65, 2, 0.00012, 0.76, 10, 'market'],
  ['PG', 'Procter & Gamble', 'stock', 168.4, 2, 0.0001, 0.75, 10, 'market'],
  ['KO', 'Coca-Cola Co.', 'stock', 63.24, 2, 0.0001, 0.75, 10, 'market'],
  ['PEP', 'PepsiCo Inc.', 'stock', 172.3, 2, 0.0001, 0.75, 10, 'market'],
  ['MCD', "McDonald's Corp.", 'stock', 295.6, 2, 0.00011, 0.76, 10, 'market'],
  ['NKE', 'Nike Inc.', 'stock', 78.24, 2, 0.00016, 0.76, 10, 'market'],
  ['DIS', 'Walt Disney Co.', 'stock', 95.42, 2, 0.00017, 0.76, 10, 'market'],
  ['BA', 'Boeing Co.', 'stock', 155.8, 2, 0.00026, 0.78, 10, 'market'],
  ['GE', 'GE Aerospace', 'stock', 190.2, 2, 0.0002, 0.76, 10, 'market'],
  ['F', 'Ford Motor Co.', 'stock', 11.24, 3, 0.00022, 0.75, 10, 'market'],
  ['GM', 'General Motors', 'stock', 48.32, 2, 0.0002, 0.75, 10, 'market'],
  ['XOM', 'Exxon Mobil', 'stock', 118.4, 2, 0.00015, 0.76, 10, 'market'],
  ['PFE', 'Pfizer Inc.', 'stock', 28.42, 2, 0.00016, 0.74, 10, 'market'],
  ['JNJ', 'Johnson & Johnson', 'stock', 155.6, 2, 0.00011, 0.75, 10, 'market'],
  ['CVX', 'Chevron Corp.', 'stock', 152.8, 2, 0.00014, 0.75, 10, 'market'],
  ['CSCO', 'Cisco Systems', 'stock', 58.32, 2, 0.00013, 0.74, 10, 'market'],
  ['IBM', 'IBM Corp.', 'stock', 225.4, 2, 0.00014, 0.76, 10, 'market'],
  ['BAC', 'Bank of America', 'stock', 44.28, 2, 0.00017, 0.75, 10, 'market'],
  ['GS', 'Goldman Sachs', 'stock', 520.4, 2, 0.00016, 0.76, 10, 'market'],
]

const INDICES: Row[] = [
  ['SP500', 'S&P 500 Index', 'index', 5852.4, 1, 0.00007, 0.8, 20, '24/5'],
  ['NASDAQ100', 'Nasdaq 100 Index', 'index', 20412, 1, 0.0001, 0.8, 20, '24/5'],
  ['DJI30', 'Dow Jones 30', 'index', 42815, 1, 0.00007, 0.8, 20, '24/5'],
  ['DAX30', 'DAX 30 Index', 'index', 19412, 1, 0.00009, 0.78, 20, '24/5'],
  ['E50', 'Euro Stoxx 50', 'index', 4872.5, 1, 0.00008, 0.77, 20, '24/5'],
  ['FTSE100', 'FTSE 100 Index', 'index', 8252.4, 1, 0.00007, 0.77, 20, '24/5'],
  ['CAC40', 'CAC 40 Index', 'index', 7421.5, 1, 0.00008, 0.76, 20, '24/5'],
  ['NIKKEI225', 'Nikkei 225', 'index', 38912, 1, 0.0001, 0.78, 20, '24/5'],
  ['ASX200', 'ASX 200 Index', 'index', 8182.4, 1, 0.00007, 0.75, 20, '24/5'],
  ['HKEX50', 'Hang Seng Index', 'index', 19812, 1, 0.00012, 0.76, 20, '24/5'],
  ['AEX25', 'AEX 25 Index', 'index', 892.4, 2, 0.00008, 0.75, 20, '24/5'],
  ['IBEX35', 'IBEX 35 Index', 'index', 11612, 1, 0.00009, 0.74, 20, '24/5'],
]

// live iqair instrument id mapping for names the broker spells differently
const IQAIR_NAMES: Record<string, string> = {
  UKBrent: 'OIL_BRENT',
  USCrude: 'OIL_WTI',
  NGAS: 'NGAS',
  COPPER: 'COPPER',
  NASDAQ100: 'NSDQ100',
  DJI30: 'DJ30',
  DAX30: 'DAX30',
  E50: 'E50',
  '-OTC': '_otc',
}

function build(rows: Row[]): AssetInfo[] {
  return rows.map(([ticker, name, category, basePrice, pip, volatility, payout, leverage, schedule]) => {
    const p = payouts(payout)
    return {
      ticker,
      name,
      category,
      otc: ticker.endsWith('-OTC'),
      basePrice,
      pip,
      volatility,
      payout,
      turboPayout: p.turbo,
      digitalPayout: p.digital,
      leverage,
      schedule,
      open: schedule === '24/7' ? true : schedule === 'market' ? false : true,
      iqairName:
        IQAIR_NAMES[ticker] ?? (ticker.endsWith('-OTC') ? `${ticker.replace('-OTC', '')}_otc` : ticker),
    }
  })
}

/** The full tradable universe, ordered: forex -> OTC -> crypto -> commodities -> stocks -> indices. */
export const UNIVERSE: AssetInfo[] = [
  ...build(FX),
  ...build(OTC),
  ...build(CRYPTO),
  ...build(COMMODITIES),
  ...build(STOCKS),
  ...build(INDICES),
]

export const UNIVERSE_MAP = new Map(UNIVERSE.map((a) => [a.ticker, a]))

export function getInstrument(ticker: string): AssetInfo | undefined {
  return UNIVERSE_MAP.get(ticker)
}

export function instrumentsByCategory(cat: AssetCategory | 'all' | 'otc'): AssetInfo[] {
  if (cat === 'all') return UNIVERSE
  if (cat === 'otc') return UNIVERSE.filter((a) => a.otc)
  return UNIVERSE.filter((a) => a.category === cat)
}

export function searchInstruments(q: string, cat: AssetCategory | 'all' | 'otc' = 'all'): AssetInfo[] {
  const needle = q.trim().toLowerCase()
  const base = instrumentsByCategory(cat)
  if (!needle) return base
  return base.filter(
    (a) => a.ticker.toLowerCase().includes(needle) || a.name.toLowerCase().includes(needle)
  )
}

/** Is an instrument currently in session (simplified: exchange hours 13:30-20:00 UTC Mon-Fri). */
export function isInstrumentOpen(a: AssetInfo, now = new Date()): boolean {
  if (a.schedule === '24/7') return true
  const day = now.getUTCDay()
  const hour = now.getUTCHours() + now.getUTCMinutes() / 60
  if (a.schedule === '24/5') return day >= 1 && day <= 5
  // 'market' = US equity session 13:30-20:00 UTC
  return day >= 1 && day <= 5 && hour >= 13.5 && hour < 20
}

export const UNIVERSE_STATS = {
  total: UNIVERSE.length,
  forex: FX.length + OTC.length,
  otc: OTC.length,
  crypto: CRYPTO.length,
  commodities: COMMODITIES.length,
  stocks: STOCKS.length,
  indices: INDICES.length,
}
