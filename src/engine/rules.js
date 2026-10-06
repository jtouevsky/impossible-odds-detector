// Probability-rule engine: turns a logical relationship + current quotes into a (possible) violation.
//
// Prices are treated conservatively. For a market with a tight book (spread ≤ 10¢) we use its
// displayed price (≈ midpoint), exactly as Polymarket does. For a market with a wide or one-sided
// book we only trust the bounds [best bid, best ask] and always take the bound that is MOST
// favourable to the prices being consistent. So "magnitude" is a violation that survives the most
// charitable reading of illiquid quotes.
//
// "edge" = guaranteed gross profit per $1 payout from trading the contradiction at today's best
// bid/ask (before fees, ignoring depth). edge > 0 means it is executable right now.

export const TIGHT_SPREAD = 0.1;

const bid = (m) => (m.bid != null ? m.bid : 0);
const ask = (m) => (m.ask != null ? m.ask : 1);
// Multi-leg sets are full of longshots whose midpoints are systematically too high (bid 0.1¢ / ask 3¢),
// so set legs only count as "tight" with a much narrower spread.
export const SET_TIGHT_SPREAD = 0.02;
// A quote is "tight" if its spread is small relative to the price itself: a 9¢ spread is fine around 50%
// but meaningless for a 5% longshot.
const tightLimit = (m) => Math.min(TIGHT_SPREAD, Math.max(0.02, 0.5 * Math.min(m.price, 1 - m.price)));
export const isTight = (m, t) => m.bid != null && m.ask != null && m.ask - m.bid <= (t ?? tightLimit(m)) + 1e-9;
const point = (m) => Math.min(Math.max(m.price, bid(m)), ask(m));
/** lowest / highest probability consistent with the quotes */
export const lo = (m, t) => (isTight(m, t) ? point(m) : bid(m));
export const hi = (m, t) => (isTight(m, t) ? point(m) : ask(m));
const sum = (xs) => xs.reduce((s, x) => s + x, 0);

export function evaluate(rel, byId) {
  if (rel.members) {
    const legs = rel.members.map((id) => byId.get(id));
    if (legs.some((m) => !m)) return null;
    const displayed = sum(legs.map((m) => m.price));
    const sLo = sum(legs.map((m) => lo(m, SET_TIGHT_SPREAD))), sHi = sum(legs.map((m) => hi(m, SET_TIGHT_SPREAD)));
    const sb = sum(legs.map(bid)), sa = sum(legs.map(ask));
    const n = legs.length;
    // cost of one full basket: all-NO costs Σ(1-bid) and pays n-1; all-YES costs Σask and pays 1
    const over = { legs, sum: displayed, sumLo: sLo, sumHi: sHi, magnitude: sLo - 1, edge: sb - 1, cost: n - sb, direction: 'over',
      trade: rel.type === 'exclusive-set'
        ? 'Buy NO on every outcome: at most one can resolve YES, so all but one NO pays out.'
        : 'Buy NO on every outcome: exactly one resolves YES, so every other NO pays out.' };
    if (rel.type === 'exclusive-set') return over;
    const under = { legs, sum: displayed, sumLo: sLo, sumHi: sHi, magnitude: 1 - sHi, edge: 1 - sa, cost: sa, direction: 'under',
      trade: 'Buy YES on every outcome: exactly one resolves YES and pays $1.' };
    return over.magnitude >= under.magnitude ? over : under;
  }

  let A = byId.get(rel.a), B = byId.get(rel.b);
  if (!A || !B) return null;
  switch (rel.type) {
    case 'implication': // A ⇒ B, so P(A) ≤ P(B)
      return { legs: [A, B], A, B, displayedGap: A.price - B.price, magnitude: lo(A) - hi(B), edge: bid(A) - ask(B), cost: 1 - bid(A) + ask(B),
        trade: `Buy NO on A and YES on B. If A happens, B happens too, so at least one leg pays $1.` };
    case 'equivalent': {
      if (lo(B) - hi(A) > lo(A) - hi(B)) [A, B] = [B, A];
      return { legs: [A, B], A, B, displayedGap: A.price - B.price, magnitude: lo(A) - hi(B), edge: bid(A) - ask(B), cost: 1 - bid(A) + ask(B),
        trade: 'Buy NO on the pricier copy (A) and YES on the cheaper one (B). They resolve together, so exactly one leg pays $1.' };
    }
    case 'exclusive': // P(A) + P(B) ≤ 1
      return { legs: [A, B], A, B, sum: A.price + B.price, magnitude: lo(A) + lo(B) - 1, edge: bid(A) + bid(B) - 1, cost: 2 - bid(A) - bid(B),
        trade: 'Buy NO on both. At most one can resolve YES, so at least one NO pays $1.' };
    default:
      return null;
  }
}
