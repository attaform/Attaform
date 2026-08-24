# P9: paths + walkers + schema-io (detailed 2026-08-24 at the P1b boundary)

Anchor 33,124 B gz (P1b final). The stub's ~-1,500 claim predates five
phases of realization data; re-derived expectation is **-600..-1,000**
with each arm priced separately below (the reconcile fold carries the
P6 twin-discount, the trie prices as deletion, node() as the P7-moved
SPI). Rep-first is MANDATORY per the standing discounts: sketch and
measure each arm BEFORE its rewrite; refuse any arm that prices under
~+3x its integration risk, and record refusals in the addendum.

## Entry criteria

1. Characterization battery pinned green on both majors before any
   rewrite: path call-form tests, walker suites (derive-default,
   fix-structural, slim-primitives, field-meta), write-funnel arrays
   suite, hydration round-trip, wizard URL restore.
2. Bench baseline captured (keystroke flat/deep, array append/swap,
   cold init F=5/50/500) — the trie and the per-store SchemaNode cache
   sit ON the P5-banked write funnel; those wins must hold within
   noise, and construction must not regress the P7 recovery.
3. Rep sketches measured for the three arms, in isolation, against
   today's tree (NOT the audit tree):
   a. trie rep: interned pathOf() + ByKey twin deletion estimate;
   b. node() rep: the normalized-node introspector over the surviving
   switches (P7 already data-drove v4 walkSchemaTree and deleted
   the slim rebuild — re-count the arms that actually remain);
   c. reconcile rep: line inventory of mergeStructural /
   setAtPathWithSchemaFill / unset-walker / merge-hydration /
   merge-deep / walk-fix-structural overlap — the fix walk landed
   AFTER the stub was written and may already own part of this
   ground; price the fold on what remains.

## Scope (execute only rep-surviving arms, in this order)

1. Interned path trie: pathOf() returns THE frozen {segs, key, parent}
   per store; === equality; ByKey method twins deleted; ONE edge
   parser kept for serialized boundaries (SSR payload, wizard URL).
   Interned-node lifetime is per-store; wizard/injectForm cross-store
   reads must not leak nodes across registries.
2. node() SPI (moved from P7 sign-off 6's refusal): normalized
   structural node + WeakMap peel cache; walkers consume node(), the
   remaining per-kind wrapper switches collapse. Both majors, same
   introspector seam as walk-fix-structural.
3. reconcile(schema, node, value, mode) ONLY if 3c priced it: absorb
   the write-side walks one at a time with the battery green between
   absorptions; hydration mode lands EAGER here (double-booking
   guard). If the rep prices at twin-fold levels, refuse and record.
4. slim-primitive-gate + schema-coerce over ONE per-store SchemaNode
   cache: one lookup per write; the parallel path-keyed caches die.

## Acceptance

- Ratchet drops by the summed realized value of executed arms;
  BUDGET_GZ tightened with the recorded reason; refused arms in the
  addendum with their measured prices.
- Bench: keystroke + array + cold-init within noise of the P9
  baseline (write-funnel perf is banked; size never buys it back).
- Full suite + typecheck green both majors; fresh unbuild before
  dist-typed gates; attribution regenerated; ledger row + P10 detail
  pass; commit; suggest /compact.
