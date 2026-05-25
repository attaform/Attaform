<script setup lang="ts">
  import { useForm } from 'attaform/zod'
  import { z } from 'zod'

  const form = useForm({
    schema: z.object({
      title: z.string(),
      body: z.string(),
      tags: z.array(z.string()),
    }),
    defaultValues: { title: '', body: '', tags: [] },
    key: 'docs-demo-undo-redo',
    history: { max: 64 },
  })

  function addTag() {
    form.append('tags', `tag-${form.values.tags.length + 1}`)
  }

  function onKeydown(event: KeyboardEvent) {
    if ((event.metaKey || event.ctrlKey) && event.key === 'z') {
      event.preventDefault()
      if (event.shiftKey) form.history.redo()
      else form.history.undo()
    }
  }
</script>

<template>
  <form @submit.prevent @keydown="onKeydown">
    <label>
      Title
      <input v-register="form.register('title')" />
    </label>
    <label>
      Body
      <textarea v-register="form.register('body')" rows="2"></textarea>
    </label>
    <fieldset>
      <legend>Tags</legend>
      <div v-for="(_, i) in form.values.tags" :key="i" class="tag-row">
        <input v-register="form.register(`tags.${i}`)" />
        <button type="button" @click="form.remove('tags', i)">−</button>
      </div>
      <button type="button" class="ghost" @click="addTag">Add tag</button>
    </fieldset>

    <div class="history-bar">
      <button
        type="button"
        class="primary"
        :disabled="!form.history.canUndo"
        @click="form.history.undo"
      >
        ↶ Undo
      </button>
      <button
        type="button"
        class="primary"
        :disabled="!form.history.canRedo"
        @click="form.history.redo"
      >
        Redo ↷
      </button>
      <button type="button" class="ghost" @click="form.history.clear">Clear history</button>
      <span class="size">size: {{ form.history.size }}</span>
    </div>

    <p class="hint">
      Every keystroke, append, and remove records a position. Try <kbd>⌘Z</kbd> / <kbd>⌘⇧Z</kbd> for
      the keyboard shortcut. <code>clear()</code> reseeds the chain at the current state — useful
      after a "Save" milestone.
    </p>
  </form>
</template>
