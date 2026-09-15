---
title: Nested objects
description: "z.object({ a: z.object({ b: z.string() }) }) composes through dot-path access: register('a.b'), errors.a.b, fields.a.b. Every nested object gets its own slim default at every level."
metaRows:
  - label: Category
    value: Schema feature
  - label: Composition
    value: 'z.object({ profile: z.object({...}) })'
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
form.errors.address.postalCode // readonly ValidationError[]
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

A `.refine` on an object attaches its error to whatever `path` you specify. Naming a leaf (`path: ['confirm']`) puts it there, where `form.errors.confirm` and that field's own state pick it up like any other error. That is what makes it the move for inline display, and for cross-field validations generally: password confirmation, address-postal-code matching, conditional-required dependencies.

With no `path`, the error lands on the object's **own bucket** rather than on any leaf, and reading it takes a different spelling. At the root of the form that is `form.meta.ownErrors` (or `form.meta.firstOwnError`), since the root has no path to address it by. One level down it is the [`''` container-self sentinel](/docs/reading-the-form/errors#the-sentinel-container-self-errors):

```ts
form.meta.firstOwnError // a refine on the root object
form.errors.profile[''] // a refine on the nested `profile` object
form.errors('profile') // the same list through the flat call form
```

To isolate that error from the fieldset's child errors, read the own bucket off the container's FieldState, which is the **call** form:

```vue
<em v-if="form.fields('profile').firstOwnError">
  {{ form.fields('profile').firstOwnError?.message }}
</em>
```

The call is the load-bearing part. `form.fields.profile` is a navigation node that keeps drilling toward leaves, so it carries no error state of its own and `form.fields.profile.firstOwnError` reads `undefined` however many errors the object holds. `form.fields('profile')` returns the container's own FieldState: `ownErrors` is its own bucket alone, `errors` rolls up the whole subtree. A leaf needs no such distinction, since it has no descendants and reads either way. See [reading FieldState](/docs/reading-the-form/fields) for the full own-versus-subtree axis.

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
form.parse('address', { commit: true }) // validate the address subtree, verdict on form.errors
form.resetField('profile') // re-seed just the profile subtree
form.history.undo() // global to the whole form (no subtree variant)
```

Subtree-scoping keeps "Save section" / "Validate this step" wizard patterns cheap: no full-form re-traversal when you only care about one branch.

## When deeply nested objects feel wrong

If a schema reaches four or five levels deep and feels unwieldy, two patterns to consider:

- **Flatten the schema.** `address.line1` could become `addressLine1` if the grouping was structural rather than semantic. The binding code stays the same shape.
- **Split into sub-forms.** Two `useForm` calls with separate keys, composed via [`injectForm`](/docs/cross-cutting-state/inject-form) or [`useWizard`](/docs/multistep/use-wizard). Per-form history and validation; one parent component coordinating.

Both are escape hatches; the proxy doesn't have a depth limit, and the type inference holds at every level. But deeply-nested schemas often signal a structural-vs.-semantic mismatch worth a second look.

## Where to next

- [Arrays & tuples](/docs/schemas/arrays-and-tuples): variable-length composition; the natural counterpart to nested objects.
- [Records & maps](/docs/schemas/records): when the nested keys are dynamic, not fixed at schema-write time.
- [`injectForm`](/docs/cross-cutting-state/inject-form): when nested-object sub-trees outgrow one component and want to live as sub-forms.
