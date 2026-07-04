---
title: URL sync
description: Wizards round-trip the active step through the URL by default. ?step=<key> writes on every navigation, reloads land on the same step, and deep links render the right step on the first byte under SSR. Opt out with restore false / persist false, or swap in custom callbacks for non-URL storage.
metaRows:
  - label: Category
    value: 'Restore / persist'
  - label: Default param
    value: '?step=<key>'
    kind: code
  - label: Opt out
    value: 'restore: false · persist: false'
    kind: code
  - label: Custom
    value: 'restore() => { step? } · persist({ step }) => void'
    kind: code
---

# URL sync

> A wizard with no extra options reads its starting step from `?step=<key>` on the URL and writes the active step back as the user navigates. Reloads land on the same step, deep links render the right step on the first byte under SSR, and the URL stays shareable. To rename the param, scope it across wizards on the same page, or wire the state to non-URL storage, pass `restore` and `persist` callbacks.

::docs-meta-table
::

## The default behavior

`useWizard` does URL sync out of the box. Construct a wizard with nothing but `steps`, and the wizard reads `?step=<key>` from the URL at construction and mirrors `currentStep` back to it on every navigation:

```ts
import { useForm, useWizard } from 'attaform'

const wizard = useWizard({
  steps: ['welcome', shipping, payment, 'final-review'],
})
```

- Landing on `/checkout?step=payment` boots the wizard with `currentStep === 'payment'`.
- `wizard.next()` and `wizard.goTo('shipping')` update the URL as the active step changes.
- Reloading the page lands on the same step.
- The URL is shareable: paste `/checkout?step=payment` into another tab and that tab opens on the payment step.

The default write uses `history.replaceState`, so a single back-button press leaves the wizard's host page rather than walking backward through every step the user visited. If you want push semantics (back button retreats one step), see [Pushing each navigation](#pushing-each-navigation) below.

## SSR hand-off

Under SSR (Nuxt or any framework wired through `createAttaform()`), the default restore reads the incoming request's `?step` from a server-side resolver provided by the integration, so the first byte rendered on the server matches what the URL asked for. The wizard exposes nothing extra here: with default `restore` and the Nuxt module installed, deep links render the right step on the first paint with no consumer wiring.

A bare-Vue SPA without the Nuxt integration still gets the client-side default: `window.location` is read on construction once the page hydrates, and the wizard navigates to the matching step before the user sees the first render.

## Disabling URL sync

Pass `false` to either side to opt out of the default. The two switches are independent:

```ts
const wizard = useWizard({
  steps: [...],
  restore: false,  // don't read the URL at construction
  persist: false,  // don't write the URL on navigation
})
```

- `restore: false`. The wizard ignores the URL at construction and boots on `steps[0]`. Useful when the consumer drives initial step from a custom source (a Pinia store, a feature flag, a server-rendered prop) and doesn't want a stray `?step=` in the URL to override it.
- `persist: false`. Navigation never writes to the URL. The wizard's active step stays in memory only. Useful for embedded wizards inside a modal, a popover, or any context where the URL belongs to the surrounding page.
- Both `false`. The wizard is fully URL-blind: starts on `steps[0]`, leaves the URL untouched, never reads from it.

## Custom callbacks

The `restore` and `persist` options take callbacks for non-URL storage:

```ts
type WizardRestoreState = { readonly step?: string }
type WizardRestoreFn = () => WizardRestoreState | undefined
type WizardPersistFn = (state: WizardRestoreState) => void
```

A localStorage example:

```ts
const STORAGE_KEY = 'checkout:active-step'

const wizard = useWizard({
  steps: [shipping, payment, review],
  restore: () => {
    const step = localStorage.getItem(STORAGE_KEY)
    return step === null ? undefined : { step }
  },
  persist: ({ step }) => {
    if (step === undefined) return
    localStorage.setItem(STORAGE_KEY, step)
  },
})
```

The restore callback is invoked at construction and re-evaluated reactively (its tracked reads decide the dep set); the persist callback fires on every `currentStep` change, diffed to break the restore-persist loop. The wizard handles the loop break, so a persist write that triggers a restore re-read converges in one round.

## Renaming the param

The default `?step=<key>` works fine until two wizards land on the same page. Then the second wizard's writes overwrite the first's. Give each wizard its own param via custom callbacks:

```ts
import { useForm, useWizard } from 'attaform'

const checkout = useWizard({
  steps: [shipping, payment, review],
  restore: () => {
    const url = new URL(window.location.href)
    const step = url.searchParams.get('checkout-step')
    return step === null ? undefined : { step }
  },
  persist: ({ step }) => {
    const url = new URL(window.location.href)
    if (step === undefined) {
      url.searchParams.delete('checkout-step')
    } else {
      url.searchParams.set('checkout-step', step)
    }
    history.replaceState(history.state, '', url.toString())
  },
})

const support = useWizard({
  steps: [...],
  restore: () => {
    const url = new URL(window.location.href)
    const step = url.searchParams.get('support-step')
    return step === null ? undefined : { step }
  },
  persist: ({ step }) => {
    const url = new URL(window.location.href)
    if (step === undefined) {
      url.searchParams.delete('support-step')
    } else {
      url.searchParams.set('support-step', step)
    }
    history.replaceState(history.state, '', url.toString())
  },
})
```

Each wizard owns its own search param; the two never collide.

## Pushing each navigation

The default `persist` uses `replaceState` so the browser's back button leaves the host page in one press. To get push semantics (back walks the visited steps), swap in a custom persist that calls `pushState`:

```ts
const wizard = useWizard({
  steps: [shipping, payment, review],
  persist: ({ step }) => {
    const url = new URL(window.location.href)
    if (step === undefined) {
      url.searchParams.delete('step')
    } else {
      url.searchParams.set('step', step)
    }
    history.pushState(history.state, '', url.toString())
  },
})
```

The matching restore (the default one) already listens to `popstate` and re-reads the URL, so the back button retreats one step at a time once persist pushes.

## Where to next

- [`useWizard`](/docs/multistep/use-wizard) for the construction signature and the wizard handle.
- [Patterns](/docs/multistep/patterns) for the per-form `persist` option that keeps each step's field values across reloads.
- [`injectWizard`](/docs/multistep/inject-wizard) for cross-component access to a wizard with a named `key` (a separate identifier from `?step=`).
