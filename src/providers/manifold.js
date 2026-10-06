// Manifold — public API, PLAY MONEY. Metadata/prices only; never used for arbitrage (you can't lock in real profit).
import { getJSON } from './polymarket.js';

export const manifoldProvider = {
  id: 'manifold',
  name: 'Manifold',
  capabilities: { status: 'partial', label: 'PARTIAL · play money', orderBook: false, depth: false, fees: 'none', realMoney: false, arb: false,
    notes: 'Mana (play money). Scanned for coverage stats only and excluded from every arbitrage calculation.' },
  async fetchSnapshot({ fetch: fetchImpl = globalThis.fetch, onProgress } = {}) {
    const rows = await getJSON(fetchImpl, 'https://api.manifold.markets/v0/search-markets?term=&sort=liquidity&filter=open&contractType=BINARY&limit=1000', { timeoutMs: 20000 });
    onProgress && onProgress({ page: 1, events: rows.length, markets: rows.length, target: rows.length });
    // Not merged into the trading snapshot: counted for diagnostics only.
    return { provider: 'manifold', fetchedAt: new Date().toISOString(), partial: false, warnings: [], events: [], markets: [], referenceCount: rows.length };
  },
};
