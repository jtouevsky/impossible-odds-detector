// Outcome-set rules for multi-outcome events (Polymarket "negRisk" events).
//   exclusive   : at most one outcome can resolve YES   -> Σ P ≤ 1
//   exhaustive  : exactly one outcome resolves YES      -> Σ P ≈ 1
const isQuoted = (m) =>
  (m.bid != null && m.ask != null && m.ask - m.bid <= 0.2) || (m.ask != null && m.ask <= 0.05 && m.price <= 0.05);

export const outcomeSetDetector = {
  id: 'outcome-set',
  name: 'Outcome sets (exclusive / exhaustive)',
  detect(ctx) {
    const rels = [];
    for (const ev of ctx.events) {
      if (!ev.exclusive || ev.resolvedYes > 0) continue;
      const members = ev.marketIds.map((id) => ctx.byId.get(id)).filter((m) => m && m.isYesNo);
      if (members.length < 2 || members.length !== ev.marketIds.length) continue;
      // every leg must be priced; placeholder legs with no book at all make the sum meaningless
      if (members.some((m) => m.acceptingOrders === false)) continue;
      // Every leg needs a real quote. Unquoted placeholders sit at a default 50¢ and would make the sum meaningless.
      if (!members.every(isQuoted)) continue;
      rels.push({
        type: ev.exhaustive ? 'exhaustive' : 'exclusive-set',
        members: members.map((m) => m.id),
        eventId: ev.id,
        confidence: ev.exhaustive ? 0.95 : 0.97,
        detector: 'outcome-set',
        rationale: ev.exhaustive
          ? `The ${members.length} outcomes of "${ev.title}" are mutually exclusive and cover every possibility, so exactly one resolves YES.`
          : `The ${members.length} listed outcomes of "${ev.title}" are mutually exclusive (only one can win), so their probabilities cannot add up to more than 100%.`,
      });
    }
    return rels;
  },
};
