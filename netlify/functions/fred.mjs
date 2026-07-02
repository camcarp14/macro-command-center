import { sourceHandler } from '../shared/util.mjs'
import { fetchFred, FRED_SERIES } from '../shared/sources.mjs'

export default sourceHandler('fred', async (req) => {
  const url = new URL(req.url)
  const q = url.searchParams.get('series')
  const list = q ? q.split(',').map((s) => s.trim()).filter(Boolean) : FRED_SERIES
  return fetchFred(list)
})
