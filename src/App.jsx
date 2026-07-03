import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { computeScore, scoreBand } from './lib/score.js'
import {
  latestValue, curveSpread, pctChangeNBack, freshness, SOURCE_MAX_AGE_SEC,
  stressHealthFactor, liquidationDrawdown, liquidationPrice, STRESS_SCENARIOS, diffLine,
} from './lib/derive.js'
import { buildFactSheet, validateNarrative, displayText } from './lib/narrative.js'
import { buildMarketRead } from './lib/signals.js'
import { evaluateSetups, setupsSummary } from './lib/setups.js'
import { ema, rsi, atr, vwapDaily, regimeRead, hourlyActivity } from './lib/ta.js'
import { projectionCone } from './lib/projection.js'
import { buildAttention, hfBandName } from './lib/attention.js'
import { createChart } from 'lightweight-charts'

// Simple/Advanced is driven by one CSS class on the shell (see App()).
// `.advanced-only` elements hide in Simple mode; `.simple-only` elements
// hide in Advanced mode. Nothing is removed either way — Simple just
// leads with plain sentences instead of the raw formula table.

function scoreHeadline(score, band, breakdown) {
  if (score == null) return 'Not enough live data yet to compute a score.'
  const top = [...(breakdown || [])].filter((b) => b.included).sort((a, b) => b.contribution - a.contribution)[0]
  const driver = top ? ` — ${top.label} is doing the most to push it there.` : ''
  const bandPlain = { benign: 'calm', tightening: 'starting to tighten', elevated: 'elevated', stress: 'showing real stress' }[band.name] || band.name
  return `Conditions read ${bandPlain} right now (${fmt(score, 0)}/100)${driver}`
}

/* ---------------- API plumbing ---------------- */
function getToken() { return sessionStorage.getItem('mcc_token') || '' }

async function api(path, opts = {}) {
  const headers = { ...(opts.headers || {}) }
  const tok = getToken()
  if (tok) headers['x-dashboard-token'] = tok
  if (opts.body) headers['content-type'] = 'application/json'
  const res = await fetch(`/api/${path}`, { ...opts, headers })
  const body = await res.json().catch(() => ({}))
  if (res.status === 401) { const e = new Error('unauthorized'); e.code = 401; throw e }
  if (!res.ok) { const e = new Error(body.error || `HTTP ${res.status}`); e.body = body; throw e }
  return body
}

const SOURCES = ['fred', 'market', 'funding', 'feargreed', 'aave']

function useSources() {
  const [state, setState] = useState({})
  const [needToken, setNeedToken] = useState(false)

  const load = useCallback(async (name, path = name) => {
    setState((s) => ({ ...s, [name]: { ...s[name], loading: true } }))
    try {
      const data = await api(path)
      setState((s) => ({ ...s, [name]: { data, error: null, fetchedAt: data?.meta?.fetchedAt ?? Date.now(), loading: false } }))
    } catch (e) {
      if (e.code === 401) { setNeedToken(true); return }
      setState((s) => ({ ...s, [name]: { ...s[name], error: e.message, loading: false, lastErrorAt: Date.now() } }))
    }
  }, [])

  const loadAll = useCallback(() => {
    for (const n of SOURCES) load(n)
    load('status')
    load('history', 'history?n=400')
    load('btchistory')
  }, [load])

  useEffect(() => {
    loadAll()
    const t = setInterval(() => { for (const n of SOURCES) load(n); load('status') }, 60_000)
    const h = setInterval(() => load('history', 'history?n=400'), 5 * 60_000)
    const bh = setInterval(() => load('btchistory'), 30 * 60_000)
    return () => { clearInterval(t); clearInterval(h); clearInterval(bh) }
  }, [load, loadAll])

  return { state, load, needToken, setNeedToken, loadAll }
}

/* ---------------- Metric assembly (mirrors the snapshot function) ---------------- */
function buildMetrics(S) {
  const m = {}
  const fred = S.fred?.data?.series
  if (fred) {
    m.ust10y = latestValue(fred.DGS10)?.value ?? null
    m.ust2y = latestValue(fred.DGS2)?.value ?? null
    m.dff = latestValue(fred.DFF)?.value ?? null
    m.dollar = latestValue(fred.DTWEXBGS)?.value ?? null
    m.hy_oas = latestValue(fred.BAMLH0A0HYM2)?.value ?? null
    m.walcl = latestValue(fred.WALCL)?.value ?? null
    m.curve_2s10s = curveSpread(fred.DGS10, fred.DGS2)?.value ?? null
    m.qt_13w = pctChangeNBack(fred.WALCL, 13)?.value ?? null
    m.policy_gap = Number.isFinite(m.dff) ? +(m.dff - 2.5).toFixed(3) : null
    const oasObs = (fred.BAMLH0A0HYM2 || []).filter((o) => Number.isFinite(o.v))
    m.hy_oas_4w_chg = oasObs.length > 20 ? +(oasObs[0].v - oasObs[20].v).toFixed(2) : null
  }
  const mk = S.market?.data
  if (mk) { m.btc = mk.btc; m.btc_24h = mk.btc24hPct }
  const fu = S.funding?.data
  if (fu) { m.funding_ann = fu.fundingAnnualizedPct; m.funding_8h = fu.funding8h; m.funding_venue = fu.venue }
  const fg = S.feargreed?.data
  if (fg) m.fear_greed = fg.value
  const av = S.aave?.data
  if (av) {
    m.aave_hf = av.healthFactor
    const dd = liquidationDrawdown(av.healthFactor)
    m.aave_liq_dd = dd == null ? null : +(dd * 100).toFixed(2)
  }
  return m
}

function withDeltas(m, snaps) {
  if (!snaps?.length) return m
  const target = Date.now() - 24 * 3600 * 1000
  let prev = snaps[0]
  for (const s of snaps) if (Math.abs(s.ts - target) < Math.abs(prev.ts - target)) prev = s
  const out = { ...m }
  for (const k of ['score', 'btc', 'ust10y', 'curve_2s10s', 'hy_oas', 'dollar', 'funding_ann', 'fear_greed', 'dff', 'aave_hf']) {
    const a = prev.metrics?.[k]
    if (Number.isFinite(a) && Number.isFinite(m[k])) out[k + '_delta'] = +(m[k] - a).toFixed(k === 'btc' ? 0 : 3)
  }
  return out
}

/* ---------------- Shared bits ---------------- */
const fmt = (v, dp = 2) => (Number.isFinite(v) ? v.toLocaleString(undefined, { minimumFractionDigits: dp, maximumFractionDigits: dp }) : '—')
const usd = (v, dp = 0) => (Number.isFinite(v) ? '$' + v.toLocaleString(undefined, { minimumFractionDigits: dp, maximumFractionDigits: dp }) : '—')
const bn = (v) => (Number.isFinite(v) ? '$' + (v / 1e9).toFixed(1) + 'B' : '—')
const hhmmss = (t) => (t ? new Date(t).toLocaleTimeString([], { hour12: false }) : '—')
const ago = (t) => {
  if (!t) return '—'
  const s = Math.max(0, Math.round((Date.now() - t) / 1000))
  if (s < 90) return `${s}s ago`
  if (s < 5400) return `${Math.round(s / 60)}m ago`
  if (s < 172800) return `${Math.round(s / 3600)}h ago`
  return `${Math.round(s / 86400)}d ago`
}

function srcStatus(S, name) {
  const e = S[name]
  const hasData = !!e?.data && !e?.data?.meta?.failed
  if (!e || (e.loading && !hasData)) return 'sync'
  return freshness(e?.fetchedAt, SOURCE_MAX_AGE_SEC[name] ?? 600, Date.now(), hasData, !!e?.error)
}

function Badge({ status, at }) {
  const label = { live: 'live', stale: 'stale', down: 'down', sync: 'sync…', watch: 'watch' }[status] || status
  return <span className={`badge ${status}`}>{label}{at ? ` · ${hhmmss(at)}` : ''}</span>
}

