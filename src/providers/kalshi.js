// Kalshi provider — public Trade API v2 (no key needed for market data).
// Docs: https://docs.kalshi.com/  Base: https://api.elections.kalshi.com/trade-api/v2
//   GET /events?status=open&with_nested_markets=true&limit=200&cursor=…
//   GET /markets/{ticker}/orderbook        (bids only: YES ask = 1 − best NO bid)
//   GET /series/{series_ticker}            (fee_type, fee_multiplier)
import { isUsableMarket, hashString } from './schema.js';
import { getJSON, compactRules } from './polymarket.js';

export const KALSHI_API = 'https://api.elections.kalshi.com/trade-api/v2';
const SITE = 'https://kalshi.com/markets';

const num = (v) => {
  if (v == null || v === '') return null;
  const n = typeof v === 'number' ? v : parseFloat(v);
  return Number.isFinite(n) ? n : null;
};

const CATEGORY = { Elections: 'Politics', Politics: 'Politics', Sports: 'Sports', Economics: 'Economy', Financials: 'Finance',
  Crypto: 'Crypto', 'Climate and Weather': 'Weather', 'Science and Technology': 'Tech', Entertainment: 'Culture',
  Companies: 'Business', Commodities: 'Finance', World: 'World', Mentions: 'Culture', Social: 'Culture', AI: 'AI', Health: 'Science' };

/**
 * Kalshi's strike_type metadata is not always what the contract says (e.g. "exactly 5" tagged as 'less' with
 * floor = cap = 5). Only trust it when the contract wording agrees.
 */
export function strikeConsistent(m) {
  const t = `${m.question} ${m.label} ${(m.rules || '').slice(0, 300)}`.toLowerCase();
  if (/\bexactly\b/.test(t)) return false;
  switch (m.strikeType) {
    case 'greater': case 'greater_or_equal':
      return m.floor != null && m.cap == null && /(above|more than|greater than|at least|or above|or more|or higher|over\b|\+|>)/.test(t);
    case 'less': case 'less_or_equal':
      return m.cap != null && m.floor == null && /(below|less than|fewer than|at most|or below|or less|or fewer|or lower|under\b|<)/.test(t);
    case 'between':
      return m.floor != null && m.cap != null && m.cap >= m.floor && /(between|to|-|–)/.test(t);
    default: return false;
  }
}

/** Kalshi numeric buckets form a verified partition only if they tile the line with no gaps. */
export function partitionCheck(markets) {
  const ms = markets.filter((m) => m.strikeType && strikeConsistent(m));
  if (ms.length !== markets.length || ms.length < 2) return null;
  const lows = ms.filter((m) => m.strikeType === 'less' || m.strikeType === 'less_or_equal');
  const highs = ms.filter((m) => m.strikeType === 'greater' || m.strikeType === 'greater_or_equal');
  const mids = ms.filter((m) => m.strikeType === 'between').sort((a, b) => a.floor - b.floor);
  if (lows.length !== 1 || highs.length !== 1 || mids.length !== ms.length - 2) return null;
  const seq = [lows[0].cap, ...mids.flatMap((m) => [m.floor, m.cap]), highs[0].floor];
  if (seq.some((x) => x == null)) return null;
  let maxGap = 0;
  // less(cap) | between[f1,c1] | between[f2,c2] … | greater(floor)
  const gaps = [mids.length ? mids[0].floor - lows[0].cap : highs[0].floor - lows[0].cap];
  for (let i = 1; i < mids.length; i++) gaps.push(mids[i].floor - mids[i - 1].cap);
  if (mids.length) gaps.push(highs[0].floor - mids[mids.length - 1].cap);
  for (const g of gaps) { if (g < -1e-9) return null; maxGap = Math.max(maxGap, g); }
  const allInt = seq.every((x) => Math.abs(x - Math.round(x)) < 1e-9);
  if (maxGap < 1e-9) return 'verified';
  if (allInt && maxGap <= 1 + 1e-9) return 'integer-steps'; // exhaustive only if the metric is integer-valued
  return null;
}

