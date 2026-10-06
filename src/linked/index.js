// Linked Markets pipeline: game/bracket state → contracts → relationships → baskets.
// Live data: Polymarket US public gateway — one payload carries the game state AND that game's markets/quotes.
//   GET /v2/leagues/{league}/events               live/upcoming games with eventState (score, period, periodScores)
//   GET /v2/leagues/{league}/events?type=futures  championship / pennant / qualifier markets
//   GET /v1/markets/{slug}/book                    depth for candidate legs
import { gameContracts, tournamentContracts, SUPPORTED_GAME_LEAGUES } from './contracts.js';
import { stateFromPMUS, manualState, StateStore } from './state.js';
import { gameRelationships, bracketRelationships } from './rules.js';
import { buildBasket, LINKED_DEFAULTS } from './baskets.js';
import { getJSON } from '../providers/polymarket.js';
import { parsePMUSBook, PMUS_GATEWAY } from '../providers/polymarketUS.js';

export const LINKED_LEAGUES = (process.env.LINKED_LEAGUES || 'nfl,cfb,mlb').split(',').map((s) => s.trim()).filter((l) => SUPPORTED_GAME_LEAGUES[l]);
export const BRACKET_LEAGUES = ['mlb', 'nfl'];

/** Fetch live game states + contracts (+ futures) from Polymarket US. */
export async function fetchLinkedInputs({ fetch: f = globalThis.fetch, leagues = LINKED_LEAGUES } = {}) {
  const t0 = Date.now(), errors = [];
  const games = [], futures = [];
  await Promise.all([
    ...leagues.map(async (lg) => {
      try {
        const j = await getJSON(f, `${PMUS_GATEWAY}/v2/leagues/${lg}/events?limit=100`, { retries: 1, timeoutMs: 15000 });
        const receivedAt = Date.now();
        for (const ev of j.events || []) games.push({ ev, league: lg, receivedAt });
      } catch (e) { errors.push(`${lg} games: ${e.message}`); }
    }),
    ...BRACKET_LEAGUES.map(async (lg) => {
      try {
        const j = await getJSON(f, `${PMUS_GATEWAY}/v2/leagues/${lg}/events?type=futures&limit=100`, { retries: 1, timeoutMs: 15000 });
        const receivedAt = Date.now();
        for (const ev of j.events || []) futures.push({ ev, league: lg, receivedAt });
      } catch (e) { errors.push(`${lg} futures: ${e.message}`); }
    }),
  ]);
  return { games, futures, errors, fetchedAt: new Date().toISOString(), ms: Date.now() - t0 };
}

export async function fetchBooks(keys, { fetch: f = globalThis.fetch } = {}) {
  const out = new Map();
  const slugs = [...new Set(keys.map((k) => k.split('|')[0]))];
  for (let i = 0; i < slugs.length; i += 6)
    await Promise.all(slugs.slice(i, i + 6).map(async (s) => {
      try {
        const b = parsePMUSBook(await getJSON(f, `${PMUS_GATEWAY}/v1/markets/${encodeURIComponent(s)}/book`, { retries: 1, timeoutMs: 8000 }));
        out.set(`${s}|yes`, { asks: b.yes.asks, timestamp: b.timestamp, state: b.state });
        out.set(`${s}|no`, { asks: b.no.asks, timestamp: b.timestamp, state: b.state });
      } catch { /* leave missing → size unknown */ }
    }));
  return out;
}

function stateFreshness(state, now, cfg) {
  if (state.source !== 'live') return { ok: false, reason: `${state.source} state` };
  if (!state.verified) return { ok: false, reason: `Game state not verified: ${state.issues.join('; ') || 'unknown'}` };
  if (!state.live) return { ok: true, reason: 'pre-game' };
  const age = now - Date.parse(state.providerTime);
  if (!(age <= cfg.maxStateAgeMs)) return { ok: false, reason: `Game state is ${Math.round(age / 1000)}s old (max ${cfg.maxStateAgeMs / 1000}s).` };
  return { ok: true, reason: 'live' };
}

/**
 * Deterministic core (no network). inputs: { games:[{state, contracts, quoteTime}], tournaments:[contracts], books, now, config, mode }
 */
