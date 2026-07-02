import { sourceHandler, store } from '../shared/util.mjs'

// Snapshot history built by the scheduled snapshot function. Free APIs only
// return "now"; the sparkline past for BTC/funding/F&G/score/HF exists only
// because we log it ourselves.
export default sourceHandler('history', async (req) => {
  const url = new URL(req.url)
  const n = Math.min(Number(url.searchParams.get('n')) || 336, 2000)
  const snaps = (await store().get('snapshots', { type: 'json' })) || []
  return { snapshots: snaps.slice(-n), count: snaps.length }
})
