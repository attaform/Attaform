# P5: store kernel — DONE 2026-08-23 (size-negative; perf + API phase)

OUTCOME, measured: eager 35,207 -> 35,768 B gz (**+561**, against the
plan's ~-2,700). The phase's value landed in performance, API shape, and
architecture, not bytes — the full findings section at the bottom is the
honest account, and the audit-model store-lazy credits it refutes matter
for every remaining phase's expectation. Behavior held verbatim
throughout: the 5a characterization battery (47 files / 569 tests) and
the full suite stayed green on every slice commit.

Original brief (for the record): deliver ~-2,700 B gz (landing
expectation ~32,500 from the 35,207 anchor; ratchet is the only
authority). Highest-risk phase: rewrites the store's inner structure
while every observable behavior holds verbatim. One phase, one stack of
commits, characterization FIRST.

Fresh anchor (2026-08-23, post-P4): eager 35,207 B gz. Attribution
(reference/attribution-v4.txt, regenerated on the P4 commit):
create-form-store.ts 6,463 gz / 20,850 raw (the mover — 18% of eager);
build-form-api.ts 2,744; field-state-api.ts 1,812; array-engine.ts 1,803
(P3's consolidation — P5 touches its call sites, not its internals);
process-form.ts 1,558; surface-proxy.ts 1,175; diff-apply.ts 789;
errors.ts 591 + errors-proxy.ts 594; du-stubs.ts + store-records.ts +
merge-hydration.ts 222 in the long tail.

## Scope (from the audit + sign-off 5; judge guards apply)

1. **Kernel record.** create-form-store's ~115-closure body becomes a plain
   `FormState` record + store-first-arg module functions + ordered hook
   arrays. Construction = reset: ONE initialize sequence runs at both
   construction and `reset()` (today they are two hand-synced paths).
   Required-internal-params memory applies: the extracted functions take the
   state record as a required first argument, no optional plumbing.
2. **Single-walk write funnel.** Gate + strip-check + structural complete +
   authored walk + patch-emit in ONE tree walk, emitting patches straight to
   `applyChangedKeys` (diff-apply.ts:288). Deletes the verified double diff:
   today the funnel diffs to decide what changed and `applyChangedKeys`
   re-diffs per top-level key (diff-apply's content-diff at ~line 217+).
   P4 note: the funnel's `arrayOpRemap` hoist and
   `arrayBookkeeping.applyStructuralOp` orchestration (P3) sit INSIDE this
   funnel — preserve the exact post-write order (migrate -> seed fresh ->
   drop verdicts -> abort vacated -> evict variant memory -> replay
   identity).
3. **One tagged error store** (sign-off 5). `schemaErrors` + `userErrors`
   maps collapse to a single map of tagged entries (src: schema|user); blank
   derives at read (`atta:no-value-supplied` synthesis stays a read-side
   augmentation). Three shared writers replace the per-channel write paths.
   `ValidationError` drops per-entry `formKey` (the form stamps envelope-
   level identity). INVARIANTS that cannot move: error order
   schema -> blank -> user with authored schema messages leading firstError
   on submit; `getErrorsForPath` stays the one "has error at path" road;
   `''` vs `[]` boundary; `errors([])` = full aggregate; ownErrors exact-path
   semantics. HistoryKernel (P3) reaches `schemaErrors` / `userErrors` /
   `setAllSchemaErrors` / `setAllUserErrors` structurally — the kernel slice
   in types-api and history.ts's capture/restore move WITH this change (the
   ring buffer snapshots the tagged store instead of two maps).
4. **Capability flags.** hasDU / hasTransforms / hasArrays computed once at
   construction; write-funnel stages and per-write guards skip disabled
   pipelines instead of re-probing per write.
5. **DU stack fold.** Reshape + du-stubs + ancestor guard consolidate to one
   module + ONE clone walk. Variant MEMORY stays in array-engine.ts (P3
   landed it there; do not re-split — the fold consumes its API).
6. **Activation/rehydrate lazy behind activate()** with SYNC gating flips:
   hydrating/activated/activationPromise published synchronously,
   onServerPrefetch awaits the composed promise. JUDGE GUARD: the
   merge-hydration bytes live EAGER in the P9 reconcile engine — this move
   credits ~480, not 600.
7. **SSR replay behind the registry payload path** with a version stamp on
   the hydration payload (sign-off 9's stamp half; the attaform/ssr entry
   split itself is P8's surface program).
8. **Async transforms:** bookkeeping STAYS EAGER (sync supersede, per-path
   counts, cancel inside the funnel); ONLY the assigner then-body commit
   orchestrator defers (the re-verified #361 decline, do-not-do list).

NOT in P5 (counted elsewhere): invalid-submit focus-policy lazy move (P6);
errors.ts prose strings (P1b); assigner-pipeline (left with P2).

## HARD GATE: pin these suites green on BOTH majors before the rewrite

Run and record green as the first commit of the phase (no source changes):

- Write funnel ordering + gates: set-value.test.ts,
  set-value-schema-fill-regression.test.ts, coerce-write-boundary.test.ts,
  preprocess-write-boundary.test.ts, slim-primitive-write-gate (v3 property),
  blank-mark-descendants.test.ts, blank-paths-order-stability.test.ts.
- Same-tick DU reshape (no flicker): du-variant-error-flicker.test.ts,
  du-variant-error-regressions.test.ts,
  discriminated-union-variant-switch.test.ts, discriminated-union-lift /
  -root.test.ts.
- Blur-revalidation value-equality dedup: blur-revalidation.test.ts,
  aborted-blur-snapshot.test.ts, blank-numeric-blur-preservation.test.ts.
- Error order schema-first + channels: errors.test.ts,
  meta-errors-order-stability.test.ts, errors-proxy-enumeration.test.ts,
  error-data.test.ts, submit-related suites (submit success semantics #490).
- Reset / resetField: reset.test.ts, reset-clears-snapshot.test.ts,
  default-values-history-skip.test.ts (history plugin construction-subscribe
  rides reset paths).
- Transforms latching: async-transforms.test.ts, async-transform-display /
  -dom-sync / -file / -override.test.ts.
- Hydration replay: default-values-rehydrate.test.ts, ssr-bare-vue/
  round-trip.test.ts + runtime-form-state-ssr.test.ts +
  optimistic-connected.test.ts, multi-select-hydration.test.ts.
- Perf-lock: perf-lock/behavior-lock.test.ts + golden captures +
  p1-validation-cancel-equivalence.test.ts (10/10 through array-engine).

Perf gate: bench mount + keystroke must not regress (expect improvement —
~115 closures + 32 Maps/Sets per form become shared functions + plain
records); run `pnpm bench` floors before and after.

## Suggested slicing (each lands green; one PR / small stack)

5a characterization pin (test-only commit) -> 5b kernel record + construction
= reset -> 5c single-walk funnel + double-diff delete -> 5d tagged error
store (+ HistoryKernel slice move) -> 5e DU fold + capability flags -> 5f
activation/SSR-replay lazy + stamp. Ratchet + caps move in the LAST commit
with the phase's total.

## Entry criteria

P2/P3/P4 landed (met). No docs-page gate. Both majors on every commit.

## 5a characterization pin record (2026-08-23, at anchor 9a057bb2)

Resolved the named suites to 47 actual files (list pinned in the 5a commit
message and reproducible via the buckets above; naming deltas from the stub:
"slim-primitive-write-gate (v3 property)" =
slim-primitive-write-gate-v3.property.test.ts, run with its .test.ts and
.property.test.ts siblings; "discriminated-union-lift / -root" = the two
composables files; "submit-related" = submit-success-semantics,
submit-clears-user-errors, submit-error-no-rethrow, submit-throw-surfaces,
form-meta-submitted; optimistic-connected exists in BOTH test/core and
test/ssr-bare-vue, both pinned; perf-lock = the whole directory, 6 files;
plus test/transforms/async-transform-store.test.ts for the stays-eager
bookkeeping).

Result: `pnpm test <47 files>` = 47 passed / 569 tests passed, 0 skipped.
Major coverage as pinned: 22 files carry explicit zod-v3 arms, 4 are
abstract-store (major-independent), the rest exercise v4/unified entries.
Every bucket has at least one v3 arm.

Perf baseline (mount + keystroke gate): recorded to
reference/p5-bench-before.json (52 scenarios, hz). Headlines: init flat
F=5/50/500 [v4] 12,580 / 3,671 / 307 hz ([v3] 17,278 / 4,679 / 457);
keystroke flat F=5/50/500 [v4] 328k / 306k / 161k hz; keystroke.bench
new-vs-old ratios 5.3x (100-leaf) and 10.6x (500-leaf) against the 3.0
floor. AFTER run: same machine, same command
(`pnpm bench bench/matrix.bench.ts bench/keystroke.bench.ts`); the hard
gate is the 3x check-bench floor plus no-regression on init + keystroke
outside run noise (~10%).

## Findings (2026-08-23, phase complete)

Commits: 5a pin b6e9704f -> 5b kernel record 61c1df17 -> 5c one-diff
9bf1e7ea -> 5d tagged store 9c7ccf64 -> 5e+5f capability/stamp a944885e
-> phase-final gates commit. Per-slice eager deltas, all measured on the
check:eager ratchet methodology:

| slice | delta (B gz) | what it was                                        |
| ----- | ------------ | -------------------------------------------------- |
| 5b    | +265         | state record + module functions + method skins     |
| 5c    | -41          | double-diff delete (patches feed applyChangedKeys) |
| 5d    | +219         | tagged error store, net of the formKey drops       |
| 5e    | +56          | DU capability flag + du-stubs fold + one-clone     |
| 5f    | +62          | payload stamp + form-activation module split       |
| net   | **+561**     | 35,207 -> 35,768                                   |

**Why the size promise failed.** Three audit assumptions did not survive
measurement. (1) The kernel-record conversion is an enabler, not a
saving: the ~50 per-instance method skins cost ~265 B that a closure
body didn't. (2) The tagged error store's semantics-preserving machinery
(slot-stability rules, two-pass source-ordered enumeration, per-side
stripping) costs more than two thin maps — the formKey drops across both
adapters, the normalizers, and the hydration validator paid most of it
back but not all. (3) The activation lazy-chunk split is gzip-NEGATIVE
under the per-chunk consumer model: implemented and measured, the
cross-chunk import glue plus the loss of shared gzip context (~880 B)
exceeded the ~570 B of orchestrator + merge-hydration it moved out, and
a runtime import cycle between the kernel and the chunk cost a further
~340 B until broken. The split was REVERTED; `fireFactory` keeps the
orchestrator eager with the sync gating flips. This is a standing
lesson for P6-P10: a lazy move only pays when the moved bytes clearly
exceed ~0.5-1 kB of split overhead, and the audit's remaining
expectations (P6 ~31,400 ... P10 ~25,870) need re-anchoring from
35,768 with that discount applied.

**What the phase delivered instead.**

- Perf (reference/p5-bench-before.json vs p5-bench-after.json, same
  machine/command): keystroke deep D=3/8/16 **+14.5% / +26% / +50%**
  (the hasDU skip retired the per-write ancestor DU probes), keystroke
  array N=10/100/1000 +8-12% (one content diff per structural write),
  flat F=5 +8%; init within run noise; no scenario regressed beyond its
  established variance; check-bench 3.0x floors comfortably green.
- Construction takes ONE clone walk instead of two (non-DU forms skip
  the stub walk outright; DU forms keep the pre-stub snapshot for field
  seeding, per today's semantics).
- API (sign-off 5): `ValidationError` dropped per-entry `formKey`
  (envelope-level identity; every serialized SSR error entry is one key
  string lighter on the wire), `ErrorInput` dropped the
  accepted-and-ignored member, the store collapsed to one tagged
  `errorCells` map with three shared channel writers, and
  `HistoryKernel` snapshots cells via `restoreErrorCells`.
- SPI: optional `hasDiscriminatedUnions?()` capability probe (both
  adapters answer via their shared tree walks; absent reads true;
  undocumented on the adapter pages, matching hasContainerOrRootRefine's
  perf-hint treatment).
- Correctness: the hydration envelope carries a version stamp
  (ATTAFORM_STATE_VERSION; mismatch skips hydration wholesale with a
  dev warning — sign-off 9's stamp half).
- Construction = reset run through four shared primitives
  (computeBaselineResponse, seedOriginalsFromBaseline,
  initialFirstValidationGate, queueInitialAsyncValidation); reset keeps
  its lazy ordinal assignment (`ensureOrdinals: false`).

**Deviations from the brief.** hasTransforms/hasArrays capability flags
NOT built: transforms register per-`register()` call (the existing
`transformRuns.size` guard IS the correct dynamic gate) and the array
paths were already meta-gated. The write funnel's gate/strip/complete/
authored walks stay separate functions: for the scalar keystroke hot
path each is O(1), and a fused walker would be net-new code. The
"one module" DU fold landed as du-stubs folding INTO the kernel (its
only consumer); reshape + guard already live there post-5b.
scheduleFieldValidation/applyFormReplacement remain kernel-internal
(the skins carry the store contract; no consumer call sites changed in
this phase).

**Gates moved (this commit).** check:eager 35_650 -> 36_200 (measured
35,768 — the one RAISE in the program, reasons recorded in the script);
size-limit: whole-entry index/zod 55.5 -> 56.25 (@55.63), zod-v4
49.5 -> 50 (@49.52), zod-v3 50.75 -> 51.25 (@50.77), abstract
39.75 -> 40.25 (@39.81); scoped zod/barrel {useForm} 42.25 -> 42.75
(@42.25), zod-v4 36.25 -> 36.75 (@36.19), zod-v3 37.75 -> 38.25
(@37.62), abstract 27.25 -> 27.75 (@27.36).
