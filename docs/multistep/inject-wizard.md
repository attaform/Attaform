---
title: injectWizard
description: Reach a useWizard handle from any descendant component. Ambient resolution for the nearest ancestor wizard, keyed resolution for distant ones. Returns the same reactive handle that useWizard exposes; mutations on one are observable on the other.
metaRows:
  - label: Category
    value: Composable
  - label: Signature
    value: 'injectWizard(input?: string | { key? }) => UseWizardReturnType | null'
    kind: code
  - label: Ambient mode
    value: useWizard(entry) without key
    kind: code
  - label: Explicit mode
    value: useWizard(entry, { key })
    kind: code
---

# `injectWizard`

> Reach a registered wizard from any descendant component. Ambient resolution for the parent's own wizard, keyed resolution for distant ones, and a single `null` on miss instead of a thrown error so floating panels and sidebar widgets stay robust to mount-order quirks.

::docs-meta-table
::

`useWizard` creates and provides the wizard handle; `injectWizard` looks it up. The two compose the way `useForm` and [`injectForm`](/docs/cross-cutting-state/inject-form) do, scaled up to the wizard handle so a sticky progress indicator, a floating finish button, or a deep-tree review summary can reach the wizard without prop-threading.

## The common case, ambient resolution

Parent owns the wizard (no `key`):

```vue
<!-- SignupWizard.vue -->
<script setup lang="ts">
  import { useForm, useWizard } from 'attaform/zod'

  const review = useForm({ schema: reviewSchema, key: 'signup-review' })
  const profile = useForm({ schema: profileSchema, key: 'signup-profile', next: review })
  const account = useForm({ schema: accountSchema, key: 'signup-account', next: profile })

  const wizard = useWizard(account)
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
      v-for="(form, i) in wizard.allForms"
      :key="form.key"
      :class="{ done: wizard.statuses[form.key]?.valid, current: wizard.current === form.key }"
    >
      <button type="button" @click="wizard.goTo(form.key)">Step {{ i + 1 }}</button>
    </li>
  </ol>
</template>
```

The rail reads `wizard.current`, `wizard.statuses`, and `wizard.allForms` exactly the way the parent does. Same reactive surface, same identity. Edits in the parent propagate to the child without a roundtrip.

## Reaching a wizard that isn't an ancestor

Sticky finish buttons, sidebar status widgets, or any component in a different branch of the tree look up the wizard by `key`:

```vue
<!-- SignupWizard.vue -->
<script setup lang="ts">
  const wizard = useWizard(account, { key: 'signup-wizard' })
</script>
```

```vue
<!-- FloatingFinishButton.vue (anywhere in the app) -->
<script setup lang="ts">
  import { injectWizard } from 'attaform/zod'

  const wizard = injectWizard('signup-wizard')

  const finish = wizard?.handleSubmit(async (ctx) => {
    await api.signup(ctx.values)
  })
</script>

<template>
  <button v-if="wizard" :disabled="!wizard.canAdvance" @click="finish">Finish signup</button>
</template>
```

Pass the same `key` the parent passed to `useWizard(entry, { key: 'signup-wizard' })`. The handle returned is identity-equal to the parent's, so `wizard.handleSubmit` wired from a floating button runs the same submission pipeline the parent would.

`injectWizard` accepts an object form too: `injectWizard({ key: 'signup-wizard' })`. The positional and object forms are equivalent; pick whichever spreads better into the surrounding setup.

## Do I need to pass a `key` to `useWizard`?

The two resolution modes are cleanly split:

- **Anonymous (no `key`) → ambient access.** `useWizard(entry)` fills the parent's ambient slot. Any descendant's `injectWizard()` (no key) resolves to it; closest ancestor wins when nested.
- **Keyed (`key: 'x'`) → ambient AND explicit access.** `useWizard(entry, { key: 'x' })` fills the ambient slot AND registers the wizard under `'x'`. Descendants reach it via `injectWizard()` (closest ancestor) OR `injectWizard('x')` (registry lookup, works from anywhere in the app).

Skip `key` for single-component wizards (an in-page checkout, a modal flow). Supply one when you want cross-tree lookup, a stable identifier for DevTools, or a sticky finish button rendered far from the step container.

## When resolution fails

`injectWizard` returns `null` rather than throwing, so descendants are robust to mount-order quirks (a sidebar widget that renders before the wizard's parent setup runs, a conditional wizard ancestor, dynamic imports). Two cases produce `null`:

- **No ambient wizard.** `injectWizard()` called from a tree with no ancestor `useWizard` and no key. Dev mode logs a one-shot `console.warn` naming the missing ambient context.
- **Key not registered.** `injectWizard('signup-wizard')` called when nothing is registered under that key. Dev mode logs the unresolved key alongside any keys that ARE registered, so a typo surfaces at a glance.

For the common case where the wizard is guaranteed to exist (it's set up in the same SFC tree), assert non-null at the call site:

```ts
const wizard = injectWizard('signup-wizard')!
```

For optional consumers (a floating panel that should hide when the wizard isn't mounted), guard the return:

```vue
<script setup lang="ts">
  const wizard = injectWizard('signup-wizard')
</script>

<template>
  <aside v-if="wizard" class="wizard-status"
    >Step {{ wizard.activeIndex + 1 }} of {{ wizard.count }}</aside
  >
</template>
```

## Lifetime

Both resolution modes ref-count the wizard handle in the registry. In practice:

- The wizard survives until every component that reached it unmounts.
- Cleanup is automatic; no explicit dispose call from the consumer.
- A wizard accessed only by `injectWizard(key)` stays alive as long as at least one consumer is mounted, even if the original `useWizard` owner unmounted first.

Hot-module reload reuses the existing handle when the parent SFC re-mounts (deferred-eviction-cancel within the same microtask). Child `injectWizard` consumers see the same wizard reactive surface they had before, not a freshly created one. Useful for stepping through the live demo on `localhost:3000` without losing the rail's pre-filled state every save.

## Duplicate keys

Two calls to `useWizard(entry, { key: 'signup-wizard' })` in the same app: the first wins, the second is silently dropped, and a dev-warn names the dropped registration. This mirrors `useForm`'s shared-key behavior and keeps the registry deterministic during HMR transitions or accidental double-setup.

## SSR isolation

The wizard registry lives on the per-request `AttaformRegistry` instance created by `createAttaform()`. A wizard registered in one server request does not leak into a sibling request rendering at the same time. The same isolation applies to forms registered through [`injectForm`](/docs/cross-cutting-state/inject-form).

## Where to next

- [`useWizard`](/docs/multistep/use-wizard) for the construction signature and the wizard's full reactive surface.
- [`injectForm`](/docs/cross-cutting-state/inject-form) for single-form sharing across a tree.
- [SSR & render efficiency](/docs/multistep/ssr) for the per-request registry contract and the activation rule.