export function normalizeKalshiEvent(e) {
  const series = e.series_ticker || '';
  const category = CATEGORY[e.category] || e.category || 'Other';
  const markets = [];
  for (const m of e.markets || []) {
    if (m.status !== 'active' || m.market_type !== 'binary') continue;
    const nm = normalizeKalshiMarket(m, e, category);
    if (nm) markets.push(nm);
  }
  const exclusive = !!e.mutually_exclusive;
  let exhaustive = false, exhaustiveBasis = null;
  if (exclusive && markets.length === (e.markets || []).filter((m) => m.status === 'active').length) {
    const p = partitionCheck(markets);
    if (p === 'verified') { exhaustive = true; exhaustiveBasis = 'numeric buckets tile the whole range'; }
    else if (p === 'integer-steps') exhaustiveBasis = 'integer buckets (assumes an integer-valued result)';
  }
  const event = {
    id: e.event_ticker, provider: 'kalshi', title: e.title || '', subTitle: e.sub_title || '', series,
    url: `${SITE}/${series.toLowerCase()}`, category, tags: [e.category].filter(Boolean),
    exclusive, exhaustive, exhaustiveVerified: exhaustive, exhaustiveBasis, augmented: false, resolvedYes: 0, isGame: /GAME$|MATCH$/.test(series),
    sources: (e.settlement_sources || []).map((s) => s.name).filter(Boolean),
    liquidity: markets.reduce((s, m) => s + m.liquidity, 0), volume: markets.reduce((s, m) => s + m.volume, 0),
    volume24h: markets.reduce((s, m) => s + m.volume24h, 0),
    endDate: markets[0]?.endDate || null, marketIds: markets.map((m) => m.id),
  };
  return { event, markets };
}

export function normalizeKalshiMarket(m, e, category) {
  try {
    let bid = num(m.yes_bid_dollars), ask = num(m.yes_ask_dollars);
    if (!(bid > 0)) bid = null;
    if (!(ask > 0 && ask < 1)) ask = null;
    let noAsk = num(m.no_ask_dollars);
    if (!(noAsk > 0 && noAsk < 1)) noAsk = null;
    const last = num(m.last_price_dollars);
    const price = bid != null && ask != null ? (bid + ask) / 2 : last;
    const bidSize = num(m.yes_bid_size_fp) || 0, askSize = num(m.yes_ask_size_fp) || 0;
    const rules = compactRules([m.rules_primary, (m.rules_secondary || '').replace(/Kalshi is not affiliated[\s\S]*$/, '')].filter((x) => x && x.trim()).join('\n\n'));
    const series = e.series_ticker || '';
    const nm = {
      id: m.ticker, provider: 'kalshi', eventId: m.event_ticker, ticker: m.ticker, series,
      question: (m.title || '').trim(), label: (m.yes_sub_title || '').trim(),
      yesOutcome: 'Yes', noOutcome: 'No', isYesNo: true,
      price, bid, ask, noAsk, lastTrade: last, bidSize, askSize, noAskSize: bidSize,
      spread: bid != null && ask != null ? ask - bid : null,
      liquidity: (bidSize * (bid || 0)) + (askSize * (ask ? 1 - ask : 0)),
      volume: num(m.volume_fp) || 0, volume24h: num(m.volume_24h_fp) || 0,
      openInterest: num(m.open_interest_fp) || 0,
      endDate: m.close_time || null, expectedExpiration: m.expected_expiration_time || null,
      occurrence: m.occurrence_datetime || null,
      acceptingOrders: true, sportsType: null, isGame: /GAME$|MATCH$/.test(series),
      category, tokenId: m.ticker, noTokenId: m.ticker,
      url: `${SITE}/${series.toLowerCase()}`, eventTitle: e.title || '',
      rules, descriptionHash: hashString(rules.replace(/\s+/g, ' ').trim().toLowerCase()),
      strikeType: m.strike_type || null, floor: num(m.floor_strike), cap: num(m.cap_strike),
      earlyClose: m.early_close_condition || '', sources: (e.settlement_sources || []).map((s) => s.name),
    };
    if (nm.price == null) return null;
    return isUsableMarket(nm) ? nm : null;
  } catch {
    return null;
  }
}

const seriesFeeCache = new Map();

