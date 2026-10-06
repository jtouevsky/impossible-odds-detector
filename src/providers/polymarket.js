// Polymarket provider: Gamma API (events + markets) and CLOB (live order books).
// Docs: https://docs.polymarket.com/
import { isUsableMarket, hashString } from './schema.js';

const GAMMA = 'https://gamma-api.polymarket.com';
const CLOB = 'https://clob.polymarket.com';
const SITE = 'https://polymarket.com';

// Preferred top-level categories (first match among an event's tags wins).
const CATEGORY_ORDER = [
  'Politics', 'Elections', 'Sports', 'Crypto', 'Finance', 'Economy', 'Tech', 'AI', 'Geopolitics',
  'World', 'Culture', 'Weather', 'Esports', 'Science', 'Business',
];
const CATEGORY_ALIASES = { Midterms: 'Politics', Elections: 'Politics', Trump: 'Politics', 'NFL (All)': 'Sports',
  NFL: 'Sports', NBA: 'Sports', NHL: 'Sports', MLB: 'Sports', Soccer: 'Sports', Tennis: 'Sports', 'CFB (All)': 'Sports',
  Bitcoin: 'Crypto', Ethereum: 'Crypto', Oil: 'Finance', Movies: 'Culture', Music: 'Culture', Awards: 'Culture' };

function pickCategory(tags) {
  const labels = (tags || []).map((t) => t && t.label).filter(Boolean);
  for (const c of CATEGORY_ORDER) if (labels.includes(c)) return c === 'Elections' ? 'Politics' : c;
  for (const l of labels) if (CATEGORY_ALIASES[l]) return CATEGORY_ALIASES[l];
  return labels[0] || 'Other';
}

function parseJSONArray(v) {
  if (Array.isArray(v)) return v;
  if (typeof v !== 'string') return null;
  try { const a = JSON.parse(v); return Array.isArray(a) ? a : null; } catch { return null; }
}

const num = (v) => {
  if (v == null || v === '') return null;
  const n = typeof v === 'number' ? v : parseFloat(v);
  return Number.isFinite(n) ? n : null;
};

const GAME_TITLE = /\bvs\.?\b|\bv\.? /i;

export function normalizeEvent(e) {
  const tags = e.tags || [];
  const category = pickCategory(tags);
  const isGameEvent = GAME_TITLE.test(e.title || '');
  const markets = [];
  let resolvedYes = 0, pricedOther = false, inactive = 0;
  for (const m of e.markets || []) {
    if (m.closed) {
      const op = parseJSONArray(m.outcomePrices);
      if (op && num(op[0]) === 1) resolvedYes++;
      continue;
    }
    if (m.active === false || m.archived) { inactive++; continue; }
    const nm = normalizeMarket(m, e, category, isGameEvent);
    if (nm) {
      markets.push(nm);
      if (/^other\b|another (person|candidate|team)/i.test(nm.label || nm.question)) pricedOther = true;
    }
  }
  const exclusive = !!(e.negRisk || e.enableNegRisk);
  // negRisk sets are mutually exclusive by construction. "Augmented" sets may gain new outcomes later,
  // so they are only exhaustive when an "Other" catch-all is actually listed and priced.
  const exhaustive = exclusive && (!e.negRiskAugmented || pricedOther);
  const event = {
    id: String(e.id), provider: 'polymarket', title: e.title || '', slug: e.slug,
    url: e.slug ? `${SITE}/event/${e.slug}` : SITE,
    category, tags: tags.map((t) => t.label).filter(Boolean).slice(0, 8),
    exclusive, exhaustive, augmented: !!e.negRiskAugmented,
    // arbitrage engine: a neg-risk set is only *treated* as exhaustive (with LIKELY status) when it lists a catch-all
    exhaustiveVerified: false, exhaustiveBasis: exclusive && pricedOther ? 'set includes a catch-all outcome (Other / None)' : null, resolvedYes, inactiveMarkets: inactive,
    isGame: isGameEvent,
    liquidity: num(e.liquidity) || 0, volume: num(e.volume) || 0, volume24h: num(e.volume24hr) || 0,
    endDate: e.endDate || null, marketIds: markets.map((m) => m.id),
  };
  return { event, markets };
}

