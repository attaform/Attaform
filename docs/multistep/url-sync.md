---
title: URL sync
description: Wizards round-trip the active step through the URL. ?step=<key> writes on navigation, reloads land on the same step, deep links SSR-render. Opt out with restore/persist false or custom callbacks.
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

The default write picks its history mode per navigation. A genuine step change calls `history.pushState`, so the step earns a real entry and the browser's Back and Forward buttons walk the flow one step at a time. Writing the step the URL is already effectively on calls `replaceState` instead, canonicalizing in place: a bare `/checkout` resolves to the first step, so stamping `?step=<first>` onto it at construction is bookkeeping rather than a navigation. That split is what keeps Back off a dead entry showing the step the user is already looking at, and it keeps the Forward stack alive across a Back round trip.

Every navigation records an entry, including the wizard's own `back()`. Clicking the wizard's Back button pushes the earlier step onto the stack rather than popping the later one, so a browser Back press after it returns the user to the step they just left. If that is not the shape you want, own the write with a custom `persist`, as in [Replacing instead of pushing](#replacing-instead-of-pushing) below.

## SSR hand-off

Under SSR (Nuxt or any framework wired through `createAttaform()`), the default restore reads the incoming request's `?step` from a server-side resolver provided by the integration, so the first byte rendered on the server matches what the URL asked for. The wizard exposes nothing extra here: with default `restore` and the Nuxt module installed, deep links render the right step on the first paint with no consumer wiring.

A bare-Vue SPA without the Nuxt integration still gets the client-side default: `window.location` is read on construction once the page hydrates, and the wizard navigates to the matching step before the user sees the first render.

## Disabling URL sync

Pass `false` to either side to opt out of the default. The two switches are independent:

```ts
const wizard = useWizard({
  steps: [shipping, payment, review],
  restore: false, // don't read the URL at construction
  persist: false, // don't write the URL on navigation
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

Those tracked reads are the whole story for a custom `restore`, and the easy thing to get wrong. A callback that reads `window.location` (or `localStorage`) directly tracks nothing, so it runs once at construction and never again: the wizard will not follow the browser's Back button, because nothing told it the URL moved. Read a `ref` you keep in sync instead, and the watcher re-fires the moment that ref changes. The default `restore` is built exactly this way, which is why Back and Forward work out of the box.

Nothing is lost by restoring only at construction, as long as that is what you meant. The localStorage example above is a fair use of it: there is no back button for a storage key, so a one-shot read on mount is the whole job.

## Renaming the param

The default `?step=<key>` works fine until two wizards land on the same page. Then the second wizard's writes overwrite the first's. Give each wizard its own param via custom callbacks, and build the pair once so both wizards get the same behavior the default has:

```ts
import { onScopeDispose, ref } from 'vue'
import { useWizard } from 'attaform'

function stepParam(param: string) {
  const read = (): string | undefined =>
    typeof window === 'undefined'
      ? undefined
      : (new URL(window.location.href).searchParams.get(param) ?? undefined)

  // The reactive source `restore` tracks. Kept in sync with the URL so
  // Back and Forward reach the wizard.
  const mirror = ref(read())

  if (typeof window !== 'undefined') {
    const onPopstate = (): void => {
      mirror.value = read()
    }
    window.addEventListener('popstate', onPopstate)
    onScopeDispose(() => window.removeEventListener('popstate', onPopstate))
  }

  return {
    restore: () => (mirror.value === undefined ? undefined : { step: mirror.value }),
    persist: ({ step }: { step?: string }): void => {
      if (step === undefined || typeof window === 'undefined') return
      const url = new URL(window.location.href)
      url.searchParams.set(param, step)
      // Same split as the default: canonicalize in place, push a move.
      if (read() === step) history.replaceState(history.state, '', url.toString())
      else history.pushState(history.state, '', url.toString())
      mirror.value = step
    },
  }
}

const checkout = useWizard({ steps: [shipping, payment, review], ...stepParam('checkout-step') })
const support = useWizard({ steps: [topic, details], ...stepParam('support-step') })
```

Each wizard owns its own search param, so the two never collide, and each keeps its own history entries.

The `typeof window` guards keep the helper from crashing on the server, but they do not make it server-aware: a custom `restore` replaces the integration's server-side resolver, so a deep link renders step one on the first byte and corrects on hydration. Under vue-router (Nuxt included), skip the helper and read the route instead. `useRoute().query` is already reactive and already resolved on the server, so a `restore` that pulls the step off it keeps both the first byte and the Back button, while `router.push` in `persist` owns the history entry. Narrow the value on the way out: a query param can repeat, so `route.query[name]` is not a `string` until you say it is.

## Replacing instead of pushing

Walking the steps with Back is the right default for a page-level flow, and the wrong one for a wizard inside a modal, where the user expects Back to close the surrounding page in a single press. Swap in a custom `persist` that always replaces, so the URL still reflects the step but the history stack never grows:

```ts
const wizard = useWizard({
  steps: [shipping, payment, review],
  persist: ({ step }) => {
    if (step === undefined) return
    const url = new URL(window.location.href)
    url.searchParams.set('step', step)
    history.replaceState(history.state, '', url.toString())
  },
})
```

The default `restore` still reads the URL at construction and still listens for `popstate`, so a reload or a shared link lands on the right step. Only the stack behavior changes: there is one entry for the whole wizard, and Back leaves the page.

## Where to next

- [`useWizard`](/docs/multistep/use-wizard) for the construction signature and the wizard handle.
- [Resumable wizards](/docs/multistep/resumable-wizards) for the full session round-trip: the active step plus each form's values and gate clearance.
- [Patterns](/docs/multistep/patterns) for the shapes this sits inside: per-step keys, per-step undo, and restoring the active step on a reload.
- [`injectWizard`](/docs/multistep/inject-wizard) for cross-component access to a wizard with a named `key` (a separate identifier from `?step=`).
