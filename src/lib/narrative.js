// The "morning take" pipeline, and the guarantee behind it:
//
//   1. The CLIENT builds a fact sheet from the exact values currently rendered.
//   2. The server sends ONLY those facts to the model, with instructions to
//      cite them verbatim and to append a <facts_used> JSON footer.
//   3. validateNarrative() runs on the server AND again on the client.
//      If it fails, the text is never displayed. Period.
//
// This module is pure (no fetch) so every rule below is unit-testable.

/** Build the fact sheet from live UI state. Only finite numbers make it in. */
export function buildFactSheet(metrics) {
  const defs = [
    ['score', 'Macro Pressure Score (0-100)', ''],
    ['btc', 'BTC spot price', 'USD'],
    ['btc_24h', 'BTC 24h change', '%'],
    ['ust10y', '10Y Treasury yield', '%'],
    ['curve_2s10s', '2s10s spread', 'pp'],
    ['dff', 'Fed funds effective rate', '%'],
    ['hy_oas', 'High-yield credit spread', '%'],
    ['dollar', 'Broad dollar index', ''],
    ['qt_13w', 'Fed balance sheet 13-week change', '%'],
    ['funding_ann', 'BTC perp funding, annualized', '%'],
    ['fear_greed', 'Crypto Fear & Greed index', ''],
    ['aave_hf', 'Aave health factor', ''],
    ['aave_liq_dd', 'BTC drawdown to liquidation', '%'],
  ]
  const facts = {}
  for (const [key, label, unit] of defs) {
    const v = metrics?.[key]
    if (Number.isFinite(v)) facts[key] = { label, unit, value: roundForFacts(key, v), delta: numOrUndef(metrics?.[key + '_delta']) }
  }
  return facts
}

function roundForFacts(key, v) {
  if (key === 'btc') return Math.round(v)
  return Math.round(v * 100) / 100
}
function numOrUndef(v) { return Number.isFinite(v) ? v : undefined }

export function buildPrompt(facts) {
  const system = [
    'You write a terse trading-desk morning note for a professional operator running a bearish AI-capex/hawkish-Fed thesis alongside a leveraged BTC position on Aave.',
    'Voice: direct, skeptical, no cheerleading, no hedging filler. 90-140 words of prose.',
    'HARD RULES:',
    '1. You may ONLY reference numbers that appear in the FACTS JSON, and you must reproduce them exactly as given (same rounding).',
    '2. Do not invent, estimate, or recall any other figure — no historical levels, no forecasts with numbers.',
    '3. Directional words (rose/fell/widened/tightened) may only be used for facts that include a "delta", and must match its sign.',
    '4. After the prose, append exactly one line: <facts_used>{"key": value, ...}</facts_used> listing every fact you cited.',
  ].join('\n')
  const user = `FACTS:\n${JSON.stringify(facts, null, 2)}\n\nWrite the morning take.`
  return { system, user }
}

// ---------------- Validation ----------------

const REL_TOL = 0.0075 // 0.75%
const ABS_TOL = 0.011  // for values near zero

function matchesFact(cited, actual) {
  if (!Number.isFinite(cited) || !Number.isFinite(actual)) return false
  if (Math.abs(actual) < 1) return Math.abs(cited - actual) <= ABS_TOL
  return Math.abs(cited - actual) / Math.abs(actual) <= REL_TOL
}

const UP_WORDS = /\b(rose|rising|up|higher|climbed|widened|widening|jumped|surged|steepened|increas\w*|spiked)\b/i
const DOWN_WORDS = /\b(fell|falling|down|lower|dropped|narrowed|tightened|declin\w*|slid|compressed|eased)\b/i

/**
 * @returns {{ ok:boolean, errors:string[], warnings:string[] }}
 * Fails closed: any hard violation => ok:false and the UI must not render the text.
 */
export function validateNarrative(text, facts) {
  const errors = []
  const warnings = []
  if (!text || typeof text !== 'string') return { ok: false, errors: ['Empty narrative'], warnings }

  // 1) The facts_used footer must exist, parse, and match the fact sheet.
  const m = text.match(/<facts_used>([\s\S]*?)<\/facts_used>/)
  if (!m) {
    errors.push('Missing <facts_used> footer — cannot verify citations.')
  } else {
    let cited
    try { cited = JSON.parse(m[1]) } catch { errors.push('<facts_used> footer is not valid JSON.') }
    if (cited && typeof cited === 'object') {
      for (const [k, v] of Object.entries(cited)) {
        if (!(k in facts)) errors.push(`Cited unknown fact "${k}".`)
        else if (!matchesFact(Number(v), facts[k].value)) {
          errors.push(`Cited ${k}=${v} but the on-screen value is ${facts[k].value}.`)
        }
      }
    }
  }

  const prose = text.replace(/<facts_used>[\s\S]*?<\/facts_used>/, '')

  // 2) Every substantive number in the prose must correspond to some fact.
  //    We scan $-amounts and decimal/percent figures; small bare integers
  //    (list counts, "24h", scenario labels like 10/20/30/40) are exempt.
  const factValues = Object.values(facts).map((f) => f.value)
  const numTokens = prose.match(/\$?-?\d[\d,]*\.?\d*%?/g) || []
  for (const tok of numTokens) {
    const isMoney = tok.startsWith('$')
    const isPct = tok.endsWith('%')
    const n = Number(tok.replace(/[$,%]/g, ''))
    if (!Number.isFinite(n)) continue
    if (!isMoney && !isPct && Number.isInteger(n) && Math.abs(n) <= 100 && !tok.includes('.')) continue // "10Y", "2s10s", "24h", scenario ints
    const matched = factValues.some((fv) => matchesFact(n, fv) || matchesFact(-n, fv))
    if (!matched) errors.push(`Number "${tok}" does not match any on-screen fact.`)
  }

  // 3) Direction words near a metric mention must match that fact's delta sign.
  for (const [key, f] of Object.entries(facts)) {
    if (!Number.isFinite(f.delta) || f.delta === 0) continue
    const stem = f.label.split(/[ ,(]/)[0]
    const re = new RegExp(`(${escapeRe(stem)}|${escapeRe(key)})[^.!?\\n]{0,60}`, 'ig')
    let mm
    while ((mm = re.exec(prose)) !== null) {
      const window = mm[0]
      if (f.delta > 0 && DOWN_WORDS.test(window) && !UP_WORDS.test(window)) {
        errors.push(`Narrative implies "${f.label}" fell, but its delta is +${f.delta}.`)
      }
      if (f.delta < 0 && UP_WORDS.test(window) && !DOWN_WORDS.test(window)) {
        errors.push(`Narrative implies "${f.label}" rose, but its delta is ${f.delta}.`)
      }
    }
  }

  if (Object.keys(facts).length === 0) warnings.push('Fact sheet was empty — narrative validated against nothing.')
  return { ok: errors.length === 0, errors, warnings }
}

function escapeRe(s) { return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') }

/** Strip the machine footer for display. */
export function displayText(text) {
  return (text || '').replace(/<facts_used>[\s\S]*?<\/facts_used>/, '').trim()
}
