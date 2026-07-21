import { sourceHandler } from '../shared/util.mjs'
import { mstrQuote } from '../shared/sources.mjs'

export default sourceHandler('quote', () => mstrQuote())
