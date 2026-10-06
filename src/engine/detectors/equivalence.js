// Equivalent contracts: the same question listed twice (often once inside a multi-outcome event and
// once as a standalone market). Matching is deliberately strict: identical canonical wording, not a
// single-game prop (those reuse generic wording like "Game 1: Both teams slay a dragon?"), and close
// resolution dates.
import { canonQuestion } from '../text.js';

export const equivalenceDetector = {
  id: 'equivalence',
  name: 'Duplicate / equivalent contracts',
  detect(ctx) {
    // Preferred path: MarketSpec comparisons computed upstream (src/spec). Only VERIFIED/LIKELY pairs count,
    // so identical wording with a different window/date/threshold is never "equivalent".
    if (ctx.specPairs) {
      return ctx.specPairs.filter((p) => p.status !== 'MISMATCH' && ctx.byId.has(p.a.marketId) && ctx.byId.has(p.b.marketId)).map((p) => ({
        type: 'equivalent', a: p.a.marketId, b: p.b.marketId, detector: 'equivalence',
        confidence: p.status === 'VERIFIED' ? 0.97 : 0.75,
        subtype: p.a.provider !== p.b.provider ? 'cross-venue' : p.status === 'VERIFIED' ? 'identical' : 'same-wording',
        rationale: p.status === 'VERIFIED'
          ? 'Settlement specs match field by field (event, outcome, window, dates, rules), so both contracts resolve the same way.'
          : `Same underlying event and outcome, but: ${p.checks.filter((c) => c.result === 'warn').map((c) => c.note || c.field).join('; ')}.`,
      }));
    }
    const groups = new Map();
    for (const m of ctx.markets) {
      if (m.isGame) continue;
      const text = m.isYesNo ? m.question : `${m.question} [${m.yesOutcome}]`;
      const k = canonQuestion(text);
      if (k.length < 20 || k.split(' ').length < 5) continue;
      let g = groups.get(k);
      if (!g) groups.set(k, (g = []));
      g.push(m);
    }
    const rels = [];
    for (const g of groups.values()) {
      if (g.length < 2 || g.length > 6) continue;
      for (let i = 0; i < g.length; i++) {
        for (let j = i + 1; j < g.length; j++) {
          const a = g[i], b = g[j];
          if (a.conditionId && a.conditionId === b.conditionId) continue;
          const ta = Date.parse(a.endDate), tb = Date.parse(b.endDate);
          const datesKnown = Number.isFinite(ta) && Number.isFinite(tb);
          if (!datesKnown || Math.abs(ta - tb) > 3600e3) continue; // different windows are different events
          const sameRules = a.descriptionHash === b.descriptionHash;
          rels.push({
            type: 'equivalent', a: a.id, b: b.id, detector: 'equivalence',
            confidence: sameRules ? 0.97 : datesKnown ? 0.88 : 0.82,
            subtype: sameRules ? 'identical' : 'same-wording',
            rationale: sameRules
              ? 'Both contracts ask the identical question with identical resolution rules, so they must resolve the same way.'
              : 'Both contracts ask the identical question and resolve around the same time. Their rule text differs slightly, so check the fine print before trading.',
          });
        }
      }
    }
    return rels;
  },
};
