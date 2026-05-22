<script setup lang="ts">
  import { useForm } from 'attaform/zod'
  import { z } from 'zod'

  const form = useForm({
    schema: z.object({
      checkpoints: z.array(z.string()),
    }),
    defaultValues: { checkpoints: ['Warm-up', 'Sprint', 'Cooldown'] },
    key: 'docs-demo-field-arrays',
  })
</script>

<template>
  <form @submit.prevent>
    <ol class="rows">
      <li v-for="(_, i) in form.values.checkpoints" :key="i" class="row">
        <input v-register="form.register(`checkpoints.${i}` as const)" />
        <div class="row-actions">
          <button
            type="button"
            title="Move up"
            @click="i > 0 && form.move('checkpoints', i, i - 1)"
          >
            ↑
          </button>
          <button
            type="button"
            title="Move down"
            @click="i < form.values.checkpoints.length - 1 && form.move('checkpoints', i, i + 1)"
          >
            ↓
          </button>
          <button type="button" title="Remove" @click="form.remove('checkpoints', i)">×</button>
        </div>
      </li>
    </ol>

    <div class="actions">
      <button type="button" @click="form.append('checkpoints', 'New checkpoint')">
        form.append(…)
      </button>
      <button type="button" @click="form.prepend('checkpoints', 'First!')">form.prepend(…)</button>
      <button type="button" @click="form.insert('checkpoints', 1, 'Inserted at index 1')">
        form.insert(1, …)
      </button>
      <button
        type="button"
        :disabled="form.values.checkpoints.length < 2"
        @click="form.swap('checkpoints', 0, form.values.checkpoints.length - 1)"
      >
        form.swap(first, last)
      </button>
      <button
        type="button"
        :disabled="form.values.checkpoints.length === 0"
        @click="form.replace('checkpoints', 0, 'Replaced item 0')"
      >
        form.replace(0, …)
      </button>
    </div>

    <pre>{{
      JSON.stringify(form.values.checkpoints, (_, v) => (v === undefined ? '(undefined)' : v), 2)
    }}</pre>
  </form>
</template>

<style scoped>
  form {
    display: flex;
    flex-direction: column;
    gap: 0.875rem;
    max-width: 32rem;
  }
  .rows {
    list-style: none;
    padding: 0;
    margin: 0;
    display: flex;
    flex-direction: column;
    gap: 0.5rem;
    counter-reset: row;
  }
  .row {
    display: flex;
    align-items: center;
    gap: 0.5rem;
  }
  .row::before {
    counter-increment: row;
    content: counter(row) '.';
    font-size: 0.75rem;
    font-family: ui-monospace, monospace;
    color: #6b7280;
    width: 1.5rem;
    text-align: right;
  }
  input {
    flex: 1;
    padding: 0.4rem 0.6rem;
    border-radius: 0.375rem;
    border: 1px solid #d1d5db;
    font-size: 0.875rem;
  }
  input:focus {
    outline: 2px solid #2563eb;
    outline-offset: -1px;
  }
  .row-actions {
    display: flex;
    gap: 0.2rem;
  }
  .row-actions button {
    width: 1.75rem;
    height: 1.75rem;
    border-radius: 0.25rem;
    border: 1px solid #d1d5db;
    background: #fff;
    font-size: 0.875rem;
    cursor: pointer;
  }
  .row-actions button:hover {
    background: #f3f4f6;
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
  .actions button:hover:not(:disabled) {
    background: #f3f4f6;
  }
  .actions button:disabled {
    opacity: 0.5;
    cursor: not-allowed;
  }
  pre {
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