function Spark({ points, width = 150, height = 30 }) {
  const clean = (points || []).filter(Number.isFinite)
  if (clean.length < 3) return <div className="spark-note">building history ({clean.length}/3 pts)</div>
  const min = Math.min(...clean), max = Math.max(...clean)
  const span = max - min || 1
  const step = width / (clean.length - 1)
  const pts = clean.map((v, i) => `${(i * step).toFixed(1)},${(height - 3 - ((v - min) / span) * (height - 6)).toFixed(1)}`).join(' ')
  return (
    <svg className="spark" width={width} height={height} role="img" aria-label="sparkline">
      <line className="base" x1="0" y1={height - 1} x2={width} y2={height - 1} />
      <polyline points={pts} />
    </svg>
  )
}

function MetricCard({ label, value, sub, spark, status, at, source, dataAsOf }) {
  return (
    <div className="panel">
      <div className="label">{label}</div>
      <div className="bigval">{value}</div>
      {sub ? <div className="sub">{sub}</div> : null}
      {spark}
      <div className="provenance">
        <Badge status={status} at={at} />
        <span>{source}{dataAsOf ? ` · data ${dataAsOf}` : ''}</span>
      </div>
    </div>
  )
}

/* ---------------- Tabs ---------------- */

function AttentionStack({ S, metrics, scored, band, changeLine }) {
  const [regime, setRegime] = useState(null)
  useEffect(() => {
    let dead = false
    const go = () => api('candles?tf=15m').then((d) => { if (!dead) setRegime(regimeRead(d.candles)) }).catch(() => { if (!dead) setRegime(null) })
    go()
    const t = setInterval(go, 5 * 60_000)
    return () => { dead = true; clearInterval(t) }
  }, [])
  const btcStats = S.btchistory?.data?.stats || null
  const setups = useMemo(() => evaluateSetups({ m: metrics, btc: btcStats }), [metrics, btcStats])
  const items = useMemo(
    () => buildAttention({ metrics, score: scored.score, bandName: band.name, setups, regime, changeLine }),
    [metrics, scored.score, band.name, setups, regime, changeLine]
  )
  return (
    <div className="panel attention">
      <h2 className="sec">Right now</h2>
      <ol className="attn">
        {items.map((it, i) => (
          <li key={i} className={`attn-item ${it.tone}`}>
            <span className="attn-title">{it.title}</span>
            <span className="attn-body">{it.body}</span>
          </li>
        ))}
      </ol>
    </div>
  )
}

