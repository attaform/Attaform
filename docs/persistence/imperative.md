---
title: Imperative persistence
description: form.persist() writes the current snapshot regardless of per-field opt-ins; form.clearPersistedDraft() wipes the backend entry. Use them for Save Draft buttons, beforeunload handlers, and explicit cleanup.
metaRows:
  - label: Category
    value: Return methods
  - label: form.persist
    value: '(path, options?) => Promise<void>'
    kind: code
  - label: form.clearPersistedDraft
    value: '(path?) => Promise<void>'
    kind: code
  - label: Bypass per-field gate?
    value: form.persist yes; clearPersistedDraft N/A.
---

# Imperative persistence

> Two methods, one job each. `form.persist(path)` flushes the current value at a path, `form.clearPersistedDraft()` wipes the backend entry. Both are async, both no-op cleanly when persistence isn't configured.

::docs-meta-table
::

Neither field in this demo opts into persistence via `register`, but `form.persist(path)` writes them anyway. That's the bypass: the method ignores the per-field opt-in gate so a "Save draft" button can capture whatever's on screen, including fields that don't otherwise persist. The clear buttons demonstrate the per-path and whole-form variants.

::docs-demo{slug="imperative-persistence" label="Imperative Demo"}
::

## `form.persist(path, options?)`

```ts
await form.persist('email') // flush just one path's subtree
await form.persist('step1') // works on object subtrees too
await form.persist('password', { acknowledgeSensitive: true }) // sensitive paths
```

A one-shot read-merge-write that:

- **Bypasses the per-element opt-in gate.** Use it when an explicit user action ("Save draft", `beforeunload`, wizard section boundary) means "save what's on screen now."
- **Bypasses the debouncer.** Pending writes flush first.
- **Preserves untouched paths in storage.** A path-scoped call merges into the existing envelope; it does not overwrite siblings.
- **Throws `SensitivePersistFieldError`** on heuristic-matched paths unless `{ acknowledgeSensitive: true }` is passed.
- **No-ops silently** when `persist:` isn't configured on the form. Adding a "Save draft" button to a non-persisted form is a no-cost call.

For "save the whole form," iterate the top-level paths:

```ts
const paths = ['title', 'body', 'tags'] as const

async function onSaveDraft() {
  for (const p of paths) await form.persist(p)
}

// beforeunload guard for a long wizard
window.addEventListener('beforeunload', () => {
  for (const p of paths) void form.persist(p)
})

// Wizard step transition: only the current step's subtree
async function goToStep(n: number) {
  await form.persist(`step${currentStep.value}`)
  currentStep.value = n
}
```

The explicit-path signature is deliberate; "save what's on screen" is rarely literally the whole form. The path-scoped call gives you a precise checkpoint without accidentally promoting unfocused fields into storage.

## `form.clearPersistedDraft(path?)`

```ts
await form.clearPersistedDraft() // wipe the whole envelope
await form.clearPersistedDraft('email') // wipe one path's slot
```

`clearPersistedDraft` does NOT touch in-memory form state, and does NOT disable any active opt-ins; future writes from opted-in bindings will re-populate the storage entry.

For "wipe both in-memory and on-disk," call `reset()` after `clearPersistedDraft()`:

```ts
async function startFresh() {
  await form.clearPersistedDraft()
  form.reset()
}
```

## Auto-clear on submit

By default, a successful submit fires `clearPersistedDraft()` automatically. `handleSubmit`'s success callback resolving is the signal to drop the draft. Set `clearOnSubmitSuccess: false` on the form's `persist` config to opt out (review pages, retry-prone APIs that want to keep the draft until a confirmation lands):

```ts
useForm({
  schema,
  key: 'signup',
  persist: { storage: 'local', clearOnSubmitSuccess: false },
})
```

The default keeps the on-disk surface aligned with the user's mental model: "I submitted, the draft is done." Override only when there's a concrete reason to keep it.

## Where to next

- [Per-field opt-in](/docs/persistence/per-field-opt-in): the declarative opt-in `form.persist()` bypasses.
- [Edge cases & hydration](/docs/persistence/edge-cases): what happens when imperative writes race the debouncer, hydration timing, cross-tab.
- [`handleSubmit`](/docs/submitting/handle-submit): the success path that owns the auto-clear.
