# Saving as the user goes

A surface that persists each decision as it is made, instead of on a submit, is a supported shape. It needs no scaffolding around `v-register` and no redesign toward a batch Save button. Two shapes fit it, and the one to reach for follows what the reaction belongs to.

- The reaction belongs to the **interaction** (one pick is one whole decision: a `<select>`, a checkbox, a radio, a star rating) → a plain listener beside `v-register`.
- The reaction belongs to the **value** (typing, or anything that must also catch a programmatic write) → `watch(form.toRef(path), ...)`.

The deciding fact when a form both saves per change and hydrates itself from a saved record: a DOM listener never sees `form.setValue` or `form.reset()`, because neither fires a DOM event. Only the watch does.

## The listener shape

```vue
<script setup lang="ts">
  import { z } from 'zod'
  import { useForm } from 'attaform'

  const schema = z.object({ choice: z.string() })
  const form = useForm({ schema })

  async function save() {
    // Already the newly picked value: the directive wrote it first.
    await fetch('/api/choice', {
      method: 'PATCH',
      body: JSON.stringify({ value: form.values.choice }),
    })
  }
</script>

<template>
  <select v-register="form.register('choice')" @change="save">
    <option value="yes">Yes</option>
    <option value="no">No</option>
  </select>
</template>
```

`v-register` attaches its own listener in Vue's `created` hook, which runs before Vue applies the handlers you wrote. The directive's listener is therefore registered first, fires first, and has written the field by the time yours is called, so the handler reads committed state rather than the previous value. That ordering is a pinned contract, not an accident of timing, and it holds for `@change`, `@input`, a `v-register.lazy` control, a checkbox, and a radio.

An observing handler is **not** a second writer. Nothing is stacked, and neither the compile-time nor the runtime redundant-binding guard flags it. What stays forbidden is a second _writer_: a `v-model`, a handler that writes the field back, a reset-signal prop.

## The watch shape

```ts
import { watch } from 'vue'
import { z } from 'zod'
import { useForm } from 'attaform'

const schema = z.object({ bio: z.string() })
const form = useForm({ schema })

async function save(value: string): Promise<void> {
  await fetch('/api/bio', { method: 'PATCH', body: JSON.stringify({ value }) })
}

// `form.toRef(path)` is a read-only ref over that path's value, so this
// fires on every committed change, including `setValue` and `reset`.
watch(form.toRef('bio'), (value) => {
  void save(value)
})
```

Registered inside `setup`, so the watchers stop on unmount with no manual teardown. Writing the same value back is a no-op in Attaform, so a watcher never fires for a write that changed nothing. For a whole container path, add `{ deep: true }`: an in-place leaf edit keeps the container's reference stable.

## What a real one adds

The full recipe at https://attaform.dev/docs/cross-cutting-state/autosave is copy-paste and carries the parts a production autosave needs. Reproduce these rather than shipping the bare watch above:

- **Debounce per path**, because typing is continuous and a keystroke is not a decision. For a per-interaction surface the wait is pointless: keep the recipe and pass `{ debounceMs: 0 }`.
- **A validity gate.** Run `form.parse(path, { commit: true })` and skip the write when it fails, so an invalid value never reaches the server and async refinements run as part of the same check. Turn it off per path for a true draft save.
- **Abort on supersede.** One `AbortController` per path, handed to `fetch` as its `signal`, so a slow request cancels when a newer edit lands and the latest write wins.
- **A pause for your own writes.** This is the one that bites. A watch reacts to every change including yours, so hydrating ten fields from a saved record echoes ten saves straight back at the server you just loaded from. Wrap a hydrating `setValue` or `reset` so the watchers skip it. The pause belongs to your composable, never to the form.

## Do not trade away the rendering to get the saving

Both shapes leave `v-register` in place, so the control keeps its binding, its ARIA, and its SSR value injection. That last one is worth naming, because a row of server-rendered `<select>` elements is where it shows: a selection is a DOM property rather than markup, so the server can only express it as `selected` on the right `<option>`, and hand-binding that per call site is a step every new row can forget. `v-register` emits it for every option it owns.

Saving per decision never costs you that. Guidance that implies otherwise, and sends an author to a batch submit to keep their server-rendered state correct, is wrong.
