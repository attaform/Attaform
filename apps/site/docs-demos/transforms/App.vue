<script setup lang="ts">
  import { useForm } from 'attaform'
  import type { RegisterTransform } from 'attaform'
  import { z } from 'zod'
  import './styles.css'

  const lowercase: RegisterTransform = (v) => (typeof v === 'string' ? v.toLowerCase() : v)
  const dashify: RegisterTransform = (v) =>
    typeof v === 'string' ? v.replace(/\s+/g, '-').replace(/[^a-z0-9-]/g, '') : v

  const form = useForm({
    schema: z.object({
      title: z.string(),
      slug: z.string(),
    }),
    key: 'docs-demo-transforms',
  })
</script>

<template>
  <form class="demo" @submit.prevent>
    <label>
      <span>Title (untouched)</span>
      <input v-register="form.register('title')" placeholder="My First Post" />
    </label>

    <label>
      <span>Slug (lowercased, dashified; try mixed case + spaces)</span>
      <input
        v-register="form.register('slug', { transforms: [lowercase, dashify] })"
        placeholder="my-first-post"
      />
    </label>

    <pre>{{ JSON.stringify(form.values, (_, v) => (v === undefined ? '(undefined)' : v), 2) }}</pre>
  </form>
</template>
