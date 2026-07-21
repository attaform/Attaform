---
title: Display state and showing errors
description: getDisplayState resolves every path to one verdict (idle, pending, error, success). It holds errors until a blurred edit or a submit, spins during async checks, and never repeats a descendant's error.
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
3. **Success.** No error, `field.valid`, and the green check is earned: the field is non-blank and the user engaged with it, meaning `dirty` (the value differs from its baseline) or `interacted` (they edited it, or `form.interact()` declared the field engaged). An empty field that happens to pass, a pre-filled field merely tabbed through (which sets `touched`, never `interacted`), and the post-submit flood of every valid field all stay `'idle'` rather than greening for free. `valid` already waits on the form-wide first validation pass for async schemas, so success never fires before the first real verdict lands.
4. **Idle.** Anything else, including a valid field nobody has engaged with, stays `'idle'`.

Engagement, not net change, is what the check rewards. A user who types into a field and then puts the original value back has `dirty: false` but `interacted: true`, and still earns the green check, because they did the work.

### Rollup at containers and the form

A container resolves over the gated verdicts of everything beneath it, so one verdict reflects the whole subtree.

- **Leaves** resolve on their own error.
- **Containers** (an object, an array row, the array itself, and the root `form.meta`) resolve to `'error'` when any descendant is showing an error, or when a cross-field error is pinned at the container itself. Each descendant counts only once its own gate has opened, so a sibling that has been blurred never drags an untouched field's error up to the group.

Precedence rolls up too: a container shows `'pending'` while any descendant is still checking, `'error'` if a gated descendant (or the container's own cross-field check) failed, `'success'` once every field is valid and at least one is earned, and `'idle'` otherwise. An untouched optional sibling sits `'idle'` without holding the group's success back.

That makes `form.meta.showErrors` the natural binding for a form-level "fix the errors below" banner: it turns on the moment a field's error becomes visible and off when the last one clears.

### `form.meta` during a submit

`form.meta.showPending` reflects validation, including the validation a submit runs before your handler. A submit re-validates the whole form, so `form.meta.showPending` stays lit through that pass and a form-level "Checking…" affordance reads true during it. It does not light during the handler itself, because `show*` tracks validation, never submission.

To gate a submit button across the whole submit (its validation and your handler), bind `form.meta.submitting`, the flag that means a submit is in flight:

```vue
<button type="submit" :disabled="form.meta.submitting">
  {{ form.meta.submitting ? 'Submitting…' : 'Submit' }}
</button>
```

So `form.meta.showPending` is the broad "the form is validating" light and `form.meta.submitting` is the precise "a submit is running" flag: use the first for an ambient indicator, the second to gate the button.

This detour is `form.meta`-only: the submit-driven `pending` is applied at the root, so an individual field never flips to a spinner just because a submit is validating, and each field keeps showing its own verdict throughout. And `showSuccess`, like every verdict, is a validation signal, not a "submission finished" one: for a "Saved" confirmation, gate on `form.meta.submitted` (which flips once the handler resolves), not on `showSuccess`.

::docs-demo{slug="container-display-state" label="Container rollup demo"}
::

## Reveal errors without a submit

The gate is built around a real user gesture, so values that arrive some other way (a server-seeded draft, a pasted import, a row populated by a picker) sit on their errors until the user visits every field or the form is submitted. `form.interact(path)` closes that gap by simulating a complete focus, edit, and blur across every field under `path`:

```ts
const schema = z.object({
  members: z.array(z.object({ name: z.string().min(1), email: z.string().email() })),
})

const form = useForm({ schema })

// Arm just this row's errors, and leave the rest of the page alone.
await form.interact(['members', 2])
```

::docs-demo{slug="interact" label="Reveal one subtree's errors"}
::

It flips the same `blurredAfterInteraction` bit a real blurred edit sets and runs the subtree's validation, so the gate opens through its front door and the errors are in the store ready to surface. Scope is the win: a submit is form-wide and lights up every field on the page, while `form.interact(path)` reveals exactly the subtree you name. Call it with no argument to arm the whole form.

The returned promise resolves once that subtree's validation has committed, so awaiting it means the verdicts are ready to read:

```ts
await form.interact(['members', 2])
form.fields(['members', 2, 'email']).showErrors // ready
```

Ignoring the promise is fine too. The flags land synchronously, so a fire-and-forget call still reveals the errors the moment validation settles.

`interact` walks schema fields rather than mounted inputs, so it reaches a field that is currently `v-if`'d away or was never rendered. The flags are sticky, so a subtree armed while a modal was open stays revealed when that modal reopens. On a form held by [`disabled`](/docs/cross-cutting-state/disabled) it does nothing, matching every other interaction signal.

### `interact` vs `touch`

The two are siblings, and picking the right one matters:

| Call                  | Writes                                             | Opens the default gate |
| --------------------- | -------------------------------------------------- | ---------------------- |
| `form.touch(path)`    | `touched`                                          | No                     |
| `form.interact(path)` | `touched`, `interacted`, `blurredAfterInteraction` | Yes                    |

`touched` is the descriptive "this field was visited" flag, and it flips on a bare tab-through with no edit. That is exactly why the default gate reads the stricter `blurredAfterInteraction` instead, and why `form.touch()` on its own does not reveal anything under the default heuristic. Reach for `touch` when a custom reducer or your analytics reads `touched`; reach for `interact` when you want errors on screen.

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

- `showDelay` (default `120`): how long a validation may run before its spinner is allowed to show. Anything that settles inside this window stays on its prior verdict, so a synchronous or microtask-fast check never flashes a spinner on every keystroke.
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
