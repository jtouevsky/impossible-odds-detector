// Arbitrage + matching tests (offline). Run: npm test
import assert from 'node:assert/strict';
import { buildSpec } from '../src/spec/marketSpec.js';
import { compareSpecs, blockByEvent, equivalentPairs, STATUS } from '../src/spec/match.js';
import { runArbEngine, ladderKey } from '../src/arb/engine.js';
import { isExecutableArbitrage } from '../src/arb/payoff.js';
import { feeFor } from '../src/arb/fees.js';
import { runPipeline } from '../src/engine/pipeline.js';
import { ladderDetector } from '../src/engine/detectors/ladder.js';
import { buildContext } from '../src/engine/pipeline.js';
import { strikeConsistent } from '../src/providers/kalshi.js';

let passed = 0;
const test = async (name, fn) => {
  try { await fn(); passed++; console.log('  ✓', name); } catch (err) { console.error('  ✗', name); throw err; }
};

let seq = 1;
const pm = (o) => ({ id: 'p' + seq++, provider: 'polymarket', eventId: 'e', question: 'Q', label: '', yesOutcome: 'Yes', noOutcome: 'No', isYesNo: true,
  price: 0.5, bid: 0.49, ask: 0.51, liquidity: 1e4, volume: 1e5, endDate: '2026-10-10T16:00:00Z', acceptingOrders: true, isGame: false,
  category: 'Test', eventTitle: 'Event', rules: '', descriptionHash: 'h', url: 'u', tokenId: 't' + seq, noTokenId: 'n' + seq, feesEnabled: false, orderMinSize: 5, ...o });
const kx = (o) => ({ id: 'K' + seq++, provider: 'kalshi', eventId: 'KE', series: 'KXTEST', question: 'Q', label: '', yesOutcome: 'Yes', noOutcome: 'No', isYesNo: true,
  price: 0.5, bid: 0.49, ask: 0.51, noAsk: 0.51, askSize: 100, noAskSize: 100, liquidity: 1e4, volume: 1e5, endDate: '2026-10-10T16:00:00Z',
  acceptingOrders: true, isGame: false, category: 'Test', eventTitle: 'Event', rules: '', descriptionHash: 'k', url: 'u', feeMultiplier: 1, ...o });
const ev = (id, markets, o = {}) => ({ id, provider: markets[0].provider, title: markets[0].eventTitle, marketIds: markets.map((m) => m.id), exclusive: false, exhaustive: false, ...o });
const specOf = (m, e) => (m.spec = buildSpec(m, e || ev(m.eventId, [m]), [m]));

// NFL game, both venues (real rule wording)
const PM_NFL_RULES = 'In the upcoming NFL game, scheduled for October 4 at 9:30AM ET:\nIf Colts wins, the market will resolve to "Colts".\nIf the game is postponed, this market will remain open until the game has been completed.\nIf the game is canceled entirely or ends in a tie, with no make-up game, this market will resolve 50-50.';
const KX_NFL_RULES = 'If Indianapolis wins the IND Colts vs WAS Commanders Pro Football game originally scheduled for Oct 4, 2026, then the market resolves to Yes.\n\nIf the game ends in a tie, the market will resolve to $0.50 for each team. If the game is not started within 48 hours, the market will resolve to a fair price.';
function nflPair({ kxRules = KX_NFL_RULES } = {}) {
  const P = pm({ eventId: 'pe', eventTitle: 'Colts vs. Commanders', eventSlug: 'nfl-ind-was-2026-10-04', question: 'Colts vs. Commanders', isYesNo: false,
    yesOutcome: 'Colts', noOutcome: 'Commanders', sportsType: 'moneyline', gameStartTime: '2026-10-04 13:30:00+00', rules: PM_NFL_RULES });
  const K1 = kx({ id: 'KXNFLGAME-26OCT04INDWAS-IND', eventId: 'KXNFLGAME-26OCT04INDWAS', series: 'KXNFLGAME', question: 'Indianapolis wins', label: 'Indianapolis', rules: kxRules });
  const K2 = kx({ id: 'KXNFLGAME-26OCT04INDWAS-WAS', eventId: 'KXNFLGAME-26OCT04INDWAS', series: 'KXNFLGAME', question: 'Washington wins', label: 'Washington', rules: kxRules });
  const pe = ev('pe', [P], { slug: 'nfl-ind-was-2026-10-04', title: 'Colts vs. Commanders' });
  const ke = ev('KXNFLGAME-26OCT04INDWAS', [K1, K2]);
  P.spec = buildSpec(P, pe, [P]);
  K1.spec = buildSpec(K1, ke, [K1, K2]); K2.spec = buildSpec(K2, ke, [K1, K2]);
  return { P, K1, K2 };
}

