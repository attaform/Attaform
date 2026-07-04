<script setup lang="ts">
  import { useForm } from 'attaform'
  import { z } from 'zod'
  import './styles.css'

  const form = useForm({
    schema: z.object({
      email: z.email('Enter a valid email'),
      password: z.string().min(8, 'At least 8 characters'),
      displayName: z.string().min(2, 'At least 2 characters').optional(),
      age: z.number().int().min(13, 'You must be 13 or older'),
    }),
    key: 'first-schema',
  })
</script>

<template>
  <form class="demo" @submit.prevent>
    <label>
      Email
      <input v-register="form.register('email')" autocomplete="email" />
      <em v-if="form.fields.email.showErrors">{{ form.fields.email.firstError?.message }}</em>
    </label>
    <label>
      Password
      <input v-register="form.register('password')" type="password" autocomplete="off" />
      <em v-if="form.fields.password.showErrors">{{ form.fields.password.firstError?.message }}</em>
    </label>
    <label>
      Display name <span class="hint">(optional)</span>
      <input v-register="form.register('displayName')" />
      <em v-if="form.fields.displayName.showErrors">{{
        form.fields.displayName.firstError?.message
      }}</em>
    </label>
    <label>
      Age
      <input v-register="form.register('age')" type="number" />
      <em v-if="form.fields.age.showErrors">{{ form.fields.age.firstError?.message }}</em>
    </label>
    <pre>{{ JSON.stringify(form.values, (_, v) => (v === undefined ? '(undefined)' : v), 2) }}</pre>
  </form>
</template>
