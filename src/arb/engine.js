// Arbitrage engine — separate from the probability-anomaly detector.
// Builds concrete trade structures (sets of positions), prices them at executable asks, walks the
// order books, and keeps only those that satisfy the central rule in payoff.js.
import { payoffTable, minPayoffs, isExecutableArbitrage, yesNo } from './payoff.js';
import { feeRatePerShare, feeFor } from './fees.js';
import { STATUS } from '../spec/match.js';
import { nestedBaskets, describeCondition } from './statespace.js';

export const DEFAULT_ARB_CONFIG = {
  bufferPerShare: 0.005,     // safety/slippage buffer per $1 basket (USD)
  includeTailStates: true,   // count cancellation/void states in the minimum payoff (strict)
  maxCandidates: 150,        // structures sent to the order-book phase
  sizes: [10, 100, 1000],
  maxQuoteAgeMs: 120000,     // quotes older than this are never "guaranteed"
  now: null,                 // injectable clock (tests)
};

const VENUE = { polymarket: 'Polymarket', kalshi: 'Kalshi' };

// ---------- quotes ----------
/** Best executable ask for buying `side` of market m, from the snapshot (top of book). */
export function topQuote(m, side) {
  if (m.provider !== 'polymarket') {   // venues that quote both sides directly (Kalshi, PredictIt, Limitless)
    return side === 'yes' ? (m.ask != null ? { p: m.ask, s: m.askSize ?? null } : null)
      : (m.noAsk != null ? { p: m.noAsk, s: m.noAskSize ?? null } : null);
  }
  // Polymarket: one CLOB; buying NO at (1 − best YES bid)
  if (side === 'yes') return m.ask != null && m.ask < 1 ? { p: m.ask, s: null } : null;
  return m.bid != null && m.bid > 0 ? { p: +(1 - m.bid).toFixed(6), s: null } : null;
}

/** Payoff of YES on a spec'd market in a given state. */
export function yesPay(spec, st) {
  if (st.tail) return [0, 1];
  if (spec.domain === 'game' && st.key === 'tie') {
    if (spec.outcomeKey === 'draw') return [0, 0];
    const t = spec.settlement?.tie;
    return t == null ? [0, 1] : [t, t];
  }
  return st.key === spec.outcomeKey ? [1, 1] : [0, 0];
}

function pos(m, side, pay) {
  return { market: m, side, pay, top: topQuote(m, side) };
}
const domainPos = (m, spec, side, states) => pos(m, side, Object.fromEntries(states.map((st) => [st.key, yesNo(side, yesPay(spec, st))])));

// ---------- structure builders ----------
function equivalenceStructures(pairs, byId) {
  const out = [];
  for (const pr of pairs) {
    if (pr.status === STATUS.MISMATCH) continue;
    const A = byId.get(pr.a.marketId), B = byId.get(pr.b.marketId);
    if (!A || !B) continue;
    const states = pr.a.states;
    for (const [sa, sb] of [['yes', 'no'], ['no', 'yes']]) {
      out.push({
        strategy: A.provider !== B.provider ? 'cross-platform' : 'binary',
        kind: 'equivalent', matchStatus: pr.status, checks: pr.checks, states,
        positions: [domainPos(A, pr.a, sa, states), domainPos(B, pr.b, sb, states)],
        title: A.question,
        rationale: `Both contracts pay on the same outcome (${pr.a.outcomeKey} of ${pr.a.eventKey}). Holding ${sa.toUpperCase()} on one and ${sb.toUpperCase()} on the other pays at least $1 whatever happens.`,
      });
    }
  }
  return out;
}

