# P9: paths + walkers + schema-io (STUB, detail at boundary)

Delivers ~-1,500 B gz. Scope: interned path trie (pathOf() returns THE frozen
{segs, key, parent}; === equality; ByKey method twins deleted; one edge-parser kept
for serialized boundaries: SSR payload, wizard URL); normalized-node introspector
(node() with 8 structural kinds + WeakMap peel cache) replacing the ~25-arm wrapper
switches across the schema walkers; ONE reconcile(schema, node, value, mode) engine
replacing mergeStructural / setAtPathWithSchemaFill / unset-walker / merge-hydration
/ merge-deep (hydration mode EAGER here per the double-booking guard); shared
validated-descent helper under path-walker's read/write primitives; slim-primitive-
gate + schema-coerce merge over ONE per-store SchemaNode cache (one lookup per write,
deleting the five parallel path-keyed caches).
Interned-node lifetime is per-store; wizard/injectForm cross-store reads must not
leak nodes across registries.
Entry criteria: P5 funnel in place (interning can start earlier behind the rim).
