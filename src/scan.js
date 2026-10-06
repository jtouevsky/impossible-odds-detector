// One full scan: providers -> MarketSpecs -> (a) arbitrage engine, (b) research/anomaly pipeline.
import { getProvider, mergeSnapshots, PLANNED } from './providers/index.js';
import { buildSpec, contractText } from './spec/marketSpec.js';
import { templatize } from './engine/text.js';
import { blockByEvent, equivalentPairs, STATUS } from './spec/match.js';
import { runPipeline } from './engine/pipeline.js';
import { runArbEngine, ladderKey } from './arb/engine.js';
import { strikeConsistent } from './providers/kalshi.js';

export function buildSpecs(snapshot) {
  const byId = new Map(snapshot.markets.map((m) => [m.id, m]));
  const specs = [];
  for (const ev of snapshot.events) {
    const sib = ev.marketIds.map((id) => byId.get(id)).filter(Boolean);
    for (const m of sib) {
      m.inExclusiveEvent = !!ev.exclusive;
      try { m.spec = buildSpec(m, ev, sib); specs.push(m.spec); } catch { /* unparseable: no spec, never matched */ }
    }
  }
  return specs;
}

/** Real order books for the positions of the surviving candidates. */
export function makeIO(fetchImpl = globalThis.fetch) {
  return {
    async fetchLadders(positions) {
      const out = new Map();
      const pm = positions.filter((p) => p.market.provider === 'polymarket');
      const kx = positions.filter((p) => p.market.provider === 'kalshi');
      const tokenOf = (p) => (p.side === 'yes' ? p.market.tokenId : p.market.noTokenId);
      const pi = positions.filter((p) => p.market.provider === 'predictit');
      const lm = positions.filter((p) => p.market.provider === 'limitless');
      const us = positions.filter((p) => p.market.provider === 'polymarket-us');
      const [pmBooks, kxBooks, piBooks, lmBooks, usBooks] = await Promise.all([
        pm.length ? getProvider('polymarket').fetchBooks([...new Set(pm.map(tokenOf).filter(Boolean))], { fetch: fetchImpl }).catch(() => ({})) : {},
        kx.length ? getProvider('kalshi').fetchBooks(kx.map((p) => p.market.id), { fetch: fetchImpl }).catch(() => ({})) : {},
        pi.length ? getProvider('predictit').fetchBooks(pi.map((p) => p.market.id), { fetch: fetchImpl }).catch(() => ({})) : {},
        lm.length ? getProvider('limitless').fetchBooks(lm.map((p) => p.market), { fetch: fetchImpl }).catch(() => ({})) : {},
        us.length ? getProvider('polymarket-us').fetchBooks([...new Set(us.map((p) => p.market.slug))], { fetch: fetchImpl }).catch(() => ({})) : {},
      ]);
      for (const p of us) { const b = usBooks[p.market.slug]; if (b) out.set(ladderKey(p), { ...b[p.side], timestamp: b.timestamp }); }
      for (const p of pm) { const b = pmBooks[tokenOf(p)]; if (b) out.set(ladderKey(p), b); }
      for (const [list, books] of [[kx, kxBooks], [pi, piBooks], [lm, lmBooks]])
        for (const p of list) { const b = books[p.market.id]; if (b) out.set(ladderKey(p), { ...b[p.side], timestamp: b.timestamp }); }
      return out;
    },
    async feeMultipliers(markets) {
      const kx = getProvider('kalshi');
      const series = [...new Set(markets.filter((m) => m.provider === 'kalshi').map((m) => m.series))];
      const mult = new Map();
      await Promise.all(series.map(async (s) => mult.set(s, await kx.feeMultiplier(s, { fetch: fetchImpl }))));
      for (const m of markets) if (m.provider === 'kalshi') m.feeMultiplier = mult.get(m.series) ?? 1;
    },
  };
}

