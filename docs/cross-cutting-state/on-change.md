---
title: onChange
description: form.onChange is a side-channel for reacting to partial value changes. Autosave a field, mirror one into another, fire analytics. It runs side effects without ever touching the form's own lifecycle.
metaRows:
  - label: Category
    value: Return method
  - label: Call forms
    value: onChange(handler) · onChange(source, handler)
    kind: code
  - label: Construction option
    value: useForm({ onChange })
    kind: code
  - label: Returns
    value: stop()
    kind: code
  - label: Side-channel
    value: never marks dirty, touched, or validating
---

# `onChange`

> A side-channel for reacting to value changes: autosave a subform, mirror one field into another, fire analytics on edit. It runs side effects and nothing else, the form's own dirty / validating lifecycle stays untouched.

::docs-meta-table
::

The demo wires a tiny autosave: each field saves itself ~700ms after you stop typing, and a status badge tracks every save. The badge lives in the component's own state, not the form's. Type fast to watch a stale save get superseded; tick the box to watch a failed save retry and recover; load the saved profile to watch a hydrating write land without echoing back through the save loop.

::docs-demo{slug="on-change" label="onChange Autosave Demo"}
::

## The side-channel principle

`onChange` is a pure event subscription. It fires after a value lands, hands you the new value, and gets out of the way. What it deliberately does **not** do is just as important:

- It never marks the form dirty, touched, or validating. A handler running is invisible to `form.meta` (the form-level rollup) and every `fields.<path>` flag.
- It owns no reactive state. There is no `field.saving` or `form.watching`. Autosave status lives in your own ref (the demo's status badge); validation feedback lives in `.refine` and `fields.<path>.show*`.

That line is what keeps the surface small and the mental model honest. `onChange` is the **writes** half of reacting to changes (persistence, analytics, mirroring). The **reads** half (does this value pass a server check?) belongs in an [async refinement](/docs/validation/async-refinements), where the verdict flows into `form.errors` like any other validation. The two never blur together.

## Call forms

Each example assumes a `form` handle from `useForm({ schema })`.

**The whole form.** Omit the source. The handler gets the current form value, and `ctx.changed` lists the leaf paths that moved:

```ts
const form = useForm({ schema })

form.onChange((values, ctx) => {
  analytics.track('form_edited', { fields: ctx.changed })
})
```

**One path.** Pass a dotted path. The value is typed as that path's value, no annotation needed:

```ts
form.onChange('user.email', (email, ctx) => {
  // email is inferred as string
})
```

**A list of paths.** Pass an array. The handler fires once per matched path, and `ctx.path` names which one fired:

```ts
form.onChange(['shipping.city', 'shipping.zip'], (value, ctx) => {
  refreshTaxEstimate(ctx.path)
})
```

An empty list (`form.onChange([], handler)`) lists zero paths, so it never fires. Reaching the whole form is "omit the source," never "pass `[]`," so a dynamically built empty list can't silently become "watch everything."

**A moving target.** Pass a getter, ref, or computed. Attaform re-resolves it on every write, so the aim can follow a live pointer like the active list row:

```ts
const activeRow = ref(0)

form.onChange(
  () => `items.${activeRow.value}.quantity`,
  (quantity, ctx) => {
    // re-aimed each write; ctx.path tracks the current row
  }
)
```

**At construction.** `useForm({ onChange })` registers a whole-form handler bound to the form's lifetime, handy when the handler is portable and you'd rather declare it next to the schema:

```ts
const form = useForm({
  schema,
  onChange: (values, ctx) => {
    draftStore.save(values)
  },
})
```

The construction option also takes a `{ handler, onError }` pair when you want error routing:

```ts
useForm({
  schema,
  onChange: {
    handler: (values, ctx) => draftStore.save(values),
    onError: (error, ctx) => ctx.retry(),
  },
})
```

## The handler context

Every handler receives `(value, ctx)`. `value` is the value at the source path (the whole form for a root handler); `ctx` carries the rest:

| `ctx` field | What it holds                                                                                                                   |
| ----------- | ------------------------------------------------------------------------------------------------------------------------------- |
| `path`      | The source path this fire is for, dotted (`'user.email'`); `''` for the whole form.                                             |
| `previous`  | The value at this path before the change, seeded at registration. (See the container caveat below.)                             |
| `changed`   | The leaf paths that actually moved this dispatch, dotted. `[path]` for a leaf, the changed descendants for a container or root. |
| `signal`    | An `AbortSignal`, aborted when a newer write to the same source supersedes this run.                                            |
| `attempt`   | The retry counter: `0` on the first run, bumped by `onError`'s `retry()`.                                                       |
| `form`      | The form handle, so a portable `useForm({ onChange })` handler can reach back in (e.g. to gate on validity).                    |

`ctx.previous` is exact for a leaf source. For a container or the whole form, an in-place leaf edit preserves the container's reference (the same identity Attaform keeps so unrelated bindings don't re-render), so `previous` can be reference-equal to the current value, the classic deep-watch gotcha. If you need a true before / after container diff, snapshot inside the handler.

## What fires it, and what doesn't

