<script setup lang="ts">
  import { useForm } from 'attaform'
  import { z } from 'zod'
  import './styles.css'

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
  <form class="demo" @submit.prevent @keydown="onKeydown">
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
      <div v-for="(_, i) in form.values.tags" :key="i" class="row">
        <input v-register="form.register(`tags.${i}`)" />
        <button type="button" class="ghost" @click="form.remove('tags', i)">−</button>
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
      the keyboard shortcut. <code>clear()</code> reseeds the chain at the current state, useful
      after a "Save" milestone.
    </p>
  </form>
</template>

<style scoped>
  .row input {
    flex: 1;
  }
  .history-bar {
    display: flex;
    align-items: center;
    gap: 0.5rem;
    padding: 0.5rem 0.75rem;
    border: 1px solid var(--color-border);
    border-radius: 0.5rem;
    background: var(--color-surface);
  }
  .history-bar button {
    align-self: auto;
    margin-top: 0;
    padding: 0.375rem 0.75rem;
    font-size: 0.8125rem;
  }
  .size {
    margin-left: auto;
    font-family: ui-monospace, monospace;
    font-size: 0.75rem;
    color: var(--color-fg-muted);
  }
  kbd {
    padding: 0.05rem 0.3rem;
    border-radius: 0.25rem;
    background: var(--color-surface-2);
    font-family: ui-monospace, monospace;
    font-size: 0.9em;
  }
</style>
