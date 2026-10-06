// In-app analyst: grounded answers, bucket separation, engine fallback. Run: node test/chat.test.mjs
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { buildContext, answerLocally, buildPrompt, systemPrompt, tradeInstructions } from '../public/chat-analyst.js';

let passed = 0;
const test = async (name, fn) => { try { await fn(); passed++; console.log('  ✓', name); } catch (e) { console.error('  ✗', name); throw e; } };

const leg = (o) => ({ venue: 'Polymarket', provider: 'polymarket', side: 'yes', question: 'Q', label: '', eventTitle: 'Ev', ask: 0.5, askSize: 300, qty: 200, fee: 0.4, depth: [{ p: 0.5, s: 300 }], url: 'https://x', rules: 'Rules text', endDate: '2026-12-31T00:00:00Z', ...o });
const opp = (o = {}) => ({
  id: 'o1', title: 'Colts vs Commanders', bucket: 'guaranteed', kind: 'equivalent', strategy: 'cross-platform', matchStatus: 'VERIFIED', rationale: 'Same game.',
  checks: [{ field: 'Event date', a: '2026-10-04', b: '2026-10-04', result: 'ok' }], venues: ['Polymarket', 'Kalshi'], venuePair: 'kalshi↔polymarket',
  legs: [leg({ side: 'yes', ask: 0.43, label: 'Colts' }), leg({ venue: 'Kalshi', provider: 'kalshi', side: 'no', ask: 0.52, label: 'Colts', fee: 1.2 })],
  states: [{ key: 'a', label: 'Colts win', legs: [[1, 1], [0, 0]], lo: 1, hi: 1 }, { key: 'b', label: 'Commanders win', legs: [[0, 0], [1, 1]], lo: 1, hi: 1 }],
  unit: { cost: 0.95, minPayoff: 1, gross: 0.05, fees: 0.008, buffer: 0.005, net: 0.037, roi: 0.039 },
  maxQty: 200, capital: 190, netProfit: 7.4, roi: 0.039, sizes: [{ qty: 200, cost: 190, payout: 200, fees: 1.6, buffer: 1, net: 7.4, roi: 0.039 }],
  edgeStop: { reason: 'book-empty' }, reasons: [], confidence: 0.95, quoteTime: '2026-10-02T12:00:00Z', fresh: true, ...o,
});
const data = (ops) => ({ opportunities: ops, perVenue: { polymarket: { name: 'Polymarket', status: 'live' }, kalshi: { name: 'Kalshi', status: 'live' } }, config: { bufferPerShare: 0.005, maxQuoteAgeMs: 120000 }, stats: { structures: 10, rejected: { deadZone: 3 } } });
const filters = { q: '', type: 'all', roi: 0, profit: 0, liq: 0, verified: false, pair: '' };
const ctxFor = (o, ops = [o]) => buildContext({ view: 'arb', mode: 'simple', filters, data: data(ops.filter(Boolean)), visible: ops.filter(Boolean), opportunity: o, research: { count: 7 } });

await test('context carries exact contracts, prices, fees, payoff table, rules, match and bucket', () => {
  const c = ctxFor(opp());
  assert.equal(c.opportunity.legs[0].askPrice, 0.43);
  assert.equal(c.opportunity.legs[1].venue, 'Kalshi');
  assert.equal(c.opportunity.legs[1].feePerShare, 1.2 / 200);
  assert.equal(c.opportunity.payoffByOutcome.length, 2);
  assert.equal(c.opportunity.matchConfidence, 'VERIFIED');
  assert.match(c.opportunity.classification, /Guaranteed/);
  assert.equal(c.opportunity.legs[0].rules, 'Rules text');
  assert.equal(c.board.guaranteedCount, 1);
  assert.equal(c.filters.minNetRoiPct, 0);
});

await test('"How would I make money" gives concrete buy steps with the real numbers', () => {
  const a = answerLocally('How exactly would I make money here?', ctxFor(opp()));
  assert.match(a, /Buy YES on Polymarket — "Colts".* at 43¢/);
  assert.match(a, /Buy NO on Kalshi — "Colts".* at 52¢/);
  assert.match(a, /total cost 95¢, guaranteed payout \$1\.00/);
  assert.match(a, /estimated net profit \$7\.40/);
});

await test('near-arb is never presented as guaranteed', () => {
  const n = opp({ bucket: 'near', matchStatus: 'LIKELY', reasons: [{ code: 'match', text: 'Not a verified match: rules may differ.' }] });
  const c = ctxFor(n);
  for (const q of ['How exactly would I make money here?', 'Explain this opportunity simply', "Why isn't this opportunity guaranteed?", 'Why is this considered arbitrage?']) {
    const a = answerLocally(q, c);
    assert.doesNotMatch(a, /guaranteed payout/i, q);
    assert.match(a, /not guaranteed|near-arb/i, q);
  }
  assert.match(answerLocally('What could make this fail?', c), /LIKELY/);
});

