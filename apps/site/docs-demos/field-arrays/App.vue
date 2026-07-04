<script setup lang="ts">
  import { useForm } from 'attaform'
  import { z } from 'zod'
  import './styles.css'

  const form = useForm({
    schema: z.object({
      checkpoints: z.array(z.string()),
    }),
    defaultValues: { checkpoints: ['Warm-up', 'Sprint', 'Cooldown'] },
    key: 'docs-demo-field-arrays',
  })
</script>

<template>
  <form class="demo" @submit.prevent>
    <ol class="rows">
      <li v-for="(row, i) in form.list('checkpoints')" :key="row.key" class="row">
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

    <div class="actions mono">
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
  .rows {
    counter-reset: row;
  }
  .row::before {
    counter-increment: row;
    content: counter(row) '.';
    font-size: 0.75rem;
    font-family: ui-monospace, monospace;
    color: var(--color-fg-muted);
    width: 1.5rem;
    text-align: right;
  }
  .row input {
    flex: 1;
  }
  .row-actions {
    display: flex;
    gap: 0.2rem;
  }
  .row-actions button {
    width: 1.75rem;
    height: 1.75rem;
    border-radius: 0.25rem;
    border: 1px solid var(--color-border-strong);
    background: var(--color-bg);
    color: var(--color-fg);
    font-size: 0.875rem;
    cursor: pointer;
  }
  .row-actions button:hover {
    background: var(--color-surface-2);
  }
</style>
