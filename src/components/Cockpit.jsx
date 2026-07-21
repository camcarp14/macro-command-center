// The cockpit: one glance → one directive. Directive card leads; position,
// entry plan, torque, and regime reads support it. Every number wears its
// freshness; every claim shows its work.
import React, { useState } from 'react'
import { Num, SkPage, Expand, FreshChip } from './primitives.jsx'
import { sizePosition, initialStop } from '../lib/risk.js'
import { fmtPx, round2 } from '../App.jsx'

const ACTION_COPY = {
  ENTER: 'Enter long',
  ADD: 'Add to position',
  HOLD: 'Hold',
  TRIM: 'Trim',
  EXIT: 'Exit',
  STOP_OUT: 'STOP OUT',
  STAND_ASIDE: 'Stand aside',
  NO_DATA: 'No data',
}

export default function Cockpit({ derived, settings, position, sources, onReload }) {
  const loading = sources.quote.loading && !sources.quote.data && !sources.quote.error
  if (loading && !derived.price) return <SkPage cards={4} />

  const d = derived.directive
  const anyError = sources.quote.error || sources.btc.error || sources.mstr1d.error

  return (
    <div className="grid stagger" data-testid="cockpit">
      {anyError && (
        <div className="error-row span2" role="alert">
          <span>Source trouble: {[sources.quote.error && 'MSTR quote', sources.btc.error && 'BTC', sources.mstr1d.error && 'MSTR history'].filter(Boolean).join(' · ')} — showing what's still trustworthy.</span>
          <button className="btn sm" onClick={onReload}>Retry</button>
        </div>
      )}

      <section className={`card directive span2 ${d.severity}`} data-testid="directive">
        <div className="ttl">Directive
          <span className="spacer" />
          <FreshChip fresh={derived.freshQuote} label="MSTR" />
          <FreshChip fresh={derived.freshBtc} label="BTC" />
        </div>
        <div className="action" data-testid="directive-action">{ACTION_COPY[d.action] ?? d.action}</div>
        <p className="sub" style={{ marginTop: 4, fontSize: 14.5 }}>{d.headline}</p>
        <ul>
          {d.reasons.map((r, i) => <li key={i}>{r}</li>)}
        </ul>
        {d.guardrails.map((g, i) => (
          <div className="guardrail" key={i}><span aria-hidden>⚠︎</span><span>{g}</span></div>
        ))}
      </section>

      {position && <PositionCard derived={derived} position={position} />}
      <EntryPlanner derived={derived} settings={settings} hasPosition={!!position} />
      <TorqueCard derived={derived} settings={settings} />
      <RegimeCard title="MSTR regime" read={derived.regime} extra={derived.pullback} breakout={derived.breakout} />
      <RegimeCard title="BTC confirmation" read={derived.btcAlign} />
    </div>
  )
}

function PositionCard({ derived, position }) {
  const { posDerived, price } = derived
  const r = posDerived?.r
  const eff = posDerived?.effStop
  const unrealized = Number.isFinite(price) ? (price - position.avgEntry) * position.shares : null
  const distPct = Number.isFinite(eff) && Number.isFinite(price) && price > 0 ? ((price - eff) / price) * 100 : null
  const meterCls = distPct == null ? '' : distPct < 3 ? 'danger' : distPct < 6 ? 'warn' : ''
  const initialRiskPct = position.avgEntry > 0 ? ((position.avgEntry - position.initialStop) / position.avgEntry) * 100 : null

  return (
    <section className="card" data-testid="position-card">
      <div className="ttl">Open position</div>
      <div className="big num">{position.shares} <span className="sub" style={{ fontSize: 14 }}>MSTR @ {fmtPx(position.avgEntry)}</span></div>
      <div className="stats" style={{ marginTop: 10 }}>
        <div className="stat"><div className="k">Open R</div><div className={`v num ${r == null ? '' : r >= 0 ? 'pos' : 'neg'}`} data-testid="open-r">{r == null ? '—' : `${r >= 0 ? '+' : ''}${round2(r)}R`}</div></div>
        <div className="stat"><div className="k">Unrealized</div><div className={`v num ${unrealized == null ? '' : unrealized >= 0 ? 'pos' : 'neg'}`}>{unrealized == null ? '—' : `${unrealized < 0 ? '-' : ''}$${Math.abs(Math.round(unrealized)).toLocaleString('en-US')}`}</div></div>
        <div className="stat"><div className="k">Stop now</div><div className="v num">{eff == null ? '—' : fmtPx(eff)}</div><div className="d">{trailNote(position, posDerived)}</div></div>
      </div>
      <div style={{ marginTop: 12 }}>
        <div className="tiny" style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 4 }}>
          <span>distance to stop</span><span className="num">{distPct == null ? '—' : `${round2(distPct)}%`}</span>
        </div>
        <div className={`meter ${meterCls}`} role="img" aria-label={distPct == null ? 'stop distance unknown' : `price is ${round2(distPct)} percent above the stop`}>
          <div style={{ width: `${distPct == null ? 0 : Math.max(4, Math.min(100, distPct * 8))}%` }} />
        </div>
        <div className="tiny" style={{ marginTop: 6 }}>
          initial risk {initialRiskPct == null ? '—' : `${round2(initialRiskPct)}%`} of entry · stop only ever rises
        </div>
      </div>
    </section>
  )
}

