// Deterministic test fixtures — NO Math.random() anywhere in tests.
// All candle arrays are oldest→newest, t in unix SECONDS, daily spacing.

const DAY = 86400
export const BASE_T = Date.UTC(2025, 0, 6) / 1000 // Mon 2025-01-06, deterministic

// mulberry32 — tiny deterministic PRNG
export function mulberry32(seed) {
  let a = seed >>> 0
  return function () {
    a |= 0; a = (a + 0x6D2B79F5) | 0
    let t = Math.imul(a ^ (a >>> 15), 1 | a)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

/**
 * Random-walk candles with drift. driftPct/volPct are per-bar percentages.
 * OHLC is self-consistent: h >= max(o,c), l <= min(o,c), all > 0.
 */
export function genCandles({ n, start = 100, driftPct = 0, volPct = 2, seed = 42, startT = BASE_T, volume = 1e6 }) {
  const rnd = mulberry32(seed)
  const out = []
  let prevClose = start
  for (let i = 0; i < n; i++) {
    const o = prevClose
    const shock = (rnd() * 2 - 1) * volPct
    const c = Math.max(0.01, o * (1 + (driftPct + shock) / 100))
    const hi = Math.max(o, c) * (1 + rnd() * volPct * 0.4 / 100)
    const lo = Math.min(o, c) * (1 - rnd() * volPct * 0.4 / 100)
    out.push({ t: startT + i * DAY, o: r2(o), h: r2(hi), l: r2(lo), c: r2(c), v: Math.round(volume * (0.6 + rnd() * 0.8)) })
    prevClose = c
  }
  return out
}

/** Build exact candles from a list of closes — for engineering precise signal scenarios. */
export function candlesFromCloses(closes, { spreadPct = 0.8, startT = BASE_T, volume = 1e6 } = {}) {
  return closes.map((c, i) => {
    const o = i === 0 ? c : closes[i - 1]
    const h = Math.max(o, c) * (1 + spreadPct / 100)
    const l = Math.min(o, c) * (1 - spreadPct / 100)
    return { t: startT + i * DAY, o: r2(o), h: r2(h), l: r2(l), c: r2(c), v: volume }
  })
}

/** Override individual candles after generation: patchCandles(cs, {5: {l: 90}, ...}) */
export function patchCandles(candles, patches) {
  return candles.map((cd, i) => (patches[i] ? { ...cd, ...patches[i] } : cd))
}

export const trendUp = (n = 120, seed = 7) => genCandles({ n, driftPct: 0.9, volPct: 1.6, seed })
export const trendDown = (n = 120, seed = 8) => genCandles({ n, driftPct: -0.9, volPct: 1.6, seed })
export const choppy = (n = 120, seed = 9) => genCandles({ n, driftPct: 0, volPct: 2.4, seed })
export const whipsaw = (n = 120, seed = 10) => genCandles({ n, driftPct: 0.1, volPct: 4.5, seed })

function r2(x) { return Math.round(x * 100) / 100 }

/* ---------------- Captured upstream response shapes ----------------
   Minimal but structurally faithful. Parser tests run against these. */

export const YAHOO_CHART_SAMPLE = {
  chart: {
    result: [{
      meta: {
        currency: 'USD', symbol: 'MSTR', exchangeName: 'NMS', instrumentType: 'EQUITY',
        regularMarketPrice: 412.35, chartPreviousClose: 405.1, previousClose: 405.1,
        regularMarketDayHigh: 419.8, regularMarketDayLow: 401.55, regularMarketVolume: 12345678,
        regularMarketTime: 1752853800, gmtoffset: -14400, timezone: 'EDT',
        currentTradingPeriod: {
          pre: { start: 1752825600, end: 1752845400 },
          regular: { start: 1752845400, end: 1752868800 },
          post: { start: 1752868800, end: 1752883200 },
        },
      },
      timestamp: [1752585000, 1752671400, 1752757800],
      indicators: {
        quote: [{
          open: [398.2, 401.0, 406.6],
          high: [403.9, 408.8, 419.8],
          low: [395.1, 399.6, 401.55],
          close: [401.0, 406.6, 412.35],
          volume: [10111213, 11121314, 12131415],
        }],
      },
    }],
    error: null,
  },
}

export const YAHOO_CHART_WITH_NULLS = JSON.parse(JSON.stringify(YAHOO_CHART_SAMPLE))
YAHOO_CHART_WITH_NULLS.chart.result[0].timestamp.push(1752844200)
YAHOO_CHART_WITH_NULLS.chart.result[0].indicators.quote[0].open.push(null)
YAHOO_CHART_WITH_NULLS.chart.result[0].indicators.quote[0].high.push(null)
YAHOO_CHART_WITH_NULLS.chart.result[0].indicators.quote[0].low.push(null)
YAHOO_CHART_WITH_NULLS.chart.result[0].indicators.quote[0].close.push(null)
YAHOO_CHART_WITH_NULLS.chart.result[0].indicators.quote[0].volume.push(null)

export const STOOQ_CSV_SAMPLE = `Date,Open,High,Low,Close,Volume
2026-07-16,398.2,403.9,395.1,401.0,10111213
2026-07-17,401.0,408.8,399.6,406.6,11121314
2026-07-18,406.6,419.8,401.55,412.35,12131415`

// [openTime(ms), open, high, low, close, volume, closeTime, quoteVol, trades, takerBase, takerQuote, ignore]
export const BINANCE_KLINES_SAMPLE = [
  [1752537600000, '117000.00', '119200.00', '116500.00', '118100.00', '12345.678', 1752623999999, '1.4e9', 234567, '6000.1', '7.1e8', '0'],
  [1752624000000, '118100.00', '119800.00', '117300.00', '118900.00', '11222.333', 1752710399999, '1.3e9', 223344, '5500.2', '6.5e8', '0'],
]

export const BINANCE_24HR_SAMPLE = {
  symbol: 'BTCUSDT', priceChange: '2480.00', priceChangePercent: '2.145',
  lastPrice: '118423.50', highPrice: '119800.00', lowPrice: '115600.00', volume: '23456.789',
}

// Coinbase Exchange candles: [time(sec), low, high, open, close, volume] — NEWEST FIRST
export const COINBASE_CANDLES_SAMPLE = [
  [1752624000, 117300.0, 119800.0, 118100.0, 118900.0, 4321.5],
  [1752537600, 116500.0, 119200.0, 117000.0, 118100.0, 5432.1],
]

export const COINBASE_SPOT_SAMPLE = { data: { base: 'BTC', currency: 'USD', amount: '118423.45' } }

// CoinGecko OHLC: [[ms, o, h, l, c], ...] — no volume
export const COINGECKO_OHLC_SAMPLE = [
  [1752537600000, 117000.0, 119200.0, 116500.0, 118100.0],
  [1752624000000, 118100.0, 119800.0, 117300.0, 118900.0],
]

export const COINGECKO_SIMPLE_SAMPLE = { bitcoin: { usd: 118423, usd_24h_change: 2.11 } }
