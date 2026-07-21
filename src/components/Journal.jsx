// Trade journal — every closed trade in R, because R is the only honest
// scoreboard for a rules trader. Cumulative-R curve is a single series:
// no legend needed, the title names it (dataviz rules).
import React, { useMemo, useState } from 'react'
import { rMultiple } from '../lib/risk.js'
import { useToast, SkCard } from './primitives.jsx'
import { api } from '../lib/api.js'
import { fmtPx, round2 } from '../lib/format.js'

export default function Journal({ journalSrc }) {
  const toast = useToast()
  const [busy, setBusy] = useState(false)
  const trades = journalSrc.data?.trades ?? []

  const withR = useMemo(() => trades.map((t) => ({
    ...t,
    r: rMultiple({ entry: t.entry, initialStop: t.initialStop, price: t.exit }),
    pnl: (t.exit - t.entry) * t.shares,
  })), [trades])

  const stats = useMemo(() => {
    const rs = withR.map((t) => t.r).filter((r) => r != null)
    if (!rs.length) return null
    const wins = rs.filter((r) => r > 0).length
    let cum = 0
    // chronological by EXIT DATE, not storage order — back-filled trades
    // must not invert the drawdown story
    const curve = withR
      .filter((t) => t.r != null)
      .slice()
      .sort((a, b) => a.exitDate.localeCompare(b.exitDate))
      .map((t) => (cum += t.r))
    return {
      n: rs.length,
      winRate: Math.round((wins / rs.length) * 100),
      avgR: round2(rs.reduce((a, b) => a + b, 0) / rs.length),
      cumR: round2(cum),
      curve,
    }
  }, [withR])

  const remove = async (id) => {
    if (!window.confirm('Delete this trade from the journal?')) return
    setBusy(true)
    try {
      await api(`journal?id=${encodeURIComponent(id)}`, { method: 'DELETE' })
      await journalSrc.reload()
      toast('Trade deleted')
    } catch (e) { toast(`Delete failed: ${e.message}`, { err: true }) }
    setBusy(false)
  }

  if (journalSrc.loading && !journalSrc.data) return <div className="grid"><SkCard /><SkCard /></div>

  return (
    <div className="grid stagger" data-testid="journal">
      {journalSrc.error && (
        <div className="error-row span2" role="alert">
          <span>Journal unavailable: {journalSrc.error}</span>
          <button className="btn sm" onClick={journalSrc.reload}>Retry</button>
        </div>
      )}

      {stats && (
        <section className="card span2">
          <div className="ttl">Scoreboard — cumulative R by trade</div>
          <div className="stats" style={{ marginBottom: 12 }}>
            <div className="stat"><div className="k">Trades</div><div className="v num">{stats.n}</div></div>
            <div className="stat"><div className="k">Win rate</div><div className="v num">{stats.winRate}%</div></div>
            <div className="stat"><div className="k">Avg R</div><div className={`v num ${stats.avgR >= 0 ? 'pos' : 'neg'}`}>{stats.avgR >= 0 ? '+' : ''}{stats.avgR}R</div></div>
            <div className="stat"><div className="k">Total R</div><div className={`v num ${stats.cumR >= 0 ? 'pos' : 'neg'}`} data-testid="total-r">{stats.cumR >= 0 ? '+' : ''}{stats.cumR}R</div></div>
          </div>
          <RCurve curve={stats.curve} />
        </section>
      )}

      <AddTrade onSaved={journalSrc.reload} />

      <section className="card span2">
        <div className="ttl">Closed trades</div>
        {withR.length === 0 ? (
          <div className="empty">
            <div className="glyph">✎</div>
            No trades logged yet. Add your first closed trade above — the scoreboard builds itself.
          </div>
        ) : (
          <div className="tbl-wrap">
            {/* R and P&L lead — the scoreboard columns must be the ones a
                narrow viewport shows first, not the ones it cuts off */}
            <table data-testid="trades-table">
              <thead><tr><th>Dates</th><th>Kind</th><th>R</th><th>P&L</th><th>Entry</th><th>Exit</th><th>Stop</th><th>Shares</th><th /></tr></thead>
              <tbody>
                {withR.map((t) => (
                  <tr key={t.id}>
                    <td className="tiny">{t.entryDate} → {t.exitDate}</td>
                    <td><span className="chip">{t.kind}</span></td>
                    <td className={`num ${t.r == null ? '' : t.r >= 0 ? 'pos' : 'neg'}`}>{t.r == null ? '—' : `${t.r >= 0 ? '+' : ''}${round2(t.r)}R`}</td>
                    <td className={`num ${t.pnl >= 0 ? 'pos' : 'neg'}`}>{t.pnl < 0 ? '-' : ''}${Math.abs(Math.round(t.pnl)).toLocaleString('en-US')}</td>
                    <td className="num">{fmtPx(t.entry)}</td>
                    <td className="num">{fmtPx(t.exit)}</td>
                    <td className="num">{fmtPx(t.initialStop)}</td>
                    <td className="num">{t.shares}</td>
                    <td><button className="btn ghost sm" disabled={busy} onClick={() => remove(t.id)} aria-label={`Delete trade ${t.entryDate}`}>✕</button></td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>
    </div>
  )
}

/** Single-series cumulative R sparkline. Direct end-label, no legend. */
function RCurve({ curve }) {
  if (curve.length < 2) return <p className="tiny">Curve appears after two trades.</p>
  const w = 600; const h = 120; const pad = 6
  const min = Math.min(0, ...curve); const max = Math.max(0, ...curve)
  const x = (i) => pad + (i / (curve.length - 1)) * (w - pad * 2)
  const y = (v) => pad + (1 - (v - min) / (max - min || 1)) * (h - pad * 2)
  const path = curve.map((v, i) => `${i ? 'L' : 'M'}${x(i).toFixed(1)},${y(v).toFixed(1)}`).join(' ')
  const last = curve[curve.length - 1]
  // The end label lives in HTML, not the scaled SVG — an 11px SVG label
  // shrinks to ~6px at mobile card width, which is decoration, not a label.
  return (
    <div style={{ position: 'relative' }}>
      <svg viewBox={`0 0 ${w} ${h}`} style={{ width: '100%', height: 'auto', display: 'block' }} role="img"
        aria-label={`Cumulative R curve ending at ${round2(last)}R over ${curve.length} trades`}>
        <line x1={pad} x2={w - pad} y1={y(0)} y2={y(0)} stroke="rgba(255,255,255,0.12)" strokeDasharray="3 4" />
        <path d={path} fill="none" stroke={last >= 0 ? '#0FA3A3' : '#D93A5F'} strokeWidth="2" strokeLinejoin="round" />
        <circle cx={x(curve.length - 1)} cy={y(last)} r="3.5" fill={last >= 0 ? '#0FA3A3' : '#D93A5F'} />
      </svg>
      <span className="num" style={{
        position: 'absolute', right: 0, top: `${(y(last) / h) * 100}%`, transform: 'translateY(-50%)',
        fontSize: 12, fontWeight: 700, color: last >= 0 ? '#0FA3A3' : '#D93A5F',
        background: 'var(--card)', padding: '0 4px', borderRadius: 4,
      }}>
        {last >= 0 ? '+' : ''}{round2(last)}R
      </span>
    </div>
  )
}

function AddTrade({ onSaved }) {
  const toast = useToast()
  const empty = { entryDate: '', exitDate: '', entry: '', exit: '', shares: '', initialStop: '', kind: 'manual', note: '' }
  const [f, setF] = useState(empty)
  const [saving, setSaving] = useState(false)
  const set = (k) => (e) => setF((s) => ({ ...s, [k]: e.target.value }))
  const previewR = rMultiple({ entry: +f.entry, initialStop: +f.initialStop, price: +f.exit })

  const submit = async (e) => {
    e.preventDefault()
    setSaving(true)
    try {
      await api('journal', {
        method: 'POST',
        body: JSON.stringify({
          entryDate: f.entryDate, exitDate: f.exitDate,
          entry: +f.entry, exit: +f.exit, shares: Math.round(+f.shares),
          initialStop: +f.initialStop, kind: f.kind, note: f.note,
        }),
      })
      setF(empty)
      await onSaved()
      toast('Trade logged')
    } catch (err) {
      const detail = err.body?.errors?.join('; ') || err.message
      toast(`Not saved: ${detail}`, { err: true, ms: 4200 })
    }
    setSaving(false)
  }

  return (
    <section className="card span2">
      <div className="ttl">Log a closed trade</div>
      <form onSubmit={submit} data-testid="add-trade-form">
        <div className="formrow">
          <div className="field"><label htmlFor="jt-ed">Entry date</label><input id="jt-ed" type="date" value={f.entryDate} onChange={set('entryDate')} required /></div>
          <div className="field"><label htmlFor="jt-xd">Exit date</label><input id="jt-xd" type="date" value={f.exitDate} onChange={set('exitDate')} required /></div>
        </div>
        <div className="formrow">
          <div className="field"><label htmlFor="jt-e">Entry price</label><input id="jt-e" type="number" step="0.01" min="0.01" value={f.entry} onChange={set('entry')} required /></div>
          <div className="field"><label htmlFor="jt-x">Exit price</label><input id="jt-x" type="number" step="0.01" min="0.01" value={f.exit} onChange={set('exit')} required /></div>
        </div>
        <div className="formrow">
          <div className="field"><label htmlFor="jt-s">Shares</label><input id="jt-s" type="number" step="1" min="1" value={f.shares} onChange={set('shares')} required /></div>
          <div className="field"><label htmlFor="jt-st">Initial stop</label>
            <input id="jt-st" type="number" step="0.01" min="0.01" value={f.initialStop} onChange={set('initialStop')} required />
            <span className="hint">{previewR != null ? `this trade will book as ${previewR >= 0 ? '+' : ''}${round2(previewR)}R` : 'R computes from entry − initial stop'}</span>
          </div>
        </div>
        <div className="formrow">
          <div className="field"><label htmlFor="jt-k">Kind</label>
            <select id="jt-k" value={f.kind} onChange={set('kind')}>
              <option value="pullback">pullback</option>
              <option value="breakout">breakout</option>
              <option value="manual">manual</option>
            </select>
          </div>
          <div className="field"><label htmlFor="jt-n">Note</label><input id="jt-n" type="text" maxLength="500" value={f.note} onChange={set('note')} placeholder="what did you learn" /></div>
        </div>
        <button className="btn primary" type="submit" disabled={saving}>{saving ? 'Saving…' : 'Log trade'}</button>
      </form>
    </section>
  )
}
