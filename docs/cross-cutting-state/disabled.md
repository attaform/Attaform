---
title: disabled
description: 'useForm({ disabled }) freezes a form so its data cannot be edited: a bypass-proof, data-layer freeze for read-only review screens and gated wizard steps, with every native input auto-disabled.'
metaRows:
  - label: Category
    value: Form option
  - label: Signature
    value: 'useForm({ disabled })'
    kind: code
  - label: Accepts
    value: 'boolean · ref · computed · getter'
    kind: code
  - label: Reads back
    value: 'form.meta.disabled · field.disabled'
    kind: code
---

# disabled

> `useForm({ disabled })` freezes a reactive form so its data cannot be edited, and nothing can write around the freeze. The guarantee lives at the data layer, so a stray binding, a programmatic write, and a host component all no-op at once. Read-only review screens and hard-prerequisite steps lean on it.

::docs-meta-table
::

Flip the toggle and every input freezes together. You never wrote `:disabled` on a single one of them: Attaform sets the native attribute on each control from that one option, and the greyed, not-allowed look is plain `input:disabled` CSS.

::docs-demo{slug="disabled-form" label="Disabled form"}
::

## One option, every write

`disabled` accepts a boolean, a ref, a computed, or a getter (`MaybeRefOrGetter<boolean>`), unwrapped live so a reactive source keeps tracking:

```ts
import { ref } from 'vue'
import { useForm } from 'attaform'
import { z } from 'zod'

const frozen = ref(false)

const profileSchema = z.object({
  fullName: z.string().min(1),
  email: z.email(),
})

const form = useForm({
  schema: profileSchema,
  disabled: frozen,
})
```

While `disabled` resolves truthy:

- **Every value write no-ops** at Attaform's single write chokepoint, so the programmatic, `v-register`, and host-model paths all fall inert together. The freeze is enforced in the data, not on the inputs, so a deep link or a rogue write cannot slip past it.
- **Native inputs render the HTML `disabled` attribute** on the server and the client, component hosts and native selects receive a `:disabled` bind, and every field's display state settles to idle, so no error, pending, or success signal shows on a frozen field.
- **`reset()` and `defaultValues` still hydrate.** A frozen form can be seeded or restored, which is exactly what a read-only review screen needs.

The resolved state reads back on `form.meta.disabled` and `field.disabled`, both read-only, so a template can style the frozen state without tracking the flag itself.

## Gating a wizard step

`useWizard({ locked })` drives this same freeze for a gated step: a locked step's form is frozen through `disabled`, so a hard prerequisite is un-fillable as well as unreachable. See [Hard prerequisites](/docs/multistep/patterns#hard-prerequisites).
