// Polymarket US — the CFTC-regulated US exchange (separate from Polymarket International; different
// markets, different order books, different fee schedule). Never reuse international quotes as US data.
// Docs: https://docs.polymarket.us/api-reference/introduction
//   Public gateway (no key): https://gateway.polymarket.us   — 20 req/s per IP
//   GET /v1/markets?limit&offset&active&closed      market list incl. bestBidQuote / bestAskQuote, feeCoefficient
//   GET /v1/markets/{slug}/book                      full book: bids/offers for the LONG side
//   Fees (docs.polymarket.us/fees): taker = Θ × C × p × (1 − p), Θ = 0.0695, rounded to the cent (banker's)
// One instrument per market: buying the SHORT side ("NO" / the other team) costs 1 − best long bid.
import { isUsableMarket, hashString } from './schema.js';
import { getJSON, compactRules } from './polymarket.js';

export const PMUS_GATEWAY = 'https://gateway.polymarket.us';
const SITE = 'https://polymarket.us/market';
const num = (v) => { const n = typeof v === 'number' ? v : parseFloat(v?.value ?? v); return Number.isFinite(n) ? n : null; };
const CATEGORY = { sports: 'Sports', politics: 'Politics', culture: 'Culture', finance: 'Finance', technology: 'Tech', macro: 'Economy', geopolitics: 'World', crypto: 'Crypto', science: 'Science' };

export function normalizePMUSMarket(m) {
  try {
    const sides = m.marketSides || [];
    const long = sides.find((s) => s.long) || sides[0], short = sides.find((s) => !s.long) || sides[1];
    if (!long || !short) return null;
    const bid = num(m.bestBidQuote), ask = num(m.bestAskQuote);
    const prices = (() => { try { return JSON.parse(m.outcomePrices || '[]').map(Number); } catch { return []; } })();
    const mid = bid != null && ask != null ? (bid + ask) / 2 : num(long.price) ?? prices[0];
    const yes = String(long.description || 'Yes'), no = String(short.description || 'No');
    const isYesNo = /^yes$/i.test(yes) && /^no$/i.test(no);
    const league = long.team?.league || short.team?.league || null;
    const nm = {
      id: `pmus:${m.slug}`, provider: 'polymarket-us', eventId: `pmus-ev:${m.slug}`, slug: m.slug,
      question: (m.question || '').trim(), label: isYesNo ? (m.title || long.team?.name || '').trim() : yes,
      yesOutcome: yes, noOutcome: no, isYesNo, price: mid,
      bid, ask, noAsk: bid != null ? Math.round((1 - bid) * 1e6) / 1e6 : null, noBid: ask != null ? Math.round((1 - ask) * 1e6) / 1e6 : null,
      spread: bid != null && ask != null ? ask - bid : null,
      liquidity: 0, volume: num(m.volume) || 0, volume24h: num(m.volume24hr) || 0,
      endDate: m.endDate || null, gameStartTime: m.gameStartTime || null,
      sportsType: m.sportsMarketType || null, marketType: m.marketType || null, isGame: !!(m.sportsMarketType && m.sportsMarketType !== 'futures'),
      league, teams: sides.map((s) => s.team && { name: s.team.name, code: s.team.abbreviation, ordering: s.team.ordering, long: !!s.long }).filter(Boolean),
      line: num(m.line),
      category: CATEGORY[m.category] || 'Other',
      feeCoefficient: num(m.feeCoefficient) ?? 0.0695, minTradeQty: num(m.minimumTradeQty) ?? 1, tickSize: num(m.orderPriceMinTickSize),
      rules: compactRules(m.description || ''), descriptionHash: hashString((m.description || '').replace(/\s+/g, ' ').trim().toLowerCase()),
      tokenId: m.slug, url: `${SITE}/${m.slug}`, eventTitle: m.question || '', quoteTime: m.updatedAt || null,
    };
    return isUsableMarket(nm) ? nm : null;
  } catch { return null; }
}

/** Order book → asks for the side bought. YES asks = offers; NO asks = 1 − bids. */
export function parsePMUSBook(j) {
  const d = j?.marketData || {};
  const lvl = (x) => ({ p: num(x.px), s: num(x.qty) });
  const offers = (d.offers || []).map(lvl).filter((x) => x.p != null && x.s > 0).sort((a, b) => a.p - b.p);
  const bids = (d.bids || []).map(lvl).filter((x) => x.p != null && x.s > 0).sort((a, b) => b.p - a.p);
  const ts = Date.parse(d.transactTime) || Date.now();
  return {
    timestamp: new Date(ts).toISOString(), state: d.state || null,
    yes: { asks: offers, bids },
    no: { asks: bids.map((x) => ({ p: Math.round((1 - x.p) * 1e6) / 1e6, s: x.s })), bids: offers.map((x) => ({ p: Math.round((1 - x.p) * 1e6) / 1e6, s: x.s })) },
  };
}

