// TORQUE — the shell. Owns: auth gate, source polling, the one derived-state
// computation that feeds every view, tab navigation, ⌘K, toasts.
//
// Honesty rules enforced here (the reviewers' bar):
//  - freshness is computed from the LAST SUCCESSFUL fetch and ages through
//    live → stale → dead; a single failed poll never forges "dead"
//  - once a feed IS dead, its price is nulled — the tape shows "—", never a
//    remembered number beside a dead chip
//  - delayed/EOD quote kinds are labeled on the tape, not hidden
//  - the persisted stop high-water mark joins the effective-stop max, so the
//    governing stop can never render below any level it has already reached
import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { regime, pullbackSetup, breakout, exitFlags, btcAlignment } from './lib/signals.js'
import { atr, swings } from './lib/ta.js'
import { sizePosition, initialStop, anchoredChandelier, effectiveStop, rMultiple } from './lib/risk.js'
import { alignByDay, rollingBeta, relativeStrength, mNav, torqueRead } from './lib/torque.js'
import { freshness, nyseSessionState } from './lib/freshness.js'
import { composeDirective } from './lib/advice.js'
import { api } from './lib/api.js'
import { fmtPx, round2 } from './lib/format.js'
import { ToastProvider, CommandK, FreshChip, Num } from './components/primitives.jsx'
import Cockpit from './components/Cockpit.jsx'
import ChartPanel from './components/ChartPanel.jsx'
import Journal from './components/Journal.jsx'
import Settings from './components/Settings.jsx'

/** Poll a source; expose {data, error, fetchedAt, loading} + reload().
 *  On error the last-good data and fetchedAt are KEPT — the freshness
 *  ladder (not the error) decides when data stops being trustworthy. */
function useSource(path, intervalMs, onAuthFail) {
  const [state, setState] = useState({ data: null, error: null, fetchedAt: null, loading: true })
  const load = useCallback(async () => {
    setState((s) => ({ ...s, loading: true }))
    try {
      const data = await api(path)
      setState({ data, error: null, fetchedAt: data?.meta?.fetchedAt ?? Date.now(), loading: false })
    } catch (e) {
      if (e.code === 401) { onAuthFail(); return }
      setState((s) => ({ ...s, error: e.message, loading: false }))
    }
  }, [path, onAuthFail])
  useEffect(() => {
    load()
    if (!intervalMs) return
    const id = setInterval(load, intervalMs)
    const onVis = () => { if (document.visibilityState === 'visible') load() }
    document.addEventListener('visibilitychange', onVis)
    return () => { clearInterval(id); document.removeEventListener('visibilitychange', onVis) }
  }, [load, intervalMs])
  return { ...state, reload: load }
}

const TABS = [
  { id: 'cockpit', label: 'Cockpit', icon: 'M13 10V3L4 14h7v7l9-11h-7z' },
  { id: 'chart', label: 'Chart', icon: 'M3 3v18h18M7 14l4-4 3 3 5-6' },
  { id: 'journal', label: 'Journal', icon: 'M12 20h9M16.5 3.5a2.1 2.1 0 013 3L7 19l-4 1 1-4L16.5 3.5z' },
  { id: 'settings', label: 'Settings', icon: 'M12 15a3 3 0 100-6 3 3 0 000 6zM19.4 15a1.65 1.65 0 00.33 1.82l.06.06a2 2 0 11-2.83 2.83l-.06-.06a1.65 1.65 0 00-1.82-.33 1.65 1.65 0 00-1 1.51V21a2 2 0 11-4 0v-.09a1.65 1.65 0 00-1-1.51 1.65 1.65 0 00-1.82.33l-.06.06a2 2 0 11-2.83-2.83l.06-.06a1.65 1.65 0 00.33-1.82 1.65 1.65 0 00-1.51-1H3a2 2 0 110-4h.09a1.65 1.65 0 001.51-1 1.65 1.65 0 00-.33-1.82l-.06-.06a2 2 0 112.83-2.83l.06.06a1.65 1.65 0 001.82.33h0a1.65 1.65 0 001-1.51V3a2 2 0 114 0v.09a1.65 1.65 0 001 1.51h0a1.65 1.65 0 001.82-.33l.06-.06a2 2 0 112.83 2.83l-.06.06a1.65 1.65 0 00-.33 1.82v0a1.65 1.65 0 001.51 1H21a2 2 0 110 4h-.09a1.65 1.65 0 00-1.51 1z' },
]

