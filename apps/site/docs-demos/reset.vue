<script setup lang="ts">
  import { useForm } from 'attaform/zod'
  import { z } from 'zod'

  const form = useForm({
    schema: z.object({
      name: z.string(),
      email: z.email(),
      newsletter: z.boolean(),
    }),
    defaultValues: { name: 'Alex', email: 'alex@attaform.dev', newsletter: true },
    key: 'docs-demo-form.reset',
  })
</script>

<template>
  <form @submit.prevent>
    <label>
      <span>Name <small v-if="form.fields.name.dirty">— dirty</small></span>
      <input v-register="form.register('name')" />
    </label>

    <label>
      <span>Email <small v-if="form.fields.email.dirty">— dirty</small></span>
      <input v-register="form.register('email')" />
    </label>

    <label class="check">
      <input v-register="form.register('newsletter')" type="checkbox" />
      Newsletter
      <small v-if="form.fields.newsletter.dirty">— dirty</small>
    </label>

    <p class="status">
      Form is <em>{{ form.meta.dirty ? 'dirty' : 'pristine' }}</em>
    </p>

    <div class="actions">
      <button type="button" @click="form.resetField('name')">form.resetField('name')</button>
      <button type="button" @click="form.resetField('email')">form.resetField('email')</button>
      <button type="button" @click="form.reset()">form.reset() — whole form</button>
      <button
        type="button"
        @click="form.reset({ name: 'Champion', email: 'champ@attaform.dev', newsletter: false })"
      >
        form.reset(newDefaults)
      </button>
    </div>
  </form>
</template>
