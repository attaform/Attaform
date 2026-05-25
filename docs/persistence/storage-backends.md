---
title: Storage backends
description: Pick local, session, indexeddb, or a custom FormStorage adapter. The bundle ships only the backend you pick, and IndexedDB round-trips Date / Map / Set verbatim through structured clone.
metaRows:
  - label: Category
    value: Module
  - label: Built-in kinds
    value: local · session · indexeddb
    kind: code
  - label: Custom
    value: FormStorage interface
    kind: code
  - label: Bundle cost
    value: only the picked backend ships
---

# Storage backends

> Pick the backend that fits your fidelity, size, and lifetime needs. Attaform handles the rest, and the bundle stays lean because only the chosen backend ships.

::docs-meta-table
::

This form persists to `'indexeddb'`. Type, refresh the page, and your draft (including the live `Date` instance on the due-date field) comes back through structured clone. Swapping to `'local'` or `'session'` is a one-word change in `persist`; the bundle includes only the backend you pick.

::docs-demo{slug="storage-backends" label="Storage Backends Demo"}
::

## The four kinds

```ts
useForm({ schema, persist: 'local' }) // localStorage
useForm({ schema, persist: 'session' }) // sessionStorage
useForm({ schema, persist: 'indexeddb' }) // IndexedDB
useForm({ schema, persist: customAdapter }) // any FormStorage object
```

| Backend       | Size budget  | Sync/async | Best for                                                                |
| ------------- | ------------ | ---------- | ----------------------------------------------------------------------- |
| `'local'`     | ~5 MB        | sync       | Small forms, widest compatibility. Shared across same-origin tabs.      |
| `'session'`   | ~5 MB        | sync       | Tab-scoped scratch state. Clears when the tab closes.                   |
| `'indexeddb'` | 50%+ of disk | async      | Large forms. `Date` / `Map` / `Set` / typed arrays round-trip verbatim. |
| `FormStorage` | you decide   | you decide | Encrypted stores, cookie-backed, native-mobile bridges.                 |

`'local'` and `'session'` go through `JSON.stringify`, so non-JSON leaves lose fidelity (a `Date` becomes a string). `'indexeddb'` uses the browser's structured-clone algorithm: `Date`, `Map`, `Set`, typed arrays, and nested objects ride through cleanly.

Only the backend you pick is bundled. Choosing `'local'` doesn't pull in the IndexedDB module; the kind dispatch is dynamic-import behind the scenes.

## Full `persist` options

```ts
useForm({
  schema,
  persist: {
    storage: 'local' | 'session' | 'indexeddb' | customAdapter,
    key: 'override-key', // default: `attaform:${formKey}`
    debounceMs: 500, // default 300
    include: 'form+errors', // default 'form'
    clearOnSubmitSuccess: false, // default true
  },
})
```

Five operational knobs:

- `storage`: the backend (same union as the shorthand).
- `key`: overrides the default `attaform:${formKey}` prefix. The schema fingerprint is appended automatically; you supply only the human-readable label.
- `debounceMs`: coalesces typing bursts into one write. Drop it to `0` for save-every-keystroke feedback, raise it for slower backends.
- `include`: `'form'` persists values only; `'form+errors'` also persists the error map (useful for multi-step wizards that don't want to re-run server validation on reload).
- `clearOnSubmitSuccess`: `true` wipes the draft when `handleSubmit`'s success callback resolves; `false` keeps it (review pages, retry-prone APIs).

What's NOT here: an allowlist / blocklist of paths, a `redactFields` knob, a `version:` field. Per-field opt-in lives on each `register` call (see [Per-field opt-in](/docs/persistence/per-field-opt-in)); schema-change invalidation flows from the fingerprint (see [Edge cases & hydration](/docs/persistence/edge-cases)).

## Switching backends safely

The configured `storage` is the source of truth for "where the draft lives now." On every mount, an orphan-cleanup pass sweeps the three standard backends (`'local'`, `'session'`, `'indexeddb'`) under the form's key prefix and removes anything that doesn't match the configured backend's current-fingerprint entry. So switching from `'local'` to `'session'` (or to a custom encrypted adapter) can't leave a stale PII envelope behind.

```ts
// Before:
useForm({ schema, key: 'signup', persist: 'local' })

// After (next deploy): mount-time sweep wipes the old 'local' entry.
useForm({ schema, key: 'signup', persist: encryptedStorage })
```

Removing `persist:` entirely sweeps all three standard backends for the form's default key, so disabling persistence actually clears the on-disk artifact instead of leaving it indefinitely. The only thing the sweep can't reach is a custom `persist.key` from a previous deployment; rename migrations are an explicit consumer move.

## Custom backend

Implement the four-method `FormStorage` interface and pass the object directly:

```ts
import type { FormStorage } from 'attaform'

const encryptedStorage: FormStorage = {
  async getItem(key) {
    return await fetch(`/api/drafts/${key}`).then((r) => r.json())
  },
  async setItem(key, value) {
    await fetch(`/api/drafts/${key}`, { method: 'PUT', body: JSON.stringify(value) })
  },
  async removeItem(key) {
    await fetch(`/api/drafts/${key}`, { method: 'DELETE' })
  },
  async listKeys(prefix) {
    return await fetch(`/api/drafts?prefix=${prefix}`).then((r) => r.json())
  },
}

useForm({ schema, key: 'signup', persist: encryptedStorage })
```

`listKeys(prefix)` powers the orphan sweep. Adapters that can't enumerate (HTTP-backed, cookie-backed) return `[]`, and the sweep degrades gracefully without blocking the rest of the lifecycle.

## Latency in practice

Write latency for a 100-leaf form: `'local'` and `'session'` land in **~3 µs**, `'indexeddb'` in **~62 µs**. Both are well under one frame; the gap matters only when you're paying for many writes per second or when async hydration timing affects first paint. For most forms, pick the backend that fits the data fidelity you need and the size budget; performance is a non-issue.

## Where to next

- [Per-field opt-in](/docs/persistence/per-field-opt-in): the second of the two gates.
- [Sensitive-name protection](/docs/persistence/sensitive-names): the heuristic that blocks `password` / `cvv` / `ssn` from landing in any backend.
- [Edge cases & hydration](/docs/persistence/edge-cases): fingerprint invalidation, cross-tab races, hydration ordering.
