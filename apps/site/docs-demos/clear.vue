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
