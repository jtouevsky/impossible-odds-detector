// Relationship detection. Deterministic only: score constraints (exact solver), published bracket formats,
// and a walk-off rule. Every relationship records its rule, assumptions, state version and settlement checks.
import { feasible, C } from './solver.js';
import { SUPPORTED_GAME_LEAGUES, STAGE_TEXT } from './contracts.js';
import { scoreText } from './state.js';

// ---------------------------------------------------------------- score model
// Outcome options a contract splits the game into (as constraints on the final score a = teams[0], b = teams[1]).
function outcomes(c, state) {
  const [A, B] = state.teams.map((t) => t.code);
  const x = (team) => (team === A ? 'a' : team === B ? 'b' : null);
  const fl = (L) => Math.floor(L);
  if (c.kind === 'winner') {
    const t = x(c.team);
    if (!t) return null;
    const ties = SUPPORTED_GAME_LEAGUES[c.league]?.ties;
    const win = t === 'a' ? C.diffAtLeast(1) : C.diffAtMost(-1), lose = t === 'a' ? C.diffAtMost(-1) : C.diffAtLeast(1);
    const tieYes = c.rules.tie;
    return [
      { key: 'win', label: `${c.team.toUpperCase()} win`, cons: [win], yes: [1, 1] },
      ...(ties ? [{ key: 'tie', label: 'Tie', cons: [C.diffAtLeast(0), C.diffAtMost(0)], yes: tieYes == null ? [0, 1] : [tieYes, tieYes] }] : []),
      { key: 'lose', label: `${c.opponent.toUpperCase()} win`, cons: [lose], yes: [0, 0] },
    ];
  }
  if (c.kind === 'gameTotal') return [
    { key: 'over', label: `total ≥ ${fl(c.line) + 1}`, cons: [C.sumAtLeast(fl(c.line) + 1)], yes: [1, 1] },
    { key: 'under', label: `total ≤ ${fl(c.line)}`, cons: [C.sumAtMost(fl(c.line))], yes: [0, 0] },
  ];
  if (c.kind === 'teamTotal') {
    const t = x(c.team);
    if (!t) return null;
    const at = t === 'a' ? [C.aAtLeast(fl(c.line) + 1), C.aAtMost(fl(c.line))] : [C.bAtLeast(fl(c.line) + 1), C.bAtMost(fl(c.line))];
    return [
      { key: 'over', label: `${c.team.toUpperCase()} ≥ ${fl(c.line) + 1}`, cons: [at[0]], yes: [1, 1] },
      { key: 'under', label: `${c.team.toUpperCase()} ≤ ${fl(c.line)}`, cons: [at[1]], yes: [0, 0] },
    ];
  }
  return null;
}

const sidePay = (yes, side) => (side === 'yes' ? yes : [1 - yes[1], 1 - yes[0]]);
export const stateConstraints = (state) => [C.aAtLeast(state.scores[state.teams[0].code]), C.bAtLeast(state.scores[state.teams[1].code])];

/**
 * Finite, exhaustive partition of every possible final score for a set of contracts, given the current score.
 * Each feasible cell carries a witness score. Nothing is sampled: infeasible cells are proven empty by the solver.
 */
export function scoreCells(contracts, state, base = stateConstraints(state)) {
  const opts = contracts.map((c) => outcomes(c, state));
  if (opts.some((o) => !o)) return null;
  const cells = [];
  const rec = (i, picked) => {
    if (i === opts.length) {
      const w = feasible([...base, ...picked.flatMap((p) => p.cons)]);
      if (w) cells.push({ picks: picked, witness: w, label: [...new Set(picked.map((p) => p.label))].join(' · ') });
      return;
    }
    for (const o of opts[i]) rec(i + 1, [...picked, o]);
  };
  rec(0, []);
  return cells;
}

/** Settlement compatibility of two game contracts. Unknown = not verified. */
export function gameCompat(c1, c2) {
  const checks = [];
  const add = (field, a, b, ok, note = '') => checks.push({ field, a: a ?? 'not stated', b: b ?? 'not stated', result: ok === true ? 'ok' : ok === false ? 'fail' : 'unknown', note });
  add('Same game', c1.eventSlug, c2.eventSlug, c1.eventSlug === c2.eventSlug);
  add('Period', c1.period, c2.period, c1.period === 'full' && c2.period === 'full', 'both must settle on the full game');
  add('Overtime / extra innings', c1.rules.overtime, c2.rules.overtime,
    c1.rules.overtime == null || c2.rules.overtime == null ? null : c1.rules.overtime === c2.rules.overtime, 'must be counted the same way');
  if (c1.kind === 'winner' || c2.kind === 'winner') {
    const w = c1.kind === 'winner' ? c1 : c2;
    add('Tie settlement (winner market)', w.rules.tie, w.rules.tie, SUPPORTED_GAME_LEAGUES[w.league]?.ties ? (w.rules.tie != null ? true : null) : true,
      SUPPORTED_GAME_LEAGUES[w.league]?.ties ? 'ties are possible in this league' : 'ties cannot occur in this league');
  }
  add('Postponement / cancellation', c1.rules.voidRule, c2.rules.voidRule, c1.rules.voidRule != null && c2.rules.voidRule != null ? true : null, 'modelled as a separate state');
  const fail = checks.some((c) => c.result === 'fail'), unknown = checks.some((c) => c.result === 'unknown' && c.field !== 'Postponement / cancellation');
  return { checks, ok: !fail, verified: !fail && !unknown };
}