/** Baskets across a fully-enumerated event (games, FOMC): cheapest position paying in each state, any venue. */
function partitionStructures(groups, byId) {
  const out = [];
  for (const specs of groups.values()) {
    const d = specs[0].domain;
    if (d !== 'game' && d !== 'fomc') continue;
    const states = specs[0].states;
    // every venue must agree on the state space (same team codes etc.)
    if (specs.some((s) => s.states.length !== states.length)) continue;
    const cands = [];
    for (const s of specs) {
      const m = byId.get(s.marketId);
      if (!m) continue;
      for (const side of ['yes', 'no']) {
        const p = domainPos(m, s, side, states);
        if (p.top) cands.push({ p, spec: s });
      }
    }
    const core = states.filter((st) => !st.tail);
    const chosen = new Map();
    let complete = true;
    for (const st of core) {
      const best = cands.filter((c) => c.p.pay[st.key][0] >= 1).sort((a, b) => a.p.top.p - b.p.top.p)[0];
      if (!best) { complete = false; break; }
      chosen.set(best.p.market.id + best.p.side, best);
    }
    if (!complete) continue;
    const legs = [...chosen.values()];
    const venues = new Set(legs.map((c) => c.p.market.provider));
    const oneMarket = new Set(legs.map((c) => c.p.market.id)).size === 1;
    const approx = legs.some((c) => c.spec.approxOutcome);
    out.push({
      strategy: venues.size > 1 ? 'cross-platform' : oneMarket ? 'binary' : 'multi-outcome',
      kind: 'partition', matchStatus: approx ? STATUS.LIKELY : STATUS.VERIFIED,
      checks: approx ? [{ field: 'Outcome definition', a: '', b: '', result: 'warn', note: legs.find((c) => c.spec.approxOutcome).spec.approxNote }] : [],
      states, positions: legs.map((c) => c.p),
      title: byId.get(specs[0].marketId).eventTitle,
      rationale: `The legs cover every outcome of ${specs[0].eventKey.replace(/\|/g, ' · ')}, so at least one pays $1 in each state.`,
    });
  }
  return out;
}

/** Venue-native outcome sets: all-NO on exclusive sets, all-YES on verified-exhaustive sets, YES+NO on one binary. */
function setStructures(events, byId) {
  const out = [];
  for (const ev of events) {
    const ms = ev.marketIds.map((id) => byId.get(id)).filter((m) => m && m.isYesNo);
    // binary complement (YES ask + NO ask) on each market
    for (const m of ev.marketIds.map((id) => byId.get(id)).filter(Boolean)) {
      const states = [{ key: 'Y', label: `${m.yesOutcome}`, tail: false }, { key: 'N', label: `${m.noOutcome}`, tail: false }];
      const y = pos(m, 'yes', { Y: [1, 1], N: [0, 0] }), n = pos(m, 'no', { Y: [0, 0], N: [1, 1] });
      if (y.top && n.top && y.top.p + n.top.p < 1) out.push({ strategy: 'binary', kind: 'complement', matchStatus: STATUS.VERIFIED, checks: [], states,
        positions: [y, n], title: m.question, rationale: 'YES and NO of the same contract: exactly one pays $1.' });
    }
    if (!ev.exclusive || ms.length < 2 || ms.length > 60 || ms.length !== ev.marketIds.length) continue;
    const label = (m) => m.label || m.question;
    const outStates = ms.map((m) => ({ key: m.id, label: label(m), tail: false }));
    // all-NO: valid on any exclusive set (at most one YES); add a "none" state unless exhaustive
    const statesNo = ev.exhaustiveVerified ? outStates : [...outStates, { key: '__none', label: 'None of the listed outcomes', tail: false }];
    const nos = ms.map((m) => pos(m, 'no', Object.fromEntries(statesNo.map((st) => [st.key, st.key === m.id ? [0, 0] : [1, 1]]))));
    if (nos.every((p) => p.top) && nos.reduce((s, p) => s + p.top.p, 0) < ms.length - 1)
      out.push({ strategy: 'multi-outcome', kind: 'all-no', matchStatus: STATUS.VERIFIED, checks: [], states: statesNo, positions: nos, title: ev.title,
        rationale: `At most one of the ${ms.length} outcomes can resolve YES (${ev.provider === 'kalshi' ? 'Kalshi mutually-exclusive event' : 'Polymarket neg-risk event'}), so at least ${ms.length - 1} NO shares pay $1.` });
    // all-YES: only if the set is established as exhaustive
    if (ev.exhaustiveVerified || ev.exhaustiveBasis) {
      const yes = ms.map((m) => pos(m, 'yes', Object.fromEntries(outStates.map((st) => [st.key, st.key === m.id ? [1, 1] : [0, 0]]))));
      if (yes.every((p) => p.top) && yes.reduce((s, p) => s + p.top.p, 0) < 1)
        out.push({ strategy: 'multi-outcome', kind: 'all-yes', matchStatus: ev.exhaustiveVerified ? STATUS.VERIFIED : STATUS.LIKELY,
          checks: ev.exhaustiveVerified ? [] : [{ field: 'Exhaustiveness', a: ev.exhaustiveBasis, b: '', result: 'warn', note: ev.exhaustiveBasis }],
          states: outStates, positions: yes, title: ev.title,
          rationale: `Exactly one of the ${ms.length} outcomes resolves YES (${ev.exhaustiveBasis || 'verified partition'}), so the basket pays $1.` });
    }
  }
  return out;
}

