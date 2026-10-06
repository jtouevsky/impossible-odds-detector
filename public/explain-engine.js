// Local, deterministic explanation engine (no API, no LLM). Shared by the UI and the tests.

const c = (x, d = 1) => (x == null || !isFinite(x) ? '—' : `${(x * 100).toFixed(d).replace(/\.0$/, '')}¢`);
const usd = (x, d = 2) => (x == null || !isFinite(x) ? '—' : `$${x.toFixed(d)}`);
const pct = (x) => (x == null || !isFinite(x) ? '—' : `${(x * 100).toFixed(x * 100 < 1 && x > 0 ? 2 : 1)}%`);
const VENUE_NOTE = { Polymarket: 'crypto-settled (USDC) exchange', Kalshi: 'CFTC-regulated US exchange', PredictIt: 'US political market with $850 limits', Limitless: 'on-chain exchange' };

export const GLOSSARY = {
  'guaranteed payout': { short: 'The least you can collect, whatever happens.', long: 'We list every way the event(s) can turn out and add up what your basket pays in each one. The smallest of those totals is the guaranteed payout. If it beats what you paid (after fees), the trade is arbitrage.', example: 'A basket that pays $1 in two outcomes and $2 in a third has a guaranteed payout of $1.' },
  arbitrage: { short: 'A set of trades that makes money in every possible outcome.', long: 'You buy several contracts whose payouts cover every outcome. If the total cost (plus fees) is less than the smallest possible payout, you profit no matter what happens — as long as every order fills at the quoted price.', example: 'Buy YES at 43¢ on one site and NO on the identical question at 52¢ elsewhere: 95¢ in, $1 out.' },
  implication: { short: 'If A happens, B must happen too.', long: 'Some contracts are nested: "BTC above $90k" can only be YES if "BTC above $85k" is also YES. So A can never be more likely than B. When prices say otherwise, buying YES on the broader one and NO on the narrower one can lock in a profit.', example: 'Reaching $75B means you already passed $70B.' },
  exhaustive: { short: 'The listed outcomes cover everything that can happen — exactly one wins.', long: 'If outcomes are mutually exclusive AND exhaustive, buying YES on every one guarantees exactly one $1 payout. We only treat a set as exhaustive when the market structure proves it (e.g. numeric ranges that tile the whole line).', example: 'Fed decision: cut 50+, cut 25, hold, hike 25, hike 50+.' },
  exclusive: { short: 'At most one of these can be YES.', long: 'Mutually exclusive outcomes can\'t both happen. Buying NO on all of them pays at least (number of outcomes − 1) dollars, because at most one NO loses.', example: 'Only one candidate can win the election.' },
  equivalence: { short: 'Two contracts that pay on exactly the same thing.', long: 'Same event, same outcome, same deadline, same rules. If one venue prices YES lower than the other prices NO, buying both locks in the difference. Wording alone is never enough — dates, thresholds and settlement rules must match.', example: '"Colts beat Commanders on Oct 4" on Polymarket and on Kalshi.' },
  'verified match': { short: 'We checked the settlement rules field by field and they line up.', long: 'Event, outcome, threshold, date/time window, geography, sources and tie/cancellation handling are compared. VERIFIED means no differences found; LIKELY means very similar but something could differ; MISMATCH means they are different contracts.', example: 'Same NFL game, same team, both settle ties at 50/50 → VERIFIED.' },
  'executable size': { short: 'How much you can actually trade before the profit disappears.', long: 'Order books only hold so many shares at each price. We walk each book level by level and stop when the next share would no longer be profitable after fees and buffer.', example: '200 shares available at 43¢, then the price jumps to 45¢ and the edge is gone → executable size 200.' },
  'net ROI': { short: 'Profit after fees and safety buffer, divided by the money you put in.', long: 'Net profit ÷ capital required. Remember your money is locked until the market settles, so a 2% ROI over 3 months is very different from 2% overnight.', example: 'Pay $95, get back $100 minus $1.20 fees → $3.80 / $95 = 4.0%.' },
  slippage: { short: 'Prices moving against you between seeing a quote and filling it.', long: 'Books change constantly. If one leg fills and the other doesn\'t (or fills worse), the "guaranteed" profit can vanish. We subtract a safety buffer and re-check live books on demand, but you still need to place both legs quickly.', example: 'You buy leg 1 at 43¢; by the time you click leg 2 its price moved from 52¢ to 54¢.' },
  'safety buffer': { short: 'A cushion we subtract from every basket to absorb small price moves.', long: 'Default 0.5¢ per $1 basket. Opportunities must stay profitable even after this cushion.', example: 'Gross edge 2¢ − fees 0.6¢ − buffer 0.5¢ = 0.9¢ net.' },
  'near-arb': { short: 'Looks like free money, but something isn\'t guaranteed.', long: 'Either the contracts might settle differently (unverified match), a rare outcome like a cancelled game could break the hedge, quotes are stale, or the venue doesn\'t publish order sizes.', example: 'Same election on two sites, but one pays on the AP call and the other on certification.' },
  'dead zone': { short: 'An outcome where every leg of the basket loses.', long: 'If any possible outcome pays $0, it is not arbitrage — no matter how cheap the basket is. We check every region between thresholds to find these.', example: 'NO on "$70B" + YES on "$75B": if it lands at $72B, both lose.' },
  'estimated consensus': { short: 'What several sportsbooks imply, after removing their built-in margin, averaged.', long: 'Each book\'s odds are turned into probabilities, the book\'s margin is removed using both sides of the same bet, and the books are averaged with weights that shrink as quotes age. The venue being evaluated is left out. It\'s the crowd\'s estimate — not the truth.', example: 'DraftKings 58%, FanDuel 60%, Pinnacle 59% (all no-vig) → about 59%.' },
  'bookmaker margin': { short: 'The extra built into sportsbook odds so the book profits (the "vig").', long: 'Add up the implied probabilities of every outcome of one bet and you get more than 100% — the excess is the margin. We remove it proportionally before comparing.', example: '−110 / −110 → 52.4% + 52.4% = 104.8%: a 4.8% margin; no-vig 50% / 50%.' },
  'no-vig': { short: 'A probability with the bookmaker margin taken out.', long: 'Needs BOTH sides of the same bet from the same book. From a single side you can\'t know how the margin was split, so we don\'t compute it.', example: '1.80 and 2.10 → implied 55.6% + 47.6% = 103.2% → no-vig 53.8% / 46.2%.' },
  'implied probability': { short: 'The chance a price "says" an outcome has.', long: 'Decimal odds d imply 1/d. American +150 = 2.50 decimal = 40%; −150 = 1.667 = 60%. Implied probabilities still include the book\'s margin.', example: 'A 52¢ prediction-market share implies 52%.' },
  'player prop': { short: 'A bet on one player\'s stats (yards, touchdowns…).', long: 'Only the same player, statistic, period and line count as the same bet. Over 1.5 TDs and over 2.5 TDs are different bets; a different line is never treated as equivalent.', example: 'Mahomes over 1.5 passing TDs.' },
  push: { short: 'A bet that lands exactly on the line or ends tied — your stake comes back.', long: 'Sportsbooks usually refund a push. Prediction markets may settle a tie at 50¢ instead. These differences are shown in Settlement differences and modelled in sports baskets.', example: 'Total 44, final score 24–20 → push.' },
  dfs: { short: 'Pick\'em apps (PrizePicks, Underdog) — not sportsbook odds.', long: 'They pay fixed multipliers for combining several picks, so a single line has no clean probability. We show them separately and never use them in a consensus or arbitrage.', example: '"More than 249.5 passing yards" as one leg of a 3-pick entry.' },
  freshness: { short: 'How old the quotes are.', long: 'Sportsbook quotes get full weight up to 10 minutes old, then less, and are dropped after 60 minutes. The freshness filter hides comparisons older than you choose.', example: 'A 40-minute-old Pinnacle price counts at 40% weight.' },
  'linked markets': { short: 'Different contracts that logic ties together.', long: 'When one outcome forces another (A ⇒ B), buying YES on B and NO on A pays in every outcome: if A happens B pays, if A fails NO-A pays.', example: 'A team trailing 24–20 that wins makes the total at least 49, so "they win" forces "over 48.5".' },
  'tail state': { short: 'A rare outcome like a cancelled or postponed event.', long: 'Some venues settle cancellations at a "fair price" they choose, so a hedge could pay less than $1 there. Strict mode counts these at their worst case.', example: 'A game postponed by more than 48 hours.' },
};

