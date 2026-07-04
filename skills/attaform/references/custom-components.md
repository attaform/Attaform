# Custom components

Reach for these only when a native `<input>`, `<select>`, or `<textarea>` bound with `v-register` will not do. Most fields never need a wrapper.

## Three orthogonal primitives

There is deliberately no `useField(path)` that returns `{ register, fields, errors }` in one call. The three concerns are kept separate on purpose:

- **`register(path)` returns an instance, not a path abstraction.** Two inputs can register the same path and move in sync: they share the path's field _state_, but each `register()` call has its own transforms and DOM lifecycle. A single bundled binding would have to pretend there is one binding per path.
- **`fields(path)` is path-keyed leaf state**: `value`, `touched`, `dirty`, `blank`, `errors`, `label`, `aria`, the display signals. The noun is the path.
- **`errors` is a related but separate concern**, not the same thing as field state.

The three lines are the idiom, not a bundle. Small primitives age better than convenient bundles.

## A single-field wrapper

The parent binds with `v-register`; the wrapper re-forwards that same instance and reads state from it:

```vue
<!-- parent -->
<UiTextField v-register="form.register('email')" type="email" />
```

```vue
<!-- UiTextField.vue -->
<script setup lang="ts">
  import { computed } from 'vue'
  import { injectForm, useRegister } from 'attaform'

  const rv = useRegister() // the forwarded instance
  const form = injectForm(rv?.formKey) // the owning form, by the instance's key
  const field = computed(() => form?.fields(rv?.segments ?? [])) // reactive leaf state
</script>

<template>
  <label>
    <span>{{ field?.label }}</span>
    <input v-register="rv" />
    <em v-if="field?.showErrors">{{ field.firstError?.message }}</em>
  </label>
</template>
```

`rv` and `field` may be `undefined` until the parent directive attaches, so defend every read with `?.`. `rv.path`, `rv.segments`, and `rv.formKey` pierce directly in script setup without `.value`.

For a **compound** component that binds _multiple_ paths (a date range exposing start and end, an address subform), skip `useRegister` (it assumes a single binding) and reach for `injectForm<Form>()`, then call `form.register(path)` for each field.

## Let the library own display and ARIA

- Read the display signals straight in the template: `field.showErrors` gates the error row, `field.showPending` gates an async "checking" indicator (it is anti-flash timed), `field.firstError?.message` is the text.
- `v-register`'s `autoAria` (on by default) keeps `aria-invalid`, `aria-busy`, and `aria-required` in sync. It wires the _error_ id, and only while the field is in its error state, so author `aria-describedby` yourself if a _static_ hint should stay associated too.
- **`v-register` alone does binding, SSR value injection, and ARIA.** Do not stack `@change` handlers, `:reset-signal` props, redundant directive imports, or watchers on top of it. If a control seems to need that scaffolding, find the idiomatic shape rather than hand-rolling around it.

## Third-party components

`v-register` binds a third-party component host, not just a native element, as long as the component renders a real form control and forwards attributes to it. The directive marks the host and injects the same binding, SSR, and ARIA it gives a native input.

## Do not re-declare native attributes as props

Attribute fallthrough already delivers `id`, `aria-*`, `class`, and the like to the root element. Declare a Vue prop only when script needs to _consume_ the value; otherwise let it fall through. If the component root is not the control, set `inheritAttrs: false` and retarget the attributes onto the control with `v-bind="$attrs"`.

## An optional `form-key` prop

When the parent form has a key, give the wrapper an optional `form-key` prop and resolve through it, falling back to ambient injection for the single-throwaway-form case:

```ts
const form = formKey ? injectForm(formKey) : injectForm()
```

## Extend the surface, do not shrink it

A wrapper composable should expose the library's full surface and add derived accessors on top, not return a hand-picked subset that strands state the library already computed. Spreading the raw handle plus your derived fields keeps everything reachable.
