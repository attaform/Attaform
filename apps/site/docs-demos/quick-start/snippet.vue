<!--
  Canonical quick-start snippet: the single source for the "API at a glance"
  headline. The generator (apps/site/scripts/generate-llms.mjs) extracts this
  SFC into the README, the quick-start docs page, and llms.txt, so those three
  copies can never drift from a form that actually type-checks.

  This is deliberately NOT a live demo (the DocsDemo/playground globs only pick
  up `<slug>/App.vue`, and the smoke tracker ignores non-App siblings). The
  playful live demo lives next door in App.vue and keeps its `toast` popup;
  this file stays copy-paste clean — no toast, no styles import, no `key` — so
  a reader can paste it into an empty project and run it as-is.
-->
<script setup lang="ts">
  import { useForm } from 'attaform'
  import { z } from 'zod'

  const schema = z.object({
    email: z.email('Enter a valid email'),
    password: z.string().min(8, 'At least 8 characters'),
  })

  const form = useForm({ schema })

  const onSubmit = form.handleSubmit(async (values) => {
    await fetch('/api/sign-in', { method: 'POST', body: JSON.stringify(values) })
  })
</script>

<template>
  <form @submit.prevent="onSubmit">
    <label>
      Email
      <input v-register="form.register('email')" autocomplete="email" />
      <em v-if="form.fields.email.showErrors">{{ form.fields.email.firstError?.message }}</em>
    </label>
    <label>
      Password
      <input type="password" v-register="form.register('password')" autocomplete="off" />
      <em v-if="form.fields.password.showErrors">{{ form.fields.password.firstError?.message }}</em>
    </label>
    <button :disabled="form.meta.submitting" type="submit">Sign in</button>
  </form>
</template>