/**
 * Implications.
 *  - Threshold / deadline ladders: both contracts are parsed independently into conditions on one quantity and
 *    every basket is scored region by region (src/arb/statespace.js). Baskets with a dead zone are rejected.
 *  - Logical (stage) implications A ⇒ B: NO on A + YES on B over the 3 possible states (A∧¬B cannot happen).
 */
function implicationStructures(implications, byId, stats) {
  const out = [];
  const logical = [
    { key: 'AB', label: 'A happens (so B happens too)', tail: false },
    { key: 'nAB', label: 'B happens but A does not', tail: false },
    { key: 'nAnB', label: 'Neither happens', tail: false },
  ];
  for (const r of implications) {
    const A = byId.get(r.a), B = byId.get(r.b);
    if (!A || !B) continue;
    if (r.detector === 'ladder' || r.detector === 'kalshi-strike') {
      const nb = nestedBaskets(A, B);
      if (!nb) { stats.unparsed++; continue; }
      for (const bk of nb.baskets) {
        if (bk.minPayoff < 1) { stats.deadZone++; continue; } // a region where every leg loses -> never arbitrage
        const states = bk.states.map((s) => ({ key: s.key, label: s.label, tail: false, boundary: s.boundary }));
        const positions = bk.legs.map((l, i) => pos(l.market, l.side, Object.fromEntries(bk.states.map((s) => [s.key, s.pay[i]]))));
        if (positions.some((p) => !p.top) || positions[0].top.p + positions[1].top.p >= bk.minPayoff) continue;
        const sameEvent = A.eventId === B.eventId;
        out.push({
          strategy: 'implication', kind: 'nested', matchStatus: sameEvent ? STATUS.VERIFIED : STATUS.LIKELY,
          checks: sameEvent ? [] : [{ field: 'Same event', a: A.eventId, b: B.eventId, result: 'warn', note: 'ladder spans two events' }],
          states, positions, conditions: nb.conditions.map((c, i) => ({ ...c, text: describeCondition(c, i ? B : A) })),
          title: A.eventTitle || A.question,
          rationale: `Both contracts measure the same thing with different ${nb.conditions[0].kind === 'D' ? 'deadlines' : 'thresholds'}. ` +
            `Checked region by region: in every possible outcome at least one leg pays $1.`,
        });
      }
      continue;
    }
    const noA = pos(A, 'no', { AB: [0, 0], nAB: [1, 1], nAnB: [1, 1] });
    const yesB = pos(B, 'yes', { AB: [1, 1], nAB: [1, 1], nAnB: [0, 0] });
    if (!noA.top || !yesB.top || noA.top.p + yesB.top.p >= 1) continue;
    out.push({
      strategy: 'implication', kind: 'logical', matchStatus: STATUS.LIKELY,
      checks: [{ field: 'Implication', a: r.detector, b: '', result: 'warn', note: 'logical link between two events — confirm both rule sets' }],
      states: logical, positions: [noA, yesB], title: `${A.question} ⇒ ${B.question}`,
      rationale: `${r.rationale} So "A happens but B doesn't" is impossible: NO on A pays unless A happens, and then B happens too.`,
    });
  }
  return out;
}

