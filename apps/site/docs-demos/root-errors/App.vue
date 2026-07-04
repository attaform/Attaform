<script setup lang="ts">
  import { useForm } from 'attaform'
  import { z } from 'zod'
  import './styles.css'

  const schema = z
    .object({
      password: z.string(),
      confirm: z.string(),
    })
    .refine((v) => v.password === v.confirm, {
      message: 'Passwords must match',
    })

  const form = useForm({
    schema,
    defaultValues: { password: '', confirm: '' },
    key: 'docs-demo-form.root-errors',
  })

  const onSubmit = form.handleSubmit(() => {})
</script>

<template>
  <form class="demo" @submit.prevent="onSubmit">
    <p v-if="form.meta.firstOwnError" class="banner error" role="alert">
      {{ form.meta.firstOwnError.message }}
    </p>

    <label>
      <span>Password</span>
      <input v-register="form.register('password')" type="password" autocomplete="new-password" />
    </label>

    <label>
      <span>Confirm password</span>
      <input v-register="form.register('confirm')" type="password" autocomplete="new-password" />
    </label>

    <div class="actions">
      <button type="submit" class="primary">Create account</button>
    </div>

    <p class="hint"
      >The root <code>.refine()</code> attaches its error to the form root, not a field.
      <code>form.meta.firstOwnError</code> reads it for the banner, and
      <code>form.meta.ownErrors</code> is the whole root bucket.</p
    >
    <pre>{{ JSON.stringify(form.meta.ownErrors, null, 2) }}</pre>
  </form>
</template>