/** Settlement text kept for matching/detail views; long boilerplate is trimmed to bound memory. */
export function compactRules(t, max = 1500) {
  const x = String(t || '').replace(/[ \t]+/g, ' ').trim();
  return x.length > max ? x.slice(0, max) + '…' : (' ' + x).slice(1); // copy -> no reference to the raw JSON
}

export function normalizeMarket(m, e, category, isGameEvent) {
  try {
    const outcomes = parseJSONArray(m.outcomes) || ['Yes', 'No'];
    const prices = parseJSONArray(m.outcomePrices);
    if (!prices || prices.length < 2 || outcomes.length !== 2) return null;
    const price = num(prices[0]);
    const tokens = parseJSONArray(m.clobTokenIds) || [];
    const description = m.description || e.description || '';
    const nm = {
      id: String(m.id), provider: 'polymarket', eventId: String(e.id), conditionId: m.conditionId,
      question: (m.question || '').trim(), label: (m.groupItemTitle || '').trim(),
      yesOutcome: String(outcomes[0]), noOutcome: String(outcomes[1]),
      isYesNo: /^yes$/i.test(outcomes[0]) && /^no$/i.test(outcomes[1]),
      price,
      bid: num(m.bestBid), ask: num(m.bestAsk), lastTrade: num(m.lastTradePrice),
      spread: num(m.spread),
      liquidity: num(m.liquidityNum ?? m.liquidity) || 0,
      volume: num(m.volumeNum ?? m.volume) || 0,
      volume24h: num(m.volume24hr) || 0,
      endDate: m.endDate || e.endDate || null,
      acceptingOrders: m.acceptingOrders !== false,
      sportsType: m.sportsMarketType || null,
      isGame: !!(m.sportsMarketType || isGameEvent),
      category,
      tokenId: tokens[0] || null,
      noTokenId: tokens[1] || null,
      // settlement rules (kept server-side for MarketSpec matching; not shipped to the browser in bulk)
      rules: compactRules(description),
      slug: m.slug || null, eventSlug: e.slug || null,
      gameStartTime: m.gameStartTime || e.startTime || null,
      // taker fees: fee = C × rate × (p(1−p))^exponent  (docs.polymarket.com/trading/fees)
      feesEnabled: m.feesEnabled == null ? null : !!m.feesEnabled,
      feeRate: num(m.feeSchedule?.rate), feeExponent: num(m.feeSchedule?.exponent) ?? 1,
      negRisk: !!(m.negRisk ?? e.negRisk),
      orderMinSize: num(m.orderMinSize) ?? 5, tickSize: num(m.orderPriceMinTickSize),
      url: e.slug ? `${SITE}/event/${e.slug}${m.slug ? '/' + m.slug : ''}` : SITE,
      eventTitle: e.title || '',
      // full text is fetched on demand (detail view) to keep the snapshot small
      descriptionHash: hashString(description.replace(/\s+/g, ' ').trim().toLowerCase()),
    };
    if (nm.bid != null && nm.ask != null && nm.ask < nm.bid) { nm.bid = null; nm.ask = null; }
    return isUsableMarket(nm) ? nm : null;
  } catch {
    return null; // malformed market — skip it, never crash the scan
  }
}

export async function getJSON(fetchImpl, url, { retries = 3, timeoutMs = 20000, method = 'GET', body } = {}) {
  let lastErr;
  for (let i = 0; i <= retries; i++) {
    const ctl = new AbortController();
    const timer = setTimeout(() => ctl.abort(), timeoutMs);
    try {
      const r = await fetchImpl(url, { method, body: body ? JSON.stringify(body) : undefined, signal: ctl.signal,
        headers: body ? { accept: 'application/json', 'content-type': 'application/json' } : { accept: 'application/json' } });
      if (r.status === 429 || r.status >= 500) throw new Error(`HTTP ${r.status}`);
      if (!r.ok) throw Object.assign(new Error(`HTTP ${r.status} for ${url}`), { fatal: true });
      return await r.json();
    } catch (err) {
      lastErr = err;
      if (err.fatal) break;
      await new Promise((res) => setTimeout(res, 400 * 2 ** i));
    } finally { clearTimeout(timer); }
  }
  throw lastErr;
}

