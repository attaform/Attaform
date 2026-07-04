---
title: meta
description: form.meta is the form-level FieldState aggregation plus seven form-only reads, submitting, submissionAttempts, departAttempts, submitError, errorCount, submitted, and instanceId.
metaRows:
  - label: Category
    value: Return property
  - label: Type
    value: FormMeta<Form>
    kind: code
  - label: Reactive
    value: 'Yes'
  - label: Shape
    value: FieldState aggregation + 7 form-only props
---

# `meta`

> Form-level state in one place: every FieldState bit rolled up across paths, plus the seven form-only reads for the submit cycle and wizard departures.

::docs-meta-table
::

Submit the demo without changing the simulate-failure toggle to watch `submitting` flip true mid-await, `submissionAttempts` increment, and `submitted` flip true once the callback succeeds. Flip the toggle and submit again: `submissionAttempts` still increments and `submitError` populates with the rejected callback's message, but `submitted` stays false because the callback never resolved. The [Form-only properties](#form-only-properties) section below names every bit; the inherited FieldState aggregations [link forward to the fields page](/docs/reading-the-form/fields).

::docs-demo{slug="meta" label="Meta Demo"}
::

## Two halves

`form.meta` extends `FieldState` with seven form-only properties. That means `meta` has 38 reads total:

- 31 properties inherited from FieldState, aggregated across every leaf in the form.
- 7 form-only properties that describe the submit cycle and the wizard-departure counter.

The inherited bits are documented once on the [`fields` page](/docs/reading-the-form/fields): same property names, same types, same reactivity. The only difference is the aggregation:

```ts
form.fields.email.dirty // this one field
form.meta.dirty // any field in the form
form.meta.errors // every error across every path (the whole-form aggregate)
form.meta.ownErrors // the root [] bucket alone: the form's own top-level errors
form.meta.value // the full form values object
```

`meta.errors` rolls up every path. `meta.ownErrors` is the exception to the aggregation rule: it reads the root's own bucket only, the form-level errors a root `.refine()` or a path-less `setErrors` pins at `[]`, with no field errors folded in. It is the banner accessor.

## Form-only properties

These seven reads exist only on `meta`, not on individual FieldStates.

| Property             | Type      | Meaning                                                                                                                                                                                           |
| -------------------- | --------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `submitting`         | `boolean` | `true` while a `handleSubmit`-produced handler is running. Covers both the validation phase and the async callback.                                                                               |
| `submissionAttempts` | `number`  | How many times the handler has been invoked (pass or fail). Useful for "show errors after first submit" UX.                                                                                       |
| `departAttempts`     | `number`  | How many times wizard navigation has actually departed this form. Bumps on real departures only (no-op back / same-key goTo / blocked next stay put).                                             |
| `submitError`        | `unknown` | The error from the most recent callback rejection. `null` on success and at the start of each new attempt.                                                                                        |
| `errorCount`         | `number`  | Scalar mirror of `errors.length`. Read it from templates and `watch()` without indexing the array.                                                                                                |
| `submitted`          | `boolean` | `true` once a `handleSubmit` callback resolves without throwing and without leaving errors set. Failed submits, including a `setErrors(...); return`, leave it `false`. Zeroed by `form.reset()`. |
| `instanceId`         | `string`  | Per-`useForm()`-call identity, stable for the lifetime of one call. New on every fresh mount.                                                                                                     |

## Templates

The classic submit-button pattern reads two bits:

```vue
<button :disabled="form.meta.submitting" type="submit">
  {{ form.meta.submitting ? 'Saving…' : 'Save' }}
</button>
```

The "show errors after first submit attempt" pattern reads the counter so failed attempts count:

```vue
<p v-if="form.meta.submissionAttempts > 0 && form.meta.errorCount > 0">
  {{ form.meta.errorCount }} field(s) need attention.
</p>
```

The form-level error banner reads `firstOwnError`, the form's own top-level error (a root `.refine()`, a path-less `setErrors`), with no field error mixed in:

