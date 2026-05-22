---
title: Undo & redo
description: history opt-in unlocks a per-form undo/redo chain — every mutation records a position, undo() and redo() walk the timeline, clear() reseeds at a milestone.
metaRows:
  - label: Category
    value: Module
  - label: Opt in
    value: useForm({ history: true })
    kind: code
  - label: Default depth
    value: 128 positions
  - label: Namespace
    value: form.history
    kind: code
---

# Undo & redo

> Opt into a per-form history chain with one option — every value mutation records a position, the namespace exposes `undo()` / `redo()` / `clear()` and the reactive flags that gate your UI.

::docs-meta-table
::

Type into any field, append a few tags, then hit `⌘Z` / `⌘⇧Z` (or click the buttons) to walk the chain. `canUndo` and `canRedo` gate the buttons reactively; `clear()` reseeds the chain at the current state — the move you'd make after a "Save successful" milestone.

::docs-demo{slug="undo-redo"}
::

## The option

```ts
useForm({
  schema,
  history: true, // default 128-position bounded chain
})
```

Tune the depth:

```ts
useForm({ schema, history: { max: 200 } })
```

Disable explicitly:

```ts
useForm({ schema, history: false })
```

When omitted, `history` defaults to `false` — the namespace is still present on the form return so templates don't need conditional logic, but every method is a no-op and the flags read `false` / `0`.

## The namespace

All undo/redo surface lives under `form.history`:

| Member    | Type            | What it does                                                        |
| --------- | --------------- | ------------------------------------------------------------------- |
| `undo()`  | `() => boolean` | Step back to the previous state. `false` at baseline.               |
| `redo()`  | `() => boolean` | Replay the next state after an undo. `false` when nothing's queued. |
| `clear()` | `() => void`    | Wipe the chain; reseed at the current state as the new baseline.    |
| `canUndo` | `boolean`       | Gate an "Undo" button reactively.                                   |
| `canRedo` | `boolean`       | Gate a "Redo" button reactively.                                    |
| `size`    | `number`        | Reachable positions across the chain — useful for debug overlays.   |

## What gets captured

Every form value mutation: `setValue`, `register`-backed input edits, any array helper (`append`, `prepend`, `insert`, `remove`, `swap`, `move`, `replace`), or a programmatic write. Each recorded position carries:

- The form value.
- The error map at the time of the captured position.
- The `blankPaths` set (so cleared-but-defaulted numeric fields keep showing as empty after an undo, instead of resurrecting their slim default).

What's NOT captured:

- **Field interaction state** — `touched` / `focused` / `blurred` / `connected`. UI interaction history; it shouldn't rewind. A field that was touched stays touched.
- **Submission lifecycle** — `meta.submitCount`, `meta.submitError`.
- **Validation in-flight state**.

Calling `setFieldErrors` / `addFieldErrors` / `clearFieldErrors` does NOT record a position — those only touch the error map. Whatever errors are live when the next mutation lands go into that mutation's delta.

## Keyboard shortcuts

Not wired by default — wire them in a few lines:

```vue
<script setup lang="ts">
  function onKeydown(event: KeyboardEvent) {
    if ((event.metaKey || event.ctrlKey) && event.key === 'z') {
      event.preventDefault()
      event.shiftKey ? form.history.redo() : form.history.undo()
    }
  }
</script>

<template>
  <form @keydown="onKeydown">
    <!-- … -->
  </form>
</template>
```

Attaform stays out of the global keydown business so you can layer shortcuts at the right scope (per-form, per-route, global), with the modifier convention that fits your platform.

## `clear()` at a milestone

After a "save successful" moment — or any point where consumers should lose access to the prior chain without disturbing the rendered form — call `clear()`. The form value, errors, and blank-paths stay exactly where they are; only the past and future history reset.

```ts
async function onSaveSuccess() {
  await api.commit(form.values())
  form.history.clear()
}
```

After `clear()`: `canUndo === false`, `canRedo === false`, `size === 1`. The current position is still reachable — there's just nothing on either side of it.

## Interactions

- **`reset()`** is itself a mutation — the pre-reset state stays one undo away. Consumers who want a hard wipe call `form.history.clear()` after `reset()`, or pop a confirmation dialog before calling `reset()`.
- **Live field validation** still runs on undo / redo — the restored state validates like any other.
- **Persistence** picks up each undo / redo as a normal mutation and writes the restored state to the configured backend.
- **Persistence hydration** is the floor: once the hydrated value applies, the chain reseeds and `undo()` can't reach back into the transient pre-hydration default.

## Memory

The default `max: 128` keeps at most 128 reachable positions across the undo + redo halves combined. Bump it for editors with long histories; drop it for memory-constrained targets. Internally history stores one base snapshot plus a chain of forward deltas (per-mutation `Patch[]` from the diff machinery), so each additional position costs `O(changed-leaf-count)` — typing one character into one field allocates a single patch, not a clone of the whole form.

## Where to next

- [Multi-tab sync](/docs/cross-cutting-state/multi-tab-sync) — values converge across tabs; the history chain stays tab-local (each tab walks its own user's intent).
- [`reset` & `resetField`](/docs/writing-and-mutating/reset) — recorded as positions; the pre-reset state stays one undo away.
- [Persistence overview](/docs/persistence/overview) — picks up undo / redo as normal mutations.
