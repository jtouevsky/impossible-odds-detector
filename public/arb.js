// Guaranteed / Near-arb / Venues views, detail sheet, help center and "explain like I'm new" layer.
// Data arrives from app.js (iod:data). The server already applied the central rule; this file only presents.
import { feeRatePerShare } from '/src/arb/fees.js';
import { explainOpportunity, GLOSSARY, HELP } from '/explain-engine.js';

const $ = (id) => document.getElementById(id);
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const money = (n, d = 2) => (n == null || !isFinite(n) ? '—' : (n < 0 ? '−$' : '$') + Math.abs(n).toLocaleString(undefined, { minimumFractionDigits: d, maximumFractionDigits: d }));
const cents = (x, d = 1) => (x == null || !isFinite(x) ? '—' : `${(x * 100).toFixed(d).replace(/\.0$/, '')}¢`);
const pct = (x, d = 1) => (x == null || !isFinite(x) ? '—' : `${(x * 100).toFixed(x * 100 < 1 && x > 0 ? 2 : d)}%`);
const qtyFmt = (q) => (q == null ? '—' : q >= 1000 ? Math.round(q).toLocaleString() : q % 1 ? q.toFixed(2) : String(q));
const ago = (iso) => { const s = (Date.now() - Date.parse(iso)) / 1000; return !isFinite(s) ? '—' : s < 60 ? `${Math.max(0, Math.round(s))}s ago` : s < 3600 ? `${Math.round(s / 60)} min ago` : `${Math.round(s / 3600)} h ago`; };
const VNAME = { polymarket: 'Polymarket', 'polymarket-us': 'Polymarket US', kalshi: 'Kalshi', predictit: 'PredictIt', limitless: 'Limitless', manifold: 'Manifold' };
const pairName = (p) => p.split('↔').map((x) => x.replace(' only', '')).map((x) => VNAME[x] || x).join(' ↔ ') + (p.endsWith(' only') ? ' only' : '');
const LABEL = { 'cross-platform': 'Cross-platform', binary: 'Binary', 'multi-outcome': 'Multi-outcome', implication: 'Implication' };
const KIND_SIMPLE = { nested: 'Nested thresholds', equivalent: 'Same contract, two prices', partition: 'Covers every outcome', 'all-no': 'Bet against every outcome', 'all-yes': 'Bet on every outcome', complement: 'YES + NO', logical: 'If A then B' };

const S = { data: null, view: 'arb', filters: { q: '', type: 'all', roi: 0, profit: 0, liq: 0, verified: false, pair: '' } };

// ---------- jurisdiction / eligibility (settings come from crowd.js) ----------
const ELIG = () => window.IOD_SETTINGS || null;
function legEligibility(o) {
  const st = ELIG();
  if (!st?.jurisdiction) return null;
  const bad = [...new Set(o.providers || [])].map((p) => [p, st.eligibility?.[p]?.[st.jurisdiction]?.[0] || 'check']).filter(([, e]) => e !== 'yes');
  if (!bad.length) return { ok: true };
  return { ok: false, no: bad.some(([, e]) => e === 'no'), venues: bad.map(([p, e]) => `${VNAME[p] || p} (${e === 'no' ? 'not offered' : 'check eligibility'})`) };
}
window.addEventListener('iod:settings', () => { render(); renderProviders(); });

// ---------- mode / tabs ----------
const mode = () => document.documentElement.dataset.mode || 'simple';
function setMode(m) {
  document.documentElement.dataset.mode = m;
  for (const b of $('mode').children) b.classList.toggle('on', b.dataset.mode === m);
  try { localStorage.setItem('iod-mode', m); } catch { /* ignore */ }
  if (S.openId) open(S.openId, false);
}
$('mode').addEventListener('click', (e) => { const b = e.target.closest('button'); if (b) setMode(b.dataset.mode); });
setMode(mode());

function setView(v) {
  S.view = v;
  for (const b of document.querySelectorAll('#tabs .tab')) b.classList.toggle('on', b.dataset.view === v);
  $('view-arb').hidden = !(v === 'arb' || v === 'near');
  $('view-research').hidden = v !== 'research';
  $('view-providers').hidden = v !== 'providers';
  $('view-crowd').hidden = v !== 'crowd';
  $('view-linked').hidden = v !== 'linked';
  window.dispatchEvent(new CustomEvent('iod:view', { detail: { view: v } }));
  $('averified-wrap').hidden = v !== 'near';
  $('hero-title').textContent = v === 'near' ? 'Near-arb · tail risk' : 'Guaranteed arbitrage';
  $('hero-sub').innerHTML = v === 'near'
    ? `Looks like free money, but one thing isn't guaranteed — the contracts may settle differently, a rare outcome could break the hedge, quotes are stale, or the venue hides order sizes. <button class="eli" data-help="near">Explain like I'm new</button>`
    : `Trades that pay more than they cost in <b>every</b> possible outcome — priced at real order-book asks, after fees and a safety buffer. <button class="eli" data-help="guaranteed">Explain like I'm new</button>`;
  try { localStorage.setItem('iod-view', v); } catch { /* ignore */ }
  render();
}
$('tabs').addEventListener('click', (e) => { const b = e.target.closest('.tab'); if (b) setView(b.dataset.view); });

