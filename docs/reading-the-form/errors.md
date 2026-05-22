---
title: errors
description: form.errors is a reactive Proxy keyed by schema paths — read any leaf's error list, with first().message ready to render and the full array available for richer surfaces.
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

> A reactive Proxy keyed by schema paths — each leaf's error list, ready to render.

::docs-meta-table
::

`form.errors.email` returns `readonly ValidationError[]`: the array of refinement failures for the `email` path, empty when the field is valid. Statically-known leaves always resolve to an array; dynamic boundaries (array indices, record keys, DU variant-only fields) still resolve to `ValidationError[] | undefined`. Reads are reactive: components re-render the moment a validation pass changes the result.

The first error's `.message` is what most templates render:

```vue
<template>
  <input v-register="form.register('email')" />
  <p v-if="form.errors.email.length">{{ form.errors.email[0]?.message }}</p>
</template>
```

For richer error display, gated by `shouldShowErrors`, or pulling the first error directly, reach for `form.fields.email.firstError.message` paired with `form.fields.email.showErrors`. The errors Proxy is the raw aggregate; the fields Proxy is the same data with display ergonomics layered on.

## Container reads

`errors` is drillable. A container path returns the errors encountered inside it:

```ts
form.errors.email // readonly ValidationError[]
form.errors.profile // readonly ValidationError[] (collected from profile.*)
```

For aggregated counts and validation state, see `form.meta`.

## Setting errors imperatively

Server-side errors come back into the same reactive store:

```ts
form.setFieldErrors([{ path: 'email', message: 'Already taken' }])
```

Pair with `parseApiErrors` to convert a server response payload into the right shape — the render surface is identical whether the error came from Zod or your API.

## Where to next

- [The form object](/docs/reading-the-form/the-form-object) — every other reactive read.
- [`values`](/docs/reading-the-form/values) — the read companion to errors.
- [When validation runs](/docs/validation/when-validation-runs) — the moment errors appear.
