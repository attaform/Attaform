# P7: zod-core + probe packs (detailed 2026-08-24 at the P8 boundary)

Anchor 34,530 B gz (P8 final). Expected band **-300..-900 B gz** on the
ratchet metric (minimal-v4), central ~-600 BEFORE the P8 addendum's
~0.6 rep-realization discount — plan against **~-400..-600 realized**.
The phase's second prize is separate from the ratchet: the plugin-less
BARREL penalty shrinks from +5.4 kB to ~+2.5-3 kB, and the both-majors
stack from ~12.3 kB to ~6.5-7.5 kB, because the shared zod-core stops
duplicating the walk machinery per major. Both numbers are measured by
the size-limit entries (`zod: { useForm } only` 41,075 B vs `zod-v4:
{ useForm } only` 34,971 B today — the gap IS the penalty).

Fresh attribution for the addressable cluster (attribution-v4.txt,
2026-08-24): zod-v4 adapter dir 5,410 gz (introspect 1,534, strip
1,505, adapter 1,061, assert-supported 446, default-values 348,
walker-introspector 232, discriminator 125, small files ~160) +
abstract-schema-factory 1,294 + schema-coerce 541 = ~7,245 gz
addressable. The v3 twin never enters minimal-v4 eager — its wins land
in the barrel/both-majors metrics only.

## Scope

1. **Shared zod-core** (major-agnostic, in core/ or adapters/shared):
   ONE `walkTree(pack, node, visit)` over `pack.children` powering the
   async-detection and container predicates + a path-labeled assert;
   peel / required / DU-discriminator / issue-map / withMeta logic
   written once; ONE shared lazy fingerprint walker; lazy 3-method
   sub-schema stubs; a direct `pathNeedsAsync` store query replacing
   the per-path sub-schema materialisation where only the flag is
   needed.
2. **Per-major probe packs**: the major-specific surface shrinks to
   ~28 two-line accessors (kind table as data, safeParse glue, the
   UNSUPPORTED list). The pack is the only per-major code; everything
   else imports zod-core.
3. **Prototype ZodSchemaAdapter absorbing abstract-schema-factory**:
   the factory's per-instance closure record becomes prototype methods
   on one class-shaped adapter; the `services` object is deleted
   (sign-off 6 approved the SPI tightening: node() added,
   arrayShapeAtPath + slim kinds required, fingerprint kept shared +
   lazy).
4. **Strict defaults via the DU-aware data-walk fix pass** (sign-off
   7): getSlimSchema / stripRefinements DELETED in favor of the
   value-directed fix walk. Unknown constraint keys are now preserved;
   suites re-baseline. The fix walk must discriminate by VALUE at DU
   nodes, never first-candidate.
5. **v3 alignment** (barrel metric): catch-under-useDefault:false to
   v4 semantics; slim-root projection deletion; lax fix loop
   unification. Detail these against the v3 adapter dir when the
   zod-core shape exists; every change tested against BOTH majors per
   the standing agreement.

## Kept / declined

- **stripAsyncChecks: KEPT** (declined sign-off), preserving SSR
  construction-seed parity. REVISIT TRIGGER (agreed 2026-08-23):
  during P7, add a characterization test answering "are
  construction-time sync-check error seeds ever USER-VISIBLE under
  default display-state gating on SSR first paint (incl. aria and
  form.meta consumers)?" If provably invisible in all default
  configurations, the ~500 B deletion may be re-proposed WITH that
  evidence; until then it stays.

## Entry criteria / characterization gate

- Both-majors adapter characterization suites re-baselined FIRST
  (test/adapters/\*\*, field-meta v3/v4 suites, the strip/introspect
  suites, zod-shape, schema-coerce, DU suites, slim-primitive gates).
- Per the rep-first rule: before the zod-core rewrite, sketch the
  shared walkTree + one probe pack for v4 (reference/rep style) and
  measure the redirect delta on the day's tree; the -900 central
  predates P5-P8 and MUST be re-anchored.
- Strict-defaults re-baseline (sign-off 7) is a behavior change:
  document the observable difference (unknown constraint keys
  preserved) in the phase findings and migrate affected tests
  deliberately, never by loosening assertions.
- Perf gate: init + keystroke vs reference/p5-bench-after.json (the
  adapter sits on the construction path; watch the init arms — P8
  already carries a recorded -2..-5% cold-init residual, so measure
  against the P8 boundary numbers in P8-surfaces.md findings, not just
  the P5 JSON).
- Fresh `pnpm exec unbuild` before both dist-typed gates (standing
  rule).

## Execution order inside the phase

7a re-baseline + rep sketch -> 7b zod-core + v4 probe pack (ratchet
slice) -> 7c factory absorption + strict-defaults fix pass -> 7d v3
alignment + barrel/size-limit re-measure -> phase-final gates
(ratchet, caps incl. the barrel entries, attribution, bench, ledger,
P1b detail). Slice commits with the adapter battery green between
each.
