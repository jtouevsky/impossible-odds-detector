// In-app AI analyst — shared by the browser (context builder) and the server (prompt + offline engine).
//
//   buildContext(...)   -> the structured, data-only context the chat sends with every question
//   systemPrompt()      -> grounding rules for the language model (never invent data)
//   buildPrompt(...)    -> one self-contained prompt (context JSON + computed facts + conversation)
//   answerLocally(...)  -> deterministic answer from the same context (always available, no AI needed)
//
// Pure ES module, no DOM / Node APIs.
import { explainOpportunity, GLOSSARY, HELP } from './explain-engine.js';

const c = (x, d = 1) => (x == null || !isFinite(x) ? '—' : `${(x * 100).toFixed(d).replace(/\.0+$/, '')}¢`);
const usd = (x, d = 2) => (x == null || !isFinite(x) ? '—' : `${x < 0 ? '−' : ''}$${Math.abs(x).toLocaleString('en-US', { minimumFractionDigits: d, maximumFractionDigits: d })}`);
const pct = (x) => (x == null || !isFinite(x) ? '—' : `${(x * 100).toFixed(Math.abs(x * 100) < 1 && x !== 0 ? 2 : 1)}%`);
const qty = (q) => (q == null ? '—' : q >= 1000 ? Math.round(q).toLocaleString('en-US') : q % 1 ? q.toFixed(2) : String(q));
const trim = (s, n) => { s = String(s ?? '').replace(/\s+/g, ' ').trim(); return s.length > n ? s.slice(0, n - 1) + '…' : s; };
const BUCKET = { guaranteed: 'Guaranteed arbitrage', near: 'Near-arb (NOT guaranteed)', research: 'Research anomaly (not a trade)' };

// ---------------------------------------------------------------- context
function legCtx(l) {
  return {
    venue: l.venue, side: l.side.toUpperCase(), contract: l.question, outcome: l.label || null, event: l.eventTitle || null,
    askPrice: l.ask, sharesAtBestAsk: l.noDepth ? null : l.askSize ?? null, sharesUsedAtMaxSize: l.qty ?? null,
    orderBook: l.noDepth ? 'venue does not publish order sizes' : (l.depth || []).slice(0, 6).map((x) => ({ price: x.p, size: x.s })),
    feeTotalAtMaxSize: l.fee ?? null, feePerShare: l.fee != null && l.qty ? l.fee / l.qty : null, settles: (l.endDate || '').slice(0, 10) || null, url: l.url || null,
    rules: trim(l.rules || '(not provided by venue)', 900),
  };
}

export function opportunityContext(o) {
  if (!o) return null;
  return {
    id: o.id, title: o.title, classification: BUCKET[o.bucket] || o.bucket, bucket: o.bucket,
    strategy: o.strategy, structure: o.kind, appRationale: o.rationale,
    matchConfidence: o.matchStatus, matchChecks: (o.checks || []).map((x) => ({ field: x.field, legA: x.a ?? null, legB: x.b ?? null, result: x.result, note: x.note || null })),
    venues: o.venues, legs: o.legs.map(legCtx),
    perBasket: { cost: o.unit.cost, guaranteedPayout: o.unit.minPayoff, grossEdge: o.unit.gross, fees: o.unit.fees, safetyBuffer: o.unit.buffer, net: o.unit.net, roi: o.unit.roi },
    payoffByOutcome: (o.states || []).map((s) => ({ outcome: s.label, rare: !!s.tail, payoutMin: s.lo, payoutMax: s.hi })),
    maxExecutableBaskets: o.maxQty ?? null, capitalRequired: o.capital ?? null, netProfitAtMaxSize: o.netProfit ?? null, netRoi: o.roi ?? null,
    sizeLadder: (o.sizes || []).map((s) => ({ baskets: s.qty, cost: s.cost, payout: s.payout, fees: s.fees, buffer: s.buffer, net: s.net, roi: s.roi })),
    sizeLimitedBy: o.edgeStop?.reason || null,
    whyNotGuaranteed: (o.reasons || []).map((r) => r.text),
    confidence: o.confidence ?? null, quoteTime: o.quoteTime || null, quotesFresh: o.fresh ?? null,
  };
}

