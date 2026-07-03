// Named market setups: each is a transparent checklist of conditions over
// the SAME live metrics already on screen, plus BTC historical stats.
// A setup being ACTIVE means "these conditions currently coexist" — a
// historically notable state, described honestly. It is never an
// instruction. Track record accrues in the trigger log so each setup can
// be judged on evidence, not vibes.
//
// ctx = { m: metrics map, btc: computeBtcStats() output (may be null) }
// Every condition returns { met: boolean|null, valueText } — null met means
// the underlying data is missing, and the setup can't be ACTIVE with an
// unknown leg (unknown ≠ met; we fail closed).

const fmt = (v, dp = 1) => (Number.isFinite(v) ? v.toFixed(dp) : '—')

export const SETUPS = [
  {
    key: 'contrarian_btc',
    name: 'Contrarian accumulation conditions — BTC',
    stance: 'risk-on watch',
    conditions: [
      { label: 'Sentiment at fearful extreme (F&G ≤ 25)', eval: ({ m }) => bool(m.fear_greed, (v) => v <= 25, `F&G ${fmt(m.fear_greed, 0)}`) },
      { label: 'Leverage flushed (funding ≤ +2% ann)', eval: ({ m }) => bool(m.funding_ann, (v) => v <= 2, `funding ${fmt(m.funding_ann)}% ann`) },
      { label: 'No credit contagion (HY OAS < 3.5%)', eval: ({ m }) => bool(m.hy_oas, (v) => v < 3.5, `HY OAS ${fmt(m.hy_oas, 2)}%`) },
      { label: 'Meaningful drawdown (≥ 15% below 365d high)', eval: ({ btc }) => bool(btc?.drawdownFromHighPct, (v) => v <= -15, `${fmt(btc?.drawdownFromHighPct)}% from high`) },
    ],
    note: 'Fear, flushed leverage, and a real drawdown — while credit stays calm — is the combination contrarian frameworks historically associate with accumulation zones more often than tops. It is a conditions read, not a timing signal: fear regimes can persist or deepen.',
  },
  {
    key: 'froth_btc',
    name: 'Froth / de-risk conditions — BTC',
    stance: 'risk-off watch',
    conditions: [
      { label: 'Sentiment at greedy extreme (F&G ≥ 75)', eval: ({ m }) => bool(m.fear_greed, (v) => v >= 75, `F&G ${fmt(m.fear_greed, 0)}`) },
      { label: 'Longs paying up (funding ≥ +15% ann)', eval: ({ m }) => bool(m.funding_ann, (v) => v >= 15, `funding ${fmt(m.funding_ann)}% ann`) },
      { label: 'Extended vs trend (≥ 25% above 200d MA)', eval: ({ btc }) => bool(btc?.distFromMA200Pct, (v) => v >= 25, `${fmt(btc?.distFromMA200Pct)}% vs 200d MA`) },
    ],
    note: 'Greed, expensive leverage, and price stretched far above trend have historically clustered around overheated phases that later corrected — though extended markets can extend further. Historically the mirror-image of the accumulation read.',
  },
  {
    key: 'credit_break',
    name: 'Credit regime break — bear-thesis trigger',
    stance: 'thesis payoff watch',
    conditions: [
      { label: 'HY spreads at stress level (OAS ≥ 4.0%)', eval: ({ m }) => bool(m.hy_oas, (v) => v >= 4.0, `HY OAS ${fmt(m.hy_oas, 2)}%`) },
      { label: 'Widening with momentum (+0.50pp over 4 weeks)', eval: ({ m }) => bool(m.hy_oas_4w_chg, (v) => v >= 0.5, `${fmt(m.hy_oas_4w_chg, 2)}pp / 4w`) },
      { label: 'Curve bull-steepening (2s10s ≥ +0.50pp)', eval: ({ m }) => bool(m.curve_2s10s, (v) => v >= 0.5, `2s10s ${fmt(m.curve_2s10s, 2)}pp`) },
    ],
    note: 'Spreads at stress levels AND widening fast AND a steepening curve is the state in which credit stops ignoring problems — the environment your AI-bubble / hawkish-Fed thesis needs to pay. Right now this panel measures how far conditions are from that state.',
  },
  {
    key: 'pivot_watch',
    name: 'Policy pivot risk window',
    stance: 'regime-change watch',
    conditions: [
      { label: 'Fed near/through neutral (gap ≤ 0.75pp)', eval: ({ m }) => bool(m.policy_gap, (v) => v <= 0.75, `gap ${fmt(m.policy_gap, 2)}pp`) },
      { label: 'Curve steepened out of inversion (2s10s ≥ 0.60pp)', eval: ({ m }) => bool(m.curve_2s10s, (v) => v >= 0.6, `2s10s ${fmt(m.curve_2s10s, 2)}pp`) },
      { label: 'Credit starting to reflect it (HY OAS ≥ 3.5%)', eval: ({ m }) => bool(m.hy_oas, (v) => v >= 3.5, `HY OAS ${fmt(m.hy_oas, 2)}%`) },
    ],
    note: '"The cut is the signal": historically, the dangerous window for risk assets is not peak rates but when cutting begins while the curve steepens and credit widens. Descriptive pattern, not destiny — soft landings exist.',
  },
]

function bool(v, test, valueText) {
  if (!Number.isFinite(v)) return { met: null, valueText: 'no data' }
  return { met: !!test(v), valueText }
}

export function evaluateSetups(ctx) {
  return SETUPS.map((s) => {
    const conditions = s.conditions.map((c) => ({ label: c.label, ...c.eval(ctx) }))
    const known = conditions.filter((c) => c.met !== null)
    const met = conditions.filter((c) => c.met === true).length
    const unknown = conditions.length - known.length
    const active = unknown === 0 && met === conditions.length // fail closed on missing data
    return { key: s.key, name: s.name, stance: s.stance, note: s.note, conditions, met, total: conditions.length, unknown, active }
  })
}

// One-line summary (used by tests; the Overview Attention Stack supersedes it in the UI).
export function setupsSummary(evaluated) {
  if (!evaluated?.length) return null
  const active = evaluated.filter((e) => e.active)
  if (active.length) return `${active.length} setup${active.length > 1 ? 's' : ''} ACTIVE: ${active.map((a) => a.name).join(' · ')}`
  const closest = [...evaluated].sort((a, b) => (b.met / b.total) - (a.met / a.total))[0]
  return `No setups active · closest: ${closest.name} (${closest.met} of ${closest.total} conditions)`
}
