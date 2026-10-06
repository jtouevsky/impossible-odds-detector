// Sports odds feed: The Odds API (https://the-odds-api.com/liveapi/guides/v4/)
//
// Why this feed: its FREE plan (500 credits/month, no card) covers DraftKings, FanDuel, BetMGM (region "us"),
// Pinnacle (region "eu") and PrizePicks/Underdog (region "us_dfs", player props only). Caesars
// (williamhill_us) is listed as paid-plan only — requested, but it simply won't appear on a free key.
// SportsGameOdds' free tier (2.5k objects/month, 10-min updates) has no Pinnacle and no DFS.
//
//   GET https://api.the-odds-api.com/v4/sports/{sport}/odds?apiKey&regions|bookmakers&markets&oddsFormat=decimal
//   GET https://api.the-odds-api.com/v4/sports/{sport}/events/{id}/odds   (player props / DFS)
//   cost per call = markets × regions ("every group of 10 bookmakers = 1 region"); headers x-requests-remaining/used/last
//
// Needs a free key: set ODDS_API_KEY or paste it in Venues → Sports odds.
import { americanToDecimal, decimalToAmerican, impliedFromDecimal } from './odds.js';
import { teamCode, nflName } from './teams.js';
import { ruleVersion } from './schema.js';

export const ODDS_API = 'https://api.the-odds-api.com/v4';
export const BOOKS = { draftkings: 'DraftKings', fanduel: 'FanDuel', betmgm: 'BetMGM', williamhill_us: 'Caesars', pinnacle: 'Pinnacle', prizepicks: 'PrizePicks', underdog: 'Underdog' };
export const DFS_BOOKS = new Set(['prizepicks', 'underdog']);
export const SPORT_LEAGUE = { americanfootball_nfl: { sport: 'football', league: 'nfl', threeWay: false } };

export const CONFIG = () => ({
  sports: (process.env.ODDS_SPORTS || 'americanfootball_nfl').split(',').map((s) => s.trim()).filter((s) => SPORT_LEAGUE[s]),
  markets: (process.env.ODDS_MARKETS || 'h2h').split(',').map((s) => s.trim()).filter(Boolean),
  bookmakers: (process.env.ODDS_BOOKMAKERS || 'draftkings,fanduel,betmgm,williamhill_us,pinnacle').split(',').map((s) => s.trim()),
  refreshMin: +(process.env.ODDS_REFRESH_MIN || 120),
  props: process.env.ODDS_PROPS === '1',
  propMarkets: (process.env.ODDS_PROP_MARKETS || 'player_pass_tds').split(',').map((s) => s.trim()),
  propEvents: +(process.env.ODDS_PROP_EVENTS || 3),
  minRemaining: +(process.env.ODDS_MIN_REMAINING || 20),
});

const ET = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/New_York', year: 'numeric', month: '2-digit', day: '2-digit' });
export const etDay = (iso) => { const t = Date.parse(iso); return Number.isFinite(t) ? ET.format(new Date(t)) : null; };

// Standard US sportsbook house rules. NOT in the feed → source 'assumed-house-rules' → matching stays LIKELY.
const HOUSE_RULES = {
  moneyline: { overtime: 'included', tie: 'push', push: null, cancellation: 'void' },
  spread: { overtime: 'included', tie: null, push: 'refund', cancellation: 'void' },
  total: { overtime: 'included', tie: null, push: 'refund', cancellation: 'void' },
  player_prop: { overtime: 'included', tie: null, push: 'refund', cancellation: 'void', participation: null },
};

const MARKET_TYPE = (key) => {
  const base = key.replace(/_(h1|h2|q1|q2|q3|q4|p1|p2|p3)$/, '').replace(/_alternate$/, '');
  const period = (key.match(/_(h1|h2|q1|q2|q3|q4)$/) || [])[1];
  const P = { h1: '1h', h2: '2h', q1: 'q1', q2: 'q2', q3: 'q3', q4: 'q4' };
  if (base === 'h2h') return { type: 'moneyline', statistic: 'winner', period: P[period] || 'game' };
  if (base === 'spreads') return { type: 'spread', statistic: 'margin', period: P[period] || 'game' };
  if (base === 'totals') return { type: 'total', statistic: 'points', period: P[period] || 'game' };
  if (base.startsWith('player_')) return { type: 'player_prop', statistic: base.slice(7), period: 'game' };
  if (base.startsWith('team_totals')) return { type: 'team_prop', statistic: 'points', period: P[period] || 'game' };
  return null;
};

