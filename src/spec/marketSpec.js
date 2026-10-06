// MarketSpec: a canonical, venue-neutral description of WHAT a contract pays on.
// Contracts are only ever matched by comparing specs, never by title similarity alone.
//
// MarketSpec = {
//   marketId, provider, domain,          // 'game' | 'fomc' | 'uspres-party' | 'binary'
//   eventKey,                            // underlying event (blocking key for candidate generation)
//   outcomeKey,                          // the state in which YES pays $1
//   approxOutcome,                       // outcome mapping is close but not definitionally identical
//   comparator, threshold,               // e.g. '>', 74100 (generic binaries)
//   windowEnd, dateKey,                  // resolution time (ms) and its America/New_York date
//   ruleDates,                           // explicit calendar dates mentioned in question + rules
//   sources, geo,                        // resolution sources / places named in the rules
//   settlement: { tie, cancel, regulation90 },  // special-state handling parsed from rules
//   states,                              // the domain's resolution states (core + tail)
//   text,                                // canonical question (generic domain)
// }
import { canonQuestion, normText, templatize } from '../engine/text.js';
import { nflCode } from '../sports/teams.js';

const MONTHS = { jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6, jul: 7, aug: 8, sep: 9, oct: 10, nov: 11, dec: 12 };
const MONTH_NAMES = Object.keys(MONTHS);

const ET_FMT = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/New_York', year: 'numeric', month: '2-digit', day: '2-digit' });
export function etDate(ts) {
  const t = typeof ts === 'number' ? ts : Date.parse(ts);
  if (!Number.isFinite(t)) return null;
  return ET_FMT.format(new Date(t));
}

// ---------- sports games ----------
const PM_LEAGUE = { nfl: 'nfl', nba: 'nba', mlb: 'mlb', nhl: 'nhl', cfb: 'ncaaf', wnba: 'wnba', mls: 'mls', epl: 'epl', ucl: 'ucl',
  uel: 'uel', lal: 'laliga', bun: 'bundesliga', sea: 'seriea', fl1: 'ligue1' };
const KX_LEAGUE = { NFL: 'nfl', NBA: 'nba', MLB: 'mlb', NHL: 'nhl', NCAAF: 'ncaaf', WNBA: 'wnba', MLS: 'mls', EPL: 'epl', UCL: 'ucl',
  UEL: 'uel', LALIGA: 'laliga', BUNDESLIGA: 'bundesliga', SERIEA: 'seriea', LIGUE1: 'ligue1' };
const SOCCER = new Set(['mls', 'epl', 'ucl', 'uel', 'laliga', 'bundesliga', 'seriea', 'ligue1']);
const TIES = new Set(['nfl']); // two-way markets where a tie is possible
// Team-code differences between venues (Polymarket slug code -> Kalshi ticker code). Only certain ones.
const CODE_ALIAS = { nfl: { la: 'lar' }, nhl: { las: 'vgk' }, epl: { mac: 'mci', liv: 'lfc' } };
const alias = (lg, c) => (lg === 'nfl' ? nflCode(c) || c : (CODE_ALIAS[lg] && CODE_ALIAS[lg][c]) || c);

export function gameStates(league, codes, { soccer = false, combat = false } = {}) {
  const s = codes.map((c) => ({ key: c, label: `${c.toUpperCase()} wins`, tail: false }));
  if (combat) s.push({ key: 'nocontest', label: 'Draw / no contest', tail: true });
  if (SOCCER.has(league) || soccer) s.push({ key: 'draw', label: 'Draw (90 min)', tail: false });
  if (TIES.has(league)) s.push({ key: 'tie', label: 'Tie', tail: false });
  s.push({ key: 'void', label: 'Postponed >48h / canceled', tail: true });
  return s;
}

function parseGameSettlement(rules, provider) {
  const r = normText(rules);
  let tie = null, cancel = null;
  if (/tie[^.]*(50-50|\$?0\.50|50\/50)/.test(r)) tie = 0.5;
  else if (/tie[^.]*resolve[^.]*no\b/.test(r)) tie = 0;
  if (/cancel[^.]*50-50/.test(r)) cancel = 0.5;
  else if (/cancel[^.]*resolve[^.]*"?no"?/.test(r)) cancel = 0;
  else if (/fair (market )?price/.test(r)) cancel = 'fair';
  return { tie, cancel, regulation90: /90 minutes/.test(r), provider };
}

