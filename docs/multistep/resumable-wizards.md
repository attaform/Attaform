---
title: Resumable wizards
description: Persist a wizard across sessions with no extra tables. Form values ride in through defaultValues, gate clearance through defaultStatuses, and the server stays the authority on every gate.
metaRows:
  - label: Category
    value: 'Restore / persist'
  - label: Restores
    value: 'step · values · gates'
    kind: code
  - label: Storage
    value: one row, no extra tables
  - label: Authority
    value: the server, re-checked per write
---

# Resumable wizards

> A multistep flow a user can leave and return to needs three things restored: the active step, each form's values, and which gates the session has cleared. Attaform already round-trips the step through the URL, values ride in through each form's `defaultValues`, and gate clearance rides in through `useWizard`'s `defaultStatuses`. All three load from one fetch, and none of them needs a table of its own.

::docs-meta-table
::

## The three things a wizard restores

A resumable wizard is three pieces of state, each with its own channel:

- **The active step**, handled for you by [URL sync](/docs/multistep/url-sync). `?step=<key>` is read at construction and written on navigation, so a reload lands where the user left off.
- **Each form's values**, restored through that form's [`defaultValues`](/docs/schemas/defaults). Validity, dirty, and error counts are recomputed from the restored values, so you never store them.
- **Gate clearance**, restored through [`defaultStatuses`](/docs/multistep/statuses). A gate's cleared state is the one fact you cannot recompute from values, because "the box validates" is not "the prerequisite was confirmed" (that split is the whole reason [`gate`](/docs/multistep/gate) exists). So it is the one status worth persisting.

## One fetch, one row

Load the session once and feed the three channels from the same payload. The gate flags are a small JSON column on the row you already keep for the form values, so a resumable wizard adds no tables:

```ts
import { useForm, useWizard, gate } from 'attaform'
import { z } from 'zod'

const consentSchema = z.object({ accepted: z.literal(true) })
const shippingSchema = z.object({ address: z.string(), city: z.string() })

// What you persist per session: each form's values, plus a `gates` column.
type SavedSession = {
  consent: { accepted: true }
  shipping: { address: string; city: string }
  gates: Record<string, { gate: 'cleared' | 'uncleared' }>
}

// One call returns the whole row.
const saved: SavedSession = await loadSession(sessionId)

const consent = useForm({ schema: consentSchema, key: 'consent', defaultValues: saved.consent })
const shipping = useForm({ schema: shippingSchema, key: 'shipping', defaultValues: saved.shipping })

const wizard = useWizard({
  steps: [gate(consent), shipping],
  defaultStatuses: saved.gates, // e.g. { consent: { gate: 'cleared' } }
})
```

Values in through `defaultValues`, gate in through `defaultStatuses`, both from `saved`. The `gates` column holds one entry per gate, so ten gates cost the same zero extra tables as one.

## Writing it back

A gate clears on its member form's clean submit, so the write-back rides on the submit you already have. Record the flag on the server there. The client's gate latch has already moved, so there is nothing else to sync:

```ts
consent.handleSubmit(async (data) => {
  await confirmConsentOnServer(sessionId, data) // server records gates.consent = 'cleared'
})
```

To re-seal a gate later, a revoked consent or a rolled-back approval, [`wizard.relock(key, commit)`](/docs/multistep/gate#withdrawing-a-gate) runs your server write and re-seals only if it resolves clean, keeping the row and the client in step.

## The server stays the authority

The seed is a first-paint optimization, not an access check. Because `defaultStatuses` seeds the gate at construction, a client that tampers with its saved `gates` value renders the flow open. That is fine, as long as the guarantee lives where `gate()` puts it: in the data, enforced by the server. Re-check the prerequisite on every downstream write, so a spoofed client seed shows an open rail but the server still refuses the mutation. The gate keeps the client honest for free; the server keeps it honest for real.

This is why gate clearance is not a field in the form's schema. Keeping it out of `values` means it is never submitted as if it were user data, never validated as if the client owned it, and never mistaken for the authority. It is server-owned state that the client is merely allowed to cache.

## Where to next

- [URL sync](/docs/multistep/url-sync) for the active-step half of the round-trip.
- [`gate`](/docs/multistep/gate) for the prerequisite model and `relock`.
- [Statuses](/docs/multistep/statuses) for the full `defaultStatuses` seed shape.
- [Defaults from the schema](/docs/schemas/defaults) for how `defaultValues` rehydrates each form.
