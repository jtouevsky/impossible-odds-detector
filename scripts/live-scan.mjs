// Usage: node scripts/live-scan.mjs [raw-gamma-events.json]
// Without an argument it fetches live data from Polymarket. Prints the top violations.
import fs from 'node:fs';
import { polymarketProvider, normalizeEvent } from '../src/providers/polymarket.js';
import { runPipeline } from '../src/engine/pipeline.js';

let snap;
const file = process.argv[2];
if (file) {
  const raw = JSON.parse(fs.readFileSync(file, 'utf8'));
  const events = [], markets = [];
  for (const e of raw) { const r = normalizeEvent(e); if (r.markets.length) { events.push(r.event); markets.push(...r.markets); } }
  snap = { provider: 'polymarket', fetchedAt: new Date().toISOString(), events, markets };
} else {
  snap = await polymarketProvider.fetchSnapshot({ maxEvents: +(process.env.MAX_EVENTS || 4000),
    onProgress: (p) => process.stderr.write(`\r${p.events} events / ${p.markets} markets`) });
  process.stderr.write('\n');
}
const res = await runPipeline(snap);
const { largest, ...rest } = res.stats;
console.log(JSON.stringify(rest));
const pct = (x) => (x * 100).toFixed(1);
const top = +(process.env.TOP || 40);
for (const v of res.violations.slice(0, top)) {
  const legs = v.a ? `${v.a.question} [${v.a.yesOutcome}] ${pct(v.a.price)} (${v.a.bid}/${v.a.ask})  ->  ${v.b.question} [${v.b.yesOutcome}] ${pct(v.b.price)} (${v.b.bid}/${v.b.ask})`
    : `${v.event?.title} Σ=${pct(v.sum)} n=${v.legs.length}`;
  console.log(`${v.type.padEnd(13)} ${v.subtype || ''} mag=${pct(v.magnitude)} edge=${pct(v.edge)} conf=${pct(v.confidence)} liq=${Math.round(v.minLiquidity)} | ${legs}`);
}
