import { pct, pts, cents, marketTitle, TYPE_META, columns, explain, liveEdge } from '/src/engine/explain.js';

// ---------- state ----------
const DEFAULTS = { q: '', type: 'all', minv: 1, minc: 60, cat: '', liq: 0, exec: false };
const state = {
  data: null,
  rows: [],
  filters: { ...DEFAULTS },
  sort: { key: 'score', dir: -1 },
  limit: 150,
  loading: false,
};
const $ = (id) => document.getElementById(id);
const VENUE = { polymarket: 'Polymarket', 'polymarket-us': 'Polymarket US', kalshi: 'Kalshi', predictit: 'PredictIt', limitless: 'Limitless', manifold: 'Manifold' };
const venueOf = (m) => VENUE[m?.provider] || 'the venue';
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const fmtInt = (n) => (n == null ? '—' : n >= 1e6 ? (n / 1e6).toFixed(1) + 'M' : n >= 1e4 ? Math.round(n / 1e3) + 'k' : n.toLocaleString());
const money = (n) => (n == null ? '—' : n >= 1e6 ? '$' + (n / 1e6).toFixed(1) + 'M' : n >= 1e3 ? '$' + (n / 1e3).toFixed(n >= 1e4 ? 0 : 1) + 'k' : '$' + Math.round(n));
const ago = (iso) => {
  const s = Math.max(0, (Date.now() - Date.parse(iso)) / 1000);
  return s < 60 ? 'just now' : s < 3600 ? `${Math.round(s / 60)} min ago` : `${Math.round(s / 3600)} h ago`;
};
const typeGroup = (t) => (t === 'exclusive-set' ? 'exclusive' : t);

// ---------- data loading ----------
async function getJSON(url) {
  const r = await fetch(url, { headers: { accept: 'application/json' } });
  let body = null;
  try { body = await r.json(); } catch { /* not json */ }
  if (!r.ok) throw new Error((body && body.error) || `HTTP ${r.status}`);
  return body;
}

let pollTimer = null;
function startProgressPolling() {
  stopProgressPolling();
  $('progress').hidden = false;
  const tick = async () => {
    try {
      const s = await getJSON('/api/status');
      const p = s.progress;
      if (p) {
        const frac = p.phase === 'analyzing' ? 0.96 : Math.min(0.92, (p.events || 0) / (p.target || s.maxEvents || 4000));
        $('progress-bar').style.width = `${Math.max(4, frac * 100)}%`;
        setStatus('busy', p.phase === 'analyzing' ? `Matching & analyzing ${fmtInt(p.markets)} markets…`
          : p.phase === 'order books' ? 'Walking order books for candidates…'
          : `Syncing venues · ${fmtInt(p.markets || 0)} markets`);
      }
    } catch { /* server busy */ }
  };
  tick();
  pollTimer = setInterval(tick, 700);
}
function stopProgressPolling() {
  clearInterval(pollTimer);
  $('progress-bar').style.width = '100%';
  setTimeout(() => { $('progress').hidden = true; $('progress-bar').style.width = '0'; }, 350);
}

async function load(refresh = false) {
  if (state.loading) return;
  state.loading = true;
  const btn = $('refresh');
  btn.disabled = true; btn.classList.add('spinning');
  if (!state.data) renderSkeleton();
  setStatus('busy', refresh ? 'Rescanning markets…' : 'Loading…');
  const slow = setTimeout(startProgressPolling, 250);
  try {
    const data = await getJSON('/api/scan' + (refresh ? '?refresh=1' : ''));
    state.data = prepare(data);
    populateCategories();
    render();
    window.dispatchEvent(new CustomEvent('iod:data', { detail: data }));
    if (data.stale) setStatus('err', `Showing cached scan from ${ago(data.scannedAt)} — refresh failed: ${data.error}`);
    else setLiveStatus();
    openFromHash();
  } catch (err) {
    setStatus('err', 'Scan failed');
    window.dispatchEvent(new CustomEvent('iod:error', { detail: err.message }));
    if (!state.data) renderError(err.message);
    else toastError(err.message);
  } finally {
    clearTimeout(slow);
    stopProgressPolling();
    state.loading = false;
    btn.disabled = false; btn.classList.remove('spinning');
  }
}

