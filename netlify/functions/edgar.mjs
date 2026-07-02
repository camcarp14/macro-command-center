// SEC EDGAR XBRL — quarterly capex and lease liabilities for the five
// hyperscalers. Weekly cache in Blobs (the Thesis tab doesn't need real-time).
//
// Design notes, stated plainly:
//  - CIKs are resolved at runtime from SEC's company_tickers.json rather than
//    hardcoded, so a mapping change can't silently poison the data.
//  - Capex uses us-gaap:PaymentsToAcquirePropertyPlantAndEquipment, taking
//    only observations that carry a clean quarterly frame (CYyyyyQq), which
//    sidesteps the 10-Q year-to-date-cumulation trap.
//  - Lease exposure uses on-balance-sheet OperatingLeaseLiability +
//    FinanceLeaseLiability (instant frames). "Lease commitments not yet
//    commenced" — the off-balance-sheet piece of the thesis — is usually
//    disclosed in filing TEXT, not XBRL. The UI says so and points you to the
//    manual timeline instead of interpolating a number that doesn't exist.
import { checkAuth, unauthorized, json, store, fetchWithTimeout, recordStatus } from '../shared/util.mjs'

const TICKERS = ['MSFT', 'GOOGL', 'AMZN', 'META', 'ORCL']
const CACHE_KEY = 'edgar_cache'
const CACHE_TTL_MS = 7 * 24 * 3600 * 1000

const CONCEPTS = {
  capexQ: { tag: 'PaymentsToAcquirePropertyPlantAndEquipment', kind: 'duration' },
  opLease: { tag: 'OperatingLeaseLiability', kind: 'instant' },
  finLease: { tag: 'FinanceLeaseLiability', kind: 'instant' },
}

export default async (req) => {
  if (!checkAuth(req)) return unauthorized()
  const s = store()
  const started = Date.now()
  const force = new URL(req.url).searchParams.get('refresh') === '1'
  const cached = (await s.get(CACHE_KEY, { type: 'json' })) || null

  if (cached && !force && Date.now() - cached.fetchedAt < CACHE_TTL_MS) {
    return json({ ...cached.data, meta: { source: 'edgar', fetchedAt: cached.fetchedAt, cache: 'hit', latencyMs: Date.now() - started } })
  }

  try {
    const data = await refresh()
    const fetchedAt = Date.now()
    await s.setJSON(CACHE_KEY, { fetchedAt, data })
    await recordStatus('edgar', { ok: true, latencyMs: Date.now() - started })
    return json({ ...data, meta: { source: 'edgar', fetchedAt, cache: force ? 'forced-refresh' : 'refresh', latencyMs: Date.now() - started } })
  } catch (err) {
    await recordStatus('edgar', { ok: false, latencyMs: Date.now() - started, error: err?.message })
    if (cached) {
      // Serve the old data, loudly marked stale — never a silent substitution.
      return json({ ...cached.data, meta: { source: 'edgar', fetchedAt: cached.fetchedAt, cache: 'stale-after-error', staleError: String(err?.message), latencyMs: Date.now() - started } })
    }
    return json({ error: String(err?.message || err), meta: { source: 'edgar', fetchedAt: Date.now(), failed: true } }, 502)
  }
}