/** Exact implications from Kalshi's structured strikes inside one event (same underlying, same rules, different strike). */
export function kalshiStrikeImplications(snapshot) {
  const byId = new Map(snapshot.markets.map((m) => [m.id, m]));
  const out = [];
  for (const ev of snapshot.events) {
    if (ev.provider !== 'kalshi') continue;
    const all = ev.marketIds.map((id) => byId.get(id)).filter((m) => m && strikeConsistent(m));
    // markets must differ ONLY in the strike: same contract text once numbers are templated out
    const bySubject = new Map();
    for (const m of all) {
      const k = templatize(contractText(m)).template;
      let a = bySubject.get(k);
      if (!a) bySubject.set(k, (a = []));
      a.push(m);
    }
    for (const ms of bySubject.values()) {
      if (ms.length < 2) continue;
      const gt = ms.filter((m) => (m.strikeType === 'greater' || m.strikeType === 'greater_or_equal') && m.floor != null).sort((a, b) => a.floor - b.floor);
      const lt = ms.filter((m) => (m.strikeType === 'less' || m.strikeType === 'less_or_equal') && m.cap != null).sort((a, b) => a.cap - b.cap);
      const push = (hard, easy, why) => out.push({ type: 'implication', a: hard.id, b: easy.id, detector: 'kalshi-strike', confidence: 0.99, rationale: why });
      for (let i = 0; i < gt.length; i++)
        for (let j = i + 1; j <= Math.min(gt.length - 1, i + 3); j++)
          if (gt[j].floor > gt[i].floor && gt[j].strikeType === gt[i].strikeType)
            push(gt[j], gt[i], `Same Kalshi contract, higher strike (${gt[j].floor} vs ${gt[i].floor}): finishing above the higher strike means finishing above the lower one.`);
      for (let i = 0; i < lt.length; i++)
        for (let j = i + 1; j <= Math.min(lt.length - 1, i + 3); j++)
          if (lt[j].cap > lt[i].cap && lt[j].strikeType === lt[i].strikeType)
            push(lt[i], lt[j], `Same Kalshi contract, lower cap (${lt[i].cap} vs ${lt[j].cap}): finishing below the lower cap means finishing below the higher one.`);
    }
  }
  return out;
}

export const DEFAULT_PROVIDERS = ['polymarket', 'polymarket-us', 'kalshi', 'predictit', 'limitless', 'manifold'];

