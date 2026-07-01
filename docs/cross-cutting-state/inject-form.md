---
title: injectForm
description: Reach any registered form from anywhere in the component tree, no props drilling, no ref forwarding. Ambient resolution for nested components, keyed lookup for distant ones.
metaRows:
  - label: Category
    value: Composable
  - label: Signature
    value: 'injectForm<Form>(key?) => ReturnType<typeof useForm<Form>>'
    kind: code
  - label: Ambient mode
    value: useForm({ schema }) without a key
    kind: code
  - label: Explicit mode
    value: useForm({ schema, key })
    kind: code
---

# `injectForm`

> Reach any registered form from any descendant. Call `injectForm` and get the same handle back. Ambient resolution for the parent's own form, keyed resolution for distant ones.

::docs-meta-table
::

The parent owns the form and renders the email field. `ProfileFieldset.vue` and `StatusPill.vue` are sibling SFCs that each call `injectForm('docs-demo-inject-form')` to reach the same form: no props passed, same reactive surface. Both children would run unchanged regardless of how deep they sat in the tree.

::docs-demo{slug="inject-form" label="Form Injection Demo"}
::

## The common case: ambient resolution

Parent owns the form (no `key`):

```vue
<!-- SignupForm.vue -->
<script setup lang="ts">
  import { useForm } from 'attaform/zod'

  const form = useForm<Form>({ schema })
  const onSubmit = form.handleSubmit(async (values) => {
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

  const form = injectForm<Form>()
</script>

<template>
  <label>Email</label>
  <input v-register="form?.register('email')" />
  <em v-if="form?.fields.email.showErrors">{{ form?.fields.email.firstError?.message }}</em>
</template>
```

You supply the `Form` generic; Vue's injection system erases it, so Attaform can't recover the shape on your behalf. Other than that, `injectForm<Form>()` returns a form type-identical to `useForm`'s return.

## Reaching a form that isn't an ancestor

Floating save buttons, sidebar status widgets, anything in a different branch of the component tree:

```vue
<!-- FloatingSaveButton.vue (anywhere in the app) -->
<script setup lang="ts">
  import { injectForm } from 'attaform/zod'

  const form = injectForm<Form>('signup')
  const onSave = () => form?.handleSubmit(async (values) => api.post('/signup', values))()
</script>

<template>
  <button :disabled="!form?.meta.dirty || form?.meta.submitting" @click="onSave">Save</button>
</template>
```

