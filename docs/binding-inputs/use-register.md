---
title: useRegister
description: The composable that lets a Vue wrapper component bind a parent's v-register onto an inner native element — for component shells whose root isn't the input itself.
metaRows:
  - label: Category
    value: Composable
  - label: Signature
    value: useRegister<V>(): UseRegisterReturn<V> | undefined
    kind: code
  - label: Returns
    value: hybrid Ref + RegisterValue Proxy
  - label: Auto-installed
    value: attaform plugin
---

# `useRegister`

> The bridge between `v-register` on a wrapper component and `v-register` on its inner native input.

::docs-meta-table
::

Type into either of the two fields rendered by `<FieldRow>` and watch the JSON readout update. The parent applies `v-register="register('email')"` to the `<FieldRow>` root; inside `FieldRow`, `useRegister()` captures that binding and `v-register="rv"` reattaches it to the inner `<input>`. The [How it works](#how-it-works) section traces every step.

::docs-demo{slug="use-register" label="useRegister Demo"}
::

## When to reach for it

`useRegister` exists for one specific shape — a Vue component that wraps a single form field, whose **root element is not the input itself**:

```vue
<!-- A labelled-row wrapper. The root is <label>, not the input. -->
<FieldRow v-register="register('email')" label="Email" />
```

Inside `<FieldRow>`, the wrapper's root receives the directive, but you need the binding on the inner `<input>` to make the form work. `useRegister` captures the parent's `v-register` binding so you can re-apply it inside.

When the wrapper's root **is** the input itself, Vue's attribute fallthrough already handles the binding — `useRegister` is unnecessary.

## Capture, re-apply

```vue
<script setup lang="ts">
  import { useRegister } from 'attaform'

  const rv = useRegister()
</script>

<template>
  <label class="field-row">
    <span>{{ label }}</span>
    <input v-register="rv" />
  </label>
</template>
```

That's the whole pattern: call once, hand the return value to `v-register` inside. `useRegister` reads the parent's binding, surfaces it as a hybrid Ref + RegisterValue Proxy, and the directive picks it up exactly as if the parent had applied it directly to the inner input.

## Two surfaces on the return value

`useRegister()` returns a hybrid Proxy:

- **Ref-shaped**: `v-register="rv"` works because the Proxy answers `__v_isRef` / `.value` like a `Ref<RegisterValue | undefined>`. Vue's template auto-unwrap surfaces the underlying RegisterValue to the directive.
- **Pierced reads**: `rv.path`, `rv.segments`, `rv.formKey`, `rv.formInstanceId` all work directly in script setup without `.value`. Reads inside reactive scopes (`computed`, `watchEffect`) track changes.

```ts
const rv = useRegister()

// In script setup — direct pierce
const ariaLabel = computed(() => `Field for ${rv?.path}`)

// In template — Vue auto-unwraps
// v-register="rv"
```

## Unbound state

When the parent didn't apply `v-register`, every pierced read returns `undefined` and the composable's return type surfaces this honestly as `UseRegisterReturn<V> | undefined`:

```ts
const rv = useRegister()
// rv?.formKey — optional-chain to defend
```

In dev mode, a single `console.warn` fires per instance at mount time when the parent never bound. The directive accepts `undefined` peacefully (its binding type is `RegisterValue<V> | undefined`), so `v-register="rv"` works whether or not a parent bound — no runtime crash, just the warn.

## Multi-field wrappers

`useRegister` is the right call for **single-field** wrappers. For compound components binding **multiple paths** (a date-range picker exposing start + end fields, an address subform exposing street + city + zip), reach for `injectForm<Form>()` and call `ctx.register(path)` directly. That sidesteps the single-binding assumption `useRegister` makes.

## Where to next

- [The `v-register` directive](/docs/binding-inputs/v-register) — the directive `useRegister` re-binds.
- [Custom assigners](/docs/binding-inputs/custom-assigners) — the escape hatch for non-standard element value surfaces.
- [Form context (`injectForm`)](/docs/cross-cutting-state/form-context) — for compound components binding multiple paths.
