<script setup lang="ts">
  import { useForm } from 'attaform/zod'
  import { parseApiErrors } from 'attaform'
  import { z } from 'zod'

  const { register, fields, handleSubmit, setFieldErrors, clearFieldErrors, meta } = useForm({
    schema: z.object({
      email: z.email(),
      username: z.string().min(3),
    }),
    defaultValues: { username: '' },
    key: 'docs-demo-server-side-errors',
  })

  const wait = (ms: number) => new Promise((r) => setTimeout(r, ms))

  // Pretend the server flags these as taken.
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

  const onSubmit = handleSubmit(async (values) => {
    clearFieldErrors()
    await wait(500)

    const response = simulateServerCall(values)

    if (!response.ok) {
      const parsed = parseApiErrors(response, { formKey: 'docs-demo-server-side-errors' })
      if (parsed.ok) {
        setFieldErrors(parsed.errors)
        return
      }
    }

    alert('✓ Account created')
  })
</script>

<template>
  <form @submit.prevent="onSubmit">
    <p class="hint">
      Try <code>taken@example.com</code> for email and <code>admin</code> for username to see the
      simulated server response route through <code>parseApiErrors</code>.
    </p>

    <label>
      <span>Email</span>
      <input v-register="register('email')" autocomplete="email" />
      <em v-if="fields.email.showErrors">{{ fields.email.firstError?.message }}</em>
    </label>

    <label>
      <span>Username</span>
      <input v-register="register('username')" />
      <em v-if="fields.username.showErrors">{{ fields.username.firstError?.message }}</em>
    </label>

    <button :disabled="meta.submitting" type="submit">
      {{ meta.submitting ? 'Checking with server…' : 'Create account' }}
    </button>
  </form>
</template>

<style scoped>
  form {
    display: flex;
    flex-direction: column;
    gap: 0.875rem;
    max-width: 30rem;
  }
  .hint {
    font-size: 0.75rem;
    color: #6b7280;
    margin: 0;
  }
  code {
    font-family: ui-monospace, monospace;
    background: #f3f4f6;
    padding: 0.05rem 0.3rem;
    border-radius: 0.25rem;
  }
  label {
    display: flex;
    flex-direction: column;
    gap: 0.25rem;
    font-size: 0.875rem;
    font-weight: 500;
  }
  input {
    padding: 0.5rem 0.75rem;
    border-radius: 0.375rem;
    border: 1px solid #d1d5db;
    font-size: 0.875rem;
  }
  input:focus {
    outline: 2px solid #2563eb;
    outline-offset: -1px;
  }
  em {
    color: #dc2626;
    font-size: 0.8125rem;
    font-style: normal;
    font-weight: 400;
  }
  button {
    align-self: flex-start;
    padding: 0.5rem 1rem;
    border-radius: 0.375rem;
    border: 1px solid #2563eb;
    background: #2563eb;
    color: #fff;
    font-size: 0.875rem;
    font-weight: 500;
    cursor: pointer;
  }
  button:hover:not(:disabled) {
    background: #1d4ed8;
  }
  button:disabled {
    opacity: 0.6;
    cursor: not-allowed;
  }
</style>
