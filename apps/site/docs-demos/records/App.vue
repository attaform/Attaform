<script setup lang="ts">
  import { useForm } from 'attaform/zod'
  import { z } from 'zod'
  import './styles.css'

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
  <form class="demo" @submit.prevent>
    <fieldset>
      <legend>z.record(z.string(), z.boolean())</legend>
      <label v-for="userId in KNOWN_USERS" :key="userId" class="row">
        <input v-register="form.register(`prefs.${userId}`)" type="checkbox" />
        <span class="user">{{ userId }}</span>
      </label>
    </fieldset>

    <p class="hint">
      The keys (<code>ada</code>, <code>grace</code>, …) aren't known to the schema at write time.
      The record's value-schema is what constrains each entry. Path binding uses a template literal:
      <code>register(`prefs.${'{userId}'}`)</code>.
    </p>

    <pre>{{
      JSON.stringify(form.values.prefs, (_, v) => (v === undefined ? '(undefined)' : v), 2)
    }}</pre>
  </form>
</template>

<style scoped>
  .user {
    font-family: ui-monospace, monospace;
    color: var(--color-fg);
  }
</style>
