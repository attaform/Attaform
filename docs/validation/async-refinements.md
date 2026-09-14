---
title: Async refinements
description: Zod's async .refine predicates run alongside sync ones. The form surfaces fields.<path>.validating while they're in flight, and handleSubmit awaits every pending refinement before dispatch.
metaRows:
  - label: Category
    value: Schema pattern
  - label: Triggers
    value: validateOn cadence + handleSubmit gate
  - label: In-flight signal
    value: fields.<path>.validating
    kind: code
  - label: Submit awaits
    value: 'Yes, every pending refinement before onSubmit'
---

# Async refinements

> Predicates that await a server round-trip: uniqueness probes, slug availability, password-breach lookups. Same surface as sync refinements, just with `async`.

::docs-meta-table
::

Type a username and blur the field to watch `validating` flip true for ~700ms while the simulated check runs. Try `ada`, `champ`, or `athlete` to see the "taken" error land. Try any unused name to see it accept. The submit handler awaits every in-flight refinement before dispatching; submitting mid-check holds until the check resolves.

::docs-demo{slug="async-refinements" label="Async Refinements Demo"}
::

## Declare an async predicate

Zod's `.refine` accepts an `async` function:

```ts
z.string().refine(async (v) => isAvailable(v), {
  message: 'That username is taken',
})
```

The predicate runs alongside sync refinements; the chain awaits its resolution before deciding pass / fail. Attaform forwards the awaited result to `form.errors.<path>` and `fields.<path>` like any other refinement.

## In-flight signal

While an async refinement is pending at a path:

- `fields.<path>.validating` is `true`.
- `meta.validating` is `true` when ANY field has a pending async refinement.

Render a "Checking…" indicator next to the field:

```vue
<small v-if="form.fields.username.validating">Checking availability…</small>
```

This is per-field UX; for a form-level spinner reach for `meta.validating` instead.

## `handleSubmit` awaits

The submit handler waits for every pending async refinement before deciding pass / fail:

1. Sync validation runs across every active path.
2. Async refinements await.
3. If every refinement passes, `onSubmit(values)` fires with the parsed Zod output.
4. If anything fails, focus pulls to the first invalid field and `onError(errors)` fires.

Submitting mid-check is safe: the handler holds until the check resolves, then routes through `onSubmit` or `onError`. No flash-of-valid window where the user hits submit while a slow uniqueness probe hasn't finished.

## Debouncing keystroke triggers

By default, sync refinements run on every committed write (with `validateOn: 'change'`, which pairs with the directive's per-keystroke commit). For async refinements, you usually want **blur**: server probes shouldn't fire on every keystroke. Set `validateOn: 'blur'` per form:

```ts
useForm({
  schema,
  validateOn: 'blur', // async probes fire on blur, not keystroke
})
```

Blur mostly fires the probe only when the value changed since the last pass, so refocusing a field and tabbing away without editing it won't re-hit the server. The one carve-out is the first blur after a real edit, which always runs: a user who types, deletes it all back to what was there, and tabs away has still earned a verdict, so that blur pays for a round-trip even though the value is where it started.

Or stay on the per-keystroke trigger and coalesce bursts with `debounceMs`:

```ts
useForm({
  schema,
  validateOn: 'change',
  debounceMs: 400, // wait 400ms of quiet before validating
})
```

See [When validation runs](/docs/validation/when-validation-runs) for the full timing API.

## Race-safety

Two rapid edits before the first probe returns, and the slow first one resolves last: its verdict is dropped, not written. Every scheduled validation pass carries a form-level epoch, and a result whose epoch has already been superseded by a committed newer one never reaches the error store. So `errors.<path>` tracks the newest committed value, and the "earlier request resolves last, overwrites the correct error" race cannot happen.

What Attaform does not do is cancel the request. A Zod refinement is handed the value and nothing else, so there is no signal Attaform could give your `fetch` to abort on. The superseded probe runs to completion and you still pay for it; only its answer is discarded. If those round-trips are expensive enough to care about, own an `AbortController` inside your own check, and cut the number of them with `validateOn: 'blur'` or a `debounceMs` as above.

## Validation, not persistence

An async refinement's job is to return a verdict: it reads a value and answers "is this allowed?". Writing to your server inside that same loop (saving the value while you check it) is tempting, but it tangles two concerns, validity and persistence, into one predicate. Keep the refinement a pure read, and persist on change through an [autosave](/docs/cross-cutting-state/autosave) instead.

The two compose cleanly. An [autosave](/docs/cross-cutting-state/autosave) handler can gate its write on `await form.parse(path, { commit: true })`, so the refinement you wrote here decides whether the save fires. One value check, reused for both the error message and the save gate.

## Where to next

- [Autosave](/docs/cross-cutting-state/autosave): the watch-based recipe for persisting values as they change.
- [The validation lifecycle](/docs/validation/lifecycle): the imperative committing `parse` for non-submit code paths.
- [When validation runs](/docs/validation/when-validation-runs): the `validateOn` cadence knob.
- [`handleSubmit`](/docs/submitting/handle-submit): the dispatch surface that awaits async refinements.
