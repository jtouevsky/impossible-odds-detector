// Explicit state-space evaluation for nested threshold / deadline contracts.
//
// Each contract is parsed INDEPENDENTLY into a condition on one underlying quantity
// ("value ≥ 75B", "value ≤ 70B", "happens by Jun 30"). The real line is then cut into regions at every
// threshold (plus the exact boundary points, where "above" vs "at least" wording is ambiguous), and every
// candidate basket is scored in every region. A basket with a region where all legs lose (a dead zone)
// can never be called arbitrage — regardless of what any detector claimed about the relationship.
import { templatize } from '../engine/text.js';
import { slotDirection, NEGATED } from '../engine/detectors/ladder.js';
import { strikeConsistent } from '../providers/kalshi.js';

export const ladderText = (m) => (m.isYesNo ? m.question : `${m.question} [${m.yesOutcome}]`) + (m.provider === 'kalshi' && m.label ? ` :: ${m.label}` : '');

const fmtNum = (v) => (Math.abs(v) >= 1e9 ? `${+(v / 1e9).toFixed(3)}B` : Math.abs(v) >= 1e6 ? `${+(v / 1e6).toFixed(3)}M` : Math.abs(v) >= 1e4 ? v.toLocaleString('en-US') : String(+v.toFixed(6)));
const fmtDate = (t) => new Date(t).toISOString().slice(0, 10);

/**
 * Condition for one contract, relative to a partner contract (they must differ in exactly one slot).
 * Returns { kind: 'N'|'D', op: 'ge'|'le', t, strict: null|true|false, negated, raw } or null.
 *   op 'ge': YES when value ≥ t (or > t)      op 'le': YES when value ≤ t (or < t)
 *   For deadlines (kind 'D') the value is "the time the event first happens" (never = +∞): "by d" ⇒ op 'le'.
 */
export function conditionPair(A, B) {
  // Kalshi structured strikes, only when the wording agrees with the metadata
  if (A.provider === 'kalshi' && B.provider === 'kalshi' && A.eventId === B.eventId && strikeConsistent(A) && strikeConsistent(B)) {
    const k = (m) => {
      switch (m.strikeType) {
        case 'greater': return { kind: 'N', op: 'ge', t: m.floor, strict: true, raw: m.label };
        case 'greater_or_equal': return { kind: 'N', op: 'ge', t: m.floor, strict: false, raw: m.label };
        case 'less': return { kind: 'N', op: 'le', t: m.cap, strict: true, raw: m.label };
        case 'less_or_equal': return { kind: 'N', op: 'le', t: m.cap, strict: false, raw: m.label };
        default: return null;
      }
    };
    const a = k(A), b = k(B);
    // the strike must be the thing that differs (e.g. "100M subscribers before 2027" vs "before 2029" share a strike)
    if (a && b && a.t !== b.t) return [a, b];
  }
  const ta = templatize(ladderText(A), Date.parse(A.endDate) || undefined);
  const tb = templatize(ladderText(B), Date.parse(B.endDate) || undefined);
  if (ta.template !== tb.template || ta.slots.length !== tb.slots.length) return null;
  const diff = ta.slots.map((s, i) => i).filter((i) => ta.slots[i].type !== tb.slots[i].type || ta.slots[i].value !== tb.slots[i].value);
  if (diff.length !== 1) return null;
  const i = diff[0];
  const one = (m, t) => {
    const s = t.slots[i];
    const dir = slotDirection(t.template, s, m.yesOutcome, m.label);
    if (!dir) return null;
    const negated = NEGATED.test(t.template.replace(/\bno longer\b/g, ''));
    // dir < 0: probability falls as the number rises  -> YES iff value ≥ t
    // dir > 0: probability rises as the number rises  -> YES iff value ≤ t   (deadlines: "by d")
    return { kind: s.type, op: dir < 0 ? 'ge' : 'le', t: s.value, strict: null, negated, raw: s.raw };
  };
  const a = one(A, ta), b = one(B, tb);
  if (!a || !b || a.kind !== b.kind || a.negated !== b.negated) return null;
  return [a, b];
}

/** Truth of a condition at a sample point. Returns [lo, hi] (boundary ambiguity -> [0,1]). */
function truth(c, pt) {
  let v;
  if (pt.at != null && pt.at === c.t) {
    if (c.strict == null) v = [0, 1];               // "above 70" vs "70 or more": unknown at exactly 70
    else v = c.strict ? [0, 0] : [1, 1];
  } else {
    const x = pt.x;
    const yes = c.op === 'ge' ? x > c.t : x < c.t;
    v = yes ? [1, 1] : [0, 0];
  }
  return c.negated ? [1 - v[1], 1 - v[0]] : v;
}

