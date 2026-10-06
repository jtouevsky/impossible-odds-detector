// v3 tests: nested-threshold direction, dead zones, staleness, providers, venue pairs, cross-venue rule mismatch.
import assert from 'node:assert/strict';
import { nestedBaskets } from '../src/arb/statespace.js';
import { runArbEngine, ladderKey } from '../src/arb/engine.js';
import { buildSpec, personKey } from '../src/spec/marketSpec.js';
import { compareSpecs, blockByEvent, equivalentPairs, STATUS } from '../src/spec/match.js';
import { normalizePredictItMarket } from '../src/providers/predictit.js';
import { normalizeLimitlessMarket } from '../src/providers/limitless.js';
import { providers, PLANNED } from '../src/providers/index.js';
import { pairMatrix } from '../src/scan.js';
import { explainOpportunity, GLOSSARY } from '../public/explain-engine.js';

let passed = 0;
const test = async (name, fn) => { try { await fn(); passed++; console.log('  ✓', name); } catch (e) { console.error('  ✗', name); throw e; } };
let seq = 1;
const pm = (o) => ({ id: 'v' + seq++, provider: 'polymarket', eventId: 'rev', eventTitle: "Revolut's valuation", question: 'Q', label: '', yesOutcome: 'Yes', noOutcome: 'No',
  isYesNo: true, price: 0.5, bid: 0.49, ask: 0.51, liquidity: 1e4, endDate: '2026-12-31T12:00:00Z', acceptingOrders: true, rules: '', url: 'u',
  tokenId: 't' + seq, noTokenId: 'n' + seq, feesEnabled: false, orderMinSize: 5, ...o });

console.log('nested thresholds (state space)');
await test('Revolut ↑: B=$75B implies A=$70B -> YES(A)+NO(B) is safe, NO(A)+YES(B) has a dead zone', () => {
  const A = pm({ question: "Will Revolut's valuation hit (HIGH) $70B by December 31?" });
  const B = pm({ question: "Will Revolut's valuation hit (HIGH) $75B by December 31?" });
  const nb = nestedBaskets(A, B);
  assert.ok(nb, 'parsed');
  assert.deepEqual(nb.conditions.map((c) => [c.op, c.t]), [['ge', 70e9], ['ge', 75e9]]);
  const good = nb.baskets.find((b) => b.legs[0].side === 'yes' && b.legs[1].side === 'no');
  const bad = nb.baskets.find((b) => b.legs[0].side === 'no' && b.legs[1].side === 'yes');
  assert.equal(good.minPayoff, 1);
  assert.deepEqual(good.deadZones, []);
  assert.equal(bad.minPayoff, 0);
  assert.ok(bad.deadZones.some((z) => /between \$70B and \$75B/.test(z)), bad.deadZones.join('|'));
});

await test('"no-hitters" is not a negation: 5+ no-hitters ⇒ 2+ no-hitters, so only YES(2+) + NO(5+) is safe', () => {
  const A = pm({ question: 'Will there be 2+ no-hitters thrown during the 2026 MLB season?', label: '2+', eventTitle: 'MLB: Number of no-hitters thrown in 2026' });
  const B = pm({ question: 'Will there be 5+ no-hitters thrown during the 2026 MLB season?', label: '5+', eventTitle: 'MLB: Number of no-hitters thrown in 2026' });
  const nb = nestedBaskets(A, B);
  assert.ok(nb, 'parsed');
  assert.deepEqual(nb.conditions.map((c) => [c.op, c.t, c.negated]), [['ge', 2, false], ['ge', 5, false]]);
  const safe = nb.baskets.find((b) => b.legs[0].side === 'yes' && b.legs[1].side === 'no');
  const bad = nb.baskets.find((b) => b.legs[0].side === 'no' && b.legs[1].side === 'yes');
  assert.equal(safe.minPayoff, 1);
  assert.equal(bad.minPayoff, 0, 'NO(2+) + YES(5+) loses everything between 2 and 5');
});

