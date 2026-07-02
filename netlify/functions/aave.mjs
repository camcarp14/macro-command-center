import { sourceHandler } from '../shared/util.mjs'
import { fetchAave } from '../shared/sources.mjs'

export default sourceHandler('aave', () => fetchAave())
