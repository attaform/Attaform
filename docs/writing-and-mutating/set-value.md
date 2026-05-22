---
title: setValue patterns
description: form.setValue is the programmatic write surface — set the whole form, one path, or a segment-tuple, with values or a callback. Every directive write flows through the same pipeline.
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

> The programmatic write surface — three call shapes, a callback option, a sentinel for absent.

::docs-meta-table
::

Click the four buttons in the demo to exercise every `setValue` shape — string path, segment tuple, callback, whole-form. The reactive surface (`values`, `fields`, validation) updates the same way it does for directive-driven writes; `setValue` and `v-register` share the pipeline. The [Three call shapes](#three-call-shapes) section unpacks each form.

::docs-demo{slug="set-value"}
::

## Three call shapes

`setValue` accepts whatever shape fits the write site:

```ts
form.setValue({ name: 'Ada', age: 30 }) // whole-form
form.setValue('profile.email', 'a@b.c') // dotted path
form.setValue(['profile', 'email'], 'a@b.c') // segment tuple
```

The dotted-path form is the most ergonomic for plain object schemas. The segment-tuple form sidesteps the dotted-key collision (a schema key that contains a literal `.`) and gives TypeScript precise typed-tuple inference. The whole-form shape replaces every path at once — useful for hydrating from a server response or applying external state.

## Callback form

Pass a function to read the current value and return the next:

```ts
form.setValue('count', (prev) => (prev ?? 0) + 1)
form.setValue('tags', (prev) => [...prev, 'new-tag'])
form.setValue(['profile', 'name'], (prev) => prev.trim().toLowerCase())
```

The callback receives the current value at the path; its return value lands in storage. Equivalent to reading `form.values.<path>`, computing the next value, and writing it — but in one atomic step.

## Returns `boolean`

`setValue` returns `true` when the write was accepted, `false` when it was rejected by the slim-type gate (value didn't match the leaf's accept set). Reach for the return value when a downstream action depends on the write succeeding:

```ts
if (form.setValue('age', 21)) {
  /* proceed */
}
```

## Same pipeline as `v-register`

Every `setValue` call flows through the same write pipeline as the directive — slim-type gating, dirty / touched tracking, persistence, multi-tab sync, history. The reactive surface (`values`, `fields`, validation) reacts identically. No "programmatic writes are second-class" carve-out.

The one difference: `setValue` writes are **never coerced**. Coercion is for user-typed DOM strings; values you pass to `setValue` are already typed at the call site (TypeScript checks it), so coercion would be a no-op at best and a footgun at worst.

## Setting to absent

For optional fields whose presence (rather than value) matters, pass the `unset` sentinel — see the [unset page](/docs/writing-and-mutating/unset) for the full pattern.

```ts
import { unset } from 'attaform/zod'

form.setValue('middleName', unset) // not '' — actually absent
```

## Where to next

- [`reset` & `resetField`](/docs/writing-and-mutating/reset) — restore defaults instead of just writing.
- [`clear`](/docs/writing-and-mutating/clear) — write blank values without going through defaults.
- [Field-array mutations](/docs/writing-and-mutating/field-arrays) — append, insert, remove, swap, move, replace, prepend.
- [`unset`](/docs/writing-and-mutating/unset) — the absent sentinel for optional fields.