export async function fullScan({ providers = DEFAULT_PROVIDERS, maxEvents = {}, onProgress, arbConfig = {}, fetch: fetchImpl = globalThis.fetch } = {}) {
  const t0 = Date.now();
  const prog = {};
  const snaps = await Promise.all(providers.map(async (id) => {
    const t1 = Date.now();
    try {
      const sn = await getProvider(id).fetchSnapshot({ maxEvents: maxEvents[id], fetch: fetchImpl,
        onProgress: (p) => { prog[id] = p; onProgress && onProgress({ phase: 'fetching', providers: { ...prog } }); } });
      // research-only venues (play money) never enter the trading snapshot
      if (getProvider(id).capabilities?.arb === false) return { ...sn, events: [], markets: [], syncMs: Date.now() - t1 };
      return { ...sn, syncMs: Date.now() - t1 };
    } catch (err) {
      return { provider: id, fetchedAt: new Date().toISOString(), partial: true, warnings: [`${id}: ${err.message}`], events: [], markets: [], failed: true, error: err.message, syncMs: Date.now() - t1 };
    }
  }));
  if (snaps.every((s) => s.failed)) throw new Error(snaps.flatMap((s) => s.warnings).join('; '));
  const snapshot = mergeSnapshots(snaps);
  onProgress && onProgress({ phase: 'analyzing', markets: snapshot.markets.length });

  const specs = buildSpecs(snapshot);
  const groups = blockByEvent(specs);
  const pairs = equivalentPairs(groups);
  const research = await runPipeline(snapshot, { specPairs: pairs });
  const byIdAll = new Map(snapshot.markets.map((m) => [m.id, m]));
  const implications = [
    // same-event ladders only: cross-event "same wording" pairs are exactly the kind of false match we must avoid
    ...research.relationships.filter((r) => r.type === 'implication' && r.detector === 'ladder' && byIdAll.get(r.a)?.eventId === byIdAll.get(r.b)?.eventId),
    ...research.relationships.filter((r) => r.type === 'implication' && r.subtype === 'stage' && byIdAll.get(r.a)?.provider === byIdAll.get(r.b)?.provider),
    ...kalshiStrikeImplications(snapshot),
  ];

  const byId = new Map(snapshot.markets.map((m) => [m.id, m]));
  onProgress && onProgress({ phase: 'order books' });
  const arb = await runArbEngine({ byId, events: snapshot.events, groups, pairs, implications }, makeIO(fetchImpl), arbConfig);

  const count = (f) => pairs.filter(f).length;
  return {
    snapshot, research, arb, ms: Date.now() - t0,
    perVenue: Object.fromEntries(snaps.map((s) => [s.provider, {
      name: getProvider(s.provider).name, ...getProvider(s.provider).capabilities,
      markets: s.referenceCount ?? s.markets.length, events: s.events.length, failed: !!s.failed, error: s.error || null,
      listed: s.listed ?? null, quoted: s.markets.filter((m) => m.bid != null || m.ask != null).length,
      state: providerState(getProvider(s.provider).capabilities, s),
      lastSuccess: s.failed ? null : s.fetchedAt,
      syncedAt: s.fetchedAt, syncMs: s.syncMs, warnings: s.warnings || [],
      opportunities: arb.opportunities.filter((o) => o.providers.includes(s.provider)).length,
      guaranteed: arb.opportunities.filter((o) => o.bucket === 'guaranteed' && o.providers.includes(s.provider)).length,
      matchedPairs: pairs.filter((p) => p.a.provider === s.provider || p.b.provider === s.provider).filter((p) => p.a.provider !== p.b.provider).length,
    }])),
    planned: PLANNED,
    pairMatrix: pairMatrix(pairs, arb),
    matching: {
      specs: specs.length, blocks: groups.size, pairs: pairs.length,
      verified: count((p) => p.status === STATUS.VERIFIED), likely: count((p) => p.status === STATUS.LIKELY), mismatch: count((p) => p.status === STATUS.MISMATCH),
      crossVenue: count((p) => p.a.provider !== p.b.provider),
      crossVerified: count((p) => p.a.provider !== p.b.provider && p.status === STATUS.VERIFIED),
    },
  };
}

/**
 * Honest connection state. LIVE only when this sync returned usable current quotes.
 *   live | partial (data but no tradable quotes, or play-money/reference only) | unavailable (fetch failed) | needs-setup
 */
export function providerState(cap = {}, s = {}) {
  if (s.needsSetup) return 'needs-setup';
  if (s.failed) return 'unavailable';
  const quoted = (s.markets || []).filter((m) => m.bid != null || m.ask != null).length;
  if (cap.realMoney === false || cap.arb === false) return (s.referenceCount ?? s.markets?.length ?? 0) > 0 ? 'partial' : 'unavailable';
  if (quoted > 0) return 'live';
  return (s.markets || []).length ? 'partial' : 'unavailable';
}

/** Per venue pair: candidate matches by status + opportunities by bucket. */
export function pairMatrix(pairs, arb) {
  const rows = {};
  const row = (k) => (rows[k] ||= { pair: k, verified: 0, likely: 0, mismatch: 0, structures: 0, guaranteed: 0, near: 0 });
  for (const p of pairs) {
    const k = p.a.provider === p.b.provider ? `${p.a.provider} only` : [p.a.provider, p.b.provider].sort().join('↔');
    row(k)[p.status.toLowerCase()]++;
  }
  for (const [k, n] of Object.entries(arb.stats.structuresByPair || {})) row(k).structures += n;
  for (const o of arb.opportunities) row(o.venuePair)[o.bucket]++;
  return Object.values(rows).sort((a, b) => (b.pair.includes('↔') - a.pair.includes('↔')) || (b.verified + b.likely - a.verified - a.likely));
}
