---
title: The v-register directive
description: v-register binds a native input to a schema path. The directive handles the value sync, the coercion, the dirty-tracking, and the focus pass — your input stays native.
metaRows:
  - label: Category
    value: Directive
  - label: Element
    value: input / select / textarea / file
  - label: Auto-installed
    value: 'Yes'
---

# The `v-register` directive

> One directive binds a native input to a schema path. The `<input>` stays native — Attaform sits at the directive layer.

::docs-meta-table
::

Click the input, type a few characters, blur, refocus — the four `fields.email.*` bits in the table below flip with each interaction. The directive surfaces every signal the schema-aware layer needs without you wiring a single event listener; the [What it does](#what-it-does) section unpacks the four pieces of plumbing.

::docs-demo{slug="v-register"}
::

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

## Reading errors per field

The directive's binding pair is read-and-error: `register('email')` for the input, `fields.email.firstError?.message` for the message — gated by `fields.email.showErrors` so a half-typed value doesn't get yelled at on first paint.

```vue
<input v-register="register('email')" />
<p v-if="fields.email.showErrors">{{ fields.email.firstError?.message }}</p>
```

The raw `errors.email` Proxy stays available as `ValidationError[] | undefined` when you need the full array — `fields` is the display-ergonomics layer over the same data.

## Where to next

- [The form object](/docs/reading-the-form/the-form-object) — the full reactive surface.
- [`values`](/docs/reading-the-form/values) — what the directive writes into.
- [`errors`](/docs/reading-the-form/errors) — the error reads paired with each registered path.
