---
title: Showing errors at the right time
description: shouldShowErrors gates when a path's error gets surfaced. The default fires after a submit attempt or once the user has blurred the field, and never duplicates errors that more-specific descendants already render.
metaRows:
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

::docs-meta-table
::

`shouldShowErrors` is the predicate that decides whether a path's error should appear in the UI. Attaform's default predicate holds back until the user has actually interacted with a field, so a fresh-page form doesn't open with every required field already complaining.

## The default predicate

```ts
import { defaultShouldShowErrors } from 'attaform'

shouldShowErrors: defaultShouldShowErrors
```

The default runs two checks in sequence.

### 1. Own-path filter

The field must have at least one error whose path equals the field's own path.

- **Leaves** always satisfy this when they have errors (a leaf's errors are at its own path).
- **Containers** (intermediate AND root) only satisfy it for errors that point directly at them. Descendant errors are rendered by the descendant fields, so a UI binding `field.showErrors` at a container never duplicates them.

That means `form.meta.showErrors` only fires for root-level (cross-field / object-level) errors. Aggregate "fix the errors below" banners should bind to `form.meta.errorCount > 0` paired with whatever timing signal fits, not to `form.meta.showErrors`.

### 2. Timing gate

After the filter, the default returns `true` when either:

- The form has attempted at least one submit (`formMeta.submissionAttempts > 0`), OR
- The field has been touched (sticky-true after the first blur) AND is not currently focused.

The not-focused half hides transient errors while the user is actively editing the field; they reappear when the user blurs or moves to a sibling. The empty-required-field case is covered: `touched` flips on blur regardless of whether the value changed, so a user who visits an empty required field and moves on sees the error.

Until one of the timing conditions holds, `field.showErrors` returns `false` even when `errors.<path>` has a value. Your template branches on the predicate-resolved boolean:

```vue
<input v-register="form.register('email')" />
<p v-if="form.fields.email.showErrors">{{ form.fields.email.firstError?.message }}</p>
```

## Override per form

```ts
useForm({
  schema,
  shouldShowErrors: (field) => field.touched === true,
})
```

Pass a custom predicate to bend the rule, for example to reveal errors as soon as a field has been touched once (ignoring focus state). The predicate receives the field's `FieldState` and the form's `FormMeta`, both with `showErrors` and `firstError` omitted to make accidental recursion impossible.

Boolean shortcuts work too: `shouldShowErrors: true` always shows when errors exist; `shouldShowErrors: false` never shows.

## Compose with the default

Adopter predicates can layer on top of `defaultShouldShowErrors`. Defer to it for the common case and special-case only the paths you care about:

```ts
import { defaultShouldShowErrors } from 'attaform'

useForm({
  schema,
  shouldShowErrors: (field, formMeta) =>
    field.path[0] === 'urgent' || defaultShouldShowErrors(field, formMeta),
})
```

## Where to next

- [`errors`](/docs/reading-the-form/errors): the error reads themselves.
- [When validation runs](/docs/validation/when-validation-runs): the timing knob for the underlying validation pass.
