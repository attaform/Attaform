# P7: zod-core + probe packs — DONE 2026-08-24

**OUTCOME: measured 33,999 B gz, -531 against the plan's -400..-600
realized band; the barrel prize overshot: plugin-less `zod: { useForm }`
41,080 -> 38,760 (-2,320), v4-gap penalty 6,104 -> ~4,360.**
Full suite 4,689 green both majors at every slice; typecheck clean;
both dist-typed gates green against fresh unbuilds; all 22 size-limit
caps tightened and passing; perf gate PASSED with a construction WIN.
Commits: 8356ec5a (7a re-baseline + rep), e3a943f9 (7b fix walk v4 +
introspect diet), bdf7adef (7c seed pin), 323b7e1a + 9928113b (7d v3
unification + catch alignment), + the boundary gates commit.

## Findings

- **Sign-off 7 delivered the phase.** The slim-schema rebuild
  (getSlimSchema / walkSlim / stripRefinements and v3's
  getSlimSchema / stripRootSchema / stripRefinements /
  clone-schema.ts / the slim-root projection cache) is gone on BOTH
  majors, replaced by ONE shared DU-aware structural fix walk
  (`core/walk-fix-structural.ts`) over the SchemaIntrospector: no
  schema is ever rebuilt at construction and nothing parses, so user
  refinements and transforms can never fire during
  `getDefaultValues` (the perf-lock p1 suites pin exactly that via a
  sync refine returning a Promise — the pin that killed the naive
  parse-against-original rewire mid-slice).
