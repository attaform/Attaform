---
title: Autosave
description: A copy-paste useAutosave recipe over a watch on form.values. Per-field status, an aggregate isSaving, a validity gate, and debounced writes, with no new dependency and the save policy in your hands.
metaRows:
  - label: Category
    value: Recipe
  - label: Built on
    value: watch · validateAsync
    kind: code
  - label: Returns
    value: status · isSaving · runWithoutAutosave
    kind: code
  - label: Dependency
    value: none (copy-paste, you own it)
---

# Autosave

> A copy-paste `useAutosave` composable built on a Vue `watch`: per-field status, an aggregate `isSaving`, a validity gate, and debounced writes. Attaform owns the reactive form, you own the save policy.

::docs-meta-table
::

Email saves as a draft: even an invalid address persists as you type, while Attaform still flags it inline below the field. Display name and bio gate on validity instead, holding back until they pass (display name needs two characters). Type a burst and one save lands per pause, the toast confirming it. Tick the box to fail saves and watch the aggregate banner flip. Load the saved profile or reset to watch a write land with no autosave at all.

::docs-demo{slug="autosave" label="Autosave Recipe Demo"}
::

## The recipe

`useAutosave` watches each path through `form.toRef`: it debounces every field, gates the save on the field being valid, tracks per-path status, and rolls that up into an aggregate. Drop it into your app as a composable and own it from there.

```ts
// composables/useAutosave.ts
import { computed, nextTick, reactive, watch } from 'vue'
import type { FlatPath, GenericForm, UseFormReturnType } from 'attaform'

export type SaveStatus = 'idle' | 'pending' | 'saving' | 'saved' | 'error'

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

  let paused = false

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
      if (!signal.aborted) status[path] = 'saved'
    } catch {
      if (!signal.aborted) status[path] = 'error'
    }
  }

  for (const path of paths) {
    let timer: ReturnType<typeof setTimeout> | undefined
    let controller: AbortController | undefined
    watch(form.toRef(path), (value) => {
      if (paused) return
      status[path] = 'pending'
      controller?.abort()
      controller = new AbortController()
      const { signal } = controller
      if (timer) clearTimeout(timer)
      timer = setTimeout(() => void run(path, value, signal), debounceMs)
    })
  }

  function runWithoutAutosave(write: () => void) {
    paused = true
    try {
      write()
    } finally {
      void nextTick(() => {
        paused = false
      })
    }
  }

  return {
    status,
    isSaving: computed(() => Object.values(status).some((s) => s === 'saving')),
    failed: computed(() => paths.filter((path) => status[path] === 'error')),
    runWithoutAutosave,
  }
}
```

The path and form type helpers (`FlatPath`, `GenericForm`, `UseFormReturnType`) come from the core `attaform` entry. The composable is adapter-agnostic: it works against a Zod v3, Zod v4, or any other adapter's form, since it only reaches for `form.toRef` and `validateAsync`.

## What it gives you back

| Return               | Type                       | Use                                                                       |
| -------------------- | -------------------------- | ------------------------------------------------------------------------- |
| `status`             | `Record<path, SaveStatus>` | Per-field badge: `idle` / `pending` / `saving` / `saved` / `error`.       |
| `isSaving`           | `ComputedRef<boolean>`     | Aggregate "a save is in flight" for a header spinner or banner.           |
| `failed`             | `ComputedRef<path[]>`      | The paths whose last save errored, for a retry affordance.                |
| `runWithoutAutosave` | `(write) => void`          | Run a programmatic write (hydrate, reset) without tripping a save. Below. |

None of it lives in form state. `status` is a plain reactive map the composable owns: the form's `dirty` / `validating` surface stays about the form, autosave status stays about autosave.

## Wiring it up

Hoist the schema, build the form, then point `useAutosave` at the paths you want saved. The `save` callback is yours: it receives the path, its value, and an `AbortSignal` to hand straight to `fetch`.

```ts
const schema = z.object({
  email: z.string().email(),
  displayName: z.string().min(2),
  bio: z.string().max(160),
})

const form = useForm({ schema })

const { status, isSaving, failed, runWithoutAutosave } = useAutosave(
  form,
  ['email', 'displayName', 'bio'],
  async (path, value, signal) => {
    await api.patch(`/profile/${path}`, { value }, { signal })
  },
  { debounceMs: 600 }
)
```