function prepare(data) {
  const M = data.markets;
  for (const v of data.violations) {
    const cols = columns(v, M);
    v._cols = cols;
    v.pLeft = cols.left.p; v.pRight = cols.right.p;
    const legs = v.legs.map((id) => M[id]).filter(Boolean);
    v._hay = [v.event?.title, ...legs.flatMap((m) => [m.question, m.label, m.eventTitle, m.yesOutcome])]
      .filter(Boolean).join(' \u0001 ').toLowerCase();
  }
  return data;
}

// ---------- status ----------
function setStatus(kind, text) {
  const el = $('status');
  el.className = 'status ' + (kind || '');
  $('status-text').textContent = text;
  el.title = text;
}
function setLiveStatus() {
  const d = state.data;
  if (!d) return;
  const pv = d.arb?.perVenue ? Object.values(d.arb.perVenue).filter((v) => v.status === 'live' && !v.failed).length : 0;
  setStatus(d.partial ? 'err' : 'live', `${pv || ''} live venues · scanned ${ago(d.scannedAt)}${d.partial ? ' (partial)' : ''}`);
}
setInterval(() => { if (!state.loading && state.data && !$('status').classList.contains('err')) setLiveStatus(); }, 30000);

function toastError(msg) {
  setStatus('err', `Refresh failed: ${msg}`);
}

// ---------- filtering / sorting ----------
function filtered() {
  const f = state.filters;
  const q = f.q.trim().toLowerCase();
  const terms = q ? q.split(/\s+/) : [];
  const out = state.data.violations.filter((v) =>
    (f.type === 'all' || typeGroup(v.type) === f.type) &&
    v.magnitude * 100 >= f.minv - 1e-9 &&
    v.confidence * 100 >= f.minc - 1e-9 &&
    (!f.cat || v.category === f.cat) &&
    (v.minLiquidity || 0) >= f.liq &&
    (!f.exec || v.executable) &&
    (!terms.length || terms.every((t) => v._hay.includes(t))));
  const { key, dir } = state.sort;
  const val = (v) => (key === 'type' ? v.type : v[key] ?? -Infinity);
  out.sort((a, b) => {
    const x = val(a), y = val(b);
    if (x === y) return b.score - a.score;
    return (x > y ? 1 : -1) * dir;
  });
  return out;
}

function typeCounts() {
  const f = { ...state.filters, type: 'all' };
  const c = { all: 0, implication: 0, exclusive: 0, exhaustive: 0, equivalent: 0 };
  const q = f.q.trim().toLowerCase(), terms = q ? q.split(/\s+/) : [];
  for (const v of state.data.violations) {
    if (v.magnitude * 100 < f.minv - 1e-9 || v.confidence * 100 < f.minc - 1e-9 || (f.cat && v.category !== f.cat) ||
      (v.minLiquidity || 0) < f.liq || (f.exec && !v.executable) || (terms.length && !terms.every((t) => v._hay.includes(t)))) continue;
    c.all++; c[typeGroup(v.type)]++;
  }
  return c;
}

