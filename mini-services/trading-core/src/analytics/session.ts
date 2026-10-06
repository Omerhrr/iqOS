// IQAIR//OS - trading session classifier
// Real (non-OTC) FX pairs trade very differently depending on which market
// center is open: thin and choppy in the dead hours, sharp and directional
// during the London/NY overlap. A strategy's win rate pooled across all of
// that is an average of two very different regimes-of-time, same reasoning
// as classifyRegime (analytics/regime.ts) but keyed on the clock instead of
// price action. Boundaries are UTC and intentionally simple (5 non-
// overlapping buckets covering the full day) - precise to the half-hour
// doesn't matter here, only "which of five very different windows is this".
//
// -OTC tickers are the broker's own synthetic weekend/24-7 instruments - IQ
// runs the SAME kind of generated random walk on them at 3am Tuesday as it
// does at 3pm Saturday, with no real market session behind it at all. Tag
// them all 'OTC' instead of splitting them by clock hour: splitting would
// fragment one pool of genuinely-comparable history into five buckets that
// differ from each other for no real reason, which only delays (and can
// mislead) the adaptive gate's judgment on exactly the pairs this system
// likely trades most on weekends.

export type Session = 'ASIA' | 'LONDON' | 'OVERLAP' | 'NEWYORK' | 'OFF' | 'OTC'

/**
 * asiaOpen 00:00 UTC, londonOpen 08:00 UTC, londonNyOverlap 13:00-16:00 UTC
 * (both majors open - historically the most liquid window), nyClose 21:00
 * UTC, then OFF (21:00-24:00 UTC) until Asia reopens - the thinnest window,
 * same boundary avoidDeadHours (os-mode.ts) treats as worth sitting out.
 * Pass the asset ticker so an -OTC instrument always comes back 'OTC'
 * regardless of the clock - see the file header for why.
 */
export function classifySession(ts: number, asset?: string): Session {
  if (asset?.endsWith('-OTC')) return 'OTC'
  const h = new Date(ts * 1000).getUTCHours()
  if (h < 8) return 'ASIA'
  if (h < 13) return 'LONDON'
  if (h < 16) return 'OVERLAP'
  if (h < 21) return 'NEWYORK'
  return 'OFF'
}
