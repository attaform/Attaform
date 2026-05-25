---
title: Variant memory
description: rememberVariants keeps the inactive variant's typed subtree alive so switching back restores it. Opt out for wizards that should reset on backtrack, or for memory-constrained targets.
metaRows:
  - label: Category
    value: Form option
  - label: Option
    value: useForm({ rememberVariants })
    kind: code
  - label: Default
    value: 'true'
    kind: code
  - label: Lifetime
    value: in-memory only (no persistence)
---

# Variant memory

> Switching away from a discriminated-union variant doesn't have to mean losing what was typed. Memory snapshots ride alongside the active state and rehydrate on switch-back. Opt out when the variants are unrelated or memory matters.

::docs-meta-table
::

Two side-by-side forms with the same payment schema. Type into the card variant, switch to bank, switch back. The left form (`rememberVariants: true`) restores your card details; the right form (`rememberVariants: false`) starts fresh every switch. Same schema, opposite memory policy.

::docs-demo{slug="variant-memory" label="Variant Memory Demo"}
::

## The default

```ts
useForm({
  schema,
  // rememberVariants: true is Attaform's default
})
```

Switching back to a previously-visited variant lands on its prior subtree, including nested fields. Each discriminated union at every nesting depth is independently memorized: a top-level union and a nested one each keep their own memory map.

## Opting out

```ts
useForm({ schema, rememberVariants: false })
```

With `false`, every switch drops the outgoing variant's typed state. The new variant initializes from its slim default; the old data is gone.

Use the opt-out when:

- **The variants represent unrelated data.** A "contact preference" picker between phone and email should clear the phone when switching to email.
- **Memory leaks user input you don't want re-applied.** A wizard step that should reset when the user backtracks.
- **Memory-constrained targets.** Snapshots are small per-union, but a deeply nested form with many unions accumulates.

## Per-app default

Set the default app-wide via the plugin:

```ts
createAttaform({
  defaults: { rememberVariants: false },
})
```

Per-form `useForm({ rememberVariants: true })` overrides back to memory-on for forms that want it.

## What gets memorized

When the discriminator value flips:

1. The current variant's subtree is snapshotted into the memory map keyed by the outgoing variant's discriminator value.
2. The new variant's slim default seeds storage.
3. On a subsequent switch to a remembered variant, the snapshot rehydrates over the seeded default.

What's stored: the value subtree only. Field-state (touched, blurred, focused, etc.) is NOT part of the snapshot; that travels with the active field state, which lives outside the union's storage tree.

## Memory is in-memory only

Variant memory does NOT survive a page reload. Persisted state (`useForm({ persist: 'local' })`) restores values into form storage on hydration, but the variant memory map starts empty: the first discriminator switch after reload loses any persisted typing in the outgoing variant.

For cross-session continuity of inactive-variant typing, persist beyond the union boundary yourself. Mirror the inactive subtree into a separate persisted slot via a watcher on the discriminator.

## `reset()` and `resetField()` interactions

- **`reset()`** clears all variant memory. The reset state becomes the new "no memory" baseline.
- **`resetField(path)`** clears any memory entry whose union path equals or sits under `path`. Resetting a single union's path drops only that union's memory; sibling unions retain theirs.

## Where to next

- [Discriminated unions](/docs/schemas/discriminated-unions): the schema feature variant memory rides on top of.
- [`reset` & `resetField`](/docs/writing-and-mutating/reset): both interact with the memory map deterministically.
- [App-wide defaults](/docs/cross-cutting-state/app-defaults): set `rememberVariants` once for every form in the app.