// ---------- rendering ----------
function render() {
  const d = state.data;
  if (!d) return;
  const rows = filtered();
  state.rows = rows;

  // summary cards
  $('c-markets').textContent = fmtInt(d.stats.markets);
  $('c-markets-sub').textContent = `${fmtInt(d.stats.events)} events · all connected venues`;
  $('c-rels').textContent = fmtInt(d.stats.relationships);
  const bd = d.stats.byDetector || {};
  $('c-rels-sub').textContent = `${fmtInt(bd.ladder || 0)} ladders · ${fmtInt(bd['outcome-set'] || 0)} sets · ${fmtInt((bd.hierarchy || 0) + (bd.equivalence || 0))} cross-event`;
  $('c-viol').textContent = rows.length.toLocaleString();
  const ex = rows.filter((v) => v.executable).length;
  $('c-viol-sub').textContent = `${ex} executable · ${d.violations.length.toLocaleString()} before filters`;
  const largest = rows.reduce((b, v) => (!b || v.magnitude > b.magnitude ? v : b), null);
  $('c-largest').textContent = largest ? pts(largest.magnitude) : '—';
  $('c-largest-sub').textContent = largest ? titleOf(largest) : 'No violations under current filters';

  // type counts
  const counts = typeCounts();
  for (const b of document.querySelectorAll('#types button')) {
    const t = b.dataset.type;
    b.innerHTML = `${esc(b.textContent.replace(/\s*\d[\d,]*$/, ''))}<span class="n">${counts[t].toLocaleString()}</span>`;
  }

  // header sort arrows
  for (const th of document.querySelectorAll('.grid th[data-sort]')) {
    const on = th.dataset.sort === state.sort.key;
    th.querySelector('.arrow')?.remove();
    if (on) th.insertAdjacentHTML('beforeend', `<span class="arrow">${state.sort.dir < 0 ? '↓' : '↑'}</span>`);
    th.setAttribute('aria-sort', on ? (state.sort.dir < 0 ? 'descending' : 'ascending') : 'none');
  }

  const tbody = $('rows');
  const shown = rows.slice(0, state.limit);
  tbody.innerHTML = shown.map(rowHTML).join('');
  if (rows.length > state.limit) {
    tbody.insertAdjacentHTML('beforeend', `<tr class="more"><td colspan="8" style="text-align:center"><button class="btn" id="more">Show ${Math.min(150, rows.length - state.limit)} more of ${rows.length - state.limit}</button></td></tr>`);
    $('more').onclick = (e) => { e.stopPropagation(); state.limit += 150; render(); };
  }
  const empty = $('empty');
  if (!rows.length) {
    empty.hidden = false;
    empty.innerHTML = d.violations.length
      ? `<h3>No contradictions match these filters</h3><p>Try lowering the minimum discrepancy or confidence.</p><button class="btn" id="empty-reset">Reset filters</button>`
      : `<h3>No contradictions right now</h3><p>Every related contract we checked is priced consistently. Markets move fast, so rescan in a few minutes.</p>`;
    $('empty-reset')?.addEventListener('click', resetFilters);
  } else empty.hidden = true;

  $('foot-left').textContent = `Showing ${Math.min(rows.length, state.limit).toLocaleString()} of ${rows.length.toLocaleString()} · data fetched ${ago(d.fetchedAt)} · scan ${((d.stats.fetchMs || 0) / 1000).toFixed(1)}s`;
}

function titleOf(v) {
  const M = state.data.markets;
  if (v.legs.length > 2 || v.type === 'exhaustive' || v.type === 'exclusive-set') return v.event?.title || 'Outcome set';
  const c = v._cols;
  return `${marketTitle(c.left.m)}  vs  ${marketTitle(c.right.m)}`;
}

function cellMarket(side) {
  if (side.kind === 'market') {
    const m = side.m;
    return `<div class="mkt"><div class="q" title="${esc(marketTitle(m))}">${esc(marketTitle(m))}</div><div class="s">${esc(m.eventTitle)}</div></div>`;
  }
  return `<div class="mkt"><div class="q ${side.kind === 'target' ? 'target' : ''}">${esc(side.title)}</div><div class="s">${esc(side.sub)}</div></div>`;
}
function cellProb(side, hot) {
  if (side.kind === 'market') {
    const m = side.m;
    const ba = m.bid != null || m.ask != null ? `${m.bid != null ? (m.bid * 100).toFixed(1) : '–'} / ${m.ask != null ? (m.ask * 100).toFixed(1) : '–'}` : 'no book';
    return `<span class="prob ${hot ? 'hi' : ''}">${pct(side.p)}<span class="ba">${ba}</span></span>`;
  }
  return `<span class="prob ${hot ? 'hi' : ''}">${pct(side.p)}</span>`;
}