// ---------- pricing ----------
export function priceTop(st, cfg) {
  const table = payoffTable(st.positions, st.states);
  const { minCore, minAll } = minPayoffs(table);
  const cost = st.positions.reduce((s, p) => s + p.top.p, 0);
  const fees = st.positions.reduce((s, p) => s + feeRatePerShare(p.market, p.top.p), 0);
  return { table, minCore, minAll, cost, fees, buffer: cfg.bufferPerShare,
    netCore: minCore - cost - fees - cfg.bufferPerShare, netAll: minAll - cost - fees - cfg.bufferPerShare };
}

/**
 * Walk the ask ladders of every position simultaneously. Each basket unit buys 1 share of every
 * position; stop when the marginal unit is no longer profitable (or a book runs out).
 */
export function walkBooks(positions, ladders, minPayoff, cfg, capQty = Infinity) {
  const idx = positions.map(() => 0);
  const left = ladders.map((l) => (l[0] ? l[0].s : 0));
  const fills = positions.map(() => []);
  let qty = 0, stop = { reason: 'cap', marginal: null };
  while (qty < capQty) {
    if (ladders.some((l, i) => !l[idx[i]])) { stop = { reason: 'book-empty', marginal: null }; break; }
    const prices = ladders.map((l, i) => l[idx[i]].p);
    const marg = minPayoff - prices.reduce((s, p) => s + p, 0) -
      positions.reduce((s, p, i) => s + feeRatePerShare(p.market, prices[i]), 0) - cfg.bufferPerShare;
    if (marg <= 1e-9) { stop = { reason: 'unprofitable', marginal: marg, prices }; break; }
    const step = Math.min(...left, capQty - qty);
    if (!(step > 0)) break;
    qty += step;
    positions.forEach((_, i) => {
      const f = fills[i], p = prices[i];
      if (f.length && f[f.length - 1].p === p) f[f.length - 1].s += step; else f.push({ p, s: step });
      left[i] -= step;
      if (left[i] <= 1e-9) { idx[i]++; left[i] = ladders[i][idx[i]] ? ladders[i][idx[i]].s : 0; }
    });
  }
  const cost = fills.reduce((s, f) => s + f.reduce((a, x) => a + x.p * x.s, 0), 0);
  const fees = fills.reduce((s, f, i) => s + f.reduce((a, x) => a + feeFor(positions[i].market, x.p, x.s), 0), 0);
  const buffer = cfg.bufferPerShare * qty;
  return { qty, fills, cost, fees, buffer, payout: minPayoff * qty, net: minPayoff * qty - cost - fees - buffer, stop };
}

// ---------- engine ----------
/**
 * ctx = { byId, events, groups (Map eventKey -> specs), pairs (spec comparisons), implications }
 * io  = { fetchLadders(positions) -> Promise<ladders[] per structure>, feeMultipliers(markets) -> Promise }
 */
