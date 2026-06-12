<script setup lang="ts">
  import { useRegister } from 'attaform'

  defineProps<{ label: string }>()

  const rv = useRegister()
</script>

<template>
  <label class="child-scope">
    <span class="scope-tag scope-tag--child">FieldRow.vue · child</span>

    <span class="field-label">{{ label }}</span>
    <input v-register="rv" />
    <small class="field-tag">
      <span class="field-tag-arrow">↳</span>
      <code>useRegister().path = {{ rv?.path != null ? `'${rv.path}'` : '(unbound)' }}</code>
    </small>
  </label>
</template>

<style scoped>
  /* Child-scope amber, the counterpart to App.vue's parent blue. Same
     demo-local custom-property pattern with explicit dark values. */
  .child-scope {
    position: relative;
    display: flex;
    flex-direction: column;
    gap: 0.25rem;
    padding: 1.25rem 0.875rem 0.75rem;
    border: 1px dashed var(--scope-line);
    border-radius: 0.5rem;
    background: var(--scope-fill);
    --scope-line: #d97706;
    --scope-fill: #fffbeb;
    --scope-code: #fef3c7;
    --scope-ink: #92400e;
  }
  :global(.dark) .child-scope {
    --scope-line: #f59e0b;
    --scope-fill: #451a03;
    --scope-code: #78350f;
    --scope-ink: #fcd34d;
  }
  .scope-tag {
    position: absolute;
    top: 0;
    left: 0.625rem;
    transform: translateY(-50%);
    padding: 0.125rem 0.5rem;
    border-radius: 0.25rem;
    font-family: ui-monospace, monospace;
    font-size: 0.625rem;
    font-weight: 700;
    letter-spacing: 0.075em;
    text-transform: uppercase;
  }
  .scope-tag--child {
    background: var(--scope-line);
    color: #fff;
  }
  .field-label {
    font-size: 0.8125rem;
    font-weight: 500;
    color: var(--scope-ink);
  }
  .field-tag {
    display: inline-flex;
    align-items: center;
    gap: 0.375rem;
    margin-top: 0.125rem;
    font-size: 0.75rem;
    font-weight: 400;
    color: var(--scope-ink);
  }
  .field-tag-arrow {
    color: var(--scope-line);
  }
  .field-tag code {
    padding: 0.05rem 0.4rem;
    border-radius: 0.25rem;
    font-family: ui-monospace, monospace;
    background: var(--scope-code);
    color: var(--scope-ink);
  }
</style>
