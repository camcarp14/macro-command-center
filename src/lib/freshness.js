// Freshness rules — the honesty layer. Every displayed number carries one
// of these states; a dead source shows "—", never a remembered price.

export const SOURCE_MAX_AGE_SEC = {
  quote: 1200,        // Yahoo delayed feed: 20 min before we call it stale
  btc: 180,           // live crypto: 3 min
  candles_1d: 93600,  // daily candles: 26 h
  candles_30m: 1800,  // intraday: 30 min
}

/** live < maxAge · stale < 3×maxAge · dead beyond (or never fetched). */
export function freshness(fetchedAtMs, key, nowMs = Date.now()) {
  if (!Number.isFinite(fetchedAtMs)) return { state: 'dead', ageSec: null, label: '—' }
  const maxAge = SOURCE_MAX_AGE_SEC[key] ?? 600
  const ageSec = Math.max(0, Math.round((nowMs - fetchedAtMs) / 1000))
  const state = ageSec < maxAge ? 'live' : ageSec < maxAge * 3 ? 'stale' : 'dead'
  return { state, ageSec, label: ageLabel(ageSec) }
}

export function ageLabel(ageSec) {
  if (!Number.isFinite(ageSec)) return '—'
  if (ageSec < 60) return `${ageSec}s ago`
  if (ageSec < 3600) return `${Math.round(ageSec / 60)}m ago`
  if (ageSec < 172800) return `${Math.round(ageSec / 3600)}h ago`
  return `${Math.round(ageSec / 86400)}d ago`
}

/**
 * Approximate NYSE session: Mon–Fri 13:30–20:00 UTC. No holiday calendar —
 * the UI labels this "approx" and it only softens copy, never blocks data.
 */
export function nyseSessionState(nowMs = Date.now()) {
  const d = new Date(nowMs)
  const day = d.getUTCDay()
  if (day === 0 || day === 6) return 'closed'
  const mins = d.getUTCHours() * 60 + d.getUTCMinutes()
  return mins >= 810 && mins < 1200 ? 'open' : 'closed'
}
