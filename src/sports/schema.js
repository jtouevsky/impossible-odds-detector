// Shared sports schema + strict "same bet?" matching.
//
// SportsQuote = {
//   id, source, venue, venueName, venueKind: 'sportsbook' | 'prediction' | 'dfs', fixture?: true (test data only),
//   sport, league, eventKey, event: { title, home, away, start }, participants: [code, code],
//   market: { type: 'moneyline'|'spread'|'total'|'player_prop'|'team_prop', period: 'game'|'1h'|'2h'|'q1'..,
//             statistic, player, team, line, side },          // side: team code | 'draw' | 'over' | 'under'
//   price: { kind: 'odds', decimal, american, implied } | { kind: 'exchange', ask, askSize, bid, feePerShare },
//   timestamp, url, marketId?, provider?,
//   rules: { overtime: 'included'|'excluded'|null, tie: number|'push'|'lose'|null, push: 'refund'|null,
//            cancellation: 'void'|'fair-price'|number|null, participation: string|null,
//            source: 'venue-text'|'assumed-house-rules'|'unknown', version: string|null, text?: string }
// }
import { hashString } from '../providers/schema.js';

export const STATUS = { VERIFIED: 'VERIFIED', LIKELY: 'LIKELY', MISMATCH: 'MISMATCH' };

/** Everything that defines WHICH bet it is, except the side. Two quotes with different keys are different bets. */
export function contractKey(q) {
  const m = q.market;
  return [q.league, q.eventKey, m.type, m.period, m.statistic || '', (m.player || '').toLowerCase(), m.team || '', m.line == null ? '' : +m.line].join('|');
}
export const outcomeKey = (q) => `${contractKey(q)}|${q.market.side}`;
export const ruleVersion = (text) => (text ? hashString(String(text).replace(/\s+/g, ' ').trim().toLowerCase()) : null);

/** The outcomes that make a complete, mutually exclusive set for this contract (needed for margin removal). */
export function outcomeSet(q) {
  const m = q.market;
  if (m.type === 'moneyline') return q.threeWay ? [...q.participants, 'draw'] : [...q.participants];
  if (m.type === 'total' || m.type === 'player_prop' || m.type === 'team_prop') return ['over', 'under'];
  if (m.type === 'spread') return [...q.participants];
  return null;
}

const show = (v) => (v == null ? 'not stated' : typeof v === 'number' ? (v === 0.5 ? '$0.50 (half)' : `$${v.toFixed(2)}`) : String(v));

/**
 * Strict comparison of two quotes for the SAME outcome. Similar names are not enough:
 * event, period, statistic, player, line and side must be identical; overtime, tie/push, cancellation and
 * participation rules must be stated on both sides to reach VERIFIED. Missing rules = LIKELY (uncertain).
 */
export function matchQuotes(a, b) {
  const checks = [];
  const add = (field, va, vb, result, note = '') => checks.push({ field, a: va, b: vb, result, note });
  const ma = a.market, mb = b.market;
  add('Event', a.eventKey, b.eventKey, a.eventKey === b.eventKey ? 'ok' : 'fail', a.eventKey === b.eventKey ? '' : 'different game');
  add('Market type', ma.type, mb.type, ma.type === mb.type ? 'ok' : 'fail');
  add('Period', ma.period, mb.period, ma.period === mb.period ? 'ok' : 'fail', ma.period === mb.period ? '' : 'different period = different bet');
  if (ma.statistic || mb.statistic) add('Statistic', ma.statistic, mb.statistic, ma.statistic === mb.statistic ? 'ok' : 'fail');
  if (ma.player || mb.player) add('Player', ma.player, mb.player, (ma.player || '').toLowerCase() === (mb.player || '').toLowerCase() ? 'ok' : 'fail');
  const la = ma.line == null ? null : +ma.line, lb = mb.line == null ? null : +mb.line;
  if (la != null || lb != null) add('Line', la, lb, la === lb ? 'ok' : 'fail', la === lb ? '' : 'different line = different bet');
  add('Side', ma.side, mb.side, ma.side === mb.side ? 'ok' : 'fail');

  const ra = a.rules || {}, rb = b.rules || {};
  const rule = (field, va, vb, why) => {
    if (va == null || vb == null) return add(field, show(va), show(vb), 'warn', `${why}: not stated on ${va == null && vb == null ? 'either side' : va == null ? a.venueName : b.venueName}`);
    add(field, show(va), show(vb), va === vb ? 'ok' : 'warn', va === vb ? '' : `${why} differs`);
  };
  rule('Overtime', ra.overtime, rb.overtime, 'overtime treatment');
  if (ma.type === 'moneyline' && !a.threeWay) rule('Tie / push', ra.tie, rb.tie, 'tie handling');
  if (ma.type !== 'moneyline' && la != null && Number.isInteger(la)) rule('Push on exact line', ra.push, rb.push, 'push handling');
  rule('Postponement / cancellation', ra.cancellation, rb.cancellation, 'cancellation handling');
  if (ma.type === 'player_prop') rule('Player participation', ra.participation, rb.participation, 'did-not-play handling');
  for (const [q, side] of [[a, 'A'], [b, 'B']])
    if ((q.rules || {}).source !== 'venue-text') add(`Rules source (${side})`, q.venueName, q.rules?.source || 'unknown', 'warn', q.rules?.source === 'assumed-house-rules' ? 'feed has no rule text — standard house rules assumed' : 'no rule text');

  const status = checks.some((c) => c.result === 'fail') ? STATUS.MISMATCH : checks.some((c) => c.result === 'warn') ? STATUS.LIKELY : STATUS.VERIFIED;
  return { status, checks };
}
