// The directive composer — one plain-English "DO THIS" with its reasons.
// Pure composition over precomputed inputs; imports nothing. The priority
// ladder is law: first match wins, and safety rungs outrank opportunity
// rungs, so a stop breach can never be talked over by a fresh trigger.
// New risk (ENTER/ADD) requires EVERY feed alive: quote, BTC, and candles —
// a dead input never buys anything, and a live trigger that can't act
// says so instead of pretending it never fired.

export function composeDirective(input = {}) {
  const {
    price = null,
    freshQuote = { state: 'dead' },
    freshBtc = { state: 'dead' },
    freshCandles = { state: 'dead' },
    freshBtcCandles = { state: 'dead' },
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
  if (freshCandles.state !== 'live') guardrails.push(`price history is ${freshCandles.state} — regime and trigger reads are running on old tape`)
  if (freshBtcCandles.state !== 'live') guardrails.push(`BTC history is ${freshBtcCandles.state} — the BTC-confirmation read is running on old tape`)
  if (torque?.read?.grade === 'rich') guardrails.push(`torque is RICH: ${torque.read.text} — you're paying up for the leverage`)
  if (marketSession === 'closed') guardrails.push('market closed (approx NYSE hours) — prices are last session\'s')

  const stopDistPct = position && Number.isFinite(effectiveStop) && Number.isFinite(price) && price > 0
    ? ((price - effectiveStop) / price) * 100
    : null

  // 1 — no data
  if (price == null || freshQuote.state === 'dead') {
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

  // Feeds that must be alive before ANY new risk goes on. BTC candles are
  // included: btcAlign is computed FROM them, so a dead btc-candle feed
  // means the alignment gate itself is running blind.
  const deadFeeds = [
    freshBtc.state === 'dead' && 'BTC',
    freshCandles.state === 'dead' && 'price history',
    freshBtcCandles.state === 'dead' && 'BTC history',
  ].filter(Boolean)

  // 5 — pyramid add (spec conditions; blocked adds surface in HOLD, not silence)
  const addSpecMet = position && pullback.stage === 'trigger' && regime.state === 'uptrend' && btcAlign.aligned &&
    Number.isFinite(effectiveStop) && Number.isFinite(position.avgEntry) && effectiveStop >= position.avgEntry
  if (addSpecMet && deadFeeds.length === 0 && addSizing?.ok) {
    return out('ADD', `Add ${addSizing.shares} shares — pullback trigger with the stop already at breakeven.`, [
      ...pullback.facts,
      `add risk: $${fmtUsd(addSizing.riskUsd)} (${addSizing.shares} shares); original position now risk-free vs blended entry`,
      stopLine(effectiveStop, stopDistPct),
    ], guardrails, 'act')
  }

  // 6 — hold
  if (position) {
    const addBlocked = addSpecMet
      ? deadFeeds.length > 0
        ? `add trigger active but blocked: ${deadFeeds.join(' + ')} feed dead — no new risk on blind data`
        : `add trigger active but blocked: ${addSizing?.error ?? 'sizing unavailable'}`
      : null
    return out('HOLD', `Hold ${position.shares} MSTR — let the trail do the work.`, [
      addBlocked,
      rLine(r),
      stopLine(effectiveStop, stopDistPct),
      regime.state === 'uptrend' ? `regime: uptrend (${regime.score}/100)` : `regime: ${regime.state} (${regime.score}/100) — watch it`,
      btcAlign.aligned ? 'BTC confirms' : `BTC not confirming (${btcAlign.state})`,
    ], guardrails, 'info')
  }

  // 7 — entry (flat): a live trigger either sizes cleanly or explains itself
  const trigger = pullback.stage === 'trigger' ? 'pullback' : breakout.active ? 'breakout' : null
  if (regime.state === 'uptrend' && btcAlign.aligned && trigger) {
    if (deadFeeds.length > 0) {
      return out('STAND_ASIDE', `A ${trigger} trigger is live but ${deadFeeds.join(' and ')} ${deadFeeds.length > 1 ? 'feeds are' : 'feed is'} dead — no new risk on blind data.`, [
        ...(trigger === 'pullback' ? pullback.facts : breakout.facts),
        'Fix the feed (Settings → Data sources), then re-read the trigger.',
      ], guardrails, 'info')
    }
    if (!sizing?.ok) {
      return out('STAND_ASIDE', `A ${trigger} trigger is live but the position can't be sized.`, [
        ...(trigger === 'pullback' ? pullback.facts : breakout.facts),
        `blocker: ${sizingErrorText(sizing?.error)}`,
      ], guardrails, 'info')
    }
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

  // 9 — default (genuinely no trigger, or no long edge)
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
function sizingErrorText(code) {
  return {
    risk_too_small_for_one_share: 'risk budget too small for one whole share at this stop distance',
    stop_not_below_entry: 'computed stop is not below the entry price',
    bad_input: 'sizing inputs incomplete',
  }[code] ?? (code || 'risk settings unavailable')
}
function fmtUsd(x) {
  return Number.isFinite(x) ? Math.round(x).toLocaleString('en-US') : '—'
}