function trailNote(position, pd) {
  if (!pd) return 'initial stop'
  if (Number.isFinite(position.stopOverride) && pd.effStop === position.stopOverride) return 'manual override'
  if (pd.trailNow != null && pd.effStop === pd.trailNow) return 'chandelier trail'
  if (pd.effStop === position.avgEntry) return 'breakeven lock'
  return 'initial stop'
}

/** "If you enter now" — live sizing with editable stop mode. The discipline
 *  widget: change the mode, watch shares and risk recompute. */
function EntryPlanner({ derived, settings, hasPosition }) {
  const [mode, setMode] = useState(null)
  const [open, setOpen] = useState(!hasPosition)
  if (!settings) return null
  const effMode = mode ?? settings.stopMode
  const price = derived.price
  const plan = price != null
    ? initialStop({ mode: effMode, entry: price, atr: derived.atrNow, atrMult: settings.atrMult, swingLow: derived.lastSwingLow, pct: settings.stopPct })
    : null
  const sz = plan?.stop != null
    ? sizePosition({ equity: settings.equity, riskPct: settings.riskPct, entry: price, stop: plan.stop, maxPositionPct: settings.maxPositionPct })
    : null

  return (
    <section className="card" data-testid="entry-planner">
      <div className="ttl">If you enter now
        <span className="spacer" />
        <button className="btn ghost sm" onClick={() => setOpen((o) => !o)} aria-expanded={open}>{open ? 'collapse' : 'expand'}</button>
      </div>
      <Expand open={open}>
        <div className="seg" style={{ marginBottom: 12 }}>
          {['atr', 'structure', 'percent'].map((m) => (
            <button key={m} className={effMode === m ? 'on' : ''} onClick={() => setMode(m)}>{m === 'atr' ? `ATR ×${settings.atrMult}` : m === 'structure' ? 'Swing low' : `${settings.stopPct}%`}</button>
          ))}
        </div>
        {price == null ? (
          <div className="empty"><div className="glyph">—</div>No live price to plan against.</div>
        ) : plan?.stop == null ? (
          <div className="empty">Stop can't be computed: {plan?.detail ?? 'no data'} <span className="tiny">({plan?.warning})</span></div>
        ) : (
          <>
            <div className="stats">
              <div className="stat"><div className="k">Buy</div><div className="v num" data-testid="plan-shares">{sz?.ok ? `${sz.shares} sh` : '—'}</div><div className="d">≈ ${sz?.ok ? Math.round(sz.positionUsd).toLocaleString('en-US') : '—'}</div></div>
              <div className="stat"><div className="k">Stop</div><div className="v num">{fmtPx(plan.stop)}</div><div className="d">{plan.detail}</div></div>
              <div className="stat"><div className="k">Risk</div><div className="v num">{sz?.ok ? `$${Math.round(sz.riskUsd).toLocaleString('en-US')}` : '—'}</div><div className="d">{settings.riskPct}% of equity{sz?.capped ? ' · CAPPED' : ''}</div></div>
              <div className="stat"><div className="k">Position</div><div className="v num">{sz?.ok ? `${sz.positionPct}%` : '—'}</div><div className="d">max {settings.maxPositionPct}%</div></div>
            </div>
            {!sz?.ok && sz?.error && <div className="guardrail"><span>⚠︎</span><span>{sizingErrorCopy(sz.error)}</span></div>}
            <p className="tiny" style={{ marginTop: 10 }}>
              Advisory only — place orders at your broker. A stop is a decision made now, not in the moment.
            </p>
          </>
        )}
      </Expand>
    </section>
  )
}

