// Plain-English explanations for a violation. Pure functions, shared by the UI and tests.

export function pct(p) {
  if (p == null || !Number.isFinite(p)) return '—';
  const v = p * 100;
  const d = Math.abs(v) < 1 && v !== 0 ? 2 : 1;
  return v.toFixed(d).replace(/\.0+$/, '') + '%';
}
export const pts = (x) => (x * 100).toFixed(1).replace(/\.0$/, '') + (Math.abs(x * 100) === 1 ? ' pt' : ' pts');
export const cents = (x) => (x >= 0 ? '+' : '−') + Math.abs(x * 100).toFixed(1).replace(/\.0$/, '') + '¢';

export function marketTitle(m) {
  if (!m) return '';
  return m.isYesNo ? m.question : `${m.question} → ${m.yesOutcome}`;
}

export const TYPE_META = {
  implication: { label: 'Implication', short: 'Subset', verb: 'REQUIRED FOR', glyph: '↓' },
  equivalent: { label: 'Equivalent', short: 'Same event', verb: 'SAME EVENT AS', glyph: '≡' },
  exclusive: { label: 'Mutually exclusive', short: 'Exclusive', verb: 'EXCLUSIVE WITH', glyph: '⊥' },
  'exclusive-set': { label: 'Mutually exclusive set', short: 'Exclusive set', verb: 'SUM ≤ 100%', glyph: 'Σ' },
  exhaustive: { label: 'Exhaustive outcomes', short: 'Exhaustive', verb: 'SUM = 100%', glyph: 'Σ' },
};

/** Columns for the table: left / right legs in the order a human reads the rule. */
export function columns(v, markets) {
  const A = markets[v.a], B = markets[v.b];
  if (v.type === 'implication') {
    // show the necessary condition first: "wins primary  ↓ REQUIRED FOR  wins presidency"
    return { left: { kind: 'market', m: B, p: B.price }, right: { kind: 'market', m: A, p: A.price } };
  }
  if (v.type === 'equivalent' || v.type === 'exclusive') {
    return { left: { kind: 'market', m: A, p: A.price }, right: { kind: 'market', m: B, p: B.price } };
  }
  const n = v.legs.length;
  return {
    left: { kind: 'set', title: v.event ? v.event.title : 'Outcome set', sub: `${n} outcomes · sum of prices`, p: v.sum },
    right: { kind: 'target', title: v.type === 'exhaustive' ? 'Exactly one outcome happens' : 'At most one outcome happens',
      sub: v.type === 'exhaustive' ? 'Sum must equal' : 'Sum cannot exceed', p: 1 },
  };
}

export function explain(v, markets) {
  const A = markets[v.a], B = markets[v.b];
  const legs = v.legs.map((id) => markets[id]).filter(Boolean);
  const out = { headline: '', relationship: v.rationale, why: '', size: '', trade: v.trade };
  const ex = v.executable
    ? `At the current best bid/ask the contradiction is tradable: one basket costs about $${(v.cost ?? 1).toFixed(2)} and locks in ${cents(v.edge)} of profit` +
      (v.roi != null ? ` (${(v.roi * 100).toFixed(v.roi >= 0.01 ? 1 : 2)}% return)` : '') + `, before fees and subject to order-book depth.`
    : `The bid/ask spreads currently absorb it (best executable edge ${cents(v.edge)}), so it is a pricing inconsistency rather than a free trade.`;

  switch (v.type) {
    case 'implication':
      out.headline = `${pct(A.price)} for the stronger outcome vs ${pct(B.price)} for the outcome it requires`;
      out.why = `If "${marketTitle(A)}" resolves YES, then "${marketTitle(B)}" must also resolve YES. ` +
        `So the market should never price the first above the second, but it does: ${pct(A.price)} > ${pct(B.price)}.`;
      break;
    case 'equivalent':
      out.headline = `Two listings of the same event priced ${pct(A.price)} and ${pct(B.price)}`;
      out.why = `Both contracts pay out on the same event, so they should trade at the same probability. They are ${pts(Math.abs(A.price - B.price))} apart.`;
      break;
    case 'exclusive':
      out.headline = `${pct(A.price)} + ${pct(B.price)} = ${pct(A.price + B.price)} for two outcomes that can't both happen`;
      out.why = `At most one of these can resolve YES, so their probabilities can add up to 100% at most. They currently add up to ${pct(A.price + B.price)}.`;
      break;
    case 'exclusive-set':
      out.headline = `${legs.length} mutually exclusive outcomes add up to ${pct(v.sum)}`;
      out.why = `Only one of these outcomes can win, so their probabilities can't sum to more than 100%. Even counting illiquid outcomes at their best bid, the total is ${pct(1 + v.magnitude)}.`;
      break;
    case 'exhaustive':
      out.headline = `${legs.length} exhaustive outcomes add up to ${pct(v.sum)} instead of 100%`;
      out.why = v.direction === 'over'
        ? `Exactly one outcome resolves YES, so the probabilities should sum to 100%. Even counting illiquid outcomes at their best bid, they sum to ${pct(1 + v.magnitude)}.`
        : `Exactly one outcome resolves YES, so the probabilities should sum to 100%. Even counting illiquid outcomes at their best ask, they only reach ${pct(1 - v.magnitude)}. ` +
          `This assumes the listed outcomes really cover every possibility (check the rules for an "all resolve NO" clause).`;
      break;
  }
  out.size = `Conservative violation: ${pts(v.magnitude)} (wide or one-sided quotes are counted at whichever bound is kindest to the market). ${ex}`;
  return out;
}

/** Recompute the executable edge from live books: books = { [marketId]: {bid, ask} } */
export function liveEdge(v, books) {
  const b = (id) => books[id]?.bid ?? 0, a = (id) => books[id]?.ask ?? 1;
  switch (v.type) {
    case 'implication': return b(v.a) - a(v.b);
    case 'equivalent': return Math.max(b(v.a) - a(v.b), b(v.b) - a(v.a));
    case 'exclusive': return b(v.a) + b(v.b) - 1;
    case 'exclusive-set': return v.legs.reduce((s, id) => s + b(id), 0) - 1;
    case 'exhaustive': return v.direction === 'under' ? 1 - v.legs.reduce((s, id) => s + a(id), 0) : v.legs.reduce((s, id) => s + b(id), 0) - 1;
    default: return null;
  }
}
