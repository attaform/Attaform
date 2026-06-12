<script setup lang="ts">
  import { useForm } from 'attaform/zod'
  import { z } from 'zod'
  import './styles.css'

  const form = useForm({
    schema: z.object({
      email: z.email('Enter a valid email'),
      newsletter: z.boolean(),
    }),
    key: 'inputs-to-submit',
  })

  const onSubmit = form.handleSubmit(async (values) => {
    await new Promise((resolve) => setTimeout(resolve, 1200))
    toast.success(`Subscribed: ${values.email}`, { description: values })
  })
</script>

<template>
  <form class="demo" @submit="onSubmit">
    <label>
      Email
      <input v-register="form.register('email')" autocomplete="email" />
      <em v-if="form.fields.email.showErrors">{{ form.fields.email.firstError?.message }}</em>
    </label>
    <label class="row">
      <input v-register="form.register('newsletter')" type="checkbox" />
      Send me the monthly newsletter
    </label>
    <button :disabled="form.meta.submitting" type="submit">
      {{ form.meta.submitting ? 'Subscribing…' : 'Subscribe' }}
    </button>
  </form>
</template>
