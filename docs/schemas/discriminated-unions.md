---
title: Discriminated unions
description: z.discriminatedUnion reshapes storage to the active variant's slim default. Inactive keys purge, new keys seed. The discriminator drives both runtime storage and conditional template rendering.
metaRows:
  - label: Category
    value: Schema feature
  - label: Schema
    value: z.discriminatedUnion('key', [variantA, variantB, …])
    kind: code
  - label: Reshape trigger
    value: writing the discriminator
  - label: Variant memory
    value: on by default (rememberVariants)
---

# Discriminated unions

> Schemas that branch on a discriminator key get first-class runtime handling: switching the discriminator reshapes storage to the new variant's slim default, and the error aggregates follow the live variant with it.

::docs-meta-table
::

Pick a notify channel (Email, SMS, or Push) and watch the field below the radios swap to the variant's typed shape. The schema's discriminated union drives both the conditional render and the underlying storage reshape; whatever the inactive variant held gets purged from `form.values`, and the new variant's slim default seeds.

::docs-demo{slug="discriminated-unions" label="Discriminated Union Demo"}
::

## The schema

```ts
import { useForm } from 'attaform'
import { z } from 'zod'

const schema = z.object({
  notify: z.discriminatedUnion('channel', [
    z.object({ channel: z.literal('email'), address: z.email() }),
    z.object({ channel: z.literal('sms'), phone: z.string() }),
    z.object({ channel: z.literal('push'), deviceId: z.string() }),
  ]),
})
const form = useForm({ schema })
```

Three variants, one discriminator (`channel`). Each variant is a regular `z.object`; refinements, defaults, transforms, nested objects all work the way they do anywhere else.

## What happens on a switch

```ts
form.setValue('notify.channel', 'email')
form.setValue('notify.address', 'a@b.com')
// storage: { notify: { channel: 'email', address: 'a@b.com' } }

form.setValue('notify.channel', 'sms')
// storage: { notify: { channel: 'sms', phone: '' } }
//   (email's `address` is purged; sms's `phone` is seeded)

form.setValue('notify.channel', 'email')
// storage: { notify: { channel: 'email', address: 'a@b.com' } }
//   (`address` restored from variant memory)
```

Writing the discriminator triggers a structural reshape:

1. The outgoing variant's keys are purged from storage.
2. The new variant's keys are seeded from the schema's slim defaults.
3. The structural-completeness invariant runs before any subsequent reads: missing variant keys get filled even if the write was the discriminator only.

The reshape fires for every variant write: `setValue('notify', { channel: 'sms', phone: '' })` reshapes the same way as `setValue('notify.channel', 'sms')`.

## Variant memory

Switching back to a previously-visited variant restores its prior typed subtree by default; `rememberVariants: true` is Attaform's default. The "memory" lives in-memory only (not persisted across reloads); each discriminated union at every nesting depth memorizes independently.

Opt out per-form:

```ts
useForm({ schema, rememberVariants: false })
```

With `false`, every switch drops the outgoing variant's typed state. See [Variant memory](/docs/writing-and-mutating/variant-memory) for the full discussion.

## Template rendering

Branch on the discriminator value with `v-if` / `v-else-if`:

```vue
<template>
  <label v-if="form.values.notify.channel === 'email'">
    <input v-register="form.register('notify.address')" />
    <em v-if="form.fields.notify.address.showErrors">
      {{ form.fields.notify.address.firstError?.message }}
    </em>
  </label>

  <label v-else-if="form.values.notify.channel === 'sms'">
    <input v-register="form.register('notify.phone')" type="tel" />
  </label>
</template>
```

Vue's template narrowing follows the discriminator: autocomplete on `form.values.notify.address` only suggests when the branch matches the literal type. The `form.fields.<variant-path>` access works regardless of the active variant, but `showErrors` only fires when the path is reachable (so an inactive variant's stale field state stays silent).

## Which error surface follows the variant

A reshape clears the outgoing variant's schema errors along with its values, so the aggregates track the live variant on their own. `form.meta.errors` and `form.errors()` carry only what the active variant produced, and a "show all" summary iterating either one needs no hand-filtering.

The per-leaf view is the surface that does not filter. `form.errors.notify.address` reports whatever the error stores hold at that path, and a reshape clears only the schema-derived ones. An error you set yourself with [`form.setErrors`](/docs/submitting/server-side-errors) outlives the switch and stays readable at its path, which is the right call: you parked it there deliberately, and a value-shaped reshape is no reason for Attaform to decide it no longer counts.

So the guard on an inline message is the discriminator, not the error's presence:

```vue
<template>
  <label v-if="form.values.notify.channel === 'email'">
    <input v-register="form.register('notify.address')" />
    <small v-if="form.errors.notify.address?.[0]">
      {{ form.errors.notify.address[0].message }}
    </small>
  </label>
</template>
```

Rendering the message inside the branch that renders its input is the whole fix, and it is what you want regardless: a message with no field beside it is not something a user can act on. For anything cross-cutting, read the aggregate, which has already dropped everything the live variant did not produce.

## Invalid discriminator values

If the user types a discriminator value that doesn't match any variant (`channel: 'fax'` against `'email' | 'sms' | 'push'`), the write still lands and the purge half of the reshape still runs. There is no variant to seed from, so storage holds the discriminator on its own:

```ts
form.setValue('notify.channel', 'fax')
// storage: { notify: { channel: 'fax' } }
//   (email's `address` purged; nothing seeded in its place)
```

Zod reports it at the discriminator's own path, coded `zod:invalid_union` with the expected values in the message. Writing a real variant value next puts the flow back together, and with `rememberVariants` on (the default) whatever the detour purged comes back with it. Template branches should test the discriminator against the literals you know rather than assume the runtime picked one, since during the detour none is active.

When the whole form is one of several shapes rather than a field nested inside one, reach for a [variant form](/docs/schemas/variant-forms): the `z.discriminatedUnion` becomes the schema root, `form.values` reads the active variant at the top level, and variant fields bind by their own key.

## Where to next

- [Variant forms](/docs/schemas/variant-forms): a `z.discriminatedUnion` schema as the form root, not just a field inside an object.
- [Variant memory](/docs/writing-and-mutating/variant-memory): when to keep the prior typed subtree, when to drop it.
- [`setValue` patterns](/docs/writing-and-mutating/set-value): programmatic writes that drive the same reshape.
- [`errors`](/docs/reading-the-form/errors): the per-leaf view, the aggregate, and where a `| undefined` is honest.
