// Linked Markets: exact score constraints, bracket rules, payoff verification, invalidation.
// Every contract and state below is an explicitly labelled TEST FIXTURE. Run: node test/linked.test.mjs
import assert from 'node:assert/strict';
import { feasible, C } from '../src/linked/solver.js';
import { gameRelationships, bracketRelationships, classifyClaim, scoreCells } from '../src/linked/rules.js';
import { buildBasket } from '../src/linked/baskets.js';
import { evaluate, exampleResults } from '../src/linked/index.js';
import { manualState, stateFromPMUS, StateStore } from '../src/linked/state.js';
import { gameContracts, tournamentContracts, parseSettlement } from '../src/linked/contracts.js';

let passed = 0;
const test = async (name, fn) => { try { await fn(); passed++; console.log('  ✓', name); } catch (e) { console.error('  ✗', name); throw e; } };
const near = (a, b, eps = 1e-9) => assert.ok(Math.abs(a - b) < eps, `${a} ≈ ${b}`);
const NOW = Date.parse('2026-10-11T20:00:00Z');

// ---- TEST FIXTURES ----
const RULES = (o = {}) => ({ overtime: 'included', tie: 0.5, voidRule: 'fair-price', shortened: null, version: 'fx', text: 'TEST FIXTURE', ...o });
const base = (o) => ({ venue: 'polymarket-us', venueName: 'Polymarket US', eventSlug: 'fx-game', eventTitle: 'FX A vs FX B', league: 'nfl', url: null,
  feeCoefficient: 0.0695, open: true, minQty: 1, period: 'full', rules: RULES(), ...o });
const sides = (yesAsk, yesBid, yl, nl) => ({ yes: { label: yl, ask: yesAsk, bid: yesBid }, no: { label: nl, ask: yesBid == null ? null : +(1 - yesBid).toFixed(6), bid: +(1 - yesAsk).toFixed(6) } });
const winnerA = (o = {}) => base({ id: 'fx-a-wins', kind: 'winner', team: 'a', opponent: 'b', question: 'A wins?', sides: sides(0.61, 0.60, 'A win', 'B win'), yesText: 'A wins', noText: 'B wins', ...o });
const total = (line, o = {}) => base({ id: `fx-over-${line}`, kind: 'gameTotal', line, team: null, question: `Over ${line}?`, sides: sides(0.55, 0.54, `Over ${line}`, `Under ${line}`), yesText: `over ${line}`, noText: `under ${line}`, ...o });
const teamTot = (team, line, o = {}) => base({ id: `fx-tt-${team}-${line}`, kind: 'teamTotal', team, line, question: `${team} over ${line}?`, sides: sides(0.7, 0.69, `${team} over`, `${team} under`), yesText: `${team} over ${line}`, noText: `${team} under ${line}`, ...o });
const st = (a, b, o = {}) => manualState({ eventSlug: 'fx-game', league: o.league || 'nfl', teams: ['a', 'b'], scores: { a, b }, source: o.source || 'live', receivedAt: o.receivedAt ?? NOW, providerTime: o.providerTime });
const liveState = (a, b, o = {}) => { const s = st(a, b, o); s.verified = true; s.live = true; return s; };
const rel = (rels, fromId, s1, toId, s2) => rels.find((r) => r.from.contract.id === fromId && r.from.side === s1 && r.to.contract.id === toId && r.to.side === s2);

await test('solver agrees with brute force on bounded instances (exactness)', () => {
  let seed = 7; const rnd = (n) => (seed = (seed * 1103515245 + 12345) % 2147483648) % n;
  const makers = [C.aAtLeast, C.aAtMost, C.bAtLeast, C.bAtMost, C.sumAtLeast, C.sumAtMost, C.diffAtLeast, C.diffAtMost];
  for (let t = 0; t < 400; t++) {
    const cons = [C.aAtMost(30), C.bAtMost(30)];
    for (let i = 0; i < 1 + rnd(4); i++) { const m = makers[rnd(8)]; cons.push(m(m === C.diffAtLeast || m === C.diffAtMost ? rnd(41) - 20 : rnd(61))); }
    let brute = false;
    for (let a = 0; a <= 30 && !brute; a++) for (let b = 0; b <= 30; b++) if (cons.every((c) => c.ca * a + c.cb * b >= c.k)) { brute = true; break; }
    const w = feasible(cons);
    assert.equal(!!w, brute, JSON.stringify(cons));
    if (w) assert.ok(cons.every((c) => c.ca * w.a + c.cb * w.b >= c.k));
  }
  // unbounded instances still decided exactly
  assert.ok(feasible([C.aAtLeast(20), C.bAtLeast(24), C.diffAtLeast(1)]));
  assert.equal(feasible([C.aAtLeast(20), C.bAtLeast(24), C.diffAtLeast(1), C.sumAtMost(48)]), null);
});

