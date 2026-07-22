// Upstream market-data adapters. Design rules:
//   - Parsers are PURE functions over raw upstream payloads → fixture-tested.
//   - Each fetcher throws on any failure; chains try the next source.
//   - Every result names its source so the UI can say where a number came from.
// v1 is keyless: Yahoo (delayed ~15m) → Stooq (EOD) for MSTR;
// Binance → Coinbase → CoinGecko for BTC. A paid key drops in here later.
import { fetchWithTimeout } from './util.mjs'

// MINIMAL user-agent, on purpose. Field-verified on the live deploy: the
// /api/status probes (plain 'Mozilla/5.0') got 200 from Yahoo and Stooq
// while the data path (full fake-Chrome UA) was refused — from a
// datacenter IP, a full browser UA without a browser TLS fingerprint is
// exactly what bot detection flags. Impersonate nothing; be a polite tool.
const UA = { 'user-agent': 'Mozilla/5.0' }

// Per-attempt budget of 3s: Netlify kills synchronous functions at ~10s, so
// an 8s hang on the primary would starve the fallbacks the chain exists for.
async function getJson(url, opts = {}, timeoutMs = 3000) {
  const res = await fetchWithTimeout(url, { ...opts, headers: { ...UA, ...(opts.headers || {}) } }, timeoutMs)
  if (!res.ok) throw new Error(`HTTP ${res.status} from ${new URL(url).host}`)
  return res.json()
}

async function getText(url, timeoutMs = 3000) {
  const res = await fetchWithTimeout(url, { headers: UA }, timeoutMs)
  if (!res.ok) throw new Error(`HTTP ${res.status} from ${new URL(url).host}`)
  return res.text()
}

/* ================= parsers (pure, fixture-tested) ================= */

export function parseYahooChart(raw) {
  const r = raw?.chart?.result?.[0]
  if (!r || !Array.isArray(r.timestamp)) throw new Error('yahoo: malformed chart payload')
  const q = r.indicators?.quote?.[0]
  if (!q) throw new Error('yahoo: missing quote indicators')
  const candles = []
  for (let i = 0; i < r.timestamp.length; i++) {
    const o = q.open?.[i]; const h = q.high?.[i]; const l = q.low?.[i]; const c = q.close?.[i]
    if (![o, h, l, c].every(Number.isFinite)) continue // drop null rows (halts, partial bars)
    candles.push({ t: r.timestamp[i], o, h, l, c, v: Number.isFinite(q.volume?.[i]) ? q.volume[i] : null })
  }
  const meta = r.meta || {}
  let marketState = null
  const reg = meta.currentTradingPeriod?.regular
  if (reg && Number.isFinite(meta.regularMarketTime)) {
    marketState = meta.regularMarketTime >= reg.start && meta.regularMarketTime < reg.end ? 'open' : 'closed'
  }
  return {
    candles,
    price: Number.isFinite(meta.regularMarketPrice) ? meta.regularMarketPrice : null,
    prevClose: Number.isFinite(meta.chartPreviousClose) ? meta.chartPreviousClose
      : Number.isFinite(meta.previousClose) ? meta.previousClose : null,
    dayHigh: Number.isFinite(meta.regularMarketDayHigh) ? meta.regularMarketDayHigh : null,
    dayLow: Number.isFinite(meta.regularMarketDayLow) ? meta.regularMarketDayLow : null,
    marketState,
  }
}

export function parseStooqDaily(csvText) {
  const lines = String(csvText).trim().split('\n')
  if (lines.length < 2 || !lines[0].toLowerCase().startsWith('date,')) throw new Error('stooq: malformed CSV')
  const candles = []
  for (const line of lines.slice(1)) {
    const [date, o, h, l, c, v] = line.split(',')
    const nums = [o, h, l, c].map(Number)
    if (!nums.every(Number.isFinite)) continue
    candles.push({ t: Date.parse(`${date}T00:00:00Z`) / 1000, o: nums[0], h: nums[1], l: nums[2], c: nums[3], v: Number(v) || null })
  }
  if (candles.length === 0) throw new Error('stooq: no rows parsed')
  return { candles }
}

