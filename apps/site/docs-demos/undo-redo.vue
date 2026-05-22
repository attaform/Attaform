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
      <input v-register="form.register('title')" type="text" />
    </label>
    <label>
      Body
      <textarea v-register="form.register('body')" rows="2"></textarea>
    </label>
    <fieldset>
      <legend>Tags</legend>
      <div v-for="(_, i) in form.values.tags" :key="i" class="tag-row">
        <input v-register="form.register(`tags.${i}`)" type="text" />
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

<style scoped>
  form {
    display: flex;
    flex-direction: column;
    gap: 0.875rem;
    max-width: 32rem;
  }
  label {
    display: flex;
    flex-direction: column;
    gap: 0.25rem;
    font-size: 0.875rem;
    font-weight: 500;
  }
  fieldset {
    border: 1px solid #e5e7eb;
    border-radius: 0.5rem;
    padding: 0.5rem 0.875rem;
    margin: 0;
    display: flex;
    flex-direction: column;
    gap: 0.5rem;
  }
  legend {
    padding: 0 0.375rem;
    font-size: 0.8125rem;
    color: #6b7280;
  }
  .tag-row {
    display: flex;
    gap: 0.375rem;
  }
  .tag-row input {
    flex: 1;
  }
  input,
  textarea {
    padding: 0.5rem 0.75rem;
    border-radius: 0.375rem;
    border: 1px solid #d1d5db;
    font-size: 0.875rem;
    font-family: inherit;
  }
  input:focus,
  textarea:focus {
    outline: 2px solid #2563eb;
    outline-offset: -1px;
  }
  .history-bar {
    display: flex;
    align-items: center;
    gap: 0.5rem;
    padding: 0.5rem 0.75rem;
    background: #f9fafb;
    border: 1px solid #e5e7eb;
    border-radius: 0.5rem;
  }
  .size {
    margin-left: auto;
    font-family: ui-monospace, monospace;
    font-size: 0.75rem;
    color: #6b7280;
  }
  button {
    font-family: inherit;
    cursor: pointer;
  }
  button.primary {
    padding: 0.375rem 0.75rem;
    border-radius: 0.375rem;
    border: 1px solid #2563eb;
    background: #2563eb;
    color: white;
    font-size: 0.8125rem;
    font-weight: 500;
  }
  button.primary:disabled {
    opacity: 0.4;
    cursor: not-allowed;
  }
  button.ghost {
    padding: 0.375rem 0.75rem;
    border-radius: 0.375rem;
    border: 1px solid #d1d5db;
    background: white;
    color: #374151;
    font-size: 0.8125rem;
  }
  button.ghost:hover {
    background: #f3f4f6;
  }
  .tag-row button {
    padding: 0.375rem 0.625rem;
    border: 1px solid #d1d5db;
    border-radius: 0.375rem;
    background: white;
  }
  code,
  kbd {
    font-family: ui-monospace, monospace;
    background: #f3f4f6;
    padding: 0.05rem 0.3rem;
    border-radius: 0.25rem;
  }
  .hint {
    margin: 0;
    color: #6b7280;
    font-size: 0.75rem;
  }
</style>