`onChange` reacts to **user edits**, not to every write that touches storage.

A handler fires when a real change reaches its source path. Attaform only records a change when a value actually moved (writing the same value back is a no-op), so there is no separate equality check to wire up, and a handler never fires for a write that changed nothing.

Matching is prefix-based in both directions. A write to `user.email` fires a `user.email` handler and a `user` handler and a whole-form handler. A whole-`user` replacement fires a `user.email` handler too. So a subform handler hears edits to any field beneath it, and a field handler hears the field being replaced wholesale.

These writes are rebaselines, not edits, so they stay silent:

| Suppressed write            | Why                                                                                                |
| --------------------------- | -------------------------------------------------------------------------------------------------- |
| Persistence hydration       | Restoring a saved draft on mount is loading state, not editing it.                                 |
| Cross-tab echo              | A value arriving from a sibling tab already fired `onChange` in that tab.                          |
| `reset()` / `reset(record)` | Resetting rebaselines the form; loading data via `reset(record)` shouldn't trip an immediate save. |
| `setValue(..., { silent })` | The explicit consumer opt-out (next section).                                                      |

## Opting a write out with `{ silent }`

Pass `{ silent: true }` to land a value without firing `onChange`. The write is otherwise completely normal: storage, validation, persistence, and history all see it. Only the side-channel is skipped.

```ts
form.setValue('user.email', saved.email, { silent: true }) // one path
form.setValue(savedRecord, { silent: true }) // whole form
```

This is the tool for hydrating the form from a fetched record. Without it, loading ten saved fields would echo ten autosaves straight back at the server you just loaded from. The flag is per call, so the next ordinary edit fires as usual.

## Async handlers: supersession and cancellation

A handler can be async, and autosave usually is. Dispatch stays synchronous at the write boundary, so the keystroke never waits; the async body runs in the background.

When a newer write hits the same source before the previous run finished, Attaform aborts the previous run's `ctx.signal` and supersedes it. Latest write wins. Pass the signal to `fetch` (or check `ctx.signal.aborted` after an `await`) so superseded work cancels itself instead of racing the winner to the server:

```ts
form.onChange('user.email', async (email, ctx) => {
  await api.save({ email }, { signal: ctx.signal })
})
```

A superseded run's rejection is dropped rather than surfaced, so an aborted save won't fire `onError`.

To gate the save on the field being valid first, reach back through `ctx.form`. This is the seam between the two halves: `.refine` decides validity, `onChange` decides persistence, and you compose them when you want "save only what passes":

```ts
form.onChange('user.email', async (email, ctx) => {
  const verdict = await ctx.form.validateAsync(ctx.path)
  if (!verdict.success) return
  await api.save({ email }, { signal: ctx.signal })
})
```

## Errors never reach the keystroke

A handler that throws or rejects never throws into the write that triggered it. The failure routes to `options.onError(error, ctx)`, or is swallowed (and logged in development) when no handler is set. The user keeps typing either way.

```ts
form.onChange('user.email', save, {
  onError: (error, ctx) => {
    if (ctx.attempt < 3) ctx.retry()
    else toast.error('Could not save your email. We will retry on the next edit.')
  },
})
```

`ctx.retry()` re-runs the handler with the same value and `attempt + 1`. It is a no-op once a newer write has superseded the run, so a retry never resurrects stale work. Backoff and a retry cap are yours to impose. Keep validation messaging out of here: a rejected save is an infrastructure problem (the network blipped), not a "this value is invalid" problem, which stays in `.refine`.

## Cleanup

`form.onChange(...)` returns an idempotent `stop()`. Called inside a component's `setup`, it also stops automatically when that component unmounts, so a handler declared in setup needs no manual teardown:

```ts
const stop = form.onChange('user.email', save)
// call stop() to detach early; otherwise it detaches on unmount
```

A `useForm({ onChange })` handler binds to the form's own lifetime and is released when the form is.

## On the server

`onChange` registration is a no-op during SSR. There is no autosave on the server and no write loop to react to, so it returns a no-op `stop()` and your consumer cleanup stays uniform across server and client.

## Validation versus persistence

`onChange` is the persistence channel. When you want to react to a value by checking it against a server (is this username taken?), that is validation, and it belongs in an async refinement instead, where the verdict lands in `form.errors` and `handleSubmit` awaits it before dispatch. Nothing stops you from writing to a server inside a refinement, but a refinement's job is to return a verdict, and folding a side effect into it tangles "is this valid?" with "save this," the exact split `onChange` exists to keep clean.

Reach for `onChange` to **write** (autosave, analytics, mirroring). Reach for [`.refine`](/docs/validation/async-refinements) to **read** (server-side validity). Compose them, as above, when an autosave should only fire for a value that passes.

## Where to next

- [Autosave](/docs/cross-cutting-state/autosave): the production recipe built on `onChange`, debounced and validity-gated, with per-field and aggregate status.
- [Async refinements](/docs/validation/async-refinements): the reads half, server-side validity through `.refine`.
- [`setValue` patterns](/docs/writing-and-mutating/set-value): the write surface that carries the `{ silent }` opt-out.
