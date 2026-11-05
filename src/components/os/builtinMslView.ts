// IQAIR//OS - "make them all msl then" per direct instruction, after
// explaining that builtin.ts's STRATEGIES catalog is real compiled
// TypeScript (Markov chains, Kalman filters, Monte Carlo, VSK/TSK
// synthesis, correlation/cointegration/triangulation - genuinely iterative
// numerical algorithms), which MSL's sandboxed grammar (no loops, no
// function definitions, no raw candle access - see strategylang.ts's own
// header for why) CANNOT literally become without losing what makes it
// safe. So this is the honest version of "make them all MSL": builtinSig()
// (one of the AI Lab's own MSL signal functions, strategies/
// signalscript.ts) already calls a builtin strategy's REAL evaluate()
// function unmodified via custom.ts's signalActive() - not a
// reimplementation, a live delegate call - so EVERY one of the 57 builtin
// strategies, however complex, gets a byte-identical-on-direction MSL view
// for free: a tiny two-line wrapper exposing its call/put verdict as an
// MSL script. The one thing this view can't carry over is the strategy's
// own internal confidence/score formula - builtinSig only reports
// active/inactive per side with a flat confidence YOU choose (same
// limitation every other 'builtin'-kind AI Lab signal has always had), so
// this is the direction-faithful, not score-faithful, translation.
// Editable and testable (via /lab_test_script, the AI Lab's resolver -
// Meta-Strategy's own script dialect has NO function-call resolver, only
// named source reads, so builtinSig only works in the AI Lab/Strategy-Lab
// MSL dialect, not Meta-Strategy's) and "save as new AI Lab strategy"
// promotes an edited version into its own independent custom:<id> spec -
// it never rewrites builtin.ts itself, since a script saved here is a NEW
// strategy built on top of the original, not a replacement for it.
export function builtinStrategyToMsl(id: string, name: string, confidence = 70): string {
  return [
    `# ${name} ('${id}') - MSL view via builtinSig(), a live call-through to`,
    `# this strategy's OWN evaluate() (real compiled TypeScript) - not a`,
    `# reimplementation, so the call/put verdict below is byte-identical to`,
    `# running '${id}' directly. The ${confidence} is a confidence YOU choose`,
    `# for this view (builtinSig reports active/inactive per side, not the`,
    `# strategy's own internal score - same as every 'builtin'-kind AI Lab`,
    '# signal). Edit this to combine it with other signals, test it, then',
    '# "save as new AI Lab strategy" - that creates an independent custom:<id>',
    `# spec built ON TOP of '${id}'; it never changes builtin.ts itself.`,
    `let callSide = builtinSig('${id}', call, ${confidence})`,
    `let putSide = builtinSig('${id}', put, ${confidence})`,
    'call when callSide.active',
    'put when putSide.active',
    `confidence = ${confidence}`,
    '',
  ].join('\n')
}
