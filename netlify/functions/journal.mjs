// Closed-trade journal. Stores raw fills; R math is computed by the shared
// risk lib on display so there is exactly one R formula in the product.
import { json, checkAuth, unauthorized, store } from '../shared/util.mjs'
import { validateTrade } from '../shared/validate.mjs'

export default async (req) => {
  if (!checkAuth(req)) return unauthorized()
  const s = store()
  const load = async () => (await s.get('journal', { type: 'json' })) || []

  if (req.method === 'GET') {
    return json({ trades: await load() })
  }

  if (req.method === 'POST') {
    const body = await req.json().catch(() => null)
    const v = validateTrade(body)
    if (!v.ok) return json({ error: 'validation failed', errors: v.errors }, 400)
    const trades = await load()
    const trade = { id: crypto.randomUUID(), ...v.value, createdAt: Date.now() }
    trades.unshift(trade)
    await s.setJSON('journal', trades)
    return json({ trade, trades })
  }

  if (req.method === 'DELETE') {
    const id = new URL(req.url).searchParams.get('id')
    if (!id) return json({ error: 'id required' }, 400)
    const trades = await load()
    const next = trades.filter((t) => t.id !== id)
    if (next.length === trades.length) return json({ error: 'not found' }, 404)
    await s.setJSON('journal', next)
    return json({ trades: next })
  }

  return json({ error: 'method not allowed' }, 405)
}
