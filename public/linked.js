// Linked Markets tab: live / research (manual score) / example results from /api/linked.
const $ = (id) => document.getElementById(id);
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const money = (n, d = 2) => (n == null || !isFinite(n) ? '—' : (n < 0 ? '−$' : '$') + Math.abs(n).toLocaleString(undefined, { minimumFractionDigits: d, maximumFractionDigits: d }));
const cents = (x, d = 1) => (x == null || !isFinite(x) ? '—' : `${(x * 100).toFixed(d).replace(/\.0$/, '')}¢`);
const pct = (x) => (x == null || !isFinite(x) ? '—' : `${(x * 100).toFixed(Math.abs(x) < 0.01 ? 2 : 1)}%`);
const qtyFmt = (q) => (q == null ? '—' : q >= 1000 ? Math.round(q).toLocaleString() : q % 1 ? q.toFixed(2) : String(q));
const ago = (iso) => { const s = (Date.now() - Date.parse(iso)) / 1000; return !isFinite(s) ? '—' : s < 60 ? `${Math.max(0, Math.round(s))}s ago` : s < 3600 ? `${Math.round(s / 60)} min ago` : `${Math.round(s / 3600)} h ago`; };

const cap = (x) => (x ? x[0].toUpperCase() + x.slice(1) : '');
const L = { data: null, research: null, mode: 'live', f: { minNet: 0, minCap: 0, kind: '', all: false }, openId: null, timer: null, view: null };
const CLS = { executable: ['verified', 'EXECUTABLE'], structural: ['near', 'PROFITABLE STRUCTURE · NOT EXECUTABLE'], research: ['likely', 'RESEARCH'], unprofitable: ['likely', 'VERIFIED LINK · NOT PROFITABLE'] };
const RULE_NAME = (r) => (r === 'score-constraint' ? 'Score-based' : `Bracket · ${r}`);

async function load(force = false) {
  try {
    const r = await fetch(`/api/linked${force ? '?force=1' : ''}`);
    L.data = await r.json();
  } catch (e) { L.data = { error: e.message, results: [], examples: [] }; }
  render();
}

function list() {
  const src = L.mode === 'example' ? L.data?.examples || [] : L.mode === 'research' ? L.research?.results || [] : L.data?.results || [];
  const f = L.f;
  return src.filter((b) => (f.all || b.profitable || L.mode === 'example') &&
    (!f.kind || (f.kind === 'score' ? b.relationship.rule === 'score-constraint' : b.relationship.rule !== 'score-constraint')) &&
    (!f.minNet || (b.econ?.minNet ?? -1) >= f.minNet) && (!f.minCap || (b.econ?.capital ?? 0) >= f.minCap)).slice(0, 120);
}

function stateLine(b) {
  const s = b.relationship.state || {};
  if (b.relationship.rule === 'score-constraint') return `${esc(s.score || '')}${s.period ? ` · ${esc(s.period)}` : ''} · ${esc(b.status.state)}${s.providerTime ? ` · score update ${ago(s.providerTime)}` : ''}`;
  return `Tournament stage: ${esc(s.stage || '')}`;
}
const chip = (ok, text, warn) => `<span class="lchip ${ok ? 'ok' : warn ? 'warn' : 'no'}">${ok ? '✓' : warn ? '!' : '×'} ${esc(text)}</span>`;
function chips(b) {
  return chip(b.status.structure === 'verified', 'Structure verified') + chip(b.status.quotes === 'live', `Quotes ${b.status.quotes}`) +
    chip(b.status.size === 'verified', b.status.size === 'verified' ? 'Size checked' : 'Size unknown', true) +
    chip(!b.status.settlement.length, b.status.settlement.length ? `${b.status.settlement.length} settlement caveat${b.status.settlement.length > 1 ? 's' : ''}` : 'Settlement clear', true);
}

