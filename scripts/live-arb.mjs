// Usage: node scripts/live-arb.mjs — full live scan (all providers), prints diagnostics and opportunities.
import { fullScan } from '../src/scan.js';
const r = await fullScan({ onProgress: () => {}, maxEvents: { polymarket: +(process.env.PM_EVENTS || 4000) } });
for (const [k, v] of Object.entries(r.perVenue)) console.log(k.padEnd(10), v.status, v.failed ? 'FAILED ' + v.error : '', 'markets', v.markets, 'opps', v.opportunities, 'guaranteed', v.guaranteed, 'xmatches', v.matchedPairs, `${v.syncMs}ms`);
console.table(r.pairMatrix);
console.log('matching', r.matching, 'rejected', r.arb.stats.rejected, 'ms', r.ms);
const pct = (x) => (x * 100).toFixed(2);
for (const o of r.arb.opportunities.slice(0, +(process.env.TOP || 25)))
  console.log(`${o.bucket.padEnd(10)} ${o.matchStatus} ${o.strategy} ${o.venuePair} net/unit=${pct(o.unit.net)}¢ qty=${o.maxQty} net$=${(o.netProfit || 0).toFixed(2)} | ${o.legs.map((l) => `${l.venue} ${l.side.toUpperCase()} ${(l.label || l.question).slice(0, 40)} @${l.ask}`).join(' + ')} ${o.reasons.map((x) => x.code).join(',')}`);
