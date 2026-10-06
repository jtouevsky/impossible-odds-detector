// Crowd Disagreement + sports structural baskets.
//
// 1. predictionQuotes(markets): prediction-market game contracts (from MarketSpec 'game') → SportsQuotes
// 2. buildComparisons(quotes): per outcome, per target venue, an estimated consensus from OTHER independent books
// 3. sportsBaskets(quotes): cash-payout baskets across venues incl. tie/push/void states — research only,
//    execution is always unverified (sportsbook limits aren't published), so nothing here ever enters the
//    guaranteed arbitrage feed.
import { contractKey, outcomeKey, outcomeSet, matchQuotes, ruleVersion, STATUS } from './schema.js';
import { devigProportional, consensus, FRESH_DEFAULTS } from './odds.js';
import { feeRatePerShare } from '../arb/fees.js';
import { isExecutableArbitrage } from '../arb/payoff.js';

const VNAME = { polymarket: 'Polymarket', 'polymarket-us': 'Polymarket US', kalshi: 'Kalshi' };

function pmRules(m, spec) {
  const r = (m.rules || '').toLowerCase();
  const overtime = /overtime (is )?included|including overtime|includes overtime/.test(r) ? 'included'
    : /overtime (is )?(not included|excluded)|regulation (time )?only|90 minutes/.test(r) ? 'excluded' : null;
  const st = spec.settlement || {};
  return { overtime, tie: st.tie ?? null, push: null, cancellation: st.cancel === 'fair' ? 'fair-price' : st.cancel ?? null, participation: null,
    source: m.rules ? 'venue-text' : 'unknown', version: ruleVersion(m.rules), text: (m.rules || '').slice(0, 900) };
}

/** Prediction-market winner contracts as SportsQuotes. Only game-winner specs; the other team only via a two-team instrument. */
export function predictionQuotes(markets, { leagues = ['nfl'], syncedAt = {} } = {}) {
  const out = [];
  for (const m of markets) {
    const s = m.spec;
    if (!s || s.domain !== 'game' || !leagues.includes(s.league) || s.outcomeKey === 'draw') continue;
    const base = {
      source: m.provider, provider: m.provider, venue: m.provider, venueName: VNAME[m.provider] || m.provider, venueKind: 'prediction',
      sport: 'football', league: s.league, eventKey: s.eventKey, threeWay: false, participants: s.codes,
      event: { title: m.eventTitle || m.question, start: m.gameStartTime || null }, marketId: m.id, url: m.url, timestamp: m.quoteTime || syncedAt[m.provider] || null,
      rules: pmRules(m, s),
    };
    const q = (side, ask, bid, label) => ask != null && ask > 0 && ask < 1 && out.push({
      ...base, id: `${m.id}:${side}`, label,
      market: { type: 'moneyline', period: 'game', statistic: 'winner', player: null, team: null, line: null, side },
      price: { kind: 'exchange', ask, bid, feePerShare: feeRatePerShare(m, ask), tradeSide: label },
    });
    q(s.outcomeKey, m.ask, m.bid, m.isYesNo ? 'YES' : m.yesOutcome);
    if (!m.isYesNo) {
      const other = s.codes.find((c) => c !== s.outcomeKey);
      const noAsk = m.noAsk ?? (m.bid != null ? 1 - m.bid : null);
      q(other, noAsk, m.ask != null ? 1 - m.ask : null, m.noOutcome);
    }
  }
  return out;
}

/** Per-book fair probabilities for every outcome of every contract (complete sets only). */
export function fairByBook(quotes) {
  const books = quotes.filter((q) => q.venueKind === 'sportsbook' && q.price?.decimal > 1);
  const groups = new Map();
  for (const q of books) {
    const k = `${contractKey(q)}#${q.venue}`;
    if (!groups.has(k)) groups.set(k, []);
    groups.get(k).push(q);
  }
  const fair = new Map(); // outcomeKey -> [{ book, fair, implied, decimal, timestamp, margin, quote }]
  const skipped = [];
  for (const qs of groups.values()) {
    const set = outcomeSet(qs[0]);
    const d = devigProportional(qs.map((q) => ({ outcome: q.market.side, decimal: q.price.decimal })), set);
    if (!d) { skipped.push({ venue: qs[0].venue, contract: contractKey(qs[0]), reason: 'opposite side missing — no fair probability from a single side' }); continue; }
    for (const o of d.outcomes) {
      const q = qs.find((x) => x.market.side === o.outcome);
      const k = outcomeKey(q);
      if (!fair.has(k)) fair.set(k, []);
      fair.get(k).push({ book: q.venue, bookName: q.venueName, fair: o.fair, implied: o.implied, decimal: o.decimal, timestamp: q.timestamp, margin: d.margin, method: d.method, quote: q });
    }
  }
  return { fair, skipped };
}

