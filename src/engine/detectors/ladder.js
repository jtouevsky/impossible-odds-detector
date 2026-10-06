// Threshold & deadline ladders.
// Two contracts whose wording is identical except for ONE number or date are monotone in that value:
//   "BTC above $90k" ⇒ "BTC above $85k"           (higher bar is harder)
//   "Kraken IPO by June 30" ⇒ "Kraken IPO by Dec 31" (earlier deadline is harder)
//   "Spread: Colts (-3.5)" ⇒ "Spread: Colts (-1.5)",  "O/U 47.5 [Over]" ⇒ "O/U 46.5 [Over]"
// Direction comes from keywords next to the slot; anything ambiguous is dropped.
import { templatize } from '../text.js';

const DEC_BEFORE = /(above|over|more than|greater than|higher than|at least|exceed(?:s|ing)?|surpass(?:es)?|hit(?:s)? \(high\)|\(high\)|≥|>|\(-|\bminimum of)( or equal to)?\s*\$?\s*$/;
const INC_BEFORE = /(below|under|less than|fewer than|lower than|at most|no more than|dip(?:s)? (?:to|below)|fall(?:s)? (?:to|below)|drop(?:s)? (?:to|below)|hit(?:s)? \(low\)|\(low\)|≤|<|\(\+|\bmaximum of)( or equal to)?\s*\$?\s*$/;
const DEC_AFTER = /^\s*(%|°[cf]|[a-z]{0,12})?\s*(\+|or more|or higher|or above|or greater|plus)\b|^\s*(%|°[cf])?\s*\+|^\+/;
const INC_AFTER = /^\s*(%|°[cf]|[a-z]{0,12})?\s*(or less|or lower|or below|or fewer)\b/;
const DATE_INC_BEFORE = /(by|before|until|on or before|by the end of|by end of|before the end of|no later than)\s*$/;
const BANNED = /\b(between|exactly|range|odd\/even|exact score|closest|nearest|winning margin|margin of victory|correct score)\b|\d\s*-\s*⟨N⟩|⟨N⟩\s*-\s*⟨N⟩|⟨N⟩\s*(to|-)\s*\$?⟨N⟩/;

export const NEGATED = /\b(not|no|never|without|fails? to|won't|doesn't|isn't)\b|n't\b/;
// "reach"/"hit" are ambiguous (hit 37% approval could be up or down) unless the market label says ↑ / ↓.
const AMBIGUOUS_BEFORE = /\b(reach(?:es)?|hit(?:s)?|touch(?:es)?|trade at)\s*\$?\s*$/;

export function slotDirection(template, slot, yesOutcome, label) {
  const before = template.slice(Math.max(0, slot.start - 40), slot.start);
  const after = template.slice(slot.end, slot.end + 24);
  if (slot.type === 'D') return DATE_INC_BEFORE.test(before) ? +1 : 0;
  if (AMBIGUOUS_BEFORE.test(before)) {
    if (DEC_AFTER.test(after) && !INC_AFTER.test(after)) return -1;
    if (INC_AFTER.test(after) && !DEC_AFTER.test(after)) return +1;
    if (/↑|\bhigh\b/i.test(label || '') || /^\s*\(high\)/.test(after)) return -1;
    if (/↓|\blow\b/i.test(label || '') || /^\s*\(low\)/.test(after)) return +1;
    return 0;
  }
  // Over/Under markets: direction depends on which side is priced.
  if (/o\/u\s*$|over\/under\s*$|total(?:s)?:?\s*$/.test(before) || /o\/u/.test(before.slice(-12))) {
    if (/^over$/i.test(yesOutcome)) return -1;
    if (/^under$/i.test(yesOutcome)) return +1;
    return 0;
  }
  const dec = DEC_BEFORE.test(before) || DEC_AFTER.test(after);
  const inc = INC_BEFORE.test(before) || INC_AFTER.test(after);
  if (dec && !inc) return -1; // P falls as value rises
  if (inc && !dec) return +1; // P rises as value rises
  return 0;
}

function makePair(a, b, k, key) {
  if (a.slots[k].value === b.slots[k].value) return null;
  let dir = slotDirection(a.template, a.slots[k], a.m.yesOutcome, a.m.label);
  if (!dir || dir !== slotDirection(b.template, b.slots[k], b.m.yesOutcome, b.m.label)) return null;
  // "Will X NOT happen by <date>" / "no release by" flips the ordering
  if (NEGATED.test(a.template.replace(/\bno longer\b/g, ''))) dir = -dir;
  const crossEvent = a.m.eventId !== b.m.eventId;
  if (crossEvent && a.slots[k].type === 'N') {
    const ta = Date.parse(a.m.endDate), tb = Date.parse(b.m.endDate);
    if (!(Math.abs(ta - tb) <= 7 * 864e5)) return null;
  }
  const va = a.slots[k].value, vb = b.slots[k].value;
  const aHarder = dir < 0 ? va > vb : va < vb; // harder = must have the lower probability
  const hard = aHarder ? a : b, easy = aHarder ? b : a;
  const isDate = a.slots[k].type === 'D';
  return {
    type: 'implication', a: hard.m.id, b: easy.m.id, confidence: crossEvent ? 0.9 : 0.97, detector: 'ladder',
    subtype: isDate ? 'deadline' : 'threshold', groupKey: key,
    rationale: isDate ? RATIONALE_DATE
      : `Same contract with a ${dir < 0 ? 'higher' : 'lower'} threshold${/^(over|under)$/i.test(hard.m.yesOutcome) ? ` on the ${hard.m.yesOutcome} side` : ''}. Clearing the harder bar automatically clears the easier one.`,
  };
}
const RATIONALE_DATE = 'Same contract with an earlier deadline. If it happens by the earlier date, it has also happened by the later one.';

export const ladderDetector = {
  id: 'ladder',
  name: 'Threshold / deadline ladder',
  detect(ctx) {
    const groups = new Map();
    for (const m of ctx.markets) {
      const ref = Date.parse(m.endDate);
      // Kalshi puts the strike in the outcome label and shares titles across events -> label in text, scope to the event
      const text = (m.isYesNo ? m.question : `${m.question} [${m.yesOutcome}]`) + (m.provider === 'kalshi' && m.label ? ` :: ${m.label}` : '');
      const { template, slots } = templatize(text, Number.isFinite(ref) ? ref : undefined);
      if (!slots.length || BANNED.test(template)) continue;
      // Game markets only compare inside the same game; other markets may match across events.
      const key = (m.isGame || m.provider === 'kalshi' ? m.eventId + '|' : '') + template;
      let g = groups.get(key);
      if (!g) groups.set(key, (g = []));
      g.push({ m, slots, template });
    }

    const rels = [];
    const NEIGHBORS = 3; // compare each rung with its next 3 rungs: O(n) pairs, and any ordering violation shows up between neighbours
    for (const [key, g] of groups) {
      if (g.length < 2) continue;
      const nSlots = g[0].slots.length;
      for (let k = 0; k < nSlots; k++) {
        // sub-group by every OTHER slot so members differ only in slot k
        const sub = new Map();
        for (const x of g) {
          if (x.slots.length !== nSlots) continue;
          const sk = x.slots.map((s, i) => (i === k ? '*' : s.type + s.value)).join('|');
          let a = sub.get(sk);
          if (!a) sub.set(sk, (a = []));
          a.push(x);
        }
        for (const arr of sub.values()) {
          if (arr.length < 2) continue;
          arr.sort((x, y) => x.slots[k].value - y.slots[k].value);
          for (let i = 0; i < arr.length; i++)
            for (let j = i + 1; j <= Math.min(arr.length - 1, i + NEIGHBORS); j++) {
              const r = makePair(arr[i], arr[j], k, key);
              if (r) rels.push(r);
            }
        }
      }
    }
    return rels;
  },
};
