---
title: Per-field opt-in policy
description: Persistence requires two opt-ins — form-level for the backend, field-level for each path. The sparse payload only carries the paths whose register call site says { persist: true }.
metaRows:
  - label: Category
    value: Module
  - label: Form-level opt-in
    value: useForm({ persist })
    kind: code
  - label: Field-level opt-in
    value: register(path, { persist: true })
    kind: code
  - label: Reactive
    value: persist flag accepts a ref or boolean
---

# Per-field opt-in policy

> Two gates, one rule: a path persists only when the form opens a backend AND the field's register call says yes. Neither alone is enough.

::docs-meta-table
::

Toggle the per-field checkboxes, type into the inputs, then refresh the page. Only the opted-in fields rehydrate — the others land empty even though the form is persisting to `sessionStorage` and the schema has defaults. That's the two-gate policy in action: adding a new field can't accidentally leak into client-side storage unless its register call site explicitly says so.

::docs-demo{slug="per-field-opt-in"}
::

## The two gates

```ts
useForm({
  schema,
  persist: 'session', // ← gate 1: form-level backend
})
```

```vue
<input v-register="form.register('email', { persist: true })" />
<!-- ← gate 2: per-field -->
```

Without both, no writes hit the backend. The form-level opt-in says _which_ backend to use; the field-level opt-in says _which paths_ go into the sparse payload. The asymmetry is intentional — opt-in beats opt-out for forms that grow new fields over time.

## The sparse payload

The persisted envelope contains only opted-in paths:

```ts
// Schema:  { email: string, phone: string, cvv: string }
// register('email', { persist: true })
// register('phone', { persist: true })
// register('cvv')                       ← no opt-in

// Persisted payload, written under key attaform:signup:${fingerprint}
{
  v: 4,                                            // attaform-internal envelope version
  data: {
    form: { email: '…', phone: '…' }               // no `cvv`
  }
}
```

The `v` field is internal to the library — it tracks the on-disk format and bumps only when Attaform changes the serialized shape. Drafts saved against a stale envelope version drop on read with a one-time dev warning.

On hydration, opted-in fields restore from storage; non-opted-in fields come from schema defaults. The opt-in set can change between mounts: a previously-persisted path that's no longer opted in stays in storage until the next write (which won't include it) or an explicit `form.clearPersistedDraft(path)`.

## Reactive opt-in

The `persist` flag is reactive — pass a `ref<boolean>` and the directive's update hook adds or removes the opt-in at runtime:

```vue
<script setup lang="ts">
  const rememberMe = ref(false)
</script>

<template>
  <input v-register="form.register('email', { persist: rememberMe })" />
  <label><input type="checkbox" v-model="rememberMe" /> Remember me</label>
</template>
```

Flip `rememberMe` `false` → `true` and the directive adds the opt-in. Future writes from this input persist. Flip it back and the opt-in is removed; writes go in-memory only. No remount, no manual cleanup.

## Cross-SFC behavior

Two SFCs binding the same path under the same form key share the FormStore and the persistence registry. Opt-ins are per-DOM-element, not per-SFC:

- SFC A renders an input bound to `'email'` with `persist: true` → A's element opted in.
- SFC B renders an input bound to `'email'` without `persist` → B's element NOT opted in.
- Typing in A persists. Typing in B doesn't.

Unmount SFC A and B's typing stops persisting (no opt-ins remain). Re-mount A and the new element gets a fresh opt-in. The registry tracks elements via WeakMap — rapid mount/unmount cycles auto-clean without any explicit dispose.

## Including errors

Default `include: 'form'` persists just the values. Server-side validation errors on reload would be stale by then.

For multi-step wizards where reconstructing errors is expensive, `include: 'form+errors'` persists and re-hydrates the `errors` map alongside the values:

```ts
useForm({
  schema,
  persist: { storage: 'local', include: 'form+errors' },
})
```

Errors on non-opted-in paths are dropped from the envelope — a persisted error without a persisted value would dangle on rehydration.

## Dev-mode footgun checks

Two symmetric warnings catch "wired half the pipeline" bugs (once per form in dev, silent in production):

- **`persist:` configured but no field opts in** → drafts never save.
- **`register({ persist: true })` but no `persist:` on the form** → opt-ins recorded, no writes land.

The warnings name the form key and (where applicable) the offending path.

## Where to next

- [Storage backends](/docs/persistence/storage-backends) — the first of the two gates.
- [Sensitive-name protection](/docs/persistence/sensitive-names) — the heuristic that throws on `password` / `cvv` / `ssn` opt-ins.
- [Imperative persistence](/docs/persistence/imperative) — `form.persist()` and `form.clearPersistedDraft()` for "Save draft" buttons and explicit cleanup.
