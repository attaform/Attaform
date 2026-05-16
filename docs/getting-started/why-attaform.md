---
title: Why Attaform
description: The case for picking Attaform for Vue 3 forms. Type-safe end to end, schema-driven defaults, layered validation, SSR-clean hydration, and built-in persistence, history, and devtools.
---

# Why Attaform

> Five marks of a great form library. Attaform's North star, top to bottom.

Forms look simple from the outside. Inside, they're a thicket of subtle details: blank-value tracking, persistence, sensitive-name protection, multi-tab sync, SSR, async validation, nested objects and discriminated unions, efficient DOM tracking, errors flowing from validators and your server into one reactive form API. A great library handles every one for you, without making you reach for the type plumbing or wire up the side-channels yourself.

These five convictions guide Attaform's design:

1. **Telepathically accurate type safety.** Types flow from your schema into every surface: values, errors, paths, write shapes, etc. We don't do `any`.
2. **A tiny, predictable API that just works.** Small surface, no surprises. If you can't learn the core API in five minutes, it's not good enough.
3. **Stays out of your markup.** One directive, `v-register`, does the heavy lifting. Your `<input>` stays a native `<input>`; nothing sits between the DOM and the form.
4. **Vue conventions, end to end.** Composables, reactivity, directives: the shapes you already know.
5. **The schema drives everything.** Data shape, defaults, validation, errors, and types. All from one Zod schema.

Why? Because at the end of the day, Vue and Nuxt devs deserve nice things too.

## One source of truth: your schema

Write a Zod schema. That's the source of truth for:

- **Types.** Every path, value, error, and write shape is inferred. No `any`, no manual generics, no reaching for the type plumbing whenever you add a field.
- **Defaults.** Attaform reads the schema's slim shape (`''` for strings, `0` for numbers, `false` for booleans) and uses it as the storage default. Override per field; don't repeat what the schema already says.
- **Validation.** Refinements run synchronously by default; async refinements await before submit dispatches.
- **Errors.** Each one lands at the offending path. `form.errors.email` is reactive end-to-end.
- **Metadata.** Labels, descriptions, placeholders, and free-form meta attach to schema fields and surface on `form.fields.<path>`.

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

`form.fields.<path>` knows the exact set of paths in the schema. `form.errors.<path>` is reactive, typed, narrowable.

## Native inputs, Vue directive

`v-register` is a Vue directive, not a wrapper component. Your `<input>` stays a native `<input>`; there's no field-component overhead between the DOM and the form.

```vue
<input v-register="form.register('email')" />
```

That's the whole binding. A11y attributes, value sync, focus state, blank tracking. All native.

## Live, layered validation

- Per-field on `change`, `blur`, or `submit`. Your call, per form.
- Sync refinements fire on the keystroke; async refinements await.
- A form's `meta.valid` is _gated_. It only flips true after every active path has resolved at least one validation pass, including the async ones. No flash-of-valid window for users with a slow uniqueness check.
- Server-side errors map back into the same reactive form API. The render surface is the same whether the error came from Zod or your API.

## SSR-first, hydration-clean

Forms render server-side and hydrate without a flash. Nuxt is zero-config; bare Vue 3 plus `@vue/server-renderer` takes two one-liner helpers. The form your server rendered _is_ the form your client picks up.

## Built into the core

These ship with the core, typed and orchestrated as first-class features:

- Field arrays with stable keys and per-item validation.
- Undo / redo with bounded history, opt-in per form.
- Persistence with per-field opt-in, local / session / IndexedDB / custom backends, and sensitive-name guards out of the box.
- Multi-tab sync over BroadcastChannel, secure-context gated.
- Discriminated unions with variant memory across discriminator switches.
- A DevTools panel that surfaces every form on the page: values, errors, history, persistence drafts.

## Where to next

- [Quick start](/docs/getting-started/quick-start): your first form, end-to-end.
- [The form object](/docs/reading-the-form/the-form-object): the full reactive surface returned by `useForm`.
- [When validation runs](/docs/validation/when-validation-runs): the moment errors appear.
- [The `v-register` directive](/docs/binding-inputs/v-register): how Attaform binds inputs.