function ua() {
  const v = process.env.EDGAR_USER_AGENT
  if (!v) throw new Error('EDGAR_USER_AGENT is not configured (SEC requires a descriptive User-Agent with contact info)')
  return { 'user-agent': v, accept: 'application/json' }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

async function refresh() {
  // 1) Resolve CIKs at runtime.
  const res = await fetchWithTimeout('https://www.sec.gov/files/company_tickers.json', { headers: ua() }, 12000)
  if (!res.ok) throw new Error(`SEC company_tickers HTTP ${res.status}`)
  const all = await res.json()
  const byTicker = {}
  for (const row of Object.values(all)) byTicker[row.ticker] = { cik: String(row.cik_str).padStart(10, '0'), name: row.title }

  const companies = []
  for (const t of TICKERS) {
    const hit = byTicker[t]
    if (!hit) { companies.push({ ticker: t, error: 'CIK not found in SEC ticker file' }); continue }
    const c = { ticker: t, name: hit.name, cik: hit.cik, concepts: {}, errors: [] }
    for (const [key, def] of Object.entries(CONCEPTS)) {
      await sleep(160) // SEC fair-use pacing (<10 req/s)
      try {
        c.concepts[key] = await fetchConcept(hit.cik, def)
      } catch (e) {
        c.errors.push(`${def.tag}: ${e.message}`)
        c.concepts[key] = null
      }
    }
    c.derived = derive(c.concepts)
    companies.push(c)
  }
  return {
    companies,
    caveat: 'On-balance-sheet lease liabilities only. "Leases not yet commenced" are disclosed in filing text, not XBRL — log those manually in the Thesis timeline.',
  }
}

async function fetchConcept(cik, { tag, kind }) {
  const url = `https://data.sec.gov/api/xbrl/companyconcept/CIK${cik}/us-gaap/${tag}.json`
  const res = await fetchWithTimeout(url, { headers: ua() }, 12000)
  if (res.status === 404) throw new Error('not reported via XBRL')
  if (!res.ok) throw new Error(`HTTP ${res.status}`)
  const body = await res.json()
  const usd = body?.units?.USD || []
  const frameRe = kind === 'duration' ? /^CY\d{4}Q\d$/ : /^CY\d{4}Q\dI$/
  const rows = usd
    .filter((r) => r.frame && frameRe.test(r.frame))
    .map((r) => ({ frame: r.frame.replace(/I$/, ''), end: r.end, val: r.val, form: r.form }))
  // De-dupe by frame (keep latest filing), sort chronologically, keep 6 quarters.
  const byFrame = new Map()
  for (const r of rows) byFrame.set(r.frame, r)
  const sorted = [...byFrame.values()].sort((a, b) => (a.end < b.end ? -1 : 1))
  return sorted.slice(-6)
}

function derive(concepts) {
  const out = {}
  const capex = concepts.capexQ
  if (capex?.length >= 2) {
    const last = capex[capex.length - 1], prev = capex[capex.length - 2]
    out.capexLatest = { frame: last.frame, usd: last.val }
    out.capexQoQPct = pct(last.val, prev.val)
    const yoy = capex.find((r) => sameQuarterPrevYear(r.frame, last.frame))
    out.capexYoYPct = yoy ? pct(last.val, yoy.val) : null
  }
  const leaseSeries = mergeLease(concepts.opLease, concepts.finLease)
  if (leaseSeries.length >= 2) {
    const last = leaseSeries[leaseSeries.length - 1], prev = leaseSeries[leaseSeries.length - 2]
    out.leaseLatest = { frame: last.frame, usd: last.val }
    out.leaseQoQPct = pct(last.val, prev.val)
  }
  out.capexSeries = capex || []
  out.leaseSeries = leaseSeries
  return out
}

function mergeLease(op, fin) {
  const map = new Map()
  for (const r of op || []) map.set(r.frame, { frame: r.frame, end: r.end, val: r.val })
  for (const r of fin || []) {
    const hit = map.get(r.frame)
    if (hit) hit.val += r.val
    else map.set(r.frame, { frame: r.frame, end: r.end, val: r.val })
  }
  return [...map.values()].sort((a, b) => (a.end < b.end ? -1 : 1)).slice(-6)
}

function pct(a, b) { return b ? Math.round(((a - b) / Math.abs(b)) * 1000) / 10 : null }
function sameQuarterPrevYear(f, latest) {
  const m = latest.match(/^CY(\d{4})(Q\d)$/)
  return m ? f === `CY${Number(m[1]) - 1}${m[2]}` : false
}
