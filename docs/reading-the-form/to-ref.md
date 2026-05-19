---
title: toRef
description: form.toRef hands you a Readonly<Ref<T>> at any schema path, for the rare consumer that needs a Vue ref instead of the values Proxy.
metaRows:
  - label: Category
    value: Return method
  - label: Signature
    value: toRef(path) | toRef(segments)
    kind: code
  - label: Returns
    value: Readonly<Ref<T>>
    kind: code
  - label: Reactive
    value: 'Yes'
---

# `toRef`

> The ref-shaped escape hatch, for the rare consumer that needs `Ref<T>` instead of the Proxy.

::docs-meta-table
::
`form.toRef(path)` returns a `Readonly<Ref<T>>` whose `.value` tracks the storage at `path`. Reach for it only when an outside surface needs the ref shape. For normal reads, `form.values.<path>` is always the right call.

## When to use it

External composables, watchers, and DevTools probes sometimes expect a `Ref` rather than a Proxy property:

```ts
const schema = z.object({
  email: z.email(),
})

const form = useForm({ schema })

const emailRef = form.toRef('email') // Readonly<Ref<string>>

// Hand off to a composable that takes a Ref
useExternalComposable(emailRef)

// Watch a single path explicitly
watch(emailRef, (next) => {
  /* respond to email changes */
})
```

For everything else (templates, computed reads, conditional rendering) prefer `form.values.email` directly. The Proxy is reactive without ceremony; `toRef` is for ref-shaped interop only.

## Two call forms

`toRef` accepts either a dotted path or a segment tuple. Both resolve to the same leaf:

```ts
form.toRef('profile.email')
form.toRef(['profile', 'email'])
```

The tuple form sidesteps the dotted-key collision (a schema key containing a literal `.`) and gives TypeScript a precise typed-tuple inference path. The dotted form is shorter and idiomatic for plain object schemas. Pick whichever matches the surrounding code's grammar.

## Read-only by contract

`toRef` returns `Readonly<Ref<T>>`. Writes go through the same paths every other consumer uses:

```ts
form.setValue('email', 'a@b.c') // imperative write
form.register('email') // bound writes via v-register
form.append('todos', {
  /* … */
}) // structural writes
```

The library tracks dirty, touched, and validation state through those write paths. Assigning to `.value` directly throws; `toRef` is a read handle, not a backdoor.

## Reactivity contract

`toRef` returns a `ComputedRef`-equivalent shape: reads inside reactive scopes track the path, and consumers re-run when storage at `path` changes. Two refs to the same path share reactivity; they don't double-subscribe.

```ts
const refA = form.toRef('email')
const refB = form.toRef('email')

// refA.value === refB.value, always.
// One storage write triggers both refs' subscribers.
```

The same path-precise reactivity Vue offers on `form.values.email`, just wrapped in a `Ref`.

## Where to next

- [`values`](/docs/reading-the-form/values): the Proxy you should reach for first, before `toRef`.
- [`fields`](/docs/reading-the-form/fields): the per-leaf reactive surface for state bits, not just values.
- [The form](/docs/reading-the-form/the-form): every other reactive read on the return shape.