function card(b) {
  const [cls, label] = b.mode === 'example' ? ['research', 'EXAMPLE · HYPOTHETICAL PRICES'] : b.mode === 'research' ? ['research', 'RESEARCH · MANUAL SCORE'] : CLS[b.classification];
  const e = b.econ, u = b.unit;
  const legs = b.legs.map((l) => `<div class="buyline"><span class="pill ${l.side}">BUY ${l.side.toUpperCase()}</span><span class="pill venue">${esc(l.venue)}</span><b>${cents(l.ask)}</b><span class="what">${esc(l.label)} <span class="muted">· ${esc(l.market)}</span></span>${e ? `<span class="muted">× ${qtyFmt(e.qty)}</span>` : ''}</div>`).join('');
  return `<article class="opp linked" tabindex="0" data-lid="${esc(b.id)}">
    <div>
      <div class="o-top"><span class="pill strat">${esc(RULE_NAME(b.relationship.rule))}</span><span class="pill ${cls}">${label}</span>
        <span class="muted" style="font-size:12px">${stateLine(b)}</span></div>
      <h3 class="o-title">${esc(cap(b.relationship.from.event))} <span class="muted">${b.relationship.type === 'equivalence' ? '⇔' : '⇒'}</span> ${esc(b.relationship.to.event)}</h3>
      <p class="lwhy">${esc(b.relationship.why)}</p>
      <div class="o-buy">${legs}</div>
      <div class="lchips">${chips(b)}</div>
    </div>
    <div class="o-nums">
      <div><div class="k">Min net profit</div><div class="v big ${e && e.minNet > 0 ? '' : 'neg'}">${e ? money(e.minNet) : '—'}</div></div>
      <div><div class="k">ROI</div><div class="v">${e ? pct(e.roi) : '—'}</div></div>
      <div><div class="k">Total cost</div><div class="v">${e ? money(e.cost) : '—'}</div></div>
      <div><div class="k">Min payout</div><div class="v">${e ? money(e.minPayout) : '—'}</div></div>
      <div class="pro-only"><div class="k">Fees</div><div class="v">${e ? money(e.fees) : '—'}</div></div>
      <div class="pro-only"><div class="k">Per basket</div><div class="v">${u ? cents(u.net, 2) : '—'}</div></div>
      <div><div class="k">Size</div><div class="v">${b.sizeVerified ? qtyFmt(e?.qty) : 'unknown'}</div></div>
    </div>
    <div class="o-why"><button class="eli" data-lexplain="${esc(b.id)}" style="margin-right:8px">Explain this simply</button>${esc(b.reasons.slice(0, 2).join(' '))}</div>
  </article>`;
}

function render() {
  if (!$('llist')) return;
  const d = L.data;
  const res = d?.results || [];
  $('tab-linked-n').textContent = d ? res.filter((b) => b.profitable).length : '';
  $('l-exec').textContent = d ? res.filter((b) => b.executable).length : '—';
  $('l-exec-sub').textContent = d ? 'live · verified · sized · fresh' : 'loading…';
  $('l-struct').textContent = d ? res.filter((b) => b.profitable).length : '—';
  $('l-struct-sub').textContent = d ? `${res.filter((b) => b.profitable && !b.executable).length} not executable` : '';
  $('l-links').textContent = d?.diagnostics ? d.diagnostics.verifiedRelationships.toLocaleString() : '—';
  $('l-links-sub').textContent = d?.diagnostics ? `${d.diagnostics.contracts.tournament} bracket · ${d.diagnostics.contracts.winner} games` : '';
  const g = d?.games || [];
  $('l-games').textContent = d ? `${g.filter((x) => x.live).length} live` : '—';
  $('l-games-sub').textContent = d ? `${g.length} upcoming/live games · ${d.diagnostics?.verifiedStates ?? 0} verified states` : '';
  $('l-source').textContent = d?.source ? `Polymarket US · ${d.source.state}${d.source.errors?.length ? ` (${d.source.errors.join('; ')})` : ''} · ${ago(d.generatedAt)} · auto-refresh ${d.config?.refreshSec ?? 15}s` : d?.error ? `Error: ${d.error}` : '';
  for (const b of $('l-mode').children) b.classList.toggle('on', b.dataset.mode === L.mode);
  renderManual();

  const rows = list();
  const empty = $('l-empty');
  if (L.mode === 'live' && d && !rows.length) {
    empty.hidden = false;
    empty.innerHTML = `<b>No profitable linked trades right now.</b> ${esc(d.emptyReason || '')} ${d.total ? `Tick “Show verified links that don't pay” to see all ${d.total.toLocaleString()} verified links and their prices.` : ''}`;
  } else if (L.mode === 'research' && !L.research) {
    empty.hidden = false; empty.innerHTML = '<b>Research mode.</b> Pick a game, type a score, and the engine re-derives every link with that score and the game\'s current prices. Results are labelled research and never enter the executable feed.';
  } else empty.hidden = true;
  $('llist').innerHTML = rows.length ? rows.map(card).join('') : '';
  $('lfoot').textContent = d?.diagnostics ? `${rows.length} shown · ${d.total?.toLocaleString() ?? 0} baskets evaluated · ${d.diagnostics.rejected.unprofitable.toLocaleString()} priced consistently · ${d.diagnostics.rejected.missingQuotes} missing a side` : '';
  if (L.openId) open(L.openId, false);
}