await test('A trails 24–20: A wins ⇒ over 48.5 (derived from score constraints)', () => {
  const rels = gameRelationships([winnerA(), total(48.5)], liveState(20, 24));
  const r = rel(rels, 'fx-a-wins', 'yes', 'fx-over-48.5', 'yes');
  assert.ok(r, 'implication found');
  assert.equal(r.type, 'implication');
  assert.equal(r.createdByState, true);
  assert.match(r.why, /at least 49/);
  assert.ok(!rel(gameRelationships([winnerA(), total(48.5)], liveState(0, 0)), 'fx-a-wins', 'yes', 'fx-over-48.5', 'yes'), 'not true before the game');
});

await test('a higher total (54.5) is NOT forced by A winning', () => {
  const rels = gameRelationships([winnerA(), total(54.5)], liveState(20, 24));
  assert.ok(!rel(rels, 'fx-a-wins', 'yes', 'fx-over-54.5', 'yes'));
  assert.equal(classifyClaim(winnerA(), total(54.5), liveState(20, 24)).status, 'rejected');
});

await test('hedge direction: YES(over) + NO(A wins); the reverse basket can lose', () => {
  const s = liveState(20, 24, { league: 'cfb' });
  const contracts = [winnerA({ league: 'cfb' }), total(48.5, { league: 'cfb' })];
  const r = rel(gameRelationships(contracts, s), 'fx-a-wins', 'yes', 'fx-over-48.5', 'yes');
  const b = buildBasket(r, { now: NOW, config: { bufferPerShare: 0 } });
  assert.deepEqual(b.legs.map((l) => [l.contractId, l.side]), [['fx-over-48.5', 'yes'], ['fx-a-wins', 'no']]);
  assert.equal(b.minPayout, 1);
  // reverse: YES(A wins) + NO(over) → B wins with a high total pays nothing
  const cells = scoreCells(contracts, s);
  const reverseMin = Math.min(...cells.map((c) => c.picks[0].yes[0] + (1 - c.picks[1].yes[1])));
  assert.equal(reverseMin, 0);
});

await test('regression example: asks 0.55 + 0.40 → cost 0.95, min payout 1.00 (labelled example, never executable)', () => {
  const [ex] = exampleResults();
  assert.ok(ex);
  near(ex.unit.cost, 0.95); assert.equal(ex.minPayout, 1);
  assert.equal(ex.mode, 'example'); assert.equal(ex.executable, false);
});

await test('NFL tie: the tie state pays $0.50, so the same basket is NOT structurally guaranteed', () => {
  const r = rel(gameRelationships([winnerA(), total(48.5)], liveState(20, 24)), 'fx-a-wins', 'yes', 'fx-over-48.5', 'yes');
  const b = buildBasket(r, { now: NOW, config: { bufferPerShare: 0 } });
  const ties = b.rows.filter((x) => x.label.includes('Tie'));
  assert.equal(ties.length, 2); // tie at 24–24 (total 48) and tie at 25–25 or later (total ≥ 50)
  near(Math.min(...ties.map((x) => x.lo)), 0.5);
  assert.deepEqual(ties.find((x) => x.lo === 0.5).witness, { a: 24, b: 24 });
  assert.equal(b.minPayout, 0.5);
  assert.equal(b.profitable, false);
});