function rowHTML(v) {
  const meta = TYPE_META[v.type];
  const c = v._cols;
  const hotLeft = v.type === 'equivalent' || v.type === 'exclusive' || v.type === 'exhaustive' || v.type === 'exclusive-set';
  const hotRight = v.type === 'implication' || v.type === 'exclusive';
  const SUBS = { threshold: 'stricter threshold', deadline: 'earlier deadline', stage: 'later stage', nomination: 'needs nomination',
    party: 'needs party win', ballot: 'needs ballot spot', identical: 'identical rules', 'same-wording': 'same wording', nominee: 'same person', place: 'same entity' };
  const sub = v.type === 'exclusive-set' || v.type === 'exhaustive' ? `${v.legs.length} outcomes` : SUBS[v.subtype] || '';
  const confCls = v.confidence >= 0.8 ? 'high' : v.confidence >= 0.6 ? 'mid' : '';
  return `<tr tabindex="0" data-id="${esc(v.id)}">
    <td class="num c-viol"><span class="viol"><span class="v">${pts(v.magnitude)}</span><span class="l">violation</span></span></td>
    <td class="c-a">${cellMarket(c.left)}</td>
    <td class="num c-pa">${cellProb(c.left, hotLeft)}</td>
    <td class="rel c-rel"><span class="chip ${v.type}"><span class="g">${meta.glyph}</span>${meta.verb}</span>${sub ? `<span class="sub">${esc(sub)}</span>` : ''}</td>
    <td class="c-b">${cellMarket(c.right)}</td>
    <td class="num c-pb">${cellProb(c.right, hotRight)}</td>
    <td class="num c-edge"><span class="edge ${v.executable ? 'pos' : 'neg'}">${v.executable ? cents(v.edge) : 'in spread'}<small>${v.executable ? roiText(v.roi) : cents(v.edge)}</small></span></td>
    <td class="num c-conf"><span class="conf ${confCls}"><span class="meter"><i style="width:${Math.round(v.confidence * 100)}%"></i></span>${Math.round(v.confidence * 100)}%</span></td>
  </tr>`;
}

function roiText(roi) {
  if (roi == null) return 'per $1';
  const r = roi * 100;
  return `${r >= 1 ? r.toFixed(1) : r.toFixed(2)}% return`;
}

function renderSkeleton() {
  const tb = $('rows');
  const cell = (w) => `<td><div class="bar" style="width:${w}%"></div></td>`;
  tb.innerHTML = Array.from({ length: 8 }, () => `<tr class="sk">${cell(60)}${cell(90)}${cell(50)}${cell(70)}${cell(90)}${cell(50)}${cell(50)}${cell(70)}</tr>`).join('');
  $('empty').hidden = true;
  $('foot-left').textContent = 'First scan pulls every connected venue (~200k markets, about 40–90 s). Results are cached for 5 minutes.';
}

function renderError(msg) {
  $('rows').innerHTML = '';
  const e = $('empty');
  e.hidden = false;
  e.innerHTML = `<h3>Couldn't load market data</h3><p>${esc(msg)}</p><button class="btn primary" id="retry">Try again</button>`;
  $('retry').onclick = () => load(true);
}

function populateCategories() {
  const sel = $('cat');
  const cur = state.filters.cat;
  const counts = {};
  for (const v of state.data.violations) counts[v.category] = (counts[v.category] || 0) + 1;
  const cats = Object.keys(counts).sort((a, b) => counts[b] - counts[a]);
  sel.innerHTML = `<option value="">All categories</option>` + cats.map((c) => `<option value="${esc(c)}">${esc(c)} (${counts[c]})</option>`).join('');
  sel.value = cats.includes(cur) ? cur : '';
}

