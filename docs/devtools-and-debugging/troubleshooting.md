---
title: Troubleshooting
description: Common Attaform pitfalls and how to fix them. Shared-form key collisions, missing v-register elements, hydration drift, handleSubmit bindings, never-typed register reads.
---

# Troubleshooting

> Symptom first, fix second. The most common stumbling blocks readers hit in the first month.

## "My field doesn't validate"

Three independent causes:

- **The schema doesn't include the field.** A `z.string().optional()` wrapper without an inner refinement accepts everything. Verify the schema.
- **You're in `strict: false` and watching `validate()`.** Lax mode strips refinements during default-values derivation so the form mounts with empty values without failing; refinements re-apply on submit. Drop the `strict: false` opt-out if you want `validate()` to fire refinements immediately.
- **The path doesn't match the schema.** `'items.0.name'` and `['items', 0, 'name']` canonicalize to the same path. But `['items', '0', 'name']` (string `'0'`) does NOT; emit numbers when the position is an array index.

## "`register('email')` returns a `never`-typed value"

The schema generic couldn't be inferred. Two likely causes:

- Your schema is typed as bare `ZodObject` without its concrete shape. Use the literal (`z.object({ email: z.string() })`) or give the variable a precise type.
- You imported `useAbstractForm` from `attaform/abstract` and passed a Zod schema without wrapping it in an adapter. `useAbstractForm` expects an `AbstractSchema`; for a Zod schema, import `useForm` from `attaform` (or `attaform/zod`), which wraps it for you.

## "`handleSubmit` doesn't run when I submit the form"

`form.handleSubmit(onSubmit)` returns the **handler function**, not a Promise. Bind the returned value:

```vue
<script setup lang="ts">
  const form = useForm({ schema })
  const onSubmit = form.handleSubmit(async (values) => {
    await api.signup(values)
  })
</script>

<template>
  <form @submit="onSubmit">...</form>
</template>
```

## "v-register on my component does nothing"

`<MyComponent v-register="...">` works only when the component's rendered root element is one Vue's directive can bind: `<input>`, `<textarea>`, or `<select>`. For components whose root is a `<div>` / `<label>` / styled wrapper, the directive skips listener attachment to avoid the bubbled-write bug.

The fix: call `useRegister()` in the child's setup and re-bind `v-register` onto an inner native element:

```vue
<!-- StyledInput.vue -->
<script setup lang="ts">
  import { useRegister } from 'attaform'
  const rv = useRegister()
</script>

<template>
  <div class="wrapper">
    <input v-register="rv" />
  </div>
</template>
```

The dev-mode console warning `v-register on <div> is a no-op …` points here.

## "Console warns that a `:value` / `:checked` is redundant beside v-register"

`v-register` already drives the field's value, so a co-located `:value` / `v-model` (text or `<select>`), `:checked` (checkbox or radio), or `:selected` (`<option>`) is redundant, and the two can fight over the DOM. Drop the extra binding and keep `v-register` alone:

```vue
<!-- Before -->
<input v-register="form.register('email')" :value="form.values.email" />
<!-- After -->
<input v-register="form.register('email')" />
```

A `:value` that gives a radio or an `<option>` its identity is expected and never flagged. The warning fires in the dev console for every app, and at build time (including CI) when you run Attaform's [Vite or Nuxt plugin](/docs/server-and-ssr/ssr-bare-vue). See [Let v-register own the value](/docs/binding-inputs/v-register#let-v-register-own-the-value) for the full rundown.

## "Submit fails with 'No value supplied' on a field the user can leave blank"

The path is in the form's `blankPaths` set and bound to a required schema. Three resolutions:

- **The field is genuinely optional.** Wrap the schema: `z.string().optional()`, `z.number().nullable()`, or `z.string().default('')`.
- **The field is required but `''` should count as "filled".** Supply an explicit default: `defaultValues: { email: '' }`. Attaform reads this as "empty string is intentional" and skips the auto-mark for that leaf.
- **Attaform should treat a blank field as "user didn't fill it."** Working as intended; the synthesized error (`code: 'atta:no-value-supplied'`) prevents silently submitting `0` / `''` / `false` for an unfilled required field.

## "Hydration mismatch after SSR"

Three usual suspects:

- **Did you call `hydrateAttaformState(app, payload)` before `app.mount(...)`?** It has to land before setup runs. Nuxt does this automatically.
- **Non-JSON-safe value in the form?** `Date`, `Map`, `Set`, `BigInt`, and circular refs don't survive `JSON.stringify`. Coerce at the form boundary (`z.date().transform((d) => d.toISOString())`) or use Nuxt's `devalue`-based payload (automatic under Nuxt).
- **`escapeForInlineScript` missing on the bare-Vue side?** A form value containing `</script>` breaks the inline payload. Wrap `JSON.stringify(payload)` in `escapeForInlineScript`. Not required under Nuxt.

## "`[attaform] AF10` in a production console"

Working as designed: production builds ship every diagnostic as a compact code, `[attaform] AF10 attaform.dev/e/af10`, and the link in the message is the fix. Each code has its own page under the [error-code index](/e) with the full development message, the cause, and the way out. Development builds print the complete prose inline instead.

## Where to next

- [The form](/docs/reading-the-form/the-form): the full reactive surface.
- [`errors`](/docs/reading-the-form/errors): per-path error reads.
- [Error codes](/e): every production `AF##` diagnostic, decoded.