/** Normalise one feed event (as documented) into SportsQuotes. Unknown teams / markets are skipped, never guessed. */
export function normalizeOddsEvent(ev, { fixture = false } = {}) {
  const meta = SPORT_LEAGUE[ev.sport_key];
  if (!meta) return [];
  const home = teamCode(meta.league, null, ev.home_team), away = teamCode(meta.league, null, ev.away_team);
  if (!home || !away) return [];
  const day = etDay(ev.commence_time);
  const codes = [home, away].sort();
  const eventKey = `game|${meta.league}|${day}|${codes.join('-')}`;
  const nameToSide = (n) => (n === 'Draw' ? 'draw' : /^over$/i.test(n) ? 'over' : /^under$/i.test(n) ? 'under' : teamCode(meta.league, null, n));
  const out = [];
  for (const bk of ev.bookmakers || []) {
    const kind = DFS_BOOKS.has(bk.key) ? 'dfs' : 'sportsbook';
    for (const mk of bk.markets || []) {
      const t = MARKET_TYPE(mk.key);
      if (!t) continue;
      for (const o of mk.outcomes || []) {
        const side = nameToSide(o.name);
        if (!side) continue;
        const decimal = o.price > 1 ? +o.price : americanToDecimal(o.price);
        const player = t.type === 'player_prop' ? o.description || null : null;
        const line = t.type === 'moneyline' ? null : o.point ?? null;
        if (t.type !== 'moneyline' && line == null && kind !== 'dfs') continue;
        const house = HOUSE_RULES[t.type] || {};
        out.push({
          id: `odds:${ev.id}:${bk.key}:${mk.key}:${o.name}:${player || ''}:${line ?? ''}`, source: 'the-odds-api', fixture,
          venue: bk.key, venueName: BOOKS[bk.key] || bk.title, venueKind: kind,
          sport: meta.sport, league: meta.league, eventKey, threeWay: meta.threeWay,
          event: { title: `${ev.away_team} @ ${ev.home_team}`, home, away, start: ev.commence_time, feedId: ev.id },
          participants: codes,
          market: { type: t.type, period: t.period, statistic: t.statistic, player, team: null,
            line: t.type === 'spread' && line != null ? (side === codes[0] ? line : -line) + 0 : line, rawLine: line, side, feedKey: mk.key },
          price: kind === 'dfs' ? { kind: 'projection', decimal: decimal || null } : { kind: 'odds', decimal, american: decimalToAmerican(decimal), implied: impliedFromDecimal(decimal) },
          timestamp: mk.last_update || bk.last_update, url: o.link || mk.link || bk.link || null,
          rules: { ...house, source: kind === 'dfs' ? 'unknown' : 'assumed-house-rules', version: ruleVersion(`${bk.key}:${t.type}:house-v1`) },
        });
      }
    }
  }
  return out;
}


export class OddsFeed {
  constructor({ getKey, cache, fetch: fetchImpl = globalThis.fetch } = {}) {
    this.getKey = getKey; this.cache = cache || { data: null, save() {} }; this.fetch = fetchImpl;
  }

  status() {
    const c = this.cache.data;
    const key = this.getKey();
    if (!key) return { state: 'needs-setup', reason: 'Add a free The Odds API key (the-odds-api.com) to compare sportsbook odds.', quota: null };
    if (c?.error && !c?.events?.length) return { state: 'unavailable', reason: c.error, quota: c.quota || null, lastSuccess: c.lastSuccess || null };
    if (!c?.events) return { state: 'pending', reason: 'Not synced yet.', quota: null };
    const books = new Set(c.events.flatMap((e) => (e.bookmakers || []).map((b) => b.key)));
    return { state: books.size ? (c.quota?.remaining != null && c.quota.remaining < CONFIG().minRemaining ? 'partial' : 'live') : 'partial',
      reason: books.size ? (c.error ? `Using last good data: ${c.error}` : '') : 'Feed returned no bookmaker prices for the configured sports.',
      quota: c.quota || null, lastSuccess: c.lastSuccess, events: c.events.length, books: [...books], error: c.error || null };
  }

