---
title: errors
description: form.errors is a reactive Proxy keyed by schema paths. Read any leaf's error list, with errors[0]?.message ready to render and the full array available for richer surfaces.
metaRows:
  - label: Category
    value: Return property
  - label: Type
    value: ErrorsProxyShape<Form>
    kind: code
  - label: Reactive
    value: 'Yes'
---

# `errors`

> A reactive Proxy keyed by schema paths. Every leaf carries its current error list, container reads aggregate everything underneath, and the whole tree re-renders the moment validation re-runs.

::docs-meta-table
::

`form.errors` is the raw validation surface, paired one-to-one with `form.values` and `form.fields`. The demo seeds invalid values up front so the panels light up on mount, then updates live as you edit each field. The container panel shows the live `profile` sub-tree, the form-level panel shows the root-only errors via `form.errors([])`, and the whole-form panel shows the full sparse tree.

::docs-demo{slug="errors" label="form.errors Demo"}
::

## Leaf reads

```ts
const schema = z.object({
  email: z.email('Enter a valid email'),
  name: z.string().min(1, 'Name is required'),
})

const form = useForm({ schema })

form.errors.email // readonly ValidationError[]
form.errors.email[0]?.message // 'Enter a valid email' | undefined
form.errors.email.length // 0 when valid
```

A static object leaf always returns an array, `readonly ValidationError[]`, empty when valid. Reads past a dynamic boundary carry `| undefined`, because the node there may be absent: a numeric array index (`form.errors.todos[3]?.title`), a record key (`form.errors.byId.missing`), or a field that only exists on an inactive discriminated-union variant. That `| undefined` is honest. Dot and index access is pure navigation, so a key the schema doesn't declare and the data doesn't hold reads `undefined`, never a stand-in proxy, and a truthy check agrees with the runtime. The one exception is a server error parked at a non-schema key: the error stores count as holding it, so it stays reachable and its message lands on the [`''` container-self sentinel](#the-sentinel-container-self-errors) (`form.errors.ghost['']`).

The first error's `.message` is what most templates render:

```vue
<template>
  <input v-register="form.register('email')" />
  <p v-if="form.errors.email.length">{{ form.errors.email[0]?.message }}</p>
</template>
```

For display ergonomics, gating by [`getDisplayState`](/docs/validation/showing-errors) and pulling the first error in one shot, reach for [`form.fields.email.firstError`](/docs/reading-the-form/fields) paired with `form.fields.email.showErrors`. The errors Proxy is the raw aggregate; the fields Proxy is the same data with display gating and `firstError` sugar layered on.

## Container reads

`form.errors` is a drillable Proxy: dot-access descends into containers (returning a sub-Proxy you can keep drilling), and the call form returns a flat aggregate at any path. The two surfaces serve different jobs:

```ts
form.errors.profile // sub-Proxy: { '': [...refines], bio: [...], ... }
form.errors('profile') // flat array: every error inside profile + container-self
form.errors() // flat array: every error in the form
form.errors([]) // flat array: global errors only (root .refine(), setFormErrors)
```

`form.errors()` is the cheapest "is anything wrong?" check (`form.errors().length === 0` when the form is valid). Its narrower companion `form.errors([])` returns only the global, form-level errors (a root `.refine()`, an imperatively-set form error), with no field errors mixed in. For aggregated counts and submission-state bits, see [`form.meta`](/docs/reading-the-form/meta). When you serialize the dot-form (`JSON.stringify(form.errors)` or `{{ form.errors }}` in a template), the Proxy materializes the live sparse tree, so you can dump the whole error state for debugging without losing structure; global errors sit under the `'[]'` key in that dump, kept distinct from every field.

### The `''` sentinel: container-self errors

A cross-field `.refine()` lives on a container, not a leaf:

```ts
const schema = z.object({
  profile: z
    .object({
      bio: z.string().max(50),
      handle: z.string(),
    })
    .refine((p) => p.bio.includes(p.handle), 'Bio must mention your handle'),
})
```

The refine's error path is `['profile']`, the container itself. To keep `form.errors.profile` readable alongside leaf errors at `['profile', 'bio']` and `['profile', 'handle']`, container-self errors land in the materialized tree under the `''` sentinel slot:

```ts
form.errors.profile[''] // refine errors on profile (and any other container-self entries)
form.errors.profile.bio // leaf errors on bio
```

`JSON.stringify(form.errors.profile)` materializes as `{ '': [refineError], bio: [maxError], handle: [...] }`. Both the refine and the descendant leaves coexist; nothing clobbers anything. The same convention reaches all the way down: a refine on `profile.address` lands at `form.errors.profile.address['']`.

The call form is the flat alternative: `form.errors('profile')` returns one `ValidationError[]` containing the refine PLUS every descendant leaf error in declaration order, no structure. Reach for the structural tree when you want to render per-field; reach for the call form when you want "anything wrong under this container?".

The sentinel is a nested-container convention: it appears one level deep or more. The root has no `''` self-slot, because at the root `''` is just an ordinary field key. `form.errors['']` reads a literal field named `''` (a rare but valid schema key), while global, form-level errors (a root `.refine()`, a `setFormErrors` call) live at the structurally-distinct root path and read through `form.errors([])`. In a `JSON.stringify(form.errors)` dump they appear under the `'[]'` key, never under `''`, so the two never collide.

If your schema legitimately declares a field literally named `''` at a nested container (an exceptionally rare choice), that leaf's own errors and the container-self errors share the sentinel slot, and both arrays concatenate into a single read. At the root no such collision exists: `''` is a plain field there, kept entirely separate from the global bucket at `form.errors([])`.

## Setting errors imperatively

Server-side errors land in the same reactive store as Zod errors:

```ts
form.setFieldErrors([
  { path: 'email', message: 'Already taken' },
  { path: 'profile.handle', message: 'Reserved' },
])
```

`form.errors.email` and `form.errors.profile.handle` update immediately, and any `form.fields.<path>.firstError` / `form.fields.<path>.showErrors` reads update with them. Pair with [`parseApiErrors`](/docs/server-and-ssr/parse-api-errors) to convert a server response payload into the `{ path, message }` shape `setFieldErrors` expects; the render surface is identical whether the error came from Zod or your API.

## Where to next

- [The form](/docs/reading-the-form/the-form): every other reactive read.
- [`values`](/docs/reading-the-form/values): the read companion to errors.
- [`fields`](/docs/reading-the-form/fields): per-leaf state, including the gated `firstError` / `showErrors` pairing.
- [`meta`](/docs/reading-the-form/meta): the form-level aggregates (`errorCount`, `valid`, `submitting`, etc.).
- [When validation runs](/docs/validation/when-validation-runs): the moment errors appear.
- [Server-side errors](/docs/submitting/server-side-errors): `setFieldErrors` + `parseApiErrors` in full.