/** Run the engine on a set of markets with explicit order books. books: { 'provider|id|side': [[p, s], ...] } */
async function arb(markets, books, { events = [], implications = [], cfg = {} } = {}) {
  const byId = new Map(markets.map((m) => [m.id, m]));
  const specs = markets.map((m) => m.spec).filter(Boolean);
  const groups = blockByEvent(specs);
  const io = {
    fetchLadders: async (positions) => new Map(positions.map((p) => {
      const lv = books[ladderKey(p)] || [];
      return [ladderKey(p), { asks: lv.map(([pp, s]) => ({ p: pp, s })), bids: [], timestamp: new Date().toISOString() }];
    })),
  };
  return runArbEngine({ byId, events, groups, pairs: equivalentPairs(groups), implications }, io, { includeTailStates: false, ...cfg });
}

console.log('matching (MarketSpec)');
await test('same wording + different week => NOT equivalent (earthquake bug)', async () => {
  const q = 'Will there be a 7.0+ magnitude earthquake?';
  const a = pm({ eventId: 'w1', eventTitle: 'Earthquake this week?', question: q, endDate: '2026-10-04T23:59:00Z', rules: 'Resolves Yes if a 7.0+ earthquake occurs between September 28 and October 4, 2026 per USGS.', descriptionHash: 'w1' });
  const b = pm({ eventId: 'w2', eventTitle: 'Earthquake this week?', question: q, endDate: '2026-10-11T23:59:00Z', rules: 'Resolves Yes if a 7.0+ earthquake occurs between October 5 and October 11, 2026 per USGS.', descriptionHash: 'w2' });
  const sa = specOf(a), sb = specOf(b);
  assert.equal(sa.eventKey, sb.eventKey, 'same wording lands in the same candidate block');
  const c = compareSpecs(sa, sb);
  assert.equal(c.status, STATUS.MISMATCH);
  assert.ok(c.checks.some((x) => x.field === 'Resolution window end' && x.result === 'fail'));
  assert.ok(c.checks.some((x) => x.field === 'Dates in rules' && x.result === 'fail'));
  // and the research feed must not call them equivalent either
  const pairs = equivalentPairs(blockByEvent([sa, sb]));
  const res = await runPipeline({ events: [ev('w1', [a]), ev('w2', [b])], markets: [{ ...a, price: 0.2, bid: 0.19, ask: 0.21 }, { ...b, price: 0.6, bid: 0.59, ask: 0.61 }] }, { specPairs: pairs });
  assert.equal(res.violations.filter((v) => v.type === 'equivalent').length, 0);
  // nor the arbitrage engine
  const r = await arb([a, b], {});
  assert.equal(r.opportunities.length, 0);
});

await test('same event + different threshold => implication candidate, NOT equivalent', () => {
  const a = pm({ eventId: 'btc', question: 'Will the price of Bitcoin be above $90,000 on October 8?' });
  const b = pm({ eventId: 'btc', question: 'Will the price of Bitcoin be above $85,000 on October 8?' });
  const e = ev('btc', [a, b]);
  const sa = buildSpec(a, e, [a, b]), sb = buildSpec(b, e, [a, b]);
  assert.notEqual(sa.eventKey, sb.eventKey);
  assert.equal(equivalentPairs(blockByEvent([sa, sb])).length, 0);
  const rels = ladderDetector.detect(buildContext({ events: [e], markets: [a, b] }));
  assert.deepEqual(rels.map((r) => [r.a, r.b]), [[a.id, b.id]]);
});

