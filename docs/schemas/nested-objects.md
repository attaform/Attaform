---
title: Nested objects
description: z.object({ a: z.object({ b: z.string() }) }) composes through dot-path access: register('a.b'), errors.a.b, fields.a.b. Every nested object gets its own slim default at every level.
metaRows:
  - label: Category
    value: Schema feature
  - label: Composition
    value: z.object({ profile: z.object({...}) })
    kind: code
  - label: Path access
    value: register('profile.name')
    kind: code
  - label: Errors
    value: form.errors.profile.name
    kind: code
---

# Nested objects

> Schemas compose by nesting: one `z.object` inside another. The proxy descends through dot-paths so `form.values.profile.name`, `form.errors.profile.name`, and `register('profile.name')` all work the way you'd expect.

::docs-meta-table
::

This page is code-only; every other demo in the docs already nests objects. The shape, the proxy, and the path semantics are best understood through the snippets below; reach for a real demo on [Arrays & tuples](/docs/schemas/arrays-and-tuples) (which composes arrays of nested objects) or [Discriminated unions](/docs/schemas/discriminated-unions) (which nests variant objects inside the outer union) when you want to see it live.

## The shape

```ts
const schema = z.object({
  profile: z.object({
    name: z.string().min(1, 'Name is required'),
    bio: z.string().optional(),
  }),
  address: z.object({
    line1: z.string().min(1, 'Street is required'),
    city: z.string(),
    postalCode: z.string(),
  }),
})

const form = useForm({ schema })
```

Each leaf gets its own path:

```ts
form.values.profile.name // string
form.values.address.city // string
form.register('profile.name') // path autocomplete narrows the union
form.errors.address.postalCode // ValidationError[] | undefined
```

## The proxy descends transparently

`form.values`, `form.errors`, and `form.fields` are all proxies; `form.values.profile.name` resolves through one descend per dot segment. The reactivity tracks at the path level, not the leaf level: re-running templates only fires for paths whose values changed.

```vue
<template>
  <fieldset>
    <legend>Profile</legend>
    <label>
      Name
      <input v-register="form.register('profile.name')" />
      <em v-if="form.fields.profile.name.showErrors">
        {{ form.fields.profile.name.firstError?.message }}
      </em>
    </label>
    <label>
      Bio
      <textarea v-register="form.register('profile.bio')" rows="3" />
    </label>
  </fieldset>
</template>
```

The pattern scales to arbitrary depth. `register('a.b.c.d.e')` works; the type inference walks the schema's shape one segment at a time and narrows along the way.

## Object-level vs. leaf-level errors

```ts
const schema = z
  .object({
    password: z.string().min(8),
    confirm: z.string(),
  })
  .refine((data) => data.password === data.confirm, {
    message: 'Passwords must match',
    path: ['confirm'],
  })
const form = useForm({ schema })
```

A `.refine` on the outer object attaches its error to whatever `path` you specify. With no `path`, the error lands on the object root, accessible at `form.errors.<object-path>` directly. With a `path`, it lands on the named leaf, usually preferable for inline display, since the field component reads from `form.errors.confirm` either way.

For cross-field validations (password confirmation, address-postal-code matching, conditional-required dependencies), the `.refine` + `path: ['leafName']` pattern is the canonical move.

## Per-nested defaults

Each nested object can have its own `.default()`:

```ts
const schema = z.object({
  ui: z
    .object({
      theme: z.string().default('light'),
      density: z.string().default('comfortable'),
    })
    .default({ theme: 'light', density: 'comfortable' }),
})

const form = useForm({ schema })

form.values.ui.theme // 'light' (inner default applied)
form.values.ui.density // 'comfortable'
```

The outer `.default({...})` is the fallback when the whole object is missing; the inner `.default()` calls fire per-leaf if the outer default is absent. In practice, defaulting at the leaves is enough; the runtime's slim-default synthesis handles missing objects.

## Resetting a subtree

`resetField` walks the path and re-seeds the subtree from the schema:

```ts
form.resetField('profile') // re-seed profile.name + profile.bio from schema
form.resetField('profile.name') // re-seed just one leaf
```

The cleared subtree's field state (touched, focused, etc.) reverts to the post-mount baseline; cross-subtree state (sibling paths) stays where it is.

## Subtree-scoped operations

Most operations accept a path argument that scopes them to a subtree:

```ts
form.validate('profile') // validate just profile.* leaves
form.validateAsync('address') // async-validate the address subtree
form.persist('profile') // write just the profile subtree to storage
form.clearPersistedDraft('profile.bio') // wipe one persisted leaf
form.history.undo() // global to the whole form (no subtree variant)
```

Subtree-scoping keeps "Save section" / "Validate this step" wizard patterns cheap: no full-form re-traversal when you only care about one branch.

## When deeply nested objects feel wrong

If a schema reaches four or five levels deep and feels unwieldy, two patterns to consider:

- **Flatten the schema.** `address.line1` could become `addressLine1` if the grouping was structural rather than semantic. The binding code stays the same shape.
- **Split into sub-forms.** Two `useForm` calls with separate keys, composed via [`injectForm`](/docs/cross-cutting-state/inject-form) or [`useStepper`](/docs/cross-cutting-state/use-stepper). Per-form persistence, history, and validation; one parent component coordinating.

Both are escape hatches; the proxy doesn't have a depth limit, and the type inference holds at every level. But deeply-nested schemas often signal a structural-vs.-semantic mismatch worth a second look.

## Where to next

- [Arrays & tuples](/docs/schemas/arrays-and-tuples): variable-length composition; the natural counterpart to nested objects.
- [Records & maps](/docs/schemas/records): when the nested keys are dynamic, not fixed at schema-write time.
- [`injectForm`](/docs/cross-cutting-state/inject-form): when nested-object sub-trees outgrow one component and want to live as sub-forms.