/** Tab panels stay mounted (drafts survive reference-checking other tabs);
 *  the pagefade animation restarts by class-toggle, not remount. */
function TabPanel({ active, children }) {
  const ref = useRef(null)
  useEffect(() => {
    const el = ref.current
    if (active && el) {
      el.classList.remove('pagefade')
      void el.offsetWidth // reflow so the animation restarts
      el.classList.add('pagefade')
    }
  }, [active])
  return <div ref={ref} hidden={!active} className="pagefade">{children}</div>
}

export default function App() {
  const [needToken, setNeedToken] = useState(false)
  const [tab, setTab] = useState('cockpit')
  const [now, setNow] = useState(Date.now())
  const onAuthFail = useCallback(() => setNeedToken(true), [])

  const quote = useSource('quote', 60_000, onAuthFail)
  const btc = useSource('btc', 60_000, onAuthFail)
  const mstr1d = useSource('candles?symbol=MSTR&tf=1d', 300_000, onAuthFail)
  const btc1d = useSource('candles?symbol=BTC&tf=1d', 300_000, onAuthFail)
  const settingsSrc = useSource('settings', 0, onAuthFail)
  const positionSrc = useSource('position', 0, onAuthFail)
  const journalSrc = useSource('journal', 0, onAuthFail)

  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), 10_000)
    return () => clearInterval(id)
  }, [])

  const settings = settingsSrc.data?.settings ?? null
  const position = positionSrc.data?.position ?? null

  const derived = useMemo(() => {
    // freshness first: it decides which numbers are allowed to exist at all
    const freshQuote = freshness(quote.fetchedAt, 'quote', now)
    const freshBtc = freshness(btc.fetchedAt, 'btc', now)
    const freshCandles = freshness(mstr1d.fetchedAt, 'candles_1d', now)
    const freshBtcCandles = freshness(btc1d.fetchedAt, 'candles_1d', now)
    const price = freshQuote.state === 'dead' ? null : quote.data?.price ?? null
    const btcPrice = freshBtc.state === 'dead' ? null : btc.data?.price ?? null
    const mc = mstr1d.data?.candles ?? []
    const bc = btc1d.data?.candles ?? []

    const reg = regime(mc)
    const align = btcAlignment(bc)
    const pb = pullbackSetup(mc)
    const bo = breakout(mc)

    const aligned = alignByDay(mc, bc)
    const beta = rollingBeta(aligned.a, aligned.b, 30).latest
    const rs = relativeStrength(aligned.a, aligned.b, 20)
    const nav = settings ? mNav({ price, sharesOutstanding: settings.sharesOutstanding, btcHoldings: settings.btcHoldings, btcPrice }) : null
    const tRead = torqueRead({ beta, mNav: nav?.mNav })

    const atrArr = atr(mc, 14)
    const atrNow = atrArr.length ? atrArr[atrArr.length - 1] : null
    const swingLows = swings(mc, 2).lows
    const lastSwingLow = swingLows.length ? swingLows[swingLows.length - 1].price : null

    const stopPlan = settings && price != null
      ? initialStop({ mode: settings.stopMode, entry: price, atr: atrNow, atrMult: settings.atrMult, swingLow: lastSwingLow, pct: settings.stopPct })
      : null
    const sizing = settings && price != null && stopPlan?.stop != null
      ? sizePosition({ equity: settings.equity, riskPct: settings.riskPct, entry: price, stop: stopPlan.stop, maxPositionPct: settings.maxPositionPct })
      : null
    const addSizing = settings && price != null && stopPlan?.stop != null
      ? sizePosition({ equity: settings.equity, riskPct: settings.riskPct * settings.addRiskFraction, entry: price, stop: stopPlan.stop, maxPositionPct: settings.maxPositionPct })
      : null

    // open-position math: anchored trail from the entry date forward
    let posDerived = null
    let flags = []
    if (position && mc.length) {
      const entryIdx = mc.findIndex((c) => new Date(c.t * 1000).toISOString().slice(0, 10) >= position.entryDate)
      let trailNow = null
      let trailSeries = []
      let hcse = null
      if (entryIdx >= 0 && settings) {
        trailSeries = anchoredChandelier(mc, {
          entryIdx, atrPeriod: settings.chandelierPeriod, mult: settings.chandelierMult, initialStop: position.initialStop,
        })
        trailNow = trailSeries.length ? trailSeries[trailSeries.length - 1] : null
        hcse = -Infinity
        for (let k = entryIdx; k < mc.length; k++) hcse = Math.max(hcse, mc[k].c)
      }
      let eff = effectiveStop({
        initialStop: position.initialStop, trailStop: trailNow, entry: position.avgEntry,
        beAtR: settings?.beAtR ?? 1, highestCloseSinceEntry: hcse,
      })
      // manual override and the persisted high-water mark only ever RAISE it
      if (Number.isFinite(position.stopOverride)) eff = Math.max(eff ?? -Infinity, position.stopOverride)
      if (Number.isFinite(position.stopHighWater)) eff = Math.max(eff ?? -Infinity, position.stopHighWater)
      const r = price != null ? rMultiple({ entry: position.avgEntry, initialStop: position.initialStop, price }) : null
      flags = exitFlags({ candles: mc, position, effectiveStop: eff })
      posDerived = { entryIdx, trailNow, trailSeries, effStop: Number.isFinite(eff) ? eff : null, r, hcse }
    }

    // prefer the exchange's own session state when the quote is live
    const marketSession = (freshQuote.state === 'live' && quote.data?.marketState) || nyseSessionState(now)
    const directive = composeDirective({
      price, freshQuote, freshBtc, freshCandles,
      regime: reg, btcAlign: align, pullback: pb, breakout: bo,
      exitFlags: flags,
      position: position ? { shares: position.shares, avgEntry: position.avgEntry, initialStop: position.initialStop } : null,
      effectiveStop: posDerived?.effStop ?? null,
      r: posDerived?.r ?? null,
      sizing, addSizing,
      torque: { read: tRead },
      marketSession,
    })

    return {
      price, btcPrice, freshQuote, freshBtc, freshCandles, freshBtcCandles,
      regime: reg, btcAlign: align, pullback: pb, breakout: bo,
      beta, rs, nav, torqueRead: tRead,
      atrNow, lastSwingLow, stopPlan, sizing, addSizing,
      posDerived, flags, directive, marketSession,
      mstrCandles: mc, btcCandles: bc,
    }
  }, [quote.data, quote.fetchedAt, btc.data, btc.fetchedAt,
    mstr1d.data, mstr1d.fetchedAt, btc1d.data, btc1d.fetchedAt, settings, position, now])

  if (needToken) {
    return <TokenGate onDone={() => { setNeedToken(false); window.location.reload() }} />
  }

  const sources = { quote, btc, mstr1d, btc1d, settingsSrc, positionSrc, journalSrc }
  const reloadAll = () => { quote.reload(); btc.reload(); mstr1d.reload(); btc1d.reload(); settingsSrc.reload(); positionSrc.reload() }

  return (
    <ToastProvider>
      <div className="shell">
        <header className="hdr">
          <div className="brand"><span className="bolt">⚡</span>TORQUE <span className="tiny" style={{ fontWeight: 500 }}>MSTR cockpit</span></div>
          <div className="tape">
            <Ticker sym="MSTR" px={derived.price} chg={derived.price == null ? null : quote.data?.changePct}
              fresh={derived.freshQuote} kind={quote.data?.kind} delayedMin={quote.data?.delayedMin} sourceDetail={quote.data?.sourceDetail} />
            <Ticker sym="BTC" px={derived.btcPrice} chg={derived.btcPrice == null ? null : btc.data?.changePct24h}
              fresh={derived.freshBtc} sourceDetail={btc.data?.sourceDetail} />
          </div>
        </header>
        <nav className="nav" aria-label="Main">
          {TABS.map((t) => (
            <button key={t.id} className={tab === t.id ? 'on' : ''} onClick={() => setTab(t.id)} aria-label={t.label}>
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"><path d={t.icon} /></svg>
              {t.label}
            </button>
          ))}
        </nav>
        <main>
          <TabPanel active={tab === 'cockpit'}><Cockpit derived={derived} settings={settings} position={position} sources={sources} onReload={reloadAll} /></TabPanel>
          <TabPanel active={tab === 'chart'}><ChartPanel derived={derived} settings={settings} position={position} /></TabPanel>
          <TabPanel active={tab === 'journal'}><Journal journalSrc={journalSrc} /></TabPanel>
          <TabPanel active={tab === 'settings'}><Settings settingsSrc={settingsSrc} positionSrc={positionSrc} derived={derived} /></TabPanel>
        </main>
        <CommandK items={[
          { label: 'Go to Cockpit', k: ['home', 'dash'], run: () => setTab('cockpit') },
          { label: 'Go to Chart', k: ['candles', 'price'], run: () => setTab('chart') },
          { label: 'Go to Journal', k: ['trades', 'log'], run: () => setTab('journal') },
          { label: 'Go to Settings', k: ['risk', 'config'], run: () => setTab('settings') },
          { label: 'Refresh market data', k: ['reload', 'update'], run: reloadAll },
        ]} />
      </div>
    </ToastProvider>
  )
}

