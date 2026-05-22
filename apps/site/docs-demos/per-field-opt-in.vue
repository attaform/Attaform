<script setup lang="ts">
  import { ref } from 'vue'
  import { useForm } from 'attaform/zod'
  import { z } from 'zod'

  const persistTitle = ref(true)
  const persistBody = ref(true)

  const form = useForm({
    schema: z.object({
      title: z.string(),
      body: z.string(),
    }),
    key: 'docs-demo-per-field-opt-in',
    persist: 'session',
  })

  async function clearAll() {
    await form.clearPersistedDraft()
    form.reset()
  }
</script>

<template>
  <form @submit.prevent>
    <label class="row">
      <span class="row-label">
        Title
        <small> <input v-model="persistTitle" type="checkbox" /> Persist this field </small>
      </span>
      <input v-register="form.register('title', { persist: persistTitle })" />
    </label>

    <label class="row">
      <span class="row-label">
        Body
        <small> <input v-model="persistBody" type="checkbox" /> Persist this field </small>
      </span>
      <textarea v-register="form.register('body', { persist: persistBody })" rows="3"></textarea>
    </label>

    <p class="hint">
      Toggle either checkbox, type something, and refresh the page. Only opted-in fields rehydrate;
      the others land empty.
    </p>

    <button type="button" class="clear" @click="clearAll">Clear persisted draft</button>
  </form>
</template>

<style scoped>
  form {
    display: flex;
    flex-direction: column;
    gap: 0.875rem;
    max-width: 30rem;
  }
  .row {
    display: flex;
    flex-direction: column;
    gap: 0.25rem;
    font-size: 0.875rem;
    font-weight: 500;
  }
  .row-label {
    display: flex;
    justify-content: space-between;
    align-items: center;
    gap: 0.5rem;
  }
  small {
    font-weight: 400;
    color: #6b7280;
    font-size: 0.75rem;
    display: inline-flex;
    align-items: center;
    gap: 0.25rem;
  }
  input[type='text'],
  textarea {
    padding: 0.5rem 0.75rem;
    border-radius: 0.375rem;
    border: 1px solid #d1d5db;
    font-size: 0.875rem;
    font-family: inherit;
  }
  input[type='text']:focus,
  textarea:focus {
    outline: 2px solid #2563eb;
    outline-offset: -1px;
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
