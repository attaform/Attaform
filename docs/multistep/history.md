---
title: Browser history
description: Wizards round-trip their active step through the URL — back, forward, refresh, and shareable links all work without extra wiring. Disable per wizard, rename the search param, or swap push for replace per navigation.
metaRows:
  - label: Default
    value: '?step=<key>'
    kind: code
  - label: Option
    value: 'history: false | { param }'
    kind: code
  - label: Per-call
    value: '{ replace: true }'
    kind: code
---

# Browser history

> `useWizard` records each step navigation in `window.history` so the back / forward buttons walk steps, a reload returns to the same step, and the URL is shareable. The integration is on by default and silently no-ops outside a browser, so SSR and tests are unaffected.

::docs-meta-table
::

## The default

```ts
import { useForm, useWizard } from 'attaform/zod'

const accountSchema = z.object({ email: z.email() })
const profileSchema = z.object({ name: z.string().min(1) })
const reviewSchema = z.object({ tos: z.literal(true) })

const account = useForm({ schema: accountSchema, key: 'signup-account' })
const profile = useForm({ schema: profileSchema, key: 'signup-profile' })
const review = useForm({ schema: reviewSchema, key: 'signup-review' })

const wizard = useWizard([account, profile, review] as const)
```

With no `history` option, the wizard:

- Calls `wizard.next()` → URL becomes `?step=signup-profile`. `pushState` adds a new history entry.
- Calls `wizard.back()` → URL becomes `?step=signup-account`. The browser's back button walks the wizard.
- Reload at `?step=signup-review` → wizard opens on the `signup-review` step (the form's resolved or seeded values populate normally).
- Other search params on the URL are preserved across navigations.

## Disabling history

For embedded wizards (modal flows, in-page widgets, sub-flows whose step state should not show up in the page URL), pass `history: false`:

```ts
const wizard = useWizard([account, profile, review] as const, {
  history: false,
})
```

Step state lives in the wizard's own ref; navigations no longer touch `window.history`.

## Renaming the URL param

When two wizards live on the same page, or `?step` clashes with an existing query param, rename it:

```ts
const checkout = useWizard([cart, shipping, payment] as const, {
  history: { param: 'checkout' },
})
const onboarding = useWizard([invite, profile, tour] as const, {
  history: { param: 'onboard' },
})
```

The URL carries both: `/account?checkout=shipping&onboard=profile`. Each wizard reads its own param on load and writes its own param on navigation.

## Push vs replace per call

`wizard.next()`, `wizard.back()`, and `wizard.goTo()` accept a per-call options bag. `replace: true` swaps `pushState` for `replaceState`, leaving the history stack unchanged:

```ts
wizard.next() // pushState — back button retreats one step
wizard.next({ replace: true }) // replaceState — back button skips this entry

wizard.goTo('signup-review', { replace: true })
```

Replace is the right call for fix-ups (validation redirects, normalized URLs, programmatic skip-aheads that shouldn't pollute history).

## SSR safety

The integration reads `window` lazily. On the server, the wizard skips every history call and opens on `forms[0]` (or whatever `getServerActiveStep()` returned). The HTML serializes the right step without ever touching browser globals.

See [the SSR page](/docs/multistep/ssr) for the per-request active-step source and the privacy invariant.

## Cross-reference

- [`useWizard`](/docs/multistep/use-wizard) for navigation methods.
- [SSR & the privacy invariant](/docs/multistep/ssr) for `getServerActiveStep` and server-side step selection.
