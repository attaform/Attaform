<script setup lang="ts">
  import { useForm } from 'attaform/zod'
  import { z } from 'zod'
  import './styles.css'

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
  <form class="demo" @submit.prevent>
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

    <div class="actions mono">
      <button type="button" @click="form.append('roster', 'New athlete')">form.append(…)</button>
    </div>

    <p class="hint">
      Type into a row, then move it. The <code>row.key</code> chip and the text travel together: the
      key follows the athlete, not the slot.
    </p>
  </form>
</template>

<style scoped>
  .token {
    font-size: 0.7rem;
    font-family: ui-monospace, monospace;
    color: var(--color-fg-muted);
    background: var(--color-surface-2);
    border-radius: 0.25rem;
    padding: 0.15rem 0.4rem;
    min-width: 2.25rem;
    text-align: center;
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