await test('same event/date/outcome across Polymarket and Kalshi => VERIFIED equivalence candidate', () => {
  const { P, K1 } = nflPair();
  assert.equal(P.spec.eventKey, 'game|nfl|2026-10-04|ind-was');
  assert.equal(P.spec.eventKey, K1.spec.eventKey);
  assert.equal(P.spec.outcomeKey, 'ind');
  const pairs = equivalentPairs(blockByEvent([P.spec, K1.spec]));
  assert.equal(pairs.length, 1);
  assert.equal(pairs[0].status, STATUS.VERIFIED);
});

await test('settlement-rule mismatch => NOT verified', () => {
  const { P, K1 } = nflPair({ kxRules: 'If Indianapolis wins the game originally scheduled for Oct 4, 2026, then the market resolves to Yes.' });
  assert.equal(compareSpecs(P.spec, K1.spec).status, STATUS.LIKELY, 'tie handling unstated on one side');
  const a = pm({ eventId: 'x1', eventTitle: 'Rain', question: 'Will it rain in New York on October 5?', rules: 'Per NOAA.' });
  const b = pm({ eventId: 'x2', eventTitle: 'Rain', question: 'Will it rain in New York on October 5?', rules: 'Per NOAA Central Park station.', descriptionHash: 'other' });
  b.geo = ['boston'];
  const sa = specOf(a), sb = specOf(b);
  assert.notEqual(compareSpecs(sa, sb).status, STATUS.VERIFIED, 'different rule text is never VERIFIED');
  const c = { ...sb, geo: ['boston'] };
  assert.equal(compareSpecs(sa, c).status, STATUS.MISMATCH, 'different geography');
});

await test('Kalshi strike metadata is only trusted when the wording agrees ("exactly 5" tagged as less)', () => {
  assert.equal(strikeConsistent({ strikeType: 'less', floor: 5, cap: 5, question: 'Will exactly 5 Starship launches reach space?', label: '5' }), false);
  assert.equal(strikeConsistent({ strikeType: 'greater', floor: 74099.99, cap: null, question: 'Bitcoin price on Oct 2?', label: '$74,100 or above' }), true);
});

console.log('arbitrage engine (central rule)');
await test('price difference on last trades but no executable spread => NOT arbitrage', async () => {
  const { P, K1 } = nflPair();
  P.price = 0.40; P.lastTrade = 0.40; P.bid = 0.58; P.ask = 0.62;       // last trade says 40%, book says 58/62
  K1.price = 0.60; K1.lastTrade = 0.60; K1.bid = 0.57; K1.ask = 0.61; K1.noAsk = 0.43;
  const r = await arb([P, K1], {
    ['polymarket|' + P.id + '|yes']: [[0.62, 500]], ['polymarket|' + P.id + '|no']: [[0.42, 500]],
    ['kalshi|' + K1.id + '|yes']: [[0.61, 500]], ['kalshi|' + K1.id + '|no']: [[0.43, 500]],
  });
  assert.equal(r.opportunities.length, 0);
});

await test('positive spread before fees but negative after fees => NOT arbitrage', async () => {
  const { P, K1 } = nflPair();
  P.feesEnabled = true; P.feeRate = 0.07; P.bid = 0.48; P.ask = 0.49;   // YES ask 49¢
  K1.bid = 0.50; K1.ask = 0.51; K1.noAsk = 0.495;                       // NO ask 49.5¢ -> gross 1.5¢
  const books = { ['polymarket|' + P.id + '|yes']: [[0.49, 1000]], ['kalshi|' + K1.id + '|no']: [[0.495, 1000]] };
  assert.ok(1 - (0.49 + 0.495) > 0, 'gross edge is positive');
  const r = await arb([P, K1], books);
  assert.equal(r.opportunities.length, 0);
  assert.equal(isExecutableArbitrage(1, 0.985, feeFor(P, 0.49, 1) + 0.07 * 0.495 * 0.505, 0.005), false);
});