function Ticker({ sym, px, chg, fresh, kind, delayedMin, sourceDetail }) {
  const cls = chg == null ? 'flat' : chg >= 0 ? 'pos' : 'neg'
  return (
    <span className="tk">
      <span className="sym">{sym}</span>
      <span className="px num"><Num v={px} f={fmtPx} /></span>
      <span className={`chg num ${cls}`}>{chg == null ? '' : `${chg >= 0 ? '+' : ''}${round2(chg)}%`}</span>
      <FreshChip fresh={fresh} title={sourceDetail} />
      {kind === 'eod' && <span className="chip stale" title={`end-of-day close via ${sourceDetail || 'fallback'}`}><span className="dot" />EOD</span>}
      {kind === 'delayed' && Number.isFinite(delayedMin) && <span className="tiny" title={sourceDetail}>{delayedMin}m delayed</span>}
    </span>
  )
}

function TokenGate({ onDone }) {
  const [val, setVal] = useState('')
  return (
    <div className="gate">
      <div className="card">
        <div className="ttl">⚡ Torque — access token</div>
        <p className="sub">This cockpit is protected by a shared secret (the <code>DASHBOARD_TOKEN</code> you set on Netlify). Paste it once; it stays in this browser session only.</p>
        <form onSubmit={(e) => { e.preventDefault(); sessionStorage.setItem('torque_token', val.trim()); onDone() }}>
          <div className="field">
            <label htmlFor="tok">Token</label>
            <input id="tok" type="password" value={val} onChange={(e) => setVal(e.target.value)} autoFocus />
          </div>
          <button className="btn primary" type="submit" disabled={!val.trim()}>Unlock</button>
        </form>
      </div>
    </div>
  )
}
