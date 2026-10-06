// Odds math. Pure functions, no I/O.
//   american ↔ decimal ↔ implied probability
//   proportional margin removal over a COMPLETE matched outcome set (never from one side)
//   estimated consensus across independent books with transparent freshness weights

export function americanToDecimal(a) {
  a = +a;
  if (!Number.isFinite(a) || a === 0 || (a > -100 && a < 100)) return null;
  return a > 0 ? 1 + a / 100 : 1 + 100 / -a;
}
export function decimalToAmerican(d) {
  if (!(d > 1)) return null;
  return d >= 2 ? Math.round((d - 1) * 100) : Math.round(-100 / (d - 1));
}
export const impliedFromDecimal = (d) => (d > 1 ? 1 / d : null);

/**
 * Remove the bookmaker margin from one book's prices for a complete set of mutually exclusive outcomes.
 * prices: [{ outcome, decimal }]. Returns null unless every outcome in `requiredOutcomes` is present.
 * Method: proportional normalisation p_i = (1/d_i) / Σ(1/d_j).
 */
export function devigProportional(prices, requiredOutcomes) {
  const by = new Map(prices.filter((p) => p.decimal > 1).map((p) => [p.outcome, p]));
  if (!requiredOutcomes || requiredOutcomes.length < 2) return null;
  if (!requiredOutcomes.every((o) => by.has(o))) return null; // missing side → no fair probability
  const imp = requiredOutcomes.map((o) => 1 / by.get(o).decimal);
  const overround = imp.reduce((s, x) => s + x, 0);
  if (!(overround > 0.9)) return null; // implausible (feed error / stale mix)
  return {
    method: 'proportional', overround, margin: overround - 1,
    outcomes: requiredOutcomes.map((o, i) => ({ outcome: o, decimal: by.get(o).decimal, implied: imp[i], fair: imp[i] / overround })),
  };
}

export const FRESH_DEFAULTS = { fullWeightMin: 10, maxAgeMin: 60 };

/** 1 while fresh, then linear decay to 0 at maxAge. Transparent by design. */
export function freshnessWeight(ageMs, { fullWeightMin = 10, maxAgeMin = 60 } = FRESH_DEFAULTS) {
  const m = ageMs / 60e3;
  if (!Number.isFinite(m) || m < 0) return 0;
  if (m <= fullWeightMin) return 1;
  if (m >= maxAgeMin) return 0;
  return 1 - (m - fullWeightMin) / (maxAgeMin - fullWeightMin);
}

// Books that share one pricing feed are counted once (the freshest copy wins).
export const BOOK_FAMILY = { williamhill_us: 'caesars', caesars: 'caesars', sugarhouse: 'betrivers', betrivers: 'betrivers' };
export const familyOf = (book) => BOOK_FAMILY[book] || book;

/**
 * Estimated consensus probability for one outcome.
 * books: [{ book, fair, timestamp }] (already de-vigged per book), excludeVenue: the venue being evaluated.
 */
export function consensus(books, { now = Date.now(), excludeVenue = null, fresh = FRESH_DEFAULTS, minBooks = 2 } = {}) {
  const fam = new Map();
  const excluded = [];
  for (const b of books) {
    if (excludeVenue && (b.book === excludeVenue || familyOf(b.book) === familyOf(excludeVenue))) { excluded.push({ ...b, why: 'venue being evaluated' }); continue; }
    const age = now - Date.parse(b.timestamp);
    const w = freshnessWeight(age, fresh);
    if (w <= 0) { excluded.push({ ...b, why: 'stale', ageMs: age }); continue; }
    const k = familyOf(b.book), cur = { ...b, weight: w, ageMs: age }, prev = fam.get(k);
    if (!prev) { fam.set(k, cur); continue; }
    const [keep, drop] = prev.ageMs <= age ? [prev, cur] : [cur, prev];
    fam.set(k, keep);
    excluded.push({ ...drop, why: `duplicate feed (${k})` });
  }
  const used = [...fam.values()];
  const W = used.reduce((s, b) => s + b.weight, 0);
  if (used.length < minBooks || W <= 0) return { probability: null, books: used, excluded, reason: `needs ${minBooks}+ fresh independent books (have ${used.length})` };
  const p = used.reduce((s, b) => s + b.fair * b.weight, 0) / W;
  const newest = Math.min(...used.map((b) => b.ageMs));
  return { probability: p, books: used, excluded, method: 'freshness-weighted mean of per-book proportional no-vig probabilities', weightTotal: W, newestAgeMs: newest, oldestAgeMs: Math.max(...used.map((b) => b.ageMs)) };
}