// ---------- detail drawer ----------
function openDetail(id, push = true) {
  const v = state.data?.violations.find((x) => x.id === id);
  if (!v) return;
  state.openId = id;
  const M = state.data.markets;
  const meta = TYPE_META[v.type];
  const ex = explain(v, M);
  const isSet = v.type === 'exhaustive' || v.type === 'exclusive-set';
  const c = v._cols;

  const contract = (m, tag) => `
    <div class="contract" data-mid="${esc(m.id)}">
      <div>
        <div class="tag">${esc(tag)}</div>
        <div class="q">${esc(marketTitle(m))}</div>
        <div class="meta"><b>${esc(venueOf(m))}</b> · ${esc(m.eventTitle)} · liquidity ${money(m.liquidity)} · volume ${money(m.volume)}${m.endDate ? ' · ends ' + esc(m.endDate.slice(0, 10)) : ''}</div>
        <a class="out" href="${esc(m.url)}" target="_blank" rel="noopener">Open on ${esc(venueOf(m))} ↗</a>
        <div class="live-leg muted" style="font-size:12px;margin-top:4px"></div>
      </div>
      <div class="p">${pct(m.price)}<small>bid ${m.bid != null ? pct(m.bid) : '–'} · ask ${m.ask != null ? pct(m.ask) : '–'}</small></div>
    </div>`;

  let contracts;
  if (isSet) {
    const legs = v.legs.map((id) => M[id]).filter(Boolean).sort((a, b) => b.price - a.price);
    contracts = `<div class="box"><h4>The ${legs.length} outcomes</h4>
      <table class="legs"><thead><tr><th>Outcome</th><th class="num">Price</th><th class="num">Bid</th><th class="num">Ask</th><th class="num">Liquidity</th></tr></thead><tbody>
      ${legs.map((m) => `<tr data-mid="${esc(m.id)}"><td><a href="${esc(m.url)}" target="_blank" rel="noopener">${esc(m.label || m.question)}</a></td><td class="num">${pct(m.price)}</td><td class="num lb">${m.bid != null ? pct(m.bid) : '–'}</td><td class="num la">${m.ask != null ? pct(m.ask) : '–'}</td><td class="num">${money(m.liquidity)}</td></tr>`).join('')}
      <tr><td><b>Sum</b></td><td class="num"><b>${pct(v.sum)}</b></td><td class="num">${pct(v.legs.reduce((s, id) => s + (M[id]?.bid ?? 0), 0))}</td><td class="num">${pct(v.legs.reduce((s, id) => s + (M[id]?.ask ?? 1), 0))}</td><td></td></tr>
      </tbody></table>
      ${v.event ? `<a class="out" style="display:inline-block;margin-top:10px;color:var(--info);text-decoration:none;font-size:12px" href="${esc(v.event.url)}" target="_blank" rel="noopener">Open event on ${esc([...new Set(legs.map(venueOf))].join(' / '))} ↗</a>` : ''}</div>`;
  } else {
    const leftTag = v.type === 'implication' ? 'Contract B · the necessary condition' : 'Contract A';
    const rightTag = v.type === 'implication' ? 'Contract A · requires B' : 'Contract B';
    contracts = `<div class="box"><h4>What each contract says</h4>
      ${contract(c.left.m, leftTag)}
      <div class="connector"><span class="chip ${v.type}"><span class="g">${meta.glyph}</span>${meta.verb}</span></div>
      ${contract(c.right.m, rightTag)}
      <details class="rules" id="rules"><summary>Resolution rules</summary><pre>Loading…</pre></details>
    </div>`;
  }

  const f = v.factors || {};
  const factorRow = (k, val, note) => `<span>${k}</span><span class="meter"><i style="width:${Math.round(val * 100)}%"></i></span><span class="val">${Math.round(val * 100)}%${note ? ' · ' + note : ''}</span>`;

  $('drawer').innerHTML = `
    <div class="d-head">
      <div>
        <span class="chip ${v.type}"><span class="g">${meta.glyph}</span>${esc(meta.label.toUpperCase())}</span>
        <h2>${esc(ex.headline)}</h2>
      </div>
      <button class="btn icon" id="close" aria-label="Close"><svg viewBox="0 0 24 24" class="ico"><path d="M6 6l12 12M18 6 6 18"/></svg></button>
    </div>
    <div class="d-body">
      <div class="kpis">
        <div class="kpi"><div class="k">Violation</div><div class="v bad">${pts(v.magnitude)}</div></div>
        <div class="kpi"><div class="k">Executable edge</div><div class="v ${v.executable ? 'good' : ''}" id="edge-kpi">${cents(v.edge)}</div></div>
        <div class="kpi"><div class="k">Return on capital</div><div class="v ${v.executable ? 'good' : ''}">${v.executable ? roiText(v.roi).replace(' return', '') : '—'}</div></div>
        <div class="kpi"><div class="k">Confidence</div><div class="v">${Math.round(v.confidence * 100)}%</div></div>
      </div>
      ${contracts}
      <div class="box"><h4>Logical relationship</h4><p>${esc(ex.relationship)}</p></div>
      <div class="box"><h4>Why the prices are inconsistent</h4><p>${esc(ex.why)}</p></div>
      <div class="box"><h4>Size of the discrepancy</h4><p>${esc(ex.size)}</p><p><b>How it would be traded:</b> ${esc(ex.trade)}</p>
        ${v.ladderPeers ? `<p class="muted">${v.ladderPeers} more pair${v.ladderPeers > 1 ? 's' : ''} in this ladder also violate the ordering; only the strongest two are listed.</p>` : ''}
      </div>
      <div class="box"><h4>Verify against live order books</h4>
        <div class="live"><button class="btn" id="verify">Check live prices</button><span class="live-out" id="live-out">Pulls the current best bid/ask for every leg from each venue's order book.</span></div>
      </div>
      <div class="box"><h4>Confidence breakdown</h4>
        <div class="factors">
          ${factorRow('Relationship is correct', f.relationship ?? v.relConfidence, v.detector)}
          ${factorRow('Survives the spread', f.execution ?? 1, v.executable ? 'executable' : 'within spread')}
          ${factorRow('Liquidity', f.liquidity ?? 1, money(v.minLiquidity) + ' thinnest')}
          ${factorRow('Quote quality', (f.spread ?? 1) * (f.freshness ?? 1), (v.maxSpread * 100).toFixed(1) + '¢ max spread' + (v.stale ? ', stale' : ''))}
          ${f.assumption != null && f.assumption < 1 ? factorRow('Exhaustiveness assumption', f.assumption, 'set may allow all-NO') : ''}
        </div>
      </div>
    </div>`;

  $('close').onclick = closeDetail;
  $('verify').onclick = () => verifyLive(v);
  const rules = $('rules');
  if (rules) rules.addEventListener('toggle', () => loadRules(v, rules), { once: true });

  $('scrim').hidden = false;
  requestAnimationFrame(() => { $('scrim').classList.add('on'); $('drawer').classList.add('on'); });
  $('drawer').setAttribute('aria-hidden', 'false');
  $('drawer').scrollTop = 0;
  $('drawer').focus();
  if (push) history.replaceState(null, '', '#v=' + encodeURIComponent(id));
}

