<script setup lang="ts">
  import { useForm } from 'attaform/zod'
  import { z } from 'zod'

  const form = useForm({
    schema: z.object({
      acceptTerms: z.boolean(),
      languages: z.array(z.enum(['ts', 'js', 'rust', 'go'])),
    }),
    defaultValues: { acceptTerms: false, languages: [] },
    key: 'docs-demo-checkbox',
  })
</script>

<template>
  <form @submit.prevent>
    <fieldset>
      <legend>Single checkbox → boolean</legend>
      <label class="row">
        <input v-register="form.register('acceptTerms')" type="checkbox" value="accepted" />
        I accept the terms
      </label>
    </fieldset>

    <fieldset>
      <legend>Checkbox group → array</legend>
      <label class="row">
        <input v-register="form.register('languages')" type="checkbox" value="ts" />
        TypeScript
      </label>
      <label class="row">
        <input v-register="form.register('languages')" type="checkbox" value="js" />
        JavaScript
      </label>
      <label class="row">
        <input v-register="form.register('languages')" type="checkbox" value="rust" />
        Rust
      </label>
      <label class="row">
        <input v-register="form.register('languages')" type="checkbox" value="go" />
        Go
      </label>
    </fieldset>

    <pre>{{
      JSON.stringify(
        { acceptTerms: form.values.acceptTerms, languages: form.values.languages },
        (_, v) => (v === undefined ? '(undefined)' : v),
        2
      )
    }}</pre>
  </form>
</template>

<style scoped>
  form {
    display: flex;
    flex-direction: column;
    gap: 0.875rem;
    max-width: 26rem;
  }
  fieldset {
    display: flex;
    flex-direction: column;
    gap: 0.4rem;
    border: 1px solid #e5e7eb;
    border-radius: 0.375rem;
    padding: 0.6rem 0.75rem;
  }
  legend {
    padding: 0 0.4rem;
    font-size: 0.75rem;
    font-weight: 600;
    color: #6b7280;
    text-transform: uppercase;
    letter-spacing: 0.05em;
  }
  .row {
    display: flex;
    align-items: center;
    gap: 0.5rem;
    font-size: 0.875rem;
    font-weight: 400;
  }
  input {
    margin: 0;
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
