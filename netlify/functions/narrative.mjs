// The "morning take". Contract:
//   - The client POSTs the fact sheet built from the values ON SCREEN.
//   - We send exactly those facts to the Anthropic API. Key never leaves here.
//   - We validate the reply against the same facts BEFORE returning it, and
//     the client validates again. A narrative that fails is returned with
//     validation.ok=false and the UI refuses to render its prose.
//   - Every call — pass or fail — is logged to the token ledger with cost,
//     and the monthly budget is enforced up front.
import { checkAuth, unauthorized, json, store, fetchWithTimeout } from '../shared/util.mjs'
import { buildPrompt, validateNarrative } from '../../src/lib/narrative.js'
import { costUsd, aggregateUsage } from '../../src/lib/cost.js'

const DEFAULT_MODEL = 'claude-sonnet-4-6'

export default async (req) => {
  if (!checkAuth(req)) return unauthorized()
  if (req.method !== 'POST') return json({ error: 'POST a { facts } object' }, 405)
  const apiKey = process.env.ANTHROPIC_API_KEY
  if (!apiKey) return json({ error: 'ANTHROPIC_API_KEY is not configured' }, 400)

  const { facts } = await req.json()
  if (!facts || typeof facts !== 'object' || Object.keys(facts).length === 0) {
    return json({ error: 'facts payload is empty — refusing to generate a data-free narrative' }, 400)
  }

  // Budget gate before spending a token.
  const s = store()
  const entries = (await s.get('token_usage', { type: 'json' })) || []
  const settings = (await s.get('settings', { type: 'json' })) || {}
  const budgetUsd = Number.isFinite(settings.budgetUsd) ? settings.budgetUsd : 10
  const totals = aggregateUsage(entries)
  if (totals.month >= budgetUsd) {
    return json({ error: `Monthly token budget reached ($${totals.month.toFixed(2)} of $${budgetUsd}). Raise it on the Token Usage tab.`, budgetUsd, totals }, 429)
  }

  const model = process.env.NARRATIVE_MODEL || DEFAULT_MODEL
  const { system, user } = buildPrompt(facts)

  const res = await fetchWithTimeout('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-api-key': apiKey, 'anthropic-version': '2023-06-01' },
    body: JSON.stringify({ model, max_tokens: 600, system, messages: [{ role: 'user', content: user }] }),
  }, 30000)

  if (!res.ok) {
    const errBody = await res.text()
    return json({ error: `Anthropic API HTTP ${res.status}: ${errBody.slice(0, 300)}` }, 502)
  }
  const body = await res.json()
  const text = (body.content || []).filter((b) => b.type === 'text').map((b) => b.text).join('\n')
  const inputTokens = body.usage?.input_tokens ?? 0
  const outputTokens = body.usage?.output_tokens ?? 0
  const cost = costUsd(body.model || model, inputTokens, outputTokens)

  const validation = validateNarrative(text, facts)

  entries.push({ ts: Date.now(), model: body.model || model, inputTokens, outputTokens, costUsd: cost, valid: validation.ok, purpose: 'morning-take' })
  await s.setJSON('token_usage', entries.slice(-2000))

  return json({
    text,
    validation,
    model: body.model || model,
    usage: { inputTokens, outputTokens, costUsd: cost },
    budget: { budgetUsd, monthUsd: aggregateUsage(entries).month },
    meta: { source: 'narrative', fetchedAt: Date.now() },
  })
}
