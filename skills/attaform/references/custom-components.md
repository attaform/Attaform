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

## Let Attaform own display and ARIA

- Read the display signals straight in the template: `field.showErrors` gates the error row, `field.showPending` gates an async "checking" indicator (it is anti-flash timed), `field.firstError?.message` is the text.
- `v-register`'s `autoAria` (on by default) keeps `aria-invalid`, `aria-busy`, and `aria-required` in sync. It wires the _error_ id, and only while the field is in its error state, so author `aria-describedby` yourself if a _static_ hint should stay associated too.
- **`v-register` alone does binding, SSR value injection, and ARIA.** Do not stack a second _writer_ on it: no `v-model`, no handler that writes the field back, no `:reset-signal` prop, no redundant directive import. If a control seems to need that scaffolding, find the idiomatic shape rather than hand-rolling around it.
- **An _observer_ is not a second writer.** A `@change` that only reads, or a `watch(form.toRef('path'), ...)`, is supported beside `v-register`. The directive attaches its own listener in the `created` hook, before Vue applies yours, so it writes the field first and your handler reads committed state. That is the shape for a surface that saves each decision as it is made instead of on submit; see `references/saving.md`.

## Third-party components

`v-register` binds a third-party component host, not just a native element. The directive marks the host and injects the same binding, SSR, and ARIA it gives a native input.

When the component renders exactly one real form control and forwards attributes to it, that control becomes the field's anchor: focus and blur tracking, ARIA, and the invalid-submit focus target all land on it. A **composite** widget (a PIN input of several boxes) or a **control-less** one (a slider built from `<div>`s) binds too; the directive declines the single-element latch and tracks focus at the widget root instead. Do not reach for an escape hatch on account of either.

The one shape that loses the directive half is a component whose root is a **fragment**, because Vue hands a runtime directive only to a single-element root. The value channel still works there; wrap it in an element you control to get the rest back.

## Do not re-declare native attributes as props

Attribute fallthrough already delivers `id`, `aria-*`, `class`, and the like to the root element. Declare a Vue prop only when script needs to _consume_ the value; otherwise let it fall through. If the component root is not the control, set `inheritAttrs: false` and retarget the attributes onto the control with `v-bind="$attrs"`.

## An optional `form-key` prop

When the parent form has a key, give the wrapper an optional `form-key` prop and resolve through it, falling back to ambient injection for the single-throwaway-form case:

```ts
const form = formKey ? injectForm(formKey) : injectForm()
```

## Extend the surface, do not shrink it

A wrapper composable should expose Attaform's full surface and add derived accessors on top, not return a hand-picked subset that strands state Attaform already computed. Spreading the raw handle plus your derived fields keeps everything reachable.
