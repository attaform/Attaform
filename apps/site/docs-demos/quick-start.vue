<script setup lang="ts">
  // Phase 1 spine demo. The reader's first encounter with Attaform —
  // wired as plain as possible: one schema, two fields, a submit
  // handler, and `v-register` doing the binding work in the template.
  // No app-internal imports (plan §3 authoring rule), no styling
  // dependencies beyond a scoped <style> block.
  import { useForm } from 'attaform/zod'
  import { z } from 'zod'

  const { register, handleSubmit, errors, meta } = useForm({
    schema: z.object({
      email: z.string().email('Enter a valid email'),
      password: z.string().min(8, 'At least 8 characters'),
    }),
    key: 'quick-start',
  })

  const onSubmit = handleSubmit(async (values) => {
    // In a real app this is an API call. For the demo, just log it.
    // eslint-disable-next-line no-console
    console.log('Submit', values)
  })
</script>

<template>
  <form @submit.prevent="onSubmit">
    <label>
      Email
      <input v-register="register('email')" type="email" autocomplete="email" />
      <em v-if="errors.email">{{ errors.email }}</em>
    </label>
    <label>
      Password
      <input v-register="register('password')" type="password" autocomplete="current-password" />
      <em v-if="errors.password">{{ errors.password }}</em>
    </label>
    <button :disabled="meta.submitting" type="submit">
      {{ meta.submitting ? 'Signing in…' : 'Sign in' }}
    </button>
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
  button {
    margin-top: 0.5rem;
    padding: 0.625rem 1rem;
    background: #2563eb;
    color: white;
    border: none;
    border-radius: 0.375rem;
    font-size: 0.875rem;
    font-weight: 600;
    cursor: pointer;
  }
  button:disabled {
    opacity: 0.5;
    cursor: not-allowed;
  }
</style>
