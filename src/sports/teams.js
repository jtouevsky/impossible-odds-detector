// Canonical team identities. Phase 1 covers the NFL fully; other leagues fall back to venue codes.
// canonical code: [nickname, city, ...aliases (venue-specific codes)]
const NFL = {
  ari: ['cardinals', 'arizona'], atl: ['falcons', 'atlanta'], bal: ['ravens', 'baltimore'], buf: ['bills', 'buffalo'],
  car: ['panthers', 'carolina'], chi: ['bears', 'chicago'], cin: ['bengals', 'cincinnati'], cle: ['browns', 'cleveland'],
  dal: ['cowboys', 'dallas'], den: ['broncos', 'denver'], det: ['lions', 'detroit'], gb: ['packers', 'green bay', 'gnb'],
  hou: ['texans', 'houston'], ind: ['colts', 'indianapolis'], jac: ['jaguars', 'jacksonville', 'jax'], kc: ['chiefs', 'kansas city', 'kan'],
  lv: ['raiders', 'las vegas', 'lvr'], lac: ['chargers', 'los angeles c', 'la chargers'], lar: ['rams', 'los angeles r', 'la', 'la rams'],
  mia: ['dolphins', 'miami'], min: ['vikings', 'minnesota'], ne: ['patriots', 'new england', 'nwe'], no: ['saints', 'new orleans', 'nor'],
  nyg: ['giants', 'new york g'], nyj: ['jets', 'new york j'], phi: ['eagles', 'philadelphia'], pit: ['steelers', 'pittsburgh'],
  sf: ['49ers', 'san francisco', 'sfo'], sea: ['seahawks', 'seattle'], tb: ['buccaneers', 'tampa bay', 'tam'], ten: ['titans', 'tennessee'],
  was: ['commanders', 'washington', 'wsh'],
};
const NFL_LOOKUP = new Map();
for (const [code, names] of Object.entries(NFL)) {
  NFL_LOOKUP.set(code, code);
  for (const n of names) NFL_LOOKUP.set(n, code);
}
const clean = (s) => String(s || '').toLowerCase().replace(/[^a-z0-9 ]/g, ' ').replace(/\s+/g, ' ').trim();

/** NFL team code from a venue code, nickname, city or full name ("Indianapolis Colts", "IND", "New York J"). */
export function nflCode(x) {
  const s = clean(x);
  if (!s) return null;
  if (NFL_LOOKUP.has(s)) return NFL_LOOKUP.get(s);
  const words = s.split(' ');
  const nick = words[words.length - 1];
  if (NFL_LOOKUP.has(nick) && NFL[NFL_LOOKUP.get(nick)][0] === nick) return NFL_LOOKUP.get(nick);
  // "New York J" / "Los Angeles C" style labels
  for (const k of [s, words.slice(0, 3).join(' ')]) if (NFL_LOOKUP.has(k)) return NFL_LOOKUP.get(k);
  return null;
}

export const nflName = (code) => (NFL[code] ? NFL[code][0][0].toUpperCase() + NFL[code][0].slice(1) : code?.toUpperCase());

/** League-aware code normalisation used by every venue's game spec. */
export function teamCode(league, code, name) {
  if (league === 'nfl') return nflCode(code) || nflCode(name) || null;
  return code ? clean(code).replace(/ /g, '') : null;
}
