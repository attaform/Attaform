<script setup lang="ts">
  import { unset, useForm } from 'attaform/zod'
  import { z } from 'zod'

  const schema = z.object({
    notify: z.boolean().default(true),
    count: z.number().default(10),
    tag: z.string().default('untitled'),
  })

  // 1. Bare — defaults flow from the schema.
  const bare = useForm({ schema, key: 'docs-demo-schema-defaults-bare' })

  // 2. Overlay — per-form `defaultValues` wins for the leaves it names.
  const overlaid = useForm({
    schema,
    defaultValues: { count: 42, tag: 'work-in-progress' },
    key: 'docs-demo-schema-defaults-overlay',
  })

  // 3. unset — opt a specific leaf back to blank.
  const blanked = useForm({
    schema,
    defaultValues: { count: unset },
    key: 'docs-demo-schema-defaults-unset',
  })
</script>

<template>
  <div class="grid">
    <section>
      <h4>Schema defaults only</h4>
      <form @submit.prevent>
        <label>
          notify
          <input v-register="bare.register('notify')" type="checkbox" />
        </label>
        <label>
          count
          <input v-register="bare.register('count')" type="number" />
        </label>
        <label>
          tag
          <input v-register="bare.register('tag')" type="text" />
        </label>
      </form>
      <pre>{{ JSON.stringify(bare.values, null, 2) }}</pre>
    </section>

    <section>
      <h4>defaultValues overlay</h4>
      <form @submit.prevent>
        <label>
          notify
          <input v-register="overlaid.register('notify')" type="checkbox" />
        </label>
        <label>
          count
          <input v-register="overlaid.register('count')" type="number" />
        </label>
        <label>
          tag
          <input v-register="overlaid.register('tag')" type="text" />
        </label>
      </form>
      <pre>{{ JSON.stringify(overlaid.values, null, 2) }}</pre>
    </section>

    <section>
      <h4><code>unset</code> on count</h4>
      <form @submit.prevent>
        <label>
          notify
          <input v-register="blanked.register('notify')" type="checkbox" />
        </label>
        <label>
          count <small v-if="blanked.fields.count.blank" class="blank">(blank)</small>
          <input v-register="blanked.register('count')" type="number" />
          <em v-if="blanked.fields.count.showErrors">{{
            blanked.fields.count.firstError?.message
          }}</em>
        </label>
        <label>
          tag
          <input v-register="blanked.register('tag')" type="text" />
        </label>
      </form>
      <pre>{{ JSON.stringify(blanked.values, null, 2) }}</pre>
    </section>
  </div>
</template>

<style scoped>
  .grid {
    display: grid;
    grid-template-columns: 1fr;
    gap: 1.25rem;
  }
  @media (min-width: 760px) {
    .grid {
      grid-template-columns: repeat(3, 1fr);
    }
  }
  section {
    display: flex;
    flex-direction: column;
    gap: 0.5rem;
  }
  h4 {
    margin: 0;
    font-size: 0.8125rem;
    font-weight: 600;
    color: #1f2937;
  }
  form {
    display: flex;
    flex-direction: column;
    gap: 0.5rem;
  }
  label {
    display: flex;
    flex-direction: column;
    gap: 0.25rem;
    font-size: 0.8125rem;
    color: #6b7280;
    font-family: ui-monospace, monospace;
  }
  input[type='text'],
  input[type='number'] {
    padding: 0.375rem 0.5rem;
    border-radius: 0.375rem;
    border: 1px solid #d1d5db;
    font-size: 0.8125rem;
    font-family: inherit;
  }
  input:focus {
    outline: 2px solid #2563eb;
    outline-offset: -1px;
  }
  pre {
    margin: 0;
    padding: 0.5rem 0.625rem;
    background: #0f172a;
    color: #a5f3fc;
    border-radius: 0.375rem;
    font-size: 0.75rem;
    font-family: ui-monospace, monospace;
    overflow: auto;
  }
  em {
    color: #dc2626;
    font-size: 0.75rem;
    font-style: normal;
  }
  .blank {
    color: #b45309;
    font-style: normal;
  }
  code {
    font-family: ui-monospace, monospace;
    background: #f3f4f6;
    padding: 0.05rem 0.3rem;
    border-radius: 0.25rem;
  }
</style>
