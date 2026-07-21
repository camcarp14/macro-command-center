// Candles + EMAs + the stop/trail drawn where your eye is. Replay overlays
// the rule audit on the same tape. lightweight-charts does the heavy lifting;
// palette is the validated set from styles.css.
import React, { useEffect, useMemo, useRef, useState } from 'react'
import { createChart, LineStyle } from 'lightweight-charts'
import { ema } from '../lib/ta.js'
import { replayRules } from '../lib/replay.js'
import { Seg, FreshChip } from './primitives.jsx'
import { fmtPx, round2 } from '../lib/format.js'

const C = {
  up: '#0FA3A3', down: '#D93A5F', mstr: '#3B72E8', ink3: '#6B7487',
  grid: 'rgba(255,255,255,0.05)', crit: '#E11D48', warn: '#D4930B',
}

export default function ChartPanel({ derived, settings, position }) {
  const [view, setView] = useState('mstr')
  const [showReplay, setShowReplay] = useState(false)
  const candles = view === 'btc' ? derived.btcCandles : derived.mstrCandles

  const replay = useMemo(() => {
    if (view !== 'mstr' || !showReplay || !settings || derived.mstrCandles.length < 61) return null
    return replayRules(derived.mstrCandles, {
      equity: settings.equity, riskPct: settings.riskPct, atrMult: settings.atrMult,
      chandelierPeriod: settings.chandelierPeriod, chandelierMult: settings.chandelierMult, beAtR: settings.beAtR,
    })
  }, [view, showReplay, settings, derived.mstrCandles])

  return (
    <div className="grid">
      <section className="card span2">
        <div className="ttl">
          {view === 'btc' ? 'BTC · daily' : 'MSTR · daily'}
          <span className="spacer" />
          <FreshChip fresh={derived.freshCandles} />
          <Seg value={view} onChange={setView} options={[{ value: 'mstr', label: 'MSTR' }, { value: 'btc', label: 'BTC' }]} />
        </div>
        {candles.length === 0 ? (
          <div className="empty"><div className="glyph">▦</div>No candle history from any source. Check Settings → Data sources.</div>
        ) : (
          <Chart
            candles={candles}
            position={view === 'mstr' ? position : null}
            posDerived={view === 'mstr' ? derived.posDerived : null}
            trades={replay?.trades}
          />
        )}
        {view === 'mstr' && (
          <div style={{ display: 'flex', gap: 10, alignItems: 'center', marginTop: 10, flexWrap: 'wrap' }}>
            <button className={`btn sm${showReplay ? ' primary' : ''}`} onClick={() => setShowReplay((s) => !s)} data-testid="replay-toggle">
              {showReplay ? 'Replay ON' : 'Run rule replay'}
            </button>
            <span className="tiny">replays the ATR-stop variant of the entry/trail rules over this history — fills at next open, 0.1% fees, no lookahead</span>
          </div>
        )}
      </section>

      {replay && (
        <section className="card span2 pagefade" data-testid="replay-summary">
          <div className="ttl">Rule replay — {replay.summary.trades} trades over {Math.round(derived.mstrCandles.length / 21)} months</div>
          {replay.summary.trades === 0 ? (
            <div className="empty">The ruleset never triggered on this tape. That is an answer, not an error.</div>
          ) : (
            <>
              <div className="stats">
                <Stat k="Win rate" v={replay.summary.winRatePct == null ? '—' : `${round2(replay.summary.winRatePct)}%`} d={`${replay.summary.wins}W / ${replay.summary.losses}L`} />
                <Stat k="Avg R" v={fmtR(replay.summary.avgR)} sign={replay.summary.avgR} />
                <Stat k="Total R" v={fmtR(replay.summary.cumR)} sign={replay.summary.cumR} />
                <Stat k="Max DD" v={replay.summary.maxDrawdownR == null ? '—' : `−${round2(replay.summary.maxDrawdownR)}R`} />
                <Stat k="Avg hold" v={replay.summary.avgBars == null ? '—' : `${Math.round(replay.summary.avgBars)} bars`} />
              </div>
              {replay.warnings.length > 0 && (
                <p className="tiny" style={{ marginTop: 8 }}>{replay.warnings.join(' · ')}</p>
              )}
              <p className="tiny" style={{ marginTop: 6 }}>
                A rule audit on one tape — not a promise. Slippage beyond the fee model, halts, and gaps are real life.
              </p>
            </>
          )}
        </section>
      )}
    </div>
  )
}

function Stat({ k, v, d, sign }) {
  const cls = sign == null ? '' : sign >= 0 ? 'pos' : 'neg'
  return <div className="stat"><div className="k">{k}</div><div className={`v num ${cls}`}>{v}</div>{d && <div className="d">{d}</div>}</div>
}
function fmtR(x) { return x == null ? '—' : `${x >= 0 ? '+' : ''}${round2(x)}R` }

