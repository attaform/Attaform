---
title: injectWizard
description: Reach a useWizard handle from any descendant component. Ambient resolution for the parent's own wizard, keyed resolution for distant ones. Returns the same reactive wizard that useWizard exposes; mutations on one are observable on the other.
metaRows:
  - label: Category
    value: Composable
  - label: Signature
    value: 'injectWizard(input?: string | { key? }) => UseWizardReturnType | null'
    kind: code
  - label: Ambient mode
    value: useWizard({ steps })
    kind: code
  - label: Explicit mode
    value: useWizard({ steps, key })
    kind: code
---

# `injectWizard`

> Reach a registered wizard from any descendant component. Ambient resolution for the parent's own wizard, keyed resolution for distant ones, and a single `null` on miss instead of a thrown error so floating panels, sticky nav rails, and sidebar widgets stay robust to mount-order quirks.

::docs-meta-table
::

`useWizard` creates and provides the wizard handle; `injectWizard` looks it up. The two compose the way `useForm` and [`injectForm`](/docs/cross-cutting-state/inject-form) do, scaled up to the wizard handle so a progress rail, a floating finish button, or a deep-tree review summary can reach the wizard without prop-threading.

## The common case, ambient resolution

The parent owns the wizard (no `key`):

```vue
<!-- CheckoutWizard.vue -->
<script setup lang="ts">
  import { useForm, useWizard } from 'attaform/zod'
  import { z } from 'zod'

  const shippingSchema = z.object({ address: z.string(), city: z.string() })
  const paymentSchema = z.object({ cardNumber: z.string(), cvv: z.string() })

  const shipping = useForm({ schema: shippingSchema, key: 'shipping' })
  const payment = useForm({ schema: paymentSchema, key: 'payment' })

  const wizard = useWizard({
    steps: ['welcome', shipping, payment, 'final-review'],
  })
</script>

<template>
  <ProgressRail />
  <StepBody />
  <NavButtons />
</template>
```

Any descendant grabs the same wizard:

```vue
<!-- ProgressRail.vue -->
<script setup lang="ts">
  import { injectWizard } from 'attaform/zod'

  const wizard = injectWizard()
</script>

<template>
  <ol v-if="wizard">
    <li
      v-for="(step, i) in wizard.steps"
      :key="step.key"
      :class="{
        done: wizard.statuses[step.key]?.valid,
        current: wizard.currentStep === step.key,
      }"
    >
      <button type="button" @click="wizard.goTo(step.key)">Step {{ i + 1 }}</button>
    </li>
  </ol>
</template>
```

The rail reads `wizard.currentStep`, `wizard.statuses`, and `wizard.steps` exactly the way the parent does. Same reactive surface, same identity. Updates in the parent propagate to the child without a roundtrip.

## Reaching a wizard that isn't an ancestor

Sticky finish buttons, sidebar status widgets, or any component in a different branch of the tree look up the wizard by `key`:

```vue
<!-- CheckoutWizard.vue -->
<script setup lang="ts">
  const wizard = useWizard({
    steps: ['welcome', shipping, payment, 'final-review'],
    key: 'checkout-wizard',
  })
</script>
```

```vue
<!-- FloatingFinishButton.vue (anywhere in the app) -->
<script setup lang="ts">
  import { injectWizard } from 'attaform/zod'

  const wizard = injectWizard('checkout-wizard')

  const finish = wizard?.handleSubmit(async (ctx) => {
    await api.checkout(ctx.values)
  })
</script>

<template>
  <button v-if="wizard" :disabled="!wizard.complete" @click="finish">Finish</button>
</template>
```

Pass the same `key` the parent passed to `useWizard({ key: 'checkout-wizard' })`. The handle returned is identity-equal to the parent's, so `wizard.handleSubmit` wired from a floating button runs the same submission pipeline the parent's Finish button would.

`injectWizard` accepts an object form too: `injectWizard({ key: 'checkout-wizard' })`. The positional and object forms are equivalent; pick whichever spreads better into the surrounding setup.

## How a key resolves

