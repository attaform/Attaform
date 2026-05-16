<script setup lang="ts">
  import { useForm } from 'attaform/zod'
  import { z } from 'zod'

  const form = useForm({
    schema: z.object({
      score: z.number().min(0).max(100),
      tags: z.array(z.string()),
    }),
    defaultValues: { tags: [] },
    key: 'docs-demo-persistence-edge-cases',
    persist: { storage: 'session', clearOnSubmitSuccess: false },
  })

  const onSubmit = form.handleSubmit(async (values) => {
    await new Promise((r) => setTimeout(r, 300))
    alert(`Submitted ${JSON.stringify(values)} — draft kept (clearOnSubmitSuccess: false).`)
  })

  function addTag() {
    form.append('tags', 'new')
  }
</script>

<template>
  <form @submit.prevent="onSubmit">
    <label>
      Score (typed as <code>number</code> — round-trips cleanly through any backend)
      <input v-register="form.register('score', { persist: true })" type="number" />
    </label>

    <fieldset>
      <legend>Tags (array — append, watch the persisted shape grow)</legend>
      <div v-for="(_, i) in form.values.tags" :key="i" class="tag-row">
        <input v-register="form.register(`tags.${i}`, { persist: true })" />
        <button type="button" @click="form.remove('tags', i)">−</button>
      </div>
      <button type="button" class="add" @click="addTag">Add tag</button>
    </fieldset>

    <p class="hint">
      <code>clearOnSubmitSuccess: false</code> keeps the draft after a successful submit — useful
      for wizards with review pages or retry-prone APIs. Refresh the page after editing; the draft
      hydrates before the first render.
    </p>

    <button type="submit" :disabled="form.meta.submitting">
      {{ form.meta.submitting ? 'Submitting…' : 'Submit (draft survives)' }}
    </button>
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
  .tag-row button {
    padding: 0.375rem 0.625rem;
    background: white;
    color: #374151;
    border: 1px solid #d1d5db;
    border-radius: 0.375rem;
    font-size: 0.8125rem;
    cursor: pointer;
  }
  button.add {
    align-self: flex-start;
    padding: 0.375rem 0.75rem;
    background: white;
    color: #374151;
    border: 1px solid #d1d5db;
    border-radius: 0.375rem;
    font-size: 0.8125rem;
    cursor: pointer;
  }
  input,
  button {
    font-family: inherit;
  }
  input {
    padding: 0.5rem 0.75rem;
    border-radius: 0.375rem;
    border: 1px solid #d1d5db;
    font-size: 0.875rem;
  }
  input:focus {
    outline: 2px solid #2563eb;
    outline-offset: -1px;
  }
  code {
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
  button[type='submit'] {
    align-self: flex-start;
    padding: 0.5rem 1rem;
    border-radius: 0.375rem;
    border: 1px solid #2563eb;
    background: #2563eb;
    color: #fff;
    font-size: 0.875rem;
    font-weight: 500;
    cursor: pointer;
  }
  button[type='submit']:hover:not(:disabled) {
    background: #1d4ed8;
  }
  button[type='submit']:disabled {
    opacity: 0.6;
    cursor: not-allowed;
  }
</style>
