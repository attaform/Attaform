# Attaform Runtime Performance Program

Status: **DRAFT for ratification** (v0.21.2 baseline, branch `perf/runtime-analysis`)

This is the living plan for the runtime-performance journey: the workload matrix
we measure on, the complexity ledger of blockers, the instrumentation we build,
and the safety net that lets us refactor internals without changing what a
consumer observes. It evolves as we profile (fills the `Measured` columns) and
bust (flips `Status`).

Bundle size is intentionally out of scope here: that measurement problem is
mature (`size-limit` over 10 bundles + the `check:eager` 48.384 KB first-paint
gate) and its honest floor is already characterized. This program is about
**wall-clock, allocations, render work, and SSR/hydration cost.**

---

## Governing constraints

1. **No public API behavior change.** Every optimization is observationally
   identical: same values, errors, dirty/touched/displayState, `form.list` /
   `field.key` identity, reactivity timing, SSR HTML, hydration outcome. The
   **behavior-lock harness** (below) is the enforcement mechanism, not a promise.
2. **Zero runtime deps.** All measurement infra is dev-only (`vitest bench`,
   `esbuild`, node profilers). No new runtime/peer package.
3. **Adapter parity.** Every scenario runs against zod v3 AND zod v4. A win on
   one adapter that regresses the other is not a win.
4. **No one-time fixes.** Every bust ships with (a) a standing benchmark guard
   and (b) a behavior-lock test, so it cannot silently regress on a future install.
5. **Just-in-time bust design.** We lock this scaffold now. We do NOT pre-design
   the individual busts: each gets a quick design pass when picked, and anything
   touching the reactive-value-tree lever (T5) gets a reference-before-change loop.

---

## 1. The workload matrix

Performance is not one number. Attaform's cost scales on independent axes, and a
blocker only shows up under the scenario that stresses its axis. We measure the
cross-product of **scenarios x lifecycle phases**, capturing **four metrics** per cell.

### Axes

- **F** — field count (leaf count)
- **D** — nesting depth
- **N** — array length (field-array rows)
- **S** — schema complexity: density of discriminated unions, refines, transforms
- **adapter** — zod v3 vs zod v4

### Scenarios

| ID  | Name                  | Shape                                   | Stresses                                       |
| --- | --------------------- | --------------------------------------- | ---------------------------------------------- |
| S0  | tiny                  | 5 flat scalars, D=1                     | baseline / fixed overhead                      |
| S1  | medium                | ~50 fields, D=2-3, a few nested objects | typical form                                   |
| S2  | large                 | ~500 fields, D=3                        | F-scaling (T2 diff, T3 init)                   |
| S3  | deep                  | single chain, D≈10                      | D-scaling (T1 guard O(D²), path ops)           |
| S4  | wide-array            | 1 field array, N≈1000 rows              | N-scaling (diff, list keys, identity)          |
| S5  | DU-heavy              | nested discriminated unions             | the guard's _real_ purpose (justifies T1 cost) |
| S6  | refine-heavy          | container/root refines present          | T4 whole-form revalidation                     |
| S7  | transform-heavy       | many register transforms                | assigner-pipeline T-count                      |
| S8  | **production-anchor** | Cubic Housing worst-case (TBD)          | real-world truth, audit story                  |

> **Open:** S8 shape needs a real number from Cubic Housing (rough field count +
> depth + arrays). Until then S2/S3 stand in as synthetics.

### Lifecycle phases (measured per scenario)

`init` · `keystroke` (single scalar deep in the tree) · `blur` · `submit` ·
`reset` · `ssr-render` · `hydrate`

### Metrics (per cell)

- **wall-clock** — ops/sec (`vitest bench`) or ms
- **allocations** — heap bytes + object count per op (delta across N iterations)
- **render-work** — render-trigger count (Vue `onRenderTriggered`); doubles as the
  P3 over-render probe AND a behavior-lock signal
- **ssr/hydrate** — server render ms; hydrate ms + Vue mismatch-warning count

---

## 2. Complexity ledger (theoretical pass)

Predicted costs are from a **static read** (`create-form-store.ts`, `directive.ts`,
`paths.ts`, `assigner-pipeline.ts`) and are confirmed/refuted under the profiler in
the practical pass. A row is a **blocker** when its predicted cost exceeds its
information-theoretic floor for that operation.