function Chart({ candles, position, posDerived, trades }) {
  const ref = useRef(null)
  const chartRef = useRef(null)

  useEffect(() => {
    if (!ref.current) return
    const el = ref.current
    const chart = createChart(el, {
      height: 380,
      layout: { background: { color: 'transparent' }, textColor: '#A2ABBD', fontSize: 11 },
      grid: { vertLines: { color: C.grid }, horzLines: { color: C.grid } },
      rightPriceScale: { borderColor: 'rgba(255,255,255,0.1)' },
      timeScale: { borderColor: 'rgba(255,255,255,0.1)', timeVisible: false },
      crosshair: { mode: 1 },
      handleScroll: { pressedMouseMove: true, horzTouchDrag: true, vertTouchDrag: false },
    })
    chartRef.current = chart
    // Panels stay mounted while hidden (width 0); on reveal, resize — and
    // refit ONLY on the 0→visible transition (data may have been set while
    // the box had no width). Ordinary resizes keep the user's zoom/pan.
    let prevWidth = el.clientWidth
    const ro = new ResizeObserver(() => {
      const w = el.clientWidth
      if (w > 0) {
        chart.applyOptions({ width: w })
        if (prevWidth === 0) chart.timeScale().fitContent()
      }
      prevWidth = w
    })
    ro.observe(el)
    return () => { ro.disconnect(); chart.remove(); chartRef.current = null }
  }, [])

  useEffect(() => {
    const chart = chartRef.current
    if (!chart) return
    // rebuild series on data change (simplest correct thing at this scale)
    const existing = chart._torqueSeries || []
    existing.forEach((s) => { try { chart.removeSeries(s) } catch { /* already gone */ } })
    const series = []

    const candleSeries = chart.addCandlestickSeries({
      upColor: C.up, downColor: C.down, borderUpColor: C.up, borderDownColor: C.down,
      wickUpColor: C.up, wickDownColor: C.down,
    })
    candleSeries.setData(candles.map((c) => ({ time: c.t, open: c.o, high: c.h, low: c.l, close: c.c })))
    series.push(candleSeries)

    const closes = candles.map((c) => c.c)
    for (const [period, color] of [[20, C.mstr], [50, C.ink3]]) {
      const line = chart.addLineSeries({ color, lineWidth: 2, priceLineVisible: false, lastValueVisible: false, crosshairMarkerVisible: false })
      const arr = ema(closes, period)
      line.setData(candles.map((c, i) => arr[i] == null ? null : { time: c.t, value: arr[i] }).filter(Boolean))
      series.push(line)
    }

    if (position && posDerived) {
      if (Number.isFinite(posDerived.effStop)) {
        candleSeries.createPriceLine({ price: posDerived.effStop, color: C.warn, lineWidth: 2, lineStyle: LineStyle.Solid, title: 'stop' })
      }
      if (Number.isFinite(position.initialStop) && position.initialStop !== posDerived.effStop) {
        candleSeries.createPriceLine({ price: position.initialStop, color: C.crit, lineWidth: 1, lineStyle: LineStyle.Dashed, title: 'initial' })
      }
      if (Number.isFinite(position.avgEntry)) {
        candleSeries.createPriceLine({ price: position.avgEntry, color: C.ink3, lineWidth: 1, lineStyle: LineStyle.Dotted, title: 'entry' })
      }
      // trail path since entry
      if (posDerived.trailSeries?.length && posDerived.entryIdx >= 0) {
        const trail = chart.addLineSeries({ color: C.warn, lineWidth: 1, lineStyle: LineStyle.Dashed, priceLineVisible: false, lastValueVisible: false, crosshairMarkerVisible: false })
        trail.setData(posDerived.trailSeries.map((v, i) => v == null ? null : ({ time: candles[posDerived.entryIdx + i].t, value: v })).filter(Boolean))
        series.push(trail)
      }
    }

    if (trades?.length) {
      const byDay = new Map(candles.map((c) => [new Date(c.t * 1000).toISOString().slice(0, 10), c.t]))
      const markers = []
      for (const t of trades) {
        const et = byDay.get(t.entryDate)
        const xt = byDay.get(t.exitDate)
        if (et) markers.push({ time: et, position: 'belowBar', color: C.up, shape: 'arrowUp', text: t.kind === 'pullback' ? 'PB' : 'BO' })
        if (xt) markers.push({ time: xt, position: 'aboveBar', color: t.r >= 0 ? C.up : C.down, shape: 'arrowDown', text: `${t.r >= 0 ? '+' : ''}${t.r}R` })
      }
      candleSeries.setMarkers(markers.sort((a, b) => a.time - b.time))
    }

    chart._torqueSeries = series
    chart.timeScale().fitContent()
  }, [candles, position, posDerived, trades])

  return (
    <div className="chartbox">
      <div className="overlay-legend">
        <span className="legend-swatch"><i style={{ background: C.mstr }} />EMA20</span>
        <span className="legend-swatch"><i style={{ background: C.ink3 }} />EMA50</span>
        {position && <span className="legend-swatch"><i style={{ background: C.warn }} />stop</span>}
      </div>
      <div ref={ref} style={{ width: '100%' }} data-testid="price-chart" />
    </div>
  )
}