// ---------- data ----------
window.addEventListener('iod:data', (e) => {
  S.data = e.detail.arb || null; S.scannedAt = e.detail.scannedAt; S.researchCount = e.detail.violations?.length || 0;
  populatePairs(); render(); renderProviders(); openFromHash();
});
window.addEventListener('iod:error', (e) => { if (!S.data) $('alist').innerHTML = zero('Couldn\'t load market data', esc(e.detail), true); });
$('alist').innerHTML = Array.from({ length: 4 }, () => '<div class="skel"></div>').join('');
{ let v = 'arb'; try { v = localStorage.getItem('iod-view') || 'arb'; } catch { /* ignore */ } setView(v); }

function bucketList() {
  const all = S.data?.opportunities || [];
  return S.view === 'near' ? all.filter((o) => o.bucket === 'near') : all.filter((o) => o.bucket === 'guaranteed');
}

function visible() {
  const f = S.filters, q = f.q.trim().toLowerCase();
  return bucketList().filter((o) =>
    (S.view !== 'near' || !f.verified || o.matchStatus === 'VERIFIED') &&
    (!ELIG()?.eligibleOnly || legEligibility(o)?.ok !== false || !legEligibility(o)?.no) &&
    (f.type === 'all' || o.strategy === f.type) && (!f.pair || o.venuePair === f.pair) &&
    (o.roi ?? 0) * 100 >= f.roi - 1e-9 && (o.netProfit ?? 0) >= f.profit && (o.minLiquidity || 0) >= f.liq &&
    (!q || [o.title, ...o.legs.flatMap((l) => [l.question, l.label, l.eventTitle, l.venue])].join(' ').toLowerCase().includes(q)),
  ).sort((a, b) => (b.netProfit ?? 0) - (a.netProfit ?? 0));
}

function populatePairs() {
  const sel = $('apair'), cur = S.filters.pair;
  const pairs = [...new Set((S.data?.opportunities || []).map((o) => o.venuePair))].sort();
  sel.innerHTML = '<option value="">All venue pairs</option>' + pairs.map((p) => `<option value="${esc(p)}">${esc(pairName(p))}</option>`).join('');
  sel.value = pairs.includes(cur) ? cur : '';
}

// ---------- numbers that glide ----------
function animateNum(el, to, fmt) {
  const from = +(el.dataset.num || 0);
  el.dataset.num = to;
  if (matchMedia('(prefers-reduced-motion: reduce)').matches || !isFinite(to)) { el.textContent = fmt(to); return; }
  const t0 = performance.now(), dur = 650;
  const step = (t) => { const k = Math.min(1, (t - t0) / dur), e = 1 - Math.pow(1 - k, 3); el.textContent = fmt(from + (to - from) * e); if (k < 1) requestAnimationFrame(step); };
  requestAnimationFrame(step);
}

// ---------- render list ----------
function render() {
  if (!S.data || (S.view !== 'arb' && S.view !== 'near')) { updateTabs(); return; }
  const list = bucketList(), rows = visible();
  const pv = S.data.perVenue || {};
  const live = Object.values(pv).filter((v) => v.status === 'live' && !v.failed);
  animateNum($('t-count'), list.length, (x) => Math.round(x).toLocaleString());
  $('t-count-sub').textContent = S.view === 'near' ? `${list.filter((o) => o.matchStatus !== 'VERIFIED').length} unverified matches` : `${(S.data.opportunities || []).filter((o) => o.bucket === 'near').length} more in Near-arb`;
  const best = list.reduce((b, o) => (!b || (o.roi ?? -1) > (b.roi ?? -1) ? o : b), null);
  $('t-roi').textContent = best ? pct(best.roi) : '—'; $('t-roi').className = 't-v' + (best ? ' good' : '');
  $('t-roi-sub').textContent = best ? best.title : 'Nothing qualifies right now';
  const tot = list.reduce((s, o) => s + Math.max(0, o.netProfit || 0), 0);
  animateNum($('t-profit'), tot, (x) => money(x));
  $('t-profit-sub').textContent = S.view === 'near' ? 'not guaranteed' : 'sum at max fillable size';
  $('t-venues').textContent = `${live.length} live`;
  $('t-venues-sub').textContent = live.map((v) => v.name).join(' · ');
  updateTabs();

  const counts = { all: 0 };
  for (const o of list) { counts.all++; counts[o.strategy] = (counts[o.strategy] || 0) + 1; }
  for (const b of document.querySelectorAll('#atypes button')) b.innerHTML = `${esc(b.textContent.replace(/\s*\d[\d,]*$/, ''))}<span class="n">${counts[b.dataset.type] || 0}</span>`;

  if (!rows.length) {
    $('alist').innerHTML = list.length
      ? zero('Nothing matches these filters', `${list.length} ${S.view === 'near' ? 'near-arb' : 'guaranteed'} trade${list.length === 1 ? '' : 's'} exist — loosen the filters to see them.`)
      : S.view === 'near'
        ? zero('No near-arb right now', 'Nothing close to a free lunch either. Markets are tightly priced at the moment.')
        : zero('0 guaranteed arbitrage opportunities', `Nothing currently pays more than it costs in every outcome after fees. That's normal for efficient markets — and this screen will never invent one. ${(S.data.opportunities || []).filter((o) => o.bucket === 'near').length} near-arb trades are in the next tab.`);
  } else $('alist').innerHTML = rows.map(card).join('');
  const c = S.data.config || {}, st = S.data.stats || {};
  $('afoot').textContent = `${rows.length} shown · ${st.structures ?? 0} trade structures priced · ${(st.rejected?.deadZone ?? 0).toLocaleString()} dead-zone baskets rejected · buffer ${cents(c.bufferPerShare ?? 0.005)}/basket · scanned ${ago(S.scannedAt)}`;
}