const minStatus = (list) => (list.includes(STATUS.MISMATCH) ? STATUS.MISMATCH : list.includes(STATUS.LIKELY) ? STATUS.LIKELY : STATUS.VERIFIED);

/**
 * One row per (outcome, target venue): target's executable buy price vs the estimated consensus of OTHER books.
 * Disagreement is a research signal. It is never arbitrage.
 */
export function buildComparisons(quotes, { now = Date.now(), fresh = FRESH_DEFAULTS, minBooks = 2 } = {}) {
  const { fair, skipped } = fairByBook(quotes);
  const rows = [];
  const targets = quotes.filter((q) => (q.venueKind === 'prediction' && q.price?.kind === 'exchange') || (q.venueKind === 'sportsbook' && q.price?.decimal > 1));
  for (const t of targets) {
    const k = outcomeKey(t);
    const books = fair.get(k) || [];
    if (!books.length) continue;
    const cons = consensus(books, { now, excludeVenue: t.venue, fresh, minBooks });
    if (cons.probability == null) continue;
    const matches = cons.books.map((b) => ({ book: b.bookName, ...matchQuotes(t, b.quote) }));
    const status = minStatus(matches.map((m) => m.status));
    if (status === STATUS.MISMATCH) continue;
    const isEx = t.price.kind === 'exchange';
    const buyPrice = isEx ? t.price.ask : t.price.implied;           // what one $1 of payout costs
    const allIn = isEx ? t.price.ask + (t.price.feePerShare || 0) : t.price.implied;
    const tAge = t.timestamp ? now - Date.parse(t.timestamp) : null;
    rows.push({
      id: `${k}@${t.venue}`, outcomeKey: k, contractKey: contractKey(t),
      sport: t.sport, league: t.league, marketType: t.market.type, period: t.market.period, line: t.market.line, side: t.market.side,
      event: t.event, eventKey: t.eventKey, participants: t.participants,
      target: { venue: t.venue, venueName: t.venueName, kind: t.venueKind, label: t.label || null, buyPrice, allInPrice: allIn,
        feePerShare: isEx ? t.price.feePerShare || 0 : 0, decimal: t.price.decimal || null, american: t.price.american || null,
        ask: t.price.ask ?? null, bid: t.price.bid ?? null, url: t.url, marketId: t.marketId || null, timestamp: t.timestamp, ageMs: tAge, rules: t.rules },
      consensus: { probability: cons.probability, label: 'Estimated consensus probability', method: cons.method, newestAgeMs: cons.newestAgeMs, oldestAgeMs: cons.oldestAgeMs,
        books: cons.books.map((b) => ({ book: b.book, name: b.bookName, decimal: b.decimal, implied: b.implied, fair: b.fair, margin: b.margin, weight: b.weight, ageMs: b.ageMs, timestamp: b.timestamp, url: b.quote.url })),
        excluded: cons.excluded.map((b) => ({ name: b.bookName, why: b.why })) },
      disagreementPts: (cons.probability - buyPrice) * 100,
      edgeAfterFeesPts: (cons.probability - allIn) * 100,
      match: { status, perBook: matches },
      freshness: { targetAgeMs: tAge, consensusNewestMs: cons.newestAgeMs, consensusOldestMs: cons.oldestAgeMs },
      kind: 'disagreement', guaranteed: false,
    });
  }
  // most meaningful first: the cheapest buys relative to the consensus (after fees)
  rows.sort((a, b) => b.edgeAfterFeesPts - a.edgeAfterFeesPts);
  return { rows, skipped };
}

