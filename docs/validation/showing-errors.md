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
- `'pending'`: a check has been running long enough to earn a spinner.
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

1. **Pending (timed).** While a per-field validation runs, the field is heading for a spinner, but Attaform holds the prior verdict for a short window first. A fast check that settles inside that window never shows `'pending'` at all; a slow one flips to the spinner and is then held a minimum so it cannot blink off. This anti-flash timing is tunable, see [Tune the timing](#tune-the-timing).
2. **Error.** An error at the field resolves to `'error'` (containers roll up their descendants, see below).
3. **Success.** No error, `field.valid`, and the green check is earned: the field is non-blank and `dirty`, so the user put valid content there themselves. An empty field that happens to pass, a pre-filled field merely tabbed through, and the post-submit flood of every valid field all stay `'idle'` rather than greening for free. `valid` already waits on the form-wide first validation pass for async schemas, so success never fires before the first real verdict lands.
4. **Idle.** Anything else, including a valid-but-unearned field (blank or unchanged), stays `'idle'`.

### Rollup at containers and the form

A container resolves over the gated verdicts of everything beneath it, so one verdict reflects the whole subtree.

- **Leaves** resolve on their own error.
- **Containers** (an object, an array row, the array itself, and the root `form.meta`) resolve to `'error'` when any descendant is showing an error, or when a cross-field error is pinned at the container itself. Each descendant counts only once its own gate has opened, so a sibling that has been blurred never drags an untouched field's error up to the group.

Precedence rolls up too: a container shows `'pending'` while any descendant is still checking, `'error'` if a gated descendant (or the container's own cross-field check) failed, `'success'` once every field is valid and at least one is earned, and `'idle'` otherwise. An untouched optional sibling sits `'idle'` without holding the group's success back.

That makes `form.meta.showErrors` the natural binding for a form-level "fix the errors below" banner: it turns on the moment a field's error becomes visible and off when the last one clears.

::docs-demo{slug="container-display-state" label="Container rollup demo"}
::

## Override per form

```ts
useForm({
  schema,
  getDisplayState: (prev, ctx) =>
    ctx.field.errors.length > 0 && ctx.field.touched ? { display: 'error' } : { display: 'idle' },
})
```

Pass a custom reducer to bend the rule, for example to reveal errors the moment a field is touched (ignoring focus and submit state). A reducer receives `(prev, ctx)`: `prev` is the field's previous `DisplayMachine`, and `ctx` carries the field's `FieldState` and the form's `FormMeta` (both with the derived `displayState` / `show*` / `firstError` keys omitted, so an accidental self-reference is impossible) plus `ctx.validatingSince` and `ctx.now` for timing. It returns the next machine: `{ display }` at minimum, optionally with a `reviewAt` timestamp telling Attaform when to look again.

## Compose with the default

Adopter reducers can layer on top of `defaultDisplayState`. Defer to it for the common case and special-case only the paths you care about:

```ts
import { defaultDisplayState } from 'attaform'

useForm({
  schema,
  // Defer everywhere, but never show a success check on `username`.
  getDisplayState: (prev, ctx) => {
    const next = defaultDisplayState(prev, ctx)
    return next.display === 'success' && ctx.field.path[0] === 'username'
      ? { display: 'idle' }
      : next
  },
})
```

## Tune the timing

The spinner is anti-flash by default. A validation that settles quickly never shows `'pending'` at all, and once a spinner appears it stays up for a minimum so it cannot blink off the instant the check lands. Two timings shape this, both in milliseconds:

- `showDelay` (default `100`): how long a validation may run before its spinner is allowed to show. Anything that settles inside this window stays on its prior verdict, so a synchronous or microtask-fast check never flashes a spinner on every keystroke.
- `minVisible` (default `120`): once shown, the minimum the spinner stays up, so a check that lands just past `showDelay` does not flash it on and immediately off.

The shipped values live in `DEFAULT_TIMINGS`. To retune, build a default with `makeDefaultDisplayState`:

```ts
import { makeDefaultDisplayState } from 'attaform'

useForm({
  schema,
  // Tighter: a spinner after 50ms, held for 200ms once shown.
  getDisplayState: makeDefaultDisplayState({ showDelay: 50, minVisible: 200 }),
})
```

This shapes only the display projection. `errors`, `valid`, `validating`, and the underlying validation all run exactly as before; only when the spinner appears and how long it lingers change. For total control, a from-scratch reducer owns its own timing by returning a `reviewAt` (an absolute `Date.now()` stamp) to tell Attaform when to re-evaluate the field.

## Where to next

- [`errors`](/docs/reading-the-form/errors): the error reads themselves.
- [When validation runs](/docs/validation/when-validation-runs): the timing knob for the underlying validation pass.