export const HELP = {
  guaranteed: 'Only trades that make money in EVERY possible outcome, priced at real order-book asks, after fees and a safety buffer, with verified matching rules and fresh quotes.',
  near: 'Attractive trades where one thing is not guaranteed: the contracts may settle differently, a rare cancellation could break it, quotes are stale, or the venue hides order sizes.',
  research: 'Pricing inconsistencies that are interesting but NOT trades: you could lose money acting on these.',
  providers: 'Which venues are connected, how fresh their data is, and how many opportunities each pair of venues produced.',
  netProfit: 'Total profit at the largest size the order books allow, after fees and the safety buffer.',
  roi: GLOSSARY['net ROI'].short,
  size: GLOSSARY['executable size'].short,
  cost: 'What one basket costs: the sum of the ask prices of every leg.',
  payout: GLOSSARY['guaranteed payout'].short,
  confidence: 'How sure we are the trade works as shown: match quality × quote freshness × tail-risk.',
  verified: GLOSSARY['verified match'].short,
  near_toggle: 'Show trades that are close to arbitrage but not guaranteed.',
  minRoi: 'Hide trades whose net return is below this.',
  minProfit: 'Hide trades whose total net profit (at max size) is below this dollar amount.',
  minLiq: 'Hide trades where the thinnest leg has less liquidity than this.',
  strategy: 'Cross-platform = same contract on two venues. Binary = YES+NO hedges on one venue. Multi-outcome = baskets across a set of outcomes. Implication = nested contracts (A implies B).',
  linked: 'Two different contracts can be tied by logic. Example: if a team trailing 24–20 wins, the game total must reach at least 49 — so "they win" forces "over 48.5". Buying YES on the forced outcome plus NO on the cause pays at least $1 whatever happens. We only list links proven from the rules and the score or bracket — never "these usually move together".',
  linkedExec: 'Trades that pay in every outcome AND are ready to execute now: live verified game state, fresh quotes on both legs, order-book size checked, and every settlement case known.',
  linkedStruct: 'Baskets whose worst-case payout beats cost + fees + buffer at the current prices, but where something about execution is not confirmed (size, quotes, a postponement rule, or a manual/example state).',
  gameState: 'Live scores from Polymarket US. We only trust a score when the per-team period scores match the headline score, and we keep the provider\'s timestamp separate from when we received it.',
  minNetLinked: 'Hide baskets whose guaranteed (worst-case) net profit at the available size is below this.',
  crowd: 'Compares a prediction market\'s buy price (or one sportsbook\'s price) with what several other sportsbooks imply after removing their margin. Big gaps are worth researching — they are not guaranteed profit.',
  oddsFeed: 'Sportsbook prices come from The Odds API (free key, 500 credits/month). Without a key this tab stays empty — the app never shows invented odds.',
  sportsBasket: 'Bets across a sportsbook and another venue that would pay more than they cost in every result, using real cash payouts (incl. ties/pushes and cancellations). Execution is unverified — books don\'t publish limits — so these never appear as guaranteed arbitrage.',
  minDisagree: 'Show only outcomes you could buy at least this many percentage points below the estimated consensus, after fees. Set to 0 to also see prices that are higher than the consensus (normal for sportsbooks, which include a margin).',
  jurisdiction: 'Where you live decides which venues you may trade on. It only changes labels and an optional filter — research data stays visible for every venue.',
  beginner: 'Simple mode: plain words, fewer numbers, and "what do I click" first.',
};

