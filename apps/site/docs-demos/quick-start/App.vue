<script setup lang="ts">
  import { useForm } from 'attaform/zod'
  import { z } from 'zod'
  import './styles.css'

  const form = useForm({
    schema: z.object({
      email: z.email('Enter a valid email'),
      password: z.string().min(8, 'At least 8 characters'),
    }),
    key: 'quick-start',
  })

  const onSubmit = form.handleSubmit(async (values) => {
    toast.success(`Signed in as ${values.email}`, { description: values })
  })
</script>

<template>
  <form class="demo" @submit="onSubmit">
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
    <button type="submit">Sign in</button>
  </form>
</template>
