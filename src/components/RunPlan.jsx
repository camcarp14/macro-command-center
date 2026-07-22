// Run preparation UI: the radar (what arms the buy, with price distances),
// the battle plan (pre-computed tickets + the campaign ladder), and the
// thesis-break levels (what retires the plan). Bias lives in what we watch;
// evidence decides what fires.
import React, { useMemo } from 'react'
import { armChecklist, triggerTickets, thesisBreaks } from '../lib/runplan.js'
import { fmtPx } from '../lib/format.js'

export default function RunPlan({ derived, settings, position }) {
  const radar = useMemo(
    () => armChecklist(derived.mstrCandles, derived.btcCandles),
    [derived.mstrCandles, derived.btcCandles],
  )
  const tickets = useMemo(
    () => triggerTickets({ mstrCandles: derived.mstrCandles, settings, forAdd: !!position }),
    [derived.mstrCandles, settings, position],
  )
  const breaks = useMemo(
    () => thesisBreaks(derived.mstrCandles, derived.btcCandles),
    [derived.mstrCandles, derived.btcCandles],
  )

  if (radar.insufficient) return null

  return (
    <>
      <section className="card span2" data-testid="run-radar">
        <div className="ttl">Run radar — what arms the buy
          <span className="spacer" />
          {radar.armed
            ? <span className="chip live"><span className="dot" />ARMED</span>
            : radar.ready
              ? <span className="chip live"><span className="dot" />ready — waiting on a trigger</span>
              : <span className="chip"><span className="dot" />not armed</span>}
        </div>
        <div className="radar-cols">
          <div>
            <div className="tiny" style={{ marginBottom: 6, fontWeight: 700 }}>MSTR REGIME ({radar.regime.score}/100 — needs ≥ 70)</div>
            <ul className="radar-list">
              {radar.mstr.map((c) => (
                <li key={c.id} className={c.pass ? 'pass' : 'fail'}>
                  <span className="mark" aria-hidden>{c.pass ? '✓' : '○'}</span>
                  <span>
                    {c.label}
                    {!c.pass && c.distancePct != null && <span className="dist num"> +{c.distancePct}% away</span>}
                    {!c.pass && c.note && <span className="tiny note"> — {c.note}</span>}
                  </span>
                </li>
              ))}
            </ul>
          </div>
          <div>
            <div className="tiny" style={{ marginBottom: 6, fontWeight: 700 }}>BTC CONFIRMATION</div>
            <ul className="radar-list">
              <li className={radar.btc.pass ? 'pass' : 'fail'}>
                <span className="mark" aria-hidden>{radar.btc.pass ? '✓' : '○'}</span>
                <span>
                  BTC regime uptrend (now {radar.btc.state} {radar.btc.score ?? '—'})
                  {!radar.btc.pass && radar.btc.distancePct != null && <span className="dist num"> 50-day ≈ {fmtPx(radar.btc.level)} · +{radar.btc.distancePct}% away</span>}
                  {!radar.btc.pass && radar.btc.note && <span className="tiny note"> — {radar.btc.note}</span>}
                </span>
              </li>
            </ul>
            <div className="tiny" style={{ margin: '10px 0 6px', fontWeight: 700 }}>TRIGGER PATHS</div>
            <ul className="radar-list">
              <li className={radar.paths.breakout.active ? 'pass' : 'fail'}>
                <span className="mark" aria-hidden>{radar.paths.breakout.active ? '✓' : '○'}</span>
                <span>breakout: close above {fmtPx(radar.paths.breakout.level)}
                  {!radar.paths.breakout.active && radar.paths.breakout.distancePct != null && <span className="dist num"> +{radar.paths.breakout.distancePct}%</span>}
                </span>
              </li>
              <li className={radar.paths.pullback.stage === 'trigger' ? 'pass' : 'fail'}>
                <span className="mark" aria-hidden>{radar.paths.pullback.stage === 'trigger' ? '✓' : '○'}</span>
                <span>pullback: {radar.paths.pullback.stage === 'none'
                  ? radar.regime.state === 'uptrend'
                    ? 'uptrend intact — waiting for a dip into the EMA20 zone'
                    : 'needs an uptrend first — then a dip to EMA20 that holds'
                  : radar.paths.pullback.stage === 'setup'
                    ? `setup live — arms on a close above ${fmtPx(radar.paths.pullback.refHigh)}`
                    : 'TRIGGER LIVE'}</span>
              </li>
            </ul>
          </div>
        </div>
        <p className="tiny" style={{ marginTop: 12 }}>
          The bias lives here — one ticker, long only. What fires is mechanical: these same checks gate every
          entry the directive will ever issue. Belief sets the watchlist; evidence sets the entry.
        </p>
      </section>

      <section className="card span2" data-testid="battle-plan">
        <div className="ttl">Battle plan — tickets ready before the day comes</div>
        {tickets.length === 0 ? (
          <p className="sub">Tickets appear when there's a computable trigger level (needs price history).</p>
        ) : (
          <div className="tbl-wrap">
            <table>
              <thead><tr><th>If this happens</th><th>Buy</th><th>Stop</th><th>Risk</th><th>Position</th></tr></thead>
              <tbody>
                {tickets.map((t) => (
                  <tr key={t.name}>
                    <td>
                      <strong>{t.name}</strong>
                      {t.live && <span className="chip live" style={{ marginLeft: 6 }}><span className="dot" />LIVE</span>}
                      <div className="tiny">{t.trigger}</div>
                    </td>
                    <td className="num">{t.shares > 0 ? `${t.shares} sh @ ~${fmtPx(t.entry)}` : '—'}</td>
                    <td className="num">{t.stop == null ? '—' : fmtPx(t.stop)}</td>
                    <td className="num">{t.riskUsd == null ? (t.note || '—') : `$${Math.round(t.riskUsd).toLocaleString('en-US')}`}</td>
                    <td className="num">{t.positionPct == null ? '—' : `${t.positionPct}%${t.capped ? ' (capped)' : ''}`}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
        {settings && (
          <>
            <div className="tiny" style={{ margin: '14px 0 6px', fontWeight: 700 }}>THE CAMPAIGN LADDER (how a multi-month run gets ridden)</div>
            <ol className="ladder">
              <li><strong>Entry</strong> — first trigger with both regimes green: 1 unit ({settings.riskPct}% risk, {stopModeLabel(settings)}).</li>
              <li><strong>Breakeven lock</strong> — at +{settings.beAtR}R the stop jumps to entry. The trade can no longer lose.</li>
              <li><strong>Add</strong> — next pullback trigger AFTER the lock: {settings.addRiskFraction} unit. Net open risk stays ≤ {settings.addRiskFraction}R because the first unit is risk-free.</li>
              <li><strong>Ride</strong> — the chandelier ({settings.chandelierMult}×ATR under the highest high) only ever rises. No target: the run decides when it's over, the trail decides where you leave.</li>
            </ol>
          </>
        )}
        {breaks.length > 0 && (
          <>
            <div className="tiny" style={{ margin: '14px 0 6px', fontWeight: 700, color: 'var(--down)' }}>WHAT RETIRES THE PLAN (pre-committed)</div>
            <ul className="radar-list">
              {breaks.map((b) => (
                <li key={b.id} className="fail"><span className="mark" aria-hidden>✕</span><span>{b.label}</span></li>
              ))}
            </ul>
          </>
        )}
        <p className="tiny" style={{ marginTop: 10 }}>
          Tickets are preparation, not permission — the directive gates every entry.
          {position && ` Position open: tickets are sized as ADDs (${settings?.addRiskFraction ?? 0.5}× risk unit).`}
        </p>
      </section>
    </>
  )
}

function stopModeLabel(settings) {
  return settings.stopMode === 'structure' ? 'swing-low stop'
    : settings.stopMode === 'percent' ? `${settings.stopPct}% stop`
      : `${settings.atrMult}×ATR stop`
}
