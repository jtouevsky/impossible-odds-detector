// Optional pluggable classifier (e.g. an LLM) for relationships the deterministic detectors can't decide.
// The app never calls one by default, so it stays 100% free. To add one later:
//
//   const classifier = {
//     id: 'my-llm',
//     async classifyPairs(pairs) {        // pairs: [{ a: Market, b: Market, similarity }]
//       // ...call your model...
//       return [{ type: 'implication', a: id1, b: id2, confidence: 0.8, rationale: '...' }];
//     },
//   };
//   await runPipeline(snapshot, { classifier });
//
// candidatePairs() below proposes plausibly-related pairs (same event or high title overlap) that no
// deterministic detector has already linked, so a classifier only sees a small, relevant batch.
import { tokens, jaccard } from './text.js';

export function candidatePairs(ctx, linked, { minSimilarity = 0.6, limit = 500 } = {}) {
  const out = [];
  const byEvent = ctx.byEvent;
  for (const ms of byEvent.values()) {
    if (ms.length < 2 || ms.length > 40 || ms[0].isGame) continue;
    const toks = ms.map((m) => tokens(m.question));
    for (let i = 0; i < ms.length; i++)
      for (let j = i + 1; j < ms.length; j++) {
        const k = [ms[i].id, ms[j].id].sort().join('|');
        if (linked.has(k)) continue;
        const s = jaccard(toks[i], toks[j]);
        if (s >= minSimilarity) out.push({ a: ms[i], b: ms[j], similarity: s });
      }
    if (out.length >= limit) break;
  }
  return out.slice(0, limit);
}
