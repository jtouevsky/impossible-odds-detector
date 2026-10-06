// Impossible Odds Detector — zero-dependency local server.
//   node server.js            -> http://localhost:4173
// Env: PORT, PROVIDERS (default polymarket,polymarket-us,kalshi,predictit,limitless,manifold), ODDS_API_KEY, MAX_EVENTS (Polymarket events, default 4000),
//      KALSHI_MAX_EVENTS (default 20000), CACHE_MINUTES (default 5), BUFFER_CENTS (safety/slippage buffer per
//      $1 basket, default 0.5), INCLUDE_TAIL_STATES (1 = strict: cancellation states count, default 1), NO_OPEN=1
//
// The server fetches market data from the providers, caches it (memory + .cache/ on disk), runs the
// detection engine and hands the browser a compact result. The engine itself is plain ES modules
// with no Node dependencies, so it can also run in the browser.
import { setEnvVar, fromFile as ENV_FROM_FILE } from './src/env.js'; // must stay first: loads .env
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { fileURLToPath } from 'node:url';
import { exec } from 'node:child_process';
import { getProvider } from './src/providers/index.js';
import { fullScan } from './src/scan.js';
import { chat, engineStatus } from './src/chat.js';
import { providers as PROVIDER_REGISTRY, JURISDICTIONS, ELIGIBILITY } from './src/providers/index.js';
import { OddsFeed, CONFIG as ODDS_CONFIG, BOOKS } from './src/sports/theOddsApi.js';
import { predictionQuotes, buildComparisons, sportsBaskets } from './src/sports/compare.js';
import { History, historyRecords } from './src/history.js';

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const PORT = +(process.env.PORT || 4173);
const MAX_EVENTS = +(process.env.MAX_EVENTS || 4000);
const KALSHI_MAX_EVENTS = +(process.env.KALSHI_MAX_EVENTS || 20000);
const CACHE_MS = +(process.env.CACHE_MINUTES || 5) * 60e3;
const ARB_CONFIG = {
  bufferPerShare: +(process.env.BUFFER_CENTS ?? 0.5) / 100,
  includeTailStates: (process.env.INCLUDE_TAIL_STATES ?? '1') !== '0',
};
const ENV_PROVIDERS = (process.env.PROVIDERS || 'polymarket,polymarket-us,kalshi,predictit,limitless,manifold').split(',').map((s) => s.trim()).filter(Boolean);
const CACHE_DIR = path.join(ROOT, '.cache');
const CACHE_FILE = path.join(CACHE_DIR, 'scan.json');
const SETTINGS_FILE = path.join(CACHE_DIR, 'settings.json');
const ODDS_FILE = path.join(CACHE_DIR, 'odds.json');

// ---------- local settings (never leave this machine) ----------
const readJSONFile = (f, d) => { try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch { return d; } };
const settings = { jurisdiction: null, oddsApiKey: null, disabledProviders: [], ...readJSONFile(SETTINGS_FILE, {}) };
const saveSettings = () => { delete settings.oddsApiKey; fs.mkdirSync(CACHE_DIR, { recursive: true }); fs.writeFileSync(SETTINGS_FILE, JSON.stringify(settings, null, 2), { mode: 0o600 }); };
const activeProviders = () => ENV_PROVIDERS.filter((p) => !settings.disabledProviders.includes(p));
const oddsKey = () => process.env.ODDS_API_KEY || null;
const oddsCache = { data: readJSONFile(ODDS_FILE, null), save() { fs.mkdirSync(CACHE_DIR, { recursive: true }); fs.writeFile(ODDS_FILE, JSON.stringify(this.data), () => {}); } };
const odds = new OddsFeed({ getKey: oddsKey, cache: oddsCache });
const history = new History(path.join(CACHE_DIR, 'history'));
let lastPredictionQuotes = [];

const state = {
  result: null,          // last compact scan result
  fetching: null,        // in-flight promise
  progress: null,
  lastError: null,
};

// ---------- scan ----------
const slimMarket = (m) => ({
  id: m.id, provider: m.provider, eventId: m.eventId, question: m.question, label: m.label,
  yesOutcome: m.yesOutcome, isYesNo: m.isYesNo, price: m.price, bid: m.bid, ask: m.ask,
  liquidity: Math.round(m.liquidity), volume: Math.round(m.volume), volume24h: Math.round(m.volume24h),
  endDate: m.endDate, url: m.url, eventTitle: m.eventTitle, category: m.category, tokenId: m.tokenId,
});

