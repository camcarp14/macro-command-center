import { sourceHandler } from '../shared/util.mjs'
import { fetchMarket } from '../shared/sources.mjs'

export default sourceHandler('market', () => fetchMarket())