/** Everything the analyst may talk about. Only data the app already shows. */
export function comparisonContext(r) {
  if (!r) return null;
  const T = r.target;
  return {
    classification: 'Crowd disagreement — research signal, NOT arbitrage and NOT guaranteed',
    event: r.event.title, start: r.event.start || null, league: r.league, market: r.marketType, period: r.period, line: r.line, outcome: r.side,
    venue: T.venueName, venueKind: T.kind, buyPrice: T.buyPrice, askPrice: T.ask, feePerShare: T.feePerShare, allInPrice: T.allInPrice,
    americanOdds: T.american, decimalOdds: T.decimal, venueRules: { overtime: T.rules?.overtime ?? null, tie: T.rules?.tie ?? null, cancellation: T.rules?.cancellation ?? null, source: T.rules?.source || null },
    estimatedConsensusProbability: r.consensus.probability, consensusMethod: r.consensus.method,
    books: r.consensus.books.map((b) => ({ book: b.name, decimalOdds: b.decimal, impliedWithMargin: b.implied, bookMargin: b.margin, noVigProbability: b.fair, weight: b.weight, ageMin: Math.round(b.ageMs / 6e4) })),
    excludedFromConsensus: r.consensus.excluded,
    rawGapPts: r.disagreementPts, gapAfterFeesPts: r.edgeAfterFeesPts,
    matchConfidence: r.match.status, matchWarnings: r.match.perBook.flatMap((m) => m.checks.filter((c) => c.result !== 'ok').map((c) => `${m.book}: ${c.field} — ${c.note || c.result}`)).slice(0, 8),
    sportsbookRules: 'standard house rules assumed (feed has no rule text): overtime included, tie = push, canceled = void',
    url: T.url,
  };
}

export function buildContext({ view, mode, filters, data, visible, opportunity, research, scannedAt, crowd }) {
  const all = data?.opportunities || [];
  const g = all.filter((o) => o.bucket === 'guaranteed'), n = all.filter((o) => o.bucket === 'near');
  const best = (list) => list.reduce((b, o) => (!b || (o.roi ?? -1) > (b.roi ?? -1) ? o : b), null);
  const pv = Object.values(data?.perVenue || {});
  return {
    screen: { view: { arb: 'Guaranteed arbitrage tab', near: 'Near-arb tab', research: 'Research tab', providers: 'Venues tab' }[view] || view, mode: mode === 'pro' ? 'Pro' : 'Simple' },
    filters: filters ? { search: filters.q || null, strategy: filters.type, minNetRoiPct: filters.roi, minNetProfitUsd: filters.profit, minLiquidityUsd: filters.liq, verifiedOnly: !!filters.verified, venuePair: filters.pair || 'all' } : null,
    board: data ? {
      scannedAt: scannedAt || null, guaranteedCount: g.length, nearArbCount: n.length, researchAnomalies: research?.count ?? null,
      bestGuaranteed: best(g) ? { title: best(g).title, roi: best(g).roi, netProfit: best(g).netProfit } : null,
      bestNear: best(n) ? { title: best(n).title, roi: best(n).roi, netProfit: best(n).netProfit } : null,
      totalGuaranteedProfit: g.reduce((s, o) => s + Math.max(0, o.netProfit || 0), 0),
      visibleNow: (visible || []).slice(0, 8).map((o) => ({ title: o.title, bucket: o.bucket, roi: o.roi, netProfit: o.netProfit, match: o.matchStatus, venues: o.venues })),
      visibleCount: visible ? visible.length : null,
      liveVenues: pv.filter((v) => v.status === 'live' && !v.failed).map((v) => v.name),
      safetyBufferPerBasket: data.config?.bufferPerShare ?? null, maxQuoteAgeSec: data.config?.maxQuoteAgeMs ? data.config.maxQuoteAgeMs / 1000 : null,
      deadZoneBasketsRejected: data.stats?.rejected?.deadZone ?? null, structuresPriced: data.stats?.structures ?? null,
    } : null,
    research: research?.selected || null,
    crowd: crowd ? {
      sportsbookFeed: crowd.feed || null, comparisons: crowd.count ?? null, filters: crowd.filters || null,
      visibleNow: (crowd.visible || []).map((r) => ({ event: r.event.title, venue: r.target.venueName, outcome: r.side, buyPrice: r.target.buyPrice, consensus: r.consensus.probability, gapAfterFeesPts: r.edgeAfterFeesPts, match: r.match.status })),
      selected: comparisonContext(crowd.selected),
    } : null,
    opportunity: opportunityContext(opportunity),
  };
}

// ---------------------------------------------------------------- computed facts (shared by LLM + local)
export function tradeInstructions(op) {
  if (!op) return null;
  const lines = op.legs.map((l) => {
    const named = l.outcome && !/^(yes|no)$/i.test(l.outcome);
    const ev = named ? (l.event || l.contract) : null;
    return `Buy ${l.side} on ${l.venue} — "${named ? l.outcome : l.contract}"${ev && ev !== l.outcome ? ` (${ev})` : ''} at ${c(l.askPrice)} per share`;
  });
  const b = op.perBasket, N = op.maxExecutableBaskets;
  const total = N ? `For ${qty(N)} baskets (the most the order books allow): total cost ${usd(op.capitalRequired)}, ${op.bucket === 'guaranteed' ? 'guaranteed' : 'minimum'} payout ${usd(N * b.guaranteedPayout)}, estimated net profit ${usd(op.netProfitAtMaxSize)} (${pct(op.netRoi)}).` : null;
  return {
    lines,
    perBasket: `One basket (1 share of each leg): total cost ${c(b.cost, 2)}, ${op.bucket === 'guaranteed' ? 'guaranteed' : 'minimum'} payout ${usd(b.guaranteedPayout)}, fees ≈${c(b.fees, 2)}, safety buffer ${c(b.safetyBuffer, 2)} → estimated net ${c(b.net, 2)} per basket.`,
    total,
  };
}

