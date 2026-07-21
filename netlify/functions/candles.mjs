import { sourceHandler, json, checkAuth, unauthorized } from '../shared/util.mjs'
import { mstrCandles, btcCandles } from '../shared/sources.mjs'

const handler = sourceHandler('candles', async (req) => {
  const url = new URL(req.url)
  const symbol = (url.searchParams.get('symbol') || 'MSTR').toUpperCase()
  const tf = url.searchParams.get('tf') || '1d'
  // validation happens in the wrapper below (400, not 502)
  const data = symbol === 'BTC' ? await btcCandles(tf) : await mstrCandles(tf)
  return { symbol, tf, ...data }
})

export default async (req, context) => {
  if (!checkAuth(req)) return unauthorized()
  const url = new URL(req.url)
  const symbol = (url.searchParams.get('symbol') || 'MSTR').toUpperCase()
  const tf = url.searchParams.get('tf') || '1d'
  if (!['MSTR', 'BTC'].includes(symbol)) return json({ error: `unknown symbol ${symbol}` }, 400)
  if (!['1d', '30m'].includes(tf)) return json({ error: `unknown tf ${tf}` }, 400)
  return handler(req, context)
}