| ID  | Hot path                                                                                         | Evidence                                    | Predicted                                         | Floor                                     | Class                                     | Measured | Status |
| --- | ------------------------------------------------------------------------------------------------ | ------------------------------------------- | ------------------------------------------------- | ----------------------------------------- | ----------------------------------------- | -------- | ------ |
| T1  | Cross-variant DU guard on every write                                                            | `create-form-store.ts:2057-2079`            | O(D²) per write, even with zero unions            | O(D), or O(1) via init "has-any-DU?" flag | free / internal                           | —        | open   |
| T2  | Full-tree diff on a single scalar write                                                          | `create-form-store.ts:1968-1970`            | O(F) worst                                        | O(D)                                      | free / internal                           | —        | open   |
| T3  | Double schema parse at init                                                                      | `create-form-store.ts:1231-1272`            | O(F·D) twice (with-defaults + without, then diff) | O(F·D) once                               | free / internal                           | —        | open   |
| T4  | Whole-form validation when container/root refine present                                         | `create-form-store.ts:2604`                 | O(F·D) per keystroke                              | O(deps-of-refine)                         | internal, possibly behavior-adjacent      | —        | open   |
| T5  | Deep reactive value tree (`ref(initialData)`)                                                    | `create-form-store.ts:1314`                 | O(F) proxy alloc + per-access traps               | shallow values + Map-driven reactivity    | **architectural lever** (reference-first) | —        | open   |
| T6  | Adapter parse-cost asymmetry                                                                     | adapters v3 vs v4                           | inherits adapter throughput                       | n/a (measure, don't assume)               | investigate                               | —        | open   |
| P1  | Per-keystroke alloc churn (fresh `FieldValidationEntry` + `AbortController`)                     | `create-form-store.ts:2551-2558`            | new objects every keystroke, no pool              | reuse per-field entry                     | free / internal                           | —        | open   |
| P2  | Repeated walks (guard `getAtPath`, blur-dedup snapshot clones taken even when dedup can't apply) | `create-form-store.ts:2057-2079, 2642-2646` | redundant O(D)/O(scope) work                      | conditional                               | free / internal                           | —        | open   |
| P3  | Over-render (components re-render on unchanged slice)                                            | needs render-trigger probe                  | unknown                                           | O(changed)                                | free / internal                           | —        | open   |
| P4  | Deferrable init work beyond eager-optional bytes                                                 | init path                                   | unknown                                           | lazy-on-interaction                       | free / internal                           | —        | open   |
| P5  | SSR per-field render cost at scale                                                               | transforms + getSSRProps                    | unknown                                           | O(F) unavoidable, constant bustable       | investigate                               | —        | open   |

### Already optimal (leave alone)

- **Path resolution** — `canonicalizePath` is O(1) on cache hit (128-entry FIFO,
  `paths.ts:180-204`); real forms sit at ~100% hit rate. Do not touch.
- **Reactive notification granularity** — `fields` / `schemaErrors` Maps + `blankPaths`
  Set use Vue 3.5 collection tracking; a write to `email` does not wake sibling
  fields' computeds (`create-form-store.ts:1314-1399`). No over-notification at the
  store layer (P3 is about the _component_ layer, still to be probed).

---

## 3. Instrumentation plan (the dashboard)

Today's gap: `check:bench` only computes `hz(new)/hz(old)` against a 3× floor
(`scripts/check-bench.mjs`). That proves a _migration_ beat the thing it replaced.
It does NOT track absolute throughput, allocations, render work, or SSR/hydrate
time, and it cannot catch slow drift. We extend, we don't replace:

1. **Absolute baselines** — record ops/sec per matrix cell; commit a baseline JSON.
2. **Regression band** — fail when a cell drifts worse than the band (width TBD,
   proposed ±15% to start) alongside the existing 3× pair gate.
3. **Allocation probe** — heap-delta + object-count around an N-iteration loop.
4. **Render-trigger probe** — count `onRenderTriggered` per scripted interaction.
5. **SSR/hydrate timing** — `renderToString` ms; hydrate ms + mismatch-warning count.

All five ride `vitest bench` / existing node tooling. No new dependency.

---

## 4. Behavior-lock harness (the safety net for constraint #1)

Golden-master characterization tests that freeze every observable across the
matrix, so internal refactors are _provably_ behavior-preserving. We already have
this muscle from the fallow refactor (strip / slim-primitives / errors-equal /
unset-walker characterization tests).

Per scenario, after a scripted interaction sequence, snapshot:

- `form.values` (full tree)
- `form.errors` (schema + user), absence semantics intact
- per-field `dirty` / `touched` / `displayState` / `show*` flags
- `form.list` ordering + `field.key` identity stability across mutations
- **reactivity timing** — the render-trigger trace (which effects re-run on a given
  write); this is simultaneously the P3 metric and a behavior lock
- SSR HTML (`renderToString`) per scenario
- hydration: zero mismatch warnings, value present pre-hydration (no flash)

These stay byte-identical through every bust. A diff is a bug (or, for T5, the
trigger for a reference-before-change conversation), not an accepted cost.

---

## 5. Execution order

1. **Ratify this doc** (matrix scenarios, regression band, the "leave alone" calls).
2. **Build harness + dashboard** (behavior-lock first, so the busts are safe; then
   absolute baselines + alloc + render-trigger + SSR/hydrate).
3. **Profile** the matrix; fill `Measured`; reconcile vs predicted. Practice >>
   theory = implementation bug; practice ≈ theory = architectural cost.
4. **Bust by impact × frequency:** keystroke > init > SSR/hydrate > submit/reset.
   Free/internal blockers first (T1-T4, P1-P5); **T5 last, reference-first.**
5. **Each bust:** quick design pass → implement → behavior-lock stays green →
   dashboard proves the win → standing guard added.

---

## Open questions

- **S8 production anchor:** Cubic Housing worst-case form shape (F, D, arrays)?
- **Regression band width:** ±15% to start, or tighter?
- **Render-trigger probe:** `onRenderTriggered` in a jsdom mount harness, or a
  lighter store-effect counter?