export function evaluate({ games = [], tournaments = [], books = new Map(), now = Date.now(), config = {}, mode = 'live', store = null }) {
  const cfg = { ...LINKED_DEFAULTS, ...config };
  const results = [];
  const diag = { games: games.length, liveGames: 0, verifiedStates: 0, unverifiedStates: [], contracts: { winner: 0, gameTotal: 0, teamTotal: 0, tournament: tournaments.length },
    relationships: 0, verifiedRelationships: 0, baskets: 0, profitable: 0, executable: 0, rejected: { incompatibleRules: 0, staleState: 0, missingQuotes: 0, unprofitable: 0, corrected: 0 } };
  for (const g of games) {
    const { state, contracts } = g;
    for (const c of contracts) diag.contracts[c.kind] = (diag.contracts[c.kind] || 0) + 1;
    if (state.live) diag.liveGames++;
    if (state.verified) diag.verifiedStates++; else if (state.source === 'live' && (state.live || state.issues.length)) diag.unverifiedStates.push(`${state.title || state.eventSlug}: ${state.issues.join('; ')}`);
    if (!state.scores) continue;
    const fresh = stateFreshness(state, now, cfg);
    const corrected = store ? store.recentlyCorrected(state.eventSlug, now) : false;
    if (corrected) diag.rejected.corrected++;
    for (const rel of gameRelationships(contracts, state)) {
      const b = buildBasket(rel, { books, now, config: cfg, mode: g.mode || mode, quoteTime: g.quoteTime, stateFresh: fresh, corrected,
        stateLabel: state.source !== 'live' ? state.source : state.live ? 'live' : 'pre-game' });
      b._fresh = fresh;
      results.push(b);
    }
  }
  for (const rel of bracketRelationships(tournaments)) {
    const qt = rel.from.contract.quoteTime || rel.to.contract.quoteTime;
    const b = buildBasket(rel, { books, now, config: cfg, mode: rel.from.contract.mode || mode, quoteTime: qt, stateFresh: { ok: true, reason: 'bracket' }, stateLabel: 'bracket' });
    b._fresh = { ok: true };
    results.push(b);
  }
  // A ⇒ B and its contrapositive (not B ⇒ not A) produce the same basket: keep one, preferring the YES ⇒ YES reading
  const best = new Map();
  const score = (b) => (b.relationship.from.side === 'yes') + (b.relationship.to.side === 'yes');
  for (const b of results) { const k = b.legs.map((l) => `${l.contractId}|${l.side}`).sort().join('+'); const cur = best.get(k); if (!cur || score(b) > score(cur)) best.set(k, b); }
  results.length = 0; results.push(...best.values());
  for (const b of results) { tally(b, diag, b._fresh); delete b._fresh; }
  results.sort((a, b) => (b.executable - a.executable) || (b.profitable - a.profitable) || ((b.unit?.net ?? -9) - (a.unit?.net ?? -9)));
  return { results, diagnostics: diag, emptyReason: emptyReason(results, diag) };
}

function tally(b, diag, fresh) {
  diag.baskets++; diag.relationships++;
  if (b.relationship.verified) diag.verifiedRelationships++; else diag.rejected.incompatibleRules++;
  if (b.profitable) diag.profitable++;
  if (b.executable) diag.executable++;
  if (!fresh.ok && b.relationship.rule === 'score-constraint' && b.mode === 'live') diag.rejected.staleState++;
  if (b.status.quotes === 'missing' || b.status.quotes === 'suspended') diag.rejected.missingQuotes++;
  else if (!b.profitable) diag.rejected.unprofitable++;
}

function emptyReason(results, d) {
  if (results.some((r) => r.executable)) return null;
  const parts = [];
  if (!d.games && !d.contracts.tournament) parts.push('No game or tournament data loaded.');
  if (d.games && !d.liveGames) parts.push('No supported game is live right now, so no score-created links exist (pre-game links only).');
  if (d.unverifiedStates.length) parts.push(`${d.unverifiedStates.length} live game state(s) could not be verified.`);
  if (d.rejected.staleState) parts.push(`${d.rejected.staleState} link(s) skipped: game state too old.`);
  if (d.rejected.missingQuotes) parts.push(`${d.rejected.missingQuotes} basket(s) lack a quote on one side.`);
  if (d.rejected.unprofitable) parts.push(`${d.rejected.unprofitable} verified link(s) are priced consistently — no profit after fees.`);
  if (d.rejected.incompatibleRules) parts.push(`${d.rejected.incompatibleRules} link(s) have rules we can't fully verify.`);
  if (results.some((r) => r.profitable)) parts.push('Profitable structures exist but are not executable (see each card).');
  return parts.join(' ') || 'No linked relationships found.';
}

