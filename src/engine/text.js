// Lightweight, deterministic text utilities shared by every detector.
// Runs unchanged in Node and the browser.

const MONTHS = {
  jan: 0, january: 0, feb: 1, february: 1, mar: 2, march: 2, apr: 3, april: 3,
  may: 4, jun: 5, june: 5, jul: 6, july: 6, aug: 7, august: 7, sep: 8, sept: 8,
  september: 8, oct: 9, october: 9, nov: 10, november: 10, dec: 11, december: 11,
};

/** Lowercase, strip accents, unify quotes/dashes, collapse whitespace. Keeps symbols that carry meaning ($ % + - < > ≤ ≥ / .). */
export function normText(s) {
  if (!s) return '';
  return String(s)
    .normalize('NFKD').replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[‘’′`]/g, "'")
    .replace(/[“”]/g, '"')
    .replace(/[‒–—−]/g, '-')
    .replace(/\s+/g, ' ')
    .trim();
}

/** Canonical form for comparing two questions for equality. */
export function canonQuestion(s) {
  return normText(s)
    .replace(/\bthe\b/g, ' ')
    .replace(/[^a-z0-9$%+\-<>≤≥.°/ ]/g, ' ')
    .replace(/\s+/g, ' ')
    .replace(/[ .?]+$/, '')
    .trim();
}

/** Canonical entity name: "J.D. Vance" == "JD Vance", "the Boston Celtics" == "boston celtics". */
export function canonEntity(s) {
  return normText(s)
    .replace(/^the /, '')
    .replace(/[.'’]/g, '')
    .replace(/&/g, ' and ')
    .replace(/[^a-z0-9 ]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

export function tokens(s) {
  return canonQuestion(s).split(' ').filter(Boolean);
}

/** Years mentioned in text, e.g. "2026-27" -> [2026, 2027]. */
export function yearsIn(s) {
  const out = [];
  const t = normText(s);
  const re = /\b(20[2-4]\d)(?:\s*[-/]\s*(\d{2}))?\b/g;
  let m;
  while ((m = re.exec(t))) {
    out.push(+m[1]);
    if (m[2]) out.push(Math.floor(+m[1] / 100) * 100 + +m[2]);
  }
  return out;
}

export function maxYear(s) {
  const ys = yearsIn(s);
  return ys.length ? Math.max(...ys) : null;
}

const NUM_RE = /(\d{1,3}(?:,\d{3})+|\d+)(\.\d+)?(\s?(?:k|m|bn|b|million|billion|trillion)\b)?/g;
const DATE_RE = /\b(jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|june?|july?|aug(?:ust)?|sept?(?:ember)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?)\.?\s+(\d{1,2})(?:st|nd|rd|th)?(?:,?\s+(20\d\d))?\b/g;
const YEAR_DEADLINE_RE = /\b(by|before|until|by the end of|by end of|before the end of)\s+(20\d\d)\b/g;

const MULT = { k: 1e3, m: 1e6, b: 1e9, bn: 1e9, million: 1e6, billion: 1e9, trillion: 1e12 };

/**
 * Turn a question into a template with typed slots.
 *   "Will BTC be above $74,000 on October 2?" ->
 *   { template: "will btc be above $⟨N⟩ on ⟨D⟩?", slots: [{type:'N', value:74000}, {type:'D', value:<ts>}] }
 * refTime (ms) = the contract's end date; used to infer the year of dates written without one.
 */
// Slot markers use private-use characters so later regexes (numbers!) can't touch them.
const mark = (i) => '\u0001' + String.fromCharCode(0xe000 + i) + '\u0001';

export function templatize(text, refTime) {
  let t = normText(text);
  const slots = [];
  const marks = [];
  // 1) explicit calendar dates
  t = t.replace(DATE_RE, (_, mon, day, yr) => {
    const m = MONTHS[mon.replace('.', '')];
    let v;
    if (yr) v = Date.UTC(+yr, m, +day);
    else {
      // no year written: pick the year that lands closest to the contract's own end date
      const ref = refTime || Date.now();
      const y0 = new Date(ref).getUTCFullYear();
      v = [y0 - 1, y0, y0 + 1].map((y) => Date.UTC(y, m, +day)).sort((a, b) => Math.abs(a - ref) - Math.abs(b - ref))[0];
    }
    marks.push({ type: 'D', value: v, raw: _ });
    return ` ${mark(marks.length - 1)} `;
  });
  // 2) "by 2027" / "before 2027" style deadlines -> date slots (keep the keyword)
  t = t.replace(YEAR_DEADLINE_RE, (_, kw, yr) => {
    const endOf = /end of/.test(kw);
    marks.push({ type: 'D', value: endOf ? Date.UTC(+yr, 11, 31) : Date.UTC(+yr, 0, 1), raw: _ });
    return `${kw} ${mark(marks.length - 1)}`;
  });
  // 3) numbers
  t = t.replace(NUM_RE, (raw, int, dec, mult) => {
    let v = parseFloat(int.replace(/,/g, '') + (dec || ''));
    if (mult) v *= MULT[mult.trim()] || 1;
    marks.push({ type: 'N', value: v, raw });
    return mark(marks.length - 1);
  });
  // rebuild in reading order
  let template = '';
  const re = /\u0001([\ue000-\uf8ff])\u0001/g;
  let last = 0, m;
  while ((m = re.exec(t))) {
    template += t.slice(last, m.index);
    const mk = marks[m[1].charCodeAt(0) - 0xe000];
    template += mk.type === 'D' ? '⟨D⟩' : '⟨N⟩';
    slots.push({ ...mk, pos: template.length });
    last = re.lastIndex;
  }
  template += t.slice(last);
  template = template.replace(/\s+/g, ' ').trim();
  // recompute slot positions after whitespace collapse
  let idx = 0;
  for (const s of slots) {
    const tag = s.type === 'D' ? '⟨D⟩' : '⟨N⟩';
    const p = template.indexOf(tag, idx);
    s.start = p; s.end = p + tag.length; idx = s.end;
  }
  return { template, slots };
}

export function jaccard(a, b) {
  const A = new Set(a), B = new Set(b);
  let i = 0;
  for (const x of A) if (B.has(x)) i++;
  return i / (A.size + B.size - i || 1);
}

export function fmtPct(p, digits = 1) {
  if (p == null || !isFinite(p)) return '—';
  return (p * 100).toFixed(digits).replace(/\.0$/, '') + '%';
}