export async function runArbEngine(ctx, io, cfgIn = {}) {
  const cfg = { ...DEFAULT_ARB_CONFIG, ...cfgIn };
  const t0 = Date.now();
  const rejected = { deadZone: 0, unparsed: 0, stale: 0 };
  const structures = [
    ...equivalenceStructures(ctx.pairs, ctx.byId),
    ...partitionStructures(ctx.groups, ctx.byId),
    ...setStructures(ctx.events, ctx.byId),
    ...implicationStructures(ctx.implications || [], ctx.byId, rejected),
  ].filter((s) => s.positions.every((p) => p.top));

  // Phase 1: top-of-book screen (fees + buffer included, Kalshi fee multiplier assumed 1 = worst case).
  // Deeper book levels can only be worse, so nothing that fails here can pass later.
  const screened = [];
  for (const st of structures) {
    const pr = priceTop(st, cfg);
    if (pr.netCore > 0) screened.push({ ...st, top: pr });
  }
  screened.sort((a, b) => b.top.netCore - a.top.netCore);
  const candidates = screened.slice(0, cfg.maxCandidates);
  // exact Kalshi series fee multipliers, only for the few series that survived
  if (io.feeMultipliers && candidates.length) await io.feeMultipliers(candidates.flatMap((s) => s.positions.map((p) => p.market)));

  // Phase 2: live order books + depth walk.
  const books = candidates.length ? await io.fetchLadders(candidates.flatMap((c) => c.positions)) : new Map();
  const opportunities = [];
  for (const c of candidates) {
    const ladders = c.positions.map((p) => books.get(ladderKey(p)) || null);
    if (ladders.some((l) => !l || !l.asks.length)) continue;
    const asks = ladders.map((l) => l.asks);
    const table = payoffTable(c.positions, c.states);
    const { minCore, minAll } = minPayoffs(table);
    const minPayoff = cfg.includeTailStates ? minAll : minCore;
    const best = c.positions.map((_, i) => asks[i][0]);
    const unitCost = best.reduce((s, x) => s + x.p, 0);
    const unitFees = c.positions.reduce((s, p, i) => s + feeRatePerShare(p.market, best[i].p), 0);
    const strict = isExecutableArbitrage(minPayoff, unitCost, unitFees, cfg.bufferPerShare);
    const coreOk = isExecutableArbitrage(minCore, unitCost, unitFees, cfg.bufferPerShare);
    if (!coreOk) continue; // books moved / snapshot was stale
    if (ladders.some((l) => l.noDepth)) {
      // Venue publishes prices but not sizes (PredictIt): per-share economics only, never "guaranteed".
      opportunities.push(depthless(c, ladders, best, table, { minPayoff, minCore, minAll, unitCost, unitFees }, cfg));
      continue;
    }
    const w = walkBooks(c.positions, asks, minCore, cfg);
    // whole contracts on Kalshi, cents of a share on Polymarket; respect venue minimum order sizes
    const lot = c.positions.some((p) => p.market.provider === 'kalshi') ? 1 : 0.01;
    const minQty = Math.max(1, ...c.positions.map((p) => p.market.orderMinSize || 1));
    const qMax = Math.floor(w.qty / lot + 1e-9) * lot;
    if (qMax < minQty) continue;
    const at = (q) => {
      const x = walkBooks(c.positions, asks, minCore, cfg, q);
      return { qty: x.qty, cost: x.cost, payout: x.payout, fees: x.fees, buffer: x.buffer, net: x.net, roi: x.cost > 0 ? x.net / x.cost : 0, fills: x.fills };
    };
    // exact (rounded) fees can make a size unprofitable: every listed size must clear the central rule
    const sizes = [...new Set([...cfg.sizes.filter((q) => q >= minQty && q < qMax), qMax])].map(at)
      .filter((x) => isExecutableArbitrage(x.payout, x.cost, x.fees, x.buffer));
    if (!sizes.length) continue;
    const max = sizes[sizes.length - 1];
    // central rule on the real fill, using the minimum payoff over ALL states (tail included when configured)
    const execOk = strict && isExecutableArbitrage(minPayoff * max.qty, max.cost, max.fees, max.buffer);
    const quoteTimes = ladders.map((l) => Date.parse(l.timestamp)).filter(Number.isFinite);
    const legs = c.positions.map((p, i) => ({
      venue: VENUE[p.market.provider] || p.market.provider, provider: p.market.provider, marketId: p.market.id,
      question: p.market.question, label: p.market.label, eventTitle: p.market.eventTitle,
      side: p.side, outcome: p.side === 'yes' ? p.market.yesOutcome : p.market.noOutcome,
      ask: best[i].p, askSize: best[i].s, bid: ladders[i].bids[0]?.p ?? null,
      depth: asks[i].slice(0, 6), fill: max.fills[i], qty: max.qty,
      fee: max.fills[i].reduce((a, x) => a + feeFor(p.market, x.p, x.s), 0),
      url: p.market.url, rules: p.market.rules || '', endDate: p.market.endDate, quoteTime: ladders[i].timestamp,
    }));
    const venues = [...new Set(legs.map((l) => l.venue))];
    const now = cfg.now ?? Date.now();
    const quoteAgeMs = quoteTimes.length ? now - Math.min(...quoteTimes) : Infinity;
    const fresh = quoteAgeMs <= cfg.maxQuoteAgeMs;
    // three buckets: guaranteed (all checks pass), near (attractive but something is not guaranteed); research lives elsewhere
    const reasons = [];
    if (c.matchStatus !== STATUS.VERIFIED) reasons.push({ code: 'match', text: `Not a verified match: ${(c.checks || []).filter((x) => x.result !== 'ok').map((x) => x.note || x.field).join('; ') || 'contracts may settle differently'}.` });
    if (!execOk) reasons.push({ code: 'tail', text: 'Positive in every normal outcome, but a postponement/cancellation can settle at an unknown "fair price" on one venue.' });
    if (!fresh) { reasons.push({ code: 'stale', text: `Quotes are ${Math.round(quoteAgeMs / 1000)}s old; prices must be re-checked before this can count as guaranteed.` }); rejected.stale++; }
    const bucket = reasons.length ? 'near' : 'guaranteed';
    const conf = (c.matchStatus === STATUS.VERIFIED ? 0.95 : 0.7) * (execOk ? 1 : 0.8) * (fresh ? 1 : 0.7);
    const providers = [...new Set(c.positions.map((p) => p.market.provider))].sort();
    opportunities.push({
      id: c.strategy + ':' + c.positions.map((p) => p.market.id + ':' + p.side).join('+'),
      strategy: c.strategy, kind: c.kind, matchStatus: c.matchStatus, checks: c.checks, title: c.title, rationale: c.rationale,
      conditions: c.conditions || null,
      venues, providers, venuePair: providers.length > 1 ? providers.join('↔') : `${providers[0]} only`,
      legs, states: table.map((r) => ({ ...r, legs: r.legs, boundary: !!c.states.find((x) => x.key === r.key)?.boundary })),
      unit: { cost: unitCost, minPayoff, minCore, minAll, gross: minPayoff - unitCost, fees: unitFees, buffer: cfg.bufferPerShare,
        net: minPayoff - unitCost - unitFees - cfg.bufferPerShare, roi: (minPayoff - unitCost - unitFees - cfg.bufferPerShare) / unitCost },
      maxQty: max.qty, capital: max.cost + max.fees, netProfit: max.net, roi: max.roi, sizes: sizes.map(({ fills, ...x }) => x),
      edgeStop: { reason: w.stop.reason, marginal: w.stop.marginal, prices: w.stop.prices || null, atQty: w.qty },
      bucket, reasons, isExecutable: bucket === 'guaranteed', nearArb: bucket === 'near',
      nearReason: reasons.map((r) => r.text).join(' ') || null,
      confidence: conf, quoteTime: quoteTimes.length ? new Date(Math.min(...quoteTimes)).toISOString() : null, quoteAgeMs, fresh,
      minLiquidity: Math.min(...c.positions.map((p) => p.market.liquidity || 0)),
    });
  }
  opportunities.sort((a, b) => (b.isExecutable - a.isExecutable) || (b.netProfit - a.netProfit));
  return {
    opportunities,
    stats: {
      structures: structures.length, screened: screened.length, booked: candidates.length,
      executable: opportunities.filter((o) => o.bucket === 'guaranteed').length,
      near: opportunities.filter((o) => o.bucket === 'near').length,
      rejected, structuresByPair: countBy(structures, (st) => pairOf(st.positions)),
      byPair: countBy(opportunities, (o) => o.venuePair), guaranteedByPair: countBy(opportunities.filter((o) => o.bucket === 'guaranteed'), (o) => o.venuePair),
      ms: Date.now() - t0, config: cfg,
    },
  };
}