// Arbitrage legs carry their fee model + book token so the browser can re-check live prices itself.
function compactArb(scan) {
  const opportunities = scan.arb.opportunities.map((o) => ({
    ...o,
    legs: o.legs.map((l) => {
      const m = scan.snapshot.markets.find((x) => x.id === l.marketId) || {};
      return { ...l, bookToken: m.provider === 'polymarket' ? (l.side === 'yes' ? m.tokenId : m.noTokenId) : m.provider === 'limitless' || m.provider === 'polymarket-us' ? m.slug : m.id,
        fee: l.fee, feeModel: { provider: m.provider, feesEnabled: m.feesEnabled, feeRate: m.feeRate, feeExponent: m.feeExponent, feeMultiplier: m.feeMultiplier } };
    }),
  }));
  return { opportunities, stats: { ...scan.arb.stats, config: undefined }, config: scan.arb.stats.config, matching: scan.matching, perVenue: scan.perVenue, planned: scan.planned, pairMatrix: scan.pairMatrix };
}

function compact(snapshot, res) {
  const violations = res.violations.map((v) => ({
    id: v.id, type: v.type, subtype: v.subtype, detector: v.detector, rationale: v.rationale, trade: v.trade,
    relConfidence: v.relConfidence, confidence: v.confidence, score: v.score, factors: v.factors,
    magnitude: v.magnitude, edge: v.edge, executable: v.executable, roi: v.roi, cost: v.cost, sum: v.sum, direction: v.direction,
    maxSpread: v.maxSpread, minLiquidity: v.minLiquidity, totalVolume: v.totalVolume, volume24h: v.volume24h,
    stale: v.stale, category: v.category, ladderPeers: v.ladderPeers || 0,
    a: v.a ? v.a.id : null, b: v.b ? v.b.id : null,
    legs: v.legs.map((m) => m.id),
    event: v.event ? { id: v.event.id, title: v.event.title, url: v.event.url, augmented: v.event.augmented } : null,
  }));
  const markets = {};
  for (const v of res.violations) for (const m of v.legs) markets[m.id] = slimMarket(m);
  const { largest, ...stats } = res.stats;
  return {
    provider: snapshot.provider, fetchedAt: snapshot.fetchedAt, scannedAt: new Date().toISOString(),
    partial: !!snapshot.partial, warnings: snapshot.warnings || [],
    stats: { ...stats, largestId: largest ? largest.id : null },
    violations, markets,
  };
}

// ---------- sports: feed status + comparisons (re-runnable without a full market rescan) ----------
async function sportsSection({ force = false } = {}) {
  const feed = await odds.sync({ force }).catch((e) => ({ state: 'unavailable', reason: e.message }));
  const bookQuotes = odds.quotes();
  const quotes = [...lastPredictionQuotes, ...bookQuotes];
  const { rows, skipped } = buildComparisons(quotes);
  const baskets = sportsBaskets(quotes);
  const cfg = ODDS_CONFIG();
  return {
    feed: { id: 'the-odds-api', name: 'The Odds API', ...feed, config: { sports: cfg.sports, markets: cfg.markets, bookmakers: cfg.bookmakers.map((b) => BOOKS[b] || b), refreshMin: cfg.refreshMin, props: cfg.props } },
    comparisons: rows.slice(0, 400), baskets: baskets.slice(0, 100), skippedSingleSide: skipped.length,
    counts: { bookQuotes: bookQuotes.filter((q) => q.venueKind === 'sportsbook').length, dfsQuotes: bookQuotes.filter((q) => q.venueKind === 'dfs').length,
      predictionQuotes: lastPredictionQuotes.length, games: new Set(quotes.map((q) => q.eventKey)).size },
    dfs: bookQuotes.filter((q) => q.venueKind === 'dfs').slice(0, 200).map((q) => ({ venue: q.venueName, event: q.event, player: q.market.player, statistic: q.market.statistic, line: q.market.line, side: q.market.side, timestamp: q.timestamp })),
    computedAt: new Date().toISOString(),
  };
}