// ---------------------------------------------------------------- LLM prompt
export function systemPrompt() {
  return `You are the built-in analyst inside "Impossible Odds Detector", a local app that scans prediction markets (Polymarket, Kalshi, PredictIt, Limitless, Manifold) for arbitrage.
You explain things to someone NEW to prediction markets: plain words, short sentences, concrete numbers.

HARD RULES
- Use ONLY the numbers, contracts, venues, rules and prices in the APP CONTEXT. Never invent prices, sizes, fees, dates, rules or opportunities. If something isn't in the context, say "the app doesn't show that" and say where the user could check (e.g. the venue's rules page).
- Keep the three categories strictly separate:
  * Guaranteed arbitrage = profit in EVERY outcome after fees + buffer, verified match, fresh quotes (still needs all legs to fill at the quoted prices).
  * Near-arb = looks profitable but at least one thing is NOT guaranteed (unverified match, rare-outcome/tail risk, stale quotes, or unknown order size). Never call it guaranteed or risk-free.
  * Research anomaly = a pricing inconsistency, NOT a trade; acting on it can lose money.
- When asked how to make money, give exact steps in this form: "Buy X on <venue> at __¢, buy Y on <venue> at __¢. Total cost __, guaranteed payout __, estimated net profit __." using the context numbers (per basket and at max size).
- Prices are dollars per share; a share pays $1 if it wins. 1 basket = 1 share of every leg.
- Mention that quotes can move and both legs must fill when it matters. No financial advice framing beyond that; no hype.
- Crowd disagreement rows compare one venue's buy price with an ESTIMATED consensus probability from other sportsbooks (margin removed per book from both sides of the same bet, freshness-weighted, the evaluated venue excluded). It is an estimate, not the truth, and a gap is never guaranteed profit or arbitrage. Say "estimated consensus probability".
- Sports baskets with a sportsbook leg are "execution unverified" (books don't publish limits) and never guaranteed. DFS/pick'em (PrizePicks, Underdog) are not sportsbook odds and are never used for consensus or arbitrage. A different line or period is a different bet.
- If no opportunity is selected, answer about the board, the filters, or the term asked about, and suggest opening a trade card for specifics.
- Format: short paragraphs or bullet lists, **bold** for key numbers. Max ~180 words unless asked for more. No headings, no tables.`;
}

