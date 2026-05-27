---
title: Display state and showing errors
description: getDisplayState resolves every path to one verdict (idle, pending, error, or success). The default holds errors back until a field is edited and blurred or the form is submitted, surfaces a spinner while async checks run, and confirms a clean field with an earned success, never duplicating errors a more-specific descendant already renders.
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
- The field has been edited and then left (`blurredAfterInteraction`, sticky-true after the first blur that follows a value edit).

Until the gate opens, `displayState` is `'idle'` no matter what is in the store. This is "reward early, punish late." A clean tab-through stays quiet: `blurredAfterInteraction` only flips on a blur that follows an edit, so a field the user tabbed through but never edited does not complain until a submit forces the issue. The first pass stays quiet too: editing alone does not open the gate, so the error reveals once the user finishes the pass and leaves the field, never mid-entry, even when the field happened to be tabbed through earlier. And because the bit is sticky and carries no not-focused condition, the gate stays open through a re-focus: once a field has been revealed, fixing its error clears the message live, instead of making the user blur again to see it.

### 2. Precedence

Once the gate is open, the default resolves in order:

1. **Pending.** A per-field validation run in flight (`field.validating`) wins. The verdict in `field.errors` is stale by definition, so Attaform surfaces a spinner rather than a possibly-wrong message.
2. **Error.** An own-path error resolves to `'error'`.
3. **Success.** No error, `field.valid`, and the green check is earned: the field is non-blank and `dirty`, so the user put valid content there themselves. An empty field that happens to pass, a pre-filled field merely tabbed through, and the post-submit flood of every valid field all stay `'idle'` rather than greening for free. `valid` already waits on the form-wide first validation pass for async schemas, so success never fires before the first real verdict lands.
4. **Idle.** Anything else, including a valid-but-unearned field (blank or unchanged), stays `'idle'`.

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
