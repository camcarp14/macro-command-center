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
 * Approximate NYSE session, DST-aware: Mon–Fri 09:30–16:00 in
 * America/New_York (via Intl, so EST/EDT are both right). No holiday
 * calendar — the UI labels this "approx" and it only softens copy, never
 * blocks data. Callers should prefer the exchange's own marketState from
 * the quote feed when it's available.
 */
export function nyseSessionState(nowMs = Date.now()) {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/New_York', weekday: 'short', hour: 'numeric', minute: 'numeric', hourCycle: 'h23',
  }).formatToParts(new Date(nowMs))
  const get = (t) => parts.find((p) => p.type === t)?.value
  const day = get('weekday')
  if (day === 'Sat' || day === 'Sun') return 'closed'
  const mins = Number(get('hour')) * 60 + Number(get('minute'))
  return mins >= 570 && mins < 960 ? 'open' : 'closed'
}
