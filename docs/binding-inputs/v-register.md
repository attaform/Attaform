---
title: The v-register directive
description: v-register binds a native input to a schema path. The directive handles the value sync, the coercion, the dirty-tracking, and the focus pass — your input stays native.
meta:
  - label: Category
    value: Directive
  - label: Element
    value: input / select / textarea / file
  - label: Auto-installed
    value: 'Yes'
---

# The `v-register` directive

> One directive binds a native input to a schema path. The `<input>` stays native — Attaform sits at the directive layer.

<DocsMetaTable />

<DocsDemo slug="v-register" />

## What it does

Bind any native input to a schema path:

```vue
<input v-register="form.register('email')" />
```

The directive runs four pieces of plumbing for you:

1. **Reads** the current value from `form.values.<path>` and writes it into the DOM input — initial render and every reactive update.
2. **Writes** back to `form.values.<path>` on every `input` event (or `change` / `blur` with modifiers).
3. **Coerces** the DOM string to the schema's leaf type — `type="number"` inputs land in storage as a number; checkboxes as a boolean; radio groups pick the option `value`.
4. **Tracks** field state — `touched`, `focused`, `blurred`, `blank` — and surfaces them through `form.fields.<path>`.

## Auto-installed

`createAttaform()` registers the directive globally — bare Vue and Nuxt both. You don't import it.

If you wrap inputs inside a component whose root is **not** the input itself, the `useRegister` composable (documented in a later category) re-binds `v-register` onto an inner native element. For compound components binding multiple paths, prefer `injectForm` over `useRegister`.

## Where to next

- [The form object](/docs/reading-the-form/the-form-object) — the full reactive surface.
- [`values`](/docs/reading-the-form/values) — what the directive writes into.
- [`errors`](/docs/reading-the-form/errors) — the error reads paired with each registered path.