await test('overtime / period mismatch and unknown rules block verification', () => {
  const s = liveState(20, 24);
  assert.ok(!rel(gameRelationships([winnerA(), total(48.5, { rules: RULES({ overtime: 'excluded' }) })], s), 'fx-a-wins', 'yes', 'fx-over-48.5', 'yes'), 'regulation-only total rejected');
  assert.ok(!rel(gameRelationships([winnerA(), total(48.5, { period: '1h' })], s), 'fx-a-wins', 'yes', 'fx-over-48.5', 'yes'), 'first-half total rejected');
  const unk = rel(gameRelationships([winnerA(), total(48.5, { rules: RULES({ overtime: null }) })], s), 'fx-a-wins', 'yes', 'fx-over-48.5', 'yes');
  assert.ok(unk && unk.verified === false, 'unknown overtime rule → unverified');
  assert.equal(buildBasket(unk, { now: NOW }).status.structure, 'unverified');
  // settlement text parsing
  assert.equal(parseSettlement('Overtime is included if played. If the game ends in a tie, the market will settle to $0.50.').tie, 0.5);
  assert.equal(parseSettlement('Extra innings are included if played.').overtime, 'included');
});

await test('team totals: A wins from 20–24 ⇒ A scores at least 25 (over 24.5), and integer lines handled', () => {
  const rels = gameRelationships([winnerA(), teamTot('a', 24.5), total(48)], liveState(20, 24));
  assert.ok(rel(rels, 'fx-a-wins', 'yes', 'fx-tt-a-24.5', 'yes'));
  assert.ok(rel(rels, 'fx-a-wins', 'yes', 'fx-over-48', 'yes'), '"more than 48" needs 49 — forced');
  assert.ok(!rel(gameRelationships([winnerA(), teamTot('a', 25.5)], liveState(20, 24)), 'fx-a-wins', 'yes', 'fx-tt-a-25.5', 'yes'));
});

await test('voids: postponement payout is an interval; strict mode keeps it out of the executable feed', () => {
  const s = liveState(20, 24, { league: 'cfb' });
  const contracts = [winnerA({ league: 'cfb', sides: sides(0.62, 0.61, 'A win', 'B win') }), total(48.5, { league: 'cfb', sides: sides(0.5, 0.49, 'Over', 'Under') })];
  const r = rel(gameRelationships(contracts, s), 'fx-a-wins', 'yes', 'fx-over-48.5', 'yes');
  const books = new Map([['fx-over-48.5|yes', { asks: [{ p: 0.5, s: 200 }] }], ['fx-a-wins|no', { asks: [{ p: 0.39, s: 150 }] }]]);
  const strict = buildBasket(r, { books, now: NOW, quoteTime: new Date(NOW).toISOString(), stateFresh: { ok: true } });
  const v = strict.rows.find((x) => x.tail);
  assert.deepEqual([v.lo, v.hi], [0, 2]);
  assert.equal(strict.profitable, true); assert.equal(strict.executable, false);
  assert.ok(strict.reasons.some((x) => /Postponement/.test(x)));
  const lenient = buildBasket(r, { books, now: NOW, quoteTime: new Date(NOW).toISOString(), stateFresh: { ok: true }, config: { includeTailStates: false } });
  assert.equal(lenient.executable, true);
  assert.equal(lenient.econ.qty, 150);
  assert.ok(lenient.econ.minNet > 0);
});

await test('fees can eliminate an apparent profit', () => {
  const s = liveState(20, 24, { league: 'cfb' });
  const contracts = [winnerA({ league: 'cfb', sides: sides(0.58, 0.57, 'A win', 'B win') }), total(48.5, { league: 'cfb', sides: sides(0.55, 0.54, 'Over', 'Under') })];
  const b = buildBasket(rel(gameRelationships(contracts, s), 'fx-a-wins', 'yes', 'fx-over-48.5', 'yes'), { now: NOW, config: { bufferPerShare: 0 } });
  near(b.unit.cost, 0.98);                 // 0.55 + 0.43 < 1 looks like +2¢ …
  assert.ok(b.unit.fees > 0.02);           // … but fees are ≈ 3.4¢
  assert.equal(b.profitable, false);
});

