<script setup lang="ts">
  import { useForm } from 'attaform/zod'
  import { z } from 'zod'

  const form = useForm({
    schema: z.object({
      title: z.string(),
      tags: z.array(z.string()),
      published: z.boolean(),
    }),
    defaultValues: {
      title: 'A great draft',
      tags: ['vue', 'forms'],
      published: true,
    },
    key: 'docs-demo-form.clear',
  })
</script>

<template>
  <form @submit.prevent>
    <label>
      <span>Title <small v-if="form.fields.title.blank">(blank)</small></span>
      <input v-register="form.register('title')" />
    </label>

    <label>
      <span>Tags (comma-separated string representation)</span>
      <input :value="form.values.tags.join(', ')" readonly />
      <small v-if="form.values.tags.length === 0">(blank: [])</small>
    </label>

    <label class="check">
      <input v-register="form.register('published')" type="checkbox" />
      Published
      <small v-if="form.fields.published.blank">(blank)</small>
    </label>

    <div class="actions">
      <button type="button" @click="form.clear('title')">form.clear('title')</button>
      <button type="button" @click="form.clear('tags')">form.clear('tags')</button>
      <button type="button" @click="form.clear()">form.clear() — whole form</button>
    </div>

    <pre>{{ JSON.stringify(form.values, (_, v) => (v === undefined ? '(undefined)' : v), 2) }}</pre>
  </form>
</template>

<style scoped>
  form {
    display: flex;
    flex-direction: column;
    gap: 0.875rem;
    max-width: 30rem;
  }
  label {
    display: flex;
    flex-direction: column;
    gap: 0.25rem;
    font-size: 0.875rem;
    font-weight: 500;
  }
  label.check {
    flex-direction: row;
    align-items: center;
    gap: 0.5rem;
    font-weight: 400;
    flex-wrap: wrap;
  }
  label.check input {
    margin: 0;
  }
  input {
    padding: 0.5rem 0.75rem;
    border-radius: 0.375rem;
    border: 1px solid #d1d5db;
    font-size: 0.875rem;
  }
  input[readonly] {
    background: #f9fafb;
    color: #6b7280;
  }
  small {
    font-size: 0.75rem;
    color: #2563eb;
    font-weight: 500;
  }
  .actions {
    display: flex;
    flex-wrap: wrap;
    gap: 0.4rem;
  }
  .actions button {
    padding: 0.35rem 0.7rem;
    border-radius: 0.375rem;
    border: 1px solid #d1d5db;
    background: #fff;
    font-size: 0.75rem;
    font-family: ui-monospace, monospace;
    cursor: pointer;
  }
  .actions button:hover {
    background: #f3f4f6;
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
