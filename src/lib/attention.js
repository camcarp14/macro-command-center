// The Attention Stack: the app's single synthesized answer to "what needs
// my attention right now", built from every subsystem with explicit
// priority rules. Descriptive throughout — it directs attention, never
// capital. An honest "nothing needs you" is a first-class outcome.
//
// Priorities:
//   P0  position health entering DANGER/CRITICAL
//   P1  any setup fully ACTIVE
//   P2  a setup one condition from active (nothing unknown)
//   P3  intraday tape trending (15m) · macro band above benign
//   P4  notable movement since last look
//   —   quiet state if nothing above

export function hfBandName(hf) {
  if (!Number.isFinite(hf)) return null
  if (hf < 1.1) return 'CRITICAL'
  if (hf < 1.25) return 'DANGER'
  if (hf < 1.5) return 'WATCH'
  return 'OK'
}

export function buildAttention({ metrics = {}, score = null, bandName = null, setups = [], regime = null, changeLine = null } = {}) {
  const items = []
  const hf = metrics.aave_hf
  const band = hfBandName(hf)

  if (band === 'CRITICAL' || band === 'DANGER') {
    items.push({ priority: 0, tone: 'down', title: `Position health: ${band}`, body: `Aave health factor is ${hf.toFixed(3)} — liquidation sits ≈ ${Number.isFinite(metrics.aave_liq_dd) ? metrics.aave_liq_dd.toFixed(1) : '?'}% below spot. The Position tab has the stress levels.` })
  } else if (band === 'WATCH') {
    items.push({ priority: 3, tone: 'stale', title: 'Position health: WATCH', body: `Health factor ${hf.toFixed(3)} — cushion is thinner than comfortable. Worth a look at the Position tab.` })
  }

  for (const su of setups) {
    if (su.active) {
      items.push({ priority: 1, tone: 'live', title: `Setup ACTIVE: ${su.name}`, body: `All ${su.total} conditions currently hold. The checklist and trigger record are on the Trade Desk.` })
    } else if (su.unknown === 0 && su.met === su.total - 1) {
      const missing = su.conditions.find((c) => c.met === false)
      items.push({ priority: 2, tone: 'watch', title: `One condition from active: ${su.name}`, body: `Only "${missing?.label}" is unmet (currently ${missing?.valueText}).` })
    }
  }

  if (regime && (regime.state === 'TRENDING UP' || regime.state === 'TRENDING DOWN')) {
    items.push({ priority: 3, tone: regime.tone, title: `15m tape: ${regime.state}`, body: regime.plain })
  }

  if (bandName && bandName !== 'benign' && Number.isFinite(score)) {
    items.push({ priority: 3, tone: bandName === 'stress' ? 'down' : 'stale', title: `Macro pressure: ${bandName.toUpperCase()} (${score.toFixed(0)}/100)`, body: 'The formula breakdown on Overview shows which input is driving it.' })
  }

  if (changeLine) items.push({ priority: 4, tone: 'sync', title: 'Since you last looked', body: changeLine })

  items.sort((a, b) => a.priority - b.priority)
  if (items.length === 0) {
    const posWord = band === 'OK' ? 'position cushion is comfortable' : band ? `position ${band}` : 'no position data'
    items.push({ priority: 9, tone: 'sync', title: 'Nothing needs your attention', body: `No setups active or near-active, macro reads ${bandName ?? '—'}${Number.isFinite(score) ? ` (${score.toFixed(0)}/100)` : ''}, ${posWord}. A quiet tape is a valid answer.` })
  }
  return items.slice(0, 5)
}
