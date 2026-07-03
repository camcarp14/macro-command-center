// The setups' report card. Every time a setup transitions to ACTIVE, the
// snapshot cron appends {ts, key, name, btc} here. This endpoint serves the
// log so the UI can show what BTC did after each activation — the evidence a
// setup must accumulate before anyone should trust it with real size.
import { checkAuth, unauthorized, json, store } from '../shared/util.mjs'

export default async (req) => {
  if (!checkAuth(req)) return unauthorized()
  const log = (await store().get('trigger_log', { type: 'json' })) || []
  return json({ triggers: log.slice(-200), count: log.length, meta: { source: 'triggers', fetchedAt: Date.now() } })
}
