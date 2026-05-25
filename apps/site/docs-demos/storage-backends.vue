<script setup lang="ts">
  import { useForm } from 'attaform/zod'
  import { z } from 'zod'

  const form = useForm({
    schema: z.object({
      note: z.string(),
      score: z.number(),
      due: z.date().nullable(),
    }),
    defaultValues: { due: null },
    key: 'docs-demo-storage-backends',
    persist: 'indexeddb',
  })

  async function clearAll() {
    await form.clearPersistedDraft()
    form.reset()
  }
</script>

<template>
  <form @submit.prevent>
    <label>
      Note
      <textarea
        v-register="form.register('note', { persist: true })"
        rows="2"
        placeholder="Plain string — survives JSON."
      ></textarea>
    </label>

    <label>
      Score
      <input
        v-register="form.register('score', { persist: true })"
        type="number"
        placeholder="Number — fine on every backend."
      />
    </label>

    <label>
      Due date
      <input v-register="form.register('due', { persist: true })" type="date" />
      <small>
        Stored as <code>Date</code> in form values; round-trips verbatim through
        <code>'indexeddb'</code> via structured clone. <code>'local'</code> /
        <code>'session'</code> would serialize through <code>JSON.stringify</code> and lose the
        <code>Date</code> prototype.
      </small>
    </label>

    <p class="hint">
      This form persists to <code>'indexeddb'</code> — type, refresh, and your draft (including the
      live <code>Date</code> instance) hydrates back. Switching to <code>'local'</code> or
      <code>'session'</code> is a one-word change in <code>persist</code>; the bundle pulls in only
      the backend you pick.
    </p>

    <button type="button" class="clear" @click="clearAll">Clear persisted draft</button>
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
  small {
    font-weight: 400;
    color: #6b7280;
    font-size: 0.75rem;
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
  button.clear {
    align-self: flex-start;
    padding: 0.375rem 0.75rem;
    background: white;
    color: #374151;
    border: 1px solid #d1d5db;
    border-radius: 0.375rem;
    font-size: 0.8125rem;
    font-weight: 500;
    cursor: pointer;
  }
  button.clear:hover {
    background: #f9fafb;
  }
</style>