function closeDetail() {
  state.openId = null;
  $('drawer').classList.remove('on');
  $('scrim').classList.remove('on');
  $('drawer').setAttribute('aria-hidden', 'true');
  setTimeout(() => { $('scrim').hidden = true; }, 220);
  history.replaceState(null, '', location.pathname);
}

export { closeDetail };
function openFromHash() {
  const m = location.hash.match(/^#v=(.+)$/);
  if (m) openDetail(decodeURIComponent(m[1]), false);
}

async function loadRules(v, el) {
  const M = state.data.markets;
  const ids = [v._cols.left.m.id, v._cols.right.m.id];
  try {
    const ds = await Promise.all(ids.map((id) => getJSON('/api/market/' + encodeURIComponent(id) + '?provider=' + encodeURIComponent(M[id]?.provider || 'polymarket')).catch((e) => ({ description: `(couldn't load from ${venueOf(M[id])}: ${e.message})` }))));
    el.querySelector('pre').textContent = ds.map((d, i) => `${i === 0 ? '▸ ' : '\n▸ '}${marketTitle(M[ids[i]])}\n${d.description || '(no rules text)'}`).join('\n');
  } catch (err) {
    el.querySelector('pre').textContent = `Couldn't load rules: ${err.message}`;
  }
}

async function verifyLive(v) {
  const M = state.data.markets;
  const btn = $('verify'), out = $('live-out');
  const legs = v.legs.map((id) => M[id]).filter((m) => m && m.tokenId).slice(0, 60);
  btn.disabled = true; btn.classList.add('spinning');
  out.textContent = `Fetching ${legs.length} order book${legs.length > 1 ? 's' : ''}…`;
  const books = {};
  let failed = 0;
  const queue = legs.slice();
  await Promise.all(Array.from({ length: 6 }, async () => {
    while (queue.length) {
      const m = queue.shift();
      try { books[m.id] = await getJSON(`/api/book?token=${encodeURIComponent(m.tokenId)}&provider=${encodeURIComponent(m.provider || 'polymarket')}`); }
      catch { failed++; }
    }
  }));
  btn.disabled = false; btn.classList.remove('spinning');
  if (!Object.keys(books).length) { out.textContent = 'Could not reach the order book right now.'; return; }
  for (const [id, b] of Object.entries(books)) {
    const el = document.querySelector(`[data-mid="${CSS.escape(id)}"]`);
    if (!el) continue;
    const ll = el.querySelector('.live-leg');
    if (ll) ll.innerHTML = `Live: bid <b>${b.bid != null ? pct(b.bid) : '–'}</b> (${fmtInt(Math.round(b.bidSize))} sh) · ask <b>${b.ask != null ? pct(b.ask) : '–'}</b> (${fmtInt(Math.round(b.askSize))} sh)`;
    const lb = el.querySelector('.lb'), la = el.querySelector('.la');
    if (lb) lb.textContent = b.bid != null ? pct(b.bid) : '–';
    if (la) la.textContent = b.ask != null ? pct(b.ask) : '–';
  }
  const e = liveEdge(v, books);
  const k = $('edge-kpi');
  k.textContent = cents(e);
  k.className = 'v ' + (e > 0 ? 'good' : '');
  const pairDepth = v.legs.length <= 2 ? (() => {
    const [x, y] = v.legs.map((id) => books[id]);
    if (!x || !y) return '';
    const size = v.type === 'implication' || v.type === 'equivalent' ? Math.min(x.bidSize, y.askSize) : Math.min(x.bidSize, y.bidSize);
    return e > 0 ? ` Size available at those prices: ~${fmtInt(Math.round(size))} shares.` : '';
  })() : '';
  out.innerHTML = e > 0
    ? `<b style="color:var(--good)">Still live:</b> executable edge <b>${cents(e)}</b> per $1 right now.${pairDepth}${failed ? ` (${failed} book${failed > 1 ? 's' : ''} unavailable)` : ''}`
    : `Live books give an edge of <b>${cents(e)}</b> — the spread currently covers the inconsistency.${failed ? ` (${failed} book${failed > 1 ? 's' : ''} unavailable)` : ''}`;
}

// ---------- events ----------
function bindFilters() {
  let t;
  $('q').addEventListener('input', (e) => { clearTimeout(t); t = setTimeout(() => { state.filters.q = e.target.value; state.limit = 150; render(); }, 120); });
  $('types').addEventListener('click', (e) => {
    const b = e.target.closest('button');
    if (!b) return;
    for (const x of $('types').children) x.classList.toggle('on', x === b);
    state.filters.type = b.dataset.type; state.limit = 150; render();
  });
  const range = (id, key, fmt) => {
    const el = $(id), lab = $(id + '-val');
    const upd = () => { state.filters[key] = +el.value; lab.textContent = fmt(+el.value); };
    el.addEventListener('input', () => { upd(); render(); });
    upd();
  };
  range('minv', 'minv', (x) => (x === 1 ? '1 pt' : `${x} pts`));
  range('minc', 'minc', (x) => `${x}%`);
  $('cat').addEventListener('change', (e) => { state.filters.cat = e.target.value; render(); });
  $('liq').addEventListener('change', (e) => { state.filters.liq = +e.target.value; render(); });
  $('exec').addEventListener('change', (e) => { state.filters.exec = e.target.checked; render(); });
  $('reset').addEventListener('click', resetFilters);

  for (const th of document.querySelectorAll('.grid th[data-sort]')) {
    th.addEventListener('click', () => {
      const k = th.dataset.sort;
      state.sort = state.sort.key === k ? { key: k, dir: -state.sort.dir } : { key: k, dir: k === 'type' ? 1 : -1 };
      render();
    });
  }
  $('rows').addEventListener('click', (e) => {
    const tr = e.target.closest('tr[data-id]');
    if (tr) openDetail(tr.dataset.id);
  });
  $('rows').addEventListener('keydown', (e) => {
    if (e.key !== 'Enter') return;
    const tr = e.target.closest('tr[data-id]');
    if (tr) openDetail(tr.dataset.id);
  });
  $('scrim').addEventListener('click', closeDetail);
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && $('drawer').classList.contains('on')) closeDetail();
    if (e.key === '/' && document.activeElement.tagName !== 'INPUT') { e.preventDefault(); $('q').focus(); }
  });
  $('refresh').addEventListener('click', () => load(true));
  $('theme').addEventListener('click', () => {
    const root = document.documentElement;
    const dark = root.dataset.theme ? root.dataset.theme === 'dark' : matchMedia('(prefers-color-scheme: dark)').matches;
    root.dataset.theme = dark ? 'light' : 'dark';
    try { localStorage.setItem('iod-theme', root.dataset.theme); } catch { /* private mode */ }
  });
}

