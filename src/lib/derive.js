// Pure derivations shared by the UI, the scheduled snapshot function,
// and the unit tests. No fetching in this file — inputs in, numbers out.

// ---------- Aave position stress testing ----------
// ASSUMPTION (shown in the UI wherever these numbers appear): collateral is
// 100% BTC-correlated (WBTC) and debt is NOT BTC-correlated (e.g. USDC).
// Under that assumption, a BTC price shock scales collateral linearly and
// leaves debt unchanged, so HF scales linearly too.

/** Health factor after a BTC price shock. shockPct is e.g. -0.30 for -30%. */
export function stressHealthFactor(hf, shockPct) {
  if (!Number.isFinite(hf)) return null
  return hf * (1 + shockPct)
}

/** The BTC drawdown (negative fraction) at which HF hits exactly 1.0. */
export function liquidationDrawdown(hf) {
  if (!Number.isFinite(hf) || hf <= 0) return null
  return 1 / hf - 1
}

/** BTC price at which HF hits 1.0, given the current price. */
export function liquidationPrice(btcPrice, hf) {
  if (!Number.isFinite(btcPrice) || !Number.isFinite(hf) || hf <= 0) return null
  return btcPrice / hf
}

export const STRESS_SCENARIOS = [-0.10, -0.20, -0.30, -0.40]

// ---------- FRED series derivations ----------
// FRED observation arrays are [{ d: 'YYYY-MM-DD', v: number|null }, ...] DESCENDING.

export function latestValue(obs) {
  const hit = (obs || []).find((o) => Number.isFinite(o.v))
  return hit ? { date: hit.d, value: hit.v } : null
}

/** 2s10s from the most recent date where BOTH series have a reading. */
export function curveSpread(obs10, obs2) {
  const byDate = new Map((obs2 || []).filter((o) => Number.isFinite(o.v)).map((o) => [o.d, o.v]))
  for (const o of obs10 || []) {
    if (Number.isFinite(o.v) && byDate.has(o.d)) {
      return { date: o.d, value: round(o.v - byDate.get(o.d), 3) }
    }
  }
  return null
}

/** % change vs N weekly observations back (WALCL is weekly). */
export function pctChangeNBack(obs, n) {
  const clean = (obs || []).filter((o) => Number.isFinite(o.v))
  if (clean.length <= n) return null
  const now = clean[0].v
  const then = clean[n].v
  if (!then) return null
  return { date: clean[0].d, value: round(((now - then) / then) * 100, 3) }
}

// ---------- Freshness / staleness ----------
// A number is only "live" while its fetch is younger than maxAgeSec.
// Between 1x and 3x maxAge it is STALE (amber). Past 3x, or errored with no
// data at all, it is DOWN (red). Nothing on screen renders without a badge.

export const SOURCE_MAX_AGE_SEC = {
  fred: 30 * 60,        // daily series; we re-fetch every few minutes
  market: 5 * 60,       // BTC spot
  funding: 10 * 60,
  feargreed: 2 * 60 * 60, // updates daily
  aave: 5 * 60,
  edgar: 8 * 24 * 3600, // weekly cadence by design
  history: 90 * 60,
}

export function freshness(fetchedAtMs, maxAgeSec, nowMs, hasData = true, hasError = false) {
  if (!hasData) return 'down'
  if (!Number.isFinite(fetchedAtMs)) return 'down'
  const age = (nowMs - fetchedAtMs) / 1000
  if (age > maxAgeSec * 3) return 'down'
  if (age > maxAgeSec) return 'stale'
  if (hasError) return 'stale' // data exists but the latest refresh failed
  return 'live'
}

// ---------- "What changed since I last looked" ----------
const DIFF_LABELS = {
  score: 'Pressure score',
  btc: 'BTC',
  ust10y: '10Y',
  curve_2s10s: '2s10s',
  hy_oas: 'HY OAS',
  dollar: 'Dollar idx',
  funding_ann: 'Funding (ann.)',
  fear_greed: 'Fear&Greed',
  dff: 'Fed funds',
  aave_hf: 'Health factor',
}

/**
 * One-line summary comparing two snapshots' metric maps.
 * Ranks moves by |Δ| relative to a per-metric "meaningful move" scale.
 */
export function diffLine(prev, curr) {
  if (!prev || !curr) return null
  const scale = { score: 3, btc: prev.btc ? prev.btc * 0.01 : 500, ust10y: 0.05, curve_2s10s: 0.05, hy_oas: 0.1, dollar: 0.5, funding_ann: 3, fear_greed: 5, dff: 0.05, aave_hf: 0.05 }
  const moves = []
  for (const k of Object.keys(DIFF_LABELS)) {
    const a = prev[k], b = curr[k]
    if (!Number.isFinite(a) || !Number.isFinite(b)) continue
    const d = b - a
    const sig = Math.abs(d) / (scale[k] || 1)
    if (sig >= 1) moves.push({ k, d, sig })
  }
  if (moves.length === 0) return 'Little changed since you last looked.'
  moves.sort((x, y) => y.sig - x.sig)
  const parts = moves.slice(0, 3).map(({ k, d }) => {
    const arrow = d > 0 ? '▲' : '▼'
    const fmt = k === 'btc' ? `$${Math.abs(Math.round(d)).toLocaleString()}` : Math.abs(d).toFixed(2)
    return `${DIFF_LABELS[k]} ${arrow} ${fmt}`
  })
  return `Since you last looked: ${parts.join(' · ')}.`
}

function round(n, dp) {
  const f = 10 ** dp
  return Math.round(n * f) / f
}