export const kalshiProvider = {
  id: 'kalshi',
  name: 'Kalshi',
  capabilities: { status: 'live', label: 'LIVE · order book', orderBook: true, depth: true, fees: 'exact', realMoney: true, arb: true,
    notes: 'Official public Trade API v2: events, rules, order books, series fee multipliers. CFTC-regulated (US).' },

  async fetchSnapshot({ maxEvents = 20000, fetch: fetchImpl = globalThis.fetch, onProgress } = {}) {
    const events = [], markets = [], warnings = [];
    let cursor = '', page = 0, raw = 0, partial = false;
    while (raw < maxEvents) {
      const u = `${KALSHI_API}/events?status=open&with_nested_markets=true&limit=200${cursor ? '&cursor=' + encodeURIComponent(cursor) : ''}`;
      let d;
      try { d = await getJSON(fetchImpl, u, { timeoutMs: 30000 }); }
      catch (err) {
        if (page === 0) throw new Error(`Kalshi API unreachable: ${err.message}`);
        warnings.push(`Kalshi: stopped after ${raw} events: ${err.message}`); partial = true; break;
      }
      for (const e of d.events || []) {
        raw++;
        if (/^KXMVE/.test(e.event_ticker || '')) continue; // multi-leg combos
        try {
          const { event, markets: ms } = normalizeKalshiEvent(e);
          if (ms.length) { events.push(event); markets.push(...ms); }
        } catch { /* malformed */ }
      }
      page++;
      onProgress && onProgress({ page, events: raw, markets: markets.length, target: maxEvents });
      cursor = d.cursor;
      if (!cursor || !(d.events || []).length) break;
    }
    return { provider: 'kalshi', fetchedAt: new Date().toISOString(), partial, warnings, events, markets };
  },

  /** Order book → ask ladders for both sides. Kalshi books hold bids only; asks are the other side's bids. */
  async fetchBooks(tickers, { fetch: fetchImpl = globalThis.fetch, concurrency = 5 } = {}) {
    const out = {};
    const q = [...new Set(tickers)];
    await Promise.all(Array.from({ length: concurrency }, async () => {
      while (q.length) {
        const t = q.shift();
        try {
          const d = await getJSON(fetchImpl, `${KALSHI_API}/markets/${encodeURIComponent(t)}/orderbook?depth=20`, { retries: 2, timeoutMs: 8000 });
          const ob = d.orderbook_fp || {};
          const yesBids = (ob.yes_dollars || []).map(([p, s]) => ({ p: +p, s: +s })).sort((a, b) => b.p - a.p);
          const noBids = (ob.no_dollars || []).map(([p, s]) => ({ p: +p, s: +s })).sort((a, b) => b.p - a.p);
          const r4 = (x) => Math.round(x * 1e4) / 1e4;
          out[t] = {
            yes: { bids: yesBids, asks: noBids.map((x) => ({ p: r4(1 - x.p), s: x.s })) },
            no: { bids: noBids, asks: yesBids.map((x) => ({ p: r4(1 - x.p), s: x.s })) },
            timestamp: new Date().toISOString(),
          };
        } catch { /* leave missing */ }
      }
    }));
    return out;
  },

  /** Taker fee multiplier for a series (cached). Default 1 = standard 0.07 × C × P × (1−P). */
  async feeMultiplier(series, { fetch: fetchImpl = globalThis.fetch } = {}) {
    if (seriesFeeCache.has(series)) return seriesFeeCache.get(series);
    let m = 1;
    try {
      const d = await getJSON(fetchImpl, `${KALSHI_API}/series/${encodeURIComponent(series)}`, { retries: 1, timeoutMs: 8000 });
      const fm = num(d.series?.fee_multiplier);
      if (fm != null) m = fm;
      if (d.series?.fee_type === 'fee_free') m = 0;
    } catch { /* keep conservative default */ }
    seriesFeeCache.set(series, m);
    return m;
  },

  async fetchMarketDetails(ticker, { fetch: fetchImpl = globalThis.fetch } = {}) {
    const d = await getJSON(fetchImpl, `${KALSHI_API}/markets/${encodeURIComponent(ticker)}`, { retries: 1, timeoutMs: 8000 });
    const m = d.market || {};
    return { id: m.ticker, question: m.title, description: [m.rules_primary, m.rules_secondary].filter(Boolean).join('\n\n'), endDate: m.close_time };
  },

  async fetchBook(ticker, opts) {
    const b = (await this.fetchBooks([ticker], opts))[ticker];
    if (!b) throw new Error('no book');
    const x = b[opts?.side === 'no' ? 'no' : 'yes'];
    return { bid: x.bids[0]?.p ?? null, bidSize: x.bids[0]?.s ?? 0, ask: x.asks[0]?.p ?? null, askSize: x.asks[0]?.s ?? 0, timestamp: b.timestamp };
  },
};