```vue
<p v-if="form.meta.firstOwnError" role="alert">
  {{ form.meta.firstOwnError.message }}
</p>
```

The demo pairs two passwords with a root `.refine()`. Submit a mismatch and the refine's error lands at the form root, where `form.meta.firstOwnError` reads it for the banner and `form.meta.ownErrors` holds the whole root bucket:

::docs-demo{slug="root-errors" label="Root Error Banner"}
::

The "post-success confirmation" pattern reads `submitted` instead, so the banner only renders after the callback actually succeeded. A callback that hands a server rejection to `setErrors` and returns counts as a failed submit, so the banner stays hidden:

```vue
<p v-if="form.meta.submitted && !form.meta.dirty">All saved.</p>
```

The form-summary pattern reads three:

```vue
<p>
  {{ form.meta.dirty ? 'Unsaved changes' : 'No changes' }} ·
  {{ form.meta.valid ? 'Ready to submit' : `${form.meta.errorCount} error(s)` }} ·
  Submitted {{ form.meta.submissionAttempts }} time(s)
</p>
```

## submitError lifecycle

`submitError` mirrors what the callback threw or rejected with, coerced to a real `Error` (a non-`Error` throw keeps its origin on `.cause`). `handleSubmit` catches the throw rather than re-raising it, so a rejected `onSubmit` never escapes as an unhandled rejection.

- `null` at form mount, between attempts, and on success.
- Set to the thrown / rejected value on callback failure.
- Cleared at the start of the next submit attempt.

A thrown callback surfaces twice. `submitError` is the raw-`Error` inspection channel above; the same failure is also piped into the error layer as a `ValidationError`. A bare `throw new Error(...)` lands form-level (the root `[]` bucket), where [`form.meta.firstOwnError`](#templates) and `form.meta.ownErrors` read it for a banner; throw a `{ path, message, code? }` (or an array of them) to land it on a specific field, where it joins `form.errors.<path>` under your own `code`. Either way it also rolls into `form.meta.errors`. This is separate from the `setErrors` path, which never touches `submitError`.

Reach for it when an inline failure banner needs to react to submit errors without your own `try { await onSubmit() }` wrapper:

```vue
<p v-if="form.meta.submitError" class="error">
  Submission failed:
  {{
    form.meta.submitError instanceof Error
      ? form.meta.submitError.message
      : String(form.meta.submitError)
  }}
</p>
```

## departAttempts

`departAttempts` counts how many times `wizard.next`, `wizard.back`, or `wizard.goTo` has actually left this form's step. The counter bumps on real departures only:

- `back()` from the first step is a no-op and leaves it alone.
- `goTo(currentKey)` (same-key jump) leaves it alone.
- `next()` blocked by failed activation leaves it alone.

The counter is a pure read; Attaform's default `getDisplayState` heuristic runs off `submissionAttempts` instead. Reach for `departAttempts` when an analytics event, a prior-step badge, or a layered error-reveal predicate wants the "user visited and left" signal:

```ts
watch(
  () => form.meta.departAttempts,
  (count) => {
    if (count === 1) analytics.track('step_first_departure', { form: form.key })
  }
)
```

Cleared by `form.reset()` alongside the submission counters.

## instanceId

`instanceId` distinguishes two mounts of the same shared form. Two `useForm({ key: 'signup' })` calls return the same FormStore (so writes in one reflect in the other), but `form.meta.instanceId` differs. Useful when devtools, telemetry, or e2e selectors need to disambiguate which mount triggered an event.

```vue
<form :data-form-id="form.meta.instanceId" @submit="onSubmit">
  …
</form>
```

Treat as identity, not state: don't parse it, don't compare ordinally, don't persist.

## Where to next

- [`fields`](/docs/reading-the-form/fields): the per-leaf FieldState, including every property `meta` inherits.
- [`handleSubmit`](/docs/submitting/handle-submit): the dispatch surface that drives `submitting`, `submissionAttempts`, and `submitError`.
- [The form](/docs/reading-the-form/the-form): the full reactive surface that surrounds `meta`.