await test('missing NO side or unknown size never becomes executable', () => {
  const s = liveState(20, 24, { league: 'cfb' });
  const noBid = winnerA({ league: 'cfb', sides: sides(0.62, null, 'A win', 'B win') });
  const b1 = buildBasket(rel(gameRelationships([noBid, total(48.5, { league: 'cfb' })], s), 'fx-a-wins', 'yes', 'fx-over-48.5', 'yes'), { now: NOW });
  assert.equal(b1.status.quotes, 'missing'); assert.equal(b1.executable, false);
  const cheap = [winnerA({ league: 'cfb', sides: sides(0.62, 0.61, 'A win', 'B win') }), total(48.5, { league: 'cfb', sides: sides(0.5, 0.49, 'Over', 'Under') })];
  const b2 = buildBasket(rel(gameRelationships(cheap, s), 'fx-a-wins', 'yes', 'fx-over-48.5', 'yes'), { now: NOW, quoteTime: new Date(NOW).toISOString(), stateFresh: { ok: true }, config: { includeTailStates: false } });
  assert.equal(b2.profitable, true); assert.equal(b2.status.size, 'unknown'); assert.equal(b2.executable, false);
});

await test('stale or corrected game states invalidate results', () => {
  const cheap = [winnerA({ league: 'cfb', sides: sides(0.62, 0.61, 'A win', 'B win') }), total(48.5, { league: 'cfb', sides: sides(0.5, 0.49, 'Over', 'Under') })];
  const books = new Map([['fx-over-48.5|yes', { asks: [{ p: 0.5, s: 50 }] }], ['fx-a-wins|no', { asks: [{ p: 0.39, s: 50 }] }]]);
  const mk = (s) => ({ state: s, contracts: cheap, quoteTime: new Date(NOW).toISOString() });
  const fresh = liveState(20, 24, { league: 'cfb', providerTime: new Date(NOW - 5e3).toISOString() });
  const ok = evaluate({ games: [mk(fresh)], books, now: NOW, config: { includeTailStates: false } }).results.find((b) => b.legs[1].contractId === 'fx-a-wins' && b.legs[0].contractId === 'fx-over-48.5');
  assert.equal(ok.executable, true);
  const stale = liveState(20, 24, { league: 'cfb', providerTime: new Date(NOW - 10 * 60e3).toISOString() });
  const st1 = evaluate({ games: [mk(stale)], books, now: NOW, config: { includeTailStates: false } });
  assert.ok(st1.results.every((b) => !b.executable)); assert.ok(st1.diagnostics.rejected.staleState > 0);
  // correction: 24 → 21 for B; the store flags it and the relationship id (state version) changes
  const store = new StateStore();
  store.update(fresh);
  const corrected = liveState(20, 21, { league: 'cfb', providerTime: new Date(NOW - 1e3).toISOString(), receivedAt: NOW });
  assert.equal(store.update(corrected).corrected, true);
  const after = evaluate({ games: [mk(corrected)], books, now: NOW, store, config: { includeTailStates: false } });
  assert.ok(after.results.every((b) => !b.executable));
  assert.notEqual(after.results[0]?.relationship.state.version, ok.relationship.state.version);
  // with B at 21, A winning only forces 43+ points — the 48.5 link disappears entirely
  assert.ok(!after.results.some((b) => b.legs[0].contractId === 'fx-over-48.5' && b.legs[1].contractId === 'fx-a-wins'));
});

await test('live state parsing: score orientation must be proven by per-team period scores', () => {
  const ev = { slug: 'nfl-x-y', title: 'X vs Y', live: true, teams: [{ id: 61, abbreviation: 'ind', name: 'Indianapolis Colts' }, { id: 79, abbreviation: 'was', name: 'Washington Commanders' }],
    eventState: { live: true, period: 'Q4', score: '20-24', updatedAt: '2026-10-11T19:59:58Z',
      periodScores: [{ scores: [{ competitorId: '61', score: 20 }, { competitorId: '79', score: 24 }] }] } };
  const s = stateFromPMUS(ev, 'nfl', NOW);
  assert.deepEqual(s.scores, { ind: 20, was: 24 }); assert.equal(s.verified, true);
  const bad = stateFromPMUS({ ...ev, eventState: { ...ev.eventState, score: '20-27' } }, 'nfl', NOW);
  assert.equal(bad.verified, false);
  const noPeriods = stateFromPMUS({ ...ev, eventState: { ...ev.eventState, periodScores: [] } }, 'nfl', NOW);
  assert.equal(noPeriods.scores, null);
});

