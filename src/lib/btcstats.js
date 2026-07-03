// Historical context math over daily BTC closes. Input shape:
// prices = [[tsMillis, priceUsd], ...] ascending. All outputs rounded,
// null when there isn't enough history — never a guess.
export function movingAverage(prices, n) {
  if (!Array.isArray(prices) || prices.length < n) return null
  const tail = prices.slice(-n)
  const sum = tail.reduce((a, [, p]) => a + p, 0)
  return round(sum / n, 0)
}

export function distFromMAPct(prices, n) {
  const ma = movingAverage(prices, n)
  const last = lastPrice(prices)
  if (ma == null || last == null || ma === 0) return null
  return round(((last - ma) / ma) * 100, 1)
}

export function highOverWindow(prices, n) {
  if (!Array.isArray(prices) || prices.length === 0) return null
  const tail = prices.slice(-n)
  return round(Math.max(...tail.map(([, p]) => p)), 0)
}

// Negative number: how far below the window high the last price sits.
export function drawdownFromHighPct(prices, n = 365) {
  const hi = highOverWindow(prices, n)
  const last = lastPrice(prices)
  if (hi == null || last == null || hi === 0) return null
  return round(((last - hi) / hi) * 100, 1)
}

// Annualized realized volatility from daily log returns, in percent.
export function realizedVolPct(prices, n = 30) {
  if (!Array.isArray(prices) || prices.length < n + 1) return null
  const tail = prices.slice(-(n + 1)).map(([, p]) => p)
  const rets = []
  for (let i = 1; i < tail.length; i++) rets.push(Math.log(tail[i] / tail[i - 1]))
  const mean = rets.reduce((a, b) => a + b, 0) / rets.length
  const variance = rets.reduce((a, b) => a + (b - mean) ** 2, 0) / (rets.length - 1)
  return round(Math.sqrt(variance) * Math.sqrt(365) * 100, 1)
}

export function lastPrice(prices) {
  if (!Array.isArray(prices) || prices.length === 0) return null
  const p = prices[prices.length - 1][1]
  return Number.isFinite(p) ? p : null
}

export function computeBtcStats(prices) {
  return {
    last: lastPrice(prices),
    ma50: movingAverage(prices, 50),
    ma200: movingAverage(prices, 200),
    distFromMA200Pct: distFromMAPct(prices, 200),
    high365: highOverWindow(prices, 365),
    drawdownFromHighPct: drawdownFromHighPct(prices, 365),
    realizedVol30Pct: realizedVolPct(prices, 30),
    days: Array.isArray(prices) ? prices.length : 0,
  }
}

function round(v, dp) { const k = 10 ** dp; return Math.round(v * k) / k }
