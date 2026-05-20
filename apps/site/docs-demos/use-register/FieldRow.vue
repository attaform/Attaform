<script setup lang="ts">
  import { useRegister } from 'attaform'

  defineProps<{ label: string }>()

  const rv = useRegister()
</script>

<template>
  <label class="child-scope">
    <span class="scope-tag scope-tag--child">FieldRow.vue · child</span>

    <span class="field-label">{{ label }}</span>
    <input v-register="rv" class="field-input" />
    <small class="field-tag">
      <span class="field-tag-arrow">↳</span>
      <code>useRegister().path = {{ rv?.path != null ? `'${rv.path}'` : '(unbound)' }}</code>
    </small>
  </label>
</template>

<style scoped>
  .child-scope {
    position: relative;
    display: flex;
    flex-direction: column;
    gap: 0.25rem;
    border: 1px dashed #fcd34d;
    background: #fffbeb;
    border-radius: 0.5rem;
    padding: 1.25rem 0.875rem 0.75rem;
  }
  .scope-tag {
    position: absolute;
    top: 0;
    left: 0.625rem;
    transform: translateY(-50%);
    font-size: 0.625rem;
    font-weight: 700;
    letter-spacing: 0.075em;
    text-transform: uppercase;
    padding: 0.125rem 0.5rem;
    border-radius: 0.25rem;
    font-family: ui-monospace, monospace;
  }
  .scope-tag--child {
    background: #d97706;
    color: #fff;
  }
  .field-label {
    font-size: 0.8125rem;
    font-weight: 500;
    color: #78350f;
  }
  .field-input {
    padding: 0.5rem 0.75rem;
    border-radius: 0.375rem;
    border: 1px solid #d1d5db;
    background: #fff;
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
    color: #92400e;
    margin-top: 0.125rem;
  }
  .field-tag-arrow {
    color: #d97706;
  }
  .field-tag code {
    font-family: ui-monospace, monospace;
    background: #fef3c7;
    padding: 0.05rem 0.4rem;
    border-radius: 0.25rem;
    color: #78350f;
  }
</style>
