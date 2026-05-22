<script setup lang="ts">
  import { useForm } from 'attaform/zod'
  import { z } from 'zod'

  const form = useForm({
    schema: z.object({
      title: z.string(),
      body: z.string(),
    }),
    defaultValues: { title: '', body: '' },
    key: 'docs-demo-multi-tab-sync',
  })
</script>

<template>
  <form @submit.prevent>
    <p class="hint open">
      Open this page in a <strong>second tab</strong> (right-click the title and pick
      &quot;Duplicate&quot;), then type in either one. The other tab converges within a microtask —
      same <code>key:</code>, same form, no coordination wiring.
    </p>

    <label>
      Title
      <input v-register="form.register('title')" type="text" />
    </label>
    <label>
      Body
      <textarea v-register="form.register('body')" rows="3"></textarea>
    </label>

    <p class="hint">
      Sync activates automatically when <code>key:</code> is set and the page is in a secure context
      (HTTPS or localhost). Errors and submit lifecycle stay tab-local — only values and blank-paths
      cross the wire.
    </p>
  </form>
</template>

<style scoped>
  form {
    display: flex;
    flex-direction: column;
    gap: 0.875rem;
    max-width: 32rem;
  }
  label {
    display: flex;
    flex-direction: column;
    gap: 0.25rem;
    font-size: 0.875rem;
    font-weight: 500;
  }
  input,
  textarea {
    padding: 0.5rem 0.75rem;
    border-radius: 0.375rem;
    border: 1px solid #d1d5db;
    font-size: 0.875rem;
    font-family: inherit;
  }
  input:focus,
  textarea:focus {
    outline: 2px solid #2563eb;
    outline-offset: -1px;
  }
  code {
    font-family: ui-monospace, monospace;
    background: #f3f4f6;
    padding: 0.05rem 0.3rem;
    border-radius: 0.25rem;
  }
  .hint {
    margin: 0;
    color: #6b7280;
    font-size: 0.75rem;
  }
  .hint.open {
    padding: 0.5rem 0.75rem;
    background: #ecfeff;
    color: #155e75;
    border-radius: 0.375rem;
    border: 1px solid #a5f3fc;
    font-size: 0.8125rem;
  }
</style>
