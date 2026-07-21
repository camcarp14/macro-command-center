import { sourceHandler } from '../shared/util.mjs'
import { btcSpot } from '../shared/sources.mjs'

export default sourceHandler('btc', () => btcSpot())
