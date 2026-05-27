---
title: Display state and showing errors
description: getDisplayState resolves every path to one verdict (idle, pending, error, or success). The default holds errors back until a submit attempt or a blur, surfaces a spinner while async checks run, and confirms a clean field with success, never duplicating errors a more-specific descendant already renders.
metaRows:
  - label: Category
    value: Option
  - label: Option
    value: getDisplayState
    kind: code
  - label: Default
    value: defaultDisplayState
    kind: code
---

# Display state and showing errors

> Errors exist in the store the moment validation runs; the display state decides what the UI surfaces, and when.

::docs-meta-table
::

Every path on a form carries a single display-state verdict, `field.displayState`, that is one of four values:

- `'idle'`: nothing to surface yet.
- `'pending'`: an async check is in flight.
- `'error'`: a blocking error is ready to show.
- `'success'`: the field has passed and earned its green check.

`getDisplayState` is the one heuristic that resolves that verdict, and it runs for every field. Attaform's default holds back until the user has actually interacted with a field, so a fresh-page form does not open with every required field already complaining.

::docs-demo{slug="display-state" label="Display State Demo"}
::

## Sugar over the verdict

The four `show*` booleans are exact projections of `displayState`, so they can never disagree with it:

| Boolean       | True when                    |
| ------------- | ---------------------------- |
| `showErrors`  | `displayState === 'error'`   |
| `showPending` | `displayState === 'pending'` |
| `showSuccess` | `displayState === 'success'` |
| `showIdle`    | `displayState === 'idle'`    |

Bind whichever reads cleanest. A field that narrates all of its states in one template block:

```vue
<input v-register="form.register('email')" />
<p v-if="form.fields.email.showErrors">{{ form.fields.email.firstError?.message }}</p>
<Spinner v-else-if="form.fields.email.showPending" />
<CheckIcon v-else-if="form.fields.email.showSuccess" />
```

Prefer one branch over the set? Switch on `form.fields.email.displayState` directly. Either way, the same verdict drives the same paint.

## The default heuristic

The default opens one timing gate, then resolves the verdict by precedence.

### 1. Timing gate

The gate opens when either:

- The form has attempted at least one submit (`formMeta.submissionAttempts > 0`), OR
- The field has been touched (sticky-true after the first blur) AND is not currently focused.

Until the gate opens, `displayState` is `'idle'` no matter what is in the store. The not-focused half keeps transient errors quiet while the user is actively editing the field; they reappear when the user blurs or moves to a sibling. The empty-required-field case is covered: `touched` flips on blur regardless of whether the value changed, so a user who visits an empty required field and moves on sees the error.

### 2. Precedence

Once the gate is open, the default resolves in order:

1. **Pending.** A per-field validation run in flight (`field.validating`) wins. The verdict in `field.errors` is stale by definition, so Attaform surfaces a spinner rather than a possibly-wrong message.
2. **Error.** An own-path error resolves to `'error'`.
3. **Success.** No error and `field.valid` resolves to `'success'`, the green-check confirmation. `valid` already waits on the form-wide first validation pass for async schemas, so success never fires before the first real verdict lands.
4. **Idle.** Anything else stays `'idle'`.

### The own-path filter

The error arm fires only on an error whose path equals the field's own path.

- **Leaves** always satisfy this when they have errors (a leaf's errors are at its own path).
- **Containers** (intermediate AND root) resolve to `'error'` only for errors that point directly at them. Descendant errors are rendered by the descendant fields, so binding `field.showErrors` at a container never duplicates them.

That means `form.meta.displayState` only reaches `'error'` for root-level (cross-field or object-level) errors. Aggregate "fix the errors below" banners should bind to `form.meta.errorCount > 0` paired with whatever timing signal fits, not to `form.meta.showErrors`.

## Override per form

```ts
useForm({
  schema,
  getDisplayState: (field) => (field.errors.length > 0 && field.touched ? 'error' : 'idle'),
})
```

Pass a custom predicate to bend the rule, for example to reveal errors the moment a field is touched (ignoring focus and submit state). The predicate receives the field's `FieldState` and the form's `FormMeta`, both with the derived `displayState` / `show*` / `firstError` keys omitted so an accidental self-reference is impossible, and returns the verdict.

## Compose with the default

Adopter predicates can layer on top of `defaultDisplayState`. Defer to it for the common case and special-case only the paths you care about:

```ts
import { defaultDisplayState } from 'attaform'

useForm({
  schema,
  // Defer everywhere, but never show a success check on `username`.
  getDisplayState: (field, formMeta) => {
    const state = defaultDisplayState(field, formMeta)
    return field.path[0] === 'username' && state === 'success' ? 'idle' : state
  },
})
```

## Where to next

- [`errors`](/docs/reading-the-form/errors): the error reads themselves.
- [When validation runs](/docs/validation/when-validation-runs): the timing knob for the underlying validation pass.