export const polymarketProvider = {
  id: 'polymarket',
  name: 'Polymarket',
  capabilities: { status: 'live', label: 'LIVE · order book', orderBook: true, depth: true, fees: 'exact', realMoney: true, arb: true,
    notes: 'Gamma API for markets + CLOB order books with full depth. Per-market fee schedule.' },

  /**
   * Fetch active events (with nested markets) ordered by 24h volume, using keyset pagination.
   * @param {{maxEvents?:number, fetch?:Function, onProgress?:Function}} opts
   */
  async fetchSnapshot({ maxEvents = 4000, fetch: fetchImpl = globalThis.fetch, onProgress } = {}) {
    const events = [], markets = [], warnings = [];
    const seen = new Set();
    let cursor = null, page = 0, raw = 0, partial = false;
    while (raw < maxEvents) {
      const u = new URL(`${GAMMA}/events/keyset`);
      u.searchParams.set('active', 'true');
      u.searchParams.set('closed', 'false');
      u.searchParams.set('limit', '100');
      u.searchParams.set('order', 'volume24hr');
      u.searchParams.set('ascending', 'false');
      if (cursor) u.searchParams.set('after_cursor', cursor);
      let data;
      try {
        data = await getJSON(fetchImpl, u.toString());
      } catch (err) {
        if (page === 0) throw new Error(`Polymarket API unreachable: ${err.message}`);
        warnings.push(`Stopped after ${raw} events: ${err.message}`);
        partial = true;
        break;
      }
      const batch = Array.isArray(data) ? data : data.events || [];
      for (const e of batch) {
        if (!e || seen.has(e.id)) continue;
        seen.add(e.id);
        raw++;
        try {
          const { event, markets: ms } = normalizeEvent(e);
          if (ms.length) { events.push(event); markets.push(...ms); }
        } catch { /* malformed event */ }
      }
      page++;
      onProgress && onProgress({ page, events: raw, markets: markets.length, target: maxEvents });
      cursor = data.next_cursor;
      if (!cursor || !batch.length) break;
    }
    return { provider: 'polymarket', fetchedAt: new Date().toISOString(), partial, warnings, events, markets };
  },

  /** Full market record (resolution rules etc.) for the detail view. */
  async fetchMarketDetails(id, { fetch: fetchImpl = globalThis.fetch } = {}) {
    const m = await getJSON(fetchImpl, `${GAMMA}/markets/${encodeURIComponent(id)}`, { retries: 1, timeoutMs: 8000 });
    return { id: String(m.id), question: m.question, description: m.description || '', endDate: m.endDate,
      resolutionSource: m.resolutionSource || '' };
  },

  /** Full ask/bid ladders for many tokens at once (CLOB POST /books). Returns { [tokenId]: {bids, asks, timestamp} } */
  async fetchBooks(tokenIds, { fetch: fetchImpl = globalThis.fetch } = {}) {
    const out = {};
    for (let i = 0; i < tokenIds.length; i += 100) {
      const chunk = tokenIds.slice(i, i + 100);
      const arr = await getJSON(fetchImpl, `${CLOB}/books`, { method: 'POST', body: chunk.map((t) => ({ token_id: t })), retries: 1, timeoutMs: 10000 });
      for (const d of arr || []) {
        out[d.asset_id] = {
          bids: (d.bids || []).map((x) => ({ p: +x.price, s: +x.size })).sort((a, b) => b.p - a.p),
          asks: (d.asks || []).map((x) => ({ p: +x.price, s: +x.size })).sort((a, b) => a.p - b.p),
          timestamp: new Date().toISOString(),                                    // when we read it
          bookUpdated: d.timestamp ? new Date(+d.timestamp).toISOString() : null, // last change on the book
        };
      }
    }
    return out;
  },

  /** Live order book for a token -> { bid, ask, bidSize, askSize } */
  async fetchBook(tokenId, { fetch: fetchImpl = globalThis.fetch } = {}) {
    const d = await getJSON(fetchImpl, `${CLOB}/book?token_id=${encodeURIComponent(tokenId)}`, { retries: 1, timeoutMs: 8000 });
    const bids = (d.bids || []).map((x) => ({ p: +x.price, s: +x.size })).sort((a, b) => b.p - a.p);
    const asks = (d.asks || []).map((x) => ({ p: +x.price, s: +x.size })).sort((a, b) => a.p - b.p);
    return {
      bid: bids[0]?.p ?? null, bidSize: bids[0]?.s ?? 0,
      ask: asks[0]?.p ?? null, askSize: asks[0]?.s ?? 0,
      timestamp: d.timestamp ? new Date(+d.timestamp).toISOString() : new Date().toISOString(),
    };
  },
};
