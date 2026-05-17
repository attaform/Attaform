---
title: From inputs to submit
description: Wire a submit handler to a typed form. handleSubmit gates dispatch on validation, exposes the parsed values, and reports back through meta.submitting.
metaRows:
  - label: Read time
    value: ~4 minutes
  - label: Builds on
    value: From schema to inputs
---

# From inputs to submit

> `handleSubmit` waits for validation, hands you parsed values, and reports submission state through `meta.submitting`.

::docs-meta-table
::

The demo binds two inputs (an `email` and a `newsletter` checkbox) and wires a submit handler that runs a 1.2-second simulated API call. Submit with a valid email and the button label switches to "Subscribing…" while the call runs, then a toast confirms the payload. Submit with an invalid email and focus pulls to the broken field automatically. The [submit handler](#the-submit-handler) section below walks through the gating contract that produces that behavior.

::docs-demo{slug="inputs-to-submit" label="Submit Demo"}
::

## Setting up the form

This page focuses on two helpers from the form: `handleSubmit` (the submit-wrapping factory) and `meta` (the form's reactive status board). Hoist the schema and destructure both straight out of `useForm`:

```ts
import { useForm } from 'attaform/zod'
import { z } from 'zod'

const schema = z.object({
  email: z.email(),
  newsletter: z.boolean(),
})

const { handleSubmit, meta } = useForm({ schema })
```

The destructured form still carries every helper from earlier pages (`register`, `fields`, `values`). Only `handleSubmit` and `meta` are new here.

## The submit handler

`handleSubmit(onSuccess, onError?)` returns a function you bind to `<form @submit>`. The wrapper calls `preventDefault` internally, so the `.prevent` modifier on the template is unnecessary. When the wrapped handler fires, it:

- Runs sync and async validation on every active path.
- Waits for pending async refinements before dispatching.
- Calls `onSuccess(values)` only if validation passes. `values` is the parsed Zod output, fully typed.
- Calls `onError(errors)` if validation fails. By default, focus moves to the first invalid field.

```ts
const onSubmit = handleSubmit(
  async (values) => {
    await api.signup(values)
  },
  (errors) => {
    console.log('Validation failed', errors)
  }
)
```

```vue
<form @submit="onSubmit">…</form>
```

## meta.submitting

While `onSuccess` is running, `meta.submitting` is `true`. Use it to disable the submit button or surface a spinner:

```vue
<button :disabled="meta.submitting" type="submit">
  {{ meta.submitting ? 'Saving…' : 'Save' }}
</button>
```

`submitting` flips back to `false` when the callback resolves or rejects (`handleSubmit` catches the rejection and routes the failure to its error hook). The full `meta` surface (`submitCount`, `submitError`, `isSubmitted`, and the 22 inherited FieldState bits) lives on [the `meta` page](/docs/reading-the-form/meta).

## Where to next

- [`handleSubmit`](/docs/submitting/handle-submit): the full submit surface, including error handlers and event semantics.
- [The form object](/docs/reading-the-form/the-form-object): every method and property `useForm` returns.