export function parseBinanceKlines(raw) {
  if (!Array.isArray(raw)) throw new Error('binance: malformed klines')
  return raw.map((k) => ({
    t: Math.floor(k[0] / 1000), o: Number(k[1]), h: Number(k[2]), l: Number(k[3]), c: Number(k[4]), v: Number(k[5]),
  })).filter((c) => [c.o, c.h, c.l, c.c].every(Number.isFinite))
}

export function parseBinance24hr(raw) {
  const price = Number(raw?.lastPrice)
  if (!Number.isFinite(price)) throw new Error('binance: malformed 24hr ticker')
  const chg = Number(raw?.priceChangePercent)
  return { price, changePct24h: Number.isFinite(chg) ? chg : null }
}

export function parseCoinbaseCandles(raw) {
  if (!Array.isArray(raw)) throw new Error('coinbase: malformed candles')
  // Coinbase Exchange: [time, low, high, open, close, volume], NEWEST FIRST.
  return raw.map((k) => ({ t: k[0], o: k[3], h: k[2], l: k[1], c: k[4], v: k[5] }))
    .filter((c) => [c.o, c.h, c.l, c.c].every(Number.isFinite))
    .sort((a, b) => a.t - b.t)
}

export function parseCoinbaseSpot(raw) {
  const price = Number(raw?.data?.amount)
  if (!Number.isFinite(price)) throw new Error('coinbase: malformed spot')
  return { price, changePct24h: null }
}

export function parseCoingeckoOhlc(raw) {
  if (!Array.isArray(raw)) throw new Error('coingecko: malformed ohlc')
  return raw.map((k) => ({ t: Math.floor(k[0] / 1000), o: k[1], h: k[2], l: k[3], c: k[4], v: null }))
    .filter((c) => [c.o, c.h, c.l, c.c].every(Number.isFinite))
}

export function parseCoingeckoSimple(raw) {
  const price = raw?.bitcoin?.usd
  if (!Number.isFinite(price)) throw new Error('coingecko: malformed simple price')
  const chg = raw?.bitcoin?.usd_24h_change
  return { price, changePct24h: Number.isFinite(chg) ? chg : null }
}

/* ================= fetchers with fallback chains ================= */

// query1 and query2 are equivalent Yahoo chart mirrors; one sometimes
// rate-limits while the other serves.
const YAHOO_HOSTS = [
  'https://query1.finance.yahoo.com/v8/finance/chart',
  'https://query2.finance.yahoo.com/v8/finance/chart',
]

async function yahooChart(params) {
  const errors = []
  for (const base of YAHOO_HOSTS) {
    try {
      return parseYahooChart(await getJson(`${base}/MSTR?${params}`))
    } catch (e) { errors.push(`${new URL(base).host}: ${e.message}`) }
  }
  throw new Error(`yahoo: ${errors.join(' | ')}`)
}

/** Pure quote assembly from a parsed daily chart — unit-testable.
 *  prevClose comes from the second-to-last daily candle (works both while
 *  the last bar is a live partial and after the close), NOT from
 *  chartPreviousClose, which is the close before the REQUESTED RANGE. */
export function quoteFromChart(parsed) {
  if (parsed.price == null) throw new Error('yahoo: no regularMarketPrice')
  const cs = parsed.candles
  const prevClose = cs.length >= 2 ? cs[cs.length - 2].c : parsed.prevClose
  const last = cs.length ? cs[cs.length - 1] : null
  const changePct = prevClose ? ((parsed.price / prevClose) - 1) * 100 : null
  return {
    symbol: 'MSTR', price: parsed.price, prevClose,
    changePct: changePct == null ? null : Math.round(changePct * 100) / 100,
    dayHigh: parsed.dayHigh ?? last?.h ?? null, dayLow: parsed.dayLow ?? last?.l ?? null,
    marketState: parsed.marketState,
    delayedMin: 15, kind: 'delayed', sourceDetail: 'yahoo',
  }
}

/** MSTR quote: Yahoo daily chart (the exact request shape the /api/status
 *  probe field-verifies) via query1→query2 → Stooq EOD. */
