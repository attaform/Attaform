# P6: validation shell fold — DONE 2026-08-23

**OUTCOME: measured 35,621 B gz, -147 against the -250..-500 band.** All
three slices shipped behavior-verbatim plus the one approved API change
(sign-off 4 retired); full suite 4,727 green, typecheck clean,
bundled-types both majors, doc-snippet gate at its 7 pre-existing
tolerated mismatches, perf spot-check PASSED. Commits: 8d1c059c (pin),
17df55d4 (6a), fd450d96 (6b), 419aa3c8 (6c), + the boundary gates commit.

## Findings

- **Delta -147 vs the -250..-500 band — and the reason is a standing
  lesson**: gzip already compresses near-identical code to almost
  nothing, so folding TEXTUAL twins (the three counter/throw shells were
  each other's best compression context) buys far less than source-line
  counting suggests. Only deleting structurally redundant logic moves
  the ratchet. This is now a program rule alongside P5's split-overhead
  and semantics-preservation discounts.
- 6a shipped a real correctness win beyond dedup: the old handleSubmit
  finally-branch could decrement a CONCURRENT validate() run's
  `activeValidations` count when a throw landed before its own inline
  increment (counter theft). `withActiveValidation` pairs the decrement
  lexically with its increment; the path is gone.
- 6b's blast radius was the docs, not the runtime: 10 docs pages (the
  validation-lifecycle page restructured around two entry points), both
  demos, the llms template, bench-arena's three adapter files, ~26 test
  files. The bundled-types gate then surfaced TWO latent items the
  fresh dist exposed: the set-errors fixture still exercised P5's
  deleted per-entry formKey (fixed), and the doc-snippet gate had been
  typing docs against a STALE dist (the P5 stale-dist trap, third
  sighting — both gates type against dist/, rebuild before trusting
  either). A new generic-wrapper fixture arm now locks the parse
  overloads under a free generic form (the autosave shape).
- Perf spot-check vs reference/p5-bench-after.json: flat +1..+8%, deep
  D=3/8/16 +11/+5.7/+0.7%, array N +3..+6%, submit cycle within noise;
  the blank-flat F=50 one-run collapse re-ran isolated at +3.5% (the
  known GC artifact class from P5).
- Gates moved: BUDGET_GZ 36_200 -> 36_050 (recorded in-script); 8
  size-limit caps tightened with P6 notes (index/zod 56, zod-v4 49.75,
  zod-v3 51, scoped 42.5/36.5/38, barrel 42.5).
- The two refuted items below stayed refuted; no code motion happened
  for either.

Detailed 2026-08-23 against anchor 35,768 B gz (P5 final, commit b996a725),
under the re-anchor ruling in 00-program.md. Expected band **-250..-500 B gz**
(honest; the original -650 assumed items P5 evidence has since refuted).
Behavior verbatim except the ONE approved API change (sign-off 4). Both zod
majors. Perf gate: no keystroke/submit regression vs
reference/p5-bench-after.json.

## What this phase is now

The audit's P6 had five items. Two are gone before we start: the sign-off-5
formKey drop ALREADY SHIPPED in P5 (9c7ccf64), and two more are REFUTED by
P5 measurement (recorded below, no code motion). What remains is one small,
high-certainty phase: fold the three duplicated imperative-validation shells,
land `parse(path?, { commit? })` absorbing `validateAsync` (sign-off 4), and
sweep three micro-duplications.

## Refuted items (recorded; do NOT implement)

- **Invalid-submit focus-policy lazy chunk**: `applyInvalidSubmitPolicy`
  (process-form.ts) is ~25 lines — far below the ~880 B cross-chunk glue P5
  measured for a new async chunk. Stays eager. Counted-once guard in
  00-program.md is moot.
- **display-state + display-engine file merge**: both dist and the eager
  measurement bundle scope-hoist (rollup/esbuild), so merging two modules
  into one file moves ~0 bytes. A merge only pays when it DELETES duplicated
  logic; these two share none (pure reducer policy vs clock/timer owner).
  No file motion.

## Characterization gate (pin FIRST, test-only commit if anything new)

The P5 pin battery is green at b996a725 and covers the submit/error-order
surface. P6's gate adds the validateAsync-behavior contract that must
survive verbatim into `parse(path, { commit: true })`:

- commits the refinement verdict to the schema-error store at the validated
  scope (stale entries drop, slot order preserved — applySchemaErrorsForSubtree)
- cancels in-flight per-field validation (a late SFV write cannot clobber it)
- composes derived-blank errors into the response, scoped to the path
- adapter-throw -> `{ success: false, errors: [{ code: AdapterThrew }] }`,
  never a rejection