async function scan() {
  if (state.fetching) return state.fetching;
  state.fetching = (async () => {
    const t0 = Date.now();
    state.progress = { phase: 'fetching', events: 0, markets: 0, target: MAX_EVENTS };
    try {
      const r = await fullScan({
        providers: activeProviders(), maxEvents: { polymarket: MAX_EVENTS, kalshi: KALSHI_MAX_EVENTS }, arbConfig: ARB_CONFIG,
        onProgress: (p) => {
          if (p.phase !== 'fetching') { state.progress = { phase: p.phase === 'order books' ? 'order books' : 'analyzing', markets: p.markets }; return; }
          const vs = Object.values(p.providers || {});
          state.progress = { phase: 'fetching', providers: p.providers, events: vs.reduce((s, x) => s + (x.events || 0), 0),
            markets: vs.reduce((s, x) => s + (x.markets || 0), 0), target: MAX_EVENTS + 14000 };
        },
      });
      const out = compact(r.snapshot, r.research);
      out.arb = compactArb(r);
      out.provider = activeProviders().join('+');
      lastPredictionQuotes = predictionQuotes(r.snapshot.markets, { syncedAt: Object.fromEntries(Object.entries(r.perVenue).map(([k, v]) => [k, v.syncedAt])) });
      out.sports = await sportsSection();
      try {
        const h = historyRecords({ arb: out.arb, sportsQuotes: [...lastPredictionQuotes, ...odds.quotes()], comparisons: out.sports.comparisons, baskets: out.sports.baskets });
        out.history = { quotesWritten: history.write('quotes', h.quotes), signalsWritten: history.write('signals', h.signals), ...history.stats() };
      } catch (e) { out.history = { error: e.message }; }
      out.stats.fetchMs = Date.now() - t0;
      state.result = out;
      state.lastError = null;
      fs.mkdirSync(CACHE_DIR, { recursive: true });
      fs.writeFile(CACHE_FILE, JSON.stringify(out), () => {});
      console.log(`[scan] ${out.stats.markets} markets, ${out.arb.matching.crossVerified} verified cross-venue matches, ${out.arb.opportunities.filter((o) => o.isExecutable).length} executable arbitrage, ${out.stats.violations} anomalies in ${((Date.now() - t0) / 1000).toFixed(1)}s`);
      return out;
    } catch (err) {
      state.lastError = err.message || String(err);
      console.error('[scan] failed:', state.lastError);
      throw err;
    } finally {
      state.fetching = null;
      state.progress = null;
    }
  })();
  return state.fetching;
}

function loadDiskCache() {
  try {
    const r = JSON.parse(fs.readFileSync(CACHE_FILE, 'utf8'));
    if (r && r.violations && r.stats && r.arb) state.result = r;
  } catch { /* no cache yet */ }
}

const isFresh = () => state.result && Date.now() - Date.parse(state.result.scannedAt) < CACHE_MS;

// ---------- http ----------
const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.json': 'application/json', '.svg': 'image/svg+xml', '.ico': 'image/x-icon', '.png': 'image/png' };

function send(req, res, status, body, type = 'application/json') {
  let buf = Buffer.isBuffer(body) ? body : Buffer.from(typeof body === 'string' ? body : JSON.stringify(body));
  const headers = { 'content-type': type, 'cache-control': 'no-store' };
  if (buf.length > 1024 && /\bgzip\b/.test(req.headers['accept-encoding'] || '')) {
    buf = zlib.gzipSync(buf);
    headers['content-encoding'] = 'gzip';
  }
  res.writeHead(status, headers);
  res.end(buf);
}

const bookCache = new Map();

function publicSettings() {
  const k = oddsKey();
  return {
    jurisdiction: settings.jurisdiction, jurisdictions: JURISDICTIONS, eligibility: ELIGIBILITY,
    providers: ENV_PROVIDERS.map((id) => ({ id, name: PROVIDER_REGISTRY[id]?.name || id, enabled: !settings.disabledProviders.includes(id) })),
    odds: { keySet: !!k, keyFrom: !k ? null : ENV_FROM_FILE.has('ODDS_API_KEY') ? 'dotenv' : 'env', keyHint: k ? `…${k.slice(-4)}` : null },
  };
}

