// Sports odds, Crowd Disagreement, Polymarket US, history. All data below is an explicitly labelled TEST FIXTURE.
// Run: node test/sports.test.mjs
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { americanToDecimal, decimalToAmerican, impliedFromDecimal, devigProportional, consensus, freshnessWeight } from '../src/sports/odds.js';
import { matchQuotes, contractKey, STATUS } from '../src/sports/schema.js';
import { normalizeOddsEvent, OddsFeed } from '../src/sports/theOddsApi.js';
import { buildComparisons, sportsBaskets, fairByBook, predictionQuotes } from '../src/sports/compare.js';
import { normalizePMUSMarket, parsePMUSBook } from '../src/providers/polymarketUS.js';
import { buildSpec } from '../src/spec/marketSpec.js';
import { feeFor } from '../src/arb/fees.js';
import { providerState } from '../src/scan.js';
import { History, historyRecords } from '../src/history.js';
import { nflCode } from '../src/sports/teams.js';
import { compareSpecs } from '../src/spec/match.js';

let passed = 0;
const test = async (name, fn) => { try { await fn(); passed++; console.log('  ✓', name); } catch (e) { console.error('  ✗', name); throw e; } };
const near = (a, b, eps = 1e-9) => assert.ok(Math.abs(a - b) < eps, `${a} ≈ ${b}`);
const NOW = Date.parse('2026-10-03T12:00:00Z');
const ago = (min) => new Date(NOW - min * 60e3).toISOString();

// ---- TEST FIXTURE: one NFL game in The Odds API's documented shape ----
const FIXTURE_EVENT = (books) => ({ id: 'fixture-1', sport_key: 'americanfootball_nfl', commence_time: '2026-10-04T17:00:00Z', home_team: 'Washington Commanders', away_team: 'Indianapolis Colts', bookmakers: books });
const book = (key, colts, wash, min = 1, extra = []) => ({ key, title: key, last_update: ago(min), markets: [{ key: 'h2h', last_update: ago(min), outcomes: [{ name: 'Indianapolis Colts', price: colts }, { name: 'Washington Commanders', price: wash }, ...extra] }] });
const pmQuote = (ask, over = {}) => ({
  id: 'pm:ind', source: 'polymarket-us', venue: 'polymarket-us', venueName: 'Polymarket US', venueKind: 'prediction', sport: 'football', league: 'nfl',
  eventKey: 'game|nfl|2026-10-04|ind-was', threeWay: false, participants: ['ind', 'was'], event: { title: 'Colts vs Commanders' }, timestamp: ago(1),
  market: { type: 'moneyline', period: 'game', statistic: 'winner', player: null, team: null, line: null, side: 'ind' },
  price: { kind: 'exchange', ask, bid: ask - 0.01, feePerShare: 0.0695 * ask * (1 - ask) },
  rules: { overtime: 'included', tie: 0.5, cancellation: 'fair-price', source: 'venue-text', version: 'v1' }, ...over,
});

await test('American ↔ decimal ↔ implied conversion', () => {
  near(americanToDecimal(150), 2.5); near(americanToDecimal(-150), 1 + 100 / 150); near(americanToDecimal(100), 2);
  assert.equal(americanToDecimal(50), null); assert.equal(americanToDecimal(0), null);
  assert.equal(decimalToAmerican(2.5), 150); assert.equal(decimalToAmerican(1.5), -200);
  near(impliedFromDecimal(2.5), 0.4);
});

await test('proportional margin removal over a complete set', () => {
  const d = devigProportional([{ outcome: 'a', decimal: 1.8 }, { outcome: 'b', decimal: 2.1 }], ['a', 'b']);
  near(d.overround, 1 / 1.8 + 1 / 2.1);
  near(d.outcomes[0].fair + d.outcomes[1].fair, 1);
  near(d.outcomes[0].fair, (1 / 1.8) / (1 / 1.8 + 1 / 2.1));
  assert.equal(d.method, 'proportional');
  const ev = devigProportional([{ outcome: 'a', decimal: 1 / 0.5238 }, { outcome: 'b', decimal: 1 / 0.5238 }], ['a', 'b']);
  near(ev.outcomes[0].fair, 0.5, 1e-9);
});