`useAutosave` registers its watchers inside `setup`, so they stop automatically when the component unmounts. No manual teardown.

## How the watch reacts

Each path gets its own `watch(form.toRef(path), ...)`. `form.toRef('email')` is a read-only Vue ref over that path's value, resolved from a dotted string, so the watcher fires whenever the value at that path changes. Writing the same value back is a no-op in Attaform, so a watcher never fires for a write that changed nothing.

`toRef` resolves a nested path directly, so `form.toRef('profile.bio')` watches a leaf several levels deep with no extra wiring. For a whole container path, add `{ deep: true }` to that watcher to react to any field beneath it, since an in-place leaf edit keeps the container's reference stable (Vue's deep-watch behaviour).

## Gating on validity

This is where validation and persistence meet. `gateOnValidity` (on by default) runs `form.validateAsync(path)` before each save and skips the write when the field is invalid, so a value that fails validation never reaches the server, and the field's [async refinements](/docs/validation/async-refinements) run as part of that same check.

`.refine` decides whether a value is allowed; the autosave decides whether to persist it. Composing them gives you "save only what passes" without either concern leaking into the other. Turn the gate off (`{ gateOnValidity: false }`) when you want a true draft autosave that captures even invalid in-progress state.

For per-field control, pass a predicate instead of a boolean: `gateOnValidity: (path) => path !== 'email'` keeps `email` a draft while gating the rest. The demo above does exactly that, so an invalid email still autosaves while `fields.email.showErrors` surfaces the validation message. The write persists the draft, the read flags it, and neither blocks the other.

## Debouncing and superseding

A network round-trip per keystroke is wasteful, so each path gets its own debounced scheduler. The recipe inlines a small `setTimeout` debounce to stay dependency-free; if your app already uses VueUse, swap in `useDebounceFn` with no other change.

Each watcher also owns an `AbortController`. When a newer edit lands before the previous save finished, the recipe aborts the prior controller and starts a fresh one, so a stale request to a slow endpoint cancels itself and the latest write wins. The `save` callback receives that `signal`, so passing it to `fetch` cancels the request in flight; checking `signal.aborted` after an `await` skips a status update for work that has been superseded. Because the scheduler returns immediately, the actual save runs after the watcher has finished, so `run` catches its own throw and sets `status[path] = 'error'` rather than letting it escape.

## Pausing autosave for hydration and reset

A `watch` reacts to every change to its source, including the writes you make yourself: loading a saved record with `form.setValue`, or a `form.reset()`. Left unguarded, hydrating ten fields would echo ten autosaves straight back at the server you just loaded from. `runWithoutAutosave` wraps such a write so the watchers skip it: it raises an internal flag, runs your write, then clears the flag on the next tick once the watchers have seen (and ignored) the change.

```ts
function loadProfile(saved: Profile) {
  runWithoutAutosave(() => form.setValue(saved))
}

function discard() {
  runWithoutAutosave(() => form.reset())
}
```

The pause belongs to the recipe, not the form. The form has no idea autosave exists, the same separation that keeps `status` out of `form.meta`. You own the autosave, so you own when it pauses.

## Why a recipe, not a shipped export

Attaform ships [zero runtime dependencies](/docs/getting-started/why-attaform), and a genuinely good autosave wants opinions the core should not make for you: the debounce window, retry and backoff policy, whether a save is optimistic or confirmed, and what "saved" even means for your backend. Those are application decisions. The reactive form is the small, sharp primitive Attaform owns; `useAutosave` is the policy you own, sized and tuned to your app. Copy it, change it, delete the parts you do not need.

## Where to next

- [Async refinements](/docs/validation/async-refinements): the server-side validity checks the gate runs.
- [`setValue` patterns](/docs/writing-and-mutating/set-value): the write surface the recipe drives, including the hydrating record load.
- [Undo and redo](/docs/cross-cutting-state/undo-redo): the other cross-cutting reaction to form changes, kept inside the form.
