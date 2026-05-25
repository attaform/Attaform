<script setup lang="ts">
  import { useForm } from 'attaform/zod'
  import { z } from 'zod'

  const form = useForm({
    schema: z.object({
      country: z.enum(['us', 'uk', 'ca', 'au']),
      tags: z.array(z.string()),
    }),
    defaultValues: { country: 'us', tags: [] },
    key: 'docs-demo-select',
  })
</script>

<template>
  <form @submit.prevent>
    <label>
      <span>Country (single)</span>
      <select v-register="form.register('country')">
        <option value="us">United States</option>
        <option value="uk">United Kingdom</option>
        <option value="ca">Canada</option>
        <option value="au">Australia</option>
      </select>
    </label>

    <label>
      <span>Tags (multi, hold ⌘ / Ctrl)</span>
      <select v-register="form.register('tags')" multiple>
        <option value="design">Design</option>
        <option value="eng">Engineering</option>
        <option value="ops">Ops</option>
        <option value="sales">Sales</option>
      </select>
    </label>

    <pre>{{
      JSON.stringify(
        { country: form.values.country, tags: form.values.tags },
        (_, v) => (v === undefined ? '(undefined)' : v),
        2
      )
    }}</pre>
  </form>
</template>