// ---- bracket fixtures (shapes as published by Polymarket US) ----
const fut = (slug, title, markets) => ({ slug, title, teams: [], markets });
const fm = (slug, team, name, desc, bid = 0.3, ask = 0.31) => ({ slug, question: name, title: name, description: desc, active: true, closed: false, status: 'MARKET_STATUS_OPEN', ep3Status: 'OPEN', feeCoefficient: 0.0695,
  bestBidQuote: { value: String(bid) }, bestAskQuote: { value: String(ask) }, marketSides: [{ description: 'Yes', long: true, team: { abbreviation: team, name } }, { description: 'No', long: false, team: { abbreviation: team, name } }] });
const WS = 'If the event is canceled, the instrument may settle at last fair market prices.';

await test('championship implies finalist (World Series ⇒ pennant), with a sound payoff', () => {
  const t = [
    ...tournamentContracts(fut('mlb-champ-2026-09-27', 'World Series Champion', [fm('tec-mlb-champ-2026-09-27-lad', 'lad', 'Los Angeles Dodgers', `Will LAD win the 2026 World Series? ${WS}`, 0.30, 0.31)])),
    ...tournamentContracts(fut('mlb-nlchamp-2026-09-27', 'National League Champion', [fm('tec-mlb-nlchamp-2026-09-27-lad', 'lad', 'Los Angeles Dodgers', `Will LAD win the 2026 NL pennant? ${WS}`, 0.50, 0.51)])),
  ];
  const rels = bracketRelationships(t);
  const r = rels.find((x) => x.rule === 'MLB-WS-PENNANT');
  assert.ok(r); assert.equal(r.from.contract.stage, 'champion'); assert.equal(r.to.contract.stage, 'pennant');
  const b = buildBasket(r, { now: NOW });
  assert.deepEqual(b.legs.map((l) => [l.contractId, l.side]), [['tec-mlb-nlchamp-2026-09-27-lad', 'yes'], ['tec-mlb-champ-2026-09-27-lad', 'no']]);
  assert.equal(b.minPayout, 1);
  near(b.unit.cost, 0.51 + 0.70);
  assert.equal(b.profitable, false); // priced consistently
});

await test('unsupported qualification assumptions are rejected', () => {
  const po = tournamentContracts(fut('nfl-2027-01-10-playoffq', 'Playoff Qualifiers', [fm('aqc-nfl-2027-01-10-playoffq-kc', 'kc', 'Kansas City Chiefs', 'Will KC qualify?')]))[0];
  assert.equal(classifyClaim(winnerA({ team: 'kc' }), po).status, 'unsupported');
  const awards = tournamentContracts(fut('nfl-mvp-2027-02-11-w', 'MVP', [fm('tec-nfl-mvp-x', 'kc', 'Kansas City Chiefs', 'MVP')]));
  assert.equal(awards.length, 0, 'awards are not bracket stages');
});

await test('baseball: only a plate-appearance home run in a tied bottom 9th implies a walk-off win', () => {
  const homeWin = base({ id: 'fx-home', kind: 'winner', team: 'h', opponent: 'v', league: 'mlb' });
  const tiedB9 = { teams: [{ code: 'h' }, { code: 'v' }], homeTeam: 'h', scores: { h: 3, v: 3 }, inning: 9, half: 'bottom' };
  assert.equal(classifyClaim({ kind: 'paHomeRun', plateAppearance: true, team: 'h', inning: 9, half: 'bottom' }, homeWin, tiedB9).status, 'verified');
  assert.equal(classifyClaim({ kind: 'hrPropGame', team: 'h' }, homeWin, tiedB9).status, 'rejected');
  assert.equal(classifyClaim({ kind: 'paHomeRun', plateAppearance: true, team: 'h', inning: 9, half: 'bottom' }, homeWin, { ...tiedB9, scores: { h: 2, v: 3 } }).status, 'rejected');
});

