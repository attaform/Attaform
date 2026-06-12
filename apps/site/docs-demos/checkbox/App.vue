<script setup lang="ts">
  import { useForm } from 'attaform/zod'
  import { z } from 'zod'
  import './styles.css'

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
  <form class="demo" @submit.prevent>
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
