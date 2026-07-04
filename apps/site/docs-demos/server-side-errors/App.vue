<script setup lang="ts">
  import { computed } from 'vue'
  import { useForm } from 'attaform'
  import { z } from 'zod'
  import './styles.css'

  const form = useForm({
    schema: z.object({
      email: z.email(),
      password: z.string().min(1, 'Enter your password'),
    }),
    defaultValues: { email: '', password: '' },
    key: 'docs-demo-server-side-errors',
  })

  const wait = (ms: number) => new Promise((r) => setTimeout(r, ms))

  function simulateServerCall(values: { email: string; password: string }) {
    if (values.email === 'locked@example.com') {
      return {
        ok: false,
        errors: [
          {
            message: 'Too many attempts. This account is locked.',
            code: 'auth:locked',
            data: { unlocksAt: new Date(Date.now() + 15 * 60_000).toISOString() },
          },
        ],
      }
    }
    if (values.password !== 'hunter2') {
      return {
        ok: false,
        errors: [{ path: ['password'], message: 'Incorrect email or password.' }],
      }
    }
    return { ok: true, errors: [] }
  }

  const lockout = computed(() => {
    const locked = form.meta.ownErrors.find((e) => e.code === 'auth:locked')
    if (!locked) return null
    const data = locked.data as { unlocksAt?: string } | null | undefined
    const unlocksAt = data?.unlocksAt ? new Date(data.unlocksAt).toLocaleTimeString() : null
    return { message: locked.message, unlocksAt }
  })

  const onSubmit = form.handleSubmit(async (values) => {
    form.clearErrors()
    await wait(500)

    const response = simulateServerCall(values)
    if (!response.ok) {
      form.setErrors(response.errors)
      return
    }

    toast.success('Signed in', { description: values.email })
  })
</script>

<template>
  <form class="demo" @submit="onSubmit">
    <p class="hint">
      Enter the wrong password (the demo accepts <code>hunter2</code>) to land a field error, or
      sign in as <code>locked@example.com</code> to see a form-level lockout whose
      <code>data</code> payload carries the unlock time. One
      <code>form.setErrors(response.errors)</code> call places every error at its path.
    </p>

    <div v-if="lockout" class="banner error">
      {{ lockout.message }}
      <template v-if="lockout.unlocksAt"> Try again after {{ lockout.unlocksAt }}.</template>
    </div>

    <label>
      <span>Email</span>
      <input v-register="form.register('email')" autocomplete="email" />
      <em v-if="form.fields.email.showErrors">{{ form.fields.email.firstError?.message }}</em>
    </label>

    <label>
      <span>Password</span>
      <input
        v-register="form.register('password')"
        type="password"
        autocomplete="current-password"
      />
      <em v-if="form.fields.password.showErrors">{{ form.fields.password.firstError?.message }}</em>
    </label>

    <button :disabled="form.meta.submitting" type="submit">
      {{ form.meta.submitting ? 'Signing in…' : 'Sign in' }}
    </button>
  </form>
</template>