function readJSON(req, limit) {
  return new Promise((resolve, reject) => {
    let n = 0; const chunks = [];
    req.on('data', (d) => { n += d.length; if (n > limit) { reject(new Error('request too large')); req.destroy(); } else chunks.push(d); });
    req.on('end', () => { try { resolve(JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}')); } catch { reject(new Error('bad JSON')); } });
    req.on('error', reject);
  });
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
  const p = url.pathname;
  try {
    if (p === '/api/scan') {
      const force = url.searchParams.get('refresh') === '1';
      if (!force && isFresh()) return send(req, res, 200, { ...state.result, cached: true });
      try {
        const out = await scan();
        return send(req, res, 200, { ...out, cached: false });
      } catch (err) {
        if (state.result) return send(req, res, 200, { ...state.result, cached: true, stale: true, error: err.message });
        return send(req, res, 502, { error: err.message || 'Scan failed' });
      }
    }
    if (p === '/api/status') {
      return send(req, res, 200, {
        busy: !!state.fetching, progress: state.progress, lastError: state.lastError,
        cachedAt: state.result ? state.result.scannedAt : null, fresh: !!isFresh(), maxEvents: MAX_EVENTS,
      });
    }
    if (p === '/api/book') {
      const token = url.searchParams.get('token');
      const provider = url.searchParams.get('provider') || 'polymarket';
      if (!token || !/^[0-9a-zA-Z_-]{1,100}$/.test(token)) return send(req, res, 400, { error: 'bad token' });
      const ck = token + '|' + (url.searchParams.get('side') || 'yes');
      const hit = bookCache.get(ck);
      if (hit && Date.now() - hit.t < 5000) return send(req, res, 200, hit.v);
      const prov = getProvider(provider);
      if (!prov.fetchBook) return send(req, res, 501, { error: 'provider has no order books' });
      const side = url.searchParams.get('side') === 'no' ? 'no' : 'yes';
      const v = await prov.fetchBook(token, { side });
      bookCache.set(ck, { t: Date.now(), v });
      return send(req, res, 200, v);
    }
    if (p === '/api/settings' && req.method === 'GET') return send(req, res, 200, publicSettings());
    if (p === '/api/settings' && req.method === 'POST') {
      const b = await readJSON(req, 20000);
      let rescan = false;
      if ('jurisdiction' in b) settings.jurisdiction = JURISDICTIONS[b.jurisdiction] ? b.jurisdiction : null;
      if ('oddsApiKey' in b) {
        const k = String(b.oddsApiKey || '').trim();
        if (k && !/^[A-Za-z0-9_-]{16,64}$/.test(k)) return send(req, res, 400, { error: 'That does not look like an API key.' });
        if (process.env.ODDS_API_KEY && !ENV_FROM_FILE.has('ODDS_API_KEY')) return send(req, res, 409, { error: 'ODDS_API_KEY is set in your shell; change it there.' });
        setEnvVar('ODDS_API_KEY', k); oddsCache.data = null; oddsCache.save();
      }
      if (Array.isArray(b.disabledProviders)) { settings.disabledProviders = b.disabledProviders.filter((x) => PROVIDER_REGISTRY[x]); rescan = true; }
      saveSettings();
      if ('oddsApiKey' in b && state.result) { state.result.sports = await sportsSection({ force: true }); }
      if (rescan && state.result) state.result.scannedAt = new Date(0).toISOString(); // next /api/scan refetches
      return send(req, res, 200, { ...publicSettings(), sports: state.result?.sports || null, rescan });
    }
    if (p === '/api/sports' && req.method === 'POST') {
      if (!state.result) return send(req, res, 409, { error: 'Run a market scan first.' });
      state.result.sports = await sportsSection({ force: url.searchParams.get('force') === '1' });
      return send(req, res, 200, state.result.sports);
    }
    if (p === '/api/chat/status') return send(req, res, 200, await engineStatus(url.searchParams.get('refresh') === '1'));
    if (p === '/api/chat' && req.method === 'POST') {
      const body = await readJSON(req, 1_500_000);
      const messages = (Array.isArray(body.messages) ? body.messages : []).filter((m) => m && (m.role === 'user' || m.role === 'assistant') && typeof m.content === 'string').slice(-12);
      if (!messages.length || messages.at(-1).role !== 'user') return send(req, res, 400, { error: 'no question' });
      return send(req, res, 200, await chat(messages, body.context || {}, { engine: body.engine }));
    }
    if (p.startsWith('/api/market/')) {
      const id = decodeURIComponent(p.slice('/api/market/'.length));
      if (!/^[0-9a-zA-Z_-]{1,64}$/.test(id)) return send(req, res, 400, { error: 'bad id' });
      const prov = getProvider(url.searchParams.get('provider') || 'polymarket');
      return send(req, res, 200, await prov.fetchMarketDetails(id));
    }

    // static: /  -> public/index.html ; /src/* served for the browser-side engine modules
    let file = p === '/' ? '/public/index.html' : p.startsWith('/src/') ? p : '/public' + p;
    file = path.normalize(path.join(ROOT, file));
    if (!file.startsWith(ROOT + path.sep) || file.includes(`${path.sep}.cache`)) return send(req, res, 403, 'forbidden', 'text/plain');
    fs.readFile(file, (err, data) => {
      if (err) return send(req, res, 404, 'not found', 'text/plain');
      send(req, res, 200, data, MIME[path.extname(file)] || 'application/octet-stream');
    });
  } catch (err) {
    send(req, res, 500, { error: err.message || 'server error' });
  }
});

loadDiskCache();
server.listen(PORT, () => {
  const link = `http://localhost:${PORT}`;
  console.log(`\n  Impossible Odds Detector running at ${link}\n`);
  if (!process.env.NO_OPEN) {
    const cmd = process.platform === 'darwin' ? 'open' : process.platform === 'win32' ? 'start ""' : 'xdg-open';
    exec(`${cmd} ${link}`, () => {});
  }
  if (!isFresh()) scan().catch(() => {}); // warm the cache in the background
});
server.on('error', (err) => {
  if (err.code === 'EADDRINUSE') console.error(`Port ${PORT} is busy. Try: PORT=4174 node server.js`);
  else console.error(err);
  process.exit(1);
});
