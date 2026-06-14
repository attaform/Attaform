---
title: Autosave
description: A copy-paste useAutosave recipe over form.onChange. Per-field status, an aggregate isSaving, a validity gate, and debounced writes, with no new dependency and the save policy in your hands.
metaRows:
  - label: Category
    value: Recipe
  - label: Built on
    value: form.onChange · validateAsync
    kind: code
  - label: Returns
    value: status · isSaving · failed
    kind: code
  - label: Dependency
    value: none (copy-paste, you own it)
---

# Autosave

> A copy-paste `useAutosave` composable built on `form.onChange`: per-field status, an aggregate `isSaving`, a validity gate, and debounced writes. Attaform ships the primitive, you own the policy.

::docs-meta-table
::

Email saves as a draft: even an invalid address persists as you type, while Attaform still flags it inline below the field. Display name and bio gate on validity instead, holding back until they pass (display name needs two characters). Type a burst and one save lands per pause, the toast confirming it. Tick the box to fail saves and watch the aggregate banner flip.

::docs-demo{slug="autosave" label="Autosave Recipe Demo"}
::

## The recipe

`useAutosave` wraps [`form.onChange`](/docs/cross-cutting-state/on-change) per path: it debounces each field, gates the save on the field being valid, tracks per-path status, and rolls that up into an aggregate. Drop it into your app as a composable and own it from there.

```ts
// composables/useAutosave.ts
import { computed, reactive } from 'vue'
import type { FlatPath, GenericForm, UseFormReturnType } from 'attaform'

type SaveStatus = 'idle' | 'pending' | 'saving' | 'saved' | 'error'

function debounce<A extends unknown[]>(fn: (...args: A) => void, ms: number) {
  let timer: ReturnType<typeof setTimeout> | undefined
  return (...args: A) => {
    if (timer) clearTimeout(timer)
    timer = setTimeout(() => fn(...args), ms)
  }
}

export function useAutosave<Form extends GenericForm>(
  form: UseFormReturnType<Form>,
  paths: readonly FlatPath<Form>[],
  save: (path: FlatPath<Form>, value: unknown, signal: AbortSignal) => Promise<void>,
  options: {
    debounceMs?: number
    gateOnValidity?: boolean | ((path: FlatPath<Form>) => boolean)
  } = {}
) {
  const { debounceMs = 600, gateOnValidity = true } = options
  const status = reactive<Record<string, SaveStatus>>({})
  for (const path of paths) status[path] = 'idle'

  async function run(path: FlatPath<Form>, value: unknown, signal: AbortSignal) {
    try {
      const gate = typeof gateOnValidity === 'function' ? gateOnValidity(path) : gateOnValidity
      if (gate && !(await form.validateAsync(path)).success) {
        status[path] = 'idle'
        return
      }
      if (signal.aborted) return
      status[path] = 'saving'
      await save(path, value, signal)
      if (signal.aborted) return
      status[path] = 'saved'
    } catch {
      if (!signal.aborted) status[path] = 'error'
    }
  }

  for (const path of paths) {
    const schedule = debounce(
      (value: unknown, signal: AbortSignal) => run(path, value, signal),
      debounceMs
    )
    form.onChange(path, (value, ctx) => {
      status[path] = 'pending'
      schedule(value, ctx.signal)
    })
  }

  return {
    status,
    isSaving: computed(() => Object.values(status).some((s) => s === 'saving')),
    failed: computed(() => paths.filter((path) => status[path] === 'error')),
  }
}
```

The path and form type helpers (`FlatPath`, `GenericForm`, `UseFormReturnType`) come from the core `attaform` entry. The composable is adapter-agnostic: it works against a Zod v3, Zod v4, or any other adapter's form, since it only reaches for `onChange` and `validateAsync`.

## What it gives you back