await test('missing opposite side → no no-vig probability (never from a single side)', () => {
  assert.equal(devigProportional([{ outcome: 'a', decimal: 1.8 }], ['a', 'b']), null);
  const qs = normalizeOddsEvent(FIXTURE_EVENT([{ key: 'draftkings', title: 'DK', last_update: ago(1), markets: [{ key: 'h2h', last_update: ago(1), outcomes: [{ name: 'Indianapolis Colts', price: 1.6 }] }] }]), { fixture: true });
  const { fair, skipped } = fairByBook(qs);
  assert.equal(fair.size, 0);
  assert.match(skipped[0].reason, /opposite side missing/);
});

await test('feed normaliser maps documented fields to the shared schema (NFL names → codes)', () => {
  const qs = normalizeOddsEvent(FIXTURE_EVENT([book('draftkings', 1.6, 2.4)]), { fixture: true });
  assert.equal(qs.length, 2);
  const q = qs.find((x) => x.market.side === 'ind');
  assert.equal(q.eventKey, 'game|nfl|2026-10-04|ind-was');
  assert.equal(q.venueName, 'DraftKings'); assert.equal(q.price.decimal, 1.6); assert.equal(q.price.american, -167);
  assert.equal(q.rules.source, 'assumed-house-rules'); assert.equal(q.fixture, true);
  assert.equal(nflCode('Washington Commanders'), 'was'); assert.equal(nflCode('JAX'), 'jac'); assert.equal(nflCode('New York J'), 'nyj');
});

await test('different games, periods, lines and settlement rules are not the same bet', () => {
  const a = pmQuote(0.6);
  assert.equal(matchQuotes(a, { ...a, eventKey: 'game|nfl|2026-10-11|ind-was' }).status, STATUS.MISMATCH);
  assert.equal(matchQuotes(a, { ...a, market: { ...a.market, period: '1h' } }).status, STATUS.MISMATCH);
  const tot = { ...a, market: { ...a.market, type: 'total', side: 'over', line: 44.5 } };
  assert.equal(matchQuotes(tot, { ...tot, market: { ...tot.market, line: 45.5 } }).status, STATUS.MISMATCH);
  const prop = { ...a, market: { ...a.market, type: 'player_prop', statistic: 'pass_tds', player: 'A. Richardson', side: 'over', line: 1.5 } };
  assert.equal(matchQuotes(prop, { ...prop, market: { ...prop.market, player: 'A. Richardson Jr.' } }).status, STATUS.MISMATCH);
  // same bet, rules differ (tie 0.5 vs push) → only LIKELY
  assert.equal(matchQuotes(a, { ...a, venue: 'kalshi', rules: { ...a.rules, tie: 'push' } }).status, STATUS.LIKELY);
  // missing rules = uncertain, never verified
  assert.equal(matchQuotes(a, { ...a, venue: 'kalshi', rules: { ...a.rules, overtime: null } }).status, STATUS.LIKELY);
  // identical stated venue-text rules → verified
  assert.equal(matchQuotes(a, { ...a, venue: 'kalshi', venueName: 'Kalshi' }).status, STATUS.VERIFIED);
  assert.notEqual(contractKey(a), contractKey({ ...a, market: { ...a.market, period: '1h' } }));
});

