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

> Get a `Readonly<Ref<T>>` at any schema path, for the rare case a consumer surface expects a Vue ref instead of the values Proxy.

::docs-meta-table
::

`form.toRef(path)` returns a `Readonly<Ref<T>>` whose `.value` tracks storage at `path`. For normal reads (templates, computeds, conditional rendering), `form.values.<path>` is the right call. `toRef` is for ref-shaped interop only.

```ts
const schema = z.object({
  profile: z.object({ email: z.email() }),
  todos: z.array(z.object({ title: z.string() })),
})

const form = useForm({ schema })
```

## When to use it

External composables, watchers, and DevTools probes sometimes expect a `Ref` rather than a Proxy property:

```ts
const emailRef = form.toRef('profile.email') // Readonly<Ref<string>>

// Hand off to any third-party composable whose signature expects a Ref
useThirdPartyRefConsumer(emailRef)

// Watch a single path explicitly
watch(emailRef, (next) => {
  /* respond to email changes */
})
```

## Two call forms

`toRef` accepts either a dotted path or a segment tuple. Both resolve to the same leaf with the same inferred type:

```ts
form.toRef('profile.email')
form.toRef(['profile', 'email'])
```

The dotted form is shorter and idiomatic. The tuple form is the escape hatch for keys that contain a literal `.` (a dotted form can't disambiguate `{ 'a.b': … }` from nested `{ a: { b: … } }`). Pick whichever matches the surrounding code's grammar.

## Read-only by contract

`toRef` returns `Readonly<Ref<T>>`. Writes go through the same paths every other consumer uses:

```ts
form.setValue('profile.email', 'a@b.c') // imperative write
form.register('profile.email') // bound writes via v-register
form.append('todos', { title: '' }) // structural writes
```

Attaform tracks dirty, touched, and validation state through those write paths. Assigning to `.value` directly throws; `toRef` is a read handle, not a backdoor.

## Reactivity contract

`toRef` returns a `ComputedRef`-equivalent shape: reads inside reactive scopes track the path, and consumers re-run when storage at `path` changes. Two refs to the same path share reactivity; they don't double-subscribe.

```ts
const refA = form.toRef('profile.email')
const refB = form.toRef('profile.email')

// refA.value === refB.value, always.
// One storage write triggers both refs' subscribers.
```

The same path-precise reactivity Vue offers on `form.values.profile.email`, just wrapped in a `Ref`.

## Where to next

- [`values`](/docs/reading-the-form/values): the Proxy you should reach for first, before `toRef`.
- [`fields`](/docs/reading-the-form/fields): the per-leaf reactive surface for state bits, not just values.
- [The form](/docs/reading-the-form/the-form): every other reactive read on the return shape.