function resetFilters() {
  state.filters = { ...DEFAULTS };
  $('q').value = ''; $('minv').value = DEFAULTS.minv; $('minc').value = DEFAULTS.minc;
  $('cat').value = ''; $('liq').value = '0'; $('exec').checked = false;
  $('minv-val').textContent = '1 pt'; $('minc-val').textContent = `${DEFAULTS.minc}%`;
  for (const x of $('types').children) x.classList.toggle('on', x.dataset.type === 'all');
  state.sort = { key: 'score', dir: -1 };
  state.limit = 150;
  render();
}

bindFilters();
load(false);

// Read-only snapshot for the in-app analyst (chat.js): the research anomaly currently open, if any.
window.IOD_RESEARCH = () => {
  const v = state.openId && state.data?.violations.find((x) => x.id === state.openId);
  const out = { count: state.data?.violations?.length ?? null, selected: null };
  if (!v) return out;
  const M = state.data.markets, ex = explain(v, M);
  const mk = (id) => { const m = M[id]; return m && { venue: m.provider, contract: marketTitle(m), price: m.price, bid: m.bid, ask: m.ask, liquidity: m.liquidity, ends: (m.endDate || '').slice(0, 10) || null, event: m.eventTitle }; };
  out.selected = {
    classification: 'Research anomaly (NOT a trade — pricing inconsistency only)', title: ex.headline, relationship: TYPE_META[v.type]?.label || v.type,
    appRationale: v.rationale, why: ex.why, size: ex.size, violationPts: v.magnitude, confidence: v.confidence, edgeAtBidAsk: v.edge,
    tradableAtTopOfBook: !!v.executable, markets: [...new Set([v.a, v.b, ...(v.legs || [])].filter(Boolean))].slice(0, 12).map(mk).filter(Boolean),
  };
  return out;
};
