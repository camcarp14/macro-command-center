// Paper-trade engine. Entries and exits are stamped SERVER-SIDE from the live
// market price, so the record can't flatter itself. This ledger is the gate
// in front of any future automation: no track record, no automation.
//   GET             → { open, closed, stats }
//   POST {action:'open', side:'long'|'short', sizeUsd, note?}
//   POST {action:'close', id}
import { checkAuth, unauthorized, json, store } from '../shared/util.mjs'
import { fetchSpotLast } from '../shared/sources.mjs'

const FEE_PCT = 0.1 // per side, taker-style — honesty about costs is the point

export default async (req) => {
  if (!checkAuth(req)) return unauthorized()
  const s = store()
  const book = (await s.get('paper_trades', { type: 'json' })) || { open: [], closed: [] }

  if (req.method === 'GET') return json({ ...book, closed: book.closed.slice(-200), stats: stats(book.closed), feePctPerSide: FEE_PCT, meta: { fetchedAt: Date.now() } })
  if (req.method !== 'POST') return json({ error: 'GET or POST' }, 405)

  const body = await req.json().catch(() => ({}))

  if (body.action === 'open') {
    const side = body.side === 'short' ? 'short' : body.side === 'long' ? 'long' : null
    const sizeUsd = Number(body.sizeUsd)
    if (!side) return json({ error: 'side must be "long" or "short"' }, 400)
    if (!Number.isFinite(sizeUsd) || sizeUsd <= 0 || sizeUsd > 10_000_000) return json({ error: 'sizeUsd must be a positive number' }, 400)
    const { price, venue } = await fetchSpotLast()
    const trade = { id: `${Date.now()}-${Math.random().toString(36).slice(2, 7)}`, ts: Date.now(), side, sizeUsd, entry: price, venue, note: String(body.note || '').slice(0, 300) }
    book.open.push(trade)
    await s.setJSON('paper_trades', book)
    return json({ ok: true, trade, ...bookOut(book) })
  }

  if (body.action === 'close') {
    const i = book.open.findIndex((t) => t.id === body.id)
    if (i === -1) return json({ error: 'no open paper trade with that id' }, 404)
    const t = book.open.splice(i, 1)[0]
    const { price } = await fetchSpotLast()
    const dir = t.side === 'long' ? 1 : -1
    const gross = ((price - t.entry) / t.entry) * dir * t.sizeUsd
    const fees = (t.sizeUsd * FEE_PCT * 2) / 100
    const closed = { ...t, exit: price, exitTs: Date.now(), grossUsd: r2(gross), feesUsd: r2(fees), pnlUsd: r2(gross - fees) }
    book.closed.push(closed)
    await s.setJSON('paper_trades', book)
    return json({ ok: true, trade: closed, ...bookOut(book), stats: stats(book.closed) })
  }

  return json({ error: 'action must be "open" or "close"' }, 400)
}

const bookOut = (b) => ({ open: b.open, closed: b.closed.slice(-200) })
const r2 = (v) => Math.round(v * 100) / 100

function stats(closed) {
  if (!closed.length) return { trades: 0 }
  const pnls = closed.map((t) => t.pnlUsd)
  const wins = pnls.filter((p) => p > 0)
  const losses = pnls.filter((p) => p <= 0)
  const total = pnls.reduce((a, b) => a + b, 0)
  let peak = 0, run = 0, maxDd = 0
  for (const p of pnls) { run += p; peak = Math.max(peak, run); maxDd = Math.min(maxDd, run - peak) }
  return {
    trades: closed.length,
    winRatePct: r2((wins.length / closed.length) * 100),
    avgWinUsd: wins.length ? r2(wins.reduce((a, b) => a + b, 0) / wins.length) : 0,
    avgLossUsd: losses.length ? r2(losses.reduce((a, b) => a + b, 0) / losses.length) : 0,
    expectancyUsd: r2(total / closed.length),
    totalPnlUsd: r2(total),
    totalFeesUsd: r2(closed.reduce((a, t) => a + t.feesUsd, 0)),
    maxDrawdownUsd: r2(maxDd),
  }
}
