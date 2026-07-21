// The leverage-truth module: is MSTR actually giving you extra BTC torque
// right now, and what premium are you paying for it? Pure math, no imports.

/** Match two candle arrays on UTC date; only days present in BOTH survive
 *  (BTC trades 7 days a week, MSTR 5 — never regress beta on ghost days). */
export function alignByDay(candlesA, candlesB) {
  const dayOf = (t) => new Date(t * 1000).toISOString().slice(0, 10)
  const mapB = new Map()
  for (const c of candlesB || []) mapB.set(dayOf(c.t), c.c)
  const a = []
  const b = []
  const days = []
  for (const c of candlesA || []) {
    const d = dayOf(c.t)
    if (mapB.has(d)) {
      a.push(c.c)
      b.push(mapB.get(d))
      days.push(d)
    }
  }
  return { a, b, days }
}

/** Daily log returns; one element shorter than input. */
export function dailyLogReturns(closes) {
  const out = []
  for (let i = 1; i < (closes?.length ?? 0); i++) {
    if (closes[i] > 0 && closes[i - 1] > 0) out.push(Math.log(closes[i] / closes[i - 1]))
    else out.push(null)
  }
  return out
}

/**
 * Rolling beta of MSTR on BTC over a trailing window of log returns.
 * series[i] is the beta of the window ENDING at return i (null until seeded).
 */
export function rollingBeta(mstrCloses, btcCloses, window = 30) {
  const rm = dailyLogReturns(mstrCloses)
  const rb = dailyLogReturns(btcCloses)
  const n = Math.min(rm.length, rb.length)
  if (n < window) return { latest: null, series: [] }
  const series = new Array(n).fill(null)
  for (let i = window - 1; i < n; i++) {
    let sa = 0; let sb = 0; let saa = 0; let sab = 0
    let ok = true
    for (let k = i - window + 1; k <= i; k++) {
      if (rm[k] == null || rb[k] == null) { ok = false; break }
      sa += rb[k]; sb += rm[k]; saa += rb[k] * rb[k]; sab += rb[k] * rm[k]
    }
    if (!ok) continue
    const varB = saa / window - (sa / window) ** 2
    if (varB === 0) continue
    const cov = sab / window - (sa / window) * (sb / window)
    series[i] = cov / varB
  }
  let latest = null
  for (let i = series.length - 1; i >= 0; i--) if (series[i] != null) { latest = series[i]; break }
  return { latest, series }
}

/** n-day rate-of-change comparison, in percentage points. */
export function relativeStrength(mstrCloses, btcCloses, n = 20) {
  const rocOf = (xs) => {
    const len = xs?.length ?? 0
    if (len < n + 1 || !(xs[len - 1 - n] > 0)) return null
    return ((xs[len - 1] / xs[len - 1 - n]) - 1) * 100
  }
  const mstrRocPct = rocOf(mstrCloses)
  const btcRocPct = rocOf(btcCloses)
  const spreadPct = mstrRocPct != null && btcRocPct != null ? mstrRocPct - btcRocPct : null
  return { mstrRocPct, btcRocPct, spreadPct }
}

/**
 * mNAV — market cap over the value of the BTC stack. impliedBtcPrice is the
 * headline honesty stat: the BTC price you're effectively paying via MSTR.
 */
export function mNav({ price, sharesOutstanding, btcHoldings, btcPrice }) {
  const nulls = { marketCap: null, btcNavUsd: null, mNav: null, premiumPct: null, btcPerShare: null, impliedBtcPrice: null }
  if (![price, sharesOutstanding, btcHoldings, btcPrice].every((x) => Number.isFinite(x) && x > 0)) return nulls
  const marketCap = price * sharesOutstanding
  const btcNavUsd = btcHoldings * btcPrice
  const ratio = marketCap / btcNavUsd
  return {
    marketCap,
    btcNavUsd,
    mNav: r2(ratio),
    premiumPct: r2((ratio - 1) * 100),
    btcPerShare: btcHoldings / sharesOutstanding,
    impliedBtcPrice: Math.round(marketCap / btcHoldings),
  }
}

/**
 * Are you getting more move than premium you're paying? ratio = beta/mNAV.
 * >1.1 efficient · 0.9–1.1 fair · <0.9 rich.
 */
export function torqueRead({ beta, mNav }) {
  if (!Number.isFinite(beta) || !Number.isFinite(mNav) || mNav <= 0) {
    return { grade: 'unknown', ratio: null, text: 'torque unknown — beta or mNAV unavailable' }
  }
  const ratio = r2(beta / mNav)
  const grade = ratio > 1.1 ? 'efficient' : ratio >= 0.9 ? 'fair' : 'rich'
  const text = `1% BTC move ≈ ${r2(beta)}% MSTR; you pay ${r2(mNav)}× NAV for it (${grade})`
  return { grade, ratio, text }
}

function r2(x) { return Math.round(x * 100) / 100 }
