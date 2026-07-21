// API plumbing — token-aware fetch against the Netlify functions.

export function getToken() { return sessionStorage.getItem('torque_token') || '' }

export async function api(path, opts = {}) {
  const headers = { ...(opts.headers || {}) }
  const tok = getToken()
  if (tok) headers['x-dashboard-token'] = tok
  if (opts.body) headers['content-type'] = 'application/json'
  const res = await fetch(`/api/${path}`, { ...opts, headers })
  const body = await res.json().catch(() => ({}))
  if (res.status === 401) { const e = new Error('unauthorized'); e.code = 401; throw e }
  if (!res.ok) { const e = new Error(body.error || `HTTP ${res.status}`); e.body = body; throw e }
  return body
}