function legLine(l) {
  const what = l.label && !/^(yes|no)$/i.test(l.label) ? `"${l.label}" (${l.eventTitle || l.question})` : `"${l.question}"`;
  return `BUY ${l.side.toUpperCase()} on ${what} at ${l.venue} — ${c(l.ask)} per share${l.askSize ? ` (${Math.floor(l.askSize).toLocaleString()} available at that price)` : l.noDepth ? ' (venue does not publish size)' : ''}`;
}

function contractLine(o, l, i) {
  const cond = o.conditions && o.conditions[i];
  const base = cond?.text ? `YES if it ${cond.text}` : `${l.question}${l.label && !l.question.includes(l.label) ? ` — ${l.label}` : ''}`;
  return { venue: l.venue, text: base, side: l.side, price: l.ask };
}

function whyText(o) {
  const cost = c(o.unit.cost, 2), pay = usd(o.unit.minPayoff);
  switch (o.kind) {
    case 'nested': return `These two contracts measure the same thing at different levels, so one is "inside" the other. We checked every range the value could land in: in each one, at least one of your legs pays $1. The basket costs ${cost} but always returns at least ${pay}.`;
    case 'equivalent': return `Both contracts pay on the same outcome. Buying YES on one and NO on the other means exactly one of them pays $1 — and together they cost only ${cost}.`;
    case 'partition': return `Your legs cover every way the event can end, so one of them always pays. Covering all outcomes costs ${cost}, less than the ${pay} you're guaranteed to collect.`;
    case 'all-no': return `At most one of these outcomes can happen, so at most one of your NO shares loses. The rest pay $1 each: at least ${pay} back for ${cost}.`;
    case 'all-yes': return `Exactly one of these outcomes will happen, so exactly one YES share pays $1. Buying all of them costs ${cost}.`;
    case 'complement': return `YES and NO on the same contract: one of them always pays $1, and right now both together cost ${cost}.`;
    default: return `${o.rationale} The basket costs ${cost} and pays at least ${pay}.`;
  }
}

