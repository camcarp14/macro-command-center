import { checkAuth, unauthorized, json, store } from '../shared/util.mjs'
import { aggregateUsage } from '../../src/lib/cost.js'

export default async (req) => {
  if (!checkAuth(req)) return unauthorized()
  const s = store()
  if (req.method === 'POST') {
    const { budgetUsd } = await req.json()
    if (!Number.isFinite(budgetUsd) || budgetUsd < 0) return json({ error: 'budgetUsd must be a non-negative number' }, 400)
    const settings = (await s.get('settings', { type: 'json' })) || {}
    settings.budgetUsd = budgetUsd
    await s.setJSON('settings', settings)
  }
  const entries = (await s.get('token_usage', { type: 'json' })) || []
  const settings = (await s.get('settings', { type: 'json' })) || {}
  return json({
    totals: aggregateUsage(entries),
    entries: entries.slice(-100).reverse(),
    budgetUsd: Number.isFinite(settings.budgetUsd) ? settings.budgetUsd : 10,
    meta: { source: 'usage', fetchedAt: Date.now() },
  })
}