export function buildPrompt(messages, ctx) {
  const facts = ctx.opportunity ? tradeInstructions(ctx.opportunity) : null;
  const hist = messages.slice(-10).map((m) => `${m.role === 'user' ? 'USER' : 'ANALYST'}: ${trim(m.content, 2000)}`).join('\n\n');
  return `APP CONTEXT (JSON, authoritative — the only data you may use):
${JSON.stringify(ctx)}
${facts ? `\nPRE-COMPUTED TRADE STEPS (from the app's engine, already exact):\n${facts.lines.map((l) => '- ' + l).join('\n')}\n${facts.perBasket}${facts.total ? '\n' + facts.total : ''}\n` : ''}
GLOSSARY (app definitions): ${Object.entries(GLOSSARY).map(([k, v]) => `${k}: ${v.short}`).join(' | ')}

CONVERSATION:
${hist}

Reply as ANALYST to the last USER message.`;
}

// ---------------------------------------------------------------- local deterministic analyst
const TERMS = [
  [/execut\w* size|max(imum)? size|how (much|many) can i (trade|buy)|baskets?\b(?!.*profit)/, 'executable size'],
  [/\bnet roi\b|\broi\b|return on/, 'net ROI'],
  [/slippage/, 'slippage'], [/buffer/, 'safety buffer'], [/dead.?zone/, 'dead zone'], [/tail|cancel|postpone/, 'tail state'],
  [/verified|likely match|mismatch|match(ing)? (confidence|status)/, 'verified match'], [/near.?arb/, 'near-arb'],
  [/\bimplication|\bnested\b|\bimpl(y|ies)\b/, 'implication'], [/exhaustive/, 'exhaustive'], [/mutually exclusive|exclusive/, 'exclusive'],
  [/equivalen/, 'equivalence'], [/consensus/, 'estimated consensus'], [/no.?vig|devig|de-vig/, 'no-vig'], [/\bvig\b|margin|juice|overround/, 'bookmaker margin'],
  [/implied prob|american odds|decimal odds|\bodds\b/, 'implied probability'], [/\bprops?\b/, 'player prop'], [/\bpush/, 'push'], [/prizepicks|underdog|\bdfs\b|pick.?em/, 'dfs'], [/fresh|stale/, 'freshness'], [/guaranteed payout|min(imum)? payout/, 'guaranteed payout'], [/arbitrage|\barb\b/, 'arbitrage'],
];
const HELP_TERMS = [
  [/min(imum)? roi|roi filter/, 'minRoi'], [/min(imum)? profit|profit filter/, 'minProfit'], [/liquidity/, 'minLiq'],
  [/strateg|cross.?platform|multi.?outcome|binary/, 'strategy'], [/confidence/, 'confidence'], [/research/, 'research'],
  [/venue|provider|platform/, 'providers'], [/simple mode|pro mode|beginner/, 'beginner'], [/capital|money needed/, 'cost'],
];

const has = (q, re) => re.test(q);

function intentOf(q) {
  if (has(q, /how (exactly )?(would|do|can) i (make|earn)|make money|step|what (do|should) i (buy|click|do)|place (the )?trade|execute/)) return 'how';
  if (has(q, /(if|with) i (put|invest|have|use|spend)|\$\s?\d|\d+\s?(dollars|usd|bucks)/)) return 'amount';
  if (has(q, /difference between|guaranteed (vs|versus|or) near|three (buckets|categories|tabs)/)) return 'buckets';
  if (has(q, /filter/)) return 'filters';
  if (has(q, /isn.?t.*guaranteed|not guaranteed|why (is it )?(only )?near|why.*near.?arb/)) return 'notGuaranteed';
  if (has(q, /what could (make (this|it) )?(fail|go wrong)|risk|fail|downside|\\blose\\b/)) return 'risks';
  if (has(q, /why (is )?(this|it) (considered )?(an )?arb|why (does|is) (this|it) (work|qualif)|why.*arbitrage/)) return 'why';
  if (has(q, /outcome|scenario|what happens if|payoff|state/)) return 'outcomes';
  if (has(q, /fee/)) return 'fees';
  if (has(q, /rule|resolve|settle|resolution|same (contract|market)/)) return 'rules';
  if (has(q, /like i.?m new|explain (this|it)|simpl|eli5|what is this|what am i looking at|summar/)) return 'explain';
  if (has(q, /fresh|stale|quote|old|recheck|re-check|still there/)) return 'fresh';
  if (has(q, /best|top|which (one|trade)|how many|anything (good|worth)|board|right now/)) return 'board';
  return null;
}

function term(q) {
  for (const [re, k] of TERMS) if (re.test(q) && GLOSSARY[k]) return { kind: 'g', k };
  for (const [re, k] of HELP_TERMS) if (re.test(q) && HELP[k]) return { kind: 'h', k };
  return null;
}

function explainTerm(t, op) {
  if (t.kind === 'h') {
    const extra = t.k === 'minRoi' || t.k === 'minProfit' || t.k === 'minLiq' ? ' It only changes what is shown, never the math.' : '';
    return `${HELP[t.k]}${extra}`;
  }
  const g = GLOSSARY[t.k];
  let s = `**${t.k[0].toUpperCase() + t.k.slice(1)}:** ${g.short}\n\n${g.long}\n\nExample: ${g.example}`;
  if (op && t.k === 'executable size') s += `\n\nFor this trade: ${op.maxExecutableBaskets ? `**${qty(op.maxExecutableBaskets)} baskets** (needs ${usd(op.capitalRequired)}). ${op.sizeLimitedBy === 'book-empty' ? 'It stops there because an order book runs out of offers.' : op.sizeLimitedBy === 'unprofitable' ? 'Beyond that the next price levels would make each extra basket lose money after fees.' : ''}` : 'the venue does not publish order sizes, so only per-basket economics are known.'}`;
  if (op && t.k === 'net ROI') s += `\n\nFor this trade: **${pct(op.netRoi)}** net, before your money is locked until ${op.legs.map((l) => l.settles).filter(Boolean).sort().pop() || 'settlement'}.`;
  if (op && t.k === 'verified match') s += `\n\nThis trade's match status is **${op.matchConfidence}**.`;
  if (op && t.k === 'safety buffer') s += `\n\nThis trade subtracts **${c(op.perBasket.safetyBuffer, 2)}** per basket.`;
  return s;
}

function howText(op) {
  const t = tradeInstructions(op);
  const guaranteed = op.bucket === 'guaranteed';
  return [
    ...t.lines.map((l, i) => `${i + 1}. ${l}`),
    '',
    t.perBasket,
    t.total || 'The venue doesn\'t publish order sizes, so the app can\'t say how many baskets you could fill.',
    '',
    guaranteed
      ? 'Whatever happens, one side of the basket pays out — that is the profit. Place all legs quickly; if prices move before every leg fills, the edge can disappear.'
      : `**This is not guaranteed.** ${op.whyNotGuaranteed.join(' ') || 'Not every check passed.'}`,
  ].join('\n');
}

function outcomesText(op) {
  const b = op.perBasket;
  return `Here is what one basket (cost ${c(b.cost, 2)} + ${c(b.fees, 2)} fees) pays in every outcome the app checked:\n\n${op.payoffByOutcome.map((s) => `- ${s.outcome}${s.rare ? ' (rare)' : ''}: pays ${s.payoutMin === s.payoutMax ? usd(s.payoutMin) : `${usd(s.payoutMin)}–${usd(s.payoutMax)}`} → ${s.payoutMin - b.cost - b.fees - b.safetyBuffer > 0 ? 'profit' : '**loss**'}`).join('\n')}\n\nThe smallest of these, **${usd(b.guaranteedPayout)}**, is the ${op.bucket === 'guaranteed' ? 'guaranteed payout' : 'minimum payout'}.`;
}

function risksText(op) {
  const r = explainOpportunityFromCtx(op);
  return `Things that could make it fail:\n\n${r.map((x) => `- ${x}`).join('\n')}`;
}

function explainOpportunityFromCtx(op) {
  const out = [
    'One leg fills and the other moves before you buy it (slippage) — place them back-to-back and re-check live prices first.',
    `Your money is locked until settlement (${op.legs.map((l) => l.settles).filter(Boolean).sort().pop() || 'see rules'}).`,
  ];
  if (op.venues.length > 1) out.push('You need funded accounts on both venues, and each settles independently under its own rules.');
  if (op.matchConfidence !== 'VERIFIED') out.push(`The match is only **${op.matchConfidence}** — the two contracts might not settle on exactly the same thing.`);
  out.push(...op.whyNotGuaranteed);
  if (op.legs.some((l) => typeof l.orderBook === 'string')) out.push('One venue does not publish order sizes, so the quoted price may only cover a few shares.');
  if (op.payoffByOutcome.some((s) => s.rare)) out.push('Rare outcomes (cancellation, postponement) are counted at their worst case.');
  return [...new Set(out)];
}

function boardText(ctx) {
  const b = ctx.board;
  if (!b) return 'Market data is still loading — give the scan a moment, then ask again.';
  const lines = [`Right now the app shows **${b.guaranteedCount} guaranteed** arbitrage trade${b.guaranteedCount === 1 ? '' : 's'} and **${b.nearArbCount} near-arb** trades${b.researchAnomalies != null ? `, plus ${b.researchAnomalies.toLocaleString('en-US')} research anomalies (not trades)` : ''}, across ${b.liveVenues.join(', ') || 'no live venues'}.`];
  if (b.bestGuaranteed) lines.push(`Best guaranteed: **${b.bestGuaranteed.title}** — ${pct(b.bestGuaranteed.roi)} net, ${usd(b.bestGuaranteed.netProfit)} at max size.`);
  else lines.push('Nothing is guaranteed right now — that is normal for efficient markets, and the app won\'t invent one.');
  if (b.bestNear) lines.push(`Best near-arb (not guaranteed): ${b.bestNear.title} — ${pct(b.bestNear.roi)}.`);
  if (b.visibleNow?.length) lines.push(`\nOn your screen (${b.visibleCount}):\n${b.visibleNow.slice(0, 5).map((o) => `- ${o.title} · ${pct(o.roi)} · ${o.match}`).join('\n')}`);
  lines.push('\nOpen any trade card and I\'ll walk through it step by step.');
  return lines.join('\n');
}

function amountText(q, op) {
  const m = q.match(/\$\s?([\d,]+(?:\.\d+)?)|([\d,]+(?:\.\d+)?)\s?(?:dollars|usd|bucks)/);
  const amt = m ? +(m[1] || m[2]).replace(/,/g, '') : null;
  if (!amt) return null;
  const b = op.perBasket;
  const perBasket = b.cost + b.fees;
  let n = Math.floor(amt / perBasket);
  const capped = op.maxExecutableBaskets != null && n > op.maxExecutableBaskets;
  if (capped) n = Math.floor(op.maxExecutableBaskets);
  const net = n * b.net;
  return `With ${usd(amt)} you could buy about **${qty(n)} baskets** (each ${c(perBasket, 2)} including fees)${capped ? ` — capped at the ${qty(op.maxExecutableBaskets)} the order books can fill at a profit` : ''}. At top-of-book prices that's roughly **${usd(net)}** net profit${op.bucket === 'guaranteed' ? '' : ' — **not guaranteed**'}.\n\nThis is an estimate from the best prices only; the size table in the trade sheet walks the real order books level by level.`;
}

export function answerLocally(question, ctx) {
  const q = String(question || '').toLowerCase();
  const op = ctx?.opportunity;
  const intent = intentOf(q);
  const t = term(q);

  // Questions about a term always get the term, enriched with this trade's numbers.
  const termQ = has(q, /what (is|are|does)|mean|define|\?$/);
  if (intent === 'buckets') return BUCKETS_TEXT;
  if (intent === 'filters') return filtersText(ctx);
  if (t && termQ && !['how', 'risks', 'notGuaranteed', 'why', 'amount', 'outcomes', 'fees'].includes(intent)) return explainTerm(t, op);
  if (intent === 'board') return boardText(ctx);
  if (!op && ctx?.research?.title) return researchText(q, ctx.research, intent);
  if (!op && ctx?.crowd?.selected && !(t && termQ && !has(q, /this|here/))) return crowdText(q, ctx.crowd.selected, intent, t);
  if (!op && ctx?.crowd && /crowd/i.test(ctx.screen?.view || '') && !t && intent !== 'buckets' && intent !== 'filters') return crowdBoardText(ctx.crowd);
  if (!op) {
    if (t) return explainTerm(t, null);
    if (intent === 'explain') return `${INTRO}\n\n${boardText(ctx)}`;
    if (intent === 'fees') return `Every trade in the app is shown **after fees**, using each venue's own fee formula at the actual fill price:\n\n- **Polymarket:** fee-enabled markets charge a small fee that is largest near 50¢ and shrinks toward 0¢/$1; many markets charge nothing.\n- **Kalshi:** about 7% × price × (1 − price) per contract, rounded up to the cent.\n- **PredictIt:** 10% of your profit on winning shares.\n\nOpen a trade card and I'll give you its exact fee per share.`;
    return `${boardText(ctx)}${intent ? '\n\n(Select a trade card for trade-specific answers.)' : ''}`;
  }
  const raw = { ...op, legs: op.legs };
  switch (intent) {
    case 'how': return howText(raw);
    case 'amount': return amountText(q, raw) || howText(raw);
    case 'risks': return risksText(raw);
    case 'notGuaranteed':
      return op.bucket === 'guaranteed'
        ? `It **is** in the Guaranteed bucket: the lowest payout in any outcome (${usd(op.perBasket.guaranteedPayout)}) beats the cost (${c(op.perBasket.cost, 2)}) plus fees and the ${c(op.perBasket.safetyBuffer, 2)} safety buffer, the match is ${op.matchConfidence}, and quotes were fresh. The only things that can break it are execution: both legs must fill at these prices before they move.`
        : `It's near-arb, not guaranteed, because: ${op.whyNotGuaranteed.map((x) => `\n- ${x}`).join('') || ' not every check passed.'}\n\nThe math (${c(op.perBasket.net, 2)} net per basket) only holds if those issues don't bite.`;
    case 'why': {
      const kindWhy = whyFromCtx(op);
      return `${kindWhy}\n\n${op.bucket === 'guaranteed' ? `That's arbitrage: in **every** outcome the basket pays at least ${usd(op.perBasket.guaranteedPayout)}, more than the ${c(op.perBasket.cost, 2)} cost + fees + buffer.` : `It *would* be arbitrage if the checks all passed — but it's **near-arb**: ${op.whyNotGuaranteed.join(' ')}`}`;
    }
    case 'outcomes': return outcomesText(raw);
    case 'fees': return `Fees for this trade are about **${c(op.perBasket.fees, 2)} per basket**${op.maxExecutableBaskets ? ` (${usd(op.sizeLadder.at(-1)?.fees ?? op.perBasket.fees * op.maxExecutableBaskets, 3)} at max size)` : ''}. Each venue's fee formula is applied at the actual fill price:\n${op.legs.map((l) => `- ${l.venue} ${l.side}: ${l.feePerShare != null ? c(l.feePerShare, 2) + ' per share' : 'fee per share not reported'}`).join('\n')}\n\nThe net profit shown is already after fees and the ${c(op.perBasket.safetyBuffer, 2)} safety buffer.`;
    case 'rules': return `Match confidence: **${op.matchConfidence}**.${op.matchChecks.length ? `\n\n${op.matchChecks.map((x) => `- ${x.field}: ${x.result.toUpperCase()}${x.note ? ` (${x.note})` : ''}`).join('\n')}` : '\n\nBoth legs are on the same venue under the same rule book; the link comes from the market\'s own structure.'}\n\nRules text the app has:\n${op.legs.filter((l, i, a) => a.findIndex((x) => x.contract === l.contract) === i).map((l) => `- ${l.venue}: ${trim(l.rules, 280)}`).join('\n')}`;
    case 'fresh': return `Quotes are from ${op.quoteTime || 'an unknown time'}${op.quotesFresh === false ? ' and were already **stale** at scan time' : ''}. Prices move constantly — use "Re-check live prices" in the trade sheet right before trading.`;
    case 'explain':
    default: {
      if (t && !has(q, /this (opportunity|trade)|like i.?m new/)) return explainTerm(t, op);
      const ex = explainCtx(op);
      return has(q, /new|beginner|never/) ? `${PRIMER}\n\n${ex}` : ex;
    }
  }
}

function whyFromCtx(op) {
  // reuse the app's own explanation text by rebuilding the minimal opportunity shape
  try { return explainOpportunity(toOpp(op)).why; } catch { return op.appRationale || ''; }
}

function explainCtx(op) {
  let ex;
  try { ex = explainOpportunity(toOpp(op)); } catch { ex = null; }
  const t = tradeInstructions(op);
  return [
    `**${op.title}** — ${op.classification}.`,
    '',
    ex?.why || op.appRationale,
    '',
    `In practice: ${t.lines.join('; ')}.`,
    t.perBasket,
    '',
    op.bucket === 'guaranteed'
      ? 'Each share pays $1 if it wins and $0 if it loses. Because your shares cover every outcome, something always pays — that\'s why the profit is locked in (as long as every leg fills at these prices).'
      : `Each share pays $1 if it wins and $0 if it loses. **Not guaranteed:** ${op.whyNotGuaranteed.join(' ')}`,
  ].join('\n');
}

// Context → opportunity shape accepted by explainOpportunity().
function toOpp(op) {
  return {
    kind: op.structure, rationale: op.appRationale, bucket: op.bucket, venues: op.venues, reasons: op.whyNotGuaranteed.map((text) => ({ text })),
    unit: { cost: op.perBasket.cost, minPayoff: op.perBasket.guaranteedPayout, fees: op.perBasket.fees, buffer: op.perBasket.safetyBuffer, net: op.perBasket.net },
    legs: op.legs.map((l) => ({ side: l.side.toLowerCase(), ask: l.askPrice, question: l.contract, label: l.outcome, eventTitle: l.event, venue: l.venue, endDate: l.settles, askSize: l.sharesAtBestAsk })),
    states: op.payoffByOutcome.map((s) => ({ label: s.outcome, tail: s.rare, lo: s.payoutMin, hi: s.payoutMax, legs: [] })),
  };
}

const INTRO = `**Prediction markets in one minute:** each contract is a yes/no question. A share costs between 0¢ and $1 and pays **$1 if it wins, $0 if it loses** — so a 40¢ price roughly means the market thinks there's a 40% chance.\n\n**Arbitrage** means buying a set of shares that pays you more than it costs *no matter what happens*. This app hunts for those across venues, subtracts fees and a safety buffer, and only calls something "guaranteed" when every possible outcome is covered.`;

const PRIMER = 'Quick primer: every contract is a yes/no question. A share costs 0–100¢ and pays **$1 if it wins, $0 if it loses**. A "basket" here means one share of each leg below.';

const BUCKETS_TEXT = `The app sorts everything into three buckets:\n\n- **Guaranteed arbitrage** — pays more than it costs in *every* outcome, after fees and a safety buffer, with a verified contract match and fresh quotes. The only remaining risk is execution (all legs must fill at those prices).\n- **Near-arb** — the math looks profitable, but one thing isn't certain: the contracts may settle differently, a rare outcome (like a cancellation) could break the hedge, quotes are stale, or the venue hides order sizes.\n- **Research** — pricing that doesn't add up logically. Interesting, but **not a trade**; acting on it can lose money.`;

function filtersText(ctx) {
  const f = ctx.filters;
  const now = f ? `\n\nYour current filters: strategy **${f.strategy}**, min ROI **${f.minNetRoiPct}%**, min profit **$${f.minNetProfitUsd}**, min liquidity **$${f.minLiquidityUsd}**, venue pair **${f.venuePair}**${f.search ? `, search "${f.search}"` : ''}${f.verifiedOnly ? ', verified matches only' : ''}.` : '';
  return `Filters only change what's shown — never the math.\n\n- **Strategy:** ${HELP.strategy}\n- **Min ROI:** ${HELP.minRoi}\n- **Min profit:** ${HELP.minProfit}\n- **Min liquidity:** ${HELP.minLiq}\n- **Venue pair:** only show trades between two specific venues.\n- **Verified only** (Near-arb tab): ${HELP.verified}${now}`;
}

function researchText(q, r, intent) {
  const legs = (r.markets || []).slice(0, 6).map((m) => `- ${m.contract} (${m.venue}): ${pct(m.price)}${m.bid != null && m.ask != null ? ` · bid ${c(m.bid)} / ask ${c(m.ask)}` : ''}`).join('\n');
  const notTrade = `**This is a research anomaly, not a trade.** ${r.tradableAtTopOfBook ? 'At the top of the books it looks tradable before fees, but it has not passed the arbitrage engine\'s checks (every outcome, real depth, fees, buffer, rule match) — so it is not in the Guaranteed or Near-arb lists.' : 'The bid/ask spreads absorb it, so there is no profitable trade at current prices.'}`;
  if (intent === 'how' || intent === 'amount' || has(q, /trade|money|profit/)) return `${notTrade}\n\nIf it ever becomes a real opportunity, the arbitrage engine will list it in the Guaranteed or Near-arb tab with exact buy instructions.`;
  if (has(q, /size|violation|magnitude|pts|points/)) return `${r.size}\n\nViolation: **${(r.violationPts * 100).toFixed(1)} pts**, confidence **${Math.round((r.confidence || 0) * 100)}%**.`;
  return `**${r.title}** (${r.relationship}).\n\n${r.why}\n\nPrices the app has:\n${legs}\n\n${notTrade}`;
}

function crowdText(q, r, intent, t) {
  const p = (x) => `${Math.round(x * 1000) / 10}%`;
  const gap = r.gapAfterFeesPts;
  const books = r.books.map((b) => `- ${b.book}: odds ${b.decimalOdds.toFixed(2)} → ${p(b.impliedWithMargin)} with margin, **${p(b.noVigProbability)}** no-vig (margin ${p(b.bookMargin)}, weight ${b.weight.toFixed(2)}, ${b.ageMin} min old)`).join('\n');
  const price = r.venueKind === 'prediction' ? `${c(r.askPrice)} ask + ${c(r.feePerShare, 2)} fee = ${c(r.allInPrice, 2)} all-in` : `${p(r.buyPrice)} implied`;
  const head = `**${r.event}** — ${r.outcome.toUpperCase()}${r.line != null ? ` ${r.line}` : ''} (${r.market}, ${r.period}).`;
  const notArb = '**This is not arbitrage and not guaranteed.** The consensus is an estimate; the price can stay different or move against you, and you only win if the outcome happens.';
  if (intent === 'how' || intent === 'amount' || has(q, /money|profit|bet|buy/)) {
    return `${head}\n\nIf you trusted the consensus, the trade would be: buy **${r.outcome.toUpperCase()}** on ${r.venue} at ${price}. The estimated consensus is **${p(r.estimatedConsensusProbability)}**, a gap of **${gap >= 0 ? '+' : ''}${gap.toFixed(1)} pts** after fees. On average that would be worth about ${gap >= 0 ? '' : 'minus '}${Math.abs(gap).toFixed(1)}¢ per $1 share — *if* the consensus is right.\n\n${notArb}`;
  }
  if (intent === 'why' || intent === 'notGuaranteed' || has(q, /arbitrage|guarantee/)) return `${notArb}\n\nArbitrage means a basket that pays more than it costs in **every** outcome. Here you'd hold one side only: if ${r.outcome.toUpperCase()} doesn't happen you lose the stake. The gap only says sportsbooks, on average, think this is ${gap >= 0 ? 'more' : 'less'} likely than the price implies.`;
  if (intent === 'risks') return `What could make this wrong:\n\n- The consensus is only an estimate from ${r.books.length} book${r.books.length === 1 ? '' : 's'}; they can all be wrong together.\n- Match confidence is **${r.matchConfidence}**${r.matchWarnings.length ? `: ${r.matchWarnings.slice(0, 3).join('; ')}` : ''}.\n- Sportsbook rules are assumed (${r.sportsbookRules}); ${r.venue} rules: overtime ${r.venueRules.overtime ?? 'not stated'}, tie ${r.venueRules.tie ?? 'not stated'}.\n- Prices move; check freshness and re-check before acting.\n- One-sided bet: you can lose the whole stake.`;
  if (t) return explainTerm(t, null);
  return `${head}\n\nSportsbooks (margin removed, freshness-weighted, ${r.venue} excluded) put this at about **${p(r.estimatedConsensusProbability)}**. ${r.venue}'s ${r.venueKind === 'prediction' ? 'buy price' : 'price'} is **${price}**. Gap after fees: **${gap >= 0 ? '+' : ''}${gap.toFixed(1)} pts**.\n\n${books}\n\n${notArb}`;
}

function crowdBoardText(cr) {
  const f = cr.sportsbookFeed;
  if (f?.state === 'needs-setup') return `The Crowd tab is waiting for sportsbook odds: it needs a **free The Odds API key** (Venues → Sports odds feed). Without it the app shows nothing rather than invented odds.\n\nOnce set up, each row compares a prediction market's buy price with an **estimated consensus probability** from DraftKings, FanDuel, BetMGM and Pinnacle (margin removed). Gaps are research signals, never guaranteed profit.`;
  const rows = (cr.visibleNow || []).map((r) => `- ${r.event} · ${r.outcome.toUpperCase()} on ${r.venue}: price ${Math.round(r.buyPrice * 100)}% vs consensus ${Math.round(r.consensus * 100)}% (${r.gapAfterFeesPts >= 0 ? '+' : ''}${r.gapAfterFeesPts.toFixed(1)} pts, ${r.match})`).join('\n');
  return `There ${cr.comparisons === 1 ? 'is' : 'are'} **${cr.comparisons ?? 0}** comparable quotes.${rows ? `\n\nOn your screen:\n${rows}` : ' None pass the current filters.'}\n\nThese are disagreements worth researching — not arbitrage. Open a row and I'll walk through the math.`;
}

export const CROWD_SUGGESTIONS = ['Explain this comparison simply', 'How would I make money here?', 'Why is this not arbitrage?', 'What is bookmaker margin?', 'How is the consensus calculated?', 'What could make this wrong?'];
export const CROWD_BOARD_SUGGESTIONS = ['What is the Crowd disagreement tab?', 'What is an estimated consensus probability?', 'What is no-vig?', 'What are player props?', "Why aren't PrizePicks lines used?"];

export const SUGGESTIONS = [
  'Explain this opportunity simply',
  'How exactly would I make money here?',
  'What could make this fail?',
  'What does executable size mean?',
  'Why is this considered arbitrage?',
  "Why isn't this opportunity guaranteed?",
  "Explain this like I'm new to prediction markets",
];
export const BOARD_SUGGESTIONS = [
  'What are the best opportunities right now?',
  "Explain this like I'm new to prediction markets",
  'What is the difference between guaranteed and near-arb?',
  'What does executable size mean?',
  'What do the filters do?',
];
