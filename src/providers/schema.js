// Provider-neutral data model. Every provider (Polymarket today, Kalshi etc. later)
// must return a Snapshot in this shape; the detection engine only ever sees this.
//
// Snapshot = {
//   provider: string, fetchedAt: ISO string, partial?: boolean, warnings?: string[],
//   events:  Event[],
//   markets: Market[],
// }
//
// Event = {
//   id, provider, title, slug, url, category, tags: string[],
//   exclusive: boolean,          // outcomes are mutually exclusive (e.g. Polymarket negRisk)
//   exhaustive: boolean,         // listed outcomes cover every possibility
//   resolvedYes: number,         // # child markets already resolved YES (set is decided)
//   liquidity, volume, volume24h, endDate, marketIds: string[]
// }
//
// Market = {
//   id, provider, eventId, question, label,  // label = short outcome name ("JD Vance", "↑ 100,000")
//   yesOutcome, noOutcome,                   // what the priced side means ("Yes", "Over", "Colts")
//   price,                                   // probability of yesOutcome, 0..1 (displayed price)
//   bid, ask,                                // best bid/ask for yesOutcome (null if none)
//   spread, liquidity, volume, volume24h, endDate,
//   isGame: boolean,                         // belongs to a single game/match (props, spreads, totals)
//   sportsType, tokenId, url, descriptionHash, description
// }

export const REQUIRED_MARKET_FIELDS = ['id', 'eventId', 'question', 'price'];

export function isUsableMarket(m) {
  return m && REQUIRED_MARKET_FIELDS.every((k) => m[k] != null) &&
    Number.isFinite(m.price) && m.price >= 0 && m.price <= 1;
}

export function hasTwoSidedBook(m) {
  return m.bid != null && m.ask != null && m.bid > 0 && m.ask < 1 && m.ask >= m.bid;
}

export function hashString(s) {
  let h = 2166136261 >>> 0;
  for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619); }
  return (h >>> 0).toString(36);
}
