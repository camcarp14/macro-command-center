// Anthropic API pricing, USD per MILLION tokens.
// Verified 2026-07-02 against Anthropic's pricing docs (platform.claude.com/docs
// → About Claude → Pricing). If you switch models, add a row here — unknown
// models are surfaced as cost:null rather than silently priced at zero.
export const PRICING = {
  'claude-sonnet-4-6':          { input: 3.0, output: 15.0 },
  'claude-haiku-4-5':           { input: 1.0, output: 5.0 },
  'claude-haiku-4-5-20251001':  { input: 1.0, output: 5.0 },
  'claude-opus-4-8':            { input: 5.0, output: 25.0 },
}

export function costUsd(model, inputTokens, outputTokens) {
  const p = PRICING[model]
  if (!p) return null
  return round6((inputTokens / 1e6) * p.input + (outputTokens / 1e6) * p.output)
}

export function aggregateUsage(entries, nowMs = Date.now()) {
  const day = 24 * 3600 * 1000
  const startOfDay = new Date(nowMs); startOfDay.setHours(0, 0, 0, 0)
  const totals = { today: 0, week: 0, month: 0, allTime: 0, calls: entries.length, unpriced: 0 }
  for (const e of entries) {
    const c = Number.isFinite(e.costUsd) ? e.costUsd : null
    if (c == null) { totals.unpriced++; continue }
    totals.allTime += c
    if (e.ts >= startOfDay.getTime()) totals.today += c
    if (e.ts >= nowMs - 7 * day) totals.week += c
    if (e.ts >= nowMs - 30 * day) totals.month += c
  }
  for (const k of ['today', 'week', 'month', 'allTime']) totals[k] = round6(totals[k])
  return totals
}

function round6(n) { return Math.round(n * 1e6) / 1e6 }
