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
 * REQUIRES day-aligned, equal-length inputs (use alignByDay): head-pairing
 * two different-length series would regress unrelated days into a
 * plausible-looking garbage beta, so unequal lengths are refused outright.
 */
export function rollingBeta(mstrCloses, btcCloses, window = 30) {
  if ((mstrCloses?.length ?? 0) !== (btcCloses?.length ?? 0)) {
    return { latest: null, series: [], warning: 'unaligned_series' }
  }
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
 * Approximate mNAV history: today's share count and BTC holdings applied
 * across day-aligned close series. Both inputs CHANGE over time (ATM raises,
 * BTC buys), so this is shape-not-gospel — label it that way. It answers
 * one question well: is today's premium high or low vs the recent past?
 */
export function mNavSeries(mstrCloses, btcCloses, { sharesOutstanding, btcHoldings }) {
  const n = Math.min(mstrCloses?.length ?? 0, btcCloses?.length ?? 0)
  if (n === 0 || !(sharesOutstanding > 0) || !(btcHoldings > 0)) {
    return { series: [], min: null, max: null, latest: null }
  }
  const series = []
  for (let i = 0; i < n; i++) {
    const m = mstrCloses[i]
    const b = btcCloses[i]
    series.push(m > 0 && b > 0 ? Math.round(((m * sharesOutstanding) / (b * btcHoldings)) * 1000) / 1000 : null)
  }
  const vals = series.filter((x) => x != null)
  if (!vals.length) return { series, min: null, max: null, latest: null }
  return {
    series,
    min: Math.min(...vals),
    max: Math.max(...vals),
    latest: vals[vals.length - 1],
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
  const raw = beta / mNav // grade on the unrounded quotient; round for display
  const grade = raw > 1.1 ? 'efficient' : raw >= 0.9 ? 'fair' : 'rich'
  const text = `1% BTC move ≈ ${r2(beta)}% MSTR; you pay ${r2(mNav)}× NAV for it (${grade})`
  return { grade, ratio: r2(raw), text }
}

function r2(x) { return Math.round(x * 100) / 100 }
