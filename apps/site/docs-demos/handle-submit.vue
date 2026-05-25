<script setup lang="ts">
  import { useForm } from 'attaform/zod'
  import { z } from 'zod'

  const form = useForm({
    schema: z.object({
      email: z.email('Enter a valid email'),
      terms: z.literal(true, { message: 'Accept the terms to continue' }),
    }),
    key: 'handle-submit',
  })

  const onSubmit = form.handleSubmit(
    async (values) => {
      await new Promise((resolve) => setTimeout(resolve, 600))
      toast.success(`Submitted as ${values.email}`, { description: values })
    },
    () => {
      toast.error('Submit blocked, check the errors above.')
    }
  )
</script>

<template>
  <form @submit.prevent="onSubmit">
    <label>
      Email
      <input v-register="form.register('email')" autocomplete="email" />
      <em v-if="form.fields.email.showErrors">{{ form.fields.email.firstError?.message }}</em>
    </label>
    <label class="checkbox">
      <input v-register="form.register('terms')" type="checkbox" />
      I accept the terms of service
      <em v-if="form.fields.terms.showErrors">{{ form.fields.terms.firstError?.message }}</em>
    </label>
    <button :disabled="form.meta.submitting" type="submit">
      {{ form.meta.submitting ? 'Submitting…' : 'Submit' }}
    </button>
  </form>
</template>