function pmGameSpec(m, ev) {
  const mm = (ev.slug || m.eventSlug || '').match(/^([a-z0-9]+)-([a-z0-9]+)-([a-z0-9]+)-(\d{4}-\d{2}-\d{2})$/);
  if (!mm || m.sportsType !== 'moneyline') return null;
  const league = PM_LEAGUE[mm[1]];
  if (!league) return null;
  const c1 = alias(league, mm[2]), c2 = alias(league, mm[3]);
  const names = (ev.title || '').split(/\s+vs\.?\s+/i).map((x) => normText(x).replace(/[^a-z0-9 ]/g, '').trim());
  if (names.length !== 2) return null;
  const nameToCode = (n) => { const x = normText(n).replace(/[^a-z0-9 ]/g, '').trim(); return x === names[0] ? c1 : x === names[1] ? c2 : null; };
  let outcomeKey;
  if (!m.isYesNo) outcomeKey = nameToCode(m.yesOutcome);
  else if (/draw/i.test(m.label) || /end in a draw/i.test(m.question)) outcomeKey = 'draw';
  else outcomeKey = nameToCode(m.label);
  if (!outcomeKey) return null;
  const date = etDate(m.gameStartTime) || mm[4];
  const codes = [c1, c2].sort();
  return { domain: 'game', league, eventKey: `game|${league}|${date}|${codes.join('-')}`, outcomeKey, codes, dateKey: date,
    states: gameStates(league, codes), settlement: parseGameSettlement(m.rules, 'polymarket') };
}

function kalshiGameSpec(m, ev, eventMarkets) {
  const sm = (m.series || '').match(/^KX(.+?)(GAME|MATCH)$/);
  if (!sm || !KX_LEAGUE[sm[1]]) return null;
  const league = KX_LEAGUE[sm[1]];
  const em = (m.eventId || '').match(/-(\d\d)([A-Z]{3})(\d\d)(\d{4})?[A-Z0-9]+$/);
  if (!em) return null;
  const date = `20${em[1]}-${String(MONTHS[em[2].toLowerCase()]).padStart(2, '0')}-${em[3]}`;
  const suffix = (t) => t.split('-').pop().toLowerCase();
  const codes = eventMarkets.map((x) => suffix(x.id)).filter((c) => c !== 'tie').map((c) => alias(league, c)).sort();
  if (codes.length !== 2) return null;
  const s = suffix(m.id) === 'tie' ? 'tie' : alias(league, suffix(m.id));
  return { domain: 'game', league, eventKey: `game|${league}|${date}|${codes.join('-')}`, outcomeKey: s === 'tie' ? 'draw' : s, codes,
    dateKey: date, states: gameStates(league, codes), settlement: parseGameSettlement(m.rules, 'kalshi') };
}

// Polymarket US: slug "aec-nfl-ind-was-2026-10-04" (two-team instrument, long side = first listed team) or
// "atc-uecl-ggk-zil-2026-07-30-ggk" (yes/no on one team / "-draw").
const PMUS_WINNER = /^(moneyline|ufc_fight_winner|[a-z]+_team_full_(game|time)_winner)$/;
function pmusGameSpec(m) {
  if (!PMUS_WINNER.test(m.sportsType || '')) return null;
  const mm = (m.slug || '').match(/^[a-z]{3}-([a-z0-9]+)-([a-z0-9]+)-([a-z0-9]+)-(\d{4}-\d{2}-\d{2})(?:-([a-z0-9-]+))?$/);
  if (!mm) return null;
  const league = PM_LEAGUE[mm[1]] || mm[1];
  const c1 = alias(league, mm[2]), c2 = alias(league, mm[3]);
  if (!c1 || !c2 || c1 === c2) return null;
  let outcomeKey;
  if (!m.isYesNo) {
    const longTeam = (m.teams || []).find((t) => t.long);
    outcomeKey = longTeam ? alias(league, longTeam.code) : null;
  } else outcomeKey = /draw|tie/.test(mm[5] || '') || /^tie$/i.test(m.label) ? 'draw' : alias(league, mm[5] || '');
  if (!outcomeKey || (outcomeKey !== 'draw' && outcomeKey !== c1 && outcomeKey !== c2)) return null;
  const date = etDate(m.gameStartTime) || mm[4];
  const codes = [c1, c2].sort();
  return { domain: 'game', league, eventKey: `game|${league}|${date}|${codes.join('-')}`, outcomeKey, codes, dateKey: date,
    states: gameStates(league, codes, { soccer: /^soccer_/.test(m.sportsType), combat: /^(ufc_|moneyline$)/.test(m.sportsType) && !/^(nfl|ncaaf|nba|mlb|nhl)$/.test(league) }),
    settlement: parseGameSettlement(m.rules, 'polymarket-us') };
}

