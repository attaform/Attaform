<script setup lang="ts">
  import { useForm } from 'attaform/zod'
  import { z } from 'zod'

  const form = useForm({
    schema: z.object({
      roster: z.array(z.string()),
    }),
    defaultValues: {
      roster: ['Ada', 'Grace', 'Katherine'],
    },
    key: 'docs-demo-form-list',
  })
</script>

<template>
  <form @submit.prevent>
    <ol class="rows">
      <li v-for="(row, i) in form.list('roster')" :key="row.key" class="row">
        <code class="token" title="row.key stays with this athlete across reorders">{{
          row.key
        }}</code>
        <input v-register="form.register(`roster.${i}` as const)" placeholder="Athlete name" />
        <div class="row-actions">
          <button type="button" title="Move up" @click="i > 0 && form.move('roster', i, i - 1)"
            >↑</button
          >
          <button
            type="button"
            title="Move down"
            @click="i < form.values.roster.length - 1 && form.move('roster', i, i + 1)"
          >
            ↓
          </button>
          <button type="button" title="Remove" @click="form.remove('roster', i)">×</button>
        </div>
      </li>
    </ol>

    <div class="actions">
      <button type="button" @click="form.append('roster', 'New athlete')">form.append(…)</button>
    </div>

    <p class="hint">
      Type into a row, then move it. The <code>row.key</code> chip and the text travel together: the
      key follows the athlete, not the slot.
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
  .rows {
    list-style: none;
    padding: 0;
    margin: 0;
    display: flex;
    flex-direction: column;
    gap: 0.5rem;
  }
  .row {
    display: flex;
    align-items: center;
    gap: 0.5rem;
  }
  .token {
    font-size: 0.7rem;
    font-family: ui-monospace, monospace;
    color: #6b7280;
    background: #f3f4f6;
    border-radius: 0.25rem;
    padding: 0.15rem 0.4rem;
    min-width: 2.25rem;
    text-align: center;
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
  .actions button:hover {
    background: #f3f4f6;
  }
  .hint {
    font-size: 0.8rem;
    color: #6b7280;
    margin: 0;
    line-height: 1.5;
  }
  .hint code {
    font-family: ui-monospace, monospace;
    font-size: 0.75rem;
    color: #374151;
  }
</style>
