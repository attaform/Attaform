<script setup lang="ts">
  import { useForm } from 'attaform'
  import { z } from 'zod'
  import './styles.css'

  const form = useForm({
    schema: z.object({
      name: z.string(),
      age: z.number(),
      bio: z.string(),
    }),
    key: 'docs-demo-text-number-textarea',
  })
</script>

<template>
  <form class="demo" @submit.prevent>
    <label>
      <span>Name</span>
      <input v-register="form.register('name')" type="text" />
    </label>

    <label>
      <span>Age</span>
      <input v-register="form.register('age')" type="number" min="0" />
    </label>

    <label>
      <span>Bio</span>
      <textarea v-register="form.register('bio')" rows="3" />
    </label>

    <pre>{{
      JSON.stringify(
        { name: form.values.name, age: form.values.age, bio: form.values.bio },
        (_, v) => (v === undefined ? '(undefined)' : typeof v === 'number' ? `${v} (number)` : v),
        2
      )
    }}</pre>
  </form>
</template>