// ---------- FOMC decisions ----------
export const FOMC_STATES = ['cut>25', 'cut25', 'hold', 'hike25', 'hike>25'].map((k) => ({ key: k, label: k, tail: false }));

function pmFomcSpec(m, ev) {
  if (!/^fed decision in/i.test(ev.title || '')) return null;
  const q = normText(m.question).match(/after the (\w+) (20\d\d) meeting/);
  if (!q || !MONTHS[q[1].slice(0, 3)]) return null;
  const l = normText(m.label);
  let k = null, approx = false;
  if (/no change/.test(l)) k = 'hold';
  else if (/^25 bps decrease/.test(l)) k = 'cut25';
  else if (/^25 bps increase/.test(l)) k = 'hike25';
  else if (/^50\+ bps decrease/.test(l)) { k = 'cut>25'; approx = true; }
  else if (/^50\+ bps increase/.test(l)) { k = 'hike>25'; approx = true; }
  if (!k) return null;
  return { domain: 'fomc', eventKey: `fomc|${q[2]}-${String(MONTHS[q[1].slice(0, 3)]).padStart(2, '0')}`, outcomeKey: k, approxOutcome: approx,
    approxNote: approx ? '"50+ bps" vs ">25 bps": identical only if the Fed moves in 25 bp steps' : null, states: FOMC_STATES };
}

function kalshiFomcSpec(m) {
  if (m.series !== 'KXFEDDECISION') return null;
  const em = (m.eventId || '').match(/-(\d\d)([A-Z]{3})$/);
  const sm = (m.id || '').match(/-(C26|C25|H0|H25|H26)$/);
  if (!em || !sm) return null;
  const k = { C26: 'cut>25', C25: 'cut25', H0: 'hold', H25: 'hike25', H26: 'hike>25' }[sm[1]];
  return { domain: 'fomc', eventKey: `fomc|20${em[1]}-${String(MONTHS[em[2].toLowerCase()]).padStart(2, '0')}`, outcomeKey: k, states: FOMC_STATES };
}

// ---------- US presidential party ----------
const PARTY_STATES = [{ key: 'd', label: 'Democrat', tail: false }, { key: 'r', label: 'Republican', tail: false }, { key: 'other', label: 'Other party', tail: false }];
function pmPartySpec(m, ev) {
  const t = (ev.title || '').match(/which party wins (20\d\d) us presidential election/i);
  if (!t) return null;
  const k = /democrat/i.test(m.label) ? 'd' : /republican/i.test(m.label) ? 'r' : null;
  if (!k) return null;
  return { domain: 'uspres-party', eventKey: `uspres-party|${t[1]}`, outcomeKey: k, approxOutcome: true,
    approxNote: 'Polymarket settles on the election winner; Kalshi on the party inaugurated', states: PARTY_STATES };
}
function kalshiPartySpec(m) {
  const t = (m.eventId || '').match(/^KXPRESPARTY-(20\d\d)$/);
  if (!t) return null;
  const k = { D: 'd', R: 'r' }[m.id.split('-').pop()];
  if (!k) return null;
  return { domain: 'uspres-party', eventKey: `uspres-party|${t[1]}`, outcomeKey: k, states: PARTY_STATES };
}


// ---------- US races by party, chamber control, presidential persons/nominees (Polymarket, Kalshi, PredictIt) ----------
const STATE = { alabama: 'al', alaska: 'ak', arizona: 'az', arkansas: 'ar', california: 'ca', colorado: 'co', connecticut: 'ct', delaware: 'de',
  florida: 'fl', georgia: 'ga', hawaii: 'hi', idaho: 'id', illinois: 'il', indiana: 'in', iowa: 'ia', kansas: 'ks', kentucky: 'ky', louisiana: 'la',
  maine: 'me', maryland: 'md', massachusetts: 'ma', michigan: 'mi', minnesota: 'mn', mississippi: 'ms', missouri: 'mo', montana: 'mt',
  nebraska: 'ne', nevada: 'nv', 'new hampshire': 'nh', 'new jersey': 'nj', 'new mexico': 'nm', 'new york': 'ny', 'north carolina': 'nc',
  'north dakota': 'nd', ohio: 'oh', oklahoma: 'ok', oregon: 'or', pennsylvania: 'pa', 'rhode island': 'ri', 'south carolina': 'sc',
  'south dakota': 'sd', tennessee: 'tn', texas: 'tx', utah: 'ut', vermont: 'vt', virginia: 'va', washington: 'wa', 'west virginia': 'wv',
  wisconsin: 'wi', wyoming: 'wy' };
