<script setup lang="ts">
  import { useForm } from 'attaform/zod'
  import type { RegisterTransform } from 'attaform'
  import { z } from 'zod'

  const lowercase: RegisterTransform = (v) => (typeof v === 'string' ? v.toLowerCase() : v)
  const dashify: RegisterTransform = (v) =>
    typeof v === 'string' ? v.replace(/\s+/g, '-').replace(/[^a-z0-9-]/g, '') : v

  const { register, values } = useForm({
    schema: z.object({
      title: z.string(),
      slug: z.string(),
    }),
    key: 'docs-demo-transforms',
  })
</script>

<template>
  <form @submit.prevent>
    <label>
      <span>Title (untouched)</span>
      <input v-register="register('title')" placeholder="My First Post" />
    </label>

    <label>
      <span>Slug (lowercased, dashified — try mixed case + spaces)</span>
      <input
        v-register="register('slug', { transforms: [lowercase, dashify] })"
        placeholder="my-first-post"
      />
    </label>

    <pre>{{ JSON.stringify(values, (_, v) => (v === undefined ? '(undefined)' : v), 2) }}</pre>
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
  input {
    padding: 0.5rem 0.75rem;
    border-radius: 0.375rem;
    border: 1px solid #d1d5db;
    font-size: 0.875rem;
  }
  input:focus {
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
