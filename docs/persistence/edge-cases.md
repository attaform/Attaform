---
title: Edge cases & hydration
description: Schema-change auto-invalidation, the four component-binding patterns, cross-tab last-writer-wins, storage degradation, and how hydration races with the first render.
metaRows:
  - label: Category
    value: Module
  - label: Schema-change invalidation
    value: automatic via fingerprint
  - label: Cross-tab
    value: last-writer-wins (no coordination)
  - label: Hydration
    value: pre-first-render (sync backends) / post-mount (indexeddb)
---

# Persistence edge cases & hydration

> The gotchas worth knowing before you ship: how schema changes drop stale drafts, how hydration races first paint, and how concurrent writes resolve.

::docs-meta-table
::

This form persists to `'session'` with `clearOnSubmitSuccess: false` and `score` is a numeric field. Type a score, add tags, refresh — values hydrate before the first render and the draft survives a successful submit. Behind the scenes, the orphan-cleanup pass runs every mount, the schema fingerprint gates the read, and the numeric blank handling stays consistent across reload.

::docs-demo{slug="persistence-edge-cases" label="Edge Cases Demo"}
::

## Schema-change auto-invalidation

Storage keys carry the schema's structural fingerprint:

```text
attaform:signup:7c3a0b   ← key on disk
                       └────┘
                       fingerprint of the current schema
```

When the schema changes shape — adding / removing / renaming a field, changing a leaf type, restructuring nested objects — the fingerprint changes. New writes go to a new key (`attaform:signup:9d2b1f`); the old key (`attaform:signup:7c3a0b`) becomes unreachable.

On the next mount, the orphan-cleanup pass enumerates keys under `attaform:signup` via `FormStorage.listKeys`, keeps the current-fingerprint entry, and removes the rest. No manual `version` bump, no possibility of forgetting it, and refinements (`.refine()`, `.transform()`) collapse to opaque sentinels in the fingerprint so tightening a refinement doesn't unnecessarily drop drafts.

Malformed entries (corrupted JSON, envelope-version mismatch, anything not matching the payload contract) wipe on read. "Truly absent" entries are a no-op — the wipe fires only when there's actually something to clean.

To force-invalidate without changing the schema (an unrelated tweak you want users to retest from scratch), call `form.clearPersistedDraft()` at mount or wrap the schema in a thin no-op layer that perturbs the fingerprint. The library deliberately doesn't expose a `forceVersion` knob — the schema fingerprint captures every legitimate "shape changed" signal.

## Hydration timing

```text
sync backends (local / session)        async backend (indexeddb)
─────────────────────────────          ─────────────────────────────
mount                                  mount
└─ pre-render hydration                ├─ render with schema defaults
   └─ first render with values         └─ post-mount hydration
                                          └─ render with values
```

`'local'` and `'session'` hydrate before the first render — no flash, the user never sees the schema's defaults. `'indexeddb'` is async; the first paint uses the schema defaults, then the hydration applies on the next microtask. For most forms this is invisible; for first-paint-critical surfaces (a credit-card form on a checkout funnel), `'session'` is the safer choice.

Numeric blank-state survives reload symmetrically. A field with no `defaultValues` entry and a numeric type starts blank-marked at construction; the persisted envelope includes the `blankPaths` set, so a numeric field cleared by the user stays visually empty after rehydration instead of resurrecting its slim default.

## Cross-tab semantics

`localStorage` writes from two tabs race; the persistence module does NOT coordinate — **last-writer-wins**. Two cases worth knowing:

- Tab A is mid-debounce; Tab B writes; Tab A's debounce overwrites.
- The persistence module doesn't subscribe to the `storage` event — fresh writes from another tab don't replay into the live form.

If multi-tab consistency matters, use `'session'` (tab-scoped) or layer [Multi-tab sync](/docs/cross-cutting-state/multi-tab-sync) on top — that _does_ mirror live edits across tabs via `BroadcastChannel`, and works orthogonally to persistence.

## Cross-SFC behavior

Two SFCs binding the same path under the same form key share the FormStore and the persistence registry. Opt-ins are per-DOM-element, not per-SFC:

- SFC A renders `<input v-register="register('email', { persist: true })">` — A's element opted in.
- SFC B renders `<input v-register="register('email')">` (no opt-in) — B's element NOT opted in.
- Typing in A persists. Typing in B doesn't.

Unmount SFC A and B's typing stops persisting (no opt-ins remain). Re-mount A and the new element gets a fresh opt-in. The registry tracks elements via WeakMap; rapid mount/unmount cycles auto-clean.

## Storage degradation

Backend failures (quota exceeded, Safari private mode, IndexedDB blocked) log a one-shot `console.warn` per form in dev mode and are silently swallowed in production. The form stays usable; writes just don't land.

If persistence appears to drop writes in dev, check the console first. For surfaces where storage failures need user-facing recovery (a wizard with a "Save Failed" toast), wrap `form.persist()` in your own `try` — that surface throws on adapter errors, unlike the implicit debounced writes.

## Component binding patterns

`<MyComponent v-register="register('name')" />` works through four patterns, each appropriate for different component shapes. The recommended pattern for most cases is `useRegister`:

| Pattern                   | When to use                                 | Persistence works?               |
| ------------------------- | ------------------------------------------- | -------------------------------- |
| Native input root         | Component's root is `<input>` / `<select>`  | Yes, directly                    |
| `useRegister` (preferred) | Component wraps a native input in styling   | Yes, on the inner native element |
| `injectForm`              | Compound component touching multiple fields | Yes, per-register call inside    |
| `assignKey`               | Web Components / non-Vue elements           | Yes, but you wire the listeners  |

The full walkthrough on each pattern lives in [`useRegister` for custom components](/docs/binding-inputs/use-register).

## What persistence is NOT for

- **Sensitive data.** See [Sensitive-name protection](/docs/persistence/sensitive-names) — the heuristic blocks the obvious cases, but per-field opt-in is the real defense.
- **Authoritative state.** Persistence is for draft UX, not source-of-truth. The server still owns the canonical record.
- **Cross-form coordination.** Each form persists independently. Multiple forms can share a key (sharing a FormStore and the persistence entry), but they're still one form to the persistence layer.
- **Schema migrations.** Auto-invalidation handles the common case. To rename a field without losing state, read the raw entry before the schema change ships and massage it into the new shape before calling `reset()`. The library deliberately doesn't ship a renaming-aware migration helper — renames are a write-once transformation the consumer owns.

## Where to next

- [Multi-tab sync](/docs/cross-cutting-state/multi-tab-sync) — live convergence across same-origin tabs (different problem; complementary to persistence).
- [`useRegister`](/docs/binding-inputs/use-register) — the recommended pattern for custom components, persistence-aware.
- [Persistence overview](/docs/persistence/overview) — the two-gate model and schema-aware hydration in one page.
