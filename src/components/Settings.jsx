// Settings: risk parameters (the discipline), MSTR balance-sheet inputs
// (the honesty), the open position editor, and source health.
import React, { useEffect, useState } from 'react'
import { useToast, SkCard } from './primitives.jsx'
import { api } from '../lib/api.js'
import { fmtPx } from '../lib/format.js'

export default function Settings({ settingsSrc, positionSrc, derived }) {
  if (settingsSrc.loading && !settingsSrc.data) return <div className="grid"><SkCard /><SkCard /></div>
  return (
    <div className="grid stagger" data-testid="settings">
      {settingsSrc.error && (
        <div className="error-row span2" role="alert">
          <span>Settings unavailable: {settingsSrc.error} — the risk engine is flying without your parameters.</span>
          <button className="btn sm" onClick={settingsSrc.reload}>Retry</button>
        </div>
      )}
      {positionSrc.error && (
        <div className="error-row span2" role="alert">
          <span>Position unavailable: {positionSrc.error}</span>
          <button className="btn sm" onClick={positionSrc.reload}>Retry</button>
        </div>
      )}
      <RiskForm settingsSrc={settingsSrc} />
      <BalanceSheetForm settingsSrc={settingsSrc} />
      <PositionForm positionSrc={positionSrc} derived={derived} />
      <SourceHealth />
    </div>
  )
}

function useForm(initial) {
  const [f, setF] = useState(initial)
  useEffect(() => { setF(initial) }, [JSON.stringify(initial)]) // reset when saved data arrives
  return [f, (k) => (e) => setF((s) => ({ ...s, [k]: e.target.value })), setF]
}