export const polymarketUSProvider = {
  id: 'polymarket-us',
  name: 'Polymarket US',
  capabilities: { status: 'live', label: 'LIVE · order book', orderBook: true, depth: true, fees: 'exact', realMoney: true, arb: true,
    notes: 'Public gateway (no key): markets + full order books. US-regulated venue, separate from Polymarket International. Taker fee 0.0695·p(1−p), rounded to the cent.' },

  async fetchSnapshot({ maxEvents, fetch: fetchImpl = globalThis.fetch, onProgress } = {}) {
    const max = +(process.env.PMUS_MAX_MARKETS || maxEvents || 15000);
    const PAGE = 500, LIMIT_PAGES = 400, CONC = 6;
    const raw = [];
    let next = 0, done = false, pages = 0;
    const worker = async () => {
      while (!done && pages < LIMIT_PAGES) {
        const off = next; next += PAGE; pages++;
        const j = await getJSON(fetchImpl, `${PMUS_GATEWAY}/v1/markets?limit=${PAGE}&offset=${off}&active=true&closed=false`);
        const ms = j?.markets || [];
        raw.push(...ms);
        if (ms.length < PAGE) done = true;
        onProgress && onProgress({ markets: raw.length });
      }
    };
    await Promise.all(Array.from({ length: CONC }, worker));
    const seen = new Set();
    const all = raw.filter((m) => !seen.has(m.slug) && seen.add(m.slug)).map(normalizePMUSMarket).filter(Boolean);
    const quoted = all.filter((m) => m.bid != null || m.ask != null);
    // Keep every game-level market with a quote; fill the rest by 24h volume (memory bound).
    const games = quoted.filter((m) => m.isGame), rest = quoted.filter((m) => !m.isGame).sort((a, b) => b.volume24h - a.volume24h);
    const markets = [...games.slice(0, max), ...rest.slice(0, Math.max(0, max - games.length))];
    const events = markets.map((m) => ({ id: m.eventId, provider: 'polymarket-us', title: m.question, slug: m.slug, url: m.url, category: m.category, tags: [],
      exclusive: false, exhaustive: false, resolvedYes: 0, liquidity: 0, volume: m.volume, volume24h: m.volume24h, endDate: m.endDate, marketIds: [m.id] }));
    return { provider: 'polymarket-us', fetchedAt: new Date().toISOString(), events, markets, listed: all.length, quoted: quoted.length,
      warnings: quoted.length > markets.length ? [`polymarket-us: kept ${markets.length.toLocaleString()} of ${quoted.length.toLocaleString()} quoted markets (PMUS_MAX_MARKETS)`] : [] };
  },

  async fetchBooks(slugs, { fetch: fetchImpl = globalThis.fetch } = {}) {
    const out = {};
    for (let i = 0; i < slugs.length; i += 8)
      await Promise.all(slugs.slice(i, i + 8).map(async (s) => {
        try { out[s] = parsePMUSBook(await getJSON(fetchImpl, `${PMUS_GATEWAY}/v1/markets/${encodeURIComponent(s)}/book`)); } catch { /* missing book = no ladder */ }
      }));
    return out;
  },

  async fetchBook(slug, { side = 'yes', fetch: fetchImpl = globalThis.fetch } = {}) {
    const b = parsePMUSBook(await getJSON(fetchImpl, `${PMUS_GATEWAY}/v1/markets/${encodeURIComponent(slug)}/book`));
    const L = b[side] || b.yes;
    return { ask: L.asks[0]?.p ?? null, askSize: L.asks[0]?.s ?? null, bid: L.bids[0]?.p ?? null, asks: L.asks.slice(0, 10), timestamp: b.timestamp };
  },

  async fetchMarketDetails(id) {
    const slug = String(id).replace(/^pmus:/, '');
    const j = await getJSON(globalThis.fetch, `${PMUS_GATEWAY}/v1/markets?slug=${encodeURIComponent(slug)}`);
    const m = j?.markets?.[0];
    return m ? { id, description: m.description || '', rules: m.description || '', url: `${SITE}/${slug}` } : { id, description: '' };
  },
};
