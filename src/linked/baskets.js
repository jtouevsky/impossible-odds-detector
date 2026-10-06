// Basket construction + payoff verification for a linked relationship.
// For  X ⇒ Y  we buy YES(Y) + NO(X) (never the reverse): whenever X happens Y pays; whenever X fails NO(X) pays.
// net (per scenario) = cash payout − acquisition cost − fees − buffer;  structural only if the WORST scenario > 0.
import { isExecutableArbitrage } from '../arb/payoff.js';

export const LINKED_DEFAULTS = { bufferPerShare: 0.005, maxQuoteAgeMs: 60e3, maxStateAgeMs: 90e3, maxStateQuoteSkewMs: 20e3, includeTailStates: true, maxQty: 100000 };

const flip = (iv, side) => (side === 'yes' ? iv : [1 - iv[1], 1 - iv[0]]);
const opposite = (s) => (s === 'yes' ? 'no' : 'yes');
const ceilCent = (x) => Math.ceil(x * 100 - 1e-9) / 100;
export const feeForOrder = (c, p, qty) => (qty > 0 ? ceilCent((c.feeCoefficient ?? 0.0695) * qty * p * (1 - p)) : 0); // Polymarket US: rounded to the cent (we round up)
const voidPay = (c, side) => { const v = c.rules.voidRule; return flip(typeof v === 'number' ? [v, v] : [0, 1], side); };

/** Walk two ask ladders together; stop when the next basket would not beat the worst-case payout. */
export function walk(ladders, contracts, minPayout, buffer, cap) {
  const lv = ladders.map((l) => l.map((x) => ({ ...x })));
  const idx = [0, 0], fills = [[], []];
  let qty = 0, stop = 'book-empty';
  while (idx[0] < lv[0].length && idx[1] < lv[1].length && qty < cap) {
    const a = lv[0][idx[0]], b = lv[1][idx[1]];
    const marginal = a.p + b.p + (contracts[0].feeCoefficient ?? 0.0695) * a.p * (1 - a.p) + (contracts[1].feeCoefficient ?? 0.0695) * b.p * (1 - b.p) + buffer;
    if (minPayout - marginal <= 1e-9) { stop = 'unprofitable'; break; }
    const take = Math.min(a.s, b.s, cap - qty);
    if (!(take > 0)) break;
    fills[0].push({ p: a.p, s: take }); fills[1].push({ p: b.p, s: take });
    a.s -= take; b.s -= take; qty += take;
    if (a.s <= 1e-9) idx[0]++;
    if (b.s <= 1e-9) idx[1]++;
  }
  return { qty: Math.floor(qty * 100) / 100, fills, stop };
}

/**
 * @param rel   relationship from rules.js
 * @param opts  { books: Map('slug|side' -> {asks:[{p,s}], timestamp}), now, config, mode: 'live'|'research'|'example',
 *                quoteTime, stateFresh: {ok, reason}, corrected }
 */