function RiskForm({ settingsSrc }) {
  const toast = useToast()
  const s = settingsSrc.data?.settings
  const [f, set] = useForm({
    equity: s?.equity ?? '', riskPct: s?.riskPct ?? '', maxPositionPct: s?.maxPositionPct ?? '',
    stopMode: s?.stopMode ?? 'atr', atrMult: s?.atrMult ?? '', stopPct: s?.stopPct ?? '',
    chandelierPeriod: s?.chandelierPeriod ?? '', chandelierMult: s?.chandelierMult ?? '', beAtR: s?.beAtR ?? '',
    addRiskFraction: s?.addRiskFraction ?? '',
  })
  const [saving, setSaving] = useState(false)

  const submit = async (e) => {
    e.preventDefault()
    setSaving(true)
    try {
      await api('settings', {
        method: 'PUT',
        body: JSON.stringify({
          equity: +f.equity, riskPct: +f.riskPct, maxPositionPct: +f.maxPositionPct,
          stopMode: f.stopMode, atrMult: +f.atrMult, stopPct: +f.stopPct,
          chandelierPeriod: Math.round(+f.chandelierPeriod), chandelierMult: +f.chandelierMult, beAtR: +f.beAtR,
          addRiskFraction: +f.addRiskFraction,
        }),
      })
      await settingsSrc.reload()
      toast('Risk settings saved')
    } catch (err) {
      toast(`Not saved: ${err.body?.errors?.join('; ') || err.message}`, { err: true, ms: 4200 })
    }
    setSaving(false)
  }

  return (
    <section className="card span2">
      <div className="ttl">Risk engine</div>
      <form onSubmit={submit} data-testid="risk-form">
        <div className="formrow">
          <div className="field"><label htmlFor="rf-eq">Account equity ($)</label><input id="rf-eq" type="number" min="1" step="1" value={f.equity} onChange={set('equity')} required /></div>
          <div className="field"><label htmlFor="rf-risk">Risk per trade (%)</label>
            <input id="rf-risk" type="number" min="0.05" max="5" step="0.05" value={f.riskPct} onChange={set('riskPct')} required />
            <span className="hint">a stop hit loses exactly this much — capped at 5%</span>
          </div>
        </div>
        <div className="formrow">
          <div className="field"><label htmlFor="rf-max">Max position (% of equity)</label><input id="rf-max" type="number" min="1" max="100" step="1" value={f.maxPositionPct} onChange={set('maxPositionPct')} required /></div>
          <div className="field"><label htmlFor="rf-mode">Default stop mode</label>
            <select id="rf-mode" value={f.stopMode} onChange={set('stopMode')}>
              <option value="atr">ATR multiple (volatility-aware)</option>
              <option value="structure">Below swing low</option>
              <option value="percent">Fixed percent</option>
            </select>
          </div>
        </div>
        <div className="formrow">
          <div className="field"><label htmlFor="rf-atrm">ATR multiple</label><input id="rf-atrm" type="number" min="0.5" max="10" step="0.1" value={f.atrMult} onChange={set('atrMult')} /></div>
          <div className="field"><label htmlFor="rf-pct">Fixed stop (%)</label><input id="rf-pct" type="number" min="1" max="50" step="0.5" value={f.stopPct} onChange={set('stopPct')} /></div>
        </div>
        <div className="formrow">
          <div className="field"><label htmlFor="rf-chp">Chandelier period</label><input id="rf-chp" type="number" min="5" max="100" step="1" value={f.chandelierPeriod} onChange={set('chandelierPeriod')} /></div>
          <div className="field"><label htmlFor="rf-chm">Chandelier multiple</label>
            <input id="rf-chm" type="number" min="0.5" max="10" step="0.1" value={f.chandelierMult} onChange={set('chandelierMult')} />
            <span className="hint">trail = highest high since entry − mult × ATR; it only rises</span>
          </div>
        </div>
        <div className="formrow">
          <div className="field"><label htmlFor="rf-be">Breakeven at (R)</label>
            <input id="rf-be" type="number" min="0.25" max="5" step="0.25" value={f.beAtR} onChange={set('beAtR')} />
            <span className="hint">once price pays you this many R, the stop jumps to entry</span>
          </div>
          <div className="field"><label htmlFor="rf-add">Add-risk fraction</label>
            <input id="rf-add" type="number" min="0.1" max="1" step="0.05" value={f.addRiskFraction} onChange={set('addRiskFraction')} />
            <span className="hint">pyramid ADDs risk this fraction of a full unit (0.5 = half risk)</span>
          </div>
        </div>
        <button className="btn primary" type="submit" disabled={saving}>{saving ? 'Saving…' : 'Save risk settings'}</button>
      </form>
    </section>
  )
}

function BalanceSheetForm({ settingsSrc }) {
  const toast = useToast()
  const s = settingsSrc.data?.settings
  const [f, set] = useForm({ btcHoldings: s?.btcHoldings ?? '', sharesOutstanding: s?.sharesOutstanding ?? '' })
  const [saving, setSaving] = useState(false)
  const seeded = s?.btcHoldingsSeeded || s?.sharesSeeded

  const submit = async (e) => {
    e.preventDefault()
    setSaving(true)
    try {
      await api('settings', { method: 'PUT', body: JSON.stringify({ btcHoldings: +f.btcHoldings, sharesOutstanding: +f.sharesOutstanding }) })
      await settingsSrc.reload()
      toast('Balance-sheet inputs verified')
    } catch (err) {
      toast(`Not saved: ${err.body?.errors?.join('; ') || err.message}`, { err: true, ms: 4200 })
    }
    setSaving(false)
  }

  return (
    <section className="card span2">
      <div className="ttl">MSTR balance sheet (feeds mNAV)
        <span className="spacer" />
        {seeded
          ? <span className="chip stale"><span className="dot" />seeded — verify vs 8-K</span>
          : <span className="chip live"><span className="dot" />user-verified {s?.btcHoldingsAsOf}</span>}
      </div>
      <p className="sub" style={{ marginBottom: 12 }}>
        mNAV and implied-BTC-price are only as honest as these two numbers. Strategy discloses
        holdings in 8-K filings (sec.gov, ticker MSTR) and on strategy.com — update after every purchase announcement.
      </p>
      <form onSubmit={submit} data-testid="balance-form">
        <div className="formrow">
          <div className="field"><label htmlFor="bs-btc">BTC held</label><input id="bs-btc" type="number" min="1" step="1" value={f.btcHoldings} onChange={set('btcHoldings')} required /></div>
          <div className="field"><label htmlFor="bs-sh">Shares outstanding (A+B)</label><input id="bs-sh" type="number" min="1000000" step="1000" value={f.sharesOutstanding} onChange={set('sharesOutstanding')} required /></div>
        </div>
        <button className="btn primary" type="submit" disabled={saving}>{saving ? 'Saving…' : 'Save as verified'}</button>
      </form>
    </section>
  )
}

