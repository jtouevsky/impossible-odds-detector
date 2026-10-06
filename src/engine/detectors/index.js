// Relationship detector registry.
// A detector is { id, name, detect(ctx) => Relationship[] } and must be deterministic and free.
//
// Relationship = {
//   type: 'implication' | 'equivalent' | 'exclusive' | 'exclusive-set' | 'exhaustive',
//   a?, b?            // market ids for pairwise types (implication means a ⇒ b, i.e. P(a) ≤ P(b))
//   members?          // market ids for set types
//   confidence        // 0..1 that the logical relationship itself is correct
//   detector, subtype?, rationale
// }
//
// Optional LLM hook: pass `classifier` to runPipeline (see ../classifier.js). It receives candidate
// pairs the deterministic detectors could not decide and may return additional relationships.
import { ladderDetector } from './ladder.js';
import { outcomeSetDetector } from './sets.js';
import { hierarchyDetector } from './hierarchy.js';
import { equivalenceDetector } from './equivalence.js';

export const detectors = [ladderDetector, outcomeSetDetector, hierarchyDetector, equivalenceDetector];
