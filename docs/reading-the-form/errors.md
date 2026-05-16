---
title: errors
description: form.errors is a reactive Proxy keyed by schema paths — read any leaf's error message, ready to render, reactive end to end.
meta:
  - label: Category
    value: Return property
  - label: Type
    value: ErrorsProxyShape<Form>
    kind: code
  - label: Reactive
    value: 'Yes'
---

# `errors`

> A reactive Proxy keyed by schema paths — each leaf's error message, ready to render.

<DocsMetaTable />

`form.errors.email` returns the current error message for the `email` path (or `undefined` if the field is valid). Reads are reactive — components re-render the moment a validation pass changes the result.

```vue
<template>
  <input v-register="form.register('email')" />
  <p v-if="form.errors.email">{{ form.errors.email }}</p>
</template>
```

## Container reads

`errors` is drillable just like `values`. A container path returns the first error encountered inside it:

```ts
form.errors.email // string | undefined
form.errors.profile // string | undefined (first error in profile.*)
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