function PositionForm({ positionSrc, derived }) {
  const toast = useToast()
  const p = positionSrc.data?.position
  const [f, set, setAll] = useForm({
    shares: p?.shares ?? '', avgEntry: p?.avgEntry ?? '', entryDate: p?.entryDate ?? '',
    initialStop: p?.initialStop ?? '', stopOverride: p?.stopOverride ?? '', note: p?.note ?? '',
  })
  const [saving, setSaving] = useState(false)

  const submit = async (e) => {
    e.preventDefault()
    setSaving(true)
    try {
      await api('position', {
        method: 'PUT',
        body: JSON.stringify({
          shares: Math.round(+f.shares), avgEntry: +f.avgEntry, entryDate: f.entryDate,
          initialStop: +f.initialStop,
          stopOverride: f.stopOverride === '' || f.stopOverride == null ? null : +f.stopOverride,
          note: f.note || '',
        }),
      })
      await positionSrc.reload()
      toast('Position saved — the cockpit is now tracking it')
    } catch (err) {
      toast(`Not saved: ${err.body?.errors?.join('; ') || err.message}`, { err: true, ms: 4200 })
    }
    setSaving(false)
  }

  const close = async () => {
    if (!window.confirm('Clear the tracked position? (Log the closed trade in the Journal first.)')) return
    setSaving(true)
    try {
      await api('position', { method: 'DELETE' })
      await positionSrc.reload()
      setAll({ shares: '', avgEntry: '', entryDate: '', initialStop: '', stopOverride: '', note: '' })
      toast('Position cleared')
    } catch (err) { toast(`Failed: ${err.message}`, { err: true }) }
    setSaving(false)
  }

  return (
    <section className="card span2">
      <div className="ttl">Open position {p ? '' : '(none tracked)'}</div>
      <p className="sub" style={{ marginBottom: 12 }}>
        Mirror your broker fill here. The cockpit computes the trail, breakeven lock, and live R from it.
        {derived?.stopPlan?.stop != null && !p && ` Suggested initial stop right now: ${fmtPx(derived.stopPlan.stop)} (${derived.stopPlan.detail}).`}
      </p>
      <form onSubmit={submit} data-testid="position-form">
        <div className="formrow">
          <div className="field"><label htmlFor="pf-sh">Shares</label><input id="pf-sh" type="number" min="1" step="1" value={f.shares} onChange={set('shares')} required /></div>
          <div className="field"><label htmlFor="pf-en">Avg entry ($)</label><input id="pf-en" type="number" min="0.01" step="0.01" value={f.avgEntry} onChange={set('avgEntry')} required /></div>
        </div>
        <div className="formrow">
          <div className="field"><label htmlFor="pf-ed">Entry date</label><input id="pf-ed" type="date" value={f.entryDate} onChange={set('entryDate')} required /></div>
          <div className="field"><label htmlFor="pf-st">Initial stop ($)</label>
            <input id="pf-st" type="number" min="0.01" step="0.01" value={f.initialStop} onChange={set('initialStop')} required />
            <span className="hint">must be below entry — this defines 1R forever</span>
          </div>
        </div>
        <div className="formrow">
          <div className="field"><label htmlFor="pf-ov">Manual stop override (optional)</label>
            <input id="pf-ov" type="number" min="0.01" step="0.01" value={f.stopOverride ?? ''} onChange={set('stopOverride')} placeholder="leave empty to trust the trail" />
            <span className="hint">
              only ever raises the stop, never lowers it
              {Number.isFinite(p?.stopHighWater) && ` · ratchet high-water: ${fmtPx(p.stopHighWater)} (a new entry date starts a fresh trade and resets it)`}
            </span>
          </div>
          <div className="field"><label htmlFor="pf-no">Note</label><input id="pf-no" type="text" maxLength="500" value={f.note} onChange={set('note')} /></div>
        </div>
        <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
          <button className="btn primary" type="submit" disabled={saving}>{saving ? 'Saving…' : p ? 'Update position' : 'Track position'}</button>
          {p && <button className="btn danger" type="button" disabled={saving} onClick={close}>Clear position</button>}
        </div>
      </form>
    </section>
  )
}

