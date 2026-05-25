<script setup lang="ts">
  import { useForm } from 'attaform/zod'
  import { z } from 'zod'

  const form = useForm({
    schema: z.object({
      name: z.string().min(1, 'Required'),
      email: z.email('Enter a valid email'),
      bio: z.string().min(20, 'At least 20 characters'),
      newsletter: z.boolean(),
    }),
    defaultValues: { newsletter: false },
    key: 'docs-demo-focus-scroll',
  })

  const onSubmit = form.handleSubmit(() => {
    /* success path not relevant for this demo */
  })
</script>

<template>
  <form @submit.prevent="onSubmit">
    <p class="hint">
      Submit with empty form.fields to see focus + scroll pull to the first invalid path. Click the
      buttons to dispatch each helper imperatively.
    </p>

    <label>
      <span>Name</span>
      <input v-register="form.register('name')" />
      <em v-if="form.fields.name.showErrors">{{ form.fields.name.firstError?.message }}</em>
    </label>

    <label>
      <span>Email</span>
      <input v-register="form.register('email')" />
      <em v-if="form.fields.email.showErrors">{{ form.fields.email.firstError?.message }}</em>
    </label>

    <label>
      <span>Bio (at least 20 characters)</span>
      <textarea v-register="form.register('bio')" rows="3" />
      <em v-if="form.fields.bio.showErrors">{{ form.fields.bio.firstError?.message }}</em>
    </label>

    <label class="check">
      <input v-register="form.register('newsletter')" type="checkbox" />
      Newsletter
    </label>

    <div class="actions">
      <button type="submit">Submit (auto focus on invalid)</button>
      <button type="button" @click="form.focusFirstError()">form.focusFirstError()</button>
      <button
        type="button"
        @click="form.scrollToFirstError({ behavior: 'smooth', block: 'center' })"
      >
        form.scrollToFirstError(…)
      </button>
    </div>
  </form>
</template>
