---
title: Showing errors at the right time
description: shouldShowErrors gates when a path's error gets surfaced — Attaform's default waits for a submit attempt or a touched-and-dirty field, so a half-typed value doesn't get yelled at.
meta:
  - label: Category
    value: Option
  - label: Option
    value: shouldShowErrors
    kind: code
  - label: Default
    value: defaultShouldShowErrors
    kind: code
---

# Showing errors at the right time

> Errors exist in the store the moment validation runs; the predicate decides when the UI surfaces them.

<DocsMetaTable />

`shouldShowErrors` is the predicate that decides whether a path's error should appear in the UI. The library default holds back until the user has actually interacted with a field — so a fresh-page form doesn't open with every required field already complaining.

## The default predicate

```ts
import { defaultShouldShowErrors } from 'attaform'

shouldShowErrors: defaultShouldShowErrors
```

It returns `true` when either:

- The form has attempted at least one submit (`formMeta.submitCount > 0`), OR
- The field is **touched and dirty** — the user typed into it, and the value isn't the schema-default anymore.

Until one of those conditions holds, `field.showErrors` returns `false` even when `errors.<path>` has a value. Your template branches on the predicate-resolved boolean:

```vue
<input v-register="register('email')" />
<p v-if="fields.email.showErrors">{{ errors.email }}</p>
```

## Override per form

```ts
useForm({
  schema,
  shouldShowErrors: (field) => field.blurred,
})
```

Pass a custom predicate to bend the rule — e.g., reveal errors only after a field has been blurred. The predicate receives the field's `FieldState` and the form's `FormMeta`.

Boolean shortcuts work too: `shouldShowErrors: true` always shows; `shouldShowErrors: false` never shows.

## Compose with the default

Adopter predicates can layer on top of the library default:

```ts
import { defaultShouldShowErrors } from 'attaform'

const myPredicate = (field, formMeta) =>
  defaultShouldShowErrors(field, formMeta) || field.firstError === 'critical'
```

## Where to next

- [`errors`](/docs/reading-the-form/errors) — the error reads themselves.
- [When validation runs](/docs/validation/when-validation-runs) — the timing knob for the underlying validation pass.
