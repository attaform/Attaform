# Attaform Runtime Performance Program

Status: **DRAFT for ratification** (v0.21.2 baseline, branch `perf/runtime-analysis`)

This is the living plan for the runtime-performance journey: the workload matrix
we measure on, the complexity ledger of blockers, the instrumentation we build,
and the safety net that lets us refactor internals without changing what a
consumer observes. It evolves as we profile (fills the `Measured` columns) and
bust (flips `Status`).

Bundle size is intentionally out of scope here: that measurement problem is
mature (`size-limit` over 10 bundles + the `check:eager` first-paint
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

> **Measured (first pass, 2026-06-08):** T2 **confirmed** (the keystroke
> prize), T1 **refuted**, T6 **confirmed**, T3 probing. Raw hz and the slope
> reads live in "First measurement pass" below; the theoretical Measured /
> Status cells above settle there until a committed baseline lands.

### Already optimal (leave alone)

- **Path resolution** — `canonicalizePath` is O(1) on cache hit (128-entry FIFO,
  `paths.ts:180-204`); real forms sit at ~100% hit rate. Do not touch.
- **Reactive notification granularity** — `fields` / `schemaErrors` Maps + `blankPaths`
  Set use Vue 3.5 collection tracking; a write to `email` does not wake sibling
  fields' computeds (`create-form-store.ts:1314-1399`). No over-notification at the
  store layer (P3 is about the _component_ layer, still to be probed).

---

### First measurement pass (matrix bench, 2026-06-08)

`bench/matrix.bench.ts` sweeps one axis at a time through the real public
`useForm` (SSR mount, both adapters) and reports absolute ops/sec. The first
run (vitest 4.1.8, in-container) already settles four ledger rows. Raw hz:

| Bench           | size   | ops/sec | per-op   |
| --------------- | ------ | ------- | -------- |
| init flat [v4]  | F=5    | 6,370   | 0.157 ms |
| init flat [v4]  | F=50   | 1,398   | 0.715 ms |
| init flat [v4]  | F=500  | 130     | 7.72 ms  |
| init flat [v3]  | F=5    | 11,865  | 0.084 ms |
| init flat [v3]  | F=50   | 2,981   | 0.335 ms |
| init flat [v3]  | F=500  | 282     | 3.55 ms  |
| keystroke flat  | F=5    | 73,660  | 0.014 ms |
| keystroke flat  | F=50   | 11,681  | 0.086 ms |
| keystroke flat  | F=500  | 1,019   | 0.981 ms |
| keystroke deep  | D=3    | 47,821  | 0.021 ms |
| keystroke deep  | D=8    | 23,510  | 0.043 ms |
| keystroke deep  | D=16   | 13,759  | 0.073 ms |
| keystroke array | N=10   | 40,571  | 0.025 ms |
| keystroke array | N=100  | 12,358  | 0.081 ms |
| keystroke array | N=1000 | 1,574   | 0.635 ms |

(keystroke sweeps run on v4; the structural write path is adapter-independent
when no union is touched.) Reading the slopes:

- **T2, CONFIRMED, the headline keystroke prize.** A single scalar write is
  O(F) flat (F=5 to F=500 is 72x slower for 100x the fields) and O(N) in arrays
  (N=10 to N=1000 is 26x). At F=500 / N=1000 one keystroke costs ~0.6 to 1.0 ms,
  which is user-perceptible. The diff-apply rewrite made the _diff_ O(changed),
  but a TARGETED `setValue` still pays O(siblings). Localized to two
  behavior-preservable sites:
  1. **Blank-descendant sweep** (`create-form-store.ts:2219`):
     `for (const k of [...blankPaths])` clones and scans the whole blank set on
     every write. A freshly-seeded form starts all-blank, so this is O(F) per
     keystroke, and for a LEAF (non-container) write it deletes nothing. Gating
     the sweep on a container value drops leaf writes to O(1) here.
  2. **`applyFormReplacement`** (`:1968` / `:1981`): `diffAndApply` plus
     `applyChangedKeys` re-derive the one changed key by walking all F root
     siblings. `setValueAtPath` already knows the path; a targeted single-leaf
     apply skips the re-derivation.
- **T1, REFUTED as a wall-clock blocker.** Deep zero-union writes scale ~O(D),
  in fact SUB-linearly (D=3 to D=16 is 3.5x for 5.3x the depth), not the
  predicted O(D^2). The guard's unconditional cost sits at the path-walk floor,
  and for flat writes it is skipped outright (`path.length >= 2`). It still
  slices ancestor paths O(D^2) in allocation (a P2 micro-cost, negligible at
  real depths). The guard's REAL-DU cost (S5 / S6) is a separate measurement.
- **T6, CONFIRMED.** zod v4 cold init is ~2x slower than v3 at every size
  (1.86x / 2.13x / 2.17x for F=5/50/500). Worth localizing: our v4
  introspection (walker-introspector / fingerprint / slim-primitives) vs zod
  v4's own parse.
- **T3, probing.** Init is ~O(F) as expected, but the double-parse is a
  constant ~2x factor a slope cannot see. Confirming it needs a direct A/B
  (single vs double parse) or an init parse-count probe, deferred to the
  alloc-probe slice.

Method notes: keystroke benches use `validateOn: 'submit'` to isolate the
STRUCTURAL write cost from validation scheduling; the render tree is a constant
`h('div')` so the init slope is Attaform's schema work, not Vue's. Numbers are
one machine / one run (rme <= ~9%); they anchor SLOPE and order-of-magnitude,
not a committed regression baseline (that is the next dashboard slice).

### Bust 1: blank-descendant-sweep gate (2026-06-08)

`setValueAtPath`'s descendant blank-sweep (`create-form-store.ts:2219`) now runs
only when the PRE-WRITE value at `path` is a container, so a scalar leaf write
(the keystroke) skips the `[...blankPaths]` clone and scan. The pre-write read
is hoisted and reused by the identity short-circuit, so there is no extra walk.
Behavior is unchanged: full suite green (4118), behavior-lock goldens
byte-identical, and the `blank-mark-descendants` suite still pins
container-write descendant clearing (the `null`/`undefined`-clears-a-container
case still sweeps, because `currentValue` was the container).

This forced a methodology correction. Provided defaults are NOT blank-marked
(`schema-default-no-autoblank`), so the original matrix forms had an empty
`blankPaths` and never hit the sweep at all (0% change). The new
`keystroke blank-flat` scenario marks all F fields blank, the representative
fresh-form keystroke. Before / after on it (v4):

| F   | before (hz) | after (hz) | gain   |
| --- | ----------- | ---------- | ------ |
| 5   | 75,536      | 87,360     | +15.6% |
| 50  | 10,894      | 11,991     | +10.1% |
| 500 | 1,010       | 1,062      | +5.1%  |

So the sweep is real O(F) work but a MINORITY of the keystroke (~0.05 ms saved
at F=500). The dominant O(F) is `applyFormReplacement` (`:1968` diff plus
`applyChangedKeys` plus the `setAtPathWithSchemaFill` root-clone), which
re-derives the single changed key across all F siblings on a write whose path is
already known. That is the real keystroke prize and the next bust (a targeted
single-leaf apply); being the heavier, funnel-touching half, it gets a formal
design pass first.

### Bust 2: targeted in-place apply (2026-06-08)

The dominant O(F)/O(N) keystroke cost was `applyFormReplacement` rediscovering an
already-known path: `setAtPathWithSchemaFill` spreads `{...root}` (O(F)),
`diffAndApply` walks for patches (O(F)), `applyChangedKeys` diffs AGAIN for
changed segments (O(F)) and scans `Object.keys` for deletions (O(F)) — ~4 O(F)
passes to land `form.value.f3 = x`. Worse, it reassigned the WHOLE first-segment
container reference on every write (typing `rows.5.name` handed `form.values.rows`
a brand-new array): a container's reference churned on a descendant-leaf edit.

`applyTargetedWrite` (`create-form-store.ts`) takes a fast path when the target
leaf slot already exists: `tryInPlaceLeafWrite` (`path-walker.ts`) walks to the
leaf's parent (O(depth)) and mutates the slot in place, preserving every ancestor
container's identity, then `commitWritePatches` emits the exact per-leaf patches
the old root diff would have (it only ever descended this same subtree).
Structural writes (missing intermediate, array growth, new key, container target,
or a prototype-shadowed segment) fall back to the proven copy-on-write
`applyFormReplacement`, which correctly re-references the grown container.

**New contract (the one intended observable change):** a container's reference
changes IFF the write targets it or alters its structure. A descendant-leaf edit
preserves every ancestor reference. Deep watches and leaf watches are unchanged;
only a by-reference (non-deep) watch on a container stops firing on leaf edits
(it now fires only on structural change — strictly less over-firing). This was a
philosophical bug: the old "orphaned but unmutated" copy-on-write rationalized a
cost as a feature, but history / `prev` callbacks deep-clone (`structuralSnapshot`)
and never relied on it (reference-safety audit), and a grabbed `form.values.address`
silently went stale. In-place mutation fires the narrowest dep set, so it is also
strictly safer for the "pickup address" mirror-deadlock.

Behavior is otherwise byte-identical: behavior-lock goldens unchanged, full suite
green (4124), and the new `test/core/reactivity-contract.test.ts` (both adapters)
pins the contract — it doubles as the standing perf guard, since reverting to
copy-on-write re-churns container refs and fails it. Cost: +0.10 kB gz eager
(deliberate, the funnel is always-on); eager budget + zod-v3 size cap loosened
with a recorded reason.

Before / after, single scalar write, v4 (matrix bench):

| shape        | before (hz) | after (hz) | gain  |
| ------------ | ----------- | ---------- | ----- |
| flat F=5     | 88,004      | 277,311    | 3.2×  |
| flat F=50    | 11,965      | 258,541    | 21.6× |
| flat F=500   | 1,067       | 245,084    | 230×  |
| array N=10   | 46,631      | 176,708    | 3.8×  |
| array N=100  | 12,967      | 162,291    | 12.5× |
| array N=1000 | 1,622       | 170,668    | 105×  |
| deep D=16    | 14,942      | 51,024     | 3.4×  |

The keystroke is now O(depth): flat F=5→500 went from an 82× falloff to 1.13×
(flat), array N=10→1000 from 29× to 1.04× (flat). Deep stays O(D) (correct) but
~3× cheaper per level (no spread, no double-diff). Even small forms gain ~3× from
killing the root-spread + double-diff. **T2 BUSTED** across flat, nested, and
array; T1 (deep) confirmed already-O(D) and left alone.

### Bust 3: single-pass authored-path derivation (2026-06-09)

Construction (and `reset()`) learned which paths the schema author put a
`.default()` at by running the adapter's `getDefaultValues` TWICE — once with
`useDefaultSchemaValues: true` (the real initial data) and once with `false` (a
"slim baseline") — then diffing the two value trees (`rebuildAuthoredPaths` →
`walkAuthoredFromSchemaDiff`). Each pass clones the whole schema (`getSlimSchema`)
and runs zod `safeParse` (up to twice), and the slim call passed `strict: true`,
so it ALSO ran a full-schema strict parse whose errors were then discarded. The
second pass cost about as much as the first, all to produce a value tree to diff.

The diff only ever reads that value tree — never a validated parse of it — and the
raw blank tree is already exposed by the factory as `getEmptyValueAtPath([])`
(literally `deriveDefault(rootSchema, false)`): no clone, no parse. The swap is a
single line inside `rebuildAuthoredPaths`, which is the one source of the authored
baseline for both construction and reset. A direct probe measured the raw walk
**31.8× cheaper** than the full slim pass (F=500: 1.97ms → 0.062ms/op).

The blank baseline round-trips through the old slim parse as a structural no-op, so
the authored-path set — which feeds `filterAuthoredErrors`, i.e. which mount-time
verdicts a consumer sees — is unchanged. `test/core/authored-baseline-equivalence.test.ts`
proves `getEmptyValueAtPath([])` is `toStrictEqual` to the slim-parsed baseline AND
yields an identical authored set across the parity-sensitive shapes (`.default(x)`,
`.default('')`-equals-empty, `.default(undefined)`, `.catch()`, `optional(default)`,
array-of-objects, typed empties, discriminated-union seeding) on BOTH adapters. A
future drift between the two baselines fails that test (it would silently move
authored-path filtering). Behavior-lock goldens byte-identical, full suite green
(4164). No size impact: `getEmptyValueAtPath` was already eager, and a
`getDefaultValues` call left the eager path (47.35 kB, unchanged).

Before / after, end-to-end `init flat` (matrix bench):

| shape | v4 before | v4 after | v4 gain | v3 before | v3 after |
| ----- | --------- | -------- | ------- | --------- | -------- |
| F=5   | 5,881     | 7,955    | +35%    | 12,672    | 11,381   |
| F=50  | 1,699     | 2,217    | +30%    | 3,295     | 3,441    |
| F=500 | 146       | 184      | +26%    | 278       | 287      |

The win is **concentrated on v4** — exactly where T6 makes `safeParse` the
expensive part, so eliminating the redundant pass's parse saves the most — and it
NARROWS the v4/v3 init gap (F=500: 1.90× → 1.56×; F=50: 1.94× → 1.55×), partially
addressing T6 as a side effect. v3 is flat-to-small within noise: its cheaper parse
made the redundant pass a smaller slice of total init to begin with. **T3 BUSTED**
(the double-parse at init is gone); the residual single `deriveDefault(false)` walk
is ~3% of the eliminated pass.

### T4 measurement: whole-form revalidation under a container refine (scoped, 2026-06-09)

NOT a bust — a measure-and-scope. Unlike the free/internal T1–T3 wins, T4's fix ADDS
adapter surface, so it is gated on a design sign-off (see the decision below). The
refine-heavy shape is exactly Cubic Housing's cross-field-eligibility forms, so this
is load-bearing downstream.

**The cost.** When `hasContainerOrRootRefine()` is true the keystroke scheduler
cannot subtree-scope (`create-form-store.ts:2651`): every keystroke runs
`validateAtPath(form.value, undefined)`, a whole-form `safeParse`. A refine-free form
takes the subtree branch (`validateAtPath(getAtPath(form.value, path), path)`)
instead. The matrix bench group `validate … (T4 vs F)` is a component probe on that
exact primitive — the per-keystroke work is async-scheduled inside a microtask chain,
so an end-to-end loop would skew on un-flushed microtasks (the Bust-3 component-probe
discipline). Three cells per adapter, ops/sec:

| cell (ops/sec)                  | F=5   | F=50  | F=500 | slope 50→500 |
| ------------------------------- | ----- | ----- | ----- | ------------ |
| v4 whole-form **refined**       | 2.60M | 250k  | 17.8k | 14.0× (O(F)) |
| v4 whole-form plain (no refine) | 2.73M | 287k  | 18.1k | 15.8×        |
| v4 **subtree-leaf** (the floor) | 3.36M | 3.06M | 2.92M | ~flat (O(1)) |
| v3 whole-form **refined**       | 735k  | 115k  | 9.2k  | 12.4× (O(F)) |
| v3 whole-form plain (no refine) | 1.03M | 118k  | 10.0k | 11.7×        |
| v3 **subtree-leaf** (the floor) | 3.14M | 2.86M | 2.85M | ~flat (O(1)) |

Three reads:

1. **T4 is real — whole-form validation is O(F) per keystroke.** Throughput falls
   ~12–14× for a 10× field increase on both adapters. The subtree branch a refine-free
   form enjoys is **O(1)** (flat ~3M ops/sec across all F). Same-F, at F=500 the
   refine-heavy form pays **164× (v4) / 309× (v3)** the per-keystroke validation cost
   of a refine-free one; at F=50, **12× / 25×**.
2. **The refine itself is nearly free; the waste is the sibling re-parse.** Whole-form
   refined vs plain is within ~2% (v4) / ~8% (v3) at F=500 — the O(1) cross-field check
   adds almost nothing. **~92–98% of the whole-form cost is re-validating the F−1
   unchanged sibling leaves' own constraints**, pure redundancy on a single-field
   keystroke.
3. **T6 flips direction at runtime.** For _validation_ v4 is ~1.9× FASTER than v3 (the
   reverse of init, where v4's `safeParse` is the slower one). v3 is the worse keystroke
   case here (~0.108 ms/keystroke at F=500).

**The decomposition: proven byte-identical (Variant A″).** Narrowing WHICH refines run
is off the table — refines are opaque functions with no dependency manifest, so skipping
one risks dropping a verdict the consumer would have seen (an observable change,
violating constraint #1). The only byte-identical lever is to DECOMPOSE the whole-form
pass into (subtree leaf validation at the edited path, already O(1)) + (a refines-only
pass over whole-form data). zod can STRIP refines (`getSlimSchema`) but not the inverse,
so the refines-only pass needs a NEW adapter primitive — `getRefinesOnlySchema`, the
dual of the slim walker — at v3/v4 parity.
`test/perf-lock/t4-refines-only-equivalence.test.ts` is the go/no-go gate that proves the
decomposition sound BEFORE any runtime code, and it is GREEN (122/122, both adapters).

The load-bearing subtlety the gate resolved: zod runs an object refine only AFTER the
per-key parse and only if no leaf ABORTED (short-circuit), and the aborting-refine
keyword DIFFERS by adapter — `abort` in v4, `fatal` in v3 — with v3 burying the flag in
a closure where it is not statically inspectable. So a naive "strip all leaf validation"
reduction diverges on BOTH adapters (a suppressed root refine wrongly reappears). The fix
(Variant A″): the refines-only schema drops ONLY built-in format/range checks
(`.email`/`.min`/`.regex`, provably non-aborting) and KEEPS each leaf's base type,
coercion, and every custom `.refine`/`.superRefine`. Keeping custom refines reproduces the
abort short-circuit structurally — no fatal/abort detection, no gate, no whole-form
fallback — so v3 is handled identically to v4. The harness pins equivalence (13
adversarial scenarios incl. aborting leaf refines both spellings + password/confirm + 800
fuzz samples), necessity (the naive strip diverges — a standing guard if a future zod
renames a spelling), and non-vacuousness (the refines-only delta genuinely raises the
cross-field verdict).

**What A″ buys (and what it does not).** A″ keeps base types to reproduce the
short-circuit, so the refines-only pass is still O(F) base-type work — it sheds the
per-leaf built-in checks, nothing more. On a format-heavy flat form
(`flatRefinedFormatHeavy`, each leaf `.string().min(2).regex(...)`, one O(1) root refine),
measured ops/sec:

| cell (ops/sec, format-heavy)    | F=5   | F=50  | F=500 |
| ------------------------------- | ----- | ----- | ----- |
| v4 whole-form **full** (today)  | 1.13M | 89.0k | 6.36k |
| v4 **refines-only** (A″)        | 1.73M | 238k  | 15.6k |
| v4 A″ win (full ÷ refines-only) | 1.54× | 2.68× | 2.45× |
| v3 whole-form **full** (today)  | 665k  | 93.5k | 8.22k |
| v3 **refines-only** (A″)        | 641k  | 106k  | 9.87k |
| v3 A″ win (full ÷ refines-only) | 0.96× | 1.13× | 1.20× |

Two reads: (1) the win is a CONSTANT FACTOR, adapter-asymmetric — ~2.5× on v4 at scale,
~1.2× on v3 (T6 again: v4's built-in checks are a larger fraction of leaf-parse cost, so
shedding them helps more; v3's base `ZodString` parse dominates, so less is sheddable; at
F=5 the win is within noise). (2) A″ does NOT change the ORDER: refines-only at F=500
(15.6k v4 / 9.87k v3) is still ~190× / ~290× slower than the O(1) subtree floor (~3M)
above. The "92–98% redundant sibling re-parse" is only PARTIALLY recovered (the
built-in-check fraction); the base-type re-parse of all F siblings remains. A true O(1)
would need runtime abort-state sourcing (cached coerced values + per-leaf abort bits) — a
much larger surface, a much harder byte-identical proof (cache coherence across array ops
/ resets / DU reshapes × both adapters), and parity-fragile runtime issue-flag
introspection.

**Still open before runtime code.** The gate proves the safeParse-level verdict
decomposition; the SCHEDULER error-map bookkeeping (`applySchemaErrorsForSubtree`
clear/reapply over the new `subtree ∪ refine-paths` set, byte-identical to the whole-form
parse) is a SECOND obligation, not yet harnessed. **Decision pending Oswald's sign-off**
(reference-before-API-change): ship A″ for the constant-factor win (per-adapter
`getRefinesOnlySchema` + scheduler decomposition + the bookkeeping proof), or record T4 as
a measured-and-scoped non-action given the order stays O(F). Notes: the `flatRefined` bench
commit (97a6a05) landed with a red `pnpm typecheck` (TS4111 in the predicate) — the
pre-commit hook runs only eslint/prettier, not `tsc`, so bench/test TS errors can slip in;
fixed here. Table-cell reconciliation (T4 Evidence `:2604` has drifted to the alloc line;
the real seam is `:2651`) stays a separate noted follow-up.

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
