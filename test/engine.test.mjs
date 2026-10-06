// Offline unit tests for the detection engine (no network). Run: npm test
import assert from 'node:assert/strict';
import { templatize, canonEntity } from '../src/engine/text.js';
import { runPipeline, buildContext } from '../src/engine/pipeline.js';
import { ladderDetector } from '../src/engine/detectors/ladder.js';
import { hierarchyDetector } from '../src/engine/detectors/hierarchy.js';
import { evaluate } from '../src/engine/rules.js';
import { explain, columns, liveEdge } from '../src/engine/explain.js';
import { normalizeEvent } from '../src/providers/polymarket.js';

let passed = 0;
const test = async (name, fn) => {
  try { await fn(); passed++; console.log('  ✓', name); }
  catch (err) { console.error('  ✗', name); throw err; }
};

let seq = 1;
const mk = (o) => ({
  id: String(seq++), provider: 'test', eventId: 'e1', question: 'Q', label: '', yesOutcome: 'Yes', noOutcome: 'No',
  isYesNo: true, price: 0.5, bid: 0.49, ask: 0.51, liquidity: 50000, volume: 1e5, volume24h: 1e4,
  endDate: '2026-12-31T12:00:00Z', acceptingOrders: true, isGame: false, category: 'Test', eventTitle: 'Event',
  descriptionHash: 'x', url: 'https://example.com', tokenId: null, ...o,
});
const ev = (id, title, markets, o = {}) => ({
  id, provider: 'test', title, url: '', category: 'Test', tags: [], exclusive: false, exhaustive: false, resolvedYes: 0,
  isGame: false, liquidity: 0, volume: 0, volume24h: 0, endDate: '2027-01-01T00:00:00Z', marketIds: markets.map((m) => m.id), ...o,
});
const q = (p, extra = {}) => ({ price: p, bid: +(p - 0.005).toFixed(4), ask: +(p + 0.005).toFixed(4), ...extra });

console.log('text');
await test('templatize keeps slot markers out of number parsing (regression)', () => {
  const t = templatize('Will the price of Bitcoin be above $90,000 on October 8?', Date.UTC(2026, 9, 8));
  assert.equal(t.template, 'will the price of bitcoin be above $⟨N⟩ on ⟨D⟩ ?');
  assert.equal(t.slots[0].value, 90000);
  assert.equal(t.slots[1].value, Date.UTC(2026, 9, 8));
});
await test('yearless dates use the year closest to the contract end date', () => {
  // ends 2027-01-01T04:59Z (= Dec 31 ET) -> "December 31" means 2026
  const t = templatize('Merger announced by December 31?', Date.parse('2027-01-01T04:59:00Z'));
  assert.equal(t.slots[0].value, Date.UTC(2026, 11, 31));
});
await test('entity canonicalization', () => {
  assert.equal(canonEntity('J.D. Vance'), canonEntity('JD Vance'));
  assert.equal(canonEntity('The Boston Celtics'), 'boston celtics');
});

