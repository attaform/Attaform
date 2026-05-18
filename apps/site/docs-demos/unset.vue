<script setup lang="ts">
  import { useForm, unset, isUnset } from 'attaform/zod'
  import { z } from 'zod'

  const form = useForm({
    schema: z.object({
      name: z.string(),
      middleName: z.string().optional(),
    }),
    defaultValues: { name: '', middleName: '' },
    key: 'docs-demo-unset',
  })
</script>

<template>
  <form @submit.prevent>
    <label>
      <span>Name (required)</span>
      <input v-register="form.register('name')" />
    </label>

    <label>
      <span>Middle name (optional)</span>
      <input v-register="form.register('middleName')" />
    </label>

    <div class="actions">
      <button type="button" @click="form.setValue('middleName', '')"
        >form.setValue('middleName', '')</button
      >
      <button type="button" @click="form.setValue('middleName', unset)">
        form.setValue('middleName', unset)
      </button>
    </div>

    <div class="panel">
      <p>
        <code>form.values.middleName</code> =
        <em>{{
          isUnset(form.values.middleName) ? 'unset' : JSON.stringify(form.values.middleName)
        }}</em>
      </p>
      <p><code>isUnset(form.values.middleName)</code> = {{ isUnset(form.values.middleName) }}</p>
    </div>
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
  .panel {
    background: #f9fafb;
    border: 1px solid #e5e7eb;
    border-radius: 0.375rem;
    padding: 0.5rem 0.75rem;
    font-size: 0.8125rem;
    font-family: ui-monospace, monospace;
  }
  .panel p {
    margin: 0.2rem 0;
  }
  code {
    color: #6b7280;
  }
  em {
    color: #2563eb;
    font-style: normal;
    font-weight: 500;
  }
</style>
