// Composite "Macro Pressure Score" — 0 to 100.
// Higher = conditions more consistent with the bearish thesis intensifying
// (hawkish policy, credit stress, dollar strength, QT, leverage froth).
//
// FULLY TRANSPARENT BY DESIGN: the UI renders every row of the breakdown
// this module returns. There is no math anywhere else.
//
// TO ADJUST WEIGHTS OR RANGES: edit INPUTS below. Weights must sum to 1.0
// (validated at module load). Each input is normalized to 0–100 across
// [min, max] and clamped; direction -1 inverts (so "more inverted curve"
// or "faster QT" pushes the score UP).

export const INPUTS = [
  { key: 'hy_oas',      label: 'HY credit spread (OAS)',   unit: '%',      min: 2.5,  max: 6.0,  direction: +1, weight: 0.20, source: 'fred',     note: 'BAMLH0A0HYM2 — wider = credit stress' },
  { key: 'ust10y',      label: '10Y Treasury yield',       unit: '%',      min: 3.5,  max: 5.5,  direction: +1, weight: 0.15, source: 'fred',     note: 'DGS10 — higher = tighter discount rates' },
  { key: 'policy_gap',  label: 'Fed funds vs 2.5% neutral',unit: 'pp',     min: 0.0,  max: 3.0,  direction: +1, weight: 0.15, source: 'fred',     note: 'DFF − 2.5 — restrictiveness proxy' },
  { key: 'curve_2s10s', label: '2s10s spread',             unit: 'pp',     min: -1.5, max: 0.5,  direction: -1, weight: 0.10, source: 'fred',     note: 'DGS10 − DGS2 — deeper inversion = higher pressure' },
  { key: 'dollar',      label: 'Broad dollar index',       unit: '',       min: 112,  max: 130,  direction: +1, weight: 0.10, source: 'fred',     note: 'DTWEXBGS — stronger USD = global tightening' },
  { key: 'qt_13w',      label: 'Fed balance sheet, 13w Δ', unit: '%',      min: -3.0, max: 1.0,  direction: -1, weight: 0.10, source: 'fred',     note: 'WALCL — shrinking = liquidity drain' },
  { key: 'funding_ann', label: 'BTC perp funding (ann.)',  unit: '%',      min: -10,  max: 30,   direction: +1, weight: 0.10, source: 'funding',  note: 'High positive funding = leverage froth' },
  { key: 'fear_greed',  label: 'Crypto Fear & Greed',      unit: '',       min: 10,   max: 90,   direction: +1, weight: 0.10, source: 'feargreed',note: 'Greed = complacency (contrarian read)' },
]

const weightSum = INPUTS.reduce((s, i) => s + i.weight, 0)
if (Math.abs(weightSum - 1) > 1e-9) {
  throw new Error(`Score input weights must sum to 1.0, got ${weightSum}`)
}

export function normalize(value, { min, max, direction }) {
  const t = Math.min(1, Math.max(0, (value - min) / (max - min))) * 100
  return direction === -1 ? 100 - t : t
}

/**
 * @param {Record<string, number|null|undefined>} values keyed by INPUTS[].key
 * @returns {{ score:number|null, breakdown:Array, inputsUsed:number, inputsTotal:number, renormalized:boolean }}
 * Missing/null inputs are EXCLUDED and remaining weights are renormalized —
 * and that fact is reported, never hidden.
 */
export function computeScore(values) {
  const present = INPUTS.filter(
    (i) => Number.isFinite(values?.[i.key])
  )
  const inputsTotal = INPUTS.length
  const inputsUsed = present.length
  if (inputsUsed === 0) {
    return { score: null, breakdown: [], inputsUsed, inputsTotal, renormalized: false }
  }
  const presentWeight = present.reduce((s, i) => s + i.weight, 0)
  const renormalized = inputsUsed !== inputsTotal

  const breakdown = INPUTS.map((i) => {
    const value = values?.[i.key]
    const included = Number.isFinite(value)
    const effWeight = included ? i.weight / presentWeight : 0
    const norm = included ? normalize(value, i) : null
    return {
      key: i.key,
      label: i.label,
      unit: i.unit,
      note: i.note,
      source: i.source,
      value: included ? value : null,
      min: i.min,
      max: i.max,
      direction: i.direction,
      baseWeight: i.weight,
      effectiveWeight: round(effWeight, 4),
      normalized: norm === null ? null : round(norm, 1),
      contribution: norm === null ? null : round(norm * effWeight, 2),
      included,
    }
  })

  const score = round(
    breakdown.filter((b) => b.included).reduce((s, b) => s + b.normalized * b.effectiveWeight, 0),
    1
  )
  return { score, breakdown, inputsUsed, inputsTotal, renormalized }
}

export function scoreBand(score) {
  if (score == null) return { name: 'no data', tone: 'down' }
  if (score < 35) return { name: 'benign', tone: 'live' }
  if (score < 55) return { name: 'tightening', tone: 'watch' }
  if (score < 70) return { name: 'elevated', tone: 'stale' }
  return { name: 'stress', tone: 'down' }
}

function round(n, dp) {
  const f = 10 ** dp
  return Math.round(n * f) / f
}
