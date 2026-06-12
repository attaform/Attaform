<script setup lang="ts">
  import { useForm } from 'attaform/zod'
  import { parseApiErrors } from 'attaform'
  import { z } from 'zod'
  import './styles.css'

  const form = useForm({
    schema: z.object({
      email: z.email(),
      username: z.string().min(3),
    }),
    defaultValues: { username: '' },
    key: 'docs-demo-server-side-errors',
  })

  const wait = (ms: number) => new Promise((r) => setTimeout(r, ms))

  function simulateServerCall(values: { email: string; username: string }) {
    const errors: Array<{ path: string; message: string }> = []
    if (values.email === 'taken@example.com') {
      errors.push({ path: 'email', message: 'Already registered' })
    }
    if (values.username === 'admin') {
      errors.push({ path: 'username', message: 'Reserved username' })
    }
    return { ok: errors.length === 0, details: errors }
  }

  const onSubmit = form.handleSubmit(async (values) => {
    form.clearFieldErrors()
    await wait(500)

    const response = simulateServerCall(values)

    if (!response.ok) {
      const parsed = parseApiErrors(response, { formKey: 'docs-demo-server-side-errors' })
      if (parsed.ok) {
        form.setFieldErrors(parsed.errors)
        return
      }
    }

    toast.success(`Account created: ${values.username}`, { description: values })
  })
</script>

<template>
  <form class="demo" @submit.prevent="onSubmit">
    <p class="hint">
      Try <code>taken@example.com</code> for email and <code>admin</code> for username to see the
      simulated server response route through <code>parseApiErrors</code>.
    </p>

    <label>
      <span>Email</span>
      <input v-register="form.register('email')" autocomplete="email" />
      <em v-if="form.fields.email.showErrors">{{ form.fields.email.firstError?.message }}</em>
    </label>

    <label>
      <span>Username</span>
      <input v-register="form.register('username')" />
      <em v-if="form.fields.username.showErrors">{{ form.fields.username.firstError?.message }}</em>
    </label>

    <button :disabled="form.meta.submitting" type="submit">
      {{ form.meta.submitting ? 'Checking with server…' : 'Create account' }}
    </button>
  </form>
</template>
