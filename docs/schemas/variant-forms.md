---
title: Variant forms
description: A z.discriminatedUnion schema can be the form root, not just a field. form.values reads the active variant at the top level, register binds variant fields by their own key, and a bare root defaults to the first variant.
metaRows:
  - label: Category
    value: Schema feature
  - label: Form root
    value: z.discriminatedUnion('key', [variantA, variantB, …])
    kind: code
  - label: Reshape trigger
    value: writing the discriminator
  - label: Default
    value: first variant
---

# Variant forms

> When the form _is_ one of several shapes, make the union the root. A `z.discriminatedUnion` schema at the top level gives you a variant form: `form.values` reads the active variant, and writing the discriminator reshapes the whole form.

::docs-meta-table
::

The demo is a checkout payment method. A payment is exactly one of card, bank transfer, or invoice, each with its own fields, so the schema root is a `z.discriminatedUnion('method', …)`. Switch the method and the form reshapes to that variant; the readout below tracks the change.

::docs-demo{slug="variant-forms" label="Variant Form Demo"}
::

## The schema

A variant form declares a `z.discriminatedUnion` schema as the root, not nested under a key. One discriminator (`method`) picks the variant; each variant is a regular Zod schema:

```ts
import { useForm } from 'attaform'
import { z } from 'zod'

const schema = z.discriminatedUnion('method', [
  z.object({ method: z.literal('card'), cardNumber: z.string(), cvc: z.string() }),
  z.object({ method: z.literal('bank'), iban: z.string() }),
  z.object({ method: z.literal('invoice'), poNumber: z.string(), netDays: z.number() }),
])

const form = useForm({ schema })
```

There is no wrapper key. The discriminator and every variant's fields sit at the top level of the form.

## Reading the active variant

Because the union is the root, `form.values` reads the variant directly. Every variant's keys are reachable at the top level, so a field read works without narrowing first:

```ts
form.values.method // the discriminator: string while editing
form.values.cardNumber // string | undefined (present on the card variant)
form.values.iban // string | undefined (present on the bank variant)
```

A per-variant field reads as `T | undefined` because it is present only while its variant is active, matching the runtime, where reading a key from another variant returns `undefined`. The discriminator reads as `string` while editing, since the user may be mid-switch. Inside [`handleSubmit`](/docs/submitting/handle-submit) the parsed value is the true narrowed union, so you branch on it with full type narrowing:

```ts
const onSubmit = form.handleSubmit((payment) => {
  if (payment.method === 'card') {
    payment.cardNumber // string, narrowed to the card variant
  }
})
```

## Binding the discriminator and variant fields

The discriminator is an ordinary field: bind it to a `<select>` or a set of radios, and each variant's fields bind by their own key, no wrapper prefix. Branch the template on `form.values.method`:

```vue
<template>
  <label>
    Payment method
    <select v-register="form.register('method')">
      <option value="card">Card</option>
      <option value="bank">Bank transfer</option>
      <option value="invoice">Invoice</option>
    </select>
  </label>

  <template v-if="form.values.method === 'card'">
    <input v-register="form.register('cardNumber')" />
    <em v-if="form.fields.cardNumber?.showErrors">{{
      form.fields.cardNumber?.firstError?.message
    }}</em>
  </template>

  <template v-else-if="form.values.method === 'bank'">
    <input v-register="form.register('iban')" />
  </template>
</template>
```

A variant field's node is absent while its variant is inactive, so reach it through `?.`: `form.fields.cardNumber?.showErrors`. The same chaining applies to [`form.errors`](/docs/reading-the-form/errors), which is variant-filtered, so an inactive variant's errors stay silent.

## Switching variants reshapes the form

Writing the discriminator reshapes storage to the new variant: the outgoing variant's keys are purged, and the new variant's keys seed from the schema's slim defaults. At the root, the reshape is the whole form:

```ts
form.setValue('method', 'bank')
// form.values() : { method: 'bank', iban: '' }
//   (card's cardNumber / cvc purged; bank's iban seeded)
```

This is the same engine that drives a nested discriminated union, run at the root path. Variant memory (restoring a variant's values when you switch back to it) is on by default. The full reshape and memory semantics live on [Discriminated unions](/docs/schemas/discriminated-unions), which covers the same feature as a field inside an object form.

## Defaults

A bare variant root defaults to the first variant, with its fields at their slim defaults:

```ts
const form = useForm({ schema })
form.values() // { method: 'card', cardNumber: '', cvc: '' }
```

Start on a different variant, or seed its fields, with `defaultValues`. Pass one complete variant:

```ts
const form = useForm({
  schema,
  defaultValues: { method: 'invoice', poNumber: 'PO-1', netDays: 30 },
})
```

## When the shape is fixed, reach for an object

Variant forms are for a value that is genuinely one of several shapes. When every field is always present, a `z.object` root is the better fit. The two compose freely: an object form can hold a discriminated-union field (see [Discriminated unions](/docs/schemas/discriminated-unions)), and a variant's schema can be any Zod schema, including nested objects, arrays, and records.

## Where to next

- [Discriminated unions](/docs/schemas/discriminated-unions): the same feature as a field inside an object form, with the full reshape and error-filtering detail.
- [Variant memory](/docs/writing-and-mutating/variant-memory): when to keep a variant's values on switch-back, when to drop them.
- [Dictionary forms](/docs/schemas/dictionary-forms): the other non-object root, a `z.record` map.
- [`handleSubmit`](/docs/submitting/handle-submit): where the parsed value narrows to the active variant.