function sizingErrorCopy(code) {
  return {
    risk_too_small_for_one_share: 'Your risk budget doesn\'t buy one whole share at this stop distance — widen risk % or wait for a tighter setup.',
    stop_not_below_entry: 'Computed stop is not below the entry price.',
    bad_input: 'Sizing inputs incomplete.',
  }[code] ?? code
}

function TorqueCard({ derived, settings }) {
  const { beta, rs, nav, torqueRead } = derived
  const seeded = settings?.btcHoldingsSeeded || settings?.sharesSeeded
  return (
    <section className="card" data-testid="torque-card">
      <div className="ttl">Leverage truth
        <span className="spacer" />
        <span className={`chip grade-${torqueRead.grade}`}>{torqueRead.grade}</span>
      </div>
      <div className="stats">
        <div className="stat"><div className="k">Beta vs BTC</div><div className="v num">{beta == null ? '—' : `${round2(beta)}×`}</div><div className="d">30-day daily</div></div>
        <div className="stat"><div className="k">mNAV</div><div className="v num">{nav?.mNav == null ? '—' : `${nav.mNav}×`}</div><div className="d">{nav?.premiumPct == null ? '' : `${nav.premiumPct >= 0 ? '+' : ''}${round2(nav.premiumPct)}% premium`}</div></div>
        <div className="stat"><div className="k">Implied BTC</div><div className="v num">{nav?.impliedBtcPrice == null ? '—' : `$${nav.impliedBtcPrice.toLocaleString('en-US')}`}</div><div className="d">price you pay via MSTR</div></div>
        <div className="stat"><div className="k">20d RS</div><div className={`v num ${rs?.spreadPct == null ? '' : rs.spreadPct >= 0 ? 'pos' : 'neg'}`}>{rs?.spreadPct == null ? '—' : `${rs.spreadPct >= 0 ? '+' : ''}${round2(rs.spreadPct)}pp`}</div><div className="d">MSTR − BTC</div></div>
      </div>
      <p className="sub" style={{ marginTop: 10 }}>{torqueRead.text}</p>
      {seeded && (
        <div className="guardrail"><span>⚠︎</span><span>
          BTC holdings / share count are SEEDED estimates (as of {settings.btcHoldingsAsOf}). Verify against the latest 8-K in Settings — mNAV is only as honest as these two numbers.
        </span></div>
      )}
    </section>
  )
}

function RegimeCard({ title, read, extra, breakout }) {
  const [open, setOpen] = useState(false)
  return (
    <section className="card">
      <div className="ttl">{title}
        <span className="spacer" />
        <span className={`badge-regime ${read.state}`}>{read.state.replace('_', ' ')}{read.score != null ? ` ${read.score}` : ''}</span>
      </div>
      {extra && extra.stage !== 'none' && (
        <p className="sub" style={{ marginBottom: 6 }}>
          {extra.stage === 'trigger' ? '● Pullback trigger LIVE' : '◐ Pullback setup forming'}
        </p>
      )}
      {breakout?.active && <p className="sub" style={{ marginBottom: 6 }}>● Breakout over {fmtPx(breakout.level)}</p>}
      <button className="btn ghost sm" onClick={() => setOpen((o) => !o)} aria-expanded={open}>{open ? 'hide the work' : 'show the work'}</button>
      <Expand open={open}>
        <ul style={{ margin: '8px 0 0', paddingLeft: 18 }}>
          {[...read.facts, ...(extra?.facts ?? []), ...(breakout?.facts ?? [])].map((f, i) => (
            <li key={i} className="sub" style={{ margin: '3px 0' }}>{f}</li>
          ))}
        </ul>
      </Expand>
    </section>
  )
}
