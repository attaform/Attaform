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

<style scoped>
  form {
    display: flex;
    flex-direction: column;
    gap: 0.875rem;
    max-width: 26rem;
  }
  label {
    display: flex;
    flex-direction: column;
    gap: 0.25rem;
    font-size: 0.875rem;
    font-weight: 500;
  }
  select {
    padding: 0.4rem 0.6rem;
    border-radius: 0.375rem;
    border: 1px solid #d1d5db;
    font-size: 0.875rem;
    background: #fff;
  }
  select:focus {
    outline: 2px solid #2563eb;
    outline-offset: -1px;
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