function depthless(c, ladders, best, table, u, cfg) {
  const providers = [...new Set(c.positions.map((p) => p.market.provider))].sort();
  const net = u.minPayoff - u.unitCost - u.unitFees - cfg.bufferPerShare;
  return {
    id: c.strategy + ':' + c.positions.map((p) => p.market.id + ':' + p.side).join('+'),
    strategy: c.strategy, kind: c.kind, matchStatus: c.matchStatus, checks: c.checks, title: c.title, rationale: c.rationale,
    conditions: c.conditions || null, venues: [...new Set(c.positions.map((p) => VENUE[p.market.provider] || p.market.provider))],
    providers, venuePair: providers.length > 1 ? providers.join('↔') : `${providers[0]} only`,
    legs: c.positions.map((p, i) => ({
      venue: VENUE[p.market.provider] || p.market.provider, provider: p.market.provider, marketId: p.market.id,
      question: p.market.question, label: p.market.label, eventTitle: p.market.eventTitle, side: p.side,
      outcome: p.side === 'yes' ? p.market.yesOutcome : p.market.noOutcome, ask: best[i].p, askSize: best[i].s, bid: ladders[i].bids[0]?.p ?? null,
      depth: ladders[i].asks.slice(0, 6), fill: [], qty: 0, fee: feeRatePerShare(p.market, best[i].p), url: p.market.url, rules: p.market.rules || '',
      endDate: p.market.endDate, quoteTime: ladders[i].timestamp, noDepth: !!ladders[i].noDepth,
    })),
    states: table.map((r) => ({ ...r, boundary: !!c.states.find((x) => x.key === r.key)?.boundary })),
    unit: { cost: u.unitCost, minPayoff: u.minPayoff, minCore: u.minCore, minAll: u.minAll, gross: u.minPayoff - u.unitCost, fees: u.unitFees, buffer: cfg.bufferPerShare, net, roi: net / u.unitCost },
    maxQty: 0, capital: null, netProfit: net, roi: net / u.unitCost, sizes: [], edgeStop: { reason: 'no-depth' },
    bucket: 'near', reasons: [
      ...(c.matchStatus !== STATUS.VERIFIED ? [{ code: 'match', text: `Not a verified match: ${(c.checks || []).filter((x) => x.result !== 'ok').map((x) => x.note || x.field).join('; ') || 'contracts may settle differently'}.` }] : []),
      { code: 'depth', text: 'One venue publishes prices but not order sizes, so we cannot prove any quantity is fillable.' }],
    isExecutable: false, nearArb: true, nearReason: 'Order sizes unknown on one venue.',
    confidence: 0.5, quoteTime: ladders[0].timestamp, quoteAgeMs: 0, fresh: true,
    minLiquidity: Math.min(...c.positions.map((p) => p.market.liquidity || 0)),
  };
}

function countBy(xs, f) { const o = {}; for (const x of xs) { const k = f(x); o[k] = (o[k] || 0) + 1; } return o; }
function pairOf(positions) { const p = [...new Set(positions.map((x) => x.market.provider))].sort(); return p.length > 1 ? p.join('↔') : `${p[0]} only`; }

export const ladderKey = (p) => `${p.market.provider}|${p.market.id}|${p.side}`;