export function buildBasket(rel, opts = {}) {
  const cfg = { ...LINKED_DEFAULTS, ...(opts.config || {}) };
  const now = opts.now ?? Date.now();
  const legs = [
    { contract: rel.to.contract, side: rel.to.side, yesIdx: 1, role: 'conclusion' },
    { contract: rel.from.contract, side: opposite(rel.from.side), yesIdx: 0, role: 'hedge' },
  ].map((l) => ({ ...l, label: l.contract.sides[l.side].label, ask: l.contract.sides[l.side].ask, url: l.contract.url, question: l.contract.question }));

  // ---- payoff table over the proven-exhaustive partition (+ the postponement/cancellation state)
  const rows = rel.cells.map((cell) => {
    const pays = legs.map((l) => flip(cell.yes[l.yesIdx], l.side));
    return { label: cell.label, witness: cell.witness || null, pays, lo: pays[0][0] + pays[1][0], hi: pays[0][1] + pays[1][1], tail: false };
  });
  const vp = legs.map((l) => voidPay(l.contract, l.side));
  rows.push({ label: 'Postponed / canceled (settles at the venue\'s last fair price)', pays: vp, lo: vp[0][0] + vp[1][0], hi: vp[0][1] + vp[1][1], tail: true,
    known: legs.every((l) => typeof l.contract.rules.voidRule === 'number') });
  const ordinary = rows.filter((r) => !r.tail);
  const minPayout = Math.min(...ordinary.map((r) => r.lo));
  const minAll = Math.min(...rows.map((r) => r.lo));

  // ---- prices, fees, size
  const quotesMissing = legs.some((l) => l.ask == null || !(l.ask > 0 && l.ask < 1));
  const suspended = legs.some((l) => !l.contract.open);
  const book = (l) => opts.books?.get(`${l.contract.id}|${l.side}`);
  const haveBooks = legs.every((l) => book(l)?.asks?.length);
  let qty = 1, fills = legs.map((l) => [{ p: l.ask, s: 1 }]), stop = null, sizeVerified = false;
  if (!quotesMissing && haveBooks) {
    const w = walk(legs.map((l) => book(l).asks), legs.map((l) => l.contract), minPayout, cfg.bufferPerShare, cfg.maxQty);
    if (w.qty > 0) { qty = w.qty; fills = w.fills; sizeVerified = true; stop = w.stop; }
    else { stop = w.stop; sizeVerified = true; qty = 0; }
  }
  const unit = quotesMissing ? null : (() => {
    const cost = legs[0].ask + legs[1].ask;
    const fees = legs.reduce((s, l) => s + (l.contract.feeCoefficient ?? 0.0695) * l.ask * (1 - l.ask), 0);
    return { cost, fees, buffer: cfg.bufferPerShare, minPayout, net: minPayout - cost - fees - cfg.bufferPerShare };
  })();
  const econ = quotesMissing ? null : (() => {
    const q = qty || 1, f = qty ? fills : legs.map((l) => [{ p: l.ask, s: 1 }]);
    const cost = f.flat().reduce((s, x) => s + x.p * x.s, 0);
    const fees = f.reduce((s, legFills, i) => s + legFills.reduce((t, x) => t + feeForOrder(legs[i].contract, x.p, x.s), 0), 0);
    const buffer = cfg.bufferPerShare * q;
    const minNet = minPayout * q - cost - fees - buffer;
    return { qty: q, cost, fees, buffer, minPayout: minPayout * q, minNet, roi: minNet / (cost + fees), capital: cost + fees,
      perScenario: rows.map((r) => ({ label: r.label, tail: r.tail, payoutLo: r.lo * q, payoutHi: r.hi * q, netLo: r.lo * q - cost - fees - buffer, netHi: r.hi * q - cost - fees - buffer })) };
  })();

  // ---- statuses (structure and execution readiness are separate on purpose)
  const quoteAge = opts.quoteTime ? now - Date.parse(opts.quoteTime) : null;
  const quotes = quotesMissing ? 'missing' : suspended ? 'suspended' : quoteAge != null && quoteAge > cfg.maxQuoteAgeMs ? 'stale' : 'live';
  const settlement = [];
  if (rows.some((r) => !r.tail && r.lo < 1 && r.lo > 0)) settlement.push('A tie settles one leg at $0.50 — counted in the minimum payout.');
  if (!rows.find((r) => r.tail).known) settlement.push('Postponement/cancellation settles at the venue\'s "last fair market price" (or is not stated): unknown payout, counted at worst case.');
  if (rel.rule === 'score-constraint') settlement.push('Relies on the current score standing; an official score correction would invalidate it.');
  if (opts.corrected) settlement.push('The score was corrected recently — waiting before trusting it again.');
  const structureOk = rel.verified;
  // structural profitability at the quoted prices (fee RATE); at a verified size the exact cent-rounded fees must also pay
  const profitable = !!unit && isExecutableArbitrage(minPayout, unit.cost, unit.fees, unit.buffer) && (!sizeVerified || (qty > 0 && econ.minNet > 0));
  const mode = opts.mode || 'live';
  const tailBlocks = cfg.includeTailStates && !rows.find((r) => r.tail).known;
  const stateOk = opts.stateFresh ? opts.stateFresh.ok : true;
  const executable = mode === 'live' && structureOk && quotes === 'live' && sizeVerified && qty > 0 && profitable && stateOk && !opts.corrected && !tailBlocks
    && (!cfg.includeTailStates || isExecutableArbitrage(minAll, unit.cost, unit.fees, unit.buffer));
  const reasons = [];
  if (!structureOk) reasons.push('Settlement rules not fully known — research only.');
  if (mode !== 'live') reasons.push(mode === 'example' ? 'Illustrative example with hypothetical prices.' : 'Manual/replay game state — research only.');
  if (quotes !== 'live') reasons.push(`Quotes ${quotes}.`);
  if (!sizeVerified) reasons.push('Available size unknown (order books not loaded).');
  if (!stateOk) reasons.push(opts.stateFresh.reason);
  if (tailBlocks) reasons.push('Postponement payout unknown — strict mode counts it at worst case.');
  if (unit && !profitable) reasons.push(sizeVerified && qty === 0 ? 'Order books have no depth at a profitable price.' : `Pricing does not pay: worst case ${(unit.net * 100).toFixed(2)}¢ per basket after fees and buffer.`);

  return {
    id: `basket:${rel.id}`, relationship: rel, legs: legs.map((l, i) => ({ ...l, contract: undefined, contractId: l.contract.id, venue: l.contract.venueName,
      market: l.contract.question, ladder: book(l)?.asks?.slice(0, 6) || null, fills: econ ? (qty ? fills[i] : [{ p: l.ask, s: 1 }]) : null, rules: l.contract.rules })),
    rows, minPayout, minAll, unit, econ, sizeVerified, stop,
    status: { structure: structureOk ? 'verified' : 'unverified', quotes, size: sizeVerified ? 'verified' : 'unknown', settlement, state: opts.stateLabel || mode },
    mode, profitable, executable, classification: executable ? 'executable' : profitable ? (structureOk ? 'structural' : 'research') : 'unprofitable', reasons,
  };
}