await test('label cross-check: a question parse that contradicts its "N+" label yields no structure', () => {
  const A = pm({ question: 'Will there not be 2 no-hitters thrown during the 2026 MLB season?', label: '2+' });
  const B = pm({ question: 'Will there not be 5 no-hitters thrown during the 2026 MLB season?', label: '5+' });
  assert.equal(nestedBaskets(A, B), null);
});

await test('Revolut ↓ (LOW): direction flips -> NO(70)+YES(75) is the safe basket', () => {
  const A = pm({ question: "Will Revolut's valuation hit (LOW) $70B by December 31?" });
  const B = pm({ question: "Will Revolut's valuation hit (LOW) $75B by December 31?" });
  const nb = nestedBaskets(A, B);
  assert.deepEqual(nb.conditions.map((c) => c.op), ['le', 'le']);
  assert.equal(nb.baskets.find((b) => b.legs[0].side === 'no').minPayoff, 1);
  assert.equal(nb.baskets.find((b) => b.legs[0].side === 'yes').minPayoff, 0);
});

await test('engine never emits a dead-zone basket, even if the detector got the direction backwards', async () => {
  const A = pm({ question: "Will Revolut's valuation hit (HIGH) $70B by December 31?", bid: 0.30, ask: 0.31 });
  const B = pm({ question: "Will Revolut's valuation hit (HIGH) $75B by December 31?", bid: 0.45, ask: 0.46 }); // mispriced: harder one dearer
  const books = { [`polymarket|${A.id}|yes`]: [[0.31, 100]], [`polymarket|${B.id}|no`]: [[0.55, 100]], [`polymarket|${A.id}|no`]: [[0.70, 100]], [`polymarket|${B.id}|yes`]: [[0.46, 100]] };
  // detector claims A ⇒ B (wrong way round)
  const r = await run([A, B], books, { implications: [{ type: 'implication', a: A.id, b: B.id, detector: 'ladder', rationale: 'x' }] });
  assert.equal(r.opportunities.length, 1);
  const o = r.opportunities[0];
  assert.deepEqual(o.legs.map((l) => [l.marketId, l.side]), [[A.id, 'yes'], [B.id, 'no']]);
  assert.ok(o.states.every((s) => s.lo >= 1));
  assert.ok(r.stats.rejected.deadZone >= 1);
});

await test('same strike, different deadline (Kalshi metadata trap) is a date ladder, never "YES+NO of one contract"', () => {
  const k = (o) => ({ ...pm({}), provider: 'kalshi', eventId: 'KXYT', series: 'KXYT', question: 'When will IShowSpeed reach 100 million Youtube subscribers?', strikeType: 'greater_or_equal', floor: 1e8, cap: null, rules: 'If @IShowSpeed has at least 100,000,000 subscribers', ...o });
  const A = k({ id: 'KXYT-27', label: 'Before 2027', endDate: '2027-01-01T00:00:00Z' });
  const B = k({ id: 'KXYT-29', label: 'Before 2029', endDate: '2029-01-01T00:00:00Z' });
  const nb = nestedBaskets(A, B);
  assert.equal(nb.conditions[0].kind, 'D');
  assert.notEqual(nb.conditions[0].t, nb.conditions[1].t);
  assert.equal(nb.baskets.find((b) => b.legs[0].side === 'yes').minPayoff, 0, 'YES(by 2027)+NO(by 2029) has a dead zone');
});

await test('buckets inside a mutually-exclusive event are never treated as a nested ladder', () => {
  const A = pm({ question: 'Will inflation be above 3% in 2026?', inExclusiveEvent: true });
  const B = pm({ question: 'Will inflation be above 4% in 2026?', inExclusiveEvent: true });
  assert.equal(nestedBaskets(A, B), null);
});