console.log('ladder detector');
const ladderPairs = (markets) => {
  const ctx = buildContext({ events: [ev('e1', 'E', markets)], markets });
  return ladderDetector.detect(ctx).map((r) => [ctx.byId.get(r.a).question, ctx.byId.get(r.b).question]);
};
await test('"above" ladder: higher strike implies lower strike', () => {
  const r = ladderPairs([mk({ question: 'Will BTC be above $90,000 on October 8?' }), mk({ question: 'Will BTC be above $85,000 on October 8?' })]);
  assert.deepEqual(r, [['Will BTC be above $90,000 on October 8?', 'Will BTC be above $85,000 on October 8?']]);
});
await test('"dip to" ladder goes the other way', () => {
  const r = ladderPairs([mk({ question: 'Will ETH dip to $2,000 in October?' }), mk({ question: 'Will ETH dip to $2,500 in October?' })]);
  assert.deepEqual(r, [['Will ETH dip to $2,000 in October?', 'Will ETH dip to $2,500 in October?']]);
});
await test('deadline ladder: earlier deadline implies later one', () => {
  const r = ladderPairs([mk({ question: 'Kraken IPO by June 30, 2026?' }), mk({ question: 'Kraken IPO by December 31, 2026?' })]);
  assert.deepEqual(r, [['Kraken IPO by June 30, 2026?', 'Kraken IPO by December 31, 2026?']]);
});
await test('negated deadline flips ("not IPO by")', () => {
  const r = ladderPairs([mk({ question: 'Will OpenAI not IPO by December 31, 2026?' }), mk({ question: 'Will OpenAI not IPO by December 31, 2027?' })]);
  assert.deepEqual(r, [['Will OpenAI not IPO by December 31, 2027?', 'Will OpenAI not IPO by December 31, 2026?']]);
});
await test('"no longer under control by" is NOT treated as a negation', () => {
  const r = ladderPairs([mk({ question: 'Island no longer under control by October 31?' }), mk({ question: 'Island no longer under control by December 31?' })]);
  assert.deepEqual(r, [['Island no longer under control by October 31?', 'Island no longer under control by December 31?']]);
});
await test('spreads and Over/Under use the priced side', () => {
  const r1 = ladderPairs([mk({ question: 'Spread: Colts (-3.5)', isYesNo: false, yesOutcome: 'Colts', isGame: true }), mk({ question: 'Spread: Colts (-1.5)', isYesNo: false, yesOutcome: 'Colts', isGame: true })]);
  assert.deepEqual(r1, [['Spread: Colts (-3.5)', 'Spread: Colts (-1.5)']]);
  const r2 = ladderPairs([mk({ question: 'A vs. B: O/U 46.5', isYesNo: false, yesOutcome: 'Under', isGame: true }), mk({ question: 'A vs. B: O/U 49.5', isYesNo: false, yesOutcome: 'Under', isGame: true })]);
  assert.deepEqual(r2, [['A vs. B: O/U 46.5', 'A vs. B: O/U 49.5']]);
});
await test('ambiguous "hit 37%" is skipped; buckets and ranges are skipped', () => {
  assert.deepEqual(ladderPairs([mk({ question: "Will Trump's approval hit 37% in 2026?" }), mk({ question: "Will Trump's approval hit 20% in 2026?" })]), []);
  assert.deepEqual(ladderPairs([mk({ question: 'Will BTC be between $80,000 and $82,000?' }), mk({ question: 'Will BTC be between $82,000 and $84,000?' })]), []);
  assert.deepEqual(ladderPairs([mk({ question: 'Exact score: 1 - 0?' }), mk({ question: 'Exact score: 2 - 0?' })]), []);
});

console.log('hierarchy detector');
await test('NBA champion ⇒ conference champion ⇒ playoffs', () => {
  const c = mk({ eventId: 'c', question: 'Will the Boston Celtics win the 2027 NBA Finals?', label: 'Boston Celtics' });
  const f = mk({ eventId: 'f', question: 'Will the Boston Celtics be the 2027 NBA Eastern Conference Champion?', label: 'Boston Celtics' });
  const p = mk({ eventId: 'p', question: 'Will the Boston Celtics make the 2027 NBA Playoffs?', label: 'Boston Celtics' });
  const events = [ev('c', 'NBA: 2027 Champion', [c]), ev('f', 'NBA: 2027 Eastern Conference Champion', [f]), ev('p', 'NBA: Team to Make Playoffs', [p])];
  const ctx = buildContext({ events, markets: [c, f, p] });
  const rels = hierarchyDetector.detect(ctx).map((r) => r.a + '>' + r.b).sort();
  assert.deepEqual(rels, [`${c.id}>${f.id}`, `${c.id}>${p.id}`, `${f.id}>${p.id}`].sort());
});
await test('president ⇒ party nomination and ⇒ party wins; Dem/Rep nominee exclusive', () => {
  const w = mk({ eventId: 'w', question: 'Will JD Vance win the 2028 US Presidential Election?', label: 'JD Vance' });
  const n = mk({ eventId: 'n', question: 'Will J.D. Vance win the 2028 Republican presidential nomination?', label: 'J.D. Vance' });
  const pr = mk({ eventId: 'p', question: 'Will the Republicans win the 2028 US Presidential Election?', label: 'Republican' });
  const pd = mk({ eventId: 'p', question: 'Will the Democrats win the 2028 US Presidential Election?', label: 'Democratic' });
  const events = [ev('w', 'Presidential Election Winner 2028', [w]), ev('n', 'Republican Presidential Nominee 2028', [n]), ev('p', 'Which party wins 2028 US Presidential Election?', [pr, pd])];
  const ctx = buildContext({ events, markets: [w, n, pr, pd] });
  const rels = hierarchyDetector.detect(ctx);
  assert.ok(rels.some((r) => r.a === w.id && r.b === n.id && r.subtype === 'nomination'));
  assert.ok(rels.some((r) => r.a === w.id && r.b === pr.id && r.subtype === 'party'));
  assert.ok(!rels.some((r) => r.b === pd.id));
});

