// Contract normalisation + settlement rules for Linked Markets (Polymarket US event payloads).
// A LinkedContract describes WHAT pays and WHEN, parsed from the venue's own settlement text. Anything we
// can't read precisely stays null — and null rules can never produce a verified relationship.
import { nflCode } from '../sports/teams.js';
import { hashString } from '../providers/schema.js';

const num = (v) => { const n = parseFloat(v?.value ?? v); return Number.isFinite(n) ? n : null; };
const r6 = (x) => (x == null ? null : Math.round(x * 1e6) / 1e6);
export const SITE = 'https://polymarket.us/event';
export const SUPPORTED_GAME_LEAGUES = { nfl: { ties: true, unit: 'points' }, cfb: { ties: false, unit: 'points' }, mlb: { ties: false, unit: 'runs' } };

/** Settlement facts the engine relies on, read from the market description. */
export function parseSettlement(text = '') {
  const t = text.replace(/\s+/g, ' ');
  const overtime = /overtime is included|extra innings are included|including overtime/i.test(t) ? 'included'
    : /overtime is not included|regulation (time )?only|extra innings are not included/i.test(t) ? 'excluded' : null;
  const tie = /tie[^.]*\$0?\.50|tie[^.]*50-50|draw[^.]*\$0?\.50/i.test(t) ? 0.5 : /tie[^.]*settle[^.]*\$0?\.00/i.test(t) ? 0 : null;
  const voidRule = /fair market price/i.test(t) ? 'fair-price' : /resolve[^.]*50-50/i.test(t) ? 0.5 : null;
  const shortened = /shortened[^.]*official final result[^.]*settle based on that result/i.test(t) ? 'official-result' : null;
  return { overtime, tie, voidRule, shortened, version: hashString(t.toLowerCase()), text: t.slice(0, 900) };
}

const teamCode = (league, t) => {
  if (!t) return null;
  if (league === 'nfl') return nflCode(t.abbreviation) || nflCode(t.name) || (t.abbreviation || '').toLowerCase() || null;
  return (t.abbreviation || '').toLowerCase() || null;
};

function quoteSides(m, yesLabel, noLabel) {
  const bid = num(m.bestBidQuote), ask = num(m.bestAskQuote);
  return {
    yes: { label: yesLabel, ask, bid },
    // one instrument per market: buying the short/NO side costs 1 − best long bid, and sells into the long ask
    no: { label: noLabel, ask: bid != null ? r6(1 - bid) : null, bid: ask != null ? r6(1 - ask) : null },
  };
}

function base(m, ev, league) {
  const open = m.active !== false && !m.closed && (m.status ? /OPEN/.test(m.status) : true) && (m.ep3Status ? m.ep3Status === 'OPEN' : true);
  return {
    id: m.slug, venue: 'polymarket-us', venueName: 'Polymarket US', eventSlug: ev.slug, eventTitle: ev.title, league,
    question: m.question, url: `${SITE}/${ev.slug}`, feeCoefficient: num(m.feeCoefficient) ?? 0.0695,
    marketType: m.sportsMarketType, open, updatedAt: m.updatedAt || null, minQty: num(m.minimumTradeQty) ?? 1,
    rules: parseSettlement(m.description || ''),
  };
}

/** Game-level contracts we can express as constraints on the final score: winner, game total, team total. */
export function gameContracts(ev, league) {
  const out = [];
  if (!SUPPORTED_GAME_LEAGUES[league]) return out;
  for (const m of ev.markets || []) {
    const type = m.sportsMarketType || '', d = (m.description || '').replace(/\s+/g, ' ');
    const sides = m.marketSides || [];
    const long = sides.find((s) => s.long), short = sides.find((s) => !s.long);
    if (!long || !short) continue;
    if (/_full_game_winner$/.test(type) && long.team && short.team) {
      const a = teamCode(league, long.team), b = teamCode(league, short.team);
      if (!a || !b || a === b) continue;
      out.push({ ...base(m, ev, league), kind: 'winner', period: 'full', team: a, opponent: b, line: null,
        sides: quoteSides(m, `${long.description} win`, `${short.description} win`),
        yesText: `${long.description} win`, noText: `${short.description} win` });
    } else if (/_full_game_total$/.test(type) && /combine for over ([\d.]+) (points|runs)/i.test(d) && !/first \d+ innings|half|quarter|inning \d/i.test(d)) {
      const line = +d.match(/combine for over ([\d.]+)/i)[1];
      if (!Number.isFinite(line) || line !== num(m.line)) continue; // text and data must agree
      out.push({ ...base(m, ev, league), kind: 'gameTotal', period: 'full', line, team: null,
        sides: quoteSides(m, `Over ${line}`, `Under ${line}`), yesText: `combined score over ${line}`, noText: `combined score ${line} or less` });
    } else if (/_points_full_game_total$/.test(type) && /scores more than ([\d.]+) (points|runs) in the full game/i.test(d) && long.team) {
      const line = +d.match(/scores more than ([\d.]+)/i)[1];
      const team = teamCode(league, long.team);
      if (!team || !Number.isFinite(line)) continue;
      out.push({ ...base(m, ev, league), kind: 'teamTotal', period: 'full', line, team,
        sides: quoteSides(m, `${team.toUpperCase()} over ${line}`, `${team.toUpperCase()} ${line} or less`),
        yesText: `${team.toUpperCase()} scores over ${line}`, noText: `${team.toUpperCase()} scores ${line} or less` });
    }
  }
  return out;
}

