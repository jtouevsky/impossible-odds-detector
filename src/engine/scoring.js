// Confidence & ranking. Confidence = P(relationship is right) × data-quality factors.
// Precision first: violations that only exist on stale/wide/illiquid quotes are pushed way down.

const clamp = (x, a, b) => Math.max(a, Math.min(b, x));

export function quality(rel, ev) {
  // For multi-leg sets, longshot legs with no bids are normal; judge quality on the legs that matter.
  const core = ev.legs.length > 2 ? ev.legs.filter((m) => m.price >= 0.02) : ev.legs;
  const legs = core.length ? core : ev.legs;
  const spreads = legs.map((m) => (m.bid != null && m.ask != null ? m.ask - m.bid : 1));
  const maxSpread = Math.max(...spreads);
  const minLiquidity = Math.min(...legs.map((m) => m.liquidity || 0));
  const totalVolume = ev.legs.reduce((s, m) => s + (m.volume || 0), 0);
  const volume24h = ev.legs.reduce((s, m) => s + (m.volume24h || 0), 0);
  const stale = legs.some((m) => m.bid != null && m.ask != null && (m.price < m.bid - 0.02 || m.price > m.ask + 0.02));

  const executable = ev.edge > 0;
  const fExec = executable ? 1 : 0.45 + 0.4 * clamp(ev.magnitude / (ev.magnitude - ev.edge || 1), 0, 1);
  const fLiq = minLiquidity >= 10000 ? 1 : minLiquidity >= 1000 ? 0.95 : minLiquidity >= 200 ? 0.85 : 0.7;
  const fSpread = maxSpread <= 0.03 ? 1 : maxSpread <= 0.1 ? 0.92 : 0.75;
  const fStale = stale ? 0.85 : 1;
  const fAssume = rel.type === 'exhaustive' && ev.direction === 'under' ? 0.6 : 1; // relies on "nothing else can happen"

  const confidence = clamp(rel.confidence * fExec * fLiq * fSpread * fStale * fAssume, 0, 1);
  const liqW = 0.6 + 0.4 * clamp(Math.log10(1 + minLiquidity) / 5, 0, 1);
  // A contradiction that needs 40 simultaneous trades is less useful than a clean two-leg one.
  const legW = 1 / (1 + 0.15 * Math.max(0, ev.legs.length - 2));
  const roi = executable && ev.cost > 0 ? ev.edge / ev.cost : null;
  const score = confidence * (ev.magnitude + 2 * Math.max(ev.edge, 0)) * liqW * legW;
  return {
    confidence, score, executable, roi, cost: ev.cost, maxSpread, minLiquidity, totalVolume, volume24h, stale,
    factors: { relationship: rel.confidence, execution: fExec, liquidity: fLiq, spread: fSpread, freshness: fStale, assumption: fAssume },
  };
}
