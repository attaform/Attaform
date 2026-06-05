<script setup lang="ts">
  import { useForm } from 'attaform/zod'
  import { z } from 'zod'
  import { ref } from 'vue'

  const form = useForm({
    schema: z.object({
      email: z.email('Enter a valid email'),
      age: z.number().int().min(18, 'Must be 18 or older'),
    }),
    defaultValues: { age: 0 },
    key: 'docs-demo-validation-lifecycle',
  })

  const lastResult = ref<string>('—')

  function runValidate() {
    const status = form.validate()
    const s = status.value
    lastResult.value = s.pending
      ? 'form.validate() → pending'
      : `form.validate() → ${s.success ? '✓ valid' : '✗ invalid'}`
  }

  async function runValidateAsync() {
    lastResult.value = 'form.validateAsync() → awaiting…'
    const res = await form.validateAsync()
    lastResult.value = `form.validateAsync() → ${res.success ? '✓ valid' : '✗ invalid'}`
  }

  async function runParse() {
    lastResult.value = 'form.parse() → awaiting…'
    const res = await form.parse()
    lastResult.value = res.success
      ? `form.parse() → ✓ parsed: ${JSON.stringify(res.data, (_, v) => (v === undefined ? '(undefined)' : v))}`
      : `form.parse() → ✗ invalid`
  }
</script>

<template>
  <form @submit.prevent>
    <label>
      <span>Email</span>
      <input v-register="form.register('email')" />
      <em v-if="form.fields.email.showErrors">{{ form.fields.email.firstError?.message }}</em>
    </label>

    <label>
      <span>Age</span>
      <input v-register="form.register('age')" type="number" />
      <em v-if="form.fields.age.showErrors">{{ form.fields.age.firstError?.message }}</em>
    </label>

    <div class="actions">
      <button type="button" @click="runValidate">form.validate() — sync</button>
      <button type="button" @click="runValidateAsync">form.validateAsync() — awaited</button>
      <button type="button" @click="runParse">form.parse() — parsed payload</button>
    </div>

    <p class="result">{{ lastResult }}</p>
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
  em {
    color: #dc2626;
    font-size: 0.8125rem;
    font-style: normal;
    font-weight: 400;
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
  .result {
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