- `activeValidations` (meta.validating) increments for the run, Math.max
  clamp on the way down
- plain `parse(path?)` stays a PURE read: no cancel, no commit (existing
  tests already pin this)

Suites to run green before and after every slice: test/core/process-form,
submit-semantics, first-error/own-errors/error-order files, display-state +
display-reducer, validation lifecycle files, plus the two adapters'
validate suites. Full `pnpm test` + `pnpm typecheck` at the phase end.

## Slices

### 6a: one imperative shell (internal only, no API change)

process-form.ts holds THREE copies of the counter/throw shell:

1. `validate()`'s `kickoff` — increment, pending-write, refinement,
   adapter-throw translation, compose, finally-decrement.
2. `runImperativeValidation` — increment, optional cancel, refinement,
   optional commit, adapter-throw translation, finally-decrement.
3. `handleSubmit`'s inline pass — increment, refinement, manual decrement +
   `validationSettled` flag replayed in the outer finally.

Fold: a `withActiveValidation(state, fn)` wrapper owning increment /
finally-clamped-decrement, and route ALL THREE through it. handleSubmit's
`validationSettled` dance deletes outright (try/finally subsumes it).
`kickoff` keeps its pending-write + generation guard locally (they are
reactive-shell concerns, not validation concerns) and consumes the shared
core for the rest: its catch-arm result is exactly
`settled(adapterThrowResponse(err))` — same shape, one construction site.
Ordering stays verbatim: increment BEFORE the pending-write inside the
guarded region (a sync watcher throw on either still decrements).

### 6b: `parse(path?, { commit? })` absorbs `validateAsync` (sign-off 4)

Pre-1.0, no back-compat: `validateAsync` is DELETED, not aliased.

- `parse(pathInput?, options?: { commit?: boolean })`. First-arg dispatch
  mirrors the setErrors/setValue house idiom (path-shaped = string | array;
  a lone plain-object first arg is the options bag), so whole-form commit is
  `parse({ commit: true })`, not `parse(undefined, {...})`.
- `commit: true` = the old validateAsync flags (cancelInFlight +
  commitToSchemaErrors) with data RETAINED — return type stays
  `Promise<ValidationResponse<GetValueFormType>>` in both modes.
- Delete: public `validateAsync` (types-api UseFormReturnType member, the
  build-form-api skin + gated() wrap, the process-form builder export),
  `stripData`, and `ValidationResponseWithoutValue` IF no other user
  remains (check \_shared-exports; it is public API, deletion is part of the
  approved change).
- `form.interact()` internally rides `parse(path, { commit: true })`
  semantics (same flags it gets from validateAsync today).
- Docs sweep: ~12 docs pages + reference/types.md name validateAsync;
  demos autosave/useAutosave.ts + validation-lifecycle/App.vue; check
  whether public/llms.txt regenerates or needs a source edit. Tests: ~26
  files migrate call sites; tests asserting the stripped-data shape reframe
  to the retained-data shape.
- Wizard: grep for validateAsync in use-wizard (whole-list handleSubmit
  path) and migrate the same way.

### 6c: micro-dedup sweep

- `pathStartsWith` (process-form.ts) duplicates `isPathPrefix` (paths.ts):
  delete, import. (Object.is vs === per segment differs only for NaN/-0
  segments, which canonical paths never hold.)
- `groupErrorsByKey` (kernel-internal, create-form-store.ts) duplicates the
  submit-throw `byPath` grouping (process-form.ts): move the pure helper to
  errors.ts, both import it. Submit path re-derives segments per bucket via
  `segmentsForPathKey(key)` (canonical keys just produced — never null; keep
  the null-skip guard anyway per no-uncaught-exceptions).
- DEV-gate the display-engine introspection hooks: `size()` / `has()` /
  `hasTimer()` become optional members assigned only under `__DEV__` (tests
  run the dev flavor; runtime uses only resolve/clear/dispose — verified by
  grep).

## Exit criteria

- Full `pnpm test` + `pnpm typecheck` green; `pnpm check:bundled-types`
  both majors (types-api changed); doc-snippet gate (docs changed).
- Ratchet run; BUDGET_GZ tightened to lock the measured number with the
  recorded reason; .size-limit.js caps tightened in the same commit.
- Perf spot-check vs reference/p5-bench-after.json (keystroke + submit
  scenarios; expect noise-level).
- Ledger row updated with the MEASURED delta; attribution regenerated;
  P8 stub fleshed out from its reference/rep sketches; commit; /compact.
