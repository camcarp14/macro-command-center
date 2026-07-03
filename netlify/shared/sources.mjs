// Every external data source, as a plain async function. The HTTP endpoints
// wrap these; the scheduled snapshot imports them directly (no self-HTTP,
// no auth loopback). All keys stay server-side.
import { createPublicClient, http, parseAbi } from 'viem'
import { fetchWithTimeout } from './util.mjs'

// ---------------- FRED ----------------
export const FRED_SERIES = ['DGS10', 'DGS2', 'DFF', 'DTWEXBGS', 'BAMLH0A0HYM2', 'WALCL']

export async function fetchFred(seriesList = FRED_SERIES, limit = 130) {
  const key = process.env.FRED_API_KEY
  if (!key) throw new Error('FRED_API_KEY is not configured')
  const bad = seriesList.filter((s) => !FRED_SERIES.includes(s))
  if (bad.length) throw new Error(`Series not in whitelist: ${bad.join(',')}`)

  const results = await Promise.all(
    seriesList.map(async (id) => {
      const url = `https://api.stlouisfed.org/fred/series/observations?series_id=${id}&api_key=${key}&file_type=json&sort_order=desc&limit=${limit}`
      const res = await fetchWithTimeout(url)
      if (!res.ok) throw new Error(`FRED ${id} HTTP ${res.status}`)
      const body = await res.json()
      const obs = (body.observations || []).map((o) => ({ d: o.date, v: o.value === '.' ? null : Number(o.value) }))
      return [id, obs]
    })
  )
  return { series: Object.fromEntries(results) }
}

// ---------------- CoinGecko (BTC spot) ----------------
export async function fetchMarket() {
  const headers = { accept: 'application/json' }
  if (process.env.COINGECKO_API_KEY) headers['x-cg-demo-api-key'] = process.env.COINGECKO_API_KEY
  const url = 'https://api.coingecko.com/api/v3/simple/price?ids=bitcoin&vs_currencies=usd&include_market_cap=true&include_24hr_change=true&include_last_updated_at=true'
  const res = await fetchWithTimeout(url, { headers })
  if (!res.ok) throw new Error(`CoinGecko HTTP ${res.status}`)
  const body = await res.json()
  const b = body.bitcoin
  if (!b || !Number.isFinite(b.usd)) throw new Error('CoinGecko returned no bitcoin price')
  return {
    btc: b.usd,
    btc24hPct: Number.isFinite(b.usd_24h_change) ? round(b.usd_24h_change, 2) : null,
    marketCap: b.usd_market_cap ?? null,
    dataAsOf: b.last_updated_at ? b.last_updated_at * 1000 : null,
  }
}

// ---------------- BTC perp funding ----------------
// Primary: Deribit public ticker (accessible from US infra).
// Fallback: Binance premiumIndex — documented as geo-blocked (HTTP 451) from
// US IPs, which is where Netlify functions typically run; kept for non-US
// self-hosting. The payload always names which venue produced the number.
export async function fetchFunding() {
  const attempts = []
  try {
    const res = await fetchWithTimeout('https://www.deribit.com/api/v2/public/ticker?instrument_name=BTC-PERPETUAL')
    if (!res.ok) throw new Error(`Deribit HTTP ${res.status}`)
    const body = await res.json()
    const r = body.result
    if (!r || !Number.isFinite(r.funding_8h)) throw new Error('Deribit ticker missing funding_8h')
    return {
      venue: 'deribit',
      instrument: 'BTC-PERPETUAL',
      funding8h: r.funding_8h,                    // decimal per 8h, e.g. 0.0001
      fundingAnnualizedPct: round(r.funding_8h * 3 * 365 * 100, 2),
      markPrice: r.mark_price ?? null,
      indexPrice: r.index_price ?? null,
      openInterest: r.open_interest ?? null,
      dataAsOf: r.timestamp ?? null,
      sourceDetail: 'deribit',
    }
  } catch (e) {
    attempts.push(`deribit: ${e.message}`)
  }
  try {
    const res = await fetchWithTimeout('https://fapi.binance.com/fapi/v1/premiumIndex?symbol=BTCUSDT')
    if (!res.ok) throw new Error(`Binance HTTP ${res.status}${res.status === 451 ? ' (geo-restricted)' : ''}`)
    const r = await res.json()
    const f = Number(r.lastFundingRate)
    if (!Number.isFinite(f)) throw new Error('Binance premiumIndex missing lastFundingRate')
    return {
      venue: 'binance',
      instrument: 'BTCUSDT-PERP',
      funding8h: f,
      fundingAnnualizedPct: round(f * 3 * 365 * 100, 2),
      markPrice: Number(r.markPrice) || null,
      indexPrice: Number(r.indexPrice) || null,
      openInterest: null,
      dataAsOf: r.time ?? null,
      sourceDetail: 'binance-fallback',
    }
  } catch (e) {
    attempts.push(`binance: ${e.message}`)
  }
  throw new Error(`All funding venues failed — ${attempts.join(' | ')}`)
}

