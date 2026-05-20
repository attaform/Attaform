<script setup lang="ts">
  import { useRegister } from 'attaform'

  defineProps<{ label: string }>()

  const rv = useRegister()
</script>

<template>
  <label class="field-row">
    <span class="field-label">{{ label }}</span>
    <input v-register="rv" class="field-input" />
    <small class="field-tag">
      <span class="field-tag-arrow">↳</span>
      <code>useRegister().path = {{ rv?.path != null ? `'${rv.path}'` : '(unbound)' }}</code>
    </small>
  </label>
</template>

<style scoped>
  .field-row {
    display: flex;
    flex-direction: column;
    gap: 0.25rem;
    font-size: 0.875rem;
    font-weight: 500;
  }
  .field-label {
    font-size: 0.8125rem;
  }
  .field-input {
    padding: 0.5rem 0.75rem;
    border-radius: 0.375rem;
    border: 1px solid #d1d5db;
    font-size: 0.875rem;
    font-weight: 400;
  }
  .field-input:focus {
    outline: 2px solid #2563eb;
    outline-offset: -1px;
  }
  .field-tag {
    display: inline-flex;
    align-items: center;
    gap: 0.375rem;
    font-size: 0.75rem;
    font-weight: 400;
    color: #6b7280;
    margin-top: 0.125rem;
  }
  .field-tag-arrow {
    color: #9ca3af;
  }
  .field-tag code {
    font-family: ui-monospace, monospace;
    background: #f3f4f6;
    padding: 0.05rem 0.4rem;
    border-radius: 0.25rem;
    color: #374151;
  }
</style>
