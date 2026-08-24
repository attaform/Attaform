# P4: field-meta install + SPI probe delete (DONE 2026-08-23)

Status: DONE. Measured eager 35,776 -> 35,207 B gz (-569; plan expected ~-626
mid). Ratchet tightened 36_250 -> 35_650. Landed with P0/P1a/P2/P3 on
`experiment/size-teardown`.

## What shipped

1. **Field-meta walk rides the registration surface.** `walk-field-meta.ts`
   (624 gz, previously imported eagerly by BOTH adapters) left the eager graph:
   - `field-meta-store.ts` (eager, stays) gained an installable slot:
     `FieldMetaPathMapBuilder` + `installFieldMetaPathMapBuilder` +
     `buildFieldMetaPathMap` (returns `undefined` while uninstalled).
   - `walk-field-meta.ts` exports `installingFieldMetaStore`: a
     `FieldMetaStore`-shaped wrapper whose `add` installs
     `getFieldMetaPathMap` into the slot then delegates; get/has/remove
     delegate straight through. CALL-SITE install, deliberately NOT a
     module-scope side effect — the repo ships `sideEffects: false`, so a
     top-level install call would be a lie to the bundler and legally
     droppable; the value-carries-the-capability shape (the historyPlugin
     principle) can't be broken by any optimizer, and dev (no tree-shaking)
     behaves identically to prod.
   - All three registration surfaces (zod-v4 / zod-v3 / unified
     `field-meta.ts`) export `fieldMeta` as the installing wrapper (same
     per-major type casts) and route `withMeta`'s add through it. The native
     v4 `schema.register(fieldMeta, payload)` chain installs too — Zod only
     calls `registry.add`.
   - Both adapters' `resolveFieldMetaAtPath` now call
     `buildFieldMetaPathMap(...)` + `getFieldMetaForSchema` from the store
     module; the per-adapter `getFieldMeta` / `getFieldMetaList` re-export
     helpers were DELETED (src stopped using them; tests re-pointed to the
     store reads). Uninstalled resolution ≡ nothing-registered resolution:
     label = humanize, description = `.describe()`, meta = {} — unchanged
     observable behavior, because registering is the only way a payload can
     exist and registering installs.

2. **`arrayShapeAtPath` is definitive (`number | null`), probe deleted**
   (sign-off 6). The `undefined` arm ("can't introspect — arm the probe")
   died: `resolveArrayShape` (TUPLE_PROBE_INDEX 1_000_000 + 1024-step tuple
   walk) deleted from path-walker; both callers read
   `schema.arrayShapeAtPath(scratch)` directly. The factory returns `null`
   for root / unresolved / non-tuple kinds (previously `undefined`).
   `getSlimPrimitiveTypesAtPath` is REQUIRED on `SchemaForFill` (the `?.`
   call dropped). wizard-noop-schema + test fake-schema answer `null`.

## Behavior-equivalence notes (recorded reasoning)

- Non-array path + array consumer: OLD probe resolved shape 0 (len-0 tuple
  → consumer passes through, no recursion); NEW `null` recurses per element
  with an `undefined` element default — every element merges to itself, the
  `mutated` flag stays false, and the SAME consumer reference returns.
  Identical observables, verified against fake-schema's data-keyed
  `getDefaultAtPath` (returns `undefined` under arrays).
- Record-typed paths where numeric segments resolve: both OLD (1M-index
  probe resolves → `null`) and NEW (`null`) take the unbounded arm. No delta.
- The tightened contract shifts the tuple burden to third-party adapters:
  returning `null` for a real tuple now silently loses per-position padding
  (docs call this out). Built-ins always answered definitively.

## Deviations from the plan

- Realized -569 vs ~-626 mid expectation: `zod-v4/field-meta.ts` (17 gz)
  left eager as planned, but `core/field-meta.ts` (29 gz) STAYS eager —
  `EMPTY_RESOLVED_FIELD_META` is consumed by field-state-api; the phase file
  had bucketed it "registration surface". Probe delete banked ~65 gz in
  path-walker (1,058 -> 993). Adapters grew ~8 gz total (slot-read wiring).
- The per-adapter `getFieldMeta` / `getFieldMetaList` helpers were deleted
  outright rather than kept as internal conveniences (no src consumer left;
  tests read through `getFieldMetaForSchema` / `getFieldMetaListForSchema`).

## Gates moved with the win

- `scripts/check-eager-size.mjs` BUDGET_GZ 36_250 -> 35_650 (measured 35,207).
- `.size-limit.js`: zod {useForm} + barrel {useForm} 43 -> 42.25 (41.71);
  zod-v4 {useForm} 37 -> 36.25 (35.59); zod-v3 {useForm} 38.25 -> 37.75
  (37.06); abstract {useAbstractForm} 27.5 -> 27.25 (26.85, probe-only —
  no zod walk in that entry). Whole-entry caps HELD: full-entry imports
  include `withMeta`/`fieldMeta`, so the walker rightly stays in those
  measurements (index 54.97 vs 55.5 cap; +0.02 KB wrapper noise).
- dev-dce S4 UNWELDED_MODULES += `src/runtime/core/walk-field-meta.ts`
  (13 modules).

## New coverage

- `test/core/field-meta-walker-install.test.ts` (both majors): uninstalled
  fallback (humanize label + `.describe()` description + empty meta with NO
  registration surface imported — relies on vitest per-file isolation and
  declaration-order specs), then install-ride via dynamic import proving the
  path walk through the one case the schema-keyed fallback CANNOT resolve
  (two registrations on the SAME schema instance at two paths; the
  single-slot store holds only the last payload, so per-path labels require
  the walk).
- Docs: `custom-adapters.md` + `abstract-schema.md` contract blocks and
  `arrayShapeAtPath` sections rewritten to the definitive `number | null`.

Next: P5 (store kernel) per `P5-store-kernel.md`, detailed at this boundary.