function updateTabs() {
  const all = S.data?.opportunities || [];
  $('tab-arb-n').textContent = S.data ? all.filter((o) => o.bucket === 'guaranteed').length : '';
  $('tab-near-n').textContent = S.data ? all.filter((o) => o.bucket === 'near').length : '';
  $('tab-res-n').textContent = S.researchCount ?? '';
  $('tab-prov-n').textContent = S.data ? Object.values(S.data.perVenue || {}).filter((v) => v.status === 'live' && !v.failed).length : '';
}

function zero(title, text, err) {
  return `<div class="zero"><img class="ring" src="/brand/mark-edge.svg" alt="" style="${err ? 'filter:grayscale(1)' : ''}"/><h3>${esc(title)}</h3><p>${text}</p></div>`;
}

function legName(l) {
  if (l.label && !/^(yes|no)$/i.test(l.label)) return l.label;
  if (!/^(yes|no)$/i.test(l.outcome)) return l.outcome;
  return l.question;
}

function card(o) {
  const simple = mode() === 'simple';
  const buys = o.legs.slice(0, 4).map((l) => `<div class="buyline"><span class="pill ${l.side}">BUY ${l.side.toUpperCase()}</span><span class="pill venue">${esc(l.venue)}</span><b>${cents(l.ask)}</b><span class="what">${esc(legName(l))}</span></div>`).join('')
    + (o.legs.length > 4 ? `<div class="buyline muted">+ ${o.legs.length - 4} more legs</div>` : '');
  const reasons = (o.reasons || []).map((r) => `<span class="reason">${esc(r.text)}</span>`).join(' ');
  return `<article class="opp" tabindex="0" data-aid="${esc(o.id)}">
    <div>
      <div class="o-top">
        <span class="pill strat">${esc(simple ? KIND_SIMPLE[o.kind] || LABEL[o.strategy] : LABEL[o.strategy])}</span>
        <span class="pill ${o.bucket === 'guaranteed' ? 'verified' : o.matchStatus === 'VERIFIED' ? 'near' : 'likely'}">${o.bucket === 'guaranteed' ? 'GUARANTEED' : o.matchStatus === 'VERIFIED' ? 'NEAR-ARB' : 'LIKELY MATCH'}</span>
        <span class="muted" style="font-size:12px">${esc(o.venues.join(' + '))}</span>
        ${(() => { const e = legEligibility(o); return e && !e.ok ? `<span class="pill ${e.no ? 'bad-pill' : 'likely'}" title="${esc(e.venues.join(', '))}">${e.no ? 'VIEW ONLY · NOT IN YOUR JURISDICTION' : 'CHECK ELIGIBILITY'}</span>` : ''; })()}
      </div>
      <h3 class="o-title">${esc(o.title)}</h3>
      <div class="o-buy">${buys}</div>
    </div>
    <div class="o-nums">
      <div><div class="k">Net profit</div><div class="v big ${(o.netProfit ?? 0) > 0 ? '' : 'neg'}">${o.maxQty ? money(o.netProfit) : cents(o.unit.net, 2)}</div></div>
      <div><div class="k">ROI</div><div class="v">${pct(o.roi)}</div></div>
      <div><div class="k">${simple ? 'You put in' : 'Capital'}</div><div class="v">${o.capital != null ? money(o.capital, 0) : '—'}</div></div>
      <div class="pro-only"><div class="k">Cost / basket</div><div class="v">${money(o.unit.cost, 3)}</div></div>
      <div class="pro-only"><div class="k">Min payout</div><div class="v">${money(o.unit.minPayoff)}</div></div>
      <div class="pro-only"><div class="k">Size</div><div class="v">${o.maxQty ? qtyFmt(o.maxQty) : 'unknown'}</div></div>
    </div>
    <div class="o-why"><button class="eli" data-explain="${esc(o.id)}" style="margin-right:8px">Explain like I'm new</button>${o.bucket === 'guaranteed'
      ? `${simple ? 'Pays at least' : 'Min payoff'} ${money(o.unit.minPayoff)} per basket in every outcome · costs ${cents(o.unit.cost, 2)} + ${cents(o.unit.fees + o.unit.buffer, 2)} fees & buffer · quotes ${ago(o.quoteTime)}`
      : reasons}</div>
  </article>`;
}

