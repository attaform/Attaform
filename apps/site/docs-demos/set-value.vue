<script setup lang="ts">
  import { useForm } from 'attaform/zod'
  import { z } from 'zod'

  const form = useForm({
    schema: z.object({
      name: z.string(),
      profile: z.object({
        email: z.email(),
        age: z.number(),
      }),
    }),
    defaultValues: { name: '', profile: { email: '', age: 0 } },
    key: 'docs-demo-set-value',
  })
</script>

<template>
  <form @submit.prevent>
    <label>
      <span>Name</span>
      <input v-register="form.register('name')" />
    </label>

    <label>
      <span>Email</span>
      <input v-register="form.register('profile.email')" />
    </label>

    <label>
      <span>Age</span>
      <input v-register="form.register('profile.age')" type="number" />
    </label>

    <div class="actions">
      <button type="button" @click="form.setValue('name', 'Athlete of the Year')">
        form.setValue('name', '…')
      </button>
      <button type="button" @click="form.setValue(['profile', 'email'], 'champ@attaform.dev')">
        form.setValue(['profile', 'email'], …)
      </button>
      <button type="button" @click="form.setValue('profile.age', (prev) => (prev ?? 0) + 1)">
        form.setValue('profile.age', callback)
      </button>
      <button
        type="button"
        @click="
          form.setValue({
            name: 'Pace of Champions',
            profile: { email: 'reset@attaform.dev', age: 25 },
          })
        "
      >
        form.setValue(wholeForm)
      </button>
    </div>

    <pre>{{ JSON.stringify(form.values, (_, v) => (v === undefined ? '(undefined)' : v), 2) }}</pre>
  </form>
</template>

<style scoped>
  form {
    display: flex;
    flex-direction: column;
    gap: 0.875rem;
    max-width: 30rem;
  }
  label {
    display: flex;
    flex-direction: column;
    gap: 0.25rem;
    font-size: 0.875rem;
    font-weight: 500;
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
  .actions {
    display: flex;
    flex-wrap: wrap;
    gap: 0.4rem;
  }
  .actions button {
    padding: 0.35rem 0.7rem;
    border-radius: 0.375rem;
    border: 1px solid #d1d5db;
    background: #fff;
    font-size: 0.75rem;
    font-family: ui-monospace, monospace;
    cursor: pointer;
  }
  .actions button:hover {
    background: #f3f4f6;
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
