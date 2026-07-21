// Deterministic API mocks for hermetic e2e. The scenario data is built with
// the SAME fixture generators and engine libs the unit tests use, so the
// expected numbers are computed, never hardcoded.
import { genCandles, candlesFromCloses, patchCandles } from '../tests/fixtures.js'
import { ema } from '../src/lib/ta.js'

export const SETTINGS = {
  equity: 100000, riskPct: 1, maxPositionPct: 30, stopMode: 'atr', atrMult: 2.5, stopPct: 8,
  chandelierPeriod: 22, chandelierMult: 3, beAtR: 1, addRiskFraction: 0.5,
  btcHoldings: 650000, btcHoldingsAsOf: '2025-12-31', btcHoldingsSeeded: true,
  sharesOutstanding: 290000000, sharesOutstandingAsOf: '2025-12-31', sharesSeeded: true,
}

/** Uptrend with a live pullback trigger on the last bar (same construction
 *  the signals unit tests prove). */
export function mstrTriggerCandles() {
  const closes = []
  let px = 300
  for (let i = 0; i < 59; i++) { closes.push(px); px *= 1.01 }
  closes.push(closes[58] * 0.99)
  closes.push(closes[59] * 1.03)
  let candles = candlesFromCloses(closes)
  const e20 = ema(closes, 20)
  candles = patchCandles(candles, { 59: { l: Math.round(e20[59] * 100) / 100 } })
  return candles
}

export const btcUpCandles = () => genCandles({ n: 120, start: 60000, driftPct: 0.6, volPct: 1.4, seed: 21 })

export function payloads(now = Date.now()) {
  const mstr = mstrTriggerCandles()
  const btc = btcUpCandles()
  const price = mstr[mstr.length - 1].c
  const btcPrice = btc[btc.length - 1].c
  const meta = (source) => ({ source, fetchedAt: now, latencyMs: 40 })
  return {
    mstr, btc, price, btcPrice,
    quote: { symbol: 'MSTR', price, prevClose: mstr[mstr.length - 2].c, changePct: 3, dayHigh: price * 1.01, dayLow: price * 0.98, marketState: 'open', delayedMin: 15, kind: 'delayed', sourceDetail: 'yahoo', meta: meta('quote') },
    btcSpot: { price: btcPrice, changePct24h: 1.8, sourceDetail: 'binance', meta: meta('btc') },
    candlesMstr: { symbol: 'MSTR', tf: '1d', candles: mstr, sourceDetail: 'yahoo', meta: meta('candles') },
    candlesBtc: { symbol: 'BTC', tf: '1d', candles: btc, sourceDetail: 'binance', meta: meta('candles') },
  }
}

/** Install route mocks. overrides: { quote: {status, body} | fn, ... } */
export async function installApi(page, { data = payloads(), overrides = {}, journal = [], position = null, settings = SETTINGS } = {}) {
  const state = { journal: [...journal], position, settings: { ...settings } }
  await page.route('**/api/**', async (route) => {
    const url = new URL(route.request().url())
    const path = url.pathname.replace(/^.*\/api\//, '')
    const method = route.request().method()
    const name = path.split('?')[0]
    const key = name === 'candles' ? (url.searchParams.get('symbol') === 'BTC' ? 'candlesBtc' : 'candlesMstr') : name

    if (overrides[key]) {
      const o = typeof overrides[key] === 'function' ? overrides[key](route) : overrides[key]
      if (o) return route.fulfill({ status: o.status ?? 200, contentType: 'application/json', body: JSON.stringify(o.body ?? {}) })
    }

    const ok = (body) => route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(body) })
    switch (key) {
      case 'quote': return ok(data.quote)
      case 'btc': return ok(data.btcSpot)
      case 'candlesMstr': return ok(data.candlesMstr)
      case 'candlesBtc': return ok(data.candlesBtc)
      case 'settings':
        if (method === 'PUT') { state.settings = { ...state.settings, ...JSON.parse(route.request().postData() || '{}') } }
        return ok({ settings: state.settings })
      case 'position':
        if (method === 'PUT') { state.position = { ...JSON.parse(route.request().postData() || '{}'), updatedAt: Date.now() } }
        if (method === 'DELETE') state.position = null
        return ok({ position: state.position })
      case 'journal':
        if (method === 'POST') {
          const t = { id: `t${state.journal.length + 1}`, ...JSON.parse(route.request().postData() || '{}'), createdAt: Date.now() }
          state.journal.unshift(t)
          return ok({ trade: t, trades: state.journal })
        }
        if (method === 'DELETE') {
          state.journal = state.journal.filter((t) => t.id !== url.searchParams.get('id'))
        }
        return ok({ trades: state.journal })
      case 'status': return ok({ pings: { yahoo: { ok: true, httpStatus: 200, latencyMs: 80 } }, sourceStatus: {}, blobs: { ok: true } })
      default: return route.fulfill({ status: 404, contentType: 'application/json', body: '{"error":"not mocked"}' })
    }
  })
  return state
}