`injectWizard('checkout-wizard')` resolves through the same registry that backs `injectForm`, with the same two properties. It is **position-independent** (the handle lives in Attaform's app-level registry, so any component reaches it regardless of branch or depth) and **time-dependent** (the entry appears once the wizard's own `useWizard({ key })` setup has run, and not before). The [How a key resolves](/docs/cross-cutting-state/inject-form#how-a-key-resolves) section on `injectForm` walks the shared mechanism and the resolve-downward rule in full.

One corollary is specific to wizards. The form steps you pass to `useWizard({ steps })` are `useForm` handles, so they follow the same ordering: they have to exist when the wizard's setup runs. A form created inside a step's own child component does not exist yet at that point, which is why the checkout example above creates `shipping` and `payment` in the same component as the `useWizard` call. Create the step forms alongside the wizard, or above it, and the wizard has them the moment it is built.

## Do I need to pass a `key` to `useWizard`?

The two resolution modes are cleanly split:

- **Anonymous (no `key`) reaches ambient.** `useWizard({ steps })` fills the parent's ambient slot. Any descendant's `injectWizard()` (no key) resolves to it; closest ancestor wins when nested.
- **Keyed (`key: 'x'`) reaches explicit access only.** `useWizard({ steps, key: 'x' })` registers the wizard under `'x'` but does NOT fill the ambient slot. Descendants reach it via `injectWizard('x')`, not via the no-key form.

Skip `key` for single-component wizards (an in-page checkout, a modal flow). Supply one when you want cross-tree lookup, a stable identifier for DevTools, or a sticky finish button rendered far from the step container.

### Gotcha: multiple anonymous `useWizard` in one component

Vue's `provide` / `inject` is last-write-wins per component. If a parent calls `useWizard` twice without keys, the second overwrites the first in the ambient slot, and descendants using `injectWizard()` only see the second.

```ts
// Parent component
const checkout = useWizard({ steps: [shipping, payment] }) // ambient → checkout
const cancel = useWizard({ steps: [reasons, confirm] }) // ambient → cancel (overwrites checkout)
// Descendants' injectWizard() reads cancel. checkout is unreachable via ambient.
```

Attaform emits a dev-mode `console.warn` lazily, when (and only when) a descendant actually consumes the ambient slot via `injectWizard()` with no key. The warning lists each anonymous `useWizard()` call by source frame so you can navigate to the offending sites.

**Fix:** give each wizard a key (which removes them from the ambient slot entirely) and look them up explicitly:

```ts
useWizard({ steps: [shipping, payment], key: 'checkout' })
useWizard({ steps: [reasons, confirm], key: 'cancel' })
// Descendants:
const checkout = injectWizard('checkout')
const cancel = injectWizard('cancel')
```

Mixing modes is fine. Keyed wizards don't interfere with an ambient sibling. A parent with three keyed wizards plus one anonymous wizard produces no warning; the descendant's `injectWizard()` unambiguously resolves to the (only) anonymous one.

## When resolution fails

`injectWizard` returns `null` rather than throwing, so descendants are robust to mount-order quirks (a sidebar widget that renders before the wizard's parent setup runs, a conditional wizard ancestor, dynamic imports). Two cases produce `null`:

- **No ambient wizard.** `injectWizard()` called from a tree with no ancestor `useWizard` and no key. Returns `null` silently. Ambient lookup is opportunistic, so a floating widget reading the ambient slot stays quiet in trees that don't have a wizard rather than spamming consumers' consoles.
- **Key not registered.** `injectWizard('checkout-wizard')` called when nothing is registered under that key. Dev mode logs the unresolved key alongside any keys that ARE registered, so a typo surfaces at a glance. If the wizard is created lower in the tree, it registers after this call runs; see [How a key resolves](#how-a-key-resolves).

Guard the return so the consumer disappears cleanly when the wizard isn't mounted:

```vue
<script setup lang="ts">
  import { injectWizard } from 'attaform/zod'

  const wizard = injectWizard('checkout-wizard')
</script>

<template>
  <aside v-if="wizard" class="wizard-status">
    Step {{ wizard.activeIndex + 1 }} of {{ wizard.count }}
  </aside>
</template>
```

## Lifetime

Both resolution modes ref-count the wizard handle in the registry. In practice:

- The wizard survives until every component that reached it unmounts.
- Cleanup is automatic; no explicit dispose call from the consumer.
- A wizard accessed only by `injectWizard(key)` stays alive as long as at least one consumer is mounted, even if the parent `useWizard` owner unmounted first.

Hot-module reload reuses the existing handle when the parent SFC re-mounts (deferred-eviction-cancel within the same microtask). Child `injectWizard` consumers see the same wizard reactive surface they had before, not a freshly created one, so a rail's pre-filled state survives every save.

## Duplicate keys

Two calls to `useWizard({ steps, key: 'checkout-wizard' })` in the same app: the first wizard stays in the registry under that key, the second call dev-warns and the registry entry is left untouched. Any `injectWizard('checkout-wizard')` resolves to the original. The dev-warn names the colliding key so the accidental duplicate setup surfaces at a glance.

## SSR isolation

The wizard registry lives on the per-request `AttaformRegistry` instance created by `createAttaform()`. A wizard registered in one server request does not leak into a sibling request rendering at the same time. The same isolation applies to forms registered through [`injectForm`](/docs/cross-cutting-state/inject-form).

## Where to next

- [`useWizard`](/docs/multistep/use-wizard) for the construction signature and the wizard's full reactive surface.
- [Statuses](/docs/multistep/statuses) for the per-step rollup that drives a progress rail's classes.
- [Step slots](/docs/multistep/step-slots) for the slot kinds that fill the `steps` list.
- [`injectForm`](/docs/cross-cutting-state/inject-form) for single-form sharing across a tree.
