<script setup lang="ts">
  // Phase 1 demo for `handleSubmit`. The terms checkbox uses
  // `z.literal(true)` so unchecking it makes the schema parse fail
  // — readers see onError fire (alert), focus pull to the invalid
  // field, and the success path alert when the form clears.
  import { useForm } from 'attaform/zod'
  import { z } from 'zod'

  const { register, handleSubmit, fields, meta } = useForm({
    schema: z.object({
      email: z.email('Enter a valid email'),
      terms: z.literal(true, { message: 'Accept the terms to continue' }),
    }),
    key: 'handle-submit',
  })

  const onSubmit = handleSubmit(
    async (values) => {
      await new Promise((resolve) => setTimeout(resolve, 600))
      alert(`✓ Submitted!\n\nemail: ${values.email}`)
    },
    () => {
      alert('✗ Submit blocked — check the errors above.')
    }
  )
</script>

<template>
  <form @submit.prevent="onSubmit">
    <label>
      Email
      <input v-register="register('email')" type="email" autocomplete="email" />
      <em v-if="fields.email.showErrors">{{ fields.email.firstError?.message }}</em>
    </label>
    <label class="checkbox">
      <input v-register="register('terms')" type="checkbox" />
      I accept the terms of service
      <em v-if="fields.terms.showErrors">{{ fields.terms.firstError?.message }}</em>
    </label>
    <button :disabled="meta.submitting" type="submit">
      {{ meta.submitting ? 'Submitting…' : 'Submit' }}
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
  label.checkbox {
    flex-direction: row;
    align-items: center;
    gap: 0.5rem;
    flex-wrap: wrap;
  }
  input {
    padding: 0.5rem 0.75rem;
    border-radius: 0.375rem;
    border: 1px solid #d1d5db;
    font-size: 0.875rem;
  }
  label.checkbox input {
    padding: 0;
    width: auto;
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
    margin-top: 0.25rem;
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
    opacity: 0.6;
    cursor: not-allowed;
  }
</style>
