---
title: Performance
description: Measured numbers for keystrokes, validation, submit, resets, and the array helpers. Sub-500-leaf forms don't surface in profiling; the patterns to watch on bigger forms.
metaRows:
  - label: Category
    value: Reference
  - label: Default
    value: no tuning under 500 leaves
  - label: Sweet spot
    value: 500 – 5,000 leaves
  - label: Frame budget
    value: 16.7 ms @ 60 fps
---

# Performance

> Notes on the hot paths and what to look at if a form starts feeling slow. Measured numbers, sizing guidance, and the array-helper gotcha worth knowing.

::docs-meta-table
::

This page is reference material; no demo. The benches live in the repo and CI runs them on every PR, so they stay honest about the code they ship beside.

## Measured numbers

These come from `pnpm bench`, the microbenchmark suite under [`bench/`](https://github.com/attaform/Attaform/tree/main/bench). They run under Vitest on Node, single-threaded, against a mounted form. For browser numbers, and for how Attaform lands against other Vue form libraries on the same scenarios, see [Benchmarks](/docs/comparison/benchmarks). Your machine will sit elsewhere on the number line; the shapes below are what carry over.

| Operation                                               | Cost                 |
| ------------------------------------------------------- | -------------------- |
| Scalar write, flat form of 5 / 50 / 500 fields          | 3.6 / 3.8 / 3.9 µs   |
| Scalar write at path depth 3 / 8 / 16                   | 5.8 / 9.4 / 16 µs    |
| Row-field write, array of 10 / 100 / 1,000 rows         | ~5.5 µs              |
| Validation on that write (`validateOn: 'change'`)       | +3.5 µs              |
| Same write with `debounceMs: 200` (steady-state typing) | +1.2 µs              |
| Submit lifecycle (validate → onSubmit → setErrors)      | 9.8 µs               |
| Discriminated union, write inside the active variant    | 8.0 µs               |
| Discriminated union, cross-variant flip                 | 29 µs                |
| Cold form construction, 5 / 50 / 500 fields             | 0.08 / 0.23 / 2.5 ms |
| `reset()`, 100-leaf object form                         | 255 µs               |
| Field-array append, 100 / 1,000 items                   | 0.47 / 0.61 ms       |
| Field-array swap, 500 items                             | 0.42 ms              |
| Path canonicalization, cache hit                        | 36 ns                |

A 60 fps frame is **16.7 ms**. A keystroke lands three orders of magnitude inside it, and Vue's render gets the rest of the frame.

The first row is the one to read twice: **a write costs the same on a 500-field form as on a 5-field one.** Attaform writes through the path you name, so the cost tracks how deep that path goes, not how much else the form holds. Row 3 says the same thing about array length. Breadth shows up in cold construction and in whole-form validation, not on the keystroke.

## Hot-path characteristics

- **Writes**: `setValue` walks only the named path's subtree, which is why the flat-form row holds across a 100x range in field count. [`bench/matrix.bench.ts`](https://github.com/attaform/Attaform/blob/main/bench/matrix.bench.ts) sweeps field count, depth, and array width against a mounted form.
- **The diff writer**: [`bench/keystroke.bench.ts`](https://github.com/attaform/Attaform/blob/main/bench/keystroke.bench.ts) holds the patch-emitting writer against the whole-form flatten it replaced, and is the one bench CI gates on ratio rather than absolute cost.
- **`form.meta.dirty`**: iterates the tracked leaves with no per-leaf parse cost. Each entry stores its own path segments, so the walk never re-parses a path key.
- **Path resolution**: dotted-string paths are cached (128 entries, FIFO eviction), so repeat canonicalization reduces to a map lookup.

Sub-500-leaf forms don't surface in profiling.

## Sizing guidance

| Scale              | Guidance                                                                                                                                                                 |
| ------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| ≤ 500 leaves       | Default. No tuning needed.                                                                                                                                               |
| 500 – 5,000 leaves | Still fine. Typing does not get slower; what grows is cold construction and any whole-form aggregate you render in a hot scope.                                          |
| 5,000+ leaves      | Consider splitting into sub-forms with distinct `key`s, composed via [`injectForm`](/docs/cross-cutting-state/inject-form) or [`useWizard`](/docs/multistep/use-wizard). |

## Array helpers are O(N)

`append` / `prepend` / `insert` / `remove` / `swap` / `move` all copy the target array before mutating. That's cheap in the common case (dozens of items), fine at hundreds, but **quadratic if you loop `append` to seed a large list**. For a large seed, assign the whole array in one shot:

```ts
form.setValue('items', preBuiltArray) // O(N): one allocation
```

For incremental population (the user appends one item at a time), per-append cost is the only thing that matters and the amortized total is linear over the user's interactions.

## Keying `v-for` rows

Use a stable per-row key: either an ID carried on the data or a client-generated `crypto.randomUUID()` stored when you append. Keying by index re-renders more than necessary when rows move and flickers focus / scroll state on reordered rows.

```vue
<!-- Good: stable key follows the item -->
<div v-for="item in form.values.items" :key="item.id">…</div>

<!-- Avoid for reorderable lists: index changes when items move -->
<div v-for="(_, i) in form.values.items" :key="i">…</div>
```

The index pattern is fine for append-only or short-lived lists; reach for stable IDs when the list can reorder.

## Discriminated unions vs. plain unions

A discriminated union reads the discriminator and validates exactly one branch. A plain `z.union` has no such key, so it works through its options to find one that fits, and a failing value is the case where it works through all of them. The gap widens with the branch count. Reach for `z.discriminatedUnion` whenever the variants share a literal key; it is faster, and it also gives Attaform the [reshape and variant-memory behaviour](/docs/schemas/discriminated-unions) a plain union cannot support.

## `form.meta.dirty` in hot templates

`form.meta.dirty` is a whole-form aggregate; it invalidates whenever any tracked leaf's `updatedAt` ticks. If you render it in a hot path (a header that re-renders on every keystroke), derive a more specific predicate instead:

```ts
// Faster than gating on the whole-form form.meta.dirty:
const isEmailDirty = computed(() => form.fields.email.dirty)
```

The pattern: read at the smallest granularity that gives you the answer you need.

## Reset cost

`reset()` is sub-millisecond on a 100-leaf form (~255 µs in the suite; see the table above). It is the one whole-form rebuild in the write API, so unlike a keystroke it does scale with leaf count. `resetField(path)` scales with the subtree instead; prefer it for localized reversions.

## Benching your own form

Clone the repo and drop a bench in `bench/`:

```ts
import { bench, describe } from 'vitest'
import { z } from 'zod'
// import your form setup

describe('my form: typical interaction', () => {
  bench('the operation I care about', () => {
    // ...
  })
})
```

Run with `pnpm bench`. The regression gate only fires on benches that follow the `old: / new:` pairing convention; informational benches run without gating.

## Peer-dep coverage

Per-PR CI runs the suite on whichever Node release is current LTS at run time, pinned as `lts/*` rather than a version number so it rolls forward on its own; the `engines.node` floor is Node 22, with no upper bound. A weekly workflow sweeps Vue 3.5 through 3.6, Vite 5 / 6, Nuxt 3.16 through Nuxt 4. Jobs fail independently; versions not yet released surface as failed cells without blocking the main CI.

## Where to next

- [Benchmarks](/docs/comparison/benchmarks): the same scenarios run across the Vue form-library field, with bundle size, supply-chain scores, and per-scenario runtime tables.
- [Field-array mutations](/docs/writing-and-mutating/field-arrays): the O(N) characteristics in full, including amortized analysis.
- [How values are stored](/docs/schemas/storage-shape): the slim write shape that keeps reads fast.
- [SSR hydration: Nuxt](/docs/server-and-ssr/ssr-nuxt): hydration costs depend on form size; pair this page with the SSR pages when sizing.
