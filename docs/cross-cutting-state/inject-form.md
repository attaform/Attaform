---
title: injectForm
description: Reach any registered form from anywhere in the component tree — no props drilling, no ref forwarding. Ambient resolution for nested components, keyed lookup for distant ones.
metaRows:
  - label: Category
    value: Composable
  - label: Signature
    value: 'injectForm<Form>(key?) => ReturnType<typeof useForm<Form>>'
    kind: code
  - label: Ambient mode
    value: useForm({ schema }) — no key
    kind: code
  - label: Explicit mode
    value: useForm({ schema, key })
    kind: code
---

# `injectForm`

> Reach any registered form from any descendant — call `injectForm` and get the same handle back. Ambient resolution for the parent's own form, keyed resolution for distant ones.

::docs-meta-table
::

The parent owns the form and renders the email field. `ProfileFieldset` and `StatusPill` are inline render-function components that call `injectForm('docs-demo-inject-form')` to reach the same form — no props passed, same reactive surface. Both child components are defined in this SFC and run unchanged regardless of how deep they sit in the tree.

::docs-demo{slug="inject-form"}
::

## The common case — ambient resolution

Parent owns the form (no `key`):

```vue
<!-- SignupForm.vue -->
<script setup lang="ts">
  import { useForm } from 'attaform/zod'

  const { handleSubmit } = useForm<Form>({ schema })
  const onSubmit = handleSubmit(async (values) => {
    await api.post('/signup', values)
  })
</script>

<template>
  <form @submit.prevent="onSubmit">
    <EmailRow />
    <ProfileGroup />
    <button>Sign up</button>
  </form>
</template>
```

Any descendant grabs the same form:

```vue
<!-- EmailRow.vue -->
<script setup lang="ts">
  import { injectForm } from 'attaform/zod'

  const { register, fields } = injectForm<Form>()
</script>

<template>
  <label>Email</label>
  <input v-register="register('email')" />
  <em v-if="fields.email.showErrors">{{ fields.email.firstError?.message }}</em>
</template>
```

You supply the `Form` generic — Vue's injection system erases it, so the library can't recover the shape on your behalf. Other than that, `injectForm<Form>()` returns an object type-identical to `useForm`'s return.

## Reaching a form that isn't an ancestor

Floating save buttons, sidebar status widgets, anything in a different branch of the component tree:

```vue
<!-- FloatingSaveButton.vue (anywhere in the app) -->
<script setup lang="ts">
  import { injectForm } from 'attaform/zod'

  const { meta, handleSubmit } = injectForm<Form>('signup')
  const onSave = handleSubmit(async (values) => api.post('/signup', values))
</script>

<template>
  <button :disabled="!meta.dirty || meta.submitting" @click="onSave">Save</button>
</template>
```

Pass the same `key` you passed to `useForm({ key: 'signup' })`. If no form is registered under that key when the component mounts, the call throws — the error names the missing key.

## Do I need to pass a `key` to `useForm`?

The two resolution modes are cleanly split:

- **Anonymous (no `key`) → ambient access.** `useForm({ schema })` fills the parent's ambient slot. Any descendant's `injectForm<Form>()` (no key) resolves to it; closest ancestor wins when nested.
- **Keyed (`key: 'x'`) → explicit access only.** `useForm({ schema, key: 'x' })` registers the form under `'x'` but does NOT fill the ambient slot. Descendants reach it via `injectForm<Form>('x')`, not via the no-key form.

Skip `key` for single-component one-off forms (login modal, settings panel). Supply one when you want cross-component lookup, multi-call-site shared state, a stable persistence default, or a legible DevTools label.

### Gotcha: multiple anonymous `useForm` in one component

Vue's `provide` / `inject` is last-write-wins per component. If a parent calls `useForm` twice without keys, the second overwrites the first in the ambient slot, and descendants using `injectForm<Form>()` only see the second.

```ts
// Parent component
const formA = useForm({ schema: schemaA }) // provides ambient → A
const formB = useForm({ schema: schemaB }) // provides ambient → B (overwrites A)
// Descendants' injectForm<Form>() reads B. A is unreachable via ambient.
```

The runtime emits a dev-mode `console.warn` lazily — when (and only when) a descendant actually consumes the ambient slot via `injectForm<Form>()` with no key. The warning lists each anonymous `useForm()` call by source frame so you can navigate to the offending sites.

**Fix** — give each form a key (which removes them from the ambient slot entirely) and look them up explicitly:

```ts
useForm({ schema: schemaA, key: 'a' })
useForm({ schema: schemaB, key: 'b' })
// Descendants:
const a = injectForm<FormA>('a')
const b = injectForm<FormB>('b')
```

Mixing modes is fine — keyed forms don't interfere with an ambient sibling. A parent with three keyed forms plus one anonymous form produces no warning; the descendant's `injectForm<F>()` unambiguously resolves to the (only) anonymous one.

## Compound vs. single-purpose

For components that touch one field, both `injectForm` and `useRegister` work. The choice:

- **`useRegister`** — single-field child that takes `v-register` from its consumer. Use when the parent decides which path the child binds to.
- **`injectForm`** — child that touches one or more specific paths the parent doesn't declare. Use when the path is the child's responsibility (an `AddressBlock` always binds `address.street`, `address.city`, `address.zip`).

`useRegister` doesn't accept a key or path — it's a single-purpose ambient hook. Compound use cases belong on `injectForm`.

## Lifetime

Both resolution modes ref-count on the form's registry entry. In practice:

- The form survives until every component that reached it unmounts.
- Cleanup is automatic — no explicit dispose call from the consumer.
- A form accessed only by `injectForm(key)` stays alive as long as at least one consumer is mounted, even if the original `useForm` owner unmounted first.

## When resolution fails

`injectForm` returns `T | null` rather than throwing — descendants are robust to mount-order quirks (children rendered before the parent's `useForm` runs, conditional ancestors, dynamic imports). Two cases produce `null`:

- **No ambient form** — `injectForm()` with no ancestor `useForm` and no key. Dev mode logs a one-shot `console.warn` naming both resolutions.
- **Key not registered** — `injectForm('key-name')` but nothing is registered under that key. Dev mode logs the unresolved key.

For the common case where the form is guaranteed to exist (it's set up in the same SFC tree), assert non-null at the call site:

```ts
const { register, fields } = injectForm<Form>('signup')!
```

For optional consumers (a floating panel that should hide when the form isn't mounted), guard the return:

```vue
<script setup lang="ts">
  const ctx = injectForm<Form>('signup')
</script>

<template>
  <div v-if="ctx" class="status">{{ ctx.meta.dirty ? '●' : '' }}</div>
</template>
```

`injectForm` does throw `OutsideSetupError` if called outside a Vue setup function — a structural mistake the runtime can catch unambiguously.

## Where to next

- [`useRegister` for custom components](/docs/binding-inputs/use-register) — the single-field child binding alternative.
- [Undo & redo](/docs/cross-cutting-state/undo-redo) — `injectForm` makes "Undo" buttons in distant components effortless.
- [Multi-step flows (`useStepper`)](/docs/cross-cutting-state/use-stepper) — orchestrates multiple `useForm` instances, not single-form access.