console.log('execution reality');
await test('stale quotes => not guaranteed (near-arb with a "stale" reason)', async () => {
  const A = pm({ question: 'Will BTC be above $90,000 on October 8?', bid: 0.30, ask: 0.31 });
  const B = pm({ question: 'Will BTC be above $85,000 on October 8?', bid: 0.20, ask: 0.21 });
  const books = { [`polymarket|${A.id}|no`]: [[0.70, 50]], [`polymarket|${B.id}|yes`]: [[0.21, 80]] };
  const old = new Date(Date.now() - 10 * 60e3).toISOString();
  const r = await run([A, B], books, { implications: [{ type: 'implication', a: A.id, b: B.id, detector: 'ladder', rationale: 'x' }], ts: old });
  const o = r.opportunities[0];
  assert.equal(o.bucket, 'near');
  assert.ok(o.reasons.some((x) => x.code === 'stale'));
  const fresh = await run([A, B], books, { implications: [{ type: 'implication', a: A.id, b: B.id, detector: 'ladder', rationale: 'x' }] });
  assert.equal(fresh.opportunities[0].bucket, 'guaranteed');
});

await test('venue without order sizes (PredictIt) can never be guaranteed', async () => {
  const pi = normalizePredictItMarket({ id: 1, name: 'Which party will win the 2028 US presidential election?', url: 'u', contracts: [
    { id: 11, name: 'Democratic', status: 'Open', bestBuyYesCost: 0.40, bestBuyNoCost: 0.55, bestSellYesCost: 0.38, lastTradePrice: 0.40, dateEnd: 'NA' },
    { id: 12, name: 'Republican', status: 'Open', bestBuyYesCost: 0.45, bestBuyNoCost: 0.58, bestSellYesCost: 0.42, lastTradePrice: 0.45, dateEnd: 'NA' }] });
  const [D] = pi.markets;
  const P = pm({ eventId: 'pp', eventTitle: 'Which party wins 2028 US Presidential Election?', question: 'Will the Democrats win the 2028 US Presidential Election?', label: 'Democratic', bid: 0.50, ask: 0.51 });
  const ev = [{ ...pi.event }, { id: 'pp', provider: 'polymarket', title: P.eventTitle, marketIds: [P.id] }];
  D.spec = buildSpec(D, pi.event, pi.markets); P.spec = buildSpec(P, ev[1], [P]);
  assert.equal(D.spec.eventKey, P.spec.eventKey);
  const books = { [`predictit|${D.id}|yes`]: [[0.40, null]], [`polymarket|${P.id}|no`]: [[0.49, 100]] };
  const r = await run([D, P], books, { noDepth: [D.id] });
  assert.ok(r.opportunities.length >= 1);
  assert.ok(r.opportunities.every((o) => o.bucket !== 'guaranteed'));
  assert.ok(r.opportunities[0].reasons.some((x) => x.code === 'depth' || x.code === 'match'));
});

console.log('matching & providers');
await test('cross-venue race-by-party rule differences => LIKELY, never VERIFIED', () => {
  const P = pm({ eventId: 'tx', eventTitle: 'Texas Senate Election Winner', question: 'Will the Democrats win the Texas Senate race in 2026?', label: 'James Talarico (D)' });
  const K = { ...pm({}), provider: 'kalshi', id: 'SENATETX-26-D', eventId: 'SENATETX-26', series: 'SENATETX', question: 'Texas Senate winner?', label: 'Democratic party' };
  const a = buildSpec(P, { title: P.eventTitle }, [P]), b = buildSpec(K, { title: 'Texas Senate winner?' }, [K]);
  assert.equal(a.eventKey, 'race|senate|tx|2026');
  assert.equal(a.eventKey, b.eventKey);
  assert.equal(compareSpecs(a, b).status, STATUS.LIKELY);
});

await test('"Donald Trump Jr." never matches "Donald J. Trump"', () => {
  assert.notEqual(personKey('Donald Trump Jr.'), personKey('Donald J. Trump'));
  assert.equal(personKey('A. Ocasio-Cortez'), personKey('Alexandria Ocasio-Cortez'));
});