const partyOf = (s) => (/^\W*(the )?(democrat|dem\b|d\b)/i.test(s) ? 'd' : /^\W*(the )?(republican|gop|r\b)/i.test(s) ? 'r' : /independent/i.test(s) ? 'i' : null);
const PARTY_RACE_STATES = ['d', 'r', 'i', 'other'].map((k) => ({ key: k, label: { d: 'Democrat wins', r: 'Republican wins', i: 'Independent wins', other: 'Someone else' }[k], tail: false }));
const RACE_NOTE = 'Venues can define "party" (independents who caucus with a party), the calling source (AP vs certification) and runoff timing differently';
export function personKey(name) {
  // "Donald Trump Jr." must never match "Donald J. Trump": generational suffixes are part of the identity
  const n = normText(name).replace(/\(.*?\)/g, '');
  const suffix = (n.match(/\b(jr|sr|ii|iii|iv)\b\.?/) || [])[1] || '';
  const t = n.replace(/\b(jr|sr|ii|iii|iv)\b\.?/g, '').replace(/[^a-z\- ]/g, ' ').split(/\s+/).filter(Boolean);
  if (t.length < 2) return null;
  return `${t[t.length - 1]}|${t[0][0]}${suffix ? '|' + suffix : ''}`;
}
const personStates = (k) => [{ key: k, label: 'This person', tail: false }, { key: '__other', label: 'Someone else', tail: false }];