// ---------------------------------------------------------------- live run
const store = new StateStore();
export async function runLive({ fetch: f = globalThis.fetch, config = {}, now = () => Date.now() } = {}) {
  const inp = await fetchLinkedInputs({ fetch: f });
  const games = [];
  for (const { ev, league, receivedAt } of inp.games) {
    const contracts = gameContracts(ev, league);
    if (!contracts.length) continue;
    const state = stateFromPMUS(ev, league, receivedAt);
    if (state.ended) continue;
    const upd = store.update(state);
    games.push({ state, contracts, quoteTime: new Date(receivedAt).toISOString(), stateUpdate: upd });
  }
  const tournaments = inp.futures.flatMap(({ ev, receivedAt }) => tournamentContracts(ev).map((c) => ({ ...c, quoteTime: new Date(receivedAt).toISOString() })));
  // first pass at top of book; load depth only for baskets that pay at the top
  let out = evaluate({ games, tournaments, now: now(), config, store });
  const keys = out.results.filter((r) => r.profitable).flatMap((r) => r.legs.map((l) => `${l.contractId}|${l.side}`));
  if (keys.length) {
    const books = await fetchBooks(keys, { fetch: f });
    out = evaluate({ games, tournaments, books, now: now(), config, store });
  }
  return { ...out, mode: 'live', source: { id: 'polymarket-us', name: 'Polymarket US public gateway', fetchedAt: inp.fetchedAt, ms: inp.ms, errors: inp.errors,
    state: inp.errors.length === LINKED_LEAGUES.length + BRACKET_LEAGUES.length ? 'unavailable' : inp.errors.length ? 'partial' : 'live' },
    games: games.map((g) => ({ slug: g.state.eventSlug, title: g.state.title, league: g.state.league, live: g.state.live, period: g.state.period, scores: g.state.scores,
      verified: g.state.verified, issues: g.state.issues, providerTime: g.state.providerTime, receivedAt: new Date(g.state.receivedAt).toISOString(), contracts: g.contracts.length })),
    gamesInput: games };
}

/** Manual / replay research mode: a user-entered score applied to a real game's current contracts. Never executable. */
export function runManual({ game, scores, period = null, now = Date.now(), config = {} }) {
  const state = manualState({ eventSlug: game.state.eventSlug, league: game.state.league, teams: game.state.teams.map((t) => t.code), scores, period, title: game.state.title, receivedAt: now });
  return { ...evaluate({ games: [{ state, contracts: game.contracts, quoteTime: game.quoteTime, mode: 'research' }], now, config, mode: 'research' }), mode: 'research', state };
}

// ---------------------------------------------------------------- labelled example (never live)
export function exampleResults() {
  const rules = { overtime: 'included', tie: null, voidRule: 'fair-price', shortened: null, version: 'example', text: 'EXAMPLE contract — not a real market.' };
  const mk = (o) => ({ venue: 'example', venueName: 'Example', eventSlug: 'example-game', eventTitle: 'Team A vs Team B (EXAMPLE)', league: 'cfb', url: null,
    feeCoefficient: 0, open: true, minQty: 1, rules, ...o });
  const winner = mk({ id: 'example-a-wins', kind: 'winner', period: 'full', team: 'a', opponent: 'b', question: 'Will Team A win? (example)',
    sides: { yes: { label: 'Team A win', ask: 0.60, bid: 0.60 }, no: { label: 'Team B win', ask: 0.40, bid: 0.39 } }, yesText: 'Team A wins', noText: 'Team B wins' });
  const total = mk({ id: 'example-over-48-5', kind: 'gameTotal', period: 'full', line: 48.5, team: null, question: 'Total over 48.5? (example)',
    sides: { yes: { label: 'Over 48.5', ask: 0.55, bid: 0.54 }, no: { label: 'Under 48.5', ask: 0.46, bid: 0.45 } }, yesText: 'combined score over 48.5', noText: 'combined score 48.5 or less' });
  const state = manualState({ eventSlug: 'example-game', league: 'cfb', teams: ['a', 'b'], scores: { a: 20, b: 24 }, period: 'Q4 (example)', source: 'fixture', title: 'Team A vs Team B (EXAMPLE)' });
  const out = evaluate({ games: [{ state, contracts: [winner, total], mode: 'example' }], mode: 'example', config: { bufferPerShare: 0 } });
  return out.results.filter((r) => r.relationship.from.contract.id === 'example-a-wins' && r.relationship.from.side === 'yes' && r.relationship.to.contract.id === 'example-over-48-5');
}
