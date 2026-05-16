---
title: Persistence overview
description: Opt in per form and per field, pick a storage backend, and Attaform saves drafts across reloads — schema-aware hydration, sensitive-name guards, zero ceremony beyond the persist option.
meta:
  - label: Category
    value: Module
  - label: Off by default?
    value: 'Yes'
  - label: Storage
    value: local / session / IndexedDB / custom
  - label: Sensitive-name guard
    value: built-in
---

# Persistence overview

> Opt in per form, opt in per field, pick a backend — Attaform handles the hydrate-on-mount and the schema-aware drop of stale drafts.

<DocsMetaTable />

<DocsDemo slug="persistence-overview" />

## Two opt-in gates

Persistence is **off by default** and gated by two opt-ins:

1. **Form-level** — pick a backend with the `persist` option:

   ```ts
   useForm({ schema, persist: 'session' })
   ```

2. **Field-level** — declare each field's participation in its `register` call site:

   ```vue
   <input v-register="form.register('email', { persist: true })" />
   ```

Without both, no writes hit the backend. Adding a new schema field can't accidentally leak into client-side storage unless its `register` call site says so — the kind of default that survives long forms growing over time.

## Storage backends

```ts
useForm({ persist: 'local' }) // localStorage
useForm({ persist: 'session' }) // sessionStorage
useForm({ persist: 'indexeddb' }) // IndexedDB
useForm({ persist: customStorage }) // any FormStorage object
useForm({ persist: { storage: 'local', debounceMs: 500 } }) // full options
```

The built-in backends are loaded on demand — picking `'local'` doesn't pull in IndexedDB code. Custom backends implement the `FormStorage` interface (read / write / clear / list).

## Schema-aware hydration

Attaform stamps every persisted draft with a fingerprint of the schema. On remount:

- If the schema is unchanged, values rehydrate before the first render — no flash.
- If the schema has changed (a field renamed, a refinement tightened), the stale draft is dropped automatically.

No silent shape mismatches; no manual versioning.

## Sensitive-name protection

Some path names imply secrets. The library-default `DEFAULT_SENSITIVE_NAMES` list — `password`, `passwd`, `pwd`, `pin`, `cvv`, `card_number`, `ssn`, `token`, `secret`, `api_key`, and others — throws at mount if you try to persist them.

Compose your own list by extending the default:

```ts
import { createAttaform, DEFAULT_SENSITIVE_NAMES } from 'attaform'

createAttaform({
  defaults: {
    sensitiveNames: [...DEFAULT_SENSITIVE_NAMES, 'mrn', 'tax_id'],
  },
})
```

The resolved list also gates multi-tab sync broadcasts and the DevTools redact walk — one configurable source of truth for "what counts as sensitive."

## Imperative control

```ts
await form.clearPersistedDraft() // wipe the backend entry
form.reset() // reset the in-memory store back to defaults
```

Pair with a "Clear my draft" button or a post-submit cleanup hook. By default, drafts auto-clear when `handleSubmit`'s success callback resolves — set `clearOnSubmitSuccess: false` to keep them.

## Where to next

- [The form object](/docs/reading-the-form/the-form-object) — the full reactive surface.
- [Troubleshooting](/docs/devtools-and-debugging/troubleshooting) — diagnose hydration mismatches with the DevTools panel.
