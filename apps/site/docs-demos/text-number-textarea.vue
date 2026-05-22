<script setup lang="ts">
  import { useForm } from 'attaform/zod'
  import { z } from 'zod'

  const form = useForm({
    schema: z.object({
      name: z.string(),
      age: z.number(),
      bio: z.string(),
    }),
    key: 'docs-demo-text-number-textarea',
  })
</script>

<template>
  <form @submit.prevent>
    <label>
      <span>Name</span>
      <input v-register="form.register('name')" type="text" />
    </label>

    <label>
      <span>Age</span>
      <input v-register="form.register('age')" type="number" min="0" />
    </label>

    <label>
      <span>Bio</span>
      <textarea v-register="form.register('bio')" rows="3" />
    </label>

    <pre>{{
      JSON.stringify(
        { name: form.values.name, age: form.values.age, bio: form.values.bio },
        (_, v) => (v === undefined ? '(undefined)' : typeof v === 'number' ? `${v} (number)` : v),
        2
      )
    }}</pre>
  </form>
</template>

<style scoped>
  form {
    display: flex;
    flex-direction: column;
    gap: 0.875rem;
    max-width: 26rem;
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
  pre {
    background: #f9fafb;
    border: 1px solid #e5e7eb;
    border-radius: 0.375rem;
    padding: 0.5rem 0.75rem;
    font-size: 0.75rem;
    font-family: ui-monospace, monospace;
    color: #111827;
    margin: 0;
  }
</style>
