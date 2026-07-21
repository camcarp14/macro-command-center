// Technical-analysis primitives. Pure functions over candle arrays
// [{t, o, h, l, c, v}], oldest→newest, t in unix seconds. Arrays returned
// are aligned to the input; unseeded leading values are null. Nothing here
// throws on short/empty input — callers get nulls and decide.

/** Simple moving average; null until period-1 values seed it. */
export function sma(values, period) {
  const out = new Array(values.length).fill(null)
  if (!Number.isFinite(period) || period <= 0) return out
  let sum = 0
  for (let i = 0; i < values.length; i++) {
    sum += values[i]
    if (i >= period) sum -= values[i - period]
    if (i >= period - 1) out[i] = sum / period
  }
  return out
}

/** Exponential moving average seeded with the SMA at index period-1. */
export function ema(values, period) {
  const out = new Array(values.length).fill(null)
  if (!Number.isFinite(period) || period <= 0 || values.length < period) return out
  let seed = 0
  for (let i = 0; i < period; i++) seed += values[i]
  seed /= period
  out[period - 1] = seed
  const k = 2 / (period + 1)
  for (let i = period; i < values.length; i++) {
    out[i] = values[i] * k + out[i - 1] * (1 - k)
  }
  return out
}

/** Wilder RSI over closes; null until the first period changes seed it. */
export function rsi(closes, period = 14) {
  const out = new Array(closes.length).fill(null)
  if (closes.length < period + 1) return out
  let gain = 0
  let loss = 0
  for (let i = 1; i <= period; i++) {
    const d = closes[i] - closes[i - 1]
    if (d >= 0) gain += d
    else loss -= d
  }
  let avgGain = gain / period
  let avgLoss = loss / period
  out[period] = avgLoss === 0 ? 100 : 100 - 100 / (1 + avgGain / avgLoss)
  for (let i = period + 1; i < closes.length; i++) {
    const d = closes[i] - closes[i - 1]
    avgGain = (avgGain * (period - 1) + Math.max(d, 0)) / period
    avgLoss = (avgLoss * (period - 1) + Math.max(-d, 0)) / period
    out[i] = avgLoss === 0 ? 100 : 100 - 100 / (1 + avgGain / avgLoss)
  }
  return out
}

/** Wilder ATR. TR at index 0 is h-l (no previous close exists). */
export function atr(candles, period = 14) {
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

/** Rate of change in percent over n bars; null for i < n. */
export function roc(values, n) {
  const out = new Array(values.length).fill(null)
  for (let i = n; i < values.length; i++) {
    if (values[i - n] !== 0 && values[i - n] != null && values[i] != null) {
      out[i] = ((values[i] / values[i - n]) - 1) * 100
    }
  }
  return out
}

/** Percent-per-bar slope between the last value and the value n back. Null-safe. */
export function slopePct(values, n) {
  const len = values.length
  if (len < n + 1) return null
  const a = values[len - 1 - n]
  const b = values[len - 1]
  if (a == null || b == null || a === 0) return null
  return ((b / a) - 1) * 100 / n
}

/** Max high over the n bars ending at endIdx (inclusive); null if out of range. */
export function highestHigh(candles, n, endIdx = candles.length - 1) {
  if (n <= 0 || endIdx >= candles.length || endIdx - n + 1 < 0) return null
  let hh = -Infinity
  for (let i = endIdx - n + 1; i <= endIdx; i++) hh = Math.max(hh, candles[i].h)
  return hh
}

/** Min low over the n bars ending at endIdx (inclusive); null if out of range. */
export function lowestLow(candles, n, endIdx = candles.length - 1) {
  if (n <= 0 || endIdx >= candles.length || endIdx - n + 1 < 0) return null
  let ll = Infinity
  for (let i = endIdx - n + 1; i <= endIdx; i++) ll = Math.min(ll, candles[i].l)
  return ll
}

/**
 * Confirmed fractal pivots: a pivot high at i needs h[i] strictly greater
 * than the highs of `strength` bars on BOTH sides (ties reject), so the
 * last `strength` bars can never confirm a pivot — that's the honesty.
 */
export function swings(candles, strength = 2) {
  const highs = []
  const lows = []
  for (let i = strength; i <= candles.length - 1 - strength; i++) {
    let isHigh = true
    let isLow = true
    for (let k = 1; k <= strength; k++) {
      if (candles[i].h <= candles[i - k].h || candles[i].h <= candles[i + k].h) isHigh = false
      if (candles[i].l >= candles[i - k].l || candles[i].l >= candles[i + k].l) isLow = false
      if (!isHigh && !isLow) break
    }
    if (isHigh) highs.push({ i, price: candles[i].h })
    if (isLow) lows.push({ i, price: candles[i].l })
  }
  return { highs, lows }
}
