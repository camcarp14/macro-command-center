import { checkAuth, unauthorized, json, store, telegramConfigured } from '../shared/util.mjs'
import { SNAPSHOT_CRON } from '../shared/schedule.mjs'

export default async (req) => {
  if (!checkAuth(req)) return unauthorized()
  const map = (await store().get('source_status', { type: 'json' })) || {}
  return json({ sources: map, snapshotCron: SNAPSHOT_CRON, nextSnapshotAt: nextHalfHour(), alerts: { telegram: telegramConfigured() }, meta: { source: 'status', fetchedAt: Date.now() } })
}

function nextHalfHour() {
  const d = new Date()
  d.setSeconds(0, 0)
  d.setMinutes(d.getMinutes() < 30 ? 30 : 60)
  return d.getTime()
}
