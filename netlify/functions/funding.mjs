import { sourceHandler } from '../shared/util.mjs'
import { fetchFunding } from '../shared/sources.mjs'

export default sourceHandler('funding', () => fetchFunding())