// ---------------- Fear & Greed ----------------
export async function fetchFearGreed() {
  const res = await fetchWithTimeout('https://api.alternative.me/fng/?limit=1&format=json')
  if (!res.ok) throw new Error(`alternative.me HTTP ${res.status}`)
  const body = await res.json()
  const d = body?.data?.[0]
  const v = Number(d?.value)
  if (!Number.isFinite(v)) throw new Error('Fear & Greed returned no value')
  return { value: v, classification: d.value_classification ?? null, dataAsOf: d.timestamp ? Number(d.timestamp) * 1000 : null }
}

// ---------------- Aave V3 (Arbitrum) ----------------
// Aave V3 Pool proxy on Arbitrum One (verified on Arbiscan, "Aave: Pool V3").
// getUserAccountData returns totals in the oracle base currency = USD, 8 dp;
// healthFactor is WAD (1e18); liquidation threshold is bps.
const AAVE_POOL_ARBITRUM = '0x794a61358D6845594F94dc1DB02A252b5b4814aD'
const POOL_ABI = parseAbi([
  'function getUserAccountData(address user) view returns (uint256 totalCollateralBase, uint256 totalDebtBase, uint256 availableBorrowsBase, uint256 currentLiquidationThreshold, uint256 ltv, uint256 healthFactor)',
])

export async function fetchAave() {
  const wallet = process.env.AAVE_WALLET_ADDRESS
  if (!wallet || !/^0x[0-9a-fA-F]{40}$/.test(wallet)) {
    throw new Error('AAVE_WALLET_ADDRESS is not configured (set it in Netlify env vars)')
  }
  const rpc = process.env.ARBITRUM_RPC_URL || 'https://arb1.arbitrum.io/rpc'
  const client = createPublicClient({ transport: http(rpc, { timeout: 9000 }) })
  const [collateral, debt, availableBorrows, liqThresholdBps, ltvBps, hfWad] = await client.readContract({
    address: AAVE_POOL_ARBITRUM,
    abi: POOL_ABI,
    functionName: 'getUserAccountData',
    args: [wallet],
  })
  const base = (x) => Number(x) / 1e8 // USD, 8 decimals
  const hf = debt === 0n ? null : Number(hfWad) / 1e18 // no debt => HF is uint max; report null ("no debt")
  return {
    network: 'arbitrum',
    pool: AAVE_POOL_ARBITRUM,
    collateralUsd: round(base(collateral), 2),
    debtUsd: round(base(debt), 2),
    availableBorrowsUsd: round(base(availableBorrows), 2),
    liquidationThresholdPct: Number(liqThresholdBps) / 100,
    ltvPct: Number(ltvBps) / 100,
    healthFactor: hf === null ? null : round(hf, 4),
    noDebt: debt === 0n,
  }
}

function round(n, dp) {
  const f = 10 ** dp
  return Math.round(n * f) / f
}

// ---------------- CoinGecko (BTC daily history, 365d) ----------------
export async function fetchBtcHistory() {
  const headers = { accept: 'application/json' }
  if (process.env.COINGECKO_API_KEY) headers['x-cg-demo-api-key'] = process.env.COINGECKO_API_KEY
  const url = 'https://api.coingecko.com/api/v3/coins/bitcoin/market_chart?vs_currency=usd&days=365&interval=daily'
  const res = await fetchWithTimeout(url, { headers }, 15000)
  if (!res.ok) throw new Error(`CoinGecko history HTTP ${res.status}`)
  const body = await res.json()
  const prices = (body.prices || []).filter((p) => Array.isArray(p) && Number.isFinite(p[1]))
  if (prices.length < 30) throw new Error(`CoinGecko history returned only ${prices.length} points`)
  return { prices }
}

// Blob-cached wrapper (6h TTL) shared by the endpoint and the snapshot cron,
// so we hit CoinGecko's history route at most ~4x/day.
export async function getBtcHistoryCached(store, { maxAgeMs = 6 * 3600 * 1000, refresh = false } = {}) {
  const cached = await store.get('btc_history', { type: 'json' }).catch(() => null)
  const fresh = cached && Date.now() - cached.fetchedAt < maxAgeMs
  if (fresh && !refresh) return { ...cached, cache: 'hit' }
  try {
    const { prices } = await fetchBtcHistory()
    const payload = { fetchedAt: Date.now(), prices }
    await store.setJSON('btc_history', payload)
    return { ...payload, cache: refresh ? 'refreshed' : 'miss' }
  } catch (e) {
    if (cached) return { ...cached, cache: 'stale-after-error', staleError: String(e?.message || e) }
    throw e
  }
}