// ---------- filters ----------
$('alist').addEventListener('click', (e) => { if (e.target.closest('.eli')) return; const c = e.target.closest('[data-aid]'); if (c) open(c.dataset.aid); });
$('alist').addEventListener('keydown', (e) => { if (e.key === 'Enter') { const c = e.target.closest('[data-aid]'); if (c) open(c.dataset.aid); } });
$('aq').addEventListener('input', (e) => { S.filters.q = e.target.value; render(); });
$('atypes').addEventListener('click', (e) => { const b = e.target.closest('button'); if (!b) return; for (const x of $('atypes').children) x.classList.toggle('on', x === b); S.filters.type = b.dataset.type; render(); });
$('aroi').addEventListener('input', (e) => { S.filters.roi = +e.target.value; $('aroi-val').textContent = `${S.filters.roi}%`; render(); });
$('aprofit').addEventListener('change', (e) => { S.filters.profit = +e.target.value; render(); });
$('aliq').addEventListener('change', (e) => { S.filters.liq = +e.target.value; render(); });
$('apair').addEventListener('change', (e) => { S.filters.pair = e.target.value; render(); });
$('averified').addEventListener('change', (e) => { S.filters.verified = e.target.checked; render(); });

// ---------- providers view ----------
function renderProviders() {
  const d = S.data;
  if (!d) return;
  const yn = (b) => (b ? '<span class="yes-i">●</span> yes' : '<span class="no-i">○</span> no');
  const rows = Object.entries(d.perVenue || {}).map(([id, v]) => `<tr>
      <td><b>${esc(v.name)}</b><div class="muted" style="font-size:12px;max-width:340px">${esc(v.notes || '')}</div>${v.failed ? `<div class="bad" style="font-size:12px">Sync failed: ${esc(v.error)}</div>` : ''}</td>
      <td><span class="lv ${STATE_CLS[v.state] || 'planned'}">${esc(STATE_LABEL[v.state] || (v.failed ? 'UNAVAILABLE' : 'PARTIAL'))}</span>${v.state === 'live' ? `<div class="muted" style="font-size:11.5px">${esc(v.label || '')}</div>` : ''}</td>
      <td>${eligCell(id)}</td>
      <td class="num">${(v.markets || 0).toLocaleString()}${v.listed ? `<div class="muted" style="font-size:11.5px">of ${v.listed.toLocaleString()} listed</div>` : ''}<div class="muted" style="font-size:11.5px">${(v.quoted ?? 0).toLocaleString()} with quotes</div></td>
      <td>${v.lastSuccess ? ago(v.lastSuccess) : '<span class="bad">never</span>'}<div class="muted" style="font-size:11.5px">${v.syncMs ? (v.syncMs / 1000).toFixed(1) + 's' : ''}</div></td>
      <td>${yn(v.orderBook)}${v.orderBook && !v.depth ? '<div class="muted" style="font-size:11.5px">prices only, no sizes</div>' : ''}</td>
      <td>${v.fees === 'exact' ? yn(true) : v.fees === 'assumed' ? '<span class="warnc">◐</span> assumed' : yn(false)}</td>
      <td>${v.realMoney ? 'real money' : 'play money'}</td>
      <td class="num">${(v.matchedPairs || 0).toLocaleString()}</td>
      <td class="num">${v.guaranteed || 0} / ${v.opportunities || 0}</td></tr>`).join('');
  $('ptable').innerHTML = `<tr><th>Venue</th><th>Status</th><th>You can trade</th><th class="num">Markets scanned</th><th>Last successful sync</th><th>Order book</th><th>Fee model</th><th>Money</th><th class="num">Cross-venue matches</th><th class="num">Guaranteed / all opps</th></tr>${rows}`;
  const pm = (d.pairMatrix || []).map((r) => `<tr><td><b>${esc(pairName(r.pair))}</b></td><td class="num">${r.verified}</td><td class="num">${r.likely}</td><td class="num">${r.mismatch}</td><td class="num">${r.structures}</td><td class="num"><b class="good">${r.guaranteed}</b></td><td class="num">${r.near}</td></tr>`).join('');
  $('pairtable').innerHTML = `<tr><th>Venue pair</th><th class="num">Verified matches</th><th class="num">Likely</th><th class="num">Rejected (mismatch)</th><th class="num">Trades priced</th><th class="num">Guaranteed</th><th class="num">Near-arb</th></tr>${pm || '<tr><td colspan="7" class="muted">No candidate pairs yet.</td></tr>'}`;
  $('planned').innerHTML = (d.planned || []).map((p) => `<div><b>${esc(p.name)}</b>${esc(p.notes)}</div>`).join('');
}

