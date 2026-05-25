<script setup lang="ts">
  // Phase 1 demo for "Persistence overview". The form persists to
  // sessionStorage; both fields opt in at their register() call
  // sites. Refresh the docs page after typing and the values
  // rehydrate before the first render — no flash, no manual wiring.
  import { useForm } from 'attaform/zod'
  import { z } from 'zod'

  const form = useForm({
    schema: z.object({
      title: z.string().min(2, 'Tell us the title'),
      body: z.string().min(10, 'A few words please'),
    }),
    key: 'persistence-overview-demo',
    persist: 'session',
  })

  async function clear() {
    await form.clearPersistedDraft()
    form.reset()
  }
</script>

<template>
  <form @submit.prevent>
    <label>
      Title
      <input v-register="form.register('title', { persist: true })" />
      <em v-if="form.fields.title.showErrors">{{ form.fields.title.firstError?.message }}</em>
    </label>
    <label>
      Body
      <textarea v-register="form.register('body', { persist: true })" rows="3"></textarea>
      <em v-if="form.fields.body.showErrors">{{ form.fields.body.firstError?.message }}</em>
    </label>
    <p class="hint">Type a draft, refresh the page — your values come back.</p>
    <button type="button" class="clear" @click="clear">Clear persisted draft</button>
  </form>
</template>

<style scoped>
  form {
    display: flex;
    flex-direction: column;
    gap: 0.875rem;
    max-width: 24rem;
  }
  label {
    display: flex;
    flex-direction: column;
    gap: 0.25rem;
    font-size: 0.875rem;
    font-weight: 500;
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
  em {
    color: #dc2626;
    font-size: 0.8125rem;
    font-style: normal;
    font-weight: 400;
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
