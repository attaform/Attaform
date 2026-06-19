---
title: Performance
description: Measured numbers for keystrokes, validation, submit, persistence, and the array helpers. Sub-500-leaf forms don't surface in profiling; the patterns to watch on bigger forms.
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

> Notes on the hot paths and what to look at if a form starts feeling slow. Real-browser numbers, sizing guidance, and the array-helper gotcha worth knowing.

::docs-meta-table
::

This page is reference material; no demo. CI runs the benchmark suite under [`bench/`](https://github.com/attaform/Attaform/tree/main/bench) on every PR, so the numbers below come from a known-good environment and ride alongside the code.

For how Attaform compares across the Vue form-library field on the same scenarios, in a real browser, see [Benchmarks](/docs/comparison/benchmarks).

## Measured numbers

Real-browser numbers from `pnpm bench`, single-threaded on contemporary hardware. Your machine will land elsewhere on the number line; the orders of magnitude won't.

| Operation                                                     | Cost    |
| ------------------------------------------------------------- | ------- |
| Single-field keystroke, 100-leaf form                         | 6 µs    |
| Single-field keystroke, 500-leaf form                         | 30 µs   |
| Validation overhead per keystroke (`validateOn: 'change'`)    | 5 µs    |
| Submit lifecycle (validate → submit → setErrors)              | 3.4 µs  |
| Path canonicalization (cache hit)                             | 60 ns   |
| Sensitive-name check (common pattern, early hit)              | 70 ns   |
| Persistence write, `'local'` / `'session'` (100-leaf payload) | 2.8 µs  |
| Persistence write, `'indexeddb'` (100-leaf payload)           | 62 µs   |
| Debounced-writer schedule (steady-state typing)               | 0.18 µs |
| Discriminated union, write into active variant                | 19 µs   |
| Discriminated union, cross-variant flip                       | 25 µs   |
| Reset, 100-leaf object form                                   | 678 µs  |
| Field-array append, 100-item                                  | 2.5 ms  |
| Field-array append, 1000-item                                 | 9 ms    |
| Field-array swap on 500-item                                  | 3.9 ms  |

A 60 fps frame is **16.7 ms**. Single-keystroke work clears the budget by three orders of magnitude on a 100-leaf form and by two on a 500-leaf form; Vue's render gets the rest of the frame to itself.

## Hot-path characteristics

- **Keystrokes**: the `register` → form-state path runs against a per-PR threshold; see [`bench/keystroke.bench.ts`](https://github.com/attaform/Attaform/blob/main/bench/keystroke.bench.ts) for the measured scenarios (100-leaf and 500-leaf forms, single-leaf mutation).
- **`form.meta.dirty`**: iterates the tracked leaves with no per-leaf parse cost.
- **Path resolution**: dotted-string paths are LRU-cached (128 entries), so repeat canonicalization reduces to a map lookup.

Sub-500-leaf forms don't surface in profiling.

## Sizing guidance

| Scale              | Guidance                                                                                                                                                                 |
| ------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| ≤ 500 leaves       | Default. No tuning needed.                                                                                                                                               |
| 500 – 5,000 leaves | Still fine. Watch out for templates that render every leaf's `form.fields.<path>.dirty` in a hot scope.                                                                  |
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

Discriminated unions (`z.discriminatedUnion`) walk only the active branch. Plain unions (`z.union`) walk every branch unconditionally; use a DU when you have a shared key. The cost difference grows with the number of branches; for a 5-branch plain union, validation does 5x the work of the equivalent DU.

## `form.meta.dirty` in hot templates

`form.meta.dirty` is a whole-form aggregate; it invalidates whenever any tracked leaf's `updatedAt` ticks. If you render it in a hot path (a header that re-renders on every keystroke), derive a more specific predicate instead:

```ts
// Faster than gating on the whole-form form.meta.dirty:
const isEmailDirty = computed(() => form.fields.email.dirty)
```

The pattern: read at the smallest granularity that gives you the answer you need.

## Reset cost

`reset()` is sub-millisecond on a 100-leaf form (~680 µs in the suite; see the table above). `resetField(path)` scales with the subtree; prefer it for localized reversions.

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

Per-PR CI runs the suite on the current Node LTS (22.x today; the `engines.node` floor is Node 22) against the devDep-pinned peer versions. A weekly workflow sweeps Vue 3.5 through 3.6, Vite 5 / 6, Nuxt 3.16 through Nuxt 4. Jobs fail independently; versions not yet released surface as failed cells without blocking the main CI.

## Where to next

- [Benchmarks](/docs/comparison/benchmarks): the same scenarios run across the Vue form-library field, with bundle size, supply-chain scores, and per-scenario runtime tables.
- [Field-array mutations](/docs/writing-and-mutating/field-arrays): the O(N) characteristics in full, including amortized analysis.
- [How values are stored](/docs/schemas/storage-shape): the slim write shape that keeps reads fast.
- [SSR hydration: Nuxt](/docs/server-and-ssr/ssr-nuxt): hydration costs depend on form size; pair this page with the SSR pages when sizing.