// ---------- cash-payout baskets (structural) ----------
/** Per-state cash payout of one leg sized to pay $1 if its side wins. */
function legPayout(q, state) {
  const side = q.market.side;
  if (q.price.kind === 'odds') {
    const stake = 1 / q.price.decimal;
    if (state === side) return [1, 1];
    if (state === 'tie') return q.rules?.tie === 'push' ? [stake, stake] : [0, 0];
    if (state === 'void') return q.rules?.cancellation === 'void' ? [stake, stake] : [0, stake];
    return [0, 0];
  }
  if (state === side) return [1, 1];
  if (state === 'tie') return typeof q.rules?.tie === 'number' ? [q.rules.tie, q.rules.tie] : [0, 1];
  if (state === 'void') return typeof q.rules?.cancellation === 'number' ? [q.rules.cancellation, q.rules.cancellation] : [0, 1];
  return [0, 0];
}
const legCost = (q) => (q.price.kind === 'odds' ? 1 / q.price.decimal : q.price.ask + (q.price.feePerShare || 0));

export function sportsBaskets(quotes, { buffer = 0.005, ties = ['nfl'] } = {}) {
  const usable = quotes.filter((q) => q.market.type === 'moneyline' && !q.threeWay && q.venueKind !== 'dfs' &&
    ((q.price.kind === 'odds' && q.price.decimal > 1) || (q.price.kind === 'exchange' && q.price.ask > 0)));
  const byContract = new Map();
  for (const q of usable) { const k = contractKey(q); if (!byContract.has(k)) byContract.set(k, []); byContract.get(k).push(q); }
  const out = [];
  for (const qs of byContract.values()) {
    const [A, B] = qs[0].participants;
    const best = (side) => qs.filter((q) => q.market.side === side).sort((x, y) => legCost(x) - legCost(y));
    for (const a of best(A).slice(0, 3)) for (const b of best(B).slice(0, 3)) {
      if (a.venue === b.venue) continue;
      // exchange-vs-exchange baskets are priced on real order books by the main arbitrage engine
      if (a.venueKind !== 'sportsbook' && b.venueKind !== 'sportsbook') continue;
      const states = [{ key: A, label: `${A.toUpperCase()} wins` }, { key: B, label: `${B.toUpperCase()} wins` },
        ...(ties.includes(a.league) ? [{ key: 'tie', label: 'Tie' }] : []), { key: 'void', label: 'Postponed / canceled', tail: true }];
      const table = states.map((s) => { const l = [legPayout(a, s.key), legPayout(b, s.key)]; return { ...s, legs: l, lo: l[0][0] + l[1][0], hi: l[0][1] + l[1][1] }; });
      const cost = legCost(a) + legCost(b);
      const minCore = Math.min(...table.filter((r) => !r.tail).map((r) => r.lo));
      const minAll = Math.min(...table.map((r) => r.lo));
      const m = matchQuotes(a, { ...b, market: { ...b.market, side: a.market.side } });
      const structural = isExecutableArbitrage(minCore, cost, 0, buffer);
      if (!structural && minCore - cost < -0.01) continue; // only show near-structural or better
      out.push({
        id: `basket:${contractKey(a)}:${a.venue}:${b.venue}`, kind: 'sports-basket', event: a.event, league: a.league,
        legs: [a, b].map((q) => ({ venue: q.venueName, kind: q.venueKind, side: q.market.side, label: q.label || q.market.side.toUpperCase(),
          price: q.price.kind === 'odds' ? { decimal: q.price.decimal, american: q.price.american } : { ask: q.price.ask, fee: q.price.feePerShare },
          stakeFor1: legCost(q), url: q.url, timestamp: q.timestamp })),
        states: table, costPer1: cost, minPayoutCore: minCore, minPayoutAll: minAll, net: minCore - cost - buffer,
        structural, strictIncludingVoid: isExecutableArbitrage(minAll, cost, 0, buffer),
        execution: 'unverified', match: m.status,
        why: [
          'Execution unverified: sportsbooks do not publish how much they will accept at this price.',
          ...(m.status !== STATUS.VERIFIED ? ['Settlement rules are not verified identical on both venues.'] : []),
          ...(!isExecutableArbitrage(minAll, cost, 0, buffer) ? ['A postponement/cancellation could pay less than the cost (rules differ).'] : []),
        ],
        guaranteed: false,
      });
    }
  }
  return out.sort((x, y) => y.net - x.net);
}