const STATE_LABEL = { live: 'LIVE', partial: 'PARTIAL', unavailable: 'UNAVAILABLE', 'needs-setup': 'NEEDS SETUP', pending: 'NOT SYNCED' };
const STATE_CLS = { live: 'live', partial: 'partial', unavailable: 'down', 'needs-setup': 'planned', pending: 'planned' };
function eligCell(id) {
  const st = ELIG();
  if (!st?.jurisdiction) return '<span class="muted">set jurisdiction</span>';
  const e = st.eligibility?.[id]?.[st.jurisdiction] || ['check', 'Unknown'];
  return `<span class="${e[0] === 'yes' ? 'good' : e[0] === 'no' ? 'bad' : 'warnc'}" title="${esc(e[1])}">${e[0] === 'yes' ? 'Yes' : e[0] === 'no' ? 'No' : 'Check'}</span><div class="muted" style="font-size:11.5px;max-width:180px">${esc(e[1])}</div>`;
}
window.IOD_STATE = { STATE_LABEL, STATE_CLS, ago, esc, money, cents, pct, eligCell };

// ---------- detail sheet ----------
function open(id, push = true) {
  const o = S.data?.opportunities.find((x) => x.id === id);
  if (!o) return;
  S.openId = id;
  const ex = explainOpportunity(o);
  const simple = mode() === 'simple';
  const sec = (n, title, body, helpKey) => `<div class="box"><h4><span class="sec-num">${n}</span>${esc(title)}${helpKey ? ` <button class="eli sm" ${helpKey}>?</button>` : ''}</h4>${body}</div>`;
  const buyRows = o.legs.map((l, i) => `<div class="row" data-leg="${i}"><span class="pill ${l.side}">BUY ${l.side.toUpperCase()}</span><span class="pill venue venue-cell">${esc(l.venue)}</span>
      <span>${esc(legName(l))}<div class="muted" style="font-size:12px">${esc(l.eventTitle || l.question)} · <a href="${esc(l.url)}" target="_blank" rel="noopener">open ${esc(l.venue)} ↗</a></div></span>
      <span style="text-align:right"><b>${cents(l.ask)}</b><div class="muted" style="font-size:11.5px">${l.noDepth ? 'size not published' : `${qtyFmt(l.qty)} sh`}</div><div class="live-cell muted" style="font-size:11.5px"></div></span></div>`).join('');
  const scen = ex.scenarios.map((s) => `<div class="s ${s.ok ? '' : 'bad'} ${s.tail ? 'tail' : ''}"><span>${esc(s.label)}${s.tail ? ' <span class="muted">(rare)</span>' : ''}<div class="muted" style="font-size:12px">wins: ${esc(s.winners)}</div></span><span class="r">pays ${esc(s.pays)}</span><span class="r ${s.ok ? 'good' : 'bad'}">${esc(s.result)}</span></div>`).join('');
  const checks = (o.checks || []).length
    ? `<table class="legs"><tr><th>Field</th><th>Leg A</th><th>Leg B</th><th>Result</th></tr>${o.checks.map((c) => `<tr><td>${esc(c.field)}</td><td>${esc(c.a ?? '')}</td><td>${esc(c.b ?? '')}</td><td class="${c.result === 'ok' ? 'good' : c.result === 'warn' ? 'warnc' : 'bad'}">${c.result.toUpperCase()}${c.note ? ` · ${esc(c.note)}` : ''}</td></tr>`).join('')}</table>`
    : '<p>Single-venue structure: the link comes from the market\'s own structure (same event, same rules, different threshold or outcome).</p>';
  const sizes = o.sizes.length
    ? `<div class="table-scroll"><table class="legs"><tr><th class="num">Baskets</th><th class="num">Cost</th><th class="num">Min payout</th><th class="num">Fees</th><th class="num">Buffer</th><th class="num">Net</th><th class="num">ROI</th></tr>${o.sizes.map((s) => `<tr><td class="num">${qtyFmt(s.qty)}</td><td class="num">${money(s.cost)}</td><td class="num">${money(s.payout)}</td><td class="num">${money(s.fees, 3)}</td><td class="num">${money(s.buffer)}</td><td class="num"><b>${money(s.net, Math.abs(s.net) < 1 ? 3 : 2)}</b></td><td class="num">${pct(s.roi)}</td></tr>`).join('')}</table></div>
       <p class="muted" style="margin-top:8px">${edgeStopText(o)}</p>`
    : '<p class="muted">Order sizes are not available on one venue, so we can only show per-basket economics.</p>';
  const rules = o.legs.filter((l, i, a) => a.findIndex((x) => x.marketId === l.marketId) === i).slice(0, 4)
    .map((l) => `<div class="rule"><div class="bk-h">${esc(l.venue)} · ${esc(legName(l))}</div><pre>${esc(l.rules || '(rules text not provided by this venue — open the market link)')}</pre></div>`).join('');

  $('drawer').innerHTML = `
    <div class="d-head"><div>
        <span class="pill ${o.bucket === 'guaranteed' ? 'verified' : 'near'}">${o.bucket === 'guaranteed' ? 'GUARANTEED ARBITRAGE' : 'NEAR-ARB · NOT GUARANTEED'}</span>
        <span class="pill ${o.matchStatus === 'VERIFIED' ? 'verified' : 'likely'}">${o.matchStatus === 'VERIFIED' ? 'VERIFIED MATCH' : o.matchStatus + ' MATCH'}</span>
        <h2>${esc(o.title)}</h2>${(() => { const e = legEligibility(o); return e && !e.ok ? `<div class="${e.no ? 'bad' : 'warnc'}" style="font-size:12.5px;margin-top:6px">${e.no ? 'View only — ' : 'Check eligibility — '}${esc(e.venues.join(', '))}. Research data stays visible either way.</div>` : ''; })()}</div>
      <button class="btn icon" id="aclose" aria-label="Close"><svg viewBox="0 0 24 24" class="ico"><path d="M6 6l12 12M18 6 6 18"/></svg></button></div>
    <div class="d-body">
      <div class="kpis">
        <div class="kpi"><div class="k">${simple ? 'Profit if you do it all' : 'Net profit (max size)'}</div><div class="v good">${o.maxQty ? money(o.netProfit) : cents(o.unit.net, 2) + '/basket'}</div></div>
        <div class="kpi"><div class="k">Return</div><div class="v good">${pct(o.roi)}</div></div>
        <div class="kpi"><div class="k">${simple ? 'Money needed' : 'Capital required'}</div><div class="v">${o.capital != null ? money(o.capital) : '—'}</div></div>
        <div class="kpi"><div class="k">Quotes</div><div class="v" style="font-size:15px">${ago(o.quoteTime)}</div></div>
      </div>
      ${sec('01', 'Trade summary', `<p>${esc(ex.summary)}</p>`)}
      ${sec('02', 'Simple explanation', `<p>${esc(ex.why)}</p><p><b>${o.bucket === 'guaranteed' ? 'Guaranteed?' : 'Guaranteed? No.'}</b> ${esc(ex.guarantee)}</p>
        <div class="claude" style="margin-top:10px"><button class="btn primary-soft" id="askclaude"><svg viewBox="0 0 24 24" class="ico"><path d="M4 5h16v11H9l-5 4z"/></svg>Ask the analyst about this</button></div>`)}
      ${sec('03', 'What do I actually buy?', `<div class="bigbuy">${buyRows}</div>
        <div class="live" style="margin-top:10px"><button class="btn" id="arecheck">Re-check live prices</button><span class="live-out" id="arecheck-out">Quotes from ${ago(o.quoteTime)}.</span></div>`, 'data-glossary="executable size"')}
      ${sec('04', 'What happens in every outcome', `<div class="scen">${scen}</div>`, 'data-glossary="guaranteed payout"')}
      ${sec('05', 'Profit math', `<div class="kv">
          <span>Cost per basket (sum of asks)</span><b>${money(o.unit.cost, 4)}</b>
          <span>Lowest payout in any outcome</span><b>${money(o.unit.minPayoff, 2)}</b>
          <span>Gross edge</span><b>${cents(o.unit.gross, 2)}</b>
          <span>Fees</span><b>−${cents(o.unit.fees, 2)}</b>
          <span>Safety / slippage buffer</span><b>−${cents(o.unit.buffer, 2)}</b>
          <span>Net per basket</span><b class="good">${cents(o.unit.net, 2)}</b></div>
          <h4 style="margin-top:14px">At different sizes (walking the order books)</h4>${sizes}`, 'data-glossary="slippage"')}
      ${sec('06', 'Why it qualifies', `<p>${esc(ex.bucketWhy)}</p><div style="margin-top:8px">${checks}</div>`, 'data-glossary="verified match"')}
      ${sec('07', 'Risks & assumptions', `<ul class="risks">${ex.risks.map((r) => `<li>${esc(r)}</li>`).join('')}</ul>`)}
      ${sec('08', 'Raw market rules', `<div class="rules-grid">${rules}</div>`)}
      ${sec('09', 'Order books & data freshness', `<div class="books">${o.legs.map((l, i) => `<div class="book"><div class="bk-h">Leg ${i + 1} · ${esc(l.venue)} ${l.side.toUpperCase()} asks</div><table class="legs"><tr><th class="num">Price</th><th class="num">Size</th><th class="num">Used</th></tr>${(l.depth || []).map((x) => { const f = (l.fill || []).find((y) => Math.abs(y.p - x.p) < 1e-9); return `<tr><td class="num">${cents(x.p)}</td><td class="num">${x.s == null ? '?' : qtyFmt(x.s)}</td><td class="num">${f ? qtyFmt(f.s) : ''}</td></tr>`; }).join('')}</table></div>`).join('')}</div>
        <p class="muted" style="margin-top:8px">Quoted ${esc(o.quoteTime || '—')} (${ago(o.quoteTime)}). Guaranteed trades must have quotes under ${Math.round((S.data.config?.maxQuoteAgeMs || 120000) / 1000)}s old at scan time — re-check before trading.</p>`)}
    </div>`;
  $('aclose').onclick = close;
  $('arecheck').onclick = () => recheck(o);
  $('askclaude').onclick = () => window.dispatchEvent(new CustomEvent('iod:ask', { detail: { id: o.id } }));
  $('scrim').hidden = false;
  requestAnimationFrame(() => { $('scrim').classList.add('on'); $('drawer').classList.add('on'); });
  $('drawer').setAttribute('aria-hidden', 'false');
  window.dispatchEvent(new CustomEvent('iod:focus', { detail: { id } }));
  if (push) { $('drawer').scrollTop = 0; $('drawer').focus(); history.replaceState(null, '', '#a=' + encodeURIComponent(id)); }
}

