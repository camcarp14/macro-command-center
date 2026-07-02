import { sourceHandler } from '../shared/util.mjs'
import { fetchFearGreed } from '../shared/sources.mjs'

export default sourceHandler('feargreed', () => fetchFearGreed())
