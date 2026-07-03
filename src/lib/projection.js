// Bear / base / bull, done honestly: a volatility-implied range cone, not a
// price forecast. Assumptions are few and stated:
//   • daily log returns ~ N(0, σ²) with σ from realized 30d vol
//   • zero drift for the base path (we do not pretend to know direction)
//   • the current vol regime persists over the horizon (it often doesn't)
// Bands scale with √t. "Bull" = +1σ cumulative path, "bear" = −1σ; the 95%
// band is ±1.96σ. BTC has repeatedly closed outside these bands — that is a
// property of the asset, and this chart says so on its face.
export function projectionCone({ lastPrice, realizedVolPct, horizonDays, startTs = Date.now() }) {
  if (!Number.isFinite(lastPrice) || !Number.isFinite(realizedVolPct) || !Number.isFinite(horizonDays) || horizonDays < 1) return null
  const sigmaDaily = realizedVolPct / 100 / Math.sqrt(365)
  const days = []
  for (let t = 0; t <= horizonDays; t++) {
    const s = sigmaDaily * Math.sqrt(t)
    days.push({
      t: startTs + t * 86400000,
      base: round(lastPrice),
      bull1s: round(lastPrice * Math.exp(1 * s)),
      bear1s: round(lastPrice * Math.exp(-1 * s)),
      up95: round(lastPrice * Math.exp(1.96 * s)),
      dn95: round(lastPrice * Math.exp(-1.96 * s)),
    })
  }
  const end = days[days.length - 1]
  return {
    days,
    sigmaDailyPct: +(sigmaDaily * 100).toFixed(2),
    summary: {
      horizonDays,
      base: end.base,
      bull1s: end.bull1s,
      bear1s: end.bear1s,
      up95: end.up95,
      dn95: end.dn95,
      band68Pct: +(((end.bull1s - end.bear1s) / 2 / lastPrice) * 100).toFixed(1),
    },
    caveat: 'Volatility-implied ranges assuming zero drift and that the current 30-day vol regime persists. This is a distribution, not a forecast — BTC has repeatedly closed outside these bands.',
  }
}

function round(v) { return Math.round(v) }