await test('provider registry: capability matrix is honest', () => {
  for (const id of ['polymarket', 'kalshi']) {
    const c = providers[id].capabilities;
    assert.equal(c.status, 'live'); assert.ok(c.orderBook && c.depth && c.realMoney && c.arb);
  }
  assert.equal(providers.predictit.capabilities.depth, false, 'PredictIt publishes no sizes');
  assert.equal(providers.manifold.capabilities.arb, false, 'play money is never arbitrage');
  assert.ok(PLANNED.every((p) => p.status === 'planned'));
  const lm = normalizeLimitlessMarket({ id: 5, tradeType: 'clob', title: 'BTC Up or Down Hourly', slug: 's', tokens: { yes: 'a', no: 'b' }, prices: [41.8, 58.2],
    tradePrices: { buy: { market: [0.42, 0.6] }, sell: { market: [0.4, 0.58] } }, expirationTimestamp: Date.now() + 3600e3, categories: ['Crypto'] });
  assert.equal(lm.ask, 0.42); assert.equal(lm.noAsk, 0.6); assert.equal(lm.bid, 0.4);
});

await test('venue-pair report counts matches and opportunities per pair', () => {
  const s = (provider, outcomeKey = 'x') => ({ provider, outcomeKey });
  const pairs = [{ a: s('polymarket'), b: s('kalshi'), status: 'VERIFIED' }, { a: s('polymarket'), b: s('kalshi'), status: 'MISMATCH' }, { a: s('kalshi'), b: s('kalshi'), status: 'LIKELY' }];
  const arb = { stats: { structuresByPair: { 'kalshi↔polymarket': 4 } }, opportunities: [{ venuePair: 'kalshi↔polymarket', bucket: 'near' }] };
  const m = pairMatrix(pairs, arb);
  const x = m.find((r) => r.pair === 'kalshi↔polymarket');
  assert.deepEqual([x.verified, x.mismatch, x.structures, x.near, x.guaranteed], [1, 1, 4, 1, 0]);
  assert.equal(m.find((r) => r.pair === 'kalshi only').likely, 1);
});

console.log('explanations');
await test('beginner explanation covers trades, scenarios, guarantee and risks; risks are listed', async () => {
  const A = pm({ question: "Will Revolut's valuation hit (HIGH) $70B by December 31?", bid: 0.30, ask: 0.31 });
  const B = pm({ question: "Will Revolut's valuation hit (HIGH) $75B by December 31?", bid: 0.45, ask: 0.46 });
  const books = { [`polymarket|${A.id}|yes`]: [[0.31, 100]], [`polymarket|${B.id}|no`]: [[0.55, 100]] };
  const r = await run([A, B], books, { implications: [{ type: 'implication', a: B.id, b: A.id, detector: 'ladder', rationale: 'x' }] });
  const ex = explainOpportunity(r.opportunities[0]);
  for (const k of ['summary', 'contracts', 'trades', 'why', 'scenarios', 'guarantee', 'risks', 'bucketWhy']) assert.ok(ex[k] && ex[k].length, k);
  assert.match(ex.guarantee, /guaranteed/i);
  assert.ok(ex.scenarios.length >= 3);
  assert.ok(ex.trades.some((t) => /BUY YES/.test(t)));
  for (const k of ['implication', 'exhaustive', 'exclusive', 'equivalence', 'executable size', 'net ROI', 'slippage', 'verified match', 'guaranteed payout']) assert.ok(GLOSSARY[k], k);
});

console.log(`\n${passed} v3 tests passed`);

// ---------- helper ----------
async function run(markets, books, { implications = [], ts, noDepth = [] } = {}) {
  const byId = new Map(markets.map((m) => [m.id, m]));
  const specs = markets.map((m) => m.spec).filter(Boolean);
  const groups = blockByEvent(specs);
  const io = { fetchLadders: async (positions) => new Map(positions.map((p) => {
    const lv = books[ladderKey(p)] || [];
    return [ladderKey(p), { asks: lv.map(([pp, s]) => ({ p: pp, s })), bids: [], timestamp: ts || new Date().toISOString(), noDepth: noDepth.includes(p.market.id) }];
  })) };
  return runArbEngine({ byId, events: [], groups, pairs: equivalentPairs(groups), implications }, io, { includeTailStates: true });
}