function SourceHealth() {
  const [state, setState] = useState({ loading: false, data: null, error: null })
  const run = async () => {
    setState({ loading: true, data: null, error: null })
    try {
      setState({ loading: false, data: await api('status'), error: null })
    } catch (e) {
      setState({ loading: false, data: null, error: e.message })
    }
  }
  return (
    <section className="card span2">
      <div className="ttl">Data sources
        <span className="spacer" />
        <button className="btn sm" onClick={run} disabled={state.loading}>{state.loading ? 'Pinging…' : 'Ping all sources'}</button>
      </div>
      {state.error && <div className="error-row"><span>{state.error}</span><button className="btn sm" onClick={run}>Retry</button></div>}
      {!state.data && !state.error && <p className="sub">MSTR: Yahoo (delayed ~15 min) → Stooq EOD fallback. BTC: Binance → Coinbase → CoinGecko. Run a ping to see live upstream health from the server's vantage point.</p>}
      {state.data && (
        <>
          <div className="tbl-wrap">
            <table>
              <thead><tr><th>Upstream</th><th>Status</th><th>Latency</th></tr></thead>
              <tbody>
                {Object.entries(state.data.pings || {}).map(([name, p]) => (
                  <tr key={name}>
                    <td>{name}</td>
                    <td>{p.ok ? <span className="chip live"><span className="dot" />ok {p.httpStatus}</span> : <span className="chip dead"><span className="dot" />{p.error || `HTTP ${p.httpStatus}`}</span>}</td>
                    <td className="num">{p.latencyMs}ms</td>
                  </tr>
                ))}
                <tr>
                  <td>blobs (state store)</td>
                  <td>{state.data.blobs?.ok ? <span className="chip live"><span className="dot" />ok</span> : <span className="chip dead"><span className="dot" />{state.data.blobs?.error}</span>}</td>
                  <td />
                </tr>
              </tbody>
            </table>
          </div>
          {Object.keys(state.data.sourceStatus || {}).length > 0 && (
            <>
              <div className="ttl" style={{ marginTop: 16 }}>Last real fetch per endpoint (server-side)</div>
              <div className="tbl-wrap">
                <table>
                  <thead><tr><th>Endpoint</th><th>Last result</th><th>Detail / last error</th></tr></thead>
                  <tbody>
                    {Object.values(state.data.sourceStatus).map((sst) => (
                      <tr key={sst.name}>
                        <td>{sst.name}</td>
                        <td>{sst.ok
                          ? <span className="chip live"><span className="dot" />ok · {sst.latencyMs}ms</span>
                          : <span className="chip dead"><span className="dot" />failed</span>}</td>
                        <td className="tiny" style={{ whiteSpace: 'normal', maxWidth: 340 }}>
                          {sst.ok ? (sst.detail || '—') : (sst.lastError || '—')}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
              <p className="tiny" style={{ marginTop: 6 }}>
                Pings test reachability with a minimal request; this table shows what the REAL
                data fetches last returned — when they disagree, the difference is the diagnosis.
              </p>
            </>
          )}
        </>
      )}
    </section>
  )
}
