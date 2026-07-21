// The risk engine — position sizing and stop discipline. Everything is
// measured in R: one R = the dollars you lose if the initial stop is hit.
// Pure functions, no imports; guard and return error codes, never throw.

/**
 * Shares to buy so a stop hit loses exactly riskPct of equity — then capped
 * so the position never exceeds maxPositionPct of equity. When the cap bites,
 * riskUsd is recomputed to the EFFECTIVE risk of the capped share count.
 */
export function sizePosition({ equity, riskPct, entry, stop, maxPositionPct = 30 }) {
  const bad = (error) => ({ ok: false, error, shares: 0, riskUsd: null, perShareRisk: null, positionUsd: null, positionPct: null, capped: false })
  if (![equity, riskPct, entry, stop, maxPositionPct].every(Number.isFinite)) return bad('bad_input')
  if (equity <= 0 || riskPct <= 0 || entry <= 0 || maxPositionPct <= 0) return bad('bad_input')
  const perShareRisk = entry - stop
  if (perShareRisk <= 0) return bad('stop_not_below_entry')
  let shares = Math.floor((equity * riskPct / 100) / perShareRisk)
  let capped = false
  const maxUsd = equity * maxPositionPct / 100
  if (shares * entry > maxUsd) {
    shares = Math.floor(maxUsd / entry)
    capped = true
  }
  if (shares <= 0) return { ...bad('risk_too_small_for_one_share'), capped }
  const riskUsd = round2(shares * perShareRisk)
  return {
    ok: true,
    error: null,
    shares,
    riskUsd,
    perShareRisk: round2(perShareRisk),
    positionUsd: round2(shares * entry),
    positionPct: round2((shares * entry / equity) * 100),
    capped,
  }
}

/**
 * Initial stop under one of three modes. Structure mode sits the stop just
 * under the last swing low (padded by a fraction of ATR) so a wick can't
 * tag it; ATR mode adapts to MSTR's volatility so "tight in R" doesn't
 * mean "inside the noise".
 */
export function initialStop({ mode, entry, atr, atrMult = 2.5, swingLow, padAtr = 0.25, pct = 8 }) {
  const out = (stop, detail, warning = null) => ({ stop, basis: mode, detail, warning })
  if (!Number.isFinite(entry) || entry <= 0) return out(null, 'no entry price', 'bad_input')
  let stop = null
  let detail = ''
  if (mode === 'atr') {
    if (!Number.isFinite(atr) || atr <= 0) return out(null, 'ATR unavailable', 'no_atr')
    stop = entry - atrMult * atr
    detail = `${atrMult}×ATR(${round2(atr)}) below ${round2(entry)}`
  } else if (mode === 'structure') {
    if (!Number.isFinite(swingLow) || !Number.isFinite(atr) || atr <= 0) return out(null, 'no confirmed swing low / ATR', 'no_structure')
    stop = swingLow - padAtr * atr
    detail = `swing low ${round2(swingLow)} minus ${padAtr}×ATR pad`
  } else if (mode === 'percent') {
    if (!Number.isFinite(pct) || pct <= 0 || pct >= 100) return out(null, 'bad percent', 'bad_input')
    stop = entry * (1 - pct / 100)
    detail = `${pct}% below ${round2(entry)}`
  } else {
    return out(null, `unknown mode ${mode}`, 'bad_input')
  }
  stop = round2(stop)
  if (stop >= entry) return out(null, detail, 'stop_not_below_entry')
  return out(stop, detail)
}

/**
 * Anchored chandelier trail: highest high SINCE ENTRY minus mult×ATR,
 * ratcheted so it never moves down. Returns an array aligned to
 * candles.slice(entryIdx). While ATR is unseeded, the initial stop carries.
 * This is the "ride the way up" mechanism — the stop only ever rises.
 */
export function anchoredChandelier(candles, { entryIdx, atrPeriod = 22, mult = 3, initialStop }) {
  if (!Array.isArray(candles) || entryIdx == null || entryIdx < 0 || entryIdx >= candles.length) return []
  const atrArr = wilderAtr(candles, atrPeriod)
  const out = []
  let hh = -Infinity
  let prev = Number.isFinite(initialStop) ? initialStop : -Infinity
  for (let i = entryIdx; i < candles.length; i++) {
    hh = Math.max(hh, candles[i].h)
    const a = atrArr[i]
    let next = prev
    if (a != null) next = Math.max(prev, hh - mult * a)
    prev = next
    out.push(Number.isFinite(next) ? round2(next) : null)
  }
  return out
}

/**
 * The stop that actually governs right now: the max of initial stop, trail,
 * and breakeven (entry) once price has paid you beAtR × initial risk.
 */
export function effectiveStop({ initialStop, trailStop, entry, beAtR = 1, highestCloseSinceEntry }) {
  const candidates = []
  if (Number.isFinite(initialStop)) candidates.push(initialStop)
  if (Number.isFinite(trailStop)) candidates.push(trailStop)
  if (
    Number.isFinite(entry) && Number.isFinite(initialStop) && Number.isFinite(highestCloseSinceEntry) &&
    entry - initialStop > 0 &&
    // float-noise epsilon only: a raw compare misses the exact +1R boundary
    // by one ULP, but rounding both sides to cents would arm breakeven up to
    // half a cent EARLY — the epsilon fixes the former without the latter
    highestCloseSinceEntry >= entry + beAtR * (entry - initialStop) - 1e-9
  ) {
    candidates.push(entry)
  }
  if (candidates.length === 0) return null
  return round2(Math.max(...candidates))
}

/** R multiple vs INITIAL risk. Null when risk per share isn't positive. */
export function rMultiple({ entry, initialStop, price }) {
  if (![entry, initialStop, price].every(Number.isFinite)) return null
  const perShare = entry - initialStop
  if (perShare <= 0) return null
  return (price - entry) / perShare
}

/** Blend lots [{shares, entry}] into total shares + average entry. */
export function blendLots(lots) {
  if (!Array.isArray(lots) || lots.length === 0) return { shares: 0, avgEntry: null }
  let shares = 0
  let cost = 0
  for (const lot of lots) {
    if (!Number.isFinite(lot?.shares) || !Number.isFinite(lot?.entry) || lot.shares <= 0) continue
    shares += lot.shares
    cost += lot.shares * lot.entry
  }
  if (shares === 0) return { shares: 0, avgEntry: null }
  return { shares, avgEntry: round2(cost / shares) }
}

// Local Wilder ATR so risk.js stays import-free (contract: imports nothing).
function wilderAtr(candles, period) {
  const out = new Array(candles.length).fill(null)
  if (candles.length < period) return out
  const tr = candles.map((cd, i) => {
    if (i === 0) return cd.h - cd.l
    const pc = candles[i - 1].c
    return Math.max(cd.h - cd.l, Math.abs(cd.h - pc), Math.abs(cd.l - pc))
  })
  let seed = 0
  for (let i = 0; i < period; i++) seed += tr[i]
  out[period - 1] = seed / period
  for (let i = period; i < candles.length; i++) {
    out[i] = (out[i - 1] * (period - 1) + tr[i]) / period
  }
  return out
}

function round2(x) { return Math.round(x * 100) / 100 }
