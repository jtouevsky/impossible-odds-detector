// Provider registry (Polymarket, Kalshi). To add another venue: implement { id, name, fetchSnapshot(), fetchBook?() }
// returning the Snapshot shape documented in schema.js, then register it here. The engine is unchanged.
import { polymarketProvider } from './polymarket.js';
import { kalshiProvider } from './kalshi.js';
import { predictitProvider } from './predictit.js';
import { limitlessProvider } from './limitless.js';
import { manifoldProvider } from './manifold.js';
import { polymarketUSProvider } from './polymarketUS.js';

export const providers = {
  [polymarketProvider.id]: polymarketProvider,
  [polymarketUSProvider.id]: polymarketUSProvider,
  [kalshiProvider.id]: kalshiProvider,
  [predictitProvider.id]: predictitProvider,
  [limitlessProvider.id]: limitlessProvider,
  [manifoldProvider.id]: manifoldProvider,
};

// Venues we know about but cannot integrate honestly without credentials / a public API.
export const PLANNED = [
  { id: 'betfair', name: 'Betfair Exchange', status: 'planned', notes: 'Needs an app key + funded account; not available in the US.' },
  { id: 'smarkets', name: 'Smarkets', status: 'planned', notes: 'Public quotes API exists (sports/politics); adapter not built yet.' },
  { id: 'forecastex', name: 'ForecastEx (Interactive Brokers)', status: 'planned', notes: 'Requires an IBKR account and the TWS/Client Portal API.' },
  { id: 'cryptocom', name: 'Crypto.com / Robinhood event contracts', status: 'planned', notes: 'No public market-data API for event contracts.' },
];

export function getProvider(id) {
  const p = providers[id];
  if (!p) throw new Error(`Unknown provider "${id}"`);
  return p;
}

/** Merge snapshots from several providers into one (ids are already provider-unique in practice). */
export function mergeSnapshots(snaps) {
  return {
    provider: snaps.map((s) => s.provider).join('+'),
    fetchedAt: snaps.map((s) => s.fetchedAt).sort()[0],
    partial: snaps.some((s) => s.partial),
    warnings: snaps.flatMap((s) => s.warnings || []),
    events: snaps.flatMap((s) => s.events),
    markets: snaps.flatMap((s) => s.markets),
  };
}

// Who may TRADE on each venue. Viewing research data never depends on this.
// 'yes' = generally open to residents, 'no' = not offered, 'check' = depends on state/country or terms we can't verify.
export const JURISDICTIONS = { US: 'United States', NONUS: 'Outside the US' };
export const ELIGIBILITY = {
  polymarket: { US: ['no', 'Polymarket International is not offered to US persons — US users trade on Polymarket US.'], NONUS: ['check', 'Restricted in several countries; check Polymarket\'s terms for yours.'] },
  'polymarket-us': { US: ['check', 'US-only exchange; availability can vary by state. Check in the app.'], NONUS: ['no', 'Only for US residents.'] },
  kalshi: { US: ['yes', 'CFTC-regulated; open to US residents.'], NONUS: ['check', 'Available in some countries; check Kalshi\'s eligibility list.'] },
  predictit: { US: ['yes', 'US political market ($850 per contract).'], NONUS: ['check', 'Check PredictIt\'s terms for your country.'] },
  limitless: { US: ['check', 'Offshore on-chain venue; check its terms for US persons.'], NONUS: ['check', 'Check Limitless\'s terms for your country.'] },
  manifold: { US: ['yes', 'Play money — research only.'], NONUS: ['yes', 'Play money — research only.'] },
  sportsbooks: { US: ['check', 'US sportsbooks are licensed state by state.'], NONUS: ['check', 'Depends on your country\'s licensing.'] },
  pinnacle: { US: ['no', 'Pinnacle does not take US customers.'], NONUS: ['check', 'Available in many countries; check yours.'] },
  dfs: { US: ['check', 'Pick\'em products are state-dependent.'], NONUS: ['check', 'Mostly US/Canada; check availability.'] },
};
export function eligibility(venue, jurisdiction) {
  if (!jurisdiction || !JURISDICTIONS[jurisdiction]) return { status: 'unknown', note: 'Choose your jurisdiction in Venues to see which venues you can trade on.' };
  const e = ELIGIBILITY[venue]?.[jurisdiction];
  return e ? { status: e[0], note: e[1] } : { status: 'check', note: 'Unknown — check the venue\'s terms.' };
}