const eventOf = (c, side) => (side === 'yes' ? c.yesText : c.noText);

/**
 * Score-constraint implications between two contracts of the same game.
 * Returns relationships  E(c1, s1) ⇒ E(c2, s2)  where E = "this side pays the full $1".
 */
export function gameRelationships(contracts, state, { now = Date.now() } = {}) {
  const out = [];
  if (!state?.scores) return out;
  for (let i = 0; i < contracts.length; i++)
    for (let j = 0; j < contracts.length; j++) {
      const c1 = contracts[i], c2 = contracts[j];
      if (i === j || c1.kind === c2.kind) continue; // same-kind ladders are handled by the nested-threshold engine
      const compat = gameCompat(c1, c2);
      if (!compat.ok) continue;
      const cells = scoreCells([c1, c2], state);
      if (!cells) continue;
      const pre = scoreCells([c1, c2], { ...state, scores: Object.fromEntries(state.teams.map((t) => [t.code, 0])) });
      for (const s1 of ['yes', 'no']) for (const s2 of ['yes', 'no']) {
        const prem = cells.filter((cell) => sidePay(cell.picks[0].yes, s1)[0] >= 1);
        if (!prem.length) continue; // premise impossible now — nothing to hedge
        const holds = prem.every((cell) => sidePay(cell.picks[1].yes, s2)[0] >= 1);
        if (!holds) continue;
        // trivial if the conclusion is certain on its own
        if (cells.every((cell) => sidePay(cell.picks[1].yes, s2)[0] >= 1)) continue;
        const staticToo = pre && pre.filter((cell) => sidePay(cell.picks[0].yes, s1)[0] >= 1).every((cell) => sidePay(cell.picks[1].yes, s2)[0] >= 1);
        out.push({
          id: `rel:${c1.id}:${s1}=>${c2.id}:${s2}@${state.version}`, type: 'implication', rule: 'score-constraint',
          from: { contract: c1, side: s1, event: eventOf(c1, s1) }, to: { contract: c2, side: s2, event: eventOf(c2, s2) },
          eventIds: [c1.eventSlug], createdByState: !staticToo,
          why: whyScore(c1, s1, c2, s2, state),
          assumptions: [
            `Current score ${scoreText(state)} is correct; scores never go down (a later official score correction would invalidate this).`,
            'Both markets settle on the official full-game result, counted the same way (overtime/extra innings).',
          ],
          state: { version: state.version, providerTime: state.providerTime, receivedAt: state.receivedAt, source: state.source, score: scoreText(state), period: state.period },
          compat, verified: compat.verified,
          cells: cells.map((c) => ({ label: c.label, witness: c.witness, yes: [c.picks[0].yes, c.picks[1].yes] })),
        });
      }
    }
  return out;
}

function whyScore(c1, s1, c2, s2, state) {
  const sc = scoreText(state);
  if (c1.kind === 'winner' && s1 === 'yes') {
    const me = c1.team, opp = c1.opponent, myS = state.scores[me], opS = state.scores[opp];
    if (c2.kind === 'gameTotal' && s2 === 'yes') return `${me.toUpperCase()} ${myS < opS ? 'trails' : myS > opS ? 'leads' : 'is tied'} (${sc}); to win they need at least ${Math.max(myS, opS + 1)} points while ${opp.toUpperCase()} keeps at least ${opS}, so a win by ${me.toUpperCase()} forces a total of at least ${Math.max(myS, opS + 1) + opS} — over ${c2.line}.`;
    if (c2.kind === 'teamTotal' && s2 === 'yes' && c2.team === me) return `${me.toUpperCase()} must outscore ${opp.toUpperCase()}, who already has ${opS} (${sc}), so a ${me.toUpperCase()} win means ${me.toUpperCase()} finishes with at least ${opS + 1} — over ${c2.line}.`;
  }
  return `With the score at ${sc}, every final score where "${eventOf(c1, s1)}" happens also has "${eventOf(c2, s2)}".`;
}