  async sync({ force = false } = {}) {
    const key = this.getKey();
    const cfg = CONFIG();
    const c = this.cache.data || {};
    if (!key) return this.status();
    if (!force && c.lastSuccess && Date.now() - Date.parse(c.lastSuccess) < cfg.refreshMin * 60e3 && c.keyHash === keyHash(key)) return this.status();
    if (c.quota?.remaining != null && c.quota.remaining < cfg.minRemaining && !force) {
      this.cache.data = { ...c, error: `Free quota nearly used (${c.quota.remaining} credits left) — keeping last data.` }; this.cache.save();
      return this.status();
    }
    const events = [];
    let quota = c.quota || null, error = null;
    for (const sport of cfg.sports) {
      try {
        const u = new URL(`${ODDS_API}/sports/${sport}/odds`);
        u.searchParams.set('apiKey', key);
        u.searchParams.set('bookmakers', cfg.bookmakers.join(','));
        u.searchParams.set('markets', cfg.markets.join(','));
        u.searchParams.set('oddsFormat', 'decimal');
        u.searchParams.set('dateFormat', 'iso');
        u.searchParams.set('includeLinks', 'true');
        const r = await this.fetch(u, { signal: AbortSignal.timeout(20000) });
        quota = readQuota(r.headers) || quota;
        if (r.status === 401) throw new Error('Invalid or expired The Odds API key (HTTP 401).');
        if (r.status === 429) throw new Error('The Odds API quota or rate limit reached (HTTP 429).');
        if (!r.ok) throw new Error(`The Odds API HTTP ${r.status}`);
        const list = await r.json();
        events.push(...list.filter((e) => Date.parse(e.commence_time) > Date.now())); // pregame only
        if (cfg.props) for (const e of list.slice(0, cfg.propEvents)) {
          const pu = new URL(`${ODDS_API}/sports/${sport}/events/${e.id}/odds`);
          pu.searchParams.set('apiKey', key); pu.searchParams.set('regions', 'us,us_dfs'); pu.searchParams.set('markets', cfg.propMarkets.join(','));
          pu.searchParams.set('oddsFormat', 'decimal'); pu.searchParams.set('includeLinks', 'true');
          const pr = await this.fetch(pu, { signal: AbortSignal.timeout(20000) });
          quota = readQuota(pr.headers) || quota;
          if (pr.ok) { const pe = await pr.json(); const tgt = events.find((x) => x.id === e.id); if (tgt) tgt.bookmakers = mergeBooks(tgt.bookmakers, pe.bookmakers); }
        }
      } catch (err) { error = err.message; }
    }
    if (events.length || !error) this.cache.data = { events, quota, lastSuccess: new Date().toISOString(), error, keyHash: keyHash(key) };
    else this.cache.data = { ...c, quota, error };
    this.cache.save();
    return this.status();
  }

  quotes() { return (this.cache.data?.events || []).flatMap((e) => normalizeOddsEvent(e)); }
}

function mergeBooks(a = [], b = []) {
  const by = new Map(a.map((x) => [x.key, { ...x, markets: [...x.markets] }]));
  for (const x of b) { const t = by.get(x.key); if (t) t.markets.push(...x.markets); else by.set(x.key, x); }
  return [...by.values()];
}
const readQuota = (h) => {
  const rem = h?.get?.('x-requests-remaining');
  return rem == null ? null : { remaining: +rem, used: +(h.get('x-requests-used') || 0), last: +(h.get('x-requests-last') || 0), at: new Date().toISOString() };
};
const keyHash = (k) => (k ? `${k.length}:${k.slice(-4)}` : null);
export { nflName };