function renderManual() {
  const box = $('l-manual');
  box.hidden = L.mode !== 'research';
  if (box.hidden || box.dataset.built) return;
  const games = L.data?.games || [];
  box.dataset.built = '1';
  box.innerHTML = `<div class="lman-row"><label class="f sel"><span>Game</span><select id="lm-game">${games.map((g) => `<option value="${esc(g.slug)}">${esc(g.title)} (${esc(g.league.toUpperCase())})</option>`).join('')}</select></label>
    <span id="lm-scores"></span><button class="btn primary" id="lm-run">Run research</button><span class="muted" id="lm-out"></span></div>`;
  const scores = () => { const g = games.find((x) => x.slug === $('lm-game').value); $('lm-scores').innerHTML = g ? Object.keys(g.scores || {}).map((c) => `<label class="f"><span>${esc(c.toUpperCase())}</span><input class="lm-in" type="number" min="0" step="1" data-team="${esc(c)}" value="${g.scores[c] ?? 0}"/></label>`).join('') : ''; };
  $('lm-game').onchange = scores; scores();
  $('lm-run').onclick = async () => {
    const body = { eventSlug: $('lm-game').value, scores: Object.fromEntries([...document.querySelectorAll('.lm-in')].map((i) => [i.dataset.team, +i.value])) };
    $('lm-out').textContent = 'Deriving links…';
    const r = await fetch('/api/linked/manual', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
    const j = await r.json();
    if (!r.ok) { $('lm-out').textContent = j.error || 'Failed'; return; }
    L.research = j; L.f.all = true; $('l-all').checked = true;
    $('lm-out').textContent = `${j.total} links derived for this score (research only).`;
    render();
  };
}

// ---------------------------------------------------------------- drawer
function find(id) { return [...(L.data?.results || []), ...(L.data?.examples || []), ...(L.research?.results || [])].find((b) => b.id === id); }
const RULE = (v) => (v == null ? 'not stated' : typeof v === 'number' ? `$${v.toFixed(2)}` : v === 'fair-price' ? 'last fair market price' : String(v));

function open(id, push = true) {
  const b = find(id);
  if (!b) return;
  L.openId = id;
  window.dispatchEvent(new CustomEvent('iod:linked-focus', { detail: { id } }));
  const r = b.relationship, e = b.econ;
  const sec = (n, t, body) => `<div class="box"><h4><span class="sec-num">${n}</span>${esc(t)}</h4>${body}</div>`;
  const rows = (e?.perScenario || b.rows.map((x) => ({ label: x.label, tail: x.tail, payoutLo: x.lo, payoutHi: x.hi, netLo: null }))).map((x, i) => {
    const row = b.rows[i];
    return `<tr class="${x.tail ? 'tail' : ''}"><td>${esc(x.label)}${row?.witness ? `<div class="muted" style="font-size:11.5px">e.g. final ${esc(Object.values(row.witness).join('–'))}</div>` : ''}${x.tail ? ' <span class="muted">(rare)</span>' : ''}</td>
      ${row.pays.map((p) => `<td class="num">${p[0] === p[1] ? money(p[0] * (e?.qty || 1)) : `${money(p[0] * (e?.qty || 1))}–${money(p[1] * (e?.qty || 1))}`}</td>`).join('')}
      <td class="num"><b>${x.payoutLo === x.payoutHi ? money(x.payoutLo) : `${money(x.payoutLo)}–${money(x.payoutHi)}`}</b></td>
      <td class="num ${x.netLo != null && x.netLo > 0 ? 'good' : 'bad'}">${x.netLo == null ? '—' : money(x.netLo)}</td></tr>`;
  }).join('');
  const checks = (r.compat?.checks || []).map((c) => `<tr><td>${esc(c.field)}</td><td>${esc(c.a ?? '')}</td><td>${esc(c.b ?? '')}</td><td class="${c.result === 'ok' ? 'good' : c.result === 'fail' ? 'bad' : 'warnc'}">${esc(c.result.toUpperCase())}${c.note ? ` · ${esc(c.note)}` : ''}</td></tr>`).join('');
  const legRules = [r.from.contract, r.to.contract].map((c) => `<div class="rule"><div class="bk-h">${esc(c.question)}${c.url ? ` · <a href="${esc(c.url)}" target="_blank" rel="noopener">open market ↗</a>` : ''}</div>
    <div class="muted" style="font-size:12px">Overtime/extra innings: ${esc(RULE(c.rules.overtime))} · Tie: ${esc(RULE(c.rules.tie))} · Postponed: ${esc(RULE(c.rules.voidRule))}</div><pre>${esc(c.rules.text || '')}</pre></div>`).join('');
  const [cls, label] = b.mode === 'example' ? ['research', 'EXAMPLE'] : b.mode === 'research' ? ['research', 'RESEARCH · MANUAL SCORE'] : CLS[b.classification];
  $('drawer').innerHTML = `
    <div class="d-head"><div><span class="pill ${cls}">${label}</span> <span class="pill strat">${esc(RULE_NAME(r.rule))}</span>
      <h2>${esc(r.from.event)} ⇒ ${esc(r.to.event)}</h2><div class="muted" style="font-size:13px">${stateLine(b)}</div></div>
      <button class="btn icon" id="lclose" aria-label="Close"><svg viewBox="0 0 24 24" class="ico"><path d="M6 6l12 12M18 6 6 18"/></svg></button></div>
    <div class="d-body">
      <div class="kpis">
        <div class="kpi"><div class="k">Min net profit</div><div class="v ${e && e.minNet > 0 ? 'good' : 'bad'}">${e ? money(e.minNet) : '—'}</div></div>
        <div class="kpi"><div class="k">ROI</div><div class="v">${e ? pct(e.roi) : '—'}</div></div>
        <div class="kpi"><div class="k">Capital</div><div class="v">${e ? money(e.capital) : '—'}</div></div>
        <div class="kpi"><div class="k">Size</div><div class="v" style="font-size:15px">${b.sizeVerified ? qtyFmt(e?.qty) + ' baskets' : 'unknown'}</div></div>
      </div>
      ${sec('01', 'Why these are linked', `<p>${esc(r.why)}</p><p class="muted">Direction: <b>${esc(r.from.event)}</b> ${r.type === 'equivalence' ? '⇔' : '⇒'} <b>${esc(r.to.event)}</b>. So we buy YES on the consequence and NO on the cause — never the reverse.</p>
        <div class="claude"><button class="btn primary-soft" id="lask">Explain this simply</button></div>`)}
      ${sec('02', 'Exact legs', `<div class="bigbuy">${b.legs.map((l) => `<div class="row"><span class="pill ${l.side}">BUY ${l.side.toUpperCase()}</span><span class="pill venue">${esc(l.venue)}</span><span>${esc(l.label)}<div class="muted" style="font-size:12px">${esc(l.market)}${l.url ? ` · <a href="${esc(l.url)}" target="_blank" rel="noopener">open ↗</a>` : ''}</div></span><span style="text-align:right"><b>${cents(l.ask)}</b><div class="muted" style="font-size:11.5px">${e ? `× ${qtyFmt(e.qty)}` : ''}</div></span></div>`).join('')}</div>
        <div class="kv" style="margin-top:10px"><span>Total cost</span><b>${e ? money(e.cost) : '—'}</b><span>Minimum payout (any outcome)</span><b>${e ? money(e.minPayout) : '—'}</b><span>Fees (rounded up per order)</span><b>${e ? money(e.fees) : '—'}</b><span>Safety buffer</span><b>${e ? money(e.buffer) : '—'}</b><span>Minimum net profit</span><b class="${e && e.minNet > 0 ? 'good' : 'bad'}">${e ? money(e.minNet) : '—'}</b></div>
        <p class="muted" style="font-size:12.5px">${b.sizeVerified ? (b.stop === 'unprofitable' ? 'Size stops where the next price level would no longer pay in every outcome.' : 'Size stops where an order book runs out.') : 'Shown for 1 basket at the top of the book — depth is loaded only for baskets that pay.'}</p>`)}
      ${sec('03', 'Every outcome (proven exhaustive)', `<div class="table-scroll"><table class="legs"><tr><th>Final outcome</th>${b.legs.map((l) => `<th class="num">${esc(l.side.toUpperCase())} ${esc(l.label)}</th>`).join('')}<th class="num">Payout</th><th class="num">Net</th></tr>${rows}</table></div>
        <p class="muted" style="font-size:12.5px">${r.rule === 'score-constraint' ? 'Outcomes are every reachable final score from the current one, grouped by what each market pays. Empty groups are proven impossible by an exact integer solver — no sampling, no maximum score.' : 'Outcomes follow the published competition format.'}</p>`)}
      ${sec('04', 'Execution readiness', `<div class="lchips">${chips(b)}</div><ul class="risks">${b.reasons.map((x) => `<li>${esc(x)}</li>`).join('')}${b.status.settlement.map((x) => `<li>${esc(x)}</li>`).join('')}</ul>`)}
      ${sec('05', 'Assumptions', `<ul class="risks">${r.assumptions.map((x) => `<li>${esc(x)}</li>`).join('')}</ul>`)}
      ${sec('06', 'Rule comparison', `<div class="table-scroll"><table class="legs"><tr><th>Check</th><th>Market A</th><th>Market B</th><th>Result</th></tr>${checks}</table></div><div class="rules-grid" style="margin-top:10px">${legRules}</div>`)}
    </div>`;
  $('lclose').onclick = close;
  $('lask').onclick = () => window.dispatchEvent(new CustomEvent('iod:ask-linked', { detail: { id } }));
  $('scrim').hidden = false;
  requestAnimationFrame(() => { $('scrim').classList.add('on'); $('drawer').classList.add('on'); });
  if (push) { $('drawer').scrollTop = 0; $('drawer').focus(); }
}
function close() {
  if (!L.openId) return;
  L.openId = null;
  $('drawer').classList.remove('on'); $('scrim').classList.remove('on');
  setTimeout(() => { $('scrim').hidden = true; }, 220);
}

// ---------------------------------------------------------------- wiring
$('llist').addEventListener('click', (e) => {
  const x = e.target.closest('[data-lexplain]');
  if (x) { open(x.dataset.lexplain); window.dispatchEvent(new CustomEvent('iod:ask-linked', { detail: { id: x.dataset.lexplain } })); return; }
  const c = e.target.closest('[data-lid]'); if (c) open(c.dataset.lid);
});
$('scrim').addEventListener('click', close);
document.addEventListener('keydown', (e) => { if (e.key === 'Escape') close(); });
$('l-mode').addEventListener('click', (e) => { const b = e.target.closest('button'); if (!b) return; L.mode = b.dataset.mode; render(); });
$('l-refresh').onclick = () => load(true);
$('l-minnet').onchange = (e) => { L.f.minNet = +e.target.value; render(); };
$('l-mincap').onchange = (e) => { L.f.minCap = +e.target.value; render(); };
$('l-kind').onchange = (e) => { L.f.kind = e.target.value; render(); };
$('l-all').onchange = (e) => { L.f.all = e.target.checked; render(); };
window.addEventListener('iod:view', (e) => {
  L.view = e.detail.view;
  clearInterval(L.timer);
  if (L.view === 'linked') { load(); L.timer = setInterval(() => load(), 15000); } // live invalidation: recompute on every refresh
});

// Read-only snapshot for the analyst chat.
window.IOD_LINKED = () => {
  const b = L.openId ? find(L.openId) : null;
  return { mode: L.mode, count: (L.data?.results || []).filter((x) => x.profitable).length, emptyReason: L.data?.emptyReason || null, selected: b || null };
};
load();
if (!$('view-linked').hidden) L.timer = setInterval(() => load(), 15000);
