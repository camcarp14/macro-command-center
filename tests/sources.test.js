import { describe, it, expect } from 'vitest'
import {
  parseYahooChart, parseStooqDaily, parseBinanceKlines, parseBinance24hr,
  parseCoinbaseCandles, parseCoinbaseSpot, parseCoingeckoOhlc, parseCoingeckoSimple,
  quoteFromChart,
} from '../netlify/shared/sources.mjs'
import {
  YAHOO_CHART_SAMPLE, YAHOO_CHART_WITH_NULLS, STOOQ_CSV_SAMPLE,
  BINANCE_KLINES_SAMPLE, BINANCE_24HR_SAMPLE, COINBASE_CANDLES_SAMPLE,
  COINBASE_SPOT_SAMPLE, COINGECKO_OHLC_SAMPLE, COINGECKO_SIMPLE_SAMPLE,
} from './fixtures.js'

describe('parseYahooChart', () => {
  it('extracts candles + quote meta', () => {
    const p = parseYahooChart(YAHOO_CHART_SAMPLE)
    expect(p.candles.length).toBe(3)
    expect(p.candles[2]).toEqual({ t: 1752757800, o: 406.6, h: 419.8, l: 401.55, c: 412.35, v: 12131415 })
    expect(p.price).toBe(412.35)
    expect(p.prevClose).toBe(405.1)
    expect(p.marketState).toBe('open') // regularMarketTime inside regular window
  })
  it('drops null candle rows instead of fabricating zeros', () => {
    const p = parseYahooChart(YAHOO_CHART_WITH_NULLS)
    expect(p.candles.length).toBe(3) // the appended null row vanished
  })
  it('throws on malformed payloads (chain moves to fallback)', () => {
    expect(() => parseYahooChart({})).toThrow()
    expect(() => parseYahooChart({ chart: { result: [{}] } })).toThrow()
  })
})

describe('quoteFromChart', () => {
  it('prevClose comes from the second-to-last daily candle, NOT chartPreviousClose', () => {
    // fixture deliberately has chartPreviousClose 405.1 ≠ prior candle close 406.6
    const q = quoteFromChart(parseYahooChart(YAHOO_CHART_SAMPLE))
    expect(q.price).toBe(412.35)
    expect(q.prevClose).toBe(406.6)
    expect(q.changePct).toBeCloseTo(((412.35 / 406.6) - 1) * 100, 1)
    expect(q.kind).toBe('delayed')
    expect(q.marketState).toBe('open')
  })
  it('throws when the chart carries no market price (chain falls through)', () => {
    const parsed = parseYahooChart(YAHOO_CHART_SAMPLE)
    expect(() => quoteFromChart({ ...parsed, price: null })).toThrow()
  })
})

describe('parseStooqDaily', () => {
  it('parses EOD rows to candles', () => {
    const p = parseStooqDaily(STOOQ_CSV_SAMPLE)
    expect(p.candles.length).toBe(3)
    expect(p.candles[2].c).toBe(412.35)
    expect(new Date(p.candles[0].t * 1000).toISOString()).toContain('2026-07-16')
  })
  it('throws on junk', () => {
    expect(() => parseStooqDaily('<html>No data</html>')).toThrow()
    expect(() => parseStooqDaily('Date,Open\n')).toThrow()
  })
})

describe('crypto parsers', () => {
  it('binance klines: ms→s, strings→numbers', () => {
    const c = parseBinanceKlines(BINANCE_KLINES_SAMPLE)
    expect(c[0]).toEqual({ t: 1752537600, o: 117000, h: 119200, l: 116500, c: 118100, v: 12345.678 })
  })
  it('binance 24hr ticker', () => {
    expect(parseBinance24hr(BINANCE_24HR_SAMPLE)).toEqual({ price: 118423.5, changePct24h: 2.145 })
  })
  it('coinbase candles: reorders newest-first → oldest-first, remaps columns', () => {
    const c = parseCoinbaseCandles(COINBASE_CANDLES_SAMPLE)
    expect(c[0].t).toBeLessThan(c[1].t)
    expect(c[0]).toEqual({ t: 1752537600, o: 117000, h: 119200, l: 116500, c: 118100, v: 5432.1 })
  })
  it('coinbase spot has no 24h change — null, not zero', () => {
    expect(parseCoinbaseSpot(COINBASE_SPOT_SAMPLE)).toEqual({ price: 118423.45, changePct24h: null })
  })
  it('coingecko ohlc is volumeless — v null, not fabricated', () => {
    const c = parseCoingeckoOhlc(COINGECKO_OHLC_SAMPLE)
    expect(c[0].v).toBeNull()
    expect(c[1].c).toBe(118900)
  })
  it('coingecko simple price', () => {
    expect(parseCoingeckoSimple(COINGECKO_SIMPLE_SAMPLE)).toEqual({ price: 118423, changePct24h: 2.11 })
  })
  it('all throw on malformed input', () => {
    expect(() => parseBinanceKlines({})).toThrow()
    expect(() => parseBinance24hr({})).toThrow()
    expect(() => parseCoinbaseCandles('x')).toThrow()
    expect(() => parseCoinbaseSpot({})).toThrow()
    expect(() => parseCoingeckoOhlc(null)).toThrow()
    expect(() => parseCoingeckoSimple({})).toThrow()
  })
})