// ---------------------------------------------------------------- bracket rules (published competition formats)
export const BRACKET_RULES = [
  { id: 'MLB-WS-PENNANT', league: 'mlb', from: 'champion', to: 'pennant', type: 'implication', sameTeam: true,
    rule: 'The World Series is played only between the AL and NL pennant winners, so a team can only win it after winning its league pennant.' },
  { id: 'MLB-PENNANT-LCS', league: 'mlb', from: 'pennant', to: 'lcsQualify', type: 'implication', sameTeam: true, sameGroup: true,
    rule: 'A league pennant is won by winning that league\'s Championship Series, which requires reaching it.' },
  { id: 'MLB-DS-LCS', league: 'mlb', from: 'dsWinner', to: 'lcsQualify', type: 'equivalence', sameTeam: true, sameGroup: true,
    rule: 'Each League Championship Series is played between the two Division Series winners of that league, so winning the Division Series and reaching the LCS are the same outcome.' },
  { id: 'MLB-MATCHUP-PENNANT', league: 'mlb', from: 'wsMatchup', to: 'pennant', type: 'implication', teamIn: true,
    rule: 'The two World Series teams are exactly the two pennant winners.' },
  { id: 'NFL-SB-CONF', league: 'nfl', from: 'champion', to: 'confChamp', type: 'implication', sameTeam: true,
    rule: 'The Super Bowl is played between the AFC and NFC champions.' },
  { id: 'NFL-CONF-PLAYOFF', league: 'nfl', from: 'confChamp', to: 'playoffQualify', type: 'implication', sameTeam: true,
    rule: 'Conference championships are decided inside the playoffs, so a conference champion made the playoffs.' },
  { id: 'NFL-DIV-PLAYOFF', league: 'nfl', from: 'divisionWinner', to: 'playoffQualify', type: 'implication', sameTeam: true,
    rule: 'All eight division winners receive a playoff berth (seeds 1–4 in each conference).' },
  { id: 'NFL-1SEED-DIV', league: 'nfl', from: 'oneSeed', to: 'divisionWinner', type: 'implication', sameTeam: true, confMatch: true,
    rule: 'Seeds 1–4 in each conference go to division winners, so the #1 seed is a division winner.' },
];
// Two-step chains we also accept (each step must be a verified rule above).
const CHAINS = [['MLB-WS-PENNANT', 'MLB-PENNANT-LCS'], ['MLB-MATCHUP-PENNANT', 'MLB-PENNANT-LCS'], ['NFL-SB-CONF', 'NFL-CONF-PLAYOFF'], ['NFL-1SEED-DIV', 'NFL-DIV-PLAYOFF']];

const ruleMatch = (r, a, b) => {
  if (a.league !== r.league || b.league !== r.league || a.stage !== r.from || b.stage !== r.to) return null;
  if (a.season && b.season && a.season !== b.season) return null;
  if (r.sameTeam && a.team !== b.team) return null;
  if (r.teamIn && !a.teams.includes(b.team)) return null;
  if (r.sameGroup && a.group !== b.group) return null;
  if (r.confMatch && !b.group.startsWith(a.group)) return null;
  return true;
};

export function bracketRelationships(contracts) {
  const out = [];
  const add = (a, b, rules, type) => {
    const voidKnown = a.rules.voidRule != null && b.rules.voidRule != null;
    const compat = { ok: true, verified: true, checks: [
      { field: 'Competition & season', a: `${a.league.toUpperCase()} ${a.season || ''}`, b: `${b.league.toUpperCase()} ${b.season || ''}`, result: 'ok', note: '' },
      { field: 'Team', a: a.teams.join(', ').toUpperCase(), b: b.teams.join(', ').toUpperCase(), result: 'ok', note: '' },
      { field: 'Format rule', a: rules.map((r) => r.id).join(' → '), b: '', result: 'ok', note: rules.map((r) => r.rule).join(' ') },
      { field: 'Cancellation / postponement', a: a.rules.voidRule, b: b.rules.voidRule, result: voidKnown ? 'ok' : 'unknown', note: voidKnown ? 'modelled as a separate state' : 'not stated on one market — counted at worst case' },
    ] };
    const sides = type === 'equivalence' ? [[a, b], [b, a]] : [[a, b]];
    for (const [x, y] of sides)
      out.push({
        id: `rel:${x.id}:yes=>${y.id}:yes`, type, rule: rules.map((r) => r.id).join('+'),
        from: { contract: x, side: 'yes', event: x.yesText }, to: { contract: y, side: 'yes', event: y.yesText },
        eventIds: [x.eventSlug, y.eventSlug], createdByState: false,
        why: `${capital(x.yesText)} is only possible if ${y.yesText}: ${rules.map((r) => r.rule).join(' ')}`,
        assumptions: ['Both markets settle on the official league result for the same season.', 'The published postseason format applies unchanged.'],
        state: { stage: STAGE_TEXT[x.stage](x.teams), source: 'live' }, compat, verified: true,
        cells: [
          { label: `${capital(x.yesText)} (so ${y.yesText})`, yes: [[1, 1], [1, 1]] },
          ...(type === 'equivalence' ? [] : [{ label: `${capital(y.yesText)}, but not ${x.yesText}`, yes: [[0, 0], [1, 1]] }]),
          { label: `Neither`, yes: [[0, 0], [0, 0]] },
        ],
      });
  };
  for (const r of BRACKET_RULES) for (const a of contracts) for (const b of contracts) if (a !== b && ruleMatch(r, a, b)) add(a, b, [r], r.type);
  for (const [r1id, r2id] of CHAINS) {
    const r1 = BRACKET_RULES.find((r) => r.id === r1id), r2 = BRACKET_RULES.find((r) => r.id === r2id);
    for (const a of contracts) for (const m of contracts) if (a !== m && ruleMatch(r1, a, m)) for (const b of contracts) if (b !== m && b !== a && ruleMatch(r2, { ...m, teams: [m.team] }, b) && a.teams.includes(b.team)) add(a, b, [r1, r2], 'implication');
  }
  return dedupe(out);
}
const dedupe = (rels) => [...new Map(rels.map((r) => [r.id, r])).values()];
const capital = (s) => s[0].toUpperCase() + s.slice(1);

