// Game state: the verified score a relationship is derived from, with provider time and local receipt time kept apart.
import { hashString } from '../providers/schema.js';
import { nflCode } from '../sports/teams.js';

const code = (league, t) => (league === 'nfl' ? nflCode(t.abbreviation) || nflCode(t.name) : null) || (t.abbreviation || '').toLowerCase();

/**
 * Polymarket US event → GameState. The score string ("30-13") has no team order, so we only trust it when the
 * per-period scores (keyed by team id) add up to the same numbers.
 */
export function stateFromPMUS(ev, league, receivedAt = Date.now()) {
  const es = ev.eventState || {};
  const teams = (ev.teams || []).map((t) => ({ id: String(t.id), code: code(league, t), name: t.name }));
  const issues = [];
  const live = !!(es.live ?? ev.live), ended = !!(es.ended ?? ev.ended);
  const period = es.period ?? ev.period ?? null;
  const providerTime = es.updatedAt || ev.updatedAt || null;
  let scores = null;
  if (teams.length !== 2 || teams.some((t) => !t.code)) issues.push('teams not identified');
  else if (period === 'NS' && !live && !ended) scores = Object.fromEntries(teams.map((t) => [t.code, 0])); // not started
  else {
    const sums = Object.fromEntries(teams.map((t) => [t.code, 0]));
    let seen = 0;
    for (const p of es.periodScores || []) for (const s of p.scores || []) {
      const t = teams.find((x) => x.id === String(s.competitorId));
      if (t && Number.isInteger(s.score)) { sums[t.code] += s.score; seen++; }
    }
    const str = (es.score ?? ev.score ?? '').match(/^(\d+)-(\d+)$/);
    if (!seen) issues.push('no per-team period scores (score string alone has no team order)');
    else if (str && [+str[1], +str[2]].sort((x, y) => x - y).join() !== Object.values(sums).sort((x, y) => x - y).join()) issues.push(`score string ${str[0]} disagrees with period scores`);
    else scores = sums;
  }
  return finalize({ eventSlug: ev.slug, league, title: ev.title, teams, scores, period, live, ended, providerTime, receivedAt, source: 'live', issues });
}

/** Manual / replay / fixture states. They can never feed the executable feed. */
export function manualState({ eventSlug, league, teams, scores, period = null, source = 'manual', providerTime = null, receivedAt = Date.now(), title = null }) {
  return finalize({ eventSlug, league, title, teams: teams.map((c) => ({ id: c, code: c, name: c.toUpperCase() })), scores, period, live: true, ended: false,
    providerTime: providerTime || new Date(receivedAt).toISOString(), receivedAt, source, issues: [] });
}

function finalize(s) {
  s.verified = s.source === 'live' && !!s.scores && !s.issues.length && !s.ended;
  s.version = hashString(`${s.eventSlug}|${JSON.stringify(s.scores)}|${s.period}|${s.providerTime}`);
  return s;
}

export const scoreText = (s) => (s?.scores ? s.teams.map((t) => `${t.code.toUpperCase()} ${s.scores[t.code]}`).join(' – ') : 'score unknown');

/** Keeps the latest state per game and detects score corrections (a score going DOWN). */
export class StateStore {
  constructor({ correctionHoldMs = 10 * 60e3 } = {}) { this.byEvent = new Map(); this.correctionHoldMs = correctionHoldMs; }
  update(state) {
    const prev = this.byEvent.get(state.eventSlug);
    let corrected = prev?.correctedAt ?? null;
    if (prev?.state?.scores && state.scores && Object.keys(state.scores).some((k) => state.scores[k] < (prev.state.scores[k] ?? 0))) corrected = state.receivedAt;
    const changed = !prev || prev.state.version !== state.version;
    this.byEvent.set(state.eventSlug, { state, correctedAt: corrected, prevVersion: prev?.state?.version ?? null });
    return { changed, corrected: corrected != null && corrected === state.receivedAt, correctedAt: corrected };
  }
  get(slug) { return this.byEvent.get(slug) || null; }
  recentlyCorrected(slug, now = Date.now()) { const e = this.byEvent.get(slug); return !!(e?.correctedAt && now - e.correctedAt < this.correctionHoldMs); }
}