/** Plain-English breakdown of one opportunity. */
export function explainOpportunity(o) {
  const scenarios = (o.states || []).map((s) => {
    const winners = s.legs.map((x, i) => (x[0] >= 1 ? `leg ${i + 1}` : x[1] > 0 && x[0] < 1 ? `leg ${i + 1} (partly / uncertain)` : null)).filter(Boolean);
    const net = s.lo - o.unit.cost - o.unit.fees - o.unit.buffer;
    return { label: s.label, tail: !!s.tail, pays: s.lo === s.hi ? usd(s.lo) : `at least ${usd(s.lo)}`, winners: winners.join(' + ') || 'nothing',
      result: net > 0 ? `+${c(net, 2)} profit per basket` : `${c(net, 2)} (loss) per basket`, ok: net > 0 };
  });
  const guaranteed = o.bucket === 'guaranteed';
  const reasons = (o.reasons || []).map((r) => r.text);
  const crossVenue = (o.venues || []).length > 1;
  const dates = [...new Set(o.legs.map((l) => (l.endDate || '').slice(0, 10)).filter(Boolean))].sort();
  const risks = [
    'Both (all) legs must fill at these prices. Place them quickly; if one fills and the other moves, the profit can disappear (slippage).',
    `Your money is locked until settlement${dates.length ? ` (${dates[dates.length - 1]})` : ''}. ROI is not annualised.`,
    crossVenue ? 'You need funded accounts on both venues, and each venue settles independently by its own rules.' : 'Everything settles on one venue, under one rule book.',
    ...(o.reasons || []).map((r) => r.text),
    ...(o.states || []).some((s) => s.boundary) ? ['If the result lands exactly on a threshold, wording like "above" vs "at least" matters — we already counted that case at its worst.'] : [],
  ];
  return {
    summary: `${o.legs.map((l) => `Buy ${l.side.toUpperCase()} at ${c(l.ask)}`).join(' + ')} ${crossVenue ? `across ${o.venues.join(' and ')}` : `on ${o.venues[0]}`}. Cost ${c(o.unit.cost, 2)}, guaranteed back ${usd(o.unit.minPayoff)}, net ${c(o.unit.net, 2)} per basket after fees.`,
    contracts: o.legs.map((l, i) => contractLine(o, l, i)),
    trades: o.legs.map(legLine),
    why: whyText(o),
    scenarios,
    guarantee: guaranteed
      ? `Profit is guaranteed: in every possible outcome the basket pays at least ${usd(o.unit.minPayoff)}, which beats the ${c(o.unit.cost, 2)} cost plus fees and our safety buffer — provided every leg fills at the quoted price.`
      : `Profit is possible but NOT guaranteed. ${reasons.join(' ')}`,
    risks,
    bucketWhy: guaranteed
      ? 'Guaranteed Arbitrage: the minimum payoff across every valid outcome beats cost + fees + buffer, the contracts are a verified match, and the quotes are fresh.'
      : `Near-arb: ${reasons.join(' ') || 'not every check passed.'}`,
    venueNotes: o.venues.map((v) => `${v}: ${VENUE_NOTE[v] || 'prediction market'}`),
  };
}

export { pct as fmtPct, c as fmtCents, usd as fmtUsd };
