// Shared plumbing for every Netlify function. Three jobs:
//   1. Optional shared-secret auth (DASHBOARD_TOKEN) on every endpoint.
//   2. fetch with a hard timeout so upstream hangs become visible errors.
//   3. Per-source health recording into Netlify Blobs so the Data Sources
//      tab reflects reality, not hope.
import { getStore } from '@netlify/blobs'

export function store() {
  return getStore('mcc')
}

export function unauthorized() {
  return json({ error: 'unauthorized' }, 401)
}

export function checkAuth(req) {
  const required = process.env.DASHBOARD_TOKEN
  if (!required) return true
  return req.headers.get('x-dashboard-token') === required
}

export function json(body, status = 200, extraHeaders = {}) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', ...extraHeaders },
  })
}

export async function fetchWithTimeout(url, opts = {}, timeoutMs = 9000) {
  const ctl = new AbortController()
  const t = setTimeout(() => ctl.abort(new Error(`timeout after ${timeoutMs}ms`)), timeoutMs)
  try {
    return await fetch(url, { ...opts, signal: ctl.signal })
  } finally {
    clearTimeout(t)
  }
}

/**
 * Record a source's latest fetch outcome. Fire-and-forget by contract:
 * a Blobs hiccup must never fail the data request itself.
 */
export async function recordStatus(name, { ok, latencyMs, error = null, detail = null }) {
  try {
    const s = store()
    const map = (await s.get('source_status', { type: 'json' })) || {}
    const prev = map[name] || {}
    map[name] = {
      name,
      ok,
      at: Date.now(),
      latencyMs: Math.round(latencyMs),
      lastError: ok ? prev.lastError ?? null : String(error ?? 'unknown error'),
      lastErrorAt: ok ? prev.lastErrorAt ?? null : Date.now(),
      lastSuccessAt: ok ? Date.now() : prev.lastSuccessAt ?? null,
      detail,
    }
    await s.setJSON('source_status', map)
  } catch {
    /* never let status bookkeeping break data delivery */
  }
}

/**
 * Wrap a source handler: times it, records status, and converts failures
 * into a structured 502 (so the client shows DOWN, never a fake number).
 */
export function sourceHandler(name, fn) {
  return async (req, context) => {
    if (!checkAuth(req)) return unauthorized()
    const started = Date.now()
    try {
      const data = await fn(req, context)
      const latencyMs = Date.now() - started
      await recordStatus(name, { ok: true, latencyMs, detail: data?.sourceDetail ?? null })
      return json({ ...data, meta: { source: name, fetchedAt: Date.now(), latencyMs } })
    } catch (err) {
      const latencyMs = Date.now() - started
      await recordStatus(name, { ok: false, latencyMs, error: err?.message || err })
      return json({ error: String(err?.message || err), meta: { source: name, fetchedAt: Date.now(), latencyMs, failed: true } }, 502)
    }
  }
}

// ---------------- Telegram alerts (optional) ----------------
// Fire-and-forget descriptive alerts. Silently disabled unless both env
// vars are set. Never throws into the caller's path.
export function telegramConfigured() {
  return !!(process.env.TELEGRAM_BOT_TOKEN && process.env.TELEGRAM_CHAT_ID)
}

export async function sendTelegram(text) {
  if (!telegramConfigured()) return { sent: false, reason: 'not configured' }
  try {
    const res = await fetchWithTimeout(
      `https://api.telegram.org/bot${process.env.TELEGRAM_BOT_TOKEN}/sendMessage`,
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ chat_id: process.env.TELEGRAM_CHAT_ID, text, disable_web_page_preview: true }),
      },
      8000
    )
    if (!res.ok) return { sent: false, reason: `HTTP ${res.status}` }
    return { sent: true }
  } catch (e) {
    return { sent: false, reason: String(e?.message || e) }
  }
}
