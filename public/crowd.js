// Crowd Disagreement tab + venue settings (jurisdiction, provider toggles, sports odds key).
// Reads the sports section of /api/scan; writes settings via /api/settings (stored locally in .cache/).
const $ = (id) => document.getElementById(id);
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const pct = (x, d = 1) => (x == null || !isFinite(x) ? '—' : `${(x * 100).toFixed(d)}%`);
const pts = (x) => (x == null || !isFinite(x) ? '—' : `${x > 0 ? '+' : x < 0 ? '−' : ''}${Math.abs(x).toFixed(1)} pts`);
const cents = (x) => (x == null || !isFinite(x) ? '—' : `${(x * 100).toFixed(1).replace(/\.0$/, '')}¢`);
const age = (ms) => (ms == null || !isFinite(ms) ? '—' : ms < 60e3 ? `${Math.max(0, Math.round(ms / 1e3))}s` : ms < 3600e3 ? `${Math.round(ms / 60e3)} min` : `${(ms / 3600e3).toFixed(1)} h`);
const agoIso = (iso) => (iso ? `${age(Date.now() - Date.parse(iso))} ago` : '—');
const SIDE = (r) => (r.side === 'draw' ? 'Draw' : r.side === 'over' || r.side === 'under' ? r.side[0].toUpperCase() + r.side.slice(1) : r.side.toUpperCase());
const MT = { moneyline: 'Game winner', spread: 'Spread', total: 'Total', player_prop: 'Player prop', team_prop: 'Team prop' };
const PERIOD = { game: 'full game incl. OT', '1h': '1st half', '2h': '2nd half', q1: '1st quarter', q2: '2nd quarter', q3: '3rd quarter', q4: '4th quarter' };
const RULE = (v) => (v == null ? 'not stated' : v === 'push' ? 'push (stake refunded)' : typeof v === 'number' ? `settles at $${v.toFixed(2)}` : v === 'fair-price' ? 'last fair price' : v === 'void' ? 'void (refund)' : String(v));

const C = { sports: null, settings: null, openId: null, f: { sport: '', type: '', venue: '', min: 2, fresh: 60 } };

// ---------------------------------------------------------------- settings
async function loadSettings() {
  try {
    const r = await fetch('/api/settings');
    C.settings = await r.json();
    try { C.settings.eligibleOnly = localStorage.getItem('iod-eligible-only') === '1'; } catch { /* ignore */ }
    window.IOD_SETTINGS = C.settings;
    window.dispatchEvent(new CustomEvent('iod:settings'));
    renderJur(); renderFeed();
  } catch { /* server down: arb view shows it */ }
}

