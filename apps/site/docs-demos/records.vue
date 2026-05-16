<script setup lang="ts">
  import { useForm } from 'attaform/zod'
  import { z } from 'zod'

  const KNOWN_USERS = ['ada', 'grace', 'linus', 'margaret'] as const

  const schema = z.object({
    prefs: z.record(z.string(), z.boolean()),
  })

  const form = useForm({
    schema,
    defaultValues: {
      prefs: {
        ada: true,
        grace: false,
        linus: true,
        margaret: false,
      },
    },
    key: 'docs-demo-records',
  })
</script>

<template>
  <form @submit.prevent>
    <fieldset>
      <legend>z.record(z.string(), z.boolean())</legend>
      <label v-for="userId in KNOWN_USERS" :key="userId" class="row">
        <input v-register="form.register(`prefs.${userId}`)" type="checkbox" />
        <span class="user">{{ userId }}</span>
      </label>
    </fieldset>

    <p class="hint">
      The keys (<code>ada</code>, <code>grace</code>, …) aren't known to the schema at write time —
      the record's value-schema is what constrains each entry. Path binding uses a template literal:
      <code>register(`prefs.${'{userId}'}`)</code>.
    </p>

    <pre>{{ JSON.stringify(form.values.prefs, null, 2) }}</pre>
  </form>
</template>

<style scoped>
  form {
    display: flex;
    flex-direction: column;
    gap: 0.75rem;
    max-width: 30rem;
  }
  fieldset {
    border: 1px solid #e5e7eb;
    border-radius: 0.5rem;
    padding: 0.625rem 0.875rem;
    margin: 0;
    display: flex;
    flex-direction: column;
    gap: 0.375rem;
  }
  legend {
    padding: 0 0.375rem;
    font-size: 0.75rem;
    color: #6b7280;
    font-family: ui-monospace, monospace;
  }
  .row {
    display: flex;
    align-items: center;
    gap: 0.5rem;
    font-size: 0.875rem;
    font-weight: 500;
  }
  .user {
    font-family: ui-monospace, monospace;
    color: #374151;
  }
  code {
    font-family: ui-monospace, monospace;
    background: #f3f4f6;
    padding: 0.05rem 0.3rem;
    border-radius: 0.25rem;
    font-size: 0.75rem;
  }
  .hint {
    margin: 0;
    color: #6b7280;
    font-size: 0.75rem;
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
</style>
