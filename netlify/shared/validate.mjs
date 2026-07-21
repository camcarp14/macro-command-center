// Pure validators for everything a client can write. No imports, fully
// unit-tested. Reject unknown keys — a typo'd setting should fail loudly,
// not silently do nothing.

const SETTINGS_RULES = {
  equity: { min: 1, max: 1e9 },
  riskPct: { min: 0.05, max: 5 },
  maxPositionPct: { min: 1, max: 100 },
  stopMode: { enum: ['atr', 'structure', 'percent'] },
  atrMult: { min: 0.5, max: 10 },
  stopPct: { min: 1, max: 50 },
  chandelierPeriod: { min: 5, max: 100, int: true },
  chandelierMult: { min: 0.5, max: 10 },
  beAtR: { min: 0.25, max: 5 },
  addRiskFraction: { min: 0.1, max: 1 },
  btcHoldings: { min: 1, max: 5e6 },
  sharesOutstanding: { min: 1e6, max: 5e9 },
}

export function validateSettings(patch) {
  if (!patch || typeof patch !== 'object' || Array.isArray(patch)) return err(['settings patch must be an object'])
  const errors = []
  const value = {}
  for (const [k, v] of Object.entries(patch)) {
    // Object.hasOwn, not a bare lookup: keys like "hasOwnProperty" or
    // "constructor" must be rejected as unknown, not resolved up the
    // prototype chain into a rule-shaped object.
    const rule = Object.hasOwn(SETTINGS_RULES, k) ? SETTINGS_RULES[k] : undefined
    if (!rule) { errors.push(`unknown setting: ${k}`); continue }
    if (rule.enum) {
      if (!rule.enum.includes(v)) { errors.push(`${k} must be one of ${rule.enum.join('/')}`); continue }
      value[k] = v
      continue
    }
    if (!Number.isFinite(v)) { errors.push(`${k} must be a number`); continue }
    if (rule.int && !Number.isInteger(v)) { errors.push(`${k} must be an integer`); continue }
    if (v < rule.min || v > rule.max) { errors.push(`${k} must be between ${rule.min} and ${rule.max}`); continue }
    value[k] = v
  }
  return errors.length ? err(errors) : { ok: true, value }
}

export function validatePosition(body) {
  if (!body || typeof body !== 'object') return err(['position must be an object'])
  const errors = []
  const { shares, avgEntry, entryDate, initialStop, stopOverride = null, note = '' } = body
  if (!Number.isInteger(shares) || shares <= 0) errors.push('shares must be a positive integer')
  if (!Number.isFinite(avgEntry) || avgEntry <= 0) errors.push('avgEntry must be a positive number')
  if (!isIsoDate(entryDate)) errors.push('entryDate must be YYYY-MM-DD')
  if (!Number.isFinite(initialStop) || initialStop <= 0) errors.push('initialStop must be a positive number')
  else if (Number.isFinite(avgEntry) && initialStop >= avgEntry) errors.push('initialStop must be below avgEntry')
  if (stopOverride != null && (!Number.isFinite(stopOverride) || stopOverride <= 0)) errors.push('stopOverride must be a positive number or null')
  else if (stopOverride != null && Number.isFinite(initialStop) && stopOverride < initialStop) errors.push('stopOverride can only raise the stop — it must be at or above initialStop')
  if (typeof note !== 'string' || note.length > 500) errors.push('note must be a string ≤ 500 chars')
  if (errors.length) return err(errors)
  return { ok: true, value: { shares, avgEntry, entryDate, initialStop, stopOverride, note } }
}

export function validateTrade(body) {
  if (!body || typeof body !== 'object') return err(['trade must be an object'])
  const errors = []
  const { entryDate, exitDate, entry, exit, shares, initialStop, kind = 'manual', note = '' } = body
  if (!isIsoDate(entryDate)) errors.push('entryDate must be YYYY-MM-DD')
  if (!isIsoDate(exitDate)) errors.push('exitDate must be YYYY-MM-DD')
  if (isIsoDate(entryDate) && isIsoDate(exitDate) && exitDate < entryDate) errors.push('exitDate must be on/after entryDate')
  if (!Number.isFinite(entry) || entry <= 0) errors.push('entry must be a positive number')
  if (!Number.isFinite(exit) || exit <= 0) errors.push('exit must be a positive number')
  if (!Number.isInteger(shares) || shares <= 0) errors.push('shares must be a positive integer')
  if (!Number.isFinite(initialStop) || initialStop <= 0) errors.push('initialStop must be a positive number')
  if (!['pullback', 'breakout', 'manual'].includes(kind)) errors.push('kind must be pullback/breakout/manual')
  if (typeof note !== 'string' || note.length > 500) errors.push('note must be a string ≤ 500 chars')
  if (errors.length) return err(errors)
  return { ok: true, value: { entryDate, exitDate, entry, exit, shares, initialStop, kind, note } }
}

function isIsoDate(s) {
  return typeof s === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(s) && !Number.isNaN(Date.parse(`${s}T00:00:00Z`))
}
function err(errors) { return { ok: false, errors } }
