// Local quote/signal history for a future backtester. Same storage approach as the scan cache: files in .cache/.
//   .cache/history/quotes-YYYY-MM-DD.ndjson    one line per changed quote
//   .cache/history/signals-YYYY-MM-DD.ndjson   one line per new/changed signal (arb, near-arb, disagreement)
// Dedup: a quote is written only when its price changed or HISTORY_HEARTBEAT_MIN passed since the last write
// of the same (source, contract, side). Retention: files older than HISTORY_DAYS are deleted.
import fs from 'node:fs';
import path from 'node:path';

export class History {
  constructor(dir, { days = +(process.env.HISTORY_DAYS || 30), heartbeatMin = +(process.env.HISTORY_HEARTBEAT_MIN || 60), enabled = process.env.HISTORY !== '0' } = {}) {
    this.dir = dir; this.days = days; this.heartbeatMs = heartbeatMin * 60e3; this.enabled = enabled;
    this.last = new Map();
    if (enabled) { fs.mkdirSync(dir, { recursive: true }); this.seed(); this.prune(); }
  }

  file(kind, t = Date.now()) { return path.join(this.dir, `${kind}-${new Date(t).toISOString().slice(0, 10)}.ndjson`); }

  /** Rebuild the dedup index from today's and yesterday's files so restarts don't re-write everything. */
  seed() {
    for (const kind of ['quotes', 'signals'])
      for (const t of [Date.now() - 864e5, Date.now()]) {
        let txt = '';
        try { txt = fs.readFileSync(this.file(kind, t), 'utf8'); } catch { continue; }
        for (const line of txt.split('\n')) { if (!line) continue; try { const r = JSON.parse(line); this.last.set(`${kind}|${r.k}`, { sig: r.sig, t: Date.parse(r.t) }); } catch { /* skip */ } }
      }
  }

  prune(now = Date.now()) {
    const cutoff = new Date(now - this.days * 864e5).toISOString().slice(0, 10);
    for (const f of fs.readdirSync(this.dir)) {
      const d = (f.match(/-(\d{4}-\d{2}-\d{2})\.ndjson$/) || [])[1];
      if (d && d < cutoff) try { fs.unlinkSync(path.join(this.dir, f)); } catch { /* ignore */ }
    }
  }

  /** records: [{ k (normalized id), sig (value fingerprint), ...data }]. Returns # written. */
  write(kind, records, now = Date.now()) {
    if (!this.enabled || !records.length) return 0;
    const lines = [];
    for (const r of records) {
      const key = `${kind}|${r.k}`, prev = this.last.get(key);
      if (prev && prev.sig === r.sig && now - prev.t < this.heartbeatMs) continue;
      this.last.set(key, { sig: r.sig, t: now });
      lines.push(JSON.stringify({ t: new Date(now).toISOString(), ...r }));
    }
    if (lines.length) fs.appendFileSync(this.file(kind, now), lines.join('\n') + '\n');
    return lines.length;
  }

  stats() {
    if (!this.enabled) return { enabled: false };
    const files = fs.readdirSync(this.dir).filter((f) => f.endsWith('.ndjson'));
    const bytes = files.reduce((s, f) => s + fs.statSync(path.join(this.dir, f)).size, 0);
    return { enabled: true, files: files.length, bytes, days: this.days, heartbeatMin: this.heartbeatMs / 60e3 };
  }
}

/** Quote records from prediction-market arb legs, sports quotes and comparisons. */
export function historyRecords({ arb, sportsQuotes = [], comparisons = [], baskets = [] }) {
  const quotes = [], signals = [];
  for (const o of arb?.opportunities || []) {
    for (const l of o.legs) quotes.push({ k: `${l.provider}|${l.marketId}|${l.side}`, sig: `${l.ask}`, src: l.provider, contract: l.marketId, side: l.side, ask: l.ask, askSize: l.askSize ?? null, quoteTime: l.quoteTime || null, ruleVersion: hashRules(l.rules) });
    signals.push({ k: `arb|${o.id}`, sig: `${o.bucket}|${o.unit.net.toFixed(4)}|${o.maxQty}`, type: o.bucket === 'guaranteed' ? 'guaranteed-arb' : 'near-arb', id: o.id, net: o.unit.net, maxQty: o.maxQty, roi: o.roi, match: o.matchStatus, legs: o.legs.map((l) => `${l.provider}|${l.marketId}|${l.side}@${l.ask}`) });
  }
  for (const q of sportsQuotes) {
    if (q.fixture) continue; // test fixtures never enter history
    const px = q.price.kind === 'exchange' ? q.price.ask : q.price.decimal;
    quotes.push({ k: `${q.source}|${q.venue}|${q.eventKey}|${q.market.type}|${q.market.period}|${q.market.player || ''}|${q.market.line ?? ''}|${q.market.side}`, sig: `${px}`,
      src: q.source, venue: q.venue, contract: `${q.eventKey}|${q.market.type}|${q.market.period}|${q.market.statistic}|${q.market.player || ''}|${q.market.line ?? ''}`, side: q.market.side,
      price: q.price, quoteTime: q.timestamp, ruleVersion: q.rules?.version || null });
  }
  for (const r of comparisons) signals.push({ k: `crowd|${r.id}`, sig: r.edgeAfterFeesPts.toFixed(1), type: 'disagreement', id: r.id, venue: r.target.venue, buy: r.target.buyPrice, consensus: r.consensus.probability, pts: r.disagreementPts, match: r.match.status, books: r.consensus.books.length });
  for (const b of baskets) signals.push({ k: `basket|${b.id}`, sig: b.net.toFixed(4), type: 'sports-basket', id: b.id, net: b.net, structural: b.structural, execution: b.execution });
  return { quotes, signals };
}
const hashRules = (t) => { if (!t) return null; let h = 2166136261 >>> 0; for (let i = 0; i < t.length; i++) { h ^= t.charCodeAt(i); h = Math.imul(h, 16777619); } return (h >>> 0).toString(36); };