await test('every default prompt gets a trade-specific answer (no generic glossary hijack)', () => {
  const c = ctxFor(opp());
  assert.match(answerLocally('Explain this opportunity simply', c), /Colts vs Commanders/);
  assert.match(answerLocally("Explain this like I'm new to prediction markets", c), /\$1 if it wins/);
  assert.match(answerLocally('What does executable size mean?', c), /200 baskets/);
  assert.match(answerLocally('Why is this considered arbitrage?', c), /every\*\* outcome/);
  assert.match(answerLocally('What could make this fail?', c), /slippage/);
});

await test('board answers never invent a trade when nothing qualifies', () => {
  const a = answerLocally('What are the best opportunities right now?', ctxFor(null, []));
  assert.match(a, /0 guaranteed/);
  assert.match(a, /won't invent/);
});

await test('research anomalies are explained as research, not trades', () => {
  const c = ctxFor(null, []);
  c.research = { title: 'Two listings priced 60% and 50%', relationship: 'Equivalent', why: 'Same event.', size: 'Conservative violation: 10 pts.', violationPts: 0.1, confidence: 0.8, tradableAtTopOfBook: true, markets: [] };
  assert.match(answerLocally('Is this a trade I can make money on?', c), /research anomaly, not a trade/);
});

await test('dollar amounts are sized from the context, capped by executable size', () => {
  const a = answerLocally('If I put $5000 in?', ctxFor(opp()));
  assert.match(a, /200 baskets/);
  assert.match(a, /capped/);
});

await test('LLM prompt embeds the context, pre-computed steps and the no-invention rules', () => {
  const c = ctxFor(opp());
  const p = buildPrompt([{ role: 'user', content: 'How do I make money?' }], c);
  assert.ok(p.includes('"askPrice":0.43'));
  assert.ok(p.includes(tradeInstructions(c.opportunity).lines[0]));
  assert.match(systemPrompt(), /Never invent/);
  assert.match(systemPrompt(), /Near-arb/);
});

await test('engine falls back to the built-in analyst when Claude Code fails', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'iod-'));
  const fake = path.join(dir, 'claude');
  fs.writeFileSync(fake, '#!/bin/sh\necho "Invalid API key · Please run /login" 1>&2\nexit 1\n', { mode: 0o755 });
  process.env.CLAUDE_BIN = fake;
  const { chat, engineStatus } = await import('../src/chat.js?fallback');
  assert.equal((await engineStatus(true)).active, 'claude');
  const r = await chat([{ role: 'user', content: 'How exactly would I make money here?' }], ctxFor(opp()));
  assert.equal(r.engine, 'local');
  assert.match(r.notice, /not logged in/);
  assert.match(r.text, /Buy YES on Polymarket/);
  assert.equal((await engineStatus()).active, 'local');
});

await test('crowd comparison context: estimate, not arbitrage; terms explained', () => {
  const row = { id: 'x', league: 'nfl', marketType: 'moneyline', period: 'game', line: null, side: 'ind', event: { title: 'Colts vs Commanders' },
    target: { venue: 'polymarket-us', venueName: 'Polymarket US', kind: 'prediction', buyPrice: 0.52, ask: 0.52, feePerShare: 0.017, allInPrice: 0.537, rules: { overtime: 'included', tie: 0.5 } },
    consensus: { probability: 0.59, method: 'freshness-weighted mean', books: [{ name: 'DraftKings', decimal: 1.65, implied: 0.606, fair: 0.59, margin: 0.045, weight: 1, ageMs: 60e3 }], excluded: [] },
    disagreementPts: 7, edgeAfterFeesPts: 5.3, match: { status: 'LIKELY', perBook: [] } };
  const c = buildContext({ view: 'crowd', mode: 'simple', filters, data: data([]), visible: [], opportunity: null, crowd: { count: 1, feed: { state: 'live' }, visible: [row], selected: row } });
  assert.equal(c.crowd.selected.estimatedConsensusProbability, 0.59);
  assert.match(c.crowd.selected.classification, /NOT arbitrage/);
  const a = answerLocally('How would I make money here?', c);
  assert.match(a, /not arbitrage and not guaranteed/);
  assert.match(a, /59%/);
  assert.match(answerLocally('What is bookmaker margin?', c), /margin/i);
  assert.match(systemPrompt(), /estimated consensus probability/);
});

await test('linked context: proven link explained with the payoff table, example stays labelled', async () => {
  const { exampleResults } = await import('../src/linked/index.js');
  const [ex] = exampleResults();
  const c = buildContext({ view: 'linked', mode: 'simple', filters, data: data([]), visible: [], opportunity: null, linked: { mode: 'example', count: 0, selected: ex } });
  assert.match(c.linked.selected.classification, /EXAMPLE/);
  assert.equal(c.linked.selected.legs[0].buy, 'YES');
  const a = answerLocally('Explain this simply', c);
  assert.match(a, /⇒/); assert.match(a, /at least 49/); assert.match(a, /EXAMPLE/);
  assert.match(answerLocally('Why is this not executable?', c), /hypothetical/i);
});

console.log(`\n${passed} chat tests passed`);