await test('correlation and fixture data never enter verified live arbitrage', () => {
  assert.equal(classifyClaim({ kind: 'qbTdProp' }, winnerA()).status, 'correlation');
  const cheap = [winnerA({ league: 'cfb', sides: sides(0.62, 0.61, 'A win', 'B win') }), total(48.5, { league: 'cfb', sides: sides(0.5, 0.49, 'Over', 'Under') })];
  const books = new Map([['fx-over-48.5|yes', { asks: [{ p: 0.5, s: 50 }] }], ['fx-a-wins|no', { asks: [{ p: 0.39, s: 50 }] }]]);
  const fixture = st(20, 24, { league: 'cfb', source: 'fixture' });
  const out = evaluate({ games: [{ state: fixture, contracts: cheap, quoteTime: new Date(NOW).toISOString() }], books, now: NOW, mode: 'example', config: { includeTailStates: false } });
  assert.ok(out.results.length && out.results.every((b) => !b.executable));
  const manual = st(20, 24, { league: 'cfb', source: 'manual' });
  const out2 = evaluate({ games: [{ state: manual, contracts: cheap, quoteTime: new Date(NOW).toISOString(), mode: 'research' }], books, now: NOW, config: { includeTailStates: false } });
  assert.ok(out2.results.every((b) => !b.executable && b.mode === 'research'));
});

await test('contract parsing from a real-shaped Polymarket US game payload', () => {
  const ev = { slug: 'nfl-ind-was-2026-10-04', title: 'IND vs WAS', markets: [
    { slug: 'aec-nfl-ind-was-2026-10-04', sportsMarketType: 'football_team_full_game_winner', question: 'Who wins?', active: true, closed: false, status: 'MARKET_STATUS_OPEN', ep3Status: 'OPEN', feeCoefficient: 0.0695,
      description: 'This market will settle to the winner of the Indianapolis Colts vs Washington Commanders NFL game. Overtime is included if played. If the game ends in a tie, the market will settle to $0.50. If the game is delayed, postponed, or suspended and not rescheduled to a date within two weeks of the originally scheduled date, the market will settle to the last fair market price.',
      marketSides: [{ description: 'Colts', long: true, team: { abbreviation: 'ind', name: 'Indianapolis Colts' } }, { description: 'Commanders', long: false, team: { abbreviation: 'was', name: 'Washington Commanders' } }], bestBidQuote: { value: '0.65' }, bestAskQuote: { value: '0.66' } },
    { slug: 'tsc-nfl-ind-was-2026-10-04-total-48pt5', sportsMarketType: 'football_team_full_game_total', line: 48.5, question: 'Total over 48.5?', active: true, closed: false, status: 'MARKET_STATUS_OPEN', ep3Status: 'OPEN', feeCoefficient: 0.0695,
      description: 'This market will settle to Yes if Indianapolis Colts and Washington Commanders combine for over 48.5 points in the game. Overtime is included if played. If the game is delayed, postponed, or suspended and not rescheduled to a date within two weeks of the originally scheduled date, the market will settle to the last fair market price.',
      marketSides: [{ description: 'Over', long: true }, { description: 'Under', long: false }], bestBidQuote: { value: '0.5' }, bestAskQuote: { value: '0.51' } },
    { slug: 'tsc-nfl-ind-was-2026-10-04-1h-24pt5', sportsMarketType: 'football_game_first_half_total', line: 24.5, description: 'combine for over 24.5 points in the first half', marketSides: [{ description: 'Over', long: true }, { description: 'Under', long: false }] },
  ] };
  const cs = gameContracts(ev, 'nfl');
  assert.deepEqual(cs.map((c) => c.kind), ['winner', 'gameTotal']);
  assert.equal(cs[0].rules.tie, 0.5); assert.equal(cs[1].rules.overtime, 'included'); near(cs[0].sides.no.ask, 0.35);
});

console.log(`\n${passed} linked tests passed`);