await test('stale quotes are dropped and duplicate feeds counted once', () => {
  assert.equal(freshnessWeight(5 * 60e3), 1); near(freshnessWeight(35 * 60e3), 0.5); assert.equal(freshnessWeight(61 * 60e3), 0);
  const c = consensus([
    { book: 'draftkings', fair: 0.6, timestamp: ago(2) },
    { book: 'fanduel', fair: 0.58, timestamp: ago(2) },
    { book: 'pinnacle', fair: 0.1, timestamp: ago(90) },          // stale
    { book: 'williamhill_us', fair: 0.62, timestamp: ago(3) },
    { book: 'caesars', fair: 0.30, timestamp: ago(1) },            // same feed as williamhill_us → one copy
  ], { now: NOW });
  assert.deepEqual(c.books.map((b) => b.book).sort(), ['caesars', 'draftkings', 'fanduel']);
  assert.ok(c.excluded.some((x) => x.book === 'pinnacle' && x.why === 'stale'));
  assert.ok(c.excluded.some((x) => x.book === 'williamhill_us' && /duplicate/.test(x.why)));
  near(c.probability, (0.6 + 0.58 + 0.3) / 3);
  assert.equal(consensus([{ book: 'draftkings', fair: 0.6, timestamp: ago(1) }], { now: NOW }).probability, null); // needs 2+ books
});

await test('the venue being evaluated is excluded from its own consensus', () => {
  const qs = normalizeOddsEvent(FIXTURE_EVENT([book('draftkings', 1.5, 2.6), book('fanduel', 1.55, 2.5), book('pinnacle', 1.6, 2.45)]), { fixture: true });
  const { rows } = buildComparisons(qs, { now: NOW });
  const dk = rows.find((r) => r.target.venue === 'draftkings' && r.side === 'ind');
  assert.ok(dk);
  assert.ok(!dk.consensus.books.some((b) => b.book === 'draftkings'));
  assert.ok(dk.consensus.excluded.some((b) => b.why === 'venue being evaluated'));
  assert.equal(dk.consensus.label, 'Estimated consensus probability');
});

await test('prediction-market buy price vs consensus uses ask + fee, keeps raw odds/method/timestamps', () => {
  const qs = [...normalizeOddsEvent(FIXTURE_EVENT([book('draftkings', 1.6, 2.45), book('fanduel', 1.62, 2.4), book('pinnacle', 1.66, 2.38)]), { fixture: true }), pmQuote(0.52)];
  const { rows } = buildComparisons(qs, { now: NOW });
  const r = rows.find((x) => x.target.venue === 'polymarket-us');
  assert.ok(r.consensus.probability > 0.58 && r.consensus.probability < 0.62);
  near(r.disagreementPts, (r.consensus.probability - 0.52) * 100);
  near(r.edgeAfterFeesPts, (r.consensus.probability - 0.52 - 0.0695 * 0.52 * 0.48) * 100);
  assert.equal(r.match.status, STATUS.LIKELY); // books' rules are assumed, not in the feed
  for (const b of r.consensus.books) { assert.ok(b.decimal > 1); assert.ok(b.implied > b.fair); assert.ok(b.timestamp); }
  assert.match(r.consensus.method, /no-vig/);
});

await test('disagreements never leak into guaranteed arbitrage', () => {
  const qs = [...normalizeOddsEvent(FIXTURE_EVENT([book('draftkings', 1.3, 4), book('fanduel', 1.3, 4)]), { fixture: true }), pmQuote(0.30)];
  const { rows } = buildComparisons(qs, { now: NOW });
  assert.ok(rows.length && rows.every((r) => r.kind === 'disagreement' && r.guaranteed === false));
  const bs = sportsBaskets(qs);
  assert.ok(bs.every((b) => b.guaranteed === false && b.execution === 'unverified'));
});

