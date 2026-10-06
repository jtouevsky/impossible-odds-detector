// Exact integer feasibility for final-score constraints (no sampling, no arbitrary score caps).
//
// Variables: a, b = final scores of the two teams (non-negative integers).
// Every constraint has the form  ca·a + cb·b ≥ k  with ca, cb ∈ {−1, 0, 1} and integer k.
// That covers everything the supported contracts need:
//   current score   a ≥ a0, b ≥ b0          winner      a − b ≥ 1 / b − a ≥ 1 / a = b
//   game total      a + b ≥ L+½ / ≤ L−½     team total  a ≥ T+½ / a ≤ T−½
//
// Decision procedure: for a fixed a, b must lie in [Lb(a), Ub(a)] where Lb is a max of lines and Ub a min
// of lines (slopes −1, 0, 1). g(a) = Ub(a) − Lb(a) is concave and piecewise linear, so over the integers its
// maximum sits at a domain endpoint or next to a breakpoint (where two of those lines cross). If the domain is
// unbounded above we also look at g's slope at +∞. This is exact — it never assumes a maximum score.

/** @typedef {{ca:number, cb:number, k:number, why?:string}} Constraint */

export const C = {
  aAtLeast: (n, why) => ({ ca: 1, cb: 0, k: n, why }),
  aAtMost: (n, why) => ({ ca: -1, cb: 0, k: -n, why }),
  bAtLeast: (n, why) => ({ ca: 0, cb: 1, k: n, why }),
  bAtMost: (n, why) => ({ ca: 0, cb: -1, k: -n, why }),
  sumAtLeast: (n, why) => ({ ca: 1, cb: 1, k: n, why }),
  sumAtMost: (n, why) => ({ ca: -1, cb: -1, k: -n, why }),
  diffAtLeast: (n, why) => ({ ca: 1, cb: -1, k: n, why }),   // a − b ≥ n
  diffAtMost: (n, why) => ({ ca: -1, cb: 1, k: -n, why }),   // a − b ≤ n
};

/** Is there an integer (a, b) ≥ 0 satisfying every constraint? Returns a witness {a, b} or null. */
export function feasible(constraints) {
  const all = [C.aAtLeast(0), C.bAtLeast(0), ...constraints];
  let aLo = 0, aHi = Infinity;
  const lowers = [], uppers = []; // lines in a: b-bound = m·a + q
  for (const c of all) {
    if (![c.ca, c.cb].every((x) => x === -1 || x === 0 || x === 1) || !Number.isInteger(c.k)) throw new Error('solver: unsupported constraint');
    if (c.cb === 0) {
      if (c.ca === 0) { if (0 < c.k) return null; continue; }
      if (c.ca === 1) aLo = Math.max(aLo, c.k); else aHi = Math.min(aHi, -c.k);
    } else if (c.cb === 1) lowers.push({ m: -c.ca, q: c.k });   // b ≥ k − ca·a
    else uppers.push({ m: c.ca, q: -c.k });                     // b ≤ ca·a − k
  }
  if (aLo > aHi) return null;
  const Lb = (a) => Math.max(...lowers.map((l) => l.m * a + l.q));        // lowers always has b ≥ 0
  const Ub = (a) => (uppers.length ? Math.min(...uppers.map((l) => l.m * a + l.q)) : Infinity);
  const ok = (a) => a >= aLo && a <= aHi && Lb(a) <= Ub(a);
  const hit = (a) => ({ a, b: Lb(a) });

  // candidates: domain ends + integers around every crossing of two bound lines
  const lines = [...lowers, ...uppers];
  const cand = [aLo];
  if (Number.isFinite(aHi)) cand.push(aHi);
  for (let i = 0; i < lines.length; i++)
    for (let j = i + 1; j < lines.length; j++) {
      const dm = lines[i].m - lines[j].m;
      if (dm === 0) continue;
      const x = (lines[j].q - lines[i].q) / dm;
      cand.push(Math.floor(x) - 1, Math.floor(x), Math.ceil(x), Math.ceil(x) + 1);
    }
  const last = Math.max(...cand);
  cand.push(last + 1, last + 2); // past every crossing the active lines no longer change
  for (const v of [...new Set(cand)].sort((x, y) => x - y)) if (ok(v)) return hit(v); // smallest witness first

  // unbounded above: beyond the last crossing g(a) = Ub − Lb is linear; if it increases, it eventually becomes ≥ 0
  if (aHi === Infinity && uppers.length) {
    const x = last + 2;
    const up = uppers.reduce((p, l) => (l.m * x + l.q < p.m * x + p.q ? l : p));
    const lo = lowers.reduce((p, l) => (l.m * x + l.q > p.m * x + p.q ? l : p));
    const slope = up.m - lo.m, g = (up.m * x + up.q) - (lo.m * x + lo.q);
    if (slope > 0) { const v = x + Math.max(0, Math.ceil(-g / slope)); if (ok(v)) return hit(v); }
  }
  return null;
}