await test('positive minimum payoff after all costs => arbitrage (with sizes walked from the books)', async () => {
  const { P, K1 } = nflPair();
  P.bid = 0.42; P.ask = 0.43;                    // Polymarket YES Colts @ 43¢ (fees disabled on this market)
  K1.bid = 0.48; K1.ask = 0.49; K1.noAsk = 0.52; // Kalshi NO Indianapolis @ 52¢
  const books = {
    ['polymarket|' + P.id + '|yes']: [[0.43, 200], [0.45, 300], [0.50, 1000]],
    ['kalshi|' + K1.id + '|no']: [[0.52, 150], [0.53, 400]],
  };
  const r = await arb([P, K1], books);
  const o = r.opportunities.find((x) => x.strategy === 'cross-platform');
  assert.ok(o, 'found');
  assert.equal(o.matchStatus, STATUS.VERIFIED);
  assert.ok(o.isExecutable);
  assert.deepEqual(o.legs.map((l) => [l.venue, l.side, l.ask]), [['Polymarket', 'yes', 0.43], ['Kalshi', 'no', 0.52]]);
  assert.ok(Math.abs(o.unit.cost - 0.95) < 1e-9 && Math.abs(o.unit.gross - 0.05) < 1e-9);
  assert.ok(o.unit.net > 0 && o.unit.net < 0.05, 'fees + buffer deducted');
  // depth: 150 @ (43+52), then 50 @ (43+53), then 300 @ (45+53) -> marginal cost 0.98 + fees > 1 - buffer -> stops at 200
  assert.equal(o.maxQty, 200);
  assert.ok(o.states.filter((s) => !s.tail).every((s) => s.lo >= 1), 'every normal state pays >= $1 (tie pays 0.5 + 0.5)');
  assert.ok(o.sizes.every((s) => s.net > 0));
});

await test('cancellation tail state with an unknown "fair price" blocks the strict feed (shown as near-arb)', async () => {
  const { P, K1 } = nflPair();
  P.ask = 0.43; P.bid = 0.42; K1.noAsk = 0.52;
  const books = { ['polymarket|' + P.id + '|yes']: [[0.43, 100]], ['kalshi|' + K1.id + '|no']: [[0.52, 100]] };
  const r = await arb([P, K1], books, { cfg: { includeTailStates: true } });
  const o = r.opportunities.find((x) => x.strategy === 'cross-platform');
  assert.ok(o && !o.isExecutable && o.nearArb);
});

await test('implication: NO on the narrower + YES on the broader pays >= $1 in every possible state', async () => {
  const A = pm({ eventId: 'L', question: 'Will BTC be above $90,000 on October 8?', bid: 0.30, ask: 0.31 }); // narrower
  const B = pm({ eventId: 'L', question: 'Will BTC be above $85,000 on October 8?', bid: 0.20, ask: 0.21 }); // broader, mispriced
  const books = { ['polymarket|' + A.id + '|no']: [[0.70, 50]], ['polymarket|' + B.id + '|yes']: [[0.21, 80]] };
  const r = await arb([A, B], books, { implications: [{ type: 'implication', a: A.id, b: B.id, detector: 'ladder', rationale: 'ladder' }] });
  const o = r.opportunities[0];
  assert.equal(o.strategy, 'implication');
  assert.deepEqual(o.states.map((s) => s.lo), [1, 1, 2, 1, 1]); // below 85k, =85k, between, =90k, above 90k
  assert.equal(o.maxQty, 50);
  assert.ok(o.isExecutable);
});

await test('zero opportunities when nothing qualifies (no fabrication)', async () => {
  const r = await arb([pm({}), kx({})], {});
  assert.equal(r.opportunities.length, 0);
});

console.log(`\n${passed} arbitrage tests passed`);
