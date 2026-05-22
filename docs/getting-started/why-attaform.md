---
title: Why Attaform
description: The case for picking Attaform for Vue 3 forms — type-safe end to end, schema-driven defaults, layered validation, SSR-clean hydration, and built-in persistence, history, and devtools.
---

# Why Attaform

> The case for picking Attaform — on its own terms.

You're choosing a form library for a Vue 3 or Nuxt project, and you have to bet on something that'll still feel right at the end of the year — not just at the end of the afternoon. Here's the case for Attaform.

## One source of truth: your schema

Write a Zod schema. That's the source of truth for:

- **Types** — every path, value, error, and write shape is inferred. No `any`, no manual generics, no reaching for the type plumbing whenever you add a field.
- **Defaults** — Attaform reads the schema's slim shape (`''` for strings, `0` for numbers, `false` for booleans) and uses it as the storage default. Override per field; don't repeat what the schema already says.
- **Validation** — refinements run synchronously by default; async refinements await before submit dispatches.
- **Errors** — refinements emit, paths surface — `form.errors.email` is reactive end-to-end.

One schema in, full reactive surface out.

## Type-safe end to end

Every part of the public surface is typed against your schema:

```ts
const form = useForm({
  schema: z.object({
    email: z.email(),
    age: z.number().int().min(13),
  }),
})

form.setValue('age', 21) // ok
form.setValue('age', 'twenty-one') // type error
```

`form.fields.<path>` knows the exact set of paths in the schema. `form.errors.<path>` is reactive, typed, narrowable. `form.setValue` rejects values that don't match.

## Live, layered validation

- Per-field on `change`, `blur`, or `submit` — your call, per form.
- Sync refinements fire on the keystroke; async refinements await.
- A form's `meta.valid` is _gated_ — it only flips true after every active path has resolved at least one validation pass, including the async ones. No flash-of-valid window for users with a slow uniqueness check.
- Server-side errors map back into the same reactive store. The render surface is the same whether the error came from Zod or your API.

## SSR-first, hydration-clean

Forms render server-side and hydrate without a flash. Nuxt is zero-config; bare Vue 3 plus `@vue/server-renderer` takes two one-liner helpers. The form your server rendered _is_ the form your client picks up.

## Built-in, not bolted on

These ship with the core — typed and orchestrated, not as third-party plugins:

- Field arrays with stable keys and per-item validation.
- Undo / redo with bounded history, opt-in per form.
- Persistence with per-field opt-in, local / session / IndexedDB / custom backends, and sensitive-name guards out of the box.
- Discriminated unions with variant memory across discriminator switches.
- A DevTools panel that surfaces every form on the page — values, errors, history, persistence drafts.

## Native inputs, Vue directive

`v-register` is a Vue directive, not a wrapper component. Your `<input>` stays a native `<input>`; there's no field-component overhead between the DOM and the form.

```vue
<input v-register="form.register('email')" />
```

That's the whole binding. A11y attributes, value sync, focus state, blank tracking — all native.

## Where to next

- [Quick start](/docs/getting-started/quick-start) — your first form, end-to-end.
- [The form object](/docs/reading-the-form/the-form-object) — the full reactive surface returned by `useForm`.
- [When validation runs](/docs/validation/when-validation-runs) — the moment errors appear.
- [The `v-register` directive](/docs/binding-inputs/v-register) — how Attaform binds inputs.
