// The directive composer — one plain-English "DO THIS" with its reasons.
// Pure composition over precomputed inputs; imports nothing. The priority
// ladder is law: first match wins, and safety rungs outrank opportunity
// rungs, so a stop breach can never be talked over by a fresh trigger.

export function composeDirective(input = {}) {
  const {
    price = null,
    freshQuote = { state: 'dead' },
    freshBtc = { state: 'dead' },
    regime = { state: 'insufficient_data', facts: [] },
    btcAlign = { aligned: false, state: 'insufficient_data', facts: [] },
    pullback = { stage: 'none', facts: [] },
    breakout = { active: false, facts: [] },
    exitFlags = [],
    position = null,
    effectiveStop = null,
    r = null,
    sizing = null,
    addSizing = null,
    torque = null,
    marketSession = 'open',
  } = input

  const guardrails = []
  if (freshQuote.state !== 'live') guardrails.push(`MSTR data is ${freshQuote.state} — treat every number below with suspicion`)
  if (freshBtc.state !== 'live') guardrails.push(`BTC data is ${freshBtc.state}`)
  if (torque?.read?.grade === 'rich') guardrails.push(`torque is RICH: ${torque.read.text} — you're paying up for the leverage`)
  if (marketSession === 'closed') guardrails.push('market closed (approx NYSE hours) — prices are last session\'s')

  const dead = freshQuote.state === 'dead'
  const stopDistPct = position && Number.isFinite(effectiveStop) && Number.isFinite(price) && price > 0
    ? ((price - effectiveStop) / price) * 100
    : null

  // 1 — no data
  if (price == null || dead) {
    return out('NO_DATA', 'Stand down — the data is dead, not the market.', [
      'No trustworthy MSTR price right now.',
      position ? 'You have an open position: check your broker directly, do not trust this screen.' : 'No position open; nothing to protect.',
    ], guardrails, position ? 'urgent' : 'info')
  }

  const hard = exitFlags.filter((f) => f.severity === 'hard')
  const soft = exitFlags.filter((f) => f.severity === 'soft')
  const breach = exitFlags.find((f) => f.id === 'stop_breach')

  // 2 — stop breach
  if (position && breach) {
    return out('STOP_OUT', `Sell ${position.shares} MSTR now — the stop is hit.`, [
      breach.fact,
      rLine(r),
      'The plan only works if the stop is real. Execute it.',
    ], guardrails, 'urgent')
  }

  // 3 — other hard exits
  if (position && hard.length > 0) {
    return out('EXIT', `Close the position — trend structure is gone.`, [
      ...hard.map((f) => f.fact),
      rLine(r),
    ], guardrails, 'urgent')
  }

  // 4 — soft flags → trim
  if (position && soft.length > 0) {
    return out('TRIM', `Take some off — momentum is wobbling, structure still holds.`, [
      ...soft.map((f) => f.fact),
      rLine(r),
      stopLine(effectiveStop, stopDistPct),
    ], guardrails, 'act')
  }

  // 5 — pyramid add
  if (
    position && pullback.stage === 'trigger' && regime.state === 'uptrend' && btcAlign.aligned &&
    Number.isFinite(effectiveStop) && Number.isFinite(position.avgEntry) && effectiveStop >= position.avgEntry &&
    addSizing?.ok
  ) {
    return out('ADD', `Add ${addSizing.shares} shares — pullback trigger with the stop already at breakeven.`, [
      ...pullback.facts,
      `add risk: $${fmtUsd(addSizing.riskUsd)} (${addSizing.shares} shares); original position now risk-free vs blended entry`,
      stopLine(effectiveStop, stopDistPct),
    ], guardrails, 'act')
  }

  // 6 — hold
  if (position) {
    return out('HOLD', `Hold ${position.shares} MSTR — let the trail do the work.`, [
      rLine(r),
      stopLine(effectiveStop, stopDistPct),
      regime.state === 'uptrend' ? `regime: uptrend (${regime.score}/100)` : `regime: ${regime.state} (${regime.score}/100) — watch it`,
      btcAlign.aligned ? 'BTC confirms' : `BTC not confirming (${btcAlign.state})`,
    ], guardrails, 'info')
  }

  // 7 — entry
  const trigger = pullback.stage === 'trigger' ? 'pullback' : breakout.active ? 'breakout' : null
  if (regime.state === 'uptrend' && btcAlign.aligned && trigger && sizing?.ok) {
    return out('ENTER', `Buy ${sizing.shares} MSTR on the ${trigger} trigger.`, [
      ...(trigger === 'pullback' ? pullback.facts : breakout.facts),
      `size: ${sizing.shares} shares ≈ $${fmtUsd(sizing.positionUsd)} (${sizing.positionPct}% of equity)${sizing.capped ? ' — CAPPED by max position size' : ''}`,
      `risk if stopped: $${fmtUsd(sizing.riskUsd)}`,
      `regime ${regime.score}/100 · BTC aligned (${btcAlign.score}/100)`,
    ], guardrails, 'act')
  }

  // 8 — uptrend but BTC not confirming
  if (regime.state === 'uptrend' && !btcAlign.aligned) {
    return out('STAND_ASIDE', 'MSTR trends up but BTC is not confirming — this is a BTC-beta trade.', [
      `BTC regime: ${btcAlign.state} (${btcAlign.score ?? '—'}/100)`,
      'Without the underlying moving, MSTR upside is premium expansion — thinner air, tighter risk.',
    ], guardrails, 'info')
  }

  // 9 — default
  const why = regime.state === 'uptrend'
    ? 'Uptrend, but no trigger yet — wait for a pullback reclaim or a breakout.'
    : `Regime is ${regime.state} — no long edge. Cash is a position.`
  return out('STAND_ASIDE', why, [
    ...(regime.facts || []).slice(0, 3),
    pullback.stage === 'setup' ? 'Pullback setup forming — a close above the prior bar\'s high arms the entry.' : null,
  ].filter(Boolean), guardrails, 'info')
}

function out(action, headline, reasons, guardrails, severity) {
  return { action, headline, reasons: reasons.filter(Boolean), guardrails, severity }
}
function rLine(r) {
  if (!Number.isFinite(r)) return null
  return `open R: ${r >= 0 ? '+' : ''}${Math.round(r * 100) / 100}R`
}
function stopLine(stop, distPct) {
  if (!Number.isFinite(stop)) return 'no effective stop computed — fix this before anything else'
  return `stop ${Math.round(stop * 100) / 100}${Number.isFinite(distPct) ? ` (${Math.round(distPct * 10) / 10}% below price)` : ''}`
}
function fmtUsd(x) {
  return Number.isFinite(x) ? Math.round(x).toLocaleString('en-US') : '—'
}
