---
title: Type safety
description: Types follow the form through every state. In-flight reads are wide enough to hold whatever the user is actually typing; handleSubmit hands you the schema's validated output with literals narrowed, refinements honored, and discriminated unions discriminating.
metaRows:
  - label: Category
    value: Concept
  - label: In-flight
    value: form.values, defaultValues, setValue
    kind: code
  - label: Validated
    value: handleSubmit((values) => ...)
    kind: code
  - label: Boundary
    value: Schema parse
---

# Type safety

> Wide while the user is typing, tight the moment the schema validates. Two surfaces, one promise: what you see is what is actually there.

::docs-meta-table
::

A form library has to tell the truth about what is in the form. Mid-typing, that is whatever the user has put there so far: an incomplete email, an undecided radio pick, a partially-filled subtree rehydrated from yesterday's session. Post-submit, it is the Zod schema's parsed output: every refinement honored, every literal narrowed, every transform applied.

Attaform's types model both states. `form.values`, `defaultValues`, and `form.setValue` use the **in-flight shape**, wide enough to hold whatever the form is actually carrying. `handleSubmit((values) => ...)` hands you the **validated shape**: narrow, exact, what the schema promised.

::docs-demo{slug="type-safety" label="In-flight vs. validated types"}
::

## The gateway example: email

Take the simplest schema:

```ts
const schema = z.object({
  email: z.email('Enter a valid email'),
})
const form = useForm({ schema })
```

What is the type of `form.values.email`? `string`. Not a branded `Email`, not `string & { __brand: 'email' }`. Plain `string`. The reason is that during form completion, `form.values.email` legitimately holds `"a"`, then `"andy"`, then `"andy@"`. None of those satisfy `z.email()`, and the schema knows that. That is why `form.errors.email` populates while the user is mid-typing.

If `form.values.email` were typed as a branded `Email`, the type would lie about what is actually there. The runtime value would be `"andy@"`; the static type would claim it is a valid email. The compiler cannot help you when it has been told a fiction.

So the type follows reality: while the user is typing, `email` is whatever string they have typed. After the schema parses successfully inside `handleSubmit`, it is whatever the schema promises.

## Discriminators do the same thing

```ts
const schema = z.object({
  transport: z.discriminatedUnion('kind', [
    z.object({ kind: z.literal('boat'), hullLengthM: z.number() }),
    z.object({ kind: z.literal('truck'), payloadKg: z.number() }),
  ]),
})
const form = useForm({ schema })

form.values.transport.kind // string (not 'boat' | 'truck')
```

Same reasoning, one layer up. The user may not have picked a variant yet. They may be mid-keystroke in an input wired to the discriminator. They may be rehydrating a draft that was saved with `kind: ''`. Typing `transport.kind` as `'boat' | 'truck'` would lie about every one of those cases.

The literal narrowing engages where it earns its keep: inside `handleSubmit`, after the schema confirms the discriminator is one of the variants. There, `values.transport.kind` is `'boat' | 'truck'`, and TypeScript narrows `values.transport` to the matching variant.

## `defaultValues` works the same way

```ts
const form = useForm({
  schema,
  defaultValues: {
    email: '', // empty string is fine, even though z.email() will reject it
    transport: { kind: 'boat', hullLengthM: 0 }, // any starting state, even invalid
  },
})
```

Rehydration is the killer use case. Yesterday's user opened the form, picked a variant, typed half an email, then closed the tab. Today's `defaultValues` (re-read from `localStorage`, `sessionStorage`, or your server) needs to faithfully restore that half-filled state. If `defaultValues.email` required a value that already passed `z.email()`, you could not rehydrate the "still typing" case at all. You would be forced to invent a valid email the user never typed, or wipe the field entirely and lose their work.

Wide in-flight types mean you can store, hydrate, autosave, and resume from any intermediate state. The schema is still in charge of what counts as valid; the types just acknowledge that the form's job is to **get there**, not to always be there.

## Where the types tighten

`handleSubmit` is the boundary:

```ts
const onSubmit = form.handleSubmit((values) => {
  values.email // string (validated, passed z.email())
  values.transport.kind // 'boat' | 'truck'

  if (values.transport.kind === 'boat') {
    values.transport.hullLengthM // narrowed to number
  } else {
    values.transport.payloadKg // narrowed to number
  }
})
```

The argument to your success callback is `z.infer<typeof schema>`, Zod's parsed output. Every literal is preserved, every refinement is honored, every transform is applied. If the schema did not parse cleanly, the success callback never fires; the error callback runs instead with the un-validated values for you to inspect.

That is the contract: while you are building the form, the types help you handle every shape it might be in. The moment validation succeeds, the types snap to what the schema actually guarantees.

## Why not narrow earlier?

A library that narrowed `form.values.email` to a branded `Email` (or `form.values.transport.kind` to `'boat' | 'truck'`) before validation would have to do one of two things, both bad:

- **Refuse to type partial state.** Empty strings, half-typed emails, undecided discriminators are all invalid against the schema. Either `form.values` could not represent them (the form cannot work) or the types would lie (the compiler cannot help).
- **Force consumers to cast.** Every read becomes `as string`, every assignment becomes a fight with the type checker. The schema's value as a source of truth evaporates because you are routing around it on every line.

Wide in-flight types skip both failure modes. The schema still owns what counts as valid; the form just acknowledges that getting to valid is the user's job, not the type system's.

## Where to next

- [`values`](/docs/reading-the-form/values): the in-flight read surface this page is built on.
- [`handleSubmit`](/docs/submitting/handle-submit): the boundary where types tighten.
- [Discriminated unions](/docs/schemas/discriminated-unions): the schema feature that benefits most from the tight side of this contract.