function raceSpec(m, ev) {
  const T = ev.title || m.eventTitle || '';
  let r = null, out = null;
  if (m.provider === 'predictit') {
    const L = m.label || '';
    if ((r = T.match(/Which party will win the (\d{4}) US Senate (special )?election in ([A-Za-z .]+)\?/i)) && STATE[r[3].toLowerCase().trim()])
      out = { key: `race|senate|${STATE[r[3].toLowerCase().trim()]}|${r[1]}${r[2] ? '|special' : ''}`, o: partyOf(L) };
    else if ((r = T.match(/Which party will win the (\d{4}) election for governor of ([A-Za-z .]+)\?/i)) && STATE[r[2].toLowerCase().trim()])
      out = { key: `race|gov|${STATE[r[2].toLowerCase().trim()]}|${r[1]}`, o: partyOf(L) };
    else if ((r = T.match(/Which party will control the Senate after the (\d{4}) election/i))) out = { key: `control|senate|${r[1]}`, o: partyOf(L) };
    else if ((r = T.match(/Which party will win the House in the (\d{4}) election/i))) out = { key: `control|house|${r[1]}`, o: partyOf(L) };
    else if ((r = T.match(/Which party will win the (\d{4}) US presidential election/i))) return { domain: 'uspres-party', eventKey: `uspres-party|${r[1]}`, outcomeKey: partyOf(L), approxOutcome: true, approxNote: 'PredictIt settles on the election result; check its rules vs. the other venue', states: PARTY_STATES };
    else if ((r = T.match(/Who will win the (\d{4}) US presidential election\?/i)) && personKey(L)) { const k = personKey(L); return { domain: 'person', eventKey: `uspres-person|${r[1]}`, outcomeKey: k, approxOutcome: true, approxNote: 'Winner of the election vs. person inaugurated can differ by venue', states: personStates(k) }; }
    else if ((r = T.match(/Who will win the (\d{4}) (Democratic|Republican) presidential nomination\?/i)) && personKey(L)) { const k = personKey(L); return { domain: 'person', eventKey: `nominee|${r[2][0].toLowerCase()}|${r[1]}`, outcomeKey: k, approxOutcome: true, approxNote: 'Nomination timing/definition can differ by venue', states: personStates(k) }; }
  } else if (m.provider === 'polymarket') {
    const q = m.question || '';
    if ((r = q.match(/^Will (?:the |an? )?(Democrats?|Republicans?|independent|Democratic Party|Republican Party) win the (.+?) (Senate|governor) race in (\d{4})/i)) && STATE[r[2].toLowerCase().trim()])
      out = { key: `race|${r[3].toLowerCase() === 'senate' ? 'senate' : 'gov'}|${STATE[r[2].toLowerCase().trim()]}|${r[4]}`, o: partyOf(r[1]) };
    else if ((r = q.match(/^Will the (Democratic|Republican) Party control the (Senate|House) after the (\d{4})/i))) out = { key: `control|${r[2].toLowerCase()}|${r[3]}`, o: partyOf(r[1]) };
    else if ((r = (ev.title || '').match(/^Presidential Election Winner (\d{4})/i)) && personKey(m.label)) { const k = personKey(m.label); return { domain: 'person', eventKey: `uspres-person|${r[1]}`, outcomeKey: k, approxOutcome: true, approxNote: 'Winner of the election vs. person inaugurated can differ by venue', states: personStates(k) }; }
    else if ((r = (ev.title || '').match(/^(Democratic|Republican) Presidential Nominee (\d{4})/i)) && personKey(m.label)) { const k = personKey(m.label); return { domain: 'person', eventKey: `nominee|${r[1][0].toLowerCase()}|${r[2]}`, outcomeKey: k, approxOutcome: true, approxNote: 'Nomination timing/definition can differ by venue', states: personStates(k) }; }
  } else if (m.provider === 'kalshi') {
    const e = m.eventId || '', sfx = (m.id || '').split('-').pop();
    const po = { D: 'd', R: 'r', I: 'i' }[sfx] || partyOf(m.label || '');
    if ((r = e.match(/^SENATE([A-Z]{2})-(\d\d)$/))) out = { key: `race|senate|${r[1].toLowerCase()}|20${r[2]}`, o: po };
    else if ((r = e.match(/^GOVPARTY([A-Z]{2})-(\d\d)$/))) out = { key: `race|gov|${r[1].toLowerCase()}|20${r[2]}`, o: po };
    else if ((r = e.match(/^CONTROL(S|H)-(\d{4})$/))) out = { key: `control|${r[1] === 'S' ? 'senate' : 'house'}|${r[2]}`, o: po };
    else if ((r = e.match(/^KXPRESPERSON-(\d\d)$/)) && personKey(m.label)) { const k = personKey(m.label); return { domain: 'person', eventKey: `uspres-person|20${r[1]}`, outcomeKey: k, approxOutcome: true, approxNote: 'Kalshi settles on the person inaugurated', states: personStates(k) }; }
    else if ((r = e.match(/^KXPRESNOM(D|R)-(\d\d)$/)) && personKey(m.label)) { const k = personKey(m.label); return { domain: 'person', eventKey: `nominee|${r[1].toLowerCase()}|20${r[2]}`, outcomeKey: k, approxOutcome: true, approxNote: 'Nomination timing/definition can differ by venue', states: personStates(k) }; }
  }
  if (!out || !out.o) return null;
  return { domain: 'race', eventKey: out.key, outcomeKey: out.o, approxOutcome: true, approxNote: RACE_NOTE, states: PARTY_RACE_STATES };
}

// ---------- generic binary ----------
const SOURCE_RE = /\b(associated press|ap\b|binance|coinbase|cf benchmarks|chainlink|kraken|bloomberg|reuters|bls|bureau of labor statistics|bea|federal reserve|fred|noaa|national weather service|nws|usgs|espn|fox sports|nhl\.com|mlb\.com|nba\.com|nfl\.com|official statistics|cnn|nyt|new york times|polymarket|kalshi|truth social|x\.com|twitter|youtube|spotify|billboard|box office mojo|rotten tomatoes|imdb|wikipedia|google trends|lmarena|livebench|openrouter|tradingview|yahoo finance|nasdaq|nyse)\b/g;
const GEO_RE = /\b(new york|nyc|los angeles|chicago|miami|austin|denver|houston|philadelphia|seattle|boston|washington|dc|london|paris|tokyo|seoul|shanghai|beijing|hong kong|singapore|moscow|ankara|taipei|toronto|mexico|canada|china|russia|ukraine|iran|israel|gaza|india|japan|uk|united kingdom|france|germany|brazil|california|texas|florida|global|worldwide|us\b|united states)\b/g;
const DATE_RE = /\b(jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|june?|july?|aug(?:ust)?|sept?(?:ember)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?)\.?\s+(\d{1,2})(?:st|nd|rd|th)?(?:,?\s+(20\d\d))?\b/g;