console.log('rules + pipeline');
await test('the README example: primary 65% vs presidency 72% is flagged', async () => {
  const prim = mk({ eventId: 'n', question: 'Will Candidate X win the 2028 Democratic presidential nomination?', label: 'Candidate X', ...q(0.65) });
  const pres = mk({ eventId: 'w', question: 'Will Candidate X win the 2028 US Presidential Election?', label: 'Candidate X', ...q(0.72) });
  const snap = { events: [ev('w', 'Presidential Election Winner 2028', [pres]), ev('n', 'Democratic Presidential Nominee 2028', [prim])], markets: [prim, pres] };
  const res = await runPipeline(snap);
  assert.equal(res.violations.length, 1);
  const v = res.violations[0];
  assert.equal(v.type, 'implication');
  assert.ok(Math.abs(v.magnitude - 0.07) < 1e-9);
  assert.ok(v.executable && Math.abs(v.edge - 0.06) < 1e-9); // bid 0.715 - ask 0.655
  const M = Object.fromEntries([prim, pres].map((m) => [m.id, m]));
  const flat = { ...v, a: v.a.id, b: v.b.id, legs: v.legs.map((m) => m.id) };
  assert.equal(columns(flat, M).left.m.id, prim.id); // necessary condition shown first
  assert.match(explain(flat, M).why, /must also resolve YES/);
  assert.ok(Math.abs(liveEdge(flat, { [pres.id]: { bid: 0.7, ask: 0.71 }, [prim.id]: { bid: 0.66, ask: 0.67 } }) - 0.03) < 1e-9);
});
await test('wide/one-sided quotes cannot create a violation on their own', () => {
  const A = mk({ price: 0.46, bid: null, ask: 0.92 }), B = mk({ price: 0.02, bid: 0.01, ask: 0.03 });
  const r = evaluate({ type: 'implication', a: A.id, b: B.id }, new Map([[A.id, A], [B.id, B]]));
  assert.ok(r.magnitude < 0, 'bid 0 for A is below ask 3% for B');
});
await test('exhaustive set over 100% is flagged with an all-NO trade', async () => {
  const legs = [0.5, 0.35, 0.25].map((p) => mk({ eventId: 'x', question: `Outcome ${p}?`, ...q(p) }));
  const res = await runPipeline({ events: [ev('x', 'Who wins?', legs, { exclusive: true, exhaustive: true })], markets: legs });
  const v = res.violations.find((x) => x.type === 'exhaustive');
  assert.ok(v && v.direction === 'over' && Math.abs(v.magnitude - 0.1) < 1e-9);
  assert.ok(v.executable && v.roi > 0);
});
await test('sets with an unquoted placeholder leg are skipped', async () => {
  const legs = [mk({ eventId: 'y', ...q(0.6) }), mk({ eventId: 'y', price: 0.5, bid: null, ask: null })];
  const res = await runPipeline({ events: [ev('y', 'Who?', legs, { exclusive: true, exhaustive: true })], markets: legs });
  assert.equal(res.violations.length, 0);
});
await test('identical questions in different events are equivalent', async () => {
  const a = mk({ eventId: 'a', question: 'Will MicroStrategy announce bankruptcy before 2027?', ...q(0.06) });
  const b = mk({ eventId: 'b', question: 'Will MicroStrategy announce bankruptcy before 2027?', ...q(0.03) });
  const res = await runPipeline({ events: [ev('a', 'A', [a]), ev('b', 'B', [b])], markets: [a, b] });
  assert.equal(res.violations[0].type, 'equivalent');
  assert.ok(Math.abs(res.violations[0].magnitude - 0.03) < 1e-9);
});

console.log('provider normalization');
await test('malformed markets are dropped, valid ones normalized', () => {
  const { event, markets } = normalizeEvent({
    id: 9, title: 'Test event', slug: 'test-event', negRisk: true, tags: [{ label: 'Crypto' }],
    markets: [
      { id: 1, question: 'Good?', outcomes: '["Yes","No"]', outcomePrices: '["0.4","0.6"]', bestBid: 0.39, bestAsk: 0.41, slug: 'good' },
      { id: 2, question: 'Broken?', outcomes: 'not json', outcomePrices: null },
      { id: 3, question: 'Closed', closed: true, outcomePrices: '["0","1"]' },
    ],
  });
  assert.equal(markets.length, 1);
  assert.equal(markets[0].price, 0.4);
  assert.equal(markets[0].url, 'https://polymarket.com/event/test-event/good');
  assert.equal(event.category, 'Crypto');
  assert.ok(event.exclusive && event.exhaustive);
});

console.log(`\n${passed} tests passed`);
