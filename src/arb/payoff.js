// THE central correctness rule. Everything in the LIVE ARBITRAGE feed must satisfy it.
//
//   isExecutableArbitrage = min payoff across all valid resolution states − cost − fees − buffer > 0
//
// Payoffs are intervals [lo, hi] per state: when a venue's settlement in some state is unknown
// (e.g. "resolves to a fair price"), the worst case (lo) is what counts.

export function isExecutableArbitrage(minPayoff, cost, fees, buffer) {
  return minPayoff - cost - fees - buffer > 1e-9;
}

/** State-by-state payoff of one basket (1 share of each position). */
export function payoffTable(positions, states) {
  return states.map((st) => {
    const legs = positions.map((p) => p.pay[st.key] || [0, 0]);
    return { key: st.key, label: st.label, tail: !!st.tail, legs, lo: legs.reduce((s, x) => s + x[0], 0), hi: legs.reduce((s, x) => s + x[1], 0) };
  });
}

export function minPayoffs(table) {
  const core = table.filter((r) => !r.tail);
  return {
    minCore: core.length ? Math.min(...core.map((r) => r.lo)) : 0,
    minAll: table.length ? Math.min(...table.map((r) => r.lo)) : 0,
  };
}

/** Payoff interval helpers for a YES/NO position. */
export const yesNo = (side, yesInterval) => (side === 'yes' ? yesInterval : [1 - yesInterval[1], 1 - yesInterval[0]]);