| Return     | Type                       | Use                                                                 |
| ---------- | -------------------------- | ------------------------------------------------------------------- |
| `status`   | `Record<path, SaveStatus>` | Per-field badge: `idle` / `pending` / `saving` / `saved` / `error`. |
| `isSaving` | `ComputedRef<boolean>`     | Aggregate "a save is in flight" for a header spinner or banner.     |
| `failed`   | `ComputedRef<path[]>`      | The paths whose last save errored, for a retry affordance.          |

None of it lives in form state. `status` is a plain reactive map the composable owns, exactly the side-channel discipline `onChange` is built for: the form's `dirty` / `validating` surface stays about the form, autosave status stays about autosave.

## Wiring it up

Hoist the schema, build the form, then point `useAutosave` at the paths you want saved. The `save` callback is yours: it receives the path, its value, and an `AbortSignal` to hand straight to `fetch`.

```ts
const schema = z.object({
  email: z.string().email(),
  displayName: z.string().min(2),
  bio: z.string().max(160),
})

const form = useForm({ schema })

const { status, isSaving, failed } = useAutosave(
  form,
  ['email', 'displayName', 'bio'],
  async (path, value, signal) => {
    await api.patch(`/profile/${path}`, { value }, { signal })
  },
  { debounceMs: 600 }
)
```

`useAutosave` registers its `onChange` handlers inside `setup`, so they stop automatically when the component unmounts. No manual teardown.

## Gating on validity

This is where the two halves meet. `gateOnValidity` (on by default) runs `form.validateAsync(path)` before each save and skips the write when the field is invalid, so a value that fails validation never reaches the server, and the field's [async refinements](/docs/validation/async-refinements) run as part of that same check.

`.refine` decides whether a value is allowed; `onChange` decides whether to persist it. Composing them gives you "save only what passes" without either concern leaking into the other. Turn the gate off (`{ gateOnValidity: false }`) when you want a true draft autosave that captures even invalid in-progress state.

For per-field control, pass a predicate instead of a boolean: `gateOnValidity: (path) => path !== 'email'` keeps `email` a draft while gating the rest. The demo above does exactly that, so an invalid email still autosaves while `fields.email.showErrors` surfaces the validation message. The write persists the draft, the read flags it, and neither blocks the other.

## Debouncing

A network round-trip per keystroke is wasteful, so each path gets its own debounced scheduler. The recipe inlines a five-line `debounce` to stay dependency-free; if your app already uses VueUse, swap in `useDebounceFn` with no other change.

Debouncing changes one thing about error handling. Because the scheduler returns immediately, the actual save runs after the `onChange` handler has already finished, so a throw inside `save` can no longer route to `onChange`'s own `onError`. That is why `run` catches its own errors and sets `status[path] = 'error'`. The `ctx.signal` cancellation still works through the debounce: a newer edit aborts the in-flight save's signal regardless of timing, so a stale request to a slow endpoint cancels itself. (For an immediate, undebounced reaction, `onChange`'s built-in `onError` and `retry()` carry the load instead. See the [`onChange` reference](/docs/cross-cutting-state/on-change#errors-never-reach-the-keystroke).)

## Why a recipe, not a shipped export

Attaform ships [zero runtime dependencies](/docs/getting-started/why-attaform), and a genuinely good autosave wants opinions the core shouldn't make for you: the debounce window, retry and backoff policy, whether a save is optimistic or confirmed, and what "saved" even means for your backend. Those are application decisions. `onChange` is the small, sharp primitive Attaform owns; `useAutosave` is the policy you own, sized and tuned to your app. Copy it, change it, delete the parts you don't need.

## Where to next

- [`onChange`](/docs/cross-cutting-state/on-change): the side-channel primitive this recipe is built on.
- [Async refinements](/docs/validation/async-refinements): the server-side validity checks the gate runs.
- [`setValue` patterns](/docs/writing-and-mutating/set-value): the `{ silent }` write for hydrating a form without echoing saves.
