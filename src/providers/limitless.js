// Limitless Exchange — public REST API (no key), on-chain CLOB (Base). Mostly short-dated crypto markets.
//   GET https://api.limitless.exchange/markets/active?limit=25&page=N
//   GET https://api.limitless.exchange/markets/{slug}/orderbook   (YES book; sizes in 1e-6 shares)
import { isUsableMarket, hashString } from './schema.js';
import { getJSON } from './polymarket.js';

const API = 'https://api.limitless.exchange';
const SITE = 'https://limitless.exchange/markets';
const num = (v) => (v == null || v === '' ? null : Number.isFinite(+v) ? +v : null);
const UNIT = 1e6;

export function normalizeLimitlessMarket(x) {
  if (x.tradeType !== 'clob' || x.expired || !x.tokens) return null;
  const buy = x.tradePrices?.buy?.market || [];
  const sell = x.tradePrices?.sell?.market || [];
  const ask = num(buy[0]), noAsk = num(buy[1]), bid = num(sell[0]);
  const price = num(x.prices?.[0]) != null ? num(x.prices[0]) / (num(x.prices[0]) > 1 ? 100 : 1) : null;
  const m = {
    id: `LM-${x.id}`, provider: 'limitless', eventId: `LM-${x.groupId || x.id}`, slug: x.slug,
    question: x.title, label: '', yesOutcome: 'Yes', noOutcome: 'No', isYesNo: true,
    price, bid: bid && bid > 0 ? bid : null, ask: ask && ask < 1 ? ask : null, noAsk: noAsk && noAsk < 1 ? noAsk : null,
    askSize: null, noAskSize: null, liquidity: 0, volume: num(x.volumeFormatted) || 0, volume24h: 0,
    endDate: x.expirationTimestamp ? new Date(x.expirationTimestamp).toISOString() : null,
    acceptingOrders: true, isGame: false, category: (x.categories || [])[0] || 'Crypto',
    tokenId: x.tokens.yes, noTokenId: x.tokens.no, url: `${SITE}/${x.slug}`, eventTitle: x.title,
    rules: String(x.description || '').replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 1500),
    descriptionHash: hashString(String(x.description || '')), orderMinSize: num(x.settings?.minSize) ? num(x.settings.minSize) / UNIT : 1,
  };
  return m.price != null && isUsableMarket(m) ? m : null;
}

export const limitlessProvider = {
  id: 'limitless',
  name: 'Limitless',
  capabilities: { status: 'live', label: 'LIVE · order book', orderBook: true, depth: true, fees: 'assumed', realMoney: true, arb: true,
    notes: 'On-chain CLOB with full depth. Fee schedule not published in the API, so a conservative 0.07·p(1−p) taker fee is assumed.' },
  async fetchSnapshot({ fetch: fetchImpl = globalThis.fetch, onProgress, maxPages = 40 } = {}) {
    const events = [], markets = [], warnings = [];
    for (let page = 1; page <= maxPages; page++) {
      let d;
      try { d = await getJSON(fetchImpl, `${API}/markets/active?limit=25&page=${page}`, { timeoutMs: 15000 }); }
      catch (err) { if (page === 1) throw new Error(`Limitless API unreachable: ${err.message}`); warnings.push(`Limitless: ${err.message}`); break; }
      const rows = d.data || [];
      for (const x of rows) {
        const m = normalizeLimitlessMarket(x);
        if (!m) continue;
        markets.push(m);
        events.push({ id: m.eventId, provider: 'limitless', title: m.question, url: m.url, category: m.category, tags: x.categories || [],
          exclusive: false, exhaustive: false, exhaustiveVerified: false, resolvedYes: 0, isGame: false, liquidity: 0, volume: m.volume,
          volume24h: 0, endDate: m.endDate, marketIds: [m.id] });
      }
      onProgress && onProgress({ page, events: events.length, markets: markets.length, target: d.totalMarketsCount || 0 });
      if (rows.length < 25) break;
    }
    // merge events that share a groupId
    const byId = new Map();
    for (const e of events) { const x = byId.get(e.id); if (x) x.marketIds.push(...e.marketIds); else byId.set(e.id, e); }
    return { provider: 'limitless', fetchedAt: new Date().toISOString(), partial: !!warnings.length, warnings, events: [...byId.values()], markets };
  },
  async fetchBooks(markets, { fetch: fetchImpl = globalThis.fetch } = {}) {
    const out = {};
    const q = [...new Map(markets.map((m) => [m.id, m])).values()];
    await Promise.all(Array.from({ length: 4 }, async () => {
      while (q.length) {
        const m = q.shift();
        try {
          const d = await getJSON(fetchImpl, `${API}/markets/${encodeURIComponent(m.slug)}/orderbook`, { retries: 1, timeoutMs: 8000 });
          const asks = (d.asks || []).map((x) => ({ p: +x.price, s: +x.size / UNIT })).sort((a, b) => a.p - b.p);
          const bids = (d.bids || []).map((x) => ({ p: +x.price, s: +x.size / UNIT })).sort((a, b) => b.p - a.p);
          const r4 = (x) => Math.round(x * 1e4) / 1e4;
          out[m.id] = { yes: { asks, bids }, no: { asks: bids.map((x) => ({ p: r4(1 - x.p), s: x.s })), bids: asks.map((x) => ({ p: r4(1 - x.p), s: x.s })) }, timestamp: new Date().toISOString() };
        } catch { /* missing */ }
      }
    }));
    return out;
  },
  async fetchBook(slug, opts) {
    const b = (await this.fetchBooks([{ id: slug, slug }], opts))[slug];
    if (!b) throw new Error('no book');
    const x = b[opts?.side === 'no' ? 'no' : 'yes'];
    return { bid: x.bids[0]?.p ?? null, bidSize: x.bids[0]?.s ?? 0, ask: x.asks[0]?.p ?? null, askSize: x.asks[0]?.s ?? 0, timestamp: b.timestamp };
  },
};