// ---------- tournament / bracket contracts ----------
const STAGE_PATTERNS = [
  // MLB postseason (Wild Card → Division Series → LCS → World Series)
  { league: 'mlb', re: /^mlb-champ-/, stage: 'champion', group: () => 'mlb' },
  { league: 'mlb', re: /^mlb-(al|nl)champ-/, stage: 'pennant', group: (s) => s.match(/^mlb-(al|nl)/)[1] },
  { league: 'mlb', re: /^mlb-\d{4}-\d\d-\d\d-(al|nl)csq$/, stage: 'lcsQualify', group: (s) => s.match(/-(al|nl)csq$/)[1] },
  { league: 'mlb', re: /^mlb-(al|nl)ds-[a-z]+-[a-z]+-.*-w$/, stage: 'dsWinner', group: (s) => s.match(/^mlb-(al|nl)ds/)[1] },
  { league: 'mlb', re: /^mlb-\d{4}-\d\d-\d\d-wsmatchup$/, stage: 'wsMatchup', group: () => 'mlb' },
  // NFL (division winners and wild cards → conference championship → Super Bowl)
  { league: 'nfl', re: /^nfl-champ-.*-w$/, stage: 'champion', group: () => 'nfl' },
  { league: 'nfl', re: /^nfl-(afc|nfc)champ-/, stage: 'confChamp', group: (s) => s.match(/^nfl-(afc|nfc)/)[1] },
  { league: 'nfl', re: /^nfl-\d{4}-\d\d-\d\d-playoffq$/, stage: 'playoffQualify', group: () => 'nfl' },
  { league: 'nfl', re: /^nfl-(afc|nfc)(east|west|north|south)-.*-w$/, stage: 'divisionWinner', group: (s) => s.match(/^nfl-(afc|nfc)(east|west|north|south)/).slice(1).join('') },
  { league: 'nfl', re: /^nfl-(afc|nfc)1seed-/, stage: 'oneSeed', group: (s) => s.match(/^nfl-(afc|nfc)/)[1] },
];

export function tournamentContracts(ev) {
  const pat = STAGE_PATTERNS.find((p) => p.re.test(ev.slug || ''));
  if (!pat) return [];
  const out = [];
  for (const m of ev.markets || []) {
    const sides = m.marketSides || [];
    const long = sides.find((s) => s.long), short = sides.find((s) => !s.long);
    if (!long || !short) continue;
    let teams = [];
    if (pat.stage === 'wsMatchup') {
      const mm = (m.description || '').match(/if the (.+?) and the (.+?) are the two teams playing/i);
      if (!mm) continue;
      teams = mm.slice(1, 3).map((n) => (ev.teams || []).concat(long.team ? [long.team] : []).find((t) => n.includes(t.name) || t.name.includes(n)));
      teams = teams.map((t) => teamCode(pat.league, t)).filter(Boolean);
      if (teams.length !== 2) { // fall back to the slug suffix "-tb-mil"
        const sm = m.slug.match(/wsmatchup-([a-z]+)-([a-z]+)$/);
        if (!sm) continue;
        teams = [sm[1], sm[2]];
      }
    } else {
      const team = teamCode(pat.league, long.team) || (pat.league === 'nfl' ? nflCode((m.description || '').match(/if the (.+?) (win|are|earn|qualif)/i)?.[1]) : null);
      if (!team) continue;
      teams = [team];
    }
    const opp = pat.stage === 'dsWinner' ? (ev.slug.match(/ds-([a-z]+)-([a-z]+)-/) || []).slice(1).map((c) => c.toLowerCase()).find((c) => c !== teams[0]) : null;
    out.push({ ...base(m, ev, pat.league), kind: 'tournament', stage: pat.stage, group: pat.group(ev.slug), team: teams[0], teams, opponent: opp || null,
      season: (ev.slug.match(/(20\d\d)/) || [])[1] || null,
      sides: quoteSides(m, `Yes — ${m.title || teams.join(' & ').toUpperCase()}`, `No — ${m.title || teams.join(' & ').toUpperCase()}`),
      yesText: STAGE_TEXT[pat.stage](teams), noText: `not: ${STAGE_TEXT[pat.stage](teams)}` });
  }
  return out;
}

export const STAGE_TEXT = {
  champion: (t) => `${t[0].toUpperCase()} win the championship`,
  pennant: (t) => `${t[0].toUpperCase()} win the league pennant`,
  lcsQualify: (t) => `${t[0].toUpperCase()} reach the LCS`,
  dsWinner: (t) => `${t[0].toUpperCase()} win their Division Series`,
  wsMatchup: (t) => `${t.map((x) => x.toUpperCase()).join(' and ')} meet in the World Series`,
  confChamp: (t) => `${t[0].toUpperCase()} win the conference`,
  playoffQualify: (t) => `${t[0].toUpperCase()} make the playoffs`,
  divisionWinner: (t) => `${t[0].toUpperCase()} win the division`,
  oneSeed: (t) => `${t[0].toUpperCase()} earn the #1 seed`,
};
