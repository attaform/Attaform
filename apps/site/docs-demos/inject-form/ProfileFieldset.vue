<script setup lang="ts">
  import { injectForm } from 'attaform'
  import type { FormShape } from './schema'

  const ctx = injectForm<FormShape>('docs-demo-inject-form')
</script>

<template>
  <fieldset>
    <legend>Profile (via injectForm)</legend>
    <label>
      <span>Name</span>
      <input v-register="ctx?.register('profile.name')" type="text" />
      <em v-if="ctx?.fields.profile.name.showErrors">
        {{ ctx?.fields.profile.name.firstError?.message }}
      </em>
    </label>
    <label>
      <span>City</span>
      <input v-register="ctx?.register('profile.city')" type="text" />
    </label>
  </fieldset>
</template>

<style scoped>
  fieldset {
    border: 1px solid #e5e7eb;
    border-radius: 0.5rem;
    padding: 0.5rem 0.875rem;
    margin: 0;
    display: flex;
    flex-direction: column;
    gap: 0.5rem;
  }
  legend {
    padding: 0 0.375rem;
    font-size: 0.8125rem;
    color: #6b7280;
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
    font-family: inherit;
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
</style>
