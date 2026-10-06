// End-to-end pipeline: snapshot -> relationships -> rule checks -> scored, ranked violations.
import { detectors as defaultDetectors } from './detectors/index.js';
import { evaluate } from './rules.js';
import { quality } from './scoring.js';
import { candidatePairs } from './classifier.js';

export const MIN_VIOLATION = 0.005; // below half a point is rounding noise

export function buildContext(snapshot) {
  const markets = snapshot.markets.filter((m) => m && m.acceptingOrders !== false);
  const byId = new Map(markets.map((m) => [m.id, m]));
  const byEvent = new Map();
  for (const m of markets) {
    let a = byEvent.get(m.eventId);
    if (!a) byEvent.set(m.eventId, (a = []));
    a.push(m);
  }
  const events = snapshot.events
    .map((e) => ({ ...e, marketIds: e.marketIds.filter((id) => byId.has(id)) }))
    .filter((e) => e.marketIds.length);
  const eventsById = new Map(events.map((e) => [e.id, e]));
  return { markets, byId, byEvent, events, eventsById };
}

const relKey = (r) => r.members ? 'set|' + r.members.slice().sort().join('|') : r.type + '|' + [r.a, r.b].sort().join('|');

export async function runPipeline(snapshot, { detectors = defaultDetectors, classifier = null, minViolation = MIN_VIOLATION, specPairs = null } = {}) {
  const t0 = Date.now();
  const ctx = buildContext(snapshot);
  if (specPairs) ctx.specPairs = specPairs;
  const relationships = [];
  const seen = new Set();
  const byDetector = {};
  for (const d of detectors) {
    let rels = [];
    try { rels = d.detect(ctx) || []; } catch (err) { console.error(`detector ${d.id} failed`, err); }
    byDetector[d.id] = 0;
    for (const r of rels) {
      const k = relKey(r);
      if (seen.has(k)) continue; // first (most specific) detector wins
      seen.add(k); relationships.push(r); byDetector[d.id]++;
    }
  }
  if (classifier) {
    try {
      const linked = new Set(relationships.filter((r) => !r.members).map((r) => [r.a, r.b].sort().join('|')));
      const extra = await classifier.classifyPairs(candidatePairs(ctx, linked));
      for (const r of extra || []) if (!seen.has(relKey(r))) { seen.add(relKey(r)); relationships.push({ ...r, detector: classifier.id }); }
    } catch (err) { console.error('classifier failed', err); }
  }

  const violations = [];
  const ladderCount = new Map();
  for (const rel of relationships) {
    const ev = evaluate(rel, ctx.byId);
    if (!ev || !(ev.magnitude >= minViolation)) continue;
    const q = quality(rel, ev);
    const legs = ev.legs;
    const event = ctx.eventsById.get(rel.eventId || legs[0].eventId);
    violations.push({
      id: relKey(rel),
      type: rel.type, subtype: rel.subtype || null, detector: rel.detector,
      relConfidence: rel.confidence, rationale: rel.rationale,
      a: ev.A || null, b: ev.B || null, legs, event: event || null,
      sum: ev.sum ?? null, direction: ev.direction || null, trade: ev.trade,
      magnitude: ev.magnitude, edge: ev.edge,
      category: (ev.A || legs[0]).category || 'Other',
      groupKey: rel.groupKey || null,
      ...q,
    });
  }

  // A single mispriced rung in a ladder creates many overlapping pairs: keep the best two per ladder.
  violations.sort((x, y) => y.score - x.score);
  const final = [];
  for (const v of violations) {
    if (v.groupKey) {
      const n = ladderCount.get(v.groupKey) || 0;
      ladderCount.set(v.groupKey, n + 1);
      if (n >= 2) continue;
    }
    final.push(v);
  }
  for (const v of final) if (v.groupKey) v.ladderPeers = ladderCount.get(v.groupKey) - 1;

  const largest = final.reduce((best, v) => (!best || v.magnitude > best.magnitude ? v : best), null);
  return {
    stats: {
      markets: ctx.markets.length, events: ctx.events.length,
      relationships: relationships.length, byDetector,
      violations: final.length, executable: final.filter((v) => v.executable).length,
      largest, ms: Date.now() - t0,
    },
    violations: final,
    relationships,
  };
}