/** Build the region states for two conditions on the same quantity. */
export function regionStates(ca, cb, unitHint = '') {
  const ts = [...new Set([ca.t, cb.t])].sort((x, y) => x - y);
  const fmt = (t) => (ca.kind === 'D' ? fmtDate(t) : `${unitHint}${fmtNum(t)}`);
  const what = ca.kind === 'D' ? 'Event happens' : 'Value';
  const pts = [];
  pts.push({ key: 'r0', x: ts[0] - 1e-6 * Math.max(1, Math.abs(ts[0])), label: ca.kind === 'D' ? `${what} before ${fmt(ts[0])}` : `${what} below ${fmt(ts[0])}` });
  ts.forEach((t, j) => {
    if (ca.kind === 'N') pts.push({ key: `b${j}`, at: t, x: t, label: `${what} exactly ${fmt(t)}`, boundary: true });
    if (j < ts.length - 1) pts.push({ key: `r${j + 1}`, x: (t + ts[j + 1]) / 2, label: ca.kind === 'D' ? `${what} between ${fmt(t)} and ${fmt(ts[j + 1])}` : `${what} between ${fmt(t)} and ${fmt(ts[j + 1])}` });
  });
  const last = ts[ts.length - 1];
  pts.push({ key: `r${ts.length}`, x: last + 1e-6 * Math.max(1, Math.abs(last)) + (ca.kind === 'D' ? 864e5 : 0),
    label: ca.kind === 'D' ? `${what} after ${fmt(last)} (or never)` : `${what} above ${fmt(last)}` });
  return pts;
}

/**
 * All 2-leg baskets for a nested pair, each scored over every region.
 * Returns [{ legs: [{market, side}], states: [{key,label,pay:[[lo,hi],[lo,hi]]}], minPayoff, deadZones: [labels] }]
 */
export function nestedBaskets(A, B) {
  const cs = conditionPair(A, B);
  if (!cs) return null;
  const [ca, cb] = cs;
  if (ca.t === cb.t) return null;   // same threshold: not a ladder pair (would look like YES+NO of one contract)
  // nested contracts can both be YES; a mutually-exclusive event says at most one is -> these are buckets, not a ladder
  if (A.eventId === B.eventId && A.inExclusiveEvent) return null;
  const unit = /\$/.test(`${ca.raw}${cb.raw}${A.question}`) ? '$' : '';
  const pts = regionStates(ca, cb, unit);
  const ta = pts.map((p) => truth(ca, p)), tb = pts.map((p) => truth(cb, p));
  // nested = one condition's YES region contains the other's (otherwise this isn't a ladder pair)
  const yesA = ta.map((x) => x[0] === 1), yesB = tb.map((x) => x[0] === 1);
  const aInB = yesA.every((y, i) => !y || tb[i][1] === 1), bInA = yesB.every((y, i) => !y || ta[i][1] === 1);
  if (!aInB && !bInA) return null;
  const flip = (v) => [1 - v[1], 1 - v[0]];
  const out = [];
  for (const [sa, sb] of [['yes', 'no'], ['no', 'yes']]) {
    const states = pts.map((p, i) => {
      const pa = sa === 'yes' ? ta[i] : flip(ta[i]);
      const pb = sb === 'yes' ? tb[i] : flip(tb[i]);
      return { key: p.key, label: p.label, boundary: !!p.boundary, pay: [pa, pb], lo: pa[0] + pb[0] };
    });
    out.push({
      legs: [{ market: A, side: sa }, { market: B, side: sb }], states, conditions: [ca, cb],
      minPayoff: Math.min(...states.map((s) => s.lo)),
      deadZones: states.filter((s) => s.lo < 1).map((s) => s.label),
    });
  }
  return { conditions: [ca, cb], aImpliesB: aInB, baskets: out };
}

export function describeCondition(c, m) {
  const subject = (m.eventTitle || m.question).replace(/\?$/, '');
  const fmt = c.kind === 'D' ? fmtDate(c.t) : `${/\$/.test(c.raw || '') ? '$' : ''}${fmtNum(c.t)}`;
  const base = c.kind === 'D' ? `happens by ${fmt}` : c.op === 'ge' ? `reaches ${fmt} or higher` : `falls to ${fmt} or lower`;
  return `${c.negated ? 'does NOT ' : ''}${base}`.replace(/^does NOT happens/, 'does NOT happen') + ` (${subject})`;
}