Pass the same `key` you passed to `useForm({ key: 'signup' })`. If no form is registered under that key when the component mounts, `injectForm` returns `null` and dev mode logs the unresolved key at the call site. Reach for the form with `?.` at every consumption site so a missing form degrades to no-ops instead of crashing. See [When resolution fails](#when-resolution-fails) below.

## How a key resolves

A key is a name, not a location. What `injectForm('signup')` resolves to is fixed by two properties, and it helps to hold both at once.

**It is position-independent.** A keyed form lives in Attaform's app-level registry, not in the component tree. `injectForm('signup')` reaches it from any component in the app: a sibling branch, a floating toolbar, a modal teleported to the document body. Extracting a wrapper or changing how deep a component sits never changes what a key resolves to.

**It is time-dependent.** The registry entry appears when the form's own `useForm({ key: 'signup' })` runs its setup, and not a moment before. So the one thing a key cannot do is hand back a form that has not been created yet.

Together they give a single rule: **resolve downward.** Vue runs a parent's setup before its children's, so:

- A descendant reaching an ancestor's keyed form always resolves. The ancestor's `useForm` ran first, so the entry is already there.
- An ancestor reaching a descendant's form gets `null`. At the ancestor's setup the descendant has not run, so nothing is registered under that key yet.

Create a form where it is owned, and reach for it at or below that point. If you catch yourself reaching upward, or sideways for a form a sibling creates, that is the cue to lift the `useForm({ key })` up to a common ancestor so the form exists before anyone asks for it.

| Resolution       | Keyed: `injectForm('signup')`                          | Ambient: `injectForm()`                         |
| ---------------- | ------------------------------------------------------ | ----------------------------------------------- |
| Resolves through | Attaform's app-level registry                          | Vue `provide` / `inject`                        |
| Reaches          | any component in the app                               | descendants of the owning `useForm`             |
| Ready            | once the owner's `useForm({ key })` setup has run      | always, from a descendant (the owner ran first) |
| On a miss        | `null`, plus a dev warning listing the registered keys | `null`, silently                                |

The dev warning on a keyed miss names this timing case directly and points at the call site, so a form that simply registered late reads differently from a typo.

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

The runtime emits a dev-mode `console.warn` lazily, when (and only when) a descendant actually consumes the ambient slot via `injectForm<Form>()` with no key. The warning lists each anonymous `useForm()` call by source frame so you can navigate to the offending sites.

**Fix:** give each form a key (which removes them from the ambient slot entirely) and look them up explicitly:

```ts
useForm({ schema: schemaA, key: 'a' })
useForm({ schema: schemaB, key: 'b' })
// Descendants:
const a = injectForm<FormA>('a')
const b = injectForm<FormB>('b')
```

Mixing modes is fine; keyed forms don't interfere with an ambient sibling. A parent with three keyed forms plus one anonymous form produces no warning; the descendant's `injectForm<F>()` unambiguously resolves to the (only) anonymous one.

## Compound vs. single-purpose

For components that touch one field, both `injectForm` and `useRegister` work. The choice:

- **`useRegister`**: single-field child that takes `v-register` from its consumer. Use when the parent decides which path the child binds to.
- **`injectForm`**: child that touches one or more specific paths the parent doesn't declare. Use when the path is the child's responsibility (an `AddressBlock` always binds `address.street`, `address.city`, `address.zip`).

`useRegister` doesn't accept a key or path; it's a single-purpose ambient hook. Compound use cases belong on `injectForm`.

## Lifetime

Both resolution modes ref-count on the form's registry entry. In practice:

- The form survives until every component that reached it unmounts.
- Cleanup is automatic; no explicit dispose call from the consumer.
- A form accessed only by `injectForm(key)` stays alive as long as at least one consumer is mounted, even if the original `useForm` owner unmounted first.

## When resolution fails

`injectForm` returns `T | null` rather than throwing, so descendants are robust to mount-order quirks (children rendered before the parent's `useForm` runs, conditional ancestors, dynamic imports). Two cases produce `null`:

- **No ambient form**: `injectForm()` with no ancestor `useForm` and no key. Returns `null` silently. Ambient lookup is opportunistic, so a downstream component library reading the ambient slot stays quiet in trees that don't have a form rather than spamming consumers' consoles.
- **Key not registered**: `injectForm('key-name')` but nothing is registered under that key. Dev mode logs the unresolved key at the call site. If the form is created lower in the tree, it registers after this call runs; see [How a key resolves](#how-a-key-resolves).

Keep the return as `T | null` and reach for it with `?.` at the consumption sites. The directive accepts `undefined` peacefully, optional chains short-circuit cleanly through reactive reads, and the child still works the moment the form becomes available:

```vue
<script setup lang="ts">
  const ctx = injectForm<Form>('signup')
</script>

<template>
  <input v-register="ctx?.register('email')" />
  <em v-if="ctx?.fields.email.showErrors">{{ ctx?.fields.email.firstError?.message }}</em>
</template>
```

For optional consumers (a floating panel that should hide entirely when the form isn't mounted), wrap the whole subtree in `v-if`:

```vue
<template>
  <div v-if="ctx" class="status">{{ ctx.meta.dirty ? '●' : '' }}</div>
</template>
```

Either way, the non-null assertion (`ctx!`) is a pattern to avoid: it teaches the type checker to look the other way, and a single mount-order regression turns into a runtime crash instead of a quiet no-op.

`injectForm` does throw `OutsideSetupError` if called outside a Vue setup function: a structural mistake the runtime can catch unambiguously.

## Where to next

- [`useRegister` for custom components](/docs/binding-inputs/use-register): the single-field child binding alternative.
- [Undo & redo](/docs/cross-cutting-state/undo-redo): `injectForm` makes "Undo" buttons in distant components effortless.
- [Multistep flows (`useWizard`)](/docs/multistep/use-wizard): orchestrates multiple `useForm` instances, not single-form access.