await test('push / void states are modelled with real cash payouts', () => {
  // Book: Commanders @ 3.2 (tie = push → stake back). Exchange: Colts @ 0.45 (+fee), tie settles $0.50.
  const qs = [...normalizeOddsEvent(FIXTURE_EVENT([book('draftkings', 1.7, 3.2)]), { fixture: true }), pmQuote(0.45)];
  const [b] = sportsBaskets(qs);
  assert.ok(b, 'basket built');
  const st = Object.fromEntries(b.states.map((s) => [s.key, s]));
  near(st.ind.lo, 1); near(st.was.lo, 1);
  near(st.tie.lo, 1 / 3.2 + 0.5);                 // book refund + exchange half
  near(st.void.lo, 1 / 3.2 + 0);                  // book void refund; exchange "fair price" unknown → worst case 0
  near(b.costPer1, 1 / 3.2 + 0.45 + 0.0695 * 0.45 * 0.55);
  assert.equal(b.structural, true);
  assert.equal(b.structural, b.minPayoutCore - b.costPer1 - 0.005 > 1e-9);
  assert.equal(b.strictIncludingVoid, false);       // void state can't be covered
  assert.equal(b.guaranteed, false); assert.equal(b.execution, 'unverified');
  // at 0.55 the tie state pays less than the cost → not structural, and not even listed
  assert.equal(sportsBaskets([...normalizeOddsEvent(FIXTURE_EVENT([book('draftkings', 1.7, 3.2)]), { fixture: true }), pmQuote(0.55)]).length, 0);
});

await test('provider failures and missing credentials are reported honestly', async () => {
  assert.equal(providerState({ realMoney: true }, { failed: true }), 'unavailable');
  assert.equal(providerState({ realMoney: true }, { markets: [{ bid: null, ask: null }] }), 'partial');
  assert.equal(providerState({ realMoney: true }, { markets: [{ bid: 0.4, ask: 0.41 }] }), 'live');
  assert.equal(providerState({ realMoney: false, arb: false }, { referenceCount: 10, markets: [] }), 'partial');
  const noKey = new OddsFeed({ getKey: () => null });
  assert.equal(noKey.status().state, 'needs-setup');
  const cache = { data: null, save() {} };
  const bad = new OddsFeed({ getKey: () => 'k'.repeat(32), cache, fetch: async () => ({ status: 401, ok: false, headers: new Map(), json: async () => ({}) }) });
  const st = await bad.sync({ force: true });
  assert.equal(st.state, 'unavailable'); assert.match(st.reason, /401/);
  const ok = new OddsFeed({ getKey: () => 'k'.repeat(32), cache: { data: null, save() {} },
    fetch: async () => ({ status: 200, ok: true, headers: new Map([['x-requests-remaining', '480'], ['x-requests-used', '20'], ['x-requests-last', '1']]),
      json: async () => [{ ...FIXTURE_EVENT([book('draftkings', 1.6, 2.4), book('pinnacle', 1.62, 2.4)]), commence_time: new Date(Date.now() + 864e5).toISOString() }] }) });
  const s2 = await ok.sync({ force: true });
  assert.equal(s2.state, 'live'); assert.equal(s2.quota.remaining, 480);
  assert.equal(ok.quotes().length, 4);
});

