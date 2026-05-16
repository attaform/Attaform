<script setup lang="ts">
  // Phase 1 demo for "From inputs to submit". Closes the loop —
  // schema + register binding + handleSubmit with an awaited
  // simulated API call so the reader sees meta.submitting flip true
  // for ~1.2 seconds and the button disable + relabel itself.
  import { ref } from 'vue'
  import { useForm } from 'attaform/zod'
  import { z } from 'zod'

  const status = ref<'idle' | 'success'>('idle')

  const { register, handleSubmit, errors, meta } = useForm({
    schema: z.object({
      email: z.string().email('Enter a valid email'),
      newsletter: z.boolean(),
    }),
    key: 'inputs-to-submit',
  })

  const onSubmit = handleSubmit(async (values) => {
    status.value = 'idle'
    // Simulated API roundtrip — long enough that the button
    // visibly disables and relabels.
    await new Promise((resolve) => setTimeout(resolve, 1200))
    status.value = 'success'
    // eslint-disable-next-line no-console
    console.log('Subscribed', values)
  })
</script>

<template>
  <form @submit.prevent="onSubmit">
    <label>
      Email
      <input v-register="register('email')" type="email" autocomplete="email" />
      <em v-if="errors.email">{{ errors.email }}</em>
    </label>
    <label class="checkbox">
      <input v-register="register('newsletter')" type="checkbox" />
      Send me the monthly newsletter
    </label>
    <button :disabled="meta.submitting" type="submit">
      {{ meta.submitting ? 'Subscribing…' : 'Subscribe' }}
    </button>
    <p v-if="status === 'success'" class="success">✓ Subscribed — check your inbox.</p>
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
  .success {
    margin: 0;
    color: #047857;
    font-size: 0.8125rem;
    font-weight: 500;
  }
</style>
