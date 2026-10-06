// PredictIt — public market data API (no key). Real-money US venue.
//   GET https://www.predictit.org/api/marketdata/all/
// Gives best buy/sell prices for YES and NO on every contract but NO order sizes, so anything that involves
// PredictIt can show per-share economics but can never be "guaranteed" (we can't prove it's fillable).
// Fees: 10% of profit on winning shares (+5% on withdrawals, not modelled per trade).
import { isUsableMarket, hashString } from './schema.js';
import { getJSON } from './polymarket.js';

const API = 'https://www.predictit.org/api/marketdata/all/';
const num = (v) => (v == null || v === '' ? null : Number.isFinite(+v) ? +v : null);

export function normalizePredictItMarket(pm) {
  const contracts = (pm.contracts || []).filter((c) => c.status === 'Open');
  const multi = contracts.length > 1;
  const markets = [];
  for (const c of contracts) {
    const ask = num(c.bestBuyYesCost), noAsk = num(c.bestBuyNoCost), bid = num(c.bestSellYesCost);
    const price = num(c.lastTradePrice) ?? (ask != null && bid != null ? (ask + bid) / 2 : ask);
    const m = {
      id: `PI-${c.id}`, provider: 'predictit', eventId: `PI-${pm.id}`, piMarketId: pm.id,
      question: multi ? `${pm.name} — ${c.name}` : pm.name, label: multi ? c.name : '',
      yesOutcome: 'Yes', noOutcome: 'No', isYesNo: true,
      price, bid, ask, noAsk, askSize: null, noAskSize: null, noDepth: true,
      liquidity: 0, volume: 0, volume24h: 0,
      endDate: c.dateEnd && c.dateEnd !== 'NA' ? new Date(c.dateEnd).toISOString() : null,
      acceptingOrders: true, isGame: false, category: 'Politics', tokenId: String(c.id), noTokenId: String(c.id),
      url: pm.url, eventTitle: pm.name, rules: '', descriptionHash: hashString(`${pm.id}|${c.id}`),
    };
    if (m.price != null && isUsableMarket(m)) markets.push(m);
  }
  const event = {
    id: `PI-${pm.id}`, provider: 'predictit', title: pm.name, url: pm.url, category: 'Politics', tags: ['Politics'],
    exclusive: multi, exhaustive: false, exhaustiveVerified: false, exhaustiveBasis: null, resolvedYes: 0, isGame: false,
    liquidity: 0, volume: 0, volume24h: 0, endDate: markets[0]?.endDate || null, marketIds: markets.map((m) => m.id),
  };
  return { event, markets };
}

export const predictitProvider = {
  id: 'predictit',
  name: 'PredictIt',
  capabilities: { status: 'live', label: 'LIVE · top of book', orderBook: true, depth: false, fees: 'exact', realMoney: true, arb: true,
    notes: 'Public prices for every contract, but no order sizes — PredictIt trades can be near-arb at best, never "guaranteed".' },
  async fetchSnapshot({ fetch: fetchImpl = globalThis.fetch, onProgress } = {}) {
    const d = await getJSON(fetchImpl, API, { timeoutMs: 20000 });
    const events = [], markets = [];
    for (const pm of d.markets || []) {
      try { const r = normalizePredictItMarket(pm); if (r.markets.length) { events.push(r.event); markets.push(...r.markets); } } catch { /* skip */ }
    }
    onProgress && onProgress({ page: 1, events: events.length, markets: markets.length, target: events.length });
    return { provider: 'predictit', fetchedAt: new Date().toISOString(), partial: false, warnings: [], events, markets };
  },
  /** Top of book only (sizes unknown). */
  async fetchBooks(ids, { fetch: fetchImpl = globalThis.fetch } = {}) {
    const d = await getJSON(fetchImpl, API, { timeoutMs: 20000, retries: 1 });
    const out = {};
    const want = new Set(ids);
    for (const pm of d.markets || []) for (const c of pm.contracts || []) {
      const id = `PI-${c.id}`;
      if (!want.has(id)) continue;
      const ts = new Date().toISOString();
      const lv = (p) => (num(p) != null ? [{ p: num(p), s: null }] : []);
      out[id] = { yes: { asks: lv(c.bestBuyYesCost), bids: lv(c.bestSellYesCost), noDepth: true }, no: { asks: lv(c.bestBuyNoCost), bids: lv(c.bestSellNoCost), noDepth: true }, timestamp: ts };
    }
    return out;
  },
  async fetchBook(id, opts) {
    const b = (await this.fetchBooks([id], opts))[id];
    if (!b) throw new Error('no book');
    const x = b[opts?.side === 'no' ? 'no' : 'yes'];
    return { bid: x.bids[0]?.p ?? null, bidSize: 0, ask: x.asks[0]?.p ?? null, askSize: 0, timestamp: b.timestamp, noDepth: true };
  },
};