function Overview({ S, load }) {
  const snaps = S.history?.data?.snapshots || []
  const metrics = useMemo(() => withDeltas(buildMetrics(S), snaps), [S, snaps])
  const scored = useMemo(() => computeScore(metrics), [metrics])
  const band = scoreBand(scored.score)
  const fred = S.fred?.data?.series

  const [lastSeenLine, setLastSeenLine] = useState(null)
  const stamped = useRef(false)
  useEffect(() => {
    if (stamped.current || !snaps.length || scored.score == null) return
    stamped.current = true
    const lastSeen = Number(localStorage.getItem('mcc_last_seen')) || null
    if (lastSeen) {
      let prev = snaps[0]
      for (const s of snaps) if (Math.abs(s.ts - lastSeen) < Math.abs(prev.ts - lastSeen)) prev = s
      setLastSeenLine(diffLine(prev.metrics, { ...metrics, score: scored.score }))
    }
    localStorage.setItem('mcc_last_seen', String(Date.now()))
  }, [snaps, metrics, scored.score])

  const fredSpark = (id) => (fred?.[id] || []).slice(0, 60).map((o) => o.v).reverse()
  const snapSpark = (k) => snaps.map((s) => s.metrics?.[k])
  const fredDate = (id) => latestValue(fred?.[id])?.date
  const fS = srcStatus(S, 'fred'), fAt = S.fred?.fetchedAt

  return (
    <>
      <AttentionStack S={S} metrics={metrics} scored={scored} band={band} changeLine={lastSeenLine} />

      <div className="panel section-gap">
        <div className="simple-only headline">{scoreHeadline(scored.score, band, scored.breakdown)}</div>
        <div className="scorewrap">
          <div className="scorebox">
            <div className="label">Macro pressure score · 0–100</div>
            <div className="scoreval" style={{ color: `var(--${band.tone === 'watch' ? 'watch' : band.tone})` }}>
              {scored.score == null ? '—' : fmt(scored.score, 1)}
            </div>
            <div className="scoreband" style={{ color: `var(--${band.tone === 'watch' ? 'watch' : band.tone})` }}>{band.name}</div>
            <div className="sub advanced-only" style={{ marginTop: 8 }}>
              {scored.inputsUsed}/{scored.inputsTotal} inputs{scored.renormalized ? ' · weights renormalized' : ''}
            </div>
            <Spark points={snapSpark('score')} width={190} height={36} />
            <div className="spark-note">score history · 30-min snapshots</div>
          </div>
          <table className="ledger" aria-label="score formula">
            <thead>
              <tr><th>Input</th><th className="r">Value</th><th className="r hide-sm advanced-only">Range → norm</th><th className="r advanced-only">Weight</th><th className="r">Contrib</th><th className="hide-sm"></th></tr>
            </thead>
            <tbody>
              {scored.breakdown.map((b) => (
                <tr key={b.key} className={b.included ? '' : 'excluded'} title={b.note}>
                  <td>{b.label}</td>
                  <td className="r">{b.included ? `${fmt(b.value, 2)}${b.unit}` : 'source down'}</td>
                  <td className="r hide-sm advanced-only">{b.included ? `[${b.min}…${b.max}]${b.direction === -1 ? ' inv' : ''} → ${fmt(b.normalized, 1)}` : '—'}</td>
                  <td className="r advanced-only">{(b.effectiveWeight * 100).toFixed(1)}%{b.effectiveWeight !== b.baseWeight && b.included ? '*' : ''}</td>
                  <td className="r">{b.included ? `+${fmt(b.contribution, 2)}` : 'excluded'}</td>
                  <td className="hide-sm"><div className="cbar"><i style={{ width: `${b.included ? Math.min(100, (b.contribution / 25) * 100) : 0}%` }} /></div></td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <div className="formula-note advanced-only">
          score = Σ weightᵢ × normᵢ(valueᵢ) · norm clamps value into [min…max] → 0–100 ("inv" flips direction) · missing sources are excluded and remaining weights renormalized (*) — shown, never hidden. Edit weights in <span className="mono">src/lib/score.js</span>.
        </div>
      </div>

      <MarketRead metrics={metrics} />

      <div className="grid cards section-gap">
        <MetricCard label="10Y Treasury" value={`${fmt(metrics.ust10y)}%`} sub={`2Y ${fmt(metrics.ust2y)}%`}
          spark={<Spark points={fredSpark('DGS10')} />} status={fS} at={fAt} source="FRED DGS10" dataAsOf={fredDate('DGS10')} />
        <MetricCard label="Yield curve slope (2s10s)" value={`${fmt(metrics.curve_2s10s)}pp`} sub={metrics.curve_2s10s < 0 ? 'inverted — short rates above long' : 'normal — long rates above short'}
          spark={<Spark points={snapSpark('curve_2s10s')} />} status={fS} at={fAt} source="FRED DGS10−DGS2" dataAsOf={fredDate('DGS10')} />
        <MetricCard label="Fed funds (eff.)" value={`${fmt(metrics.dff)}%`} sub={`vs 2.5 neutral: +${fmt(metrics.policy_gap)}pp`}
          spark={<Spark points={fredSpark('DFF')} />} status={fS} at={fAt} source="FRED DFF" dataAsOf={fredDate('DFF')} />
        <MetricCard label="Dollar strength (DXY-style)" value={fmt(metrics.dollar)} sub="Broad trade-weighted index"
          spark={<Spark points={fredSpark('DTWEXBGS')} />} status={fS} at={fAt} source="FRED DTWEXBGS" dataAsOf={fredDate('DTWEXBGS')} />
        <MetricCard label="Corporate credit risk (HY OAS)" value={`${fmt(metrics.hy_oas)}%`} sub="Extra yield junk bonds pay over Treasuries"
          spark={<Spark points={fredSpark('BAMLH0A0HYM2')} />} status={fS} at={fAt} source="FRED BAMLH0A0HYM2" dataAsOf={fredDate('BAMLH0A0HYM2')} />
        <MetricCard label="Fed balance sheet (liquidity)" value={Number.isFinite(metrics.walcl) ? `$${(metrics.walcl / 1e6).toFixed(2)}T` : '—'} sub={`13w Δ ${fmt(metrics.qt_13w)}% — shrinking = liquidity drain`}
          spark={<Spark points={fredSpark('WALCL')} />} status={fS} at={fAt} source="FRED WALCL" dataAsOf={fredDate('WALCL')} />
        <MetricCard label="BTC spot" value={usd(metrics.btc)} sub={`24h ${fmt(metrics.btc_24h)}%`}
          spark={<Spark points={snapSpark('btc')} />} status={srcStatus(S, 'market')} at={S.market?.fetchedAt} source="CoinGecko" />
        <MetricCard label="Leverage cost (BTC funding)" value={`${fmt(metrics.funding_ann)}% ann.`} sub={`8h ${Number.isFinite(metrics.funding_8h) ? (metrics.funding_8h * 100).toFixed(4) : '—'}% · ${metrics.funding_venue || ''}`}
          spark={<Spark points={snapSpark('funding_ann')} />} status={srcStatus(S, 'funding')} at={S.funding?.fetchedAt} source={metrics.funding_venue === 'binance' ? 'Binance (fallback)' : 'Deribit'} />
        <MetricCard label="Fear & Greed" value={fmt(metrics.fear_greed, 0)} sub={S.feargreed?.data?.classification || ''}
          spark={<Spark points={snapSpark('fear_greed')} />} status={srcStatus(S, 'feargreed')} at={S.feargreed?.fetchedAt} source="alternative.me" />
      </div>

      <Narrative metrics={{ ...metrics, score: scored.score }} />
    </>
  )
}

function SetupsGrid({ S }) {
  const metrics = buildMetrics(S)
  const btcStats = S.btchistory?.data?.stats || null
  const evaluated = useMemo(() => evaluateSetups({ m: metrics, btc: btcStats }), [metrics, btcStats])

  return (
      <div className="panel section-gap">
        <h2 className="sec">Setups · transparent condition checklists</h2>
        <div className="sub" style={{ marginBottom: 12 }}>
          A setup is ACTIVE when every listed condition currently holds — a historically notable state, described. Missing data never counts as met. Thresholds live in <span className="mono">src/lib/setups.js</span>.
        </div>
        <div className="grid" style={{ gridTemplateColumns: 'repeat(auto-fill, minmax(340px, 1fr))' }}>
          {evaluated.map((su) => (
            <div key={su.key} className="panel setupcard" style={{ background: 'var(--panel-2)' }}>
              <div className="label">{su.stance}</div>
              <div className="setupname">{su.name}</div>
              <div className={`setupstate ${su.active ? 'live' : ''}`}>
                {su.active ? 'ACTIVE' : `${su.met} of ${su.total} conditions met${su.unknown ? ` · ${su.unknown} unknown` : ''}`}
              </div>
              <ul className="conds">
                {su.conditions.map((c, i) => (
                  <li key={i} className={c.met === true ? 'met' : c.met === false ? 'unmet' : 'unk'}>
                    <span className="tick">{c.met === true ? '✓' : c.met === false ? '✕' : '?'}</span>
                    <span>{c.label}</span>
                    <span className="cv num">{c.valueText}</span>
                  </li>
                ))}
              </ul>
              <div className="sub setupnote">{su.note}</div>
            </div>
          ))}
        </div>
      </div>

  )
}

function TriggerHistory({ S }) {
  const metrics = buildMetrics(S)
  const [triggers, setTriggers] = useState(null)
  const telegramOn = S.status?.data?.alerts?.telegram
  useEffect(() => {
    api('triggers').then((d) => setTriggers(d.triggers.slice().reverse())).catch(() => setTriggers([]))
  }, [])
  const btcNow = metrics.btc
  return (
      <div className="panel section-gap">
        <h2 className="sec">Trigger history · the setups' report card</h2>
        <div className="sub" style={{ marginBottom: 10 }}>
          Every activation is logged with BTC's price at that moment (checked every 30 min by the snapshot job). Over time this is the evidence a setup has — or hasn't — earned trust. No track record yet means exactly that.
        </div>
        {triggers === null && <div className="sub">loading…</div>}
        {triggers?.length === 0 && <div className="dim">No activations recorded yet. The snapshot job evaluates all setups every 30 minutes and will log the first one that fires.</div>}
        {triggers?.length > 0 && (
          <table className="stress">
            <thead><tr><th>When</th><th>Setup</th><th>BTC at trigger</th><th>BTC now</th><th>Since trigger</th></tr></thead>
            <tbody>
              {triggers.map((t, i) => {
                const chg = Number.isFinite(t.btc) && Number.isFinite(btcNow) ? ((btcNow - t.btc) / t.btc) * 100 : null
                return (
                  <tr key={i}>
                    <td>{new Date(t.ts).toLocaleString()}</td>
                    <td>{t.name}</td>
                    <td>{usd(t.btc)}</td>
                    <td>{usd(btcNow)}</td>
                    <td className={chg == null ? '' : chg >= 0 ? 'hf-safe' : 'hf-danger'}>{chg == null ? '—' : `${chg >= 0 ? '+' : ''}${chg.toFixed(1)}%`}</td>
                  </tr>
                )
              })}
            </tbody>
          </table>
        )}
        <div className="provenance">
          <Badge status={telegramOn ? 'live' : 'sync'} />
          <span>{telegramOn ? 'Telegram alerts connected — activations and health-factor degradations ping you.' : 'Telegram alerts not configured — set TELEGRAM_BOT_TOKEN + TELEGRAM_CHAT_ID in Netlify env vars to get pinged on activations and HF degradation.'}</span>
        </div>
        <div className="caveat">
          Conditions reads with honest historical framing — not recommendations to buy, sell, or hold, and not financial advice. Small trigger samples prove nothing; that's why the log exists.
        </div>
      </div>
  )
}

function MarketRead({ metrics }) {
  const reads = useMemo(() => buildMarketRead(metrics), [metrics])
  if (reads.length === 0) return null
  return (
    <div className="panel section-gap">
      <h2 className="sec">Market read · plain English</h2>
      <div className="grid cards">
        {reads.map((r) => (
          <div className="panel signal" key={r.key} style={{ background: 'var(--panel-2)' }}>
            <div className="label">{r.label}</div>
            <div className={`sigstate ${r.tone}`}>{r.state}</div>
            <div className="sub sig-plain">{r.plain}</div>
          </div>
        ))}
      </div>
      <div className="caveat section-gap">
        Descriptive read of the live data above at the thresholds in <span className="mono">src/lib/signals.js</span> — not a recommendation to buy, sell, or hold anything. Not financial advice; I'm not a licensed advisor. Markets can stay extreme longer than these labels suggest.
      </div>
    </div>
  )
}

function Narrative({ metrics }) {
  const [busy, setBusy] = useState(false)
  const [result, setResult] = useState(null)
  const [err, setErr] = useState(null)

  const run = async () => {
    setBusy(true); setErr(null)
    try {
      const facts = buildFactSheet(metrics)
      const res = await api('narrative', { method: 'POST', body: JSON.stringify({ facts }) })
      // Trust nothing: re-validate locally against the same facts we sent.
      const local = validateNarrative(res.text, facts)
      setResult({ ...res, validation: local.ok && res.validation?.ok ? local : { ok: false, errors: [...new Set([...(res.validation?.errors || []), ...local.errors])] } })
    } catch (e) { setErr(e.message) } finally { setBusy(false) }
  }

  return (
    <div className="panel section-gap">
      <h2 className="sec">Morning take</h2>
      <button className="btn primary" onClick={run} disabled={busy}>{busy ? 'writing…' : 'Generate from current on-screen data'}</button>
      {err && <div className="sub" style={{ color: 'var(--down)', marginTop: 8 }}>{err}</div>}
      {result && result.validation.ok && (
        <div className="take section-gap">
          {displayText(result.text)}
          <div className="provenance">
            <Badge status="live" at={Date.now()} />
            <span>validated against on-screen facts · {result.model} · {result.usage.inputTokens}+{result.usage.outputTokens} tok · {result.usage.costUsd != null ? `$${result.usage.costUsd.toFixed(4)}` : 'unpriced model'}</span>
          </div>
        </div>
      )}
      {result && !result.validation.ok && (
        <div className="take-fail section-gap">
          <div className="label">Narrative failed validation — not shown</div>
          <ul>{result.validation.errors.map((e, i) => <li key={i}>{e}</li>)}</ul>
          <div className="sub" style={{ marginTop: 6 }}>The call was still logged to the token ledger. Regenerate or ignore — the numbers on screen remain the source of truth.</div>
        </div>
      )}
    </div>
  )
}

function Position({ S, load }) {
  const a = S.aave?.data
  const btc = S.market?.data?.btc
  const status = srcStatus(S, 'aave')
  const hf = a?.healthFactor
  const liqDd = liquidationDrawdown(hf)
  const liqPx = liquidationPrice(btc, hf)
  const hfClass = (v) => (v == null ? '' : v < 1 ? 'hf-danger' : v < 1.25 ? 'hf-warn' : 'hf-safe')
  const btcStats = S.btchistory?.data?.stats
  const band = hfBandName(hf)
  const coneCheck = useMemo(() => {
    const c = projectionCone({ lastPrice: btcStats?.last, realizedVolPct: btcStats?.realizedVol30Pct, horizonDays: 30 })
    if (!c || !Number.isFinite(liqPx)) return null
    const sm = c.summary
    let zone, tone
    if (liqPx < sm.dn95) { zone = 'below the 95% band'; tone = 'live' }
    else if (liqPx < sm.bear1s) { zone = 'inside the 1–2σ zone'; tone = 'stale' }
    else { zone = 'inside the ±1σ band'; tone = 'down' }
    return { zone, tone, dn95: sm.dn95, bear1s: sm.bear1s }
  }, [btcStats, liqPx])

  return (
    <>
    {a && !a.noDebt && Number.isFinite(hf) && (
      <div className="panel" style={{ marginBottom: 12 }}>
        <div className="headline" style={{ marginBottom: 0, paddingBottom: 0, borderBottom: 'none' }}>
          Health factor {fmt(hf, 2)} ({band}) — liquidation sits ≈ {fmt(Math.abs(liquidationDrawdown(hf) * 100), 1)}% below spot at {usd(liqPx)}.
          {coneCheck ? ` At current 30-day vol, that price is ${coneCheck.zone} of the one-month projection.` : ''}
        </div>
      </div>
    )}
    <div className="grid two">
      <div className="panel">
        <h2 className="sec">Aave V3 · Arbitrum · WBTC position</h2>
        {!a && <div className="sub">{S.aave?.error || 'loading…'}</div>}
        {a?.noDebt && <div className="sub">No outstanding debt on this wallet — health factor not applicable.</div>}
        {a && !a.noDebt && (
          <>
            <div className="hfline">
              <div>
                <div className="label">Health factor</div>
                <div className={`bigval ${hfClass(hf)}`} style={{ fontSize: 40 }}>{fmt(hf, 3)}</div>
              </div>
              <div>
                <div className="label">Collateral</div>
                <div className="bigval">{usd(a.collateralUsd)}</div>
              </div>
              <div>
                <div className="label">Debt</div>
                <div className="bigval">{usd(a.debtUsd)}</div>
              </div>
              <div>
                <div className="label">Liq. threshold</div>
                <div className="bigval">{fmt(a.liquidationThresholdPct, 1)}%</div>
              </div>
            </div>
            {Number.isFinite(liqPx) && Number.isFinite(btc) && (
              <>
                <div className="liqbar" role="img" aria-label="distance to liquidation">
                  <div className="fill" style={{ width: `${Math.min(100, (liqPx / btc) * 100)}%` }} />
                  <div className="mark" style={{ left: `${Math.min(100, (liqPx / btc) * 100)}%` }} />
                  <div className="tag" style={{ left: `${Math.min(100, (liqPx / btc) * 100)}%` }}>liq ≈ {usd(liqPx)}</div>
                  <div className="now" style={{ left: '100%' }} />
                  <div className="tag" style={{ left: '100%' }}>now {usd(btc)}</div>
                </div>
                <div className="assume">
                  Liquidation at ≈ {fmt(liqDd * 100, 1)}% BTC drawdown. Assumes collateral is 100% BTC-correlated and debt is stable-denominated — matches a WBTC-collateral / USD-debt structure; if you borrow BTC-correlated assets this math understates risk.
                </div>
              </>
            )}
          </>
        )}
        <div className="provenance"><Badge status={status} at={S.aave?.fetchedAt} /><span>on-chain read · Pool {a?.pool ? a.pool.slice(0, 8) + '…' : ''} · arb1 RPC</span></div>
      </div>

      <div className="panel">
        <h2 className="sec">Stress test · BTC drawdown scenarios</h2>
        {a && !a.noDebt ? (
          <table className="stress">
            <thead><tr><th>Scenario</th><th>BTC price</th><th>Health factor</th><th>State</th></tr></thead>
            <tbody>
              <tr><td>now</td><td>{usd(btc)}</td><td className={hfClass(hf)}>{fmt(hf, 3)}</td><td className={hfClass(hf)}>{hf < 1 ? 'LIQUIDATABLE' : hf < 1.25 ? 'thin' : 'ok'}</td></tr>
              {STRESS_SCENARIOS.map((s) => {
                const shf = stressHealthFactor(hf, s)
                return (
                  <tr key={s}>
                    <td>{(s * 100).toFixed(0)}%</td>
                    <td>{usd(btc * (1 + s))}</td>
                    <td className={hfClass(shf)}>{fmt(shf, 3)}</td>
                    <td className={hfClass(shf)}>{shf < 1 ? 'LIQUIDATED' : shf < 1.25 ? 'thin' : 'ok'}</td>
                  </tr>
                )
              })}
              {Number.isFinite(liqDd) && (
                <tr>
                  <td className="hf-danger">{fmt(liqDd * 100, 1)}%</td>
                  <td className="hf-danger">{usd(liqPx)}</td>
                  <td className="hf-danger">1.000</td>
                  <td className="hf-danger">LIQUIDATION LINE</td>
                </tr>
              )}
            </tbody>
          </table>
        ) : (
          <div className="sub">Waiting on position data.</div>
        )}
      </div>
    </div>

    {a && !a.noDebt && Number.isFinite(liqPx) && (
      <div className="panel section-gap">
        <h2 className="sec">Liquidation vs. the volatility cone · one-month view</h2>
        <ProjectionCone series={S.btchistory?.data?.series} stats={btcStats} overlay={{ price: liqPx, label: 'liquidation' }} />
        <div className="caveat">
          The dashed red line is your liquidation price drawn on the same volatility-implied ranges as the Trade Desk projection. "Below the 95% band" means a one-month move to liquidation would be an outside-the-cone event at current vol — which BTC produces more often than a normal distribution says it should. Same assumptions, same caveats: a distribution, not a forecast.
        </div>
      </div>
    )}
    </>
  )
}

const THESIS = [
  { claim: 'Hawkish Fed: policy well above neutral, curve inverted', keys: (m) => `DFF ${fmt(m.dff)}% · 2s10s ${fmt(m.curve_2s10s)}pp` },
  { claim: 'Liquidity drain: balance sheet shrinking (QT)', keys: (m) => `WALCL 13w Δ ${fmt(m.qt_13w)}%` },
  { claim: 'Credit not yet pricing stress → asymmetric if it does', keys: (m) => `HY OAS ${fmt(m.hy_oas)}%` },
  { claim: 'Dollar strength = global tightening transmission', keys: (m) => `Broad USD ${fmt(m.dollar)}` },
  { claim: 'Speculative froth persists in crypto leverage', keys: (m) => `Funding ${fmt(m.funding_ann)}% ann · F&G ${fmt(m.fear_greed, 0)}` },
  { claim: 'Hyperscaler capex + lease commitments compounding (circular AI financing)', keys: () => 'EDGAR table below' },
]

function Thesis({ S, load }) {
  const metrics = buildMetrics(S)
  const [edgar, setEdgar] = useState(null)
  const [edgarErr, setEdgarErr] = useState(null)
  const [refreshing, setRefreshing] = useState(false)
  const [notes, setNotes] = useState([])
  const [noteText, setNoteText] = useState('')

  const loadEdgar = useCallback(async (force = false) => {
    setRefreshing(true); setEdgarErr(null)
    try { setEdgar(await api(`edgar${force ? '?refresh=1' : ''}`)) }
    catch (e) { setEdgarErr(e.message) }
    finally { setRefreshing(false) }
  }, [])
  const loadNotes = useCallback(async () => {
    try { setNotes((await api('notes')).notes.slice().reverse()) } catch { /* surfaced via sources tab */ }
  }, [])
  useEffect(() => { loadEdgar(); loadNotes() }, [loadEdgar, loadNotes])

  const addNote = async () => {
    if (!noteText.trim()) return
    const res = await api('notes', { method: 'POST', body: JSON.stringify({ text: noteText.trim() }) })
    setNotes(res.notes.slice().reverse()); setNoteText('')
  }
  const delNote = async (ts) => {
    const res = await api(`notes?ts=${ts}`, { method: 'DELETE' })
    setNotes(res.notes.slice().reverse())
  }

  const edgarStale = edgar?.meta?.cache === 'stale-after-error'
  const snaps = S.history?.data?.snapshots || []
  const scoredNow = computeScore(metrics)
  const bandNow = scoreBand(scoredNow.score)
  const creditBreak = useMemo(() => evaluateSetups({ m: metrics, btc: S.btchistory?.data?.stats || null }).find((x) => x.key === 'credit_break'), [metrics, S.btchistory])
  return (
    <>
      <div className="panel">
        <h2 className="sec">Thesis scoreboard · claims vs. tape</h2>
        <div className="grid" style={{ gridTemplateColumns: 'repeat(auto-fit, minmax(240px, 1fr))' }}>
          <div className="panel" style={{ background: 'var(--panel-2)' }}>
            <div className="label">Macro pressure now</div>
            <div className="bigval" style={{ color: `var(--${bandNow.tone === 'watch' ? 'watch' : bandNow.tone})` }}>{scoredNow.score == null ? '—' : fmt(scoredNow.score, 1)} <span style={{ fontSize: 14 }}>{bandNow.name}</span></div>
            <Spark points={snaps.map((x) => x.metrics?.score)} width={200} height={30} />
          </div>
          <div className="panel" style={{ background: 'var(--panel-2)' }}>
            <div className="label">Credit regime break · thesis trigger</div>
            <div className="bigval">{creditBreak ? `${creditBreak.met} / ${creditBreak.total}` : '—'} <span style={{ fontSize: 14 }}>conditions</span></div>
            <div className="sub">{creditBreak?.active ? 'ACTIVE — the environment the thesis needs.' : creditBreak ? `Missing: ${creditBreak.conditions.filter((c) => c.met !== true).map((c) => c.valueText).join(' · ')}` : 'evaluating…'}</div>
          </div>
        </div>
        <div className="caveat">The thesis is a claim about where these numbers go. This strip is the referee — full checklist on the Trade Desk.</div>
      </div>

      <div className="panel section-gap">
        <h2 className="sec">Thesis elements · live reads</h2>
        {THESIS.map((t, i) => (
          <div className="thesis-el" key={i}>
            <div className="claim">{t.claim}</div>
            <div className="read">{t.keys(metrics)}</div>
          </div>
        ))}
      </div>

      <div className="panel section-gap">
        <h2 className="sec">Hyperscalers · quarterly capex &amp; lease liabilities (EDGAR XBRL)</h2>
        {edgarErr && <div className="sub" style={{ color: 'var(--down)' }}>{edgarErr}</div>}
        {edgar && (
          <>
            <table className="edgar">
              <thead><tr><th>Company</th><th>Capex (last Q)</th><th>QoQ</th><th>YoY</th><th>Lease liab.</th><th>QoQ</th></tr></thead>
              <tbody>
                {edgar.companies?.map((c) => (
                  <tr key={c.ticker} title={c.errors?.join(' · ') || ''}>
                    <td>{c.ticker}</td>
                    <td>{bn(c.derived?.capexLatest?.usd)} <span className="dim">{c.derived?.capexLatest?.frame || ''}</span></td>
                    <td className={cls(c.derived?.capexQoQPct)}>{pctTxt(c.derived?.capexQoQPct)}</td>
                    <td className={cls(c.derived?.capexYoYPct)}>{pctTxt(c.derived?.capexYoYPct)}</td>
                    <td>{bn(c.derived?.leaseLatest?.usd)}</td>
                    <td className={cls(c.derived?.leaseQoQPct)}>{pctTxt(c.derived?.leaseQoQPct)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
            <div className="provenance">
              <Badge status={edgarStale ? 'stale' : 'live'} at={edgar.meta?.fetchedAt} />
              <span>SEC EDGAR · weekly cache ({edgar.meta?.cache}){edgarStale ? ` · refresh failed: ${edgar.meta?.staleError}` : ''}</span>
              <button className="btn" style={{ marginLeft: 'auto' }} onClick={() => loadEdgar(true)} disabled={refreshing}>{refreshing ? 'refreshing…' : 'refresh now'}</button>
            </div>
            <div className="caveat">{edgar.caveat}</div>
          </>
        )}
      </div>

      <div className="panel section-gap">
        <h2 className="sec">Manual timeline · things the feeds can't see</h2>
        <div className="note-row">
          <input value={noteText} onChange={(e) => setNoteText(e.target.value)} placeholder='e.g. "Oracle 5Y CDS widened 40bps on the lease headline"'
            onKeyDown={(e) => e.key === 'Enter' && addNote()} />
          <button className="btn primary" onClick={addNote}>Log</button>
        </div>
        <ul className="notes">
          {notes.map((n) => (
            <li key={n.ts}><span className="ts">{new Date(n.ts).toLocaleString()}</span><span>{n.text}</span><button onClick={() => delNote(n.ts)} aria-label="delete note">✕</button></li>
          ))}
          {notes.length === 0 && <li className="dim">Nothing logged yet.</li>}
        </ul>
      </div>
    </>
  )
}
const cls = (v) => (Number.isFinite(v) ? (v > 0 ? 'pos' : 'neg') : '')
const pctTxt = (v) => (Number.isFinite(v) ? `${v > 0 ? '+' : ''}${v}%` : '—')

const SOURCE_ROWS = [
  { key: 'fred', label: 'FRED (rates, credit, dollar, balance sheet)', endpoint: '/api/fred' },
  { key: 'market', label: 'CoinGecko (BTC spot)', endpoint: '/api/market' },
  { key: 'funding', label: 'BTC perp funding (Deribit → Binance fallback)', endpoint: '/api/funding' },
  { key: 'feargreed', label: 'Fear & Greed (alternative.me)', endpoint: '/api/feargreed' },
  { key: 'aave', label: 'Aave V3 Arbitrum (on-chain read)', endpoint: '/api/aave' },
  { key: 'candles', label: 'Intraday candles (Kraken → Coinbase fallback)', endpoint: '/api/candles' },
  { key: 'btchistory', label: 'BTC daily history 365d (CoinGecko, 6h cache)', endpoint: '/api/btchistory' },
  { key: 'edgar', label: 'SEC EDGAR XBRL (weekly cache)', endpoint: '/api/edgar' },
  { key: 'snapshot', label: 'Snapshot logger (scheduled)', endpoint: 'cron' },
]

function Sources({ S, load }) {
  const st = S.status?.data
  const [busy, setBusy] = useState('')
  const retry = async (key) => {
    setBusy(key)
    if (key === 'edgar') { try { await api('edgar?refresh=1') } catch {} }
    else if (key !== 'snapshot') await load(key)
    await load('status')
    setBusy('')
  }
  return (
    <div className="panel">
      <h2 className="sec">Data sources &amp; status</h2>
      <table className="srcs">
        <thead><tr><th>Source</th><th>State</th><th>Last success</th><th>Latency</th><th>Last error</th><th></th></tr></thead>
        <tbody>
          {SOURCE_ROWS.map((row) => {
            const rec = st?.sources?.[row.key]
            const clientStatus = row.key === 'snapshot'
              ? freshness(rec?.lastSuccessAt, 45 * 60, Date.now(), !!rec, rec ? !rec.ok : false)
              : row.key === 'candles'
                ? freshness(rec?.lastSuccessAt, 300, Date.now(), !!rec, rec ? !rec.ok : false)
                : row.key === 'edgar'
                ? freshness(rec?.lastSuccessAt, SOURCE_MAX_AGE_SEC.edgar, Date.now(), !!rec, rec ? !rec.ok : false)
                : srcStatus(S, row.key)
            return (
              <tr key={row.key}>
                <td>{row.label}<div className="dim">{row.endpoint}</div></td>
                <td><Badge status={clientStatus} /></td>
                <td>{rec?.lastSuccessAt ? `${hhmmss(rec.lastSuccessAt)} (${ago(rec.lastSuccessAt)})` : S[row.key]?.fetchedAt ? hhmmss(S[row.key].fetchedAt) : '—'}</td>
                <td>{rec?.latencyMs != null ? `${rec.latencyMs}ms` : '—'}</td>
                <td className="err">{rec?.lastError ? `${rec.lastError}${rec.lastErrorAt ? ` (${ago(rec.lastErrorAt)})` : ''}` : S[row.key]?.error || '—'}</td>
                <td>{row.key !== 'snapshot' && <button className="btn" onClick={() => retry(row.key)} disabled={busy === row.key}>{busy === row.key ? '…' : 'retry now'}</button>}</td>
              </tr>
            )
          })}
        </tbody>
      </table>
      <div className="caveat">
        Snapshots every 30 min ({st?.snapshotCron || '*/30 * * * *'}) · next ≈ {st?.nextSnapshotAt ? hhmmss(st.nextSnapshotAt) : '—'}. Status map itself fetched {ago(S.status?.fetchedAt)}. A stale number is always labeled where it is displayed — this tab is where you find out why.
      </div>
    </div>
  )
}

function Usage() {
  const [data, setData] = useState(null)
  const [err, setErr] = useState(null)
  const [budgetInput, setBudgetInput] = useState('')
  const refresh = useCallback(async () => {
    try { const d = await api('usage'); setData(d); setBudgetInput(String(d.budgetUsd)) } catch (e) { setErr(e.message) }
  }, [])
  useEffect(() => { refresh() }, [refresh])

  const saveBudget = async () => {
    const v = Number(budgetInput)
    if (!Number.isFinite(v) || v < 0) return
    await api('usage', { method: 'POST', body: JSON.stringify({ budgetUsd: v }) })
    refresh()
  }

  const t = data?.totals
  const pct = t && data.budgetUsd > 0 ? Math.min(100, (t.month / data.budgetUsd) * 100) : 0
  const meterCls = pct >= 100 ? 'over' : pct >= 80 ? 'warn' : ''
  return (
    <div className="panel">
      <h2 className="sec">Token usage &amp; cost · Anthropic API</h2>
      {err && <div className="sub" style={{ color: 'var(--down)' }}>{err}</div>}
      {t && (
        <>
          <div className="usage-cards">
            {[['Today', t.today], ['7 days', t.week], ['30 days', t.month], ['All time', t.allTime]].map(([l, v]) => (
              <div className="panel" key={l} style={{ background: 'var(--panel-2)' }}>
                <div className="label">{l}</div>
                <div className="bigval">${v.toFixed(4)}</div>
              </div>
            ))}
          </div>
          <div className="budget-row">
            <span className="label">Monthly budget $</span>
            <input className="num" value={budgetInput} onChange={(e) => setBudgetInput(e.target.value)} inputMode="decimal" />
            <button className="btn" onClick={saveBudget}>Set</button>
            <div className={`meter ${meterCls}`}><i style={{ width: `${pct}%` }} /></div>
            <span className="sub">{pct.toFixed(0)}% of ${data.budgetUsd}{pct >= 80 && pct < 100 ? ' · approaching cap' : pct >= 100 ? ' · CAP HIT — narrative calls blocked' : ''}</span>
          </div>
          {t.unpriced > 0 && <div className="sub" style={{ color: 'var(--stale)' }}>{t.unpriced} call(s) used a model not in the pricing map (src/lib/cost.js) — cost shown as unpriced, not $0.</div>}
          <table className="ulog section-gap">
            <thead><tr><th>When</th><th>Model</th><th>In</th><th>Out</th><th>Cost</th><th>Valid</th></tr></thead>
            <tbody>
              {data.entries.map((e, i) => (
                <tr key={i}>
                  <td>{new Date(e.ts).toLocaleString()}</td>
                  <td>{e.model}</td>
                  <td>{e.inputTokens.toLocaleString()}</td>
                  <td>{e.outputTokens.toLocaleString()}</td>
                  <td>{e.costUsd != null ? `$${e.costUsd.toFixed(4)}` : 'unpriced'}</td>
                  <td>{e.valid ? '✓' : '✕'}</td>
                </tr>
              ))}
              {data.entries.length === 0 && <tr><td colSpan="6" className="dim">No calls logged yet.</td></tr>}
            </tbody>
          </table>
        </>
      )}
    </div>
  )
}

function TokenGate({ onDone }) {
  const [v, setV] = useState('')
  return (
    <div className="panel gate">
      <h2 className="sec">Dashboard token required</h2>
      <p className="sub">This deployment has DASHBOARD_TOKEN set. Enter it once; it's kept in sessionStorage only.</p>
      <input type="password" value={v} onChange={(e) => setV(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && (sessionStorage.setItem('mcc_token', v), onDone())} autoFocus />
      <button className="btn primary" onClick={() => { sessionStorage.setItem('mcc_token', v); onDone() }}>Unlock</button>
    </div>
  )
}


/* ---------------- Trader: intraday charts, regime, projection, paper ledger ---------------- */
const CHART_COLORS = { up: '#3dd68c', down: '#e5484d', ema9: '#5cc8ff', ema21: '#e5a83b', ema50: '#8a93a6', vwap: '#d8c25c', grid: '#1e2430', text: '#8a93a6' }

function CandleChart({ candles, height = 380 }) {
  const ref = useRef(null)
  const chartRef = useRef(null)
  useEffect(() => {
    if (!ref.current) return
    const chart = createChart(ref.current, {
      width: ref.current.clientWidth || 600, height,
      layout: { background: { color: 'transparent' }, textColor: CHART_COLORS.text, fontFamily: 'ui-monospace, Menlo, monospace', fontSize: 11 },
      grid: { vertLines: { color: CHART_COLORS.grid }, horzLines: { color: CHART_COLORS.grid } },
      timeScale: { timeVisible: true, secondsVisible: false, borderColor: CHART_COLORS.grid },
      rightPriceScale: { borderColor: CHART_COLORS.grid },
    })
    const candleSeries = chart.addCandlestickSeries({ upColor: CHART_COLORS.up, downColor: CHART_COLORS.down, wickUpColor: CHART_COLORS.up, wickDownColor: CHART_COLORS.down, borderVisible: false })
    const vol = chart.addHistogramSeries({ priceScaleId: '', priceFormat: { type: 'volume' } })
    vol.priceScale().applyOptions({ scaleMargins: { top: 0.82, bottom: 0 } })
    const mkLine = (color, lineWidth = 1) => chart.addLineSeries({ color, lineWidth, priceLineVisible: false, lastValueVisible: false, crosshairMarkerVisible: false })
    chartRef.current = { chart, candleSeries, vol, e9: mkLine(CHART_COLORS.ema9), e21: mkLine(CHART_COLORS.ema21), e50: mkLine(CHART_COLORS.ema50), vw: mkLine(CHART_COLORS.vwap, 2) }
    const onResize = () => chart.applyOptions({ width: ref.current?.clientWidth || 600 })
    window.addEventListener('resize', onResize)
    return () => { window.removeEventListener('resize', onResize); chart.remove(); chartRef.current = null }
  }, [height])
  useEffect(() => {
    const r = chartRef.current
    if (!r || !candles?.length) return
    r.candleSeries.setData(candles.map((c) => ({ time: c.t, open: c.o, high: c.h, low: c.l, close: c.c })))
    r.vol.setData(candles.map((c) => ({ time: c.t, value: c.v, color: c.c >= c.o ? 'rgba(61,214,140,0.35)' : 'rgba(229,72,77,0.35)' })))
    const closes = candles.map((c) => c.c)
    const toLine = (arr) => arr.map((v, i) => (v == null ? null : { time: candles[i].t, value: v })).filter(Boolean)
    r.e9.setData(toLine(ema(closes, 9)))
    r.e21.setData(toLine(ema(closes, 21)))
    r.e50.setData(toLine(ema(closes, 50)))
    r.vw.setData(toLine(vwapDaily(candles)))
    if (!r.fitted) { r.chart.timeScale().fitContent(); r.fitted = true } // fit once — never yank the trader's zoom on refresh
  }, [candles])
  return <div ref={ref} className="candlechart" style={{ width: '100%' }} />
}

function ProjectionCone({ series, stats, overlay }) {
  const [horizon, setHorizon] = useState(7)
  const cone = useMemo(() => projectionCone({ lastPrice: stats?.last, realizedVolPct: stats?.realizedVol30Pct, horizonDays: horizon }), [stats, horizon])
  if (!cone) return <div className="sub">Projection needs BTC daily history — check the /api/btchistory row on Data Sources.</div>
  const hist = (series || []).slice(-90)
  const all = [...hist.map(([, p]) => p), ...cone.days.flatMap((d) => [d.up95, d.dn95]), ...(overlay && Number.isFinite(overlay.price) ? [overlay.price] : [])]
  const min = Math.min(...all), max = Math.max(...all)
  const W = 720, H = 240, PAD = 4
  const n = hist.length + cone.days.length - 1
  const X = (i) => PAD + (i / Math.max(1, n)) * (W - 2 * PAD)
  const Y = (p) => H - PAD - ((p - min) / (max - min || 1)) * (H - 2 * PAD)
  const histPts = hist.map(([, p], i) => `${X(i).toFixed(1)},${Y(p).toFixed(1)}`).join(' ')
  const cX = (j) => X(hist.length - 1 + j)
  const band = (upKey, dnKey) => {
    const up = cone.days.map((d, j) => `${cX(j).toFixed(1)},${Y(d[upKey]).toFixed(1)}`)
    const dn = cone.days.map((d, j) => `${cX(j).toFixed(1)},${Y(d[dnKey]).toFixed(1)}`).reverse()
    return [...up, ...dn].join(' ')
  }
  const line = (key) => cone.days.map((d, j) => `${cX(j).toFixed(1)},${Y(d[key]).toFixed(1)}`).join(' ')
  const sm = cone.summary
  return (
    <div>
      <div className="hfline" style={{ marginBottom: 8 }}>
        <div className="modeswitch" role="group" aria-label="Projection horizon">
          <button className={horizon === 7 ? 'on' : ''} onClick={() => setHorizon(7)}>1 week</button>
          <button className={horizon === 30 ? 'on' : ''} onClick={() => setHorizon(30)}>1 month</button>
        </div>
        <div className="sub num">
          bear −1σ {usd(sm.bear1s)} · base {usd(sm.base)} · bull +1σ {usd(sm.bull1s)} · 68% band ±{sm.band68Pct}% · 95% {usd(sm.dn95)}–{usd(sm.up95)}
        </div>
      </div>
      <svg viewBox={`0 0 ${W} ${H}`} className="cone" role="img" aria-label="volatility-implied projection cone">
        <polygon points={band('up95', 'dn95')} fill="rgba(92,200,255,0.07)" />
        <polygon points={band('bull1s', 'bear1s')} fill="rgba(92,200,255,0.16)" />
        <polyline points={histPts} fill="none" stroke="#e8ebf2" strokeWidth="1.5" />
        <polyline points={line('base')} fill="none" stroke="#8a93a6" strokeWidth="1" strokeDasharray="4 4" />
        <polyline points={line('bull1s')} fill="none" stroke="#3dd68c" strokeWidth="1" />
        <polyline points={line('bear1s')} fill="none" stroke="#e5484d" strokeWidth="1" />
        {overlay && Number.isFinite(overlay.price) && (
          <>
            <line x1={PAD} x2={W - PAD} y1={Y(overlay.price)} y2={Y(overlay.price)} stroke="#e5484d" strokeWidth="1.5" strokeDasharray="6 4" />
            <text x={PAD + 4} y={Y(overlay.price) - 5} fill="#e5484d" fontSize="11" fontFamily="ui-monospace, monospace">{overlay.label} {usd(overlay.price)}</text>
          </>
        )}
      </svg>
      <div className="caveat">{cone.caveat} Daily σ used: {cone.sigmaDailyPct}% (from 30d realized vol {fmt(stats?.realizedVol30Pct, 1)}%).</div>
    </div>
  )
}

function HourPockets({ candles }) {
  const rows = useMemo(() => hourlyActivity(candles), [candles])
  if (!rows.length) return null
  const spanDays = candles.length ? ((candles[candles.length - 1].t - candles[0].t) / 86400).toFixed(1) : '0'
  const top = [...rows].sort((a, b) => b.avgRangePct - a.avgRangePct).slice(0, 3).map((r) => r.hourUtc)
  const toLocal = (hUtc) => { const d = new Date(Date.UTC(2026, 0, 1, hUtc)); return d.toLocaleTimeString([], { hour: 'numeric' }) }
  return (
    <div>
      <div className="sub" style={{ marginBottom: 8 }}>Average bar range by hour over the loaded sample (~{spanDays} days), shown in your local time. Volatility clusters by session — the shaded hours are where this sample actually moved. Measurement of the recent past, not a promise.</div>
      <div className="hourbars">
        {rows.map((r) => (
          <div key={r.hourUtc} className={`hourbar ${top.includes(r.hourUtc) ? 'hot' : ''}`} title={`${r.avgRangePct}% avg range · ${r.samples} bars`}>
            <i style={{ height: `${Math.max(6, r.rel * 100)}%` }} />
            <span>{toLocal(r.hourUtc)}</span>
          </div>
        ))}
      </div>
    </div>
  )
}

function PaperPanel({ lastPrice }) {
  const [book, setBook] = useState(null)
  const [err, setErr] = useState(null)
  const [side, setSide] = useState('long')
  const [size, setSize] = useState('1000')
  const [note, setNote] = useState('')
  const [busy, setBusy] = useState(false)
  const refresh = useCallback(async () => {
    try { setBook(await api('paper')) } catch (e) { setErr(e.message) }
  }, [])
  useEffect(() => { refresh() }, [refresh])

  const openTrade = async () => {
    setBusy(true); setErr(null)
    try { await api('paper', { method: 'POST', body: JSON.stringify({ action: 'open', side, sizeUsd: Number(size), note }) }); setNote(''); await refresh() }
    catch (e) { setErr(e.message) } finally { setBusy(false) }
  }
  const closeTrade = async (id) => {
    setBusy(true); setErr(null)
    try { await api('paper', { method: 'POST', body: JSON.stringify({ action: 'close', id }) }); await refresh() }
    catch (e) { setErr(e.message) } finally { setBusy(false) }
  }
  const livePnl = (t) => {
    if (!Number.isFinite(lastPrice)) return null
    const dir = t.side === 'long' ? 1 : -1
    return ((lastPrice - t.entry) / t.entry) * dir * t.sizeUsd
  }
  const st = book?.stats
  return (
    <div>
      <div className="sub" style={{ marginBottom: 10 }}>Entries and exits are stamped server-side from the live market price, and every round trip is charged {book?.feePctPerSide ?? 0.1}% per side in simulated fees — so this ledger tells you the truth about your intraday results before any real dollar does. This record is the gate in front of automation.</div>
      <div className="note-row" style={{ flexWrap: 'wrap' }}>
        <div className="modeswitch" role="group" aria-label="Side">
          <button className={side === 'long' ? 'on' : ''} onClick={() => setSide('long')}>Long</button>
          <button className={side === 'short' ? 'on' : ''} onClick={() => setSide('short')}>Short</button>
        </div>
        <input className="num" style={{ flex: '0 0 110px' }} value={size} onChange={(e) => setSize(e.target.value)} inputMode="decimal" aria-label="size in USD" />
        <input value={note} onChange={(e) => setNote(e.target.value)} placeholder="setup / reason (this is the part that teaches you)" />
        <button className="btn primary" onClick={openTrade} disabled={busy}>Open paper {side}</button>
      </div>
      {err && <div className="sub" style={{ color: 'var(--down)', marginTop: 6 }}>{err}</div>}

      {book?.open?.length > 0 && (
        <table className="stress section-gap">
          <thead><tr><th>Opened</th><th>Side</th><th>Size</th><th>Entry</th><th>Live P&L</th><th>Note</th><th></th></tr></thead>
          <tbody>
            {book.open.map((t) => {
              const p = livePnl(t)
              return (
                <tr key={t.id}>
                  <td>{new Date(t.ts).toLocaleTimeString([], { hour12: false })}</td>
                  <td>{t.side}</td>
                  <td>{usd(t.sizeUsd)}</td>
                  <td>{usd(t.entry)}</td>
                  <td className={p == null ? '' : p >= 0 ? 'hf-safe' : 'hf-danger'}>{p == null ? '—' : `${p >= 0 ? '+' : ''}$${p.toFixed(2)} gross`}</td>
                  <td className="dim">{t.note}</td>
                  <td><button className="btn" onClick={() => closeTrade(t.id)} disabled={busy}>close</button></td>
                </tr>
              )
            })}
          </tbody>
        </table>
      )}

      {st && st.trades > 0 ? (
        <>
          <div className="usage-cards section-gap">
            {[['Closed trades', st.trades, ''], ['Win rate', st.winRatePct, '%'], ['Expectancy / trade', st.expectancyUsd, '$'], ['Total P&L (net)', st.totalPnlUsd, '$'], ['Fees paid', st.totalFeesUsd, '$'], ['Max drawdown', st.maxDrawdownUsd, '$']].map(([l, v, u]) => (
              <div className="panel" key={l} style={{ background: 'var(--panel-2)' }}>
                <div className="label">{l}</div>
                <div className="bigval" style={{ fontSize: 20 }}>{u === '$' ? `$${Number(v).toFixed(2)}` : `${v}${u}`}</div>
              </div>
            ))}
          </div>
          <table className="ulog section-gap">
            <thead><tr><th>Closed</th><th>Side</th><th>Size</th><th>Entry</th><th>Exit</th><th>Fees</th><th>P&L net</th></tr></thead>
            <tbody>
              {book.closed.slice().reverse().slice(0, 30).map((t) => (
                <tr key={t.id}>
                  <td>{new Date(t.exitTs).toLocaleString()}</td>
                  <td>{t.side}</td>
                  <td>{usd(t.sizeUsd)}</td>
                  <td>{usd(t.entry)}</td>
                  <td>{usd(t.exit)}</td>
                  <td>${t.feesUsd.toFixed(2)}</td>
                  <td className={t.pnlUsd >= 0 ? 'hf-safe' : 'hf-danger'}>{t.pnlUsd >= 0 ? '+' : ''}${t.pnlUsd.toFixed(2)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </>
      ) : (
        <div className="dim section-gap">No closed paper trades yet. The stats panel appears after your first round trip — and stays honest about fees.</div>
      )}
    </div>
  )
}

function TradeDesk({ S }) {
  const [tf, setTf] = useState('5m')
  const [cd, setCd] = useState(null)
  const [cErr, setCErr] = useState(null)
  const loadCandles = useCallback(async (which) => {
    try { const d = await api(`candles?tf=${which}`); setCd(d); setCErr(null) } catch (e) { setCErr(e.message) }
  }, [])
  useEffect(() => {
    setCd(null)
    loadCandles(tf)
    const t = setInterval(() => loadCandles(tf), 30_000)
    return () => clearInterval(t)
  }, [tf, loadCandles])

  const candles = cd?.candles || []
  const regime = useMemo(() => regimeRead(candles), [candles])
  const closes = candles.map((c) => c.c)
  const lastClose = closes[closes.length - 1]
  const rsiLast = useMemo(() => { const r = rsi(closes, 14); return r[r.length - 1] }, [candles])
  const atrLast = useMemo(() => { const a = atr(candles, 14); return a[a.length - 1] }, [candles])
  const status = cd ? freshness(cd.meta?.fetchedAt, 120, Date.now(), true, !!cErr) : cErr ? 'down' : 'sync'
  const btcStats = S.btchistory?.data?.stats

  return (
    <>
      <div className="panel">
        <div className="hfline" style={{ marginBottom: 10 }}>
          <div className="modeswitch" role="group" aria-label="Timeframe">
            {['1m', '3m', '5m', '15m'].map((t) => (
              <button key={t} className={tf === t ? 'on' : ''} onClick={() => setTf(t)}>{t}</button>
            ))}
          </div>
          <div className="sub num">BTC {usd(lastClose)} · RSI14 {fmt(rsiLast, 0)} · ATR14 {usd(atrLast)} ({Number.isFinite(atrLast) && Number.isFinite(lastClose) ? ((atrLast / lastClose) * 100).toFixed(2) : '—'}%)</div>
          <div style={{ marginLeft: 'auto' }}><Badge status={status} at={cd?.meta?.fetchedAt} /></div>
        </div>
        <div className={`regimebanner ${regime.tone}`}>
          <span className="regstate">{regime.state}</span>
          <span className="regplain">{regime.plain}</span>
        </div>
        {cErr && <div className="sub" style={{ color: 'var(--down)', margin: '8px 0' }}>{cErr}</div>}
        {candles.length > 0 ? <CandleChart candles={candles} /> : !cErr && <div className="sub">loading candles…</div>}
        <div className="chartlegend">
          <span style={{ color: CHART_COLORS.ema9 }}>— EMA9</span>
          <span style={{ color: CHART_COLORS.ema21 }}>— EMA21</span>
          <span style={{ color: CHART_COLORS.ema50 }}>— EMA50</span>
          <span style={{ color: CHART_COLORS.vwap }}>— session VWAP (UTC-anchored)</span>
          <span className="dim">· {cd?.venue || ''} · refreshes every 30s</span>
        </div>
      </div>

      <SetupsGrid S={S} />

      <div className="grid two section-gap">
        <div className="panel">
          <h2 className="sec">Volatility pockets · when this market actually moves</h2>
          {candles.length ? <HourPockets candles={candles} /> : <div className="sub">waiting for candles…</div>}
        </div>
        <div className="panel">
          <h2 className="sec">Projection · volatility-implied range, not a forecast</h2>
          <ProjectionCone series={S.btchistory?.data?.series} stats={btcStats} />
        </div>
      </div>

      <TriggerHistory S={S} />

      <div className="panel section-gap">
        <h2 className="sec">Paper trading ledger · prove it here first</h2>
        <PaperPanel lastPrice={lastClose} />
      </div>

      <div className="panel section-gap automation">
        <h2 className="sec">Automation · locked by design</h2>
        <div className="sub" style={{ lineHeight: 1.6 }}>
          Rule-based execution gets built only after this ledger earns it: <b>50+ closed paper trades</b>, <b>positive expectancy net of fees</b> across the sample, and a written max-daily-loss rule. Even then, the design is deterministic rules with hard size caps and a human confirmation per order — a discretionary AI holding wallet keys is not on this roadmap, because that is the account-killer architecture, not the edge. The lock isn't a limitation of the tool; it is the tool.
        </div>
      </div>
    </>
  )
}

const TABS = ['Overview', 'Trade Desk', 'Position', 'Thesis', 'Data Sources', 'Token Usage']

export default function App() {
  const { state, load, needToken, setNeedToken, loadAll } = useSources()
  const [tab, setTab] = useState(0)
  const [clock, setClock] = useState(new Date())
  const [simple, setSimple] = useState(() => localStorage.getItem('mcc_mode') !== 'advanced')
  useEffect(() => { const t = setInterval(() => setClock(new Date()), 1000); return () => clearInterval(t) }, [])
  useEffect(() => { localStorage.setItem('mcc_mode', simple ? 'simple' : 'advanced') }, [simple])

  if (needToken) return <div className="shell"><TokenGate onDone={() => { setNeedToken(false); loadAll() }} /></div>

  return (
    <div className={`shell ${simple ? 'simple-mode' : 'advanced-mode'}`}>
      <header className="top">
        <div className="brand">Macro <b>Command Center</b></div>
        <div className="sub">every number live or labeled — nothing interpolated</div>
        <div className="modeswitch" role="group" aria-label="Detail level">
          <button className={simple ? 'on' : ''} onClick={() => setSimple(true)}>Simple</button>
          <button className={!simple ? 'on' : ''} onClick={() => setSimple(false)}>Advanced</button>
        </div>
        <div className="clock num">{clock.toLocaleString([], { hour12: false })}</div>
      </header>
      <nav className="tabs" role="tablist">
        {TABS.map((t, i) => (
          <button key={t} className={i === tab ? 'on' : ''} role="tab" aria-selected={i === tab} onClick={() => setTab(i)}>{t}</button>
        ))}
      </nav>
      {tab === 0 && <Overview S={state} load={load} />}
      {tab === 1 && <TradeDesk S={state} />}
      {tab === 2 && <Position S={state} load={load} />}
      {tab === 3 && <Thesis S={state} load={load} />}
      {tab === 4 && <Sources S={state} load={load} />}
      {tab === 5 && <Usage />}
    </div>
  )
}
