---
title: URL availability check (preprocess + async refine)
description: Preprocess prepares the value, async refine validates it. A small sentinel handoff lets refine skip the API call when preprocess already knows the input is empty or malformed, and a cache keeps repeat checks free.
metaRows:
  - label: Category
    value: Recipe
  - label: Builds on
    value: z.preprocess, .refine, useForm
    kind: code
  - label: Surfaces
    value: form.errors, form.meta.validating
    kind: code
---

# URL availability check (preprocess + async refine)

> Two cooperating layers. Preprocess augments the user's input into a full URL. Async refine checks it against a backend, with sentinels for "empty" and "malformed" so refine can skip the network when there's nothing worth asking. A cache makes repeat checks free.

::docs-meta-table
::

::docs-demo{slug="url-availability-check" label="URL Availability Demo"}
::

## What the form needs to do

A signup form takes a site URL. Users type informally (`example.com`, not `https://example.com`). The form has to:

1. Accept whatever the user types verbatim, so the input cursor never jumps under their fingers.
2. Augment the value to a full URL when checking it.
3. Ask the backend whether the URL is already taken.
4. Surface a specific message for each failure mode: empty, malformed, or taken.
5. Avoid hammering the backend on every keystroke; reuse previous answers.

Preprocess and async refine map onto that work cleanly. Preprocess **prepares** the value (trim, add protocol, decide whether it's URL-shaped at all). Refine **validates** it (ask the backend, surface a message). Storage stays as the user's raw text, so re-rendering, persistence, and history all carry the input the user actually typed.

## The schema

Hoist the schema next to the form so the type flows through `useForm` cleanly. Two sentinels (`EMPTY_URL` and `INVALID_URL`) bridge the two layers; both are strings so the inner `z.string()` accepts them, and refine recognises them by exact equality.

```ts
import { useForm } from 'attaform/zod'
import { z } from 'zod'

const EMPTY_URL = '__atta:empty-url__'
const INVALID_URL = '__atta:invalid-url__'

const TAKEN = new Set(['https://google.com', 'https://apple.com', 'https://github.com'])
const availabilityCache = new Map<string, boolean>()

async function checkAvailability(url: string): Promise<boolean> {
  const cached = availabilityCache.get(url)
  if (cached !== undefined) return cached
  await new Promise((r) => setTimeout(r, 350))
  const available = !TAKEN.has(url)
  availabilityCache.set(url, available)
  return available
}

function formatUrl(v: unknown): string {
  if (typeof v !== 'string') return INVALID_URL
  const trimmed = v.trim()
  if (trimmed.length === 0) return EMPTY_URL
  const withProtocol = /^https?:\/\//i.test(trimmed) ? trimmed : `https://${trimmed}`
  try {
    new URL(withProtocol)
    return withProtocol
  } catch {
    return INVALID_URL
  }
}

const schema = z.object({
  url: z.preprocess(
    formatUrl,
    z.string().refine(
      async (val) => {
        if (val === EMPTY_URL || val === INVALID_URL) return false
        return checkAvailability(val)
      },
      {
        error: (issue) => {
          const val = issue.input as string
          if (val === EMPTY_URL) return 'Please enter a URL.'
          if (val === INVALID_URL) return "That doesn't look like a URL."
          return `${val} is already taken.`
        },
      }
    )
  ),
})

const form = useForm({ schema, key: 'url-check', validateOn: 'blur' })
```

## How the layers split the work

Preprocess and refine each own a single decision.

**Preprocess decides what shape the value is in.** It receives whatever the consumer wrote (`unknown` at the type level under the [storage contract](/docs/schemas/storage-shape)) and produces one of three string outputs: a fully-qualified URL, the empty sentinel, or the invalid sentinel. The function is synchronous, so it never holds up the write boundary; storage at `form.values.url` keeps the raw text the user typed.

**Refine validates the prepared value.** It sees the post-preprocess string. Sentinels short-circuit straight to failure; real URLs go through `checkAvailability`. Refine also owns the error messages: it has all the context (the value, the sentinel) to pick the right copy without preprocess having to thread it through.

**The cache is a Map keyed on the post-preprocess URL.** Repeat checks against the same URL hit the cache instead of the simulated network, so a user who types `google.com`, edits it to `apple.com`, then back to `google.com` only pays the API cost twice. In production, you'd populate the cache from a SWR / TanStack Query layer rather than rolling your own.

## Three messages, one validator

| User input                 | Preprocess returns       | Refine outcome | Error message                          |
| -------------------------- | ------------------------ | -------------- | -------------------------------------- |
| `''` (blur on empty input) | `EMPTY_URL`              | invalid        | "Please enter a URL."                  |
| `'###'`                    | `INVALID_URL`            | invalid        | "That doesn't look like a URL."        |
| `'google.com'`             | `'https://google.com'`   | invalid        | "https://google.com is already taken." |
| `'attaform.dev'`           | `'https://attaform.dev'` | valid          | (none, form submits)                   |

Every message comes out of the refine layer. Preprocess never raises an error itself; it just hands a value over for refine to grade. This is the cleanest division: validation messages all live in one place.

## Storage stays raw

Under the [storage contract](/docs/schemas/storage-shape), `form.values.url` holds whatever the user typed, never the post-preprocess value and never the sentinel. The directive re-renders the input from storage, so the user always sees their own text. The sentinels live only inside the parse pipeline (preprocess output → refine input); they never leak to the surface.

This split is what makes the recipe work. Under a "preprocess mutates storage at write" model, typing `google.com` would jump to `https://google.com` mid-edit, the cursor would land in the middle of "google", and the sentinel pattern would surface in `form.values.url` as a magic string. Under the no-write-mutation contract, the typed value is the displayed value is the stored value, and the parsed view is reached through `handleSubmit`, `validate`, or `validateAsync`.

## Reaching the typed result

Submit hands the success callback the post-parse output: preprocess has augmented the URL, refine has confirmed availability, and the cache holds the answer for the next pass.

```ts
const onSubmit = form.handleSubmit((data) => {
  data.url // 'https://attaform.dev', full URL, augmented + checked
  // POST to the signup endpoint…
})
```

If you need the typed shape outside submit, call `form.validateAsync()` or `form.process()`. Both run the same pipeline against current storage and return the post-parse output.

## Tweaks

- **One sentinel instead of two.** If you only need a single "rejected" message ("That URL won't work"), collapse `EMPTY_URL` and `INVALID_URL` into one sentinel and short-circuit refine on that single check. You lose the empty-vs-malformed distinction but the schema gets a few lines shorter.
- **Validate on submit only.** Change `validateOn: 'blur'` to `validateOn: 'submit'` for forms where the network round-trip on blur is too noisy. The cache still pays for itself once the user clicks Submit and retries.
- **Invalidate on success.** After a successful signup, call `availabilityCache.delete(submittedUrl)` so a subsequent re-check picks up the new "taken" state on the server.
- **Real backend.** Swap the `setTimeout`-based `checkAvailability` for your API call. A library like TanStack Query gives you the cache + de-duplication for free; the schema stays exactly as written.

## Where to next

- [The storage contract](/docs/schemas/storage-shape): why preprocess and coerce keep storage raw, and how the two-layer model splits responsibilities.
- [Async refinements](/docs/validation/async-refinements): the broader lifecycle around async refine, debouncing, and the validating state.
- [Showing errors at the right time](/docs/validation/showing-errors): when to render `form.errors.url` so the user sees the message at the right moment.
