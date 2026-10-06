// Spec comparison + candidate generation. Expensive comparison only runs inside eventKey blocks,
// never all-markets × all-markets.
export const STATUS = { VERIFIED: 'VERIFIED', LIKELY: 'LIKELY', MISMATCH: 'MISMATCH' };

const HOUR = 3600e3;
const sameSet = (a, b) => a.length === b.length && a.every((x, i) => x === b[i]);

/**
 * Compare two MarketSpecs for "these pay out in exactly the same states".
 * Returns { status, checks: [{ field, a, b, result: 'ok'|'warn'|'fail', note }] }.
 */
export function compareSpecs(a, b) {
  const checks = [];
  const add = (field, va, vb, result, note = '') => checks.push({ field, a: va, b: vb, result, note });

  add('Domain', a.domain, b.domain, a.domain === b.domain ? 'ok' : 'fail');
  add('Underlying event', a.eventKey, b.eventKey, a.eventKey === b.eventKey ? 'ok' : 'fail');
  add('Outcome', a.outcomeKey, b.outcomeKey, a.outcomeKey === b.outcomeKey ? 'ok' : 'fail');
  if (a.approxOutcome || b.approxOutcome) add('Outcome definition', a.approxNote || 'exact', b.approxNote || 'exact', 'warn', a.approxNote || b.approxNote);

  if (a.domain === 'binary' && b.domain === 'binary') {
    add('Threshold', a.threshold, b.threshold, a.threshold === b.threshold ? 'ok' : 'fail');
    add('Comparator', a.comparator, b.comparator, a.comparator === b.comparator ? 'ok' : 'fail');
    const dt = a.windowEnd != null && b.windowEnd != null ? Math.abs(a.windowEnd - b.windowEnd) : null;
    add('Resolution window end', iso(a.windowEnd), iso(b.windowEnd), dt == null ? 'warn' : dt <= HOUR ? 'ok' : 'fail',
      dt == null ? 'missing end time' : dt <= HOUR ? '' : `ends ${(dt / 864e5).toFixed(1)} days apart — different events`);
    add('Dates in rules', a.ruleDates.join(', ') || '—', b.ruleDates.join(', ') || '—', sameSet(a.ruleDates, b.ruleDates) ? 'ok' : 'fail',
      sameSet(a.ruleDates, b.ruleDates) ? '' : 'rules reference different dates/windows');
    add('Geography', a.geo.join(', ') || '—', b.geo.join(', ') || '—', sameSet(a.geo, b.geo) ? 'ok' : 'fail');
    // identical rule text only counts when there IS rule text (two empty descriptions prove nothing),
    // and two different venues never share a rule book, so a generic cross-venue match is at best LIKELY
    const hasRules = (a.ruleCore || '').length > 40 && (b.ruleCore || '').length > 40;
    const sameRules = a.provider === b.provider && hasRules && (a.rulesHash && b.rulesHash ? a.rulesHash === b.rulesHash : a.ruleCore === b.ruleCore);
    // Same venue, same wording, different rule text = two different contracts (e.g. full game vs 3rd quarter).
    const sameVenueDifferent = a.provider === b.provider && hasRules && !sameRules;
    add('Settlement rules text', a.provider, b.provider, sameRules ? 'ok' : sameVenueDifferent ? 'fail' : 'warn',
      sameRules ? 'identical rule text' : !hasRules ? 'rule text missing on one side' : a.provider !== b.provider ? 'different venues write different rules — compare them before trading' : 'rule text differs — read both before trading');
  } else if (a.domain === 'game') {
    add('Event date (ET)', a.dateKey, b.dateKey, a.dateKey === b.dateKey ? 'ok' : 'fail');
  } else {
    // meeting / election cycle is part of the canonical event key (e.g. fomc|2026-10, race|senate|tx|2026)
    add('Event period', a.eventKey.split('|').pop(), b.eventKey.split('|').pop(), a.eventKey === b.eventKey ? 'ok' : 'fail');
  }

  if (a.domain === 'game' && b.domain === 'game') {
    const lg = a.league;
    if (a.states.some((s) => s.key === 'tie')) {
      const ok = a.settlement.tie != null && a.settlement.tie === b.settlement.tie;
      add('Tie settlement', fmtTie(a.settlement.tie), fmtTie(b.settlement.tie), ok ? 'ok' : 'warn', ok ? '' : 'tie handling differs or is unstated');
    }
    if (a.states.some((s) => s.key === 'draw')) {
      const ok = a.settlement.regulation90 && b.settlement.regulation90;
      add('Result basis', a.settlement.regulation90 ? '90 min' : '?', b.settlement.regulation90 ? '90 min' : '?', ok ? 'ok' : 'warn', ok ? '' : `${lg}: regulation-time basis not stated on both`);
    }
    add('Postponement / cancellation', fmtCancel(a.settlement.cancel), fmtCancel(b.settlement.cancel), 'ok',
      'modelled as a separate tail state in the payoff table');
  }

  if (a.sources.length && b.sources.length && !a.sources.some((s) => b.sources.includes(s))) {
    add('Resolution source', a.sources.join(', '), b.sources.join(', '), a.domain === 'binary' ? 'warn' : 'ok', 'different named sources');
  }

  const status = checks.some((c) => c.result === 'fail') ? STATUS.MISMATCH : checks.some((c) => c.result === 'warn') ? STATUS.LIKELY : STATUS.VERIFIED;
  return { status, checks };
}

const iso = (t) => (t == null ? '—' : new Date(t).toISOString().replace('.000Z', 'Z'));
const fmtTie = (x) => (x == null ? 'unstated' : x === 0.5 ? '50/50' : x === 0 ? 'No' : String(x));
const fmtCancel = (x) => (x == null ? 'unstated' : x === 0.5 ? '50/50' : x === 0 ? 'No' : x === 'fair' ? 'fair price' : String(x));

/** Group specs by eventKey (the blocking step). Returns Map<eventKey, spec[]> with groups of ≥ 2. */
export function blockByEvent(specs) {
  const g = new Map();
  for (const s of specs) {
    let a = g.get(s.eventKey);
    if (!a) g.set(s.eventKey, (a = []));
    a.push(s);
  }
  for (const [k, v] of g) if (v.length < 2 || v.length > 400) g.delete(k);
  return g;
}

/** Equivalence candidates: same eventKey + same outcome, then a full spec comparison. */
export function equivalentPairs(groups, { crossVenueOnly = false } = {}) {
  const out = [];
  for (const specs of groups.values()) {
    const byOutcome = new Map();
    for (const s of specs) {
      let a = byOutcome.get(s.outcomeKey);
      if (!a) byOutcome.set(s.outcomeKey, (a = []));
      a.push(s);
    }
    for (const arr of byOutcome.values()) {
      if (arr.length < 2 || arr.length > 8) continue;
      for (let i = 0; i < arr.length; i++)
        for (let j = i + 1; j < arr.length; j++) {
          if (crossVenueOnly && arr[i].provider === arr[j].provider) continue;
          out.push({ a: arr[i], b: arr[j], ...compareSpecs(arr[i], arr[j]) });
        }
    }
  }
  return out;
}