export async function mstrQuote() {
  try {
    return quoteFromChart(await yahooChart('interval=1d&range=5d'))
  } catch (yahooErr) {
    const { candles } = parseStooqDaily(await getText('https://stooq.com/q/d/l/?s=mstr.us&i=d'))
    const last = candles[candles.length - 1]
    const prev = candles[candles.length - 2]
    return {
      symbol: 'MSTR', price: last.c, prevClose: prev?.c ?? null,
      changePct: prev ? Math.round(((last.c / prev.c) - 1) * 10000) / 100 : null,
      dayHigh: last.h, dayLow: last.l, marketState: null,
      delayedMin: null, kind: 'eod', sourceDetail: `stooq (yahoo failed: ${yahooErr.message})`,
    }
  }
}

/** MSTR candles: Yahoo (1d→2y / 30m→60d), query1→query2 → Stooq daily. */
export async function mstrCandles(tf) {
  const cfg = tf === '30m' ? { interval: '30m', range: '60d' } : { interval: '1d', range: '2y' }
  try {
    const { candles } = await yahooChart(`interval=${cfg.interval}&range=${cfg.range}`)
    if (candles.length === 0) throw new Error('yahoo: zero candles')
    return { candles, sourceDetail: 'yahoo' }
  } catch (yahooErr) {
    if (tf === '30m') throw new Error(`intraday unavailable: ${yahooErr.message}`)
    const { candles } = parseStooqDaily(await getText('https://stooq.com/q/d/l/?s=mstr.us&i=d'))
    return { candles: candles.slice(-730), sourceDetail: `stooq (yahoo failed: ${yahooErr.message})` }
  }
}

/** BTC spot: Binance → Coinbase → CoinGecko. */
export async function btcSpot() {
  const chain = [
    async () => ({ ...parseBinance24hr(await getJson('https://api.binance.com/api/v3/ticker/24hr?symbol=BTCUSDT')), sourceDetail: 'binance' }),
    async () => ({ ...parseCoinbaseSpot(await getJson('https://api.coinbase.com/v2/prices/BTC-USD/spot')), sourceDetail: 'coinbase' }),
    async () => ({ ...parseCoingeckoSimple(await getJson('https://api.coingecko.com/api/v3/simple/price?ids=bitcoin&vs_currencies=usd&include_24hr_change=true')), sourceDetail: 'coingecko' }),
  ]
  return tryChain(chain, 'btc spot')
}

/** BTC candles: Binance klines → Coinbase. CoinGecko is deliberately NOT a
 *  daily fallback: its /ohlc auto-granularity serves 4-DAY candles for long
 *  ranges, and 4-day bars labeled '1d' would silently poison the BTC regime
 *  read. For 30m only, days=1 keeps it in the true 30-minute tier. */
export async function btcCandles(tf) {
  const isDay = tf !== '30m'
  const chain = [
    async () => ({
      candles: parseBinanceKlines(await getJson(
        `https://api.binance.com/api/v3/klines?symbol=BTCUSDT&interval=${isDay ? '1d' : '30m'}&limit=${isDay ? 730 : 500}`)),
      sourceDetail: 'binance',
    }),
    async () => ({
      candles: parseCoinbaseCandles(await getJson(
        `https://api.exchange.coinbase.com/products/BTC-USD/candles?granularity=${isDay ? 86400 : 1800}`)),
      sourceDetail: 'coinbase',
    }),
    ...(!isDay ? [async () => ({
      candles: parseCoingeckoOhlc(await getJson(
        'https://api.coingecko.com/api/v3/coins/bitcoin/ohlc?vs_currency=usd&days=1')),
      sourceDetail: 'coingecko (no volume, 30m tier)',
    })] : []),
  ]
  const out = await tryChain(chain, 'btc candles')
  if (!out.candles?.length) throw new Error('btc candles: all sources empty')
  return out
}

async function tryChain(fns, what) {
  const errors = []
  for (const fn of fns) {
    try { return await fn() } catch (e) { errors.push(e.message) }
  }
  throw new Error(`${what}: all sources failed — ${errors.join(' | ')}`)
}