function edgeStopText(o) {
  const e = o.edgeStop || {};
  if (e.reason === 'book-empty') return `Stops at ${qtyFmt(o.maxQty)} baskets because one order book runs out of offers.`;
  if (e.reason === 'unprofitable') return `Stops at ${qtyFmt(o.maxQty)} baskets: the next price levels (${(e.prices || []).map((p) => cents(p)).join(' + ')}) would make each extra basket lose ${cents(-e.marginal, 2)} after fees.`;
  return '';
}

function close() {
  S.openId = null;
  $('drawer').classList.remove('on'); $('scrim').classList.remove('on');
  $('drawer').setAttribute('aria-hidden', 'true');
  setTimeout(() => { $('scrim').hidden = true; }, 220);
  history.replaceState(null, '', location.pathname);
}
$('scrim').addEventListener('click', () => { if (S.openId) close(); });
document.addEventListener('keydown', (e) => { if (e.key === 'Escape') { if (!$('helpmodal').hidden) $('helpmodal').hidden = true; else if (S.openId) close(); hidePop(); } });

function openFromHash() {
  const m = location.hash.match(/^#a=(.+)$/);
  if (!m) return;
  const o = S.data?.opportunities.find((x) => x.id === decodeURIComponent(m[1]));
  if (o) { setView(o.bucket === 'near' ? 'near' : 'arb'); open(o.id, false); }
}

async function recheck(o) {
  const btn = $('arecheck'), out = $('arecheck-out');
  btn.disabled = true; btn.classList.add('spinning'); out.textContent = 'Fetching live order books…';
  try {
    const live = await Promise.all(o.legs.map(async (l) => {
      const r = await fetch(`/api/book?provider=${encodeURIComponent(l.provider)}&token=${encodeURIComponent(l.bookToken)}&side=${l.side}`);
      if (!r.ok) throw new Error(`${l.venue} book unavailable`);
      const b = await r.json();
      return { ask: b.ask, size: b.askSize, noDepth: b.noDepth };
    }));
    live.forEach((x, i) => { const c = document.querySelector(`[data-leg="${i}"] .live-cell`); if (c) c.textContent = x.ask != null ? `live ${cents(x.ask)}${x.noDepth ? '' : ` · ${qtyFmt(Math.round(x.size))} sh`}` : 'no offer now'; });
    if (live.some((x) => x.ask == null)) { out.innerHTML = '<b class="bad">A leg has no offer right now — not executable.</b>'; return; }
    const cost = live.reduce((s, x) => s + x.ask, 0);
    const fees = live.reduce((s, x, i) => s + feeRatePerShare(o.legs[i].feeModel || { provider: o.legs[i].provider }, x.ask), 0);
    const net = o.unit.minPayoff - cost - fees - o.unit.buffer;
    out.innerHTML = net > 0
      ? `<b class="good">Still there:</b> cost ${money(cost, 4)}, net ${cents(net, 2)} per basket at the top of the books. ${new Date().toLocaleTimeString()}`
      : `<b class="bad">Gone:</b> live cost ${money(cost, 4)} + fees + buffer leaves ${cents(net, 2)} per basket. ${new Date().toLocaleTimeString()}`;
  } catch (err) { out.textContent = `Could not re-check: ${err.message}`; }
  finally { btn.disabled = false; btn.classList.remove('spinning'); }
}

async function copy(text, notify = true) {
  try { await navigator.clipboard.writeText(text); if (notify) toast('Prompt copied — paste it into Claude'); }
  catch { const t = document.createElement('textarea'); t.value = text; document.body.appendChild(t); t.select(); document.execCommand('copy'); t.remove(); if (notify) toast('Prompt copied'); }
}
function toast(msg) { const t = $('toast'); t.textContent = msg; t.hidden = false; clearTimeout(toast.t); toast.t = setTimeout(() => { t.hidden = true; }, 2600); }

// ---------- "explain like I'm new" popovers ----------
function hidePop() { $('pop').hidden = true; }
document.addEventListener('click', (e) => {
  const b = e.target.closest('.eli');
  if (!b) { if (!e.target.closest('#pop')) hidePop(); return; }
  e.preventDefault(); e.stopPropagation();
  if (b.dataset.explain) {
    const o = S.data?.opportunities.find((x) => x.id === b.dataset.explain);
    if (!o) return;
    const ex = explainOpportunity(o);
    const pop = $('pop');
    pop.innerHTML = `<h5>In plain English</h5><p><b>${esc(ex.summary)}</b></p><p>${esc(ex.why)}</p><p>${esc(ex.guarantee)}</p><p class="ex"><a href="#" id="pop-open">See every outcome, risks and exact trades →</a></p>`;
    placePop(b);
    $('pop-open').onclick = (ev) => { ev.preventDefault(); hidePop(); open(o.id); };
    return;
  }
  const g = b.dataset.glossary && GLOSSARY[b.dataset.glossary];
  const h = b.dataset.help && HELP[b.dataset.help];
  const title = b.dataset.glossary || ({ guaranteed: 'Guaranteed arbitrage', near: 'Near-arb', research: 'Research', providers: 'Venues', netProfit: 'Executable profit', strategy: 'Strategy types', minRoi: 'Min net ROI', minProfit: 'Min profit', minLiq: 'Min liquidity', beginner: 'Simple mode' }[b.dataset.help] || 'Explanation');
  const pop = $('pop');
  pop.innerHTML = `<h5>${esc(title)}</h5>${g ? `<p><b>${esc(g.short)}</b></p><p>${esc(g.long)}</p><p class="ex">Example: ${esc(g.example)}</p>` : `<p>${esc(h || '')}</p>`}<p class="ex"><a href="#" id="pop-more">Open the glossary →</a></p>`;
  placePop(b);
  $('pop-more').onclick = (ev) => { ev.preventDefault(); hidePop(); openHelp(); };
});

function placePop(b) {
  const pop = $('pop');
  pop.hidden = false;
  const r = b.getBoundingClientRect();
  const w = Math.min(340, innerWidth - 24);
  pop.style.left = `${Math.max(12, Math.min(innerWidth - w - 12, r.left - 20))}px`;
  pop.style.top = `${r.bottom + 8 + pop.offsetHeight > innerHeight ? Math.max(12, r.top - 8 - pop.offsetHeight) : r.bottom + 8}px`;
}

// ---------- help center ----------
function openHelp() {
  const g = Object.entries(GLOSSARY).map(([k, v]) => `<div class="g"><h5>${esc(k)}</h5><b>${esc(v.short)}</b><p style="margin:6px 0 0">${esc(v.long)}</p><p class="muted" style="margin:6px 0 0">e.g. ${esc(v.example)}</p></div>`).join('');
  $('helpsheet').innerHTML = `
    <div style="display:flex;justify-content:space-between;align-items:start;gap:12px"><div><h2>Help & glossary</h2><p class="muted" style="margin:0">Everything on this screen, in plain words.</p></div>
      <button class="btn icon" id="helpclose" aria-label="Close"><svg viewBox="0 0 24 24" class="ico"><path d="M6 6l12 12M18 6 6 18"/></svg></button></div>
    <div class="gloss" style="margin-top:18px">
      <div class="g"><h5>Guaranteed arbitrage</h5>${esc(HELP.guaranteed)}</div>
      <div class="g"><h5>Near-arb</h5>${esc(HELP.near)}</div>
      <div class="g"><h5>Research</h5>${esc(HELP.research)}</div>
      <div class="g"><h5>How to place a trade</h5>Open an opportunity, look at "What do I actually buy?", press "Re-check live prices", then place every leg quickly at (or below) the shown price. Partial fills are the main risk.</div>
    </div>
    <h3 style="margin:22px 0 0;font-size:15px">Glossary</h3><div class="gloss">${g}</div>
    <h3 style="margin:22px 0 4px;font-size:15px">About the analyst chat</h3>
    <p class="muted" style="margin:0">The chat button (lower right) answers questions using only the data on screen. If Claude Code is installed and logged in on this Mac, it answers with Claude through your existing Claude subscription — no API key or credits. Otherwise it uses a free local model (Ollama) if one is running, or the built-in offline analyst.</p>`;
  $('helpmodal').hidden = false;
  $('helpclose').onclick = () => { $('helpmodal').hidden = true; };
}
$('help').addEventListener('click', openHelp);
$('helpmodal').addEventListener('click', (e) => { if (e.target.id === 'helpmodal') $('helpmodal').hidden = true; });

// Read-only snapshot for the in-app analyst (chat.js).
window.IOD = { snapshot: () => ({ S, visible: S.data ? visible() : [], mode: mode() }) };
