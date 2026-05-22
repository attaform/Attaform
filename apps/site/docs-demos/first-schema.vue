<script setup lang="ts">
  import { useForm } from 'attaform/zod'
  import { z } from 'zod'

  const form = useForm({
    schema: z.object({
      email: z.email('Enter a valid email'),
      password: z.string().min(8, 'At least 8 characters'),
      displayName: z.string().min(2, 'At least 2 characters').optional(),
      age: z.number().int().min(13, 'You must be 13 or older'),
    }),
    key: 'first-schema',
  })
</script>

<template>
  <form @submit.prevent>
    <label>
      Email
      <input v-register="form.register('email')" autocomplete="email" />
      <em v-if="form.fields.email.showErrors">{{ form.fields.email.firstError?.message }}</em>
    </label>
    <label>
      Password
      <input v-register="form.register('password')" type="password" autocomplete="off" />
      <em v-if="form.fields.password.showErrors">{{ form.fields.password.firstError?.message }}</em>
    </label>
    <label>
      Display name <span class="hint">(optional)</span>
      <input v-register="form.register('displayName')" />
      <em v-if="form.fields.displayName.showErrors">{{
        form.fields.displayName.firstError?.message
      }}</em>
    </label>
    <label>
      Age
      <input v-register="form.register('age')" type="number" />
      <em v-if="form.fields.age.showErrors">{{ form.fields.age.firstError?.message }}</em>
    </label>
    <pre class="form.values">{{
      JSON.stringify(form.values, (_, v) => (v === undefined ? '(undefined)' : v), 2)
    }}</pre>
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
  .hint {
    font-weight: 400;
    color: #6b7280;
    font-size: 0.75rem;
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
  em {
    color: #dc2626;
    font-size: 0.8125rem;
    font-style: normal;
    font-weight: 400;
  }
  .form.values {
    margin-top: 0.5rem;
    padding: 0.75rem;
    background: #f3f4f6;
    border-radius: 0.375rem;
    font-size: 0.75rem;
    font-family: ui-monospace, monospace;
    color: #374151;
    white-space: pre-wrap;
    word-break: break-all;
  }
</style>