await test('Polymarket US: own quotes, NO side = 1 − bid, book parsing, exact fee, game spec', () => {
  const raw = { slug: 'aec-nfl-ind-was-2026-10-04', question: 'Colts vs Commanders', category: 'sports', sportsMarketType: 'football_team_full_game_winner', marketType: 'moneyline',
    gameStartTime: '2026-10-04T17:00:00Z', endDate: '2026-10-05T00:00:00Z', feeCoefficient: 0.0695,
    description: 'This market will settle to the winner of the Indianapolis Colts vs Washington Commanders NFL game scheduled for Oct 4, 2026. Overtime is included if played. If the game ends in a tie, the market will settle to $0.50. If the game is delayed, postponed, or suspended and not rescheduled to a date within two weeks of the originally scheduled date, the market will settle to the last fair market price.',
    marketSides: [{ description: 'Colts', long: true, team: { name: 'Indianapolis Colts', abbreviation: 'ind', league: 'nfl', ordering: 'away' } }, { description: 'Commanders', long: false, team: { name: 'Washington Commanders', abbreviation: 'was', league: 'nfl', ordering: 'home' } }],
    bestBidQuote: { value: '0.6525' }, bestAskQuote: { value: '0.6550' } };
  const m = normalizePMUSMarket(raw);
  assert.equal(m.provider, 'polymarket-us'); assert.equal(m.ask, 0.655); near(m.noAsk, 1 - 0.6525);
  const spec = buildSpec(m, {}, [m]);
  assert.equal(spec.domain, 'game'); assert.equal(spec.eventKey, 'game|nfl|2026-10-04|ind-was'); assert.equal(spec.outcomeKey, 'ind');
  assert.equal(spec.settlement.tie, 0.5); assert.equal(spec.settlement.cancel, 'fair');
  const b = parsePMUSBook({ marketData: { bids: [{ px: { value: '0.65' }, qty: '100' }], offers: [{ px: { value: '0.66' }, qty: '50' }, { px: { value: '0.67' }, qty: '80' }], transactTime: '2026-10-03T12:00:00Z' } });
  assert.deepEqual(b.yes.asks.map((x) => x.p), [0.66, 0.67]); near(b.no.asks[0].p, 0.35); assert.equal(b.no.asks[0].s, 100);
  near(feeFor(m, 0.5, 1000), 17.38);   // docs example: 0.0695 × 1000 × 0.25 = 17.375 → never understated
  const qs = predictionQuotes([{ ...m, spec }]);
  assert.deepEqual(qs.map((q) => q.market.side).sort(), ['ind', 'was']);
  assert.equal(qs.find((q) => q.market.side === 'was').price.ask, m.noAsk);
  assert.equal(qs[0].rules.overtime, 'included');
});

await test('history: dedup, heartbeat, retention, fixtures excluded', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'iod-hist-'));
  fs.writeFileSync(path.join(dir, 'quotes-2020-01-01.ndjson'), '{}\n');
  const h = new History(dir, { days: 30, heartbeatMin: 60 });
  assert.ok(!fs.existsSync(path.join(dir, 'quotes-2020-01-01.ndjson')), 'old file pruned');
  const recs = [{ k: 'a', sig: '0.5', x: 1 }, { k: 'b', sig: '0.6' }];
  assert.equal(h.write('quotes', recs, NOW), 2);
  assert.equal(h.write('quotes', recs, NOW + 60e3), 0);                       // unchanged → skipped
  assert.equal(h.write('quotes', [{ k: 'a', sig: '0.51' }], NOW + 120e3), 1); // changed → written
  assert.equal(h.write('quotes', recs, NOW + 2 * 3600e3), 2);                 // heartbeat
  const fx = historyRecords({ sportsQuotes: normalizeOddsEvent(FIXTURE_EVENT([book('draftkings', 1.6, 2.4)]), { fixture: true }) });
  assert.equal(fx.quotes.length, 0);
});

await test('same venue + same wording but different rules (full game vs 3rd quarter) is a MISMATCH', () => {
  const mk = (slug, desc) => normalizePMUSMarket({ slug, question: 'Will the total in ARI Cardinals vs. NY Giants be more than 25.5?', category: 'sports', sportsMarketType: 'football_game_total_points', marketType: 'futures',
    endDate: '2026-10-05T00:00:00Z', description: desc, marketSides: [{ description: 'Over', long: true }, { description: 'Under', long: false }], bestBidQuote: { value: '0.5' }, bestAskQuote: { value: '0.52' } });
  const a = mk('tsc-nfl-ari-nyg-2026-10-04-total-25pt5', 'Resolves Over if the combined final score of the full game including overtime exceeds 25.5 points. Otherwise Under.');
  const b = mk('tsc-nfl-ari-nyg-2026-10-04-3q-25pt5', 'Resolves Over if the combined points scored in the third quarter only exceed 25.5 points. Otherwise Under.');
  const r = compareSpecs(buildSpec(a, {}, [a]), buildSpec(b, {}, [b]));
  assert.equal(r.status, 'MISMATCH');
});

console.log(`\n${passed} sports tests passed`);