async function saveSettings(body) {
  const r = await fetch('/api/settings', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
  const j = await r.json();
  if (!r.ok) throw new Error(j.error || `HTTP ${r.status}`);
  const keep = C.settings?.eligibleOnly;
  C.settings = { ...j, eligibleOnly: keep };
  window.IOD_SETTINGS = C.settings;
  if (j.sports) { C.sports = j.sports; render(); }
  window.dispatchEvent(new CustomEvent('iod:settings'));
  renderJur(); renderFeed();
  return j;
}

function renderJur() {
  const st = C.settings;
  if (!st || !$('jur')) return;
  const opts = Object.entries(st.jurisdictions).map(([k, v]) => `<button data-j="${k}" class="${st.jurisdiction === k ? 'on' : ''}">${esc(v)}</button>`).join('');
  $('jur').innerHTML = `
    <div class="jur-row"><div><b>Your jurisdiction</b><div class="muted">Decides which venues are marked tradable for you. Research data stays visible for every venue.</div></div>
      <div class="seg" id="jur-seg">${opts}<button data-j="" class="${!st.jurisdiction ? 'on' : ''}">Not set</button></div></div>
    <label class="toggle"><input type="checkbox" id="jur-only" ${st.eligibleOnly ? 'checked' : ''} ${st.jurisdiction ? '' : 'disabled'}/><span class="track"><span class="knob"></span></span><span>Hide trades that need a venue not offered where I am</span></label>
    <div class="jur-row" style="margin-top:12px"><div><b>Venues to scan</b><div class="muted">Turning one off removes it from the next scan.</div></div>
      <div class="prov-toggles">${st.providers.map((p) => `<label class="chip-t"><input type="checkbox" data-prov="${esc(p.id)}" ${p.enabled ? 'checked' : ''}/> ${esc(p.name)}</label>`).join('')}</div></div>`;
  $('jur-seg').onclick = async (e) => { const b = e.target.closest('button'); if (b) await saveSettings({ jurisdiction: b.dataset.j || null }); };
  $('jur-only').onchange = (e) => { C.settings.eligibleOnly = e.target.checked; try { localStorage.setItem('iod-eligible-only', e.target.checked ? '1' : '0'); } catch { /* ignore */ } window.dispatchEvent(new CustomEvent('iod:settings')); };
  for (const cb of $('jur').querySelectorAll('[data-prov]')) cb.onchange = async () => {
    const disabled = [...$('jur').querySelectorAll('[data-prov]')].filter((x) => !x.checked).map((x) => x.dataset.prov);
    if (disabled.length === st.providers.length) { cb.checked = true; return; }
    await saveSettings({ disabledProviders: disabled });
    toast('Saved — press Refresh to rescan with these venues');
  };
}

function feedStateHTML(f) {
  const cls = { live: 'live', partial: 'partial', unavailable: 'down', 'needs-setup': 'planned', pending: 'planned' }[f?.state] || 'planned';
  const lbl = { live: 'LIVE', partial: 'PARTIAL', unavailable: 'UNAVAILABLE', 'needs-setup': 'NEEDS SETUP', pending: 'NOT SYNCED' }[f?.state] || '—';
  return `<span class="lv ${cls}">${lbl}</span>`;
}

function renderFeed() {
  const f = C.sports?.feed, st = C.settings;
  if (!$('feedpanel')) return;
  const cfg = f?.config || {};
  const keyRow = st?.odds?.keyFrom === 'env'
    ? `<p class="muted">Key comes from the <code>ODDS_API_KEY</code> environment variable (${esc(st.odds.keyHint)}).</p>`
    : `<form class="keyform" id="keyform"><input id="oddskey" type="password" autocomplete="off" placeholder="${st?.odds?.keySet ? `Saved key ${esc(st.odds.keyHint)} — paste a new one to replace` : 'Paste your free The Odds API key'}"/><button class="btn">Save key</button>${st?.odds?.keySet ? '<button class="btn" type="button" id="keyclear">Remove</button>' : ''}</form>
       <p class="muted" style="font-size:12px">Saved to the project's <code>.env</code> file on this computer — never committed to git. Free plan: 500 credits/month, no card — sign up at the-odds-api.com. The app spends ~1 credit per refresh (every ${cfg.refreshMin || 120} min while open).</p>`;
  $('feedpanel').innerHTML = `
    <div class="feed-h"><div><b>The Odds API</b> ${feedStateHTML(f)}<div class="muted" style="font-size:12.5px;margin-top:4px">${esc(f?.reason || (f?.state === 'live' ? `${f.events} games · ${(f.books || []).length} books` : ''))}</div></div>
      ${f?.state && f.state !== 'needs-setup' ? '<button class="btn" id="feedsync">Sync now</button>' : ''}</div>
    <div class="kv" style="margin:10px 0">
      <span>Sports</span><b>${esc((cfg.sports || []).join(', ') || '—')}</b>
      <span>Markets</span><b>${esc((cfg.markets || []).join(', ') || '—')}${cfg.props ? ' + player props' : ''}</b>
      <span>Books requested</span><b>${esc((cfg.bookmakers || []).join(', '))}</b>
      <span>Books returning prices</span><b>${esc((f?.books || []).join(', ') || '—')}</b>
      <span>Credits left</span><b>${f?.quota ? `${f.quota.remaining} (used ${f.quota.used})` : '—'}</b>
      <span>Last successful sync</span><b>${f?.lastSuccess ? agoIso(f.lastSuccess) : 'never'}</b>
    </div>${keyRow}
    <p class="muted" style="font-size:12px">Caesars is paid-plan only on this feed. PrizePicks/Underdog appear only with player props enabled (ODDS_PROPS=1) and are shown separately — pick'em payouts are not sportsbook odds. Crypto casinos and other books: not integrated yet.</p>`;
  const kf = $('keyform');
  if (kf) kf.onsubmit = async (e) => { e.preventDefault(); const v = $('oddskey').value.trim(); if (!v) return; try { await saveSettings({ oddsApiKey: v }); toast('Key saved — syncing sportsbook odds'); } catch (err) { toast(err.message); } };
  const kc = $('keyclear'); if (kc) kc.onclick = () => saveSettings({ oddsApiKey: '' });
  const fs = $('feedsync'); if (fs) fs.onclick = async () => { fs.disabled = true; try { const r = await fetch('/api/sports?force=1', { method: 'POST' }); C.sports = await r.json(); render(); renderFeed(); } finally { fs.disabled = false; } };
}

// ---------------------------------------------------------------- crowd list
function rowAgeMs(r) {
  const a = r.freshness.targetAgeMs, b = r.freshness.consensusNewestMs;
  return Math.max(a ?? 0, b ?? 0);
}
function visible() {
  const f = C.f;
  return (C.sports?.comparisons || []).filter((r) =>
    (!f.sport || r.league === f.sport) && (!f.type || r.marketType === f.type) && (!f.venue || r.target.venue === f.venue) &&
    (f.min <= 0 || r.edgeAfterFeesPts >= f.min - 1e-9) && (!f.fresh || rowAgeMs(r) <= f.fresh * 60e3));
}
const outcomeText = (r) => `${SIDE(r)}${r.line != null ? ` ${r.marketType === 'spread' ? (r.line > 0 ? '+' : '') : ''}${r.line}` : ''} · ${MT[r.marketType] || r.marketType}${r.period !== 'game' ? ` (${PERIOD[r.period] || r.period})` : ''}`;

function explain(r) {
  const c = r.consensus.probability, b = r.target.buyPrice, n = r.consensus.books.length;
  const venueWord = r.target.kind === 'prediction' ? `this prediction market's buy price` : `${r.target.venueName}'s price`;
  const dir = c > b ? 'worth researching' : 'the other way — this venue prices it higher than the books do';
  return `${n >= 3 ? 'Several' : n === 2 ? 'Two' : 'One'} sportsbook${n === 1 ? '' : 's'} estimate this outcome at about ${Math.round(c * 100)}%, while ${venueWord} is ${Math.round(b * 100)}%. That is a disagreement ${dir}; it does not guarantee profit.`;
}

function card(r) {
  const good = r.edgeAfterFeesPts > 0;
  return `<article class="opp crowd" tabindex="0" data-cid="${esc(r.id)}">
    <div>
      <div class="o-top"><span class="pill strat">${esc(r.league.toUpperCase())} · ${esc(MT[r.marketType] || r.marketType)}</span>
        <span class="pill ${r.match.status === 'VERIFIED' ? 'verified' : 'likely'}">${r.match.status} MATCH</span>
        <span class="pill research">RESEARCH · NOT GUARANTEED</span></div>
      <h3 class="o-title">${esc(r.event.title)}</h3>
      <div class="o-buy"><div class="buyline"><span class="pill venue">${esc(r.target.venueName)}</span><b>${r.target.kind === 'prediction' ? cents(r.target.buyPrice) : r.target.american > 0 ? `+${r.target.american}` : r.target.american}</b><span class="what">${esc(outcomeText(r))}</span></div>
        <div class="buyline muted">vs ${r.consensus.books.map((b) => esc(b.name)).join(', ')}</div></div>
    </div>
    <div class="o-nums">
      <div><div class="k">Consensus</div><div class="v">${pct(r.consensus.probability)}</div></div>
      <div><div class="k">${r.target.kind === 'prediction' ? 'Buy price' : 'Implied'}</div><div class="v">${pct(r.target.buyPrice)}</div></div>
      <div><div class="k">Gap after fees</div><div class="v big ${good ? '' : 'neg'}">${pts(r.edgeAfterFeesPts)}</div></div>
      <div class="pro-only"><div class="k">Raw gap</div><div class="v">${pts(r.disagreementPts)}</div></div>
      <div class="pro-only"><div class="k">Books</div><div class="v">${r.consensus.books.length}</div></div>
      <div><div class="k">Freshness</div><div class="v">${age(rowAgeMs(r))}</div></div>
    </div>
    <div class="o-why">${esc(explain(r))}</div>
  </article>`;
}

function zero(title, text) { return `<div class="zero"><img class="ring" src="/brand/mark-edge.svg" alt=""/><h3>${esc(title)}</h3><p>${text}</p></div>`; }

function render() {
  const sp = C.sports;
  const all = sp?.comparisons || [];
  $('tab-crowd-n').textContent = sp ? all.length : '';
  const f = sp?.feed;
  $('c-feed').innerHTML = f ? feedStateHTML(f) : '—';
  $('c-feed-sub').textContent = f?.state === 'live' ? `${(f.books || []).length} books · ${agoIso(f.lastSuccess)}` : f?.state === 'needs-setup' ? 'free key needed' : f?.reason || '';
  // selects
  const fill = (id, vals, label, cur) => { const el = $(id); el.innerHTML = `<option value="">${label}</option>` + vals.map(([v, t]) => `<option value="${esc(v)}">${esc(t)}</option>`).join(''); el.value = vals.some(([v]) => v === cur) ? cur : ''; };
  fill('c-sport', [...new Set(all.map((r) => r.league))].map((l) => [l, l.toUpperCase()]), 'All sports', C.f.sport);
  fill('c-venue', [...new Map(all.map((r) => [r.target.venue, r.target.venueName])).entries()], 'All venues', C.f.venue);
  const rows = visible();
  $('c-count').textContent = sp ? rows.length.toLocaleString() : '—';
  $('c-count-sub').textContent = sp ? `${all.length} comparable · ${sp.counts?.games ?? 0} games` : 'waiting for scan';
  const top = rows[0];
  $('c-max').textContent = top ? pts(top.edgeAfterFeesPts) : '—';
  $('c-max-sub').textContent = top ? `${top.target.venueName} · ${top.event.title}` : 'nothing qualifies';
  $('c-baskets').textContent = sp ? String((sp.baskets || []).filter((b) => b.structural).length) : '—';

  // setup / empty states
  const setup = $('c-setup');
  if (f?.state === 'needs-setup') {
    setup.hidden = false;
    setup.innerHTML = `<div class="setup"><div><b>Needs setup: sportsbook odds</b><p class="muted">Crowd Disagreement compares prediction-market prices with DraftKings, FanDuel, BetMGM and Pinnacle. That data needs a free key from The Odds API (500 credits/month, no card). Nothing is shown until real odds arrive — no sample data.</p>
      <p class="muted">Already loaded: ${sp?.counts?.predictionQuotes ?? 0} NFL game-winner quotes from Polymarket US, Polymarket and Kalshi.</p></div>
      <button class="btn primary" id="c-gosetup">Add key in Venues</button></div>`;
    $('c-gosetup').onclick = () => document.querySelector('.tab[data-view="providers"]').click();
  } else if (f && (f.state === 'unavailable' || f.state === 'partial')) {
    setup.hidden = false;
    setup.innerHTML = `<div class="setup"><div><b>Sportsbook feed: ${esc(f.state)}</b><p class="muted">${esc(f.reason || f.error || '')}</p></div></div>`;
  } else setup.hidden = true;

  if (!sp) $('clist').innerHTML = zero('Waiting for the first scan', 'Prediction-market prices load with the main scan.');
  else if (!rows.length) {
    $('clist').innerHTML = f?.state === 'needs-setup'
      ? zero('No comparisons yet', 'Add a sportsbook odds key to compare against an estimated consensus.')
      : all.length ? zero('Nothing passes these filters', `${all.length} comparable quotes exist — lower the minimum disagreement or widen freshness.`)
        : zero('No comparable quotes right now', `Comparisons need the same game, period, line and side on a prediction market and on 2+ fresh sportsbooks. ${sp.skippedSingleSide ? `${sp.skippedSingleSide} book prices were skipped because the opposite side was missing.` : ''}`);
  } else $('clist').innerHTML = rows.slice(0, 200).map(card).join('');
  $('cfoot').textContent = sp ? `${rows.length} shown · ${sp.counts?.bookQuotes ?? 0} sportsbook prices · ${sp.counts?.predictionQuotes ?? 0} prediction-market quotes · computed ${agoIso(sp.computedAt)}` : '';

  const bs = sp?.baskets || [];
  $('c-basket-panel').hidden = !bs.length;
  $('c-baskets-list').innerHTML = bs.slice(0, 30).map((b) => `<div class="basket"><div><b>${esc(b.event.title)}</b> <span class="pill ${b.structural ? 'near' : 'likely'}">${b.structural ? 'STRUCTURAL' : 'NEAR'} · EXECUTION UNVERIFIED</span>
      <div class="muted" style="font-size:12.5px">${b.legs.map((l) => `${esc(l.venue)} ${esc(l.side.toUpperCase())} ${l.price.decimal ? `@ ${l.price.decimal.toFixed(2)}` : `@ ${cents(l.price.ask)}`} (stake ${cents(l.stakeFor1)} per $1 payout)`).join(' + ')}</div>
      <div class="muted" style="font-size:12px">${b.states.map((s) => `${esc(s.label)}: $${s.lo.toFixed(3)}`).join(' · ')} · cost $${b.costPer1.toFixed(3)} · ${esc(b.why.join(' '))}</div></div>
      <div class="v ${b.net > 0 ? 'good' : 'bad'}">${(b.net * 100).toFixed(2)}%</div></div>`).join('');
  if (C.openId) open(C.openId, false);
}

// ---------------------------------------------------------------- detail sheet
function open(id, push = true) {
  const r = (C.sports?.comparisons || []).find((x) => x.id === id);
  if (!r) return;
  C.openId = id;
  window.dispatchEvent(new CustomEvent('iod:crowd-focus', { detail: { id } }));
  const sec = (n, t, body) => `<div class="box"><h4><span class="sec-num">${n}</span>${esc(t)}</h4>${body}</div>`;
  const books = r.consensus.books.map((b) => `<tr><td>${b.url ? `<a href="${esc(b.url)}" target="_blank" rel="noopener">${esc(b.name)} ↗</a>` : esc(b.name)}</td><td class="num">${b.decimal.toFixed(2)}</td><td class="num">${pct(b.implied)}</td><td class="num">${pct(b.margin)}</td><td class="num"><b>${pct(b.fair)}</b></td><td class="num">${b.weight.toFixed(2)}</td><td class="num">${age(b.ageMs)}</td></tr>`).join('');
  const excl = r.consensus.excluded.length ? `<p class="muted" style="font-size:12.5px">Left out: ${r.consensus.excluded.map((x) => `${esc(x.name)} (${esc(x.why)})`).join(', ')}.</p>` : '';
  const T = r.target;
  const checks = r.match.perBook.map((m) => `<h5 style="margin:10px 0 4px">${esc(T.venueName)} vs ${esc(m.book)} — ${m.status}</h5><table class="legs"><tr><th>Field</th><th>${esc(T.venueName)}</th><th>${esc(m.book)}</th><th>Result</th></tr>${m.checks.map((c) => `<tr><td>${esc(c.field)}</td><td>${esc(c.a ?? '')}</td><td>${esc(c.b ?? '')}</td><td class="${c.result === 'ok' ? 'good' : c.result === 'warn' ? 'warnc' : 'bad'}">${c.result.toUpperCase()}${c.note ? ` · ${esc(c.note)}` : ''}</td></tr>`).join('')}</table>`).slice(0, 2).join('');
  const sumW = r.consensus.books.reduce((s, b) => s + b.weight, 0);
  $('drawer').innerHTML = `
    <div class="d-head"><div><span class="pill research">CROWD DISAGREEMENT · RESEARCH</span> <span class="pill ${r.match.status === 'VERIFIED' ? 'verified' : 'likely'}">${r.match.status} MATCH</span>
      <h2>${esc(r.event.title)}</h2><div class="muted" style="font-size:13px">${esc(outcomeText(r))}${r.event.start ? ` · starts ${esc(new Date(r.event.start).toLocaleString())}` : ''}</div></div>
      <button class="btn icon" id="cclose" aria-label="Close"><svg viewBox="0 0 24 24" class="ico"><path d="M6 6l12 12M18 6 6 18"/></svg></button></div>
    <div class="d-body">
      <div class="kpis">
        <div class="kpi"><div class="k">Estimated consensus</div><div class="v">${pct(r.consensus.probability)}</div></div>
        <div class="kpi"><div class="k">${esc(T.venueName)} ${T.kind === 'prediction' ? 'buy price' : 'implied'}</div><div class="v">${pct(T.buyPrice)}</div></div>
        <div class="kpi"><div class="k">Gap after fees</div><div class="v ${r.edgeAfterFeesPts > 0 ? 'good' : 'bad'}">${pts(r.edgeAfterFeesPts)}</div></div>
        <div class="kpi"><div class="k">Freshness</div><div class="v" style="font-size:15px">${age(rowAgeMs(r))}</div></div>
      </div>
      ${sec('01', 'In plain words', `<p>${esc(explain(r))}</p><p class="muted">A sportsbook price includes its margin, so we first remove it (using both sides of the same bet), then average books with weights that fall as quotes age. This is an <b>estimated consensus probability</b> — the crowd's view, not the truth.</p>
        <div class="claude" style="margin-top:8px"><button class="btn primary-soft" id="cask">Ask the analyst about this</button></div>`)}
      ${sec('02', 'Source odds', `<div class="table-scroll"><table class="legs"><tr><th>Book</th><th class="num">Decimal</th><th class="num">Implied</th><th class="num">Book margin</th><th class="num">No-vig</th><th class="num">Weight</th><th class="num">Age</th></tr>${books}</table></div>${excl}`)}
      ${sec('03', 'Calculation', `<div class="kv">
          <span>Method</span><b>${esc(r.consensus.method)}</b>
          <span>Per book</span><b>no-vig = (1/odds) ÷ Σ(1/odds of every outcome)</b>
          <span>Weights</span><b>1.0 if ≤ 10 min old, falling to 0 at 60 min</b>
          <span>Consensus</span><b>Σ(weight × no-vig) ÷ ${sumW.toFixed(2)} = ${pct(r.consensus.probability, 2)}</b>
          <span>${esc(T.venueName)} price</span><b>${T.kind === 'prediction' ? `ask ${cents(T.ask)} + fee ${cents(T.feePerShare)} = ${cents(T.allInPrice)} all-in` : `odds ${T.decimal?.toFixed(2)} → ${pct(T.buyPrice, 2)} implied (margin included)`}</b>
          <span>Raw gap</span><b>${pts(r.disagreementPts)}</b>
          <span>Gap after fees</span><b>${pts(r.edgeAfterFeesPts)}</b></div>
        <p class="muted" style="font-size:12.5px">${esc(T.venueName)} is excluded from its own reference consensus. Books that share a pricing feed count once.</p>`)}
      ${sec('04', 'Settlement differences', `<div class="kv">
          <span>${esc(T.venueName)} · overtime</span><b>${esc(RULE(T.rules?.overtime))}</b>
          <span>${esc(T.venueName)} · tie</span><b>${esc(RULE(T.rules?.tie))}</b>
          <span>${esc(T.venueName)} · postponed/canceled</span><b>${esc(RULE(T.rules?.cancellation))}</b>
          <span>Sportsbooks</span><b>standard house rules assumed (feed has no rule text): OT included, tie = push, canceled = void</b></div>
        ${checks}${T.rules?.text ? `<pre class="rules-pre">${esc(T.rules.text)}</pre>` : ''}`)}
      ${sec('05', 'Links', `<p>${T.url ? `<a href="${esc(T.url)}" target="_blank" rel="noopener">Open on ${esc(T.venueName)} ↗</a>` : ''} ${r.consensus.books.filter((b) => b.url).map((b) => `· <a href="${esc(b.url)}" target="_blank" rel="noopener">${esc(b.name)} ↗</a>`).join(' ')}</p>
        <p class="muted" style="font-size:12.5px">Not guaranteed arbitrage: a disagreement can persist or move against you, and nothing here locks in a profit.</p>`)}
    </div>`;
  $('cclose').onclick = close;
  $('cask').onclick = () => window.dispatchEvent(new CustomEvent('iod:ask-crowd', { detail: { id } }));
  $('scrim').hidden = false;
  requestAnimationFrame(() => { $('scrim').classList.add('on'); $('drawer').classList.add('on'); });
  $('drawer').setAttribute('aria-hidden', 'false');
  if (push) { $('drawer').scrollTop = 0; $('drawer').focus(); }
}
function close() {
  if (!C.openId) return;
  C.openId = null;
  $('drawer').classList.remove('on'); $('scrim').classList.remove('on'); $('drawer').setAttribute('aria-hidden', 'true');
  setTimeout(() => { $('scrim').hidden = true; }, 220);
}

function toast(msg) { const t = $('toast'); t.textContent = msg; t.hidden = false; clearTimeout(toast.t); toast.t = setTimeout(() => { t.hidden = true; }, 2600); }

// ---------------------------------------------------------------- wiring
$('clist').addEventListener('click', (e) => { const c = e.target.closest('[data-cid]'); if (c) open(c.dataset.cid); });
$('clist').addEventListener('keydown', (e) => { if (e.key === 'Enter') { const c = e.target.closest('[data-cid]'); if (c) open(c.dataset.cid); } });
$('scrim').addEventListener('click', close);
document.addEventListener('keydown', (e) => { if (e.key === 'Escape') close(); });
for (const [id, k, conv] of [['c-sport', 'sport', String], ['c-type', 'type', String], ['c-venue', 'venue', String], ['c-fresh', 'fresh', Number]])
  $(id).addEventListener('change', (e) => { C.f[k] = conv(e.target.value); render(); });
$('c-min').addEventListener('input', (e) => { C.f.min = +e.target.value; $('c-min-val').textContent = `${C.f.min} pts`; render(); });
window.addEventListener('iod:data', (e) => { C.sports = e.detail.sports || null; render(); renderFeed(); });

// Read-only snapshot for the analyst chat.
window.IOD_CROWD = () => {
  const r = C.openId && (C.sports?.comparisons || []).find((x) => x.id === C.openId);
  return { feed: C.sports?.feed ? { state: C.sports.feed.state, reason: C.sports.feed.reason, books: C.sports.feed.books || [] } : null,
    count: C.sports?.comparisons?.length ?? 0, visible: visible().slice(0, 6), filters: { ...C.f }, selected: r || null, explanation: r ? explain(r) : null };
};

loadSettings();
