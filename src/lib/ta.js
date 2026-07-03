// Intraday technical analysis over OHLCV candles. Pure functions, no I/O.
// Candle shape: { t: unixSeconds, o, h, l, c, v }. All series ascending by t.
// Same discipline as everywhere else: not enough data → null, never a guess.

export function ema(values, period) {
  if (!Array.isArray(values) || values.length < period) return []
  const k = 2 / (period + 1)
  const out = new Array(values.length).fill(null)
  let prev = values.slice(0, period).reduce((a, b) => a + b, 0) / period
  out[period - 1] = prev
  for (let i = period; i < values.length; i++) {
    prev = values[i] * k + prev * (1 - k)
    out[i] = prev
  }
  return out
}

export function rsi(closes, period = 14) {
  if (!Array.isArray(closes) || closes.length < period + 1) return []
  const out = new Array(closes.length).fill(null)
  let gain = 0, loss = 0
  for (let i = 1; i <= period; i++) {
    const d = closes[i] - closes[i - 1]
    if (d >= 0) gain += d; else loss -= d
  }
  let avgG = gain / period, avgL = loss / period
  out[period] = avgL === 0 ? 100 : 100 - 100 / (1 + avgG / avgL)
  for (let i = period + 1; i < closes.length; i++) {
    const d = closes[i] - closes[i - 1]
    avgG = (avgG * (period - 1) + Math.max(d, 0)) / period
    avgL = (avgL * (period - 1) + Math.max(-d, 0)) / period
    out[i] = avgL === 0 ? 100 : 100 - 100 / (1 + avgG / avgL)
  }
  return out
}

export function atr(candles, period = 14) {
  if (!Array.isArray(candles) || candles.length < period + 1) return []
  const trs = candles.map((c, i) => {
    if (i === 0) return c.h - c.l
    const pc = candles[i - 1].c
    return Math.max(c.h - c.l, Math.abs(c.h - pc), Math.abs(c.l - pc))
  })
  const out = new Array(candles.length).fill(null)
  let prev = trs.slice(1, period + 1).reduce((a, b) => a + b, 0) / period
  out[period] = prev
  for (let i = period + 1; i < candles.length; i++) {
    prev = (prev * (period - 1) + trs[i]) / period
    out[i] = prev
  }
  return out
}

// VWAP anchored to each UTC day boundary — the classic session VWAP.
export function vwapDaily(candles) {
  if (!Array.isArray(candles)) return []
  const out = []
  let day = null, cumPV = 0, cumV = 0
  for (const c of candles) {
    const d = Math.floor(c.t / 86400)
    if (d !== day) { day = d; cumPV = 0; cumV = 0 }
    const typical = (c.h + c.l + c.c) / 3
    cumPV += typical * (c.v || 0)
    cumV += c.v || 0
    out.push(cumV > 0 ? cumPV / cumV : c.c)
  }
  return out
}

// Aggregate consecutive candles by an integer factor (e.g. 1m → 3m).
export function aggregateCandles(candles, factor) {
  if (!Array.isArray(candles) || factor <= 1) return candles || []
  const out = []
  for (let i = 0; i + factor <= candles.length; i += factor) {
    const grp = candles.slice(i, i + factor)
    out.push({
      t: grp[0].t,
      o: grp[0].o,
      h: Math.max(...grp.map((c) => c.h)),
      l: Math.min(...grp.map((c) => c.l)),
      c: grp[grp.length - 1].c,
      v: grp.reduce((a, c) => a + (c.v || 0), 0),
    })
  }
  return out
}

// Transparent regime classification on one timeframe. Rules, not vibes:
//   TRENDING UP:   price > session VWAP, EMA9 > EMA21 > EMA50,
//                  and EMA9–EMA21 separation > 0.15 × ATR (real spread, not noise)
//   TRENDING DOWN: the mirror image
//   CHOP:          everything else — the state where short-timeframe entries
//                  historically bleed fees.
export function regimeRead(candles) {
  const closes = (candles || []).map((c) => c.c)
  if (closes.length < 60) return { state: 'INSUFFICIENT DATA', tone: 'sync', plain: `Only ${closes.length} candles loaded — need 60+ for a regime read.` }
  const e9 = ema(closes, 9), e21 = ema(closes, 21), e50 = ema(closes, 50)
  const a = atr(candles, 14), vw = vwapDaily(candles)
  const i = closes.length - 1
  const [c, x9, x21, x50, at, vwp] = [closes[i], e9[i], e21[i], e50[i], a[i], vw[i]]
  if (![c, x9, x21, x50, at, vwp].every(Number.isFinite)) return { state: 'INSUFFICIENT DATA', tone: 'sync', plain: 'Indicators still warming up on this timeframe.' }
  const sep = Math.abs(x9 - x21)
  const detail = { close: c, ema9: x9, ema21: x21, ema50: x50, atr: at, vwap: vwp, sepVsAtr: +(sep / at).toFixed(2) }
  if (c > vwp && x9 > x21 && x21 > x50 && sep > 0.15 * at) {
    return { state: 'TRENDING UP', tone: 'live', detail, plain: `Price is above session VWAP with EMAs stacked bullishly (9>21>50) and real separation (${detail.sepVsAtr}× ATR). Trend-following conditions on this timeframe.` }
  }
  if (c < vwp && x9 < x21 && x21 < x50 && sep > 0.15 * at) {
    return { state: 'TRENDING DOWN', tone: 'down', detail, plain: `Price is below session VWAP with EMAs stacked bearishly (9<21<50) and real separation (${detail.sepVsAtr}× ATR). Downtrend conditions on this timeframe.` }
  }
  return { state: 'CHOP', tone: 'stale', detail, plain: `EMAs are tangled or price is fighting VWAP — no directional alignment. Chop is where short-timeframe entries historically bleed fees; many disciplined intraday traders simply stand aside here.` }
}

// Which hours actually move: average (high−low)/close per hour-of-day across
// the sample. This is measurement of the recent past, not a promise about
// tomorrow — but volatility clustering by session is one of the most stable
// intraday regularities in BTC.
export function hourlyActivity(candles) {
  if (!Array.isArray(candles) || candles.length < 50) return []
  const buckets = new Map()
  for (const c of candles) {
    const hr = Math.floor((c.t % 86400) / 3600)
    const range = c.c ? (c.h - c.l) / c.c : 0
    const b = buckets.get(hr) || { sum: 0, n: 0 }
    b.sum += range; b.n += 1
    buckets.set(hr, b)
  }
  const rows = [...buckets.entries()].map(([hourUtc, b]) => ({ hourUtc, avgRangePct: +((b.sum / b.n) * 100).toFixed(3), samples: b.n }))
  const max = Math.max(...rows.map((r) => r.avgRangePct)) || 1
  return rows.map((r) => ({ ...r, rel: +(r.avgRangePct / max).toFixed(2) })).sort((a, b) => a.hourUtc - b.hourUtc)
}