// ---------------------------------------------------------------- claim classifier (also used by tests)
/**
 * Is "premise ⇒ conclusion" something this engine can prove? Returns
 *   { status: 'verified' | 'correlation' | 'unsupported' | 'rejected', reason }
 */
export function classifyClaim(premise, conclusion, state = null) {
  const P = premise.kind === 'tournament' ? premise.stage : premise.kind, Q = conclusion.kind === 'tournament' ? conclusion.stage : conclusion.kind;
  if (P === 'paHomeRun') {
    if (!premise.plateAppearance) return { status: 'rejected', reason: 'Not tied to one plate appearance.' };
    const s = state || {};
    const home = s.homeTeam, tied = s.scores && s.scores[home] === s.scores[s.teams?.find((t) => t.code !== home)?.code];
    if (Q === 'winner' && conclusion.team === home && premise.team === home && s.inning >= 9 && s.half === 'bottom' && tied && premise.inning === s.inning && premise.half === 'bottom')
      return { status: 'verified', reason: 'Walk-off: a home run by the home team in a tied bottom of the 9th (or later) ends the game with the home team ahead.' };
    return { status: 'rejected', reason: 'Only a home-team home run in a tied bottom 9th-or-later plate appearance forces a win.' };
  }
  if (P === 'hrPropGame') return { status: 'rejected', reason: 'A full-game home-run prop can be hit in any plate appearance — when tied, ahead or behind — so it does not force a win.' };
  if (P === 'playerTdProp' || P === 'qbTdProp') return { status: 'correlation', reason: 'Player touchdowns are correlated with winning, not a guarantee: a team can score touchdowns and still lose.' };
  if (P === 'winner' && Q === 'playoffQualify') return { status: 'unsupported', reason: 'Playoff qualification depends on full standings and tiebreakers, which this engine does not model.' };
  if (premise.kind === 'tournament' && conclusion.kind === 'tournament') {
    const ok = BRACKET_RULES.some((r) => ruleMatch(r, premise, conclusion)) || CHAINS.some(([a, b]) => {
      const r1 = BRACKET_RULES.find((r) => r.id === a), r2 = BRACKET_RULES.find((r) => r.id === b);
      return r1.from === P && r2.to === Q && premise.team === conclusion.team && premise.league === r1.league && conclusion.league === r1.league;
    });
    return ok ? { status: 'verified', reason: 'Published competition format.' } : { status: 'unsupported', reason: 'No verified bracket rule links these stages.' };
  }
  if (['winner', 'gameTotal', 'teamTotal'].includes(P) && ['winner', 'gameTotal', 'teamTotal'].includes(Q)) {
    if (!state?.scores) return { status: 'unsupported', reason: 'Needs a verified game state.' };
    const rels = gameRelationships([premise, conclusion], state);
    const hit = rels.find((r) => r.from.contract === premise && r.to.contract === conclusion && r.from.side === 'yes' && r.to.side === 'yes');
    if (hit) return { status: hit.compat.verified ? 'verified' : 'unsupported', reason: hit.compat.verified ? hit.why : 'Settlement rules are not fully known.' };
    const compat = gameCompat(premise, conclusion);
    return { status: 'rejected', reason: compat.ok ? 'Some reachable final score satisfies the premise but not the conclusion.' : 'Settlement rules are incompatible (period/overtime).' };
  }
  return { status: 'unsupported', reason: 'No deterministic rule for this pair.' };
}
