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

What's stored: the value subtree, plus the blank marks under it. A field the user deliberately emptied comes back empty rather than showing its slim value, which keeps "the user cleared this" distinguishable from "nothing was ever entered" across a switch. Turn `rememberVariants` off and the blank marks go with the values.

Interaction state (`touched`, `blurred`, `focused`) is NOT part of the snapshot. It lives outside the union's storage tree, so it survives a switch either way, memory on or off.

## Memory is in-memory only

Variant memory lives for the lifetime of the form instance and goes nowhere else. Nothing writes it to storage, to the URL, or to the server, so it does not survive a page reload, and a form rehydrated from a saved draft starts with an empty memory map: the first discriminator switch after the reload has no prior variant to restore.

For cross-session continuity of inactive-variant typing, carry it beyond the union boundary yourself. Watch the discriminator, mirror the outgoing subtree into a slot you save, and write it back when the user returns to that variant.

## `reset()` and `resetField()` interactions

- **`reset()`** clears all variant memory. The reset state becomes the new "no memory" baseline.
- **`resetField(path)`** clears any memory entry whose union path equals or sits under `path`. Sibling unions keep theirs, and so does a union sitting **above** the reset path: `resetField('notify.address')` leaves the memory for the union at `notify` intact, because that snapshot self-corrects on the next switch-out.

## Where to next

- [Discriminated unions](/docs/schemas/discriminated-unions): the schema feature variant memory rides on top of.
- [`reset` & `resetField`](/docs/writing-and-mutating/reset): both interact with the memory map deterministically.
- [App-wide defaults](/docs/cross-cutting-state/app-defaults): set `rememberVariants` once for every form in the app.