export function explicitDates(text, refTime) {
  const out = new Set();
  const t = normText(text);
  let m;
  DATE_RE.lastIndex = 0;
  while ((m = DATE_RE.exec(t))) {
    const mo = MONTHS[m[1].slice(0, 3)];
    let y = m[3] ? +m[3] : null;
    if (!y) {
      const ref = refTime || Date.now();
      const y0 = new Date(ref).getUTCFullYear();
      y = [y0 - 1, y0, y0 + 1].sort((a, b) => Math.abs(Date.UTC(a, mo - 1, +m[2]) - ref) - Math.abs(Date.UTC(b, mo - 1, +m[2]) - ref))[0];
    }
    out.add(`${y}-${String(mo).padStart(2, '0')}-${String(+m[2]).padStart(2, '0')}`);
  }
  for (const mm of t.matchAll(/\b(20\d\d)-(\d\d)-(\d\d)\b/g)) out.add(mm[0]);
  return [...out].sort();
}

const uniq = (xs) => [...new Set(xs)].sort();
const firstSentences = (s) => normText(s).split(/(?<=\.)\s/).slice(0, 4).join(' ');

/** The full statement a binary pays on: event title + question + outcome label (Kalshi titles alone are often shared by every market in an event). */
export function contractText(m) {
  const parts = [m.eventTitle || '', m.question];
  // Kalshi's yes_sub_title IS the outcome identity (titles are often shared by every market in an event)
  if (m.label && (m.provider === 'kalshi' || !normText(m.question).includes(normText(m.label)))) parts.push(`[${m.label}]`);
  if (!m.isYesNo) parts.push(`[${m.yesOutcome}]`);
  return parts.filter(Boolean).join(' :: ');
}

function genericSpec(m) {
  const text = contractText(m);
  const ref = Date.parse(m.endDate);
  const { slots, template } = templatize(text, Number.isFinite(ref) ? ref : undefined);
  const num = slots.filter((s) => s.type === 'N');
  let comparator = null;
  if (/(above|over|more than|greater than|at least|or more|or higher|\+)/.test(template)) comparator = '>';
  else if (/(below|under|less than|fewer than|at most|or less|or lower)/.test(template)) comparator = '<';
  return {
    domain: 'binary', eventKey: 'q|' + canonQuestion(text), outcomeKey: 'Y',
    comparator, threshold: num.length === 1 ? num[0].value : null,
    states: [{ key: 'Y', label: 'Event happens', tail: false }, { key: 'N', label: "Event doesn't happen", tail: false }],
    // the parts of the rules that actually define the event (first sentences), for same-rules checks
    ruleCore: firstSentences(m.rules || ''),
  };
}

/** Build a MarketSpec. `ev` is the market's event; `eventMarkets` its sibling markets. */
export function buildSpec(m, ev = {}, eventMarkets = []) {
  let d = null;
  if (m.provider === 'polymarket') d = pmGameSpec(m, ev) || pmFomcSpec(m, ev) || pmPartySpec(m, ev) || raceSpec(m, ev);
  else if (m.provider === 'kalshi') d = kalshiGameSpec(m, ev, eventMarkets) || kalshiFomcSpec(m) || kalshiPartySpec(m) || raceSpec(m, ev);
  else if (m.provider === 'predictit') d = raceSpec(m, ev);
  else if (m.provider === 'polymarket-us') d = pmusGameSpec(m);
  if (!d) d = genericSpec(m);
  const rules = m.rules || '';
  const ref = Date.parse(m.endDate);
  const text = `${m.question} ${rules}`;
  return {
    marketId: m.id, provider: m.provider, approxOutcome: false, settlement: {}, ...d,
    windowEnd: Number.isFinite(ref) ? ref : null,
    dateKey: d.dateKey || etDate(ref),
    ruleDates: explicitDates(`${m.question} ${rules.split(/\n\s*\n/)[0] || ''}`, Number.isFinite(ref) ? ref : undefined),
    sources: uniq([...(normText(text).match(SOURCE_RE) || []), ...((m.sources || []).map((s) => normText(s)))]),
    geo: uniq(normText(m.question).match(GEO_RE) || []),
    rulesHash: m.descriptionHash || null,
  };
}

export { MONTH_NAMES };
