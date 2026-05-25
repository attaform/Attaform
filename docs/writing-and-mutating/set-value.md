---
title: setValue patterns
description: form.setValue is the programmatic write surface, set the whole form, one path, or a segment-tuple, with values or a callback. Every directive write flows through the same pipeline.
metaRows:
  - label: Category
    value: Return method
  - label: Signatures
    value: setValue(value) · setValue(path, value) · setValue(segments, value)
    kind: code
  - label: Callback form
    value: (prev, ctx) => next
    kind: code
  - label: Returns
    value: boolean
    kind: code
---

# `setValue` patterns

> The programmatic write surface: three call shapes, a callback option, and the `unset` sentinel for flagging any path blank.

::docs-meta-table
::

Click the four buttons in the demo to exercise every `setValue` shape: string path, segment tuple, callback, whole-form. The reactive surface (`values`, `fields`, validation) updates the same way it does for directive-driven writes; `setValue` and `v-register` share the pipeline. The [Three call shapes](#three-call-shapes) section unpacks each form.

::docs-demo{slug="set-value" label="Set Value Demo"}
::

## Three call shapes

`setValue` accepts whatever shape fits the write site. Each example below assumes a `form` handle from `useForm({ schema })`:

```ts
const form = useForm({ schema })

form.setValue({ name: 'Ada', age: 30 }) // whole-form
form.setValue('profile.email', 'a@b.c') // dotted path
form.setValue(['profile', 'email'], 'a@b.c') // segment tuple
```

The dotted-path form is the most ergonomic for plain object schemas. The segment-tuple form sidesteps the dotted-key collision (a schema key that contains a literal `.`) and gives TypeScript precise typed-tuple inference. The whole-form shape replaces every path at once: useful for hydrating from a server response or applying external state.

## Callback form

Pass a function to read the current value and return the next:

```ts
form.setValue('count', (prev) => (prev ?? 0) + 1)
form.setValue('tags', (prev) => [...prev, 'new-tag'])
form.setValue(['profile', 'name'], (prev) => prev.trim().toLowerCase())
```

The callback receives the current value at the path; its return value lands in storage. Equivalent to reading `form.values.<path>`, computing the next value, and writing it, in one atomic step.

## Returns `boolean`

`setValue` returns `true` when the write was accepted, `false` when it was rejected by the slim-type gate (value didn't match the leaf's accept set). Reach for the return value when a downstream action depends on the write succeeding:

```ts
if (form.setValue('age', 21)) {
  /* proceed */
}
```

## Same pipeline as `v-register`

Every `setValue` call flows through the same write pipeline as the directive: slim-type gating, dirty / touched tracking, persistence, multi-tab sync, history. The reactive surface (`values`, `fields`, validation) reacts identically. No "programmatic writes are second-class" carve-out.

The one difference: `setValue` writes are **never coerced**. Coercion is for user-typed DOM strings; values you pass to `setValue` are already typed at the call site (TypeScript checks it), so coercion would be a no-op at best and a footgun at worst.

## Flagging a path blank

To flag a path as displayed-empty, pass the `unset` sentinel. The runtime writes the schema's slim value at that path and joins the path to `form.blankPaths` so the bound input renders empty.

```ts
import { unset } from 'attaform/zod'

form.setValue('middleName', unset) // storage holds '', form.blankPaths has 'middleName'
form.setValue('profile', unset) // recursive, marks every primitive descendant
form.setValue('cargo', unset) // DU stub, writes { kind: '' } with no variant body
```

`unset` works at every path the consumer can address: primitive leaves, containers, arrays, tuples, records, discriminated unions, wrappers, and the root. See [the `unset` page](/docs/writing-and-mutating/unset) for the full contract.

## Where to next

- [`reset` & `resetField`](/docs/writing-and-mutating/reset): restore defaults instead of just writing.
- [`clear`](/docs/writing-and-mutating/clear): write blank values without going through defaults.
- [Field-array mutations](/docs/writing-and-mutating/field-arrays): append, insert, remove, swap, move, replace, prepend.
- [`unset`](/docs/writing-and-mutating/unset): the blank-anywhere sentinel for `defaultValues`, `setValue`, and `reset`.
