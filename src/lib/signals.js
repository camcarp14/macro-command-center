// Translates the same live metrics already on screen into plain-English
// descriptions of current market conditions. This is deliberately
// DESCRIPTIVE, not PRESCRIPTIVE: it says what the data currently shows,
// never "buy" or "sell". Every threshold is a plain number in this file —
// nothing hidden, nothing modeled, no confidence score attached.
export const SIGNAL_DEFS = [
  {
    key: 'leverage',
    label: 'Leverage positioning',
    metric: 'funding_ann',
    read(v) {
      if (!Number.isFinite(v)) return null
      if (v >= 20) return { state: 'CROWDED LONG', tone: 'stale', plain: `Perpetual funding is running +${v.toFixed(1)}% annualized — longs are paying a heavy premium to stay leveraged. That level has historically coincided with crowded, one-sided positioning.` }
      if (v <= -5) return { state: 'CROWDED SHORT', tone: 'live', plain: `Funding is negative (${v.toFixed(1)}% annualized) — shorts are paying longs to hold their position. Negative funding this deep is uncommon and typically means short interest is stretched.` }
      return { state: 'BALANCED', tone: 'sync', plain: `Funding sits at ${v.toFixed(1)}% annualized — neither side is paying a big premium to stay leveraged right now.` }
    },
  },
  {
    key: 'sentiment',
    label: 'Crowd sentiment',
    metric: 'fear_greed',
    read(v, m) {
      if (!Number.isFinite(v)) return null
      const label = m?.fg_label || (v <= 25 ? 'Extreme Fear' : v <= 45 ? 'Fear' : v <= 55 ? 'Neutral' : v <= 75 ? 'Greed' : 'Extreme Greed')
      if (v <= 25) return { state: 'EXTREME FEAR', tone: 'live', plain: `Crypto Fear & Greed reads ${v.toFixed(0)} (${label}) — sentiment is near the fearful extreme, a zone many contrarian traders watch, though fear can persist or deepen.` }
      if (v >= 75) return { state: 'EXTREME GREED', tone: 'stale', plain: `Crypto Fear & Greed reads ${v.toFixed(0)} (${label}) — sentiment is near the greedy extreme, a zone often associated with complacency, though greed can persist or extend.` }
      return { state: label.toUpperCase(), tone: 'sync', plain: `Crypto Fear & Greed reads ${v.toFixed(0)} (${label}) — no sentiment extreme in either direction right now.` }
    },
  },
  {
    key: 'credit',
    label: 'Credit market stress',
    metric: 'hy_oas',
    read(v) {
      if (!Number.isFinite(v)) return null
      if (v < 3.2) return { state: 'MARKET CALM', tone: 'live', plain: `High-yield spreads sit at ${v.toFixed(2)}% — tight by historical standards, meaning credit markets aren't pricing in meaningful stress.` }
      if (v < 4.5) return { state: 'MARKET WATCHFUL', tone: 'sync', plain: `High-yield spreads sit at ${v.toFixed(2)}% — a bit wider than calm conditions, worth watching for a further widening trend.` }
      return { state: 'MARKET STRESSED', tone: 'down', plain: `High-yield spreads sit at ${v.toFixed(2)}% — wide by historical standards, meaning credit markets are actively pricing in stress.` }
    },
  },
  {
    key: 'curve',
    label: 'Yield curve shape',
    metric: 'curve_2s10s',
    read(v) {
      if (!Number.isFinite(v)) return null
      if (v < -0.1) return { state: 'INVERTED', tone: 'stale', plain: `The 2s10s spread is ${v.toFixed(2)}pp — the curve is inverted, meaning short-term rates exceed long-term rates. Historically a recession-watch signal, though timing has varied widely.` }
      if (v < 0.15) return { state: 'FLAT', tone: 'sync', plain: `The 2s10s spread is ${v.toFixed(2)}pp — close to flat, sitting right around the inversion line.` }
      return { state: 'NORMAL SLOPE', tone: 'live', plain: `The 2s10s spread is ${v.toFixed(2)}pp — a normal, positively sloped curve.` }
    },
  },
  {
    key: 'fed',
    label: 'Fed policy stance',
    metric: 'policy_gap',
    read(v) {
      if (!Number.isFinite(v)) return null
      if (v > 1.5) return { state: 'RESTRICTIVE', tone: 'stale', plain: `Fed funds sits ${v.toFixed(2)}pp above the ~2.5% neutral estimate — policy is actively restrictive, weighing on liquidity and risk assets.` }
      if (v > 0.25) return { state: 'MILDLY RESTRICTIVE', tone: 'sync', plain: `Fed funds sits ${v.toFixed(2)}pp above neutral — mildly tight, not aggressively so.` }
      return { state: 'NEAR NEUTRAL', tone: 'live', plain: `Fed funds sits close to the neutral estimate (${v.toFixed(2)}pp above) — policy isn't leaning hard in either direction.` }
    },
  },
  {
    key: 'position',
    label: 'Your position cushion',
    metric: 'aave_hf',
    read(v) {
      if (!Number.isFinite(v)) return null
      if (v < 1.25) return { state: 'AT RISK', tone: 'down', plain: `Your Aave health factor is ${v.toFixed(2)} — thin cushion. A moderate further BTC drop could put this near liquidation; see the Positions tab for exact levels.` }
      if (v < 1.6) return { state: 'WATCH', tone: 'stale', plain: `Your Aave health factor is ${v.toFixed(2)} — a reasonable cushion, but worth checking the stress table on the Positions tab.` }
      return { state: 'SAFE', tone: 'live', plain: `Your Aave health factor is ${v.toFixed(2)} — comfortable distance from liquidation under normal conditions.` }
    },
  },
]

export function buildMarketRead(metrics) {
  return SIGNAL_DEFS
    .map((def) => {
      const r = def.read(metrics?.[def.metric], metrics)
      return r ? { key: def.key, label: def.label, ...r } : null
    })
    .filter(Boolean)
}
