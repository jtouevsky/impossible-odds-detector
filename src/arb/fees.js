// Venue taker fees.
// Polymarket: fee = C × rate × (p(1−p))^exponent, rounded to 5 dp (docs.polymarket.com/trading/fees).
//   Markets with fees disabled pay 0; if the market doesn't say, assume the highest published rate (0.07).
// Kalshi: fee = ceil_to_cent( 0.07 × M × C × p(1−p) ) per order; M = series fee multiplier (default 1).
export const PM_DEFAULT_RATE = 0.07;
export const KALSHI_RATE = 0.07;

const ceilTo = (x, step) => Math.ceil(x / step - 1e-9) * step;

export function feeRatePerShare(market, p) {
  if (market.provider === 'polymarket') {
    if (market.feesEnabled === false) return 0;
    const rate = market.feeRate ?? PM_DEFAULT_RATE;
    return rate * Math.pow(p * (1 - p), market.feeExponent ?? 1);
  }
  // Polymarket US (docs.polymarket.us/fees): Θ × C × p(1−p), Θ = 0.0695 (per-market feeCoefficient), rounded to the cent.
  if (market.provider === 'polymarket-us') return (market.feeCoefficient ?? 0.0695) * p * (1 - p);
  if (market.provider === 'kalshi') return KALSHI_RATE * (market.feeMultiplier ?? 1) * p * (1 - p);
  // PredictIt: 10% of profit on a winning share (assume it wins: conservative). 5% withdrawal fee not per-trade.
  if (market.provider === 'predictit') return 0.1 * (1 - p);
  return 0.07 * p * (1 - p); // unknown venue: conservative
}

/** Exact fee for buying `qty` shares at price p in a single fill. */
export function feeFor(market, p, qty) {
  if (qty <= 0) return 0;
  const raw = feeRatePerShare(market, p) * qty;
  // Kalshi rounds up; Polymarket US rounds half-to-even — we round UP to the cent (never understate a fee).
  if (market.provider === 'kalshi' || market.provider === 'polymarket-us') return ceilTo(raw, 0.01);
  return ceilTo(raw, 0.00001);
}
