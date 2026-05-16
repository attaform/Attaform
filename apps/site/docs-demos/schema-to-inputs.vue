<script setup lang="ts">
  import { useForm } from 'attaform/zod'
  import { z } from 'zod'

  const COUNTRIES = ['US', 'CA', 'MX', 'GB', 'DE', 'FR', 'JP'] as const

  const { register, fields, values } = useForm({
    schema: z.object({
      fullName: z.string().min(2, 'Tell us your name'),
      age: z.number().int().min(13, '13 or older to sign up'),
      country: z.enum(COUNTRIES),
      newsletter: z.boolean(),
      bio: z.string().optional(),
    }),
    key: 'schema-to-inputs',
  })
</script>

<template>
  <form @submit.prevent>
    <label>
      Full name
      <input v-register="register('fullName')" autocomplete="name" />
      <em v-if="fields.fullName.showErrors">{{ fields.fullName.firstError?.message }}</em>
    </label>
    <label>
      Age
      <input v-register="register('age')" type="number" />
      <em v-if="fields.age.showErrors">{{ fields.age.firstError?.message }}</em>
    </label>
    <label>
      Country
      <select v-register="register('country')">
        <option value="" disabled>Choose…</option>
        <option v-for="code in COUNTRIES" :key="code" :value="code">{{ code }}</option>
      </select>
      <em v-if="fields.country.showErrors">{{ fields.country.firstError?.message }}</em>
    </label>
    <label class="checkbox">
      <input v-register="register('newsletter')" type="checkbox" />
      Send me the monthly newsletter
    </label>
    <label>
      Bio <span class="hint">(optional)</span>
      <textarea v-register="register('bio')" rows="3"></textarea>
    </label>
    <pre class="values">{{ JSON.stringify(values, null, 2) }}</pre>
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
  .hint {
    font-weight: 400;
    color: #6b7280;
    font-size: 0.75rem;
  }
  input,
  select,
  textarea {
    padding: 0.5rem 0.75rem;
    border-radius: 0.375rem;
    border: 1px solid #d1d5db;
    font-size: 0.875rem;
    font-family: inherit;
  }
  label.checkbox input {
    padding: 0;
    width: auto;
  }
  input:focus,
  select:focus,
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
  .values {
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