- **The DU foreign-key strip was load-bearing.** The old slim parse
  silently dropped keys foreign to a DU value's selected variant
  (Zod's unknown-key stripping); the variant-memory / reshape
  machinery depends on that. The fix walk now does it DU-scoped by
  design, so undeclared keys at plain objects survive (the sign-off 7
  preservation) while DU residue is still cleaned. Caught by the DU
  hardening probes, not by theory.
- **Sign-off 6 REFUSED on rep evidence (+17 gz)**: the
  createAbstractSchema + services double-dispatch was fully
  gzip-pre-discounted; a class port GROWS the bundle and a shared
  class weighs what the shared factory weighs on the barrel. The
  factory stays; `node()` moves to P9.
- **Construction perf came back with the deletion**: v4 cold init
  +26% / +42% / +81% (flat F=5/50/500) vs the P5 reference — the P8
  -2..-5% residual repaid with interest. Keystroke arms noise-to-
  positive; the flagged array N=1000 batch collapse re-ran +1.8%
  solo (the known positional-GC artifact class).
- **v3 catch-under-useDefault:false aligned to v4** (recurse-inner);
  the `catchOnUseDefaultFalse` knob deleted from the core walker —
  with one behavior there is nothing to configure.
- **stripAsyncChecks revisit trigger ANSWERED (keep)**: seeds are
  user-visible on first paint via meta.valid / meta.errors /
  errors(path) while the field UI stays gated — pinned in
  `test/composables/construction-seed-visibility.test.ts`.
- **En-route docs traps fixed** (gate was green; these were the
  tolerated eyeball list): two success-arm snippets predating P5's
  `errors: undefined` tightening, and the custom-adapter example in
  two pages missing getEmptyValueAtPath / isFixedObjectAtPath /
  isPreprocessOrCoerceLeaf. REMAINING eyeball items: coercion.md's
  elided-entry TS2345 and app-defaults.md's generic-wrapper TS2589
  cluster (the known #443-space TS limitation). RECOMMENDATION for
  Oswald: widen `hydrateAttaformState(app, payload)` to
  `payload: unknown` — the body already runtime-validates the
  envelope and its own docblock example doesn't compile against the
  declared signature; reverted here pending a ruling (public API).
- Gates moved: BUDGET_GZ 34_950 -> 34_400; caps tightened
  (index/zod 52.75, zod-v4 48.25, zod-v3 49, scoped zod 39.25 /
  zod-v4 34.75 / zod-v3 35.5, barrel 39.25). Attribution: zod-v4 dir
  5,410 -> 4,051 gz; strip.ts and default-values.ts are thin
  bindings now.

## 7a findings (2026-08-24) — re-baseline done, claim re-anchored

Battery green first: 58 files / 972 tests (test/adapters/\*\* both majors

- zod-shape, schema-coerce, coerce, discriminator-cache,
  is-fixed-object, use-form-unified/guard, values-storage-shape v3/v4,
  default-values-shape).

Survey correction: the plan's item 1 is largely PRIOR ART. The shared
walkers already exist (`core/walk-derive-default` 996 gz,
`core/walk-slim-primitives` 724, `core/walk-path-segments` 463, all
parameterized by `SchemaIntrospector`), and `walker-introspector.ts`
IS the v4 probe pack (~28 accessors as data). The remaining eager fat
sits in strip.ts's THREE same-skeleton rebuilders, introspect.ts's
switch/walk text, and the factory indirection.

Rep sketch (reference/rep-p7/, cumulative arms, esbuild redirect on
the day's tree, scenario baseline 36,734 gz):

| arm | claim                                                                                      | lean delta      |
| --- | ------------------------------------------------------------------------------------------ | --------------- |
| A   | sign-off 7: getSlimSchema+stripRefinements DELETED; fix pass parses original-or-stripAsync | **-730**        |
| B   | introspect diet: kindOf alias table + data-driven walkSchemaTree                           | -102            |
| C   | sign-off 6: class adapter absorbs factory + services                                       | **+17 (GROWS)** |
| D   | all three                                                                                  | -834            |

**armC is REFUSED as a size item** (rep-first rule): the services
record + createAbstractSchema indirection was fully gzip-pre-discounted;
the lean class port measured +17. The factory stays. Sign-off 6's
`node()` SPI addition moves to P9 where its consumer (trie) lives; the
"services deleted" arm is dropped. Barrel value of the absorption is
also ~0 (a shared class weighs what the shared factory weighs).

Re-anchored expectation: armD lean -834 x0.6 realization (P8 addendum
discount) = **~-500 realized central, band -400..-650** — inside the
plan's -400..-600. Anchor 34,530 -> ~34,030 expected.

Re-sliced execution: 7b = strip diet + fix-pass rewire + introspect
diet (the -832 lean cluster, ratchet slice) -> 7c = stripAsyncChecks
SSR-visibility characterization test (the declined-sign-off revisit
trigger) + strict-defaults behavior migration -> 7d = v3 alignment +
barrel re-measure (v3's mirror of armA is where the barrel prize
lives, NOT the factory).

7b design notes carried from the sketch (the claws the x0.6 prices):

- First-parse success now returns `merged`, not `firstParse.data` —
  unknown constraint keys PRESERVED (the sign-off 7 documented change;
  Zod's default object parse strips undeclared keys, the slim rebuild
  also lost `.catchall()`/`.strict()`).
- Lax mode now runs the full original parse -> sync `.transform` fns
  fire at construction in lax mode (strict mode already ran them).
- Async-TRANSFORM schemas lose the construction fix pass entirely
  (today the slim rebuild stripped pipes and still fixed structural
  constraint mismatches; stripAsyncChecks leaves pipes intact so no
  sync parse is possible). Decide at 7b: accept + document, or keep a
  minimal pipe-peel for this one case. The parity suites referee.

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
- **TRIGGER ANSWERED 2026-08-24 (7c): the seeds ARE user-visible —
  the walker stays, now with pinned evidence.**
  `test/composables/construction-seed-visibility.test.ts` proves the
  strict-mode seed reads through `meta.valid === false`,
  `meta.errors` / `errorCount`, and `form.errors('name')` on first
  paint (a submit button bound to `meta.valid` renders disabled
  BECAUSE of the seed), while the per-field display gate
  simultaneously hides it from the field UI (`displayState` 'idle',
  `showErrors` false). The suite also pins strip-walker parity (an
  async refine elsewhere does not eat the seed) and the lax-mode
  control (no seed). The deletion is off the table for good unless
  the meta surfaces themselves change.

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
