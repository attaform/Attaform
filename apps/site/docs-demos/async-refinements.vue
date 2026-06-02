<script setup lang="ts">
  import { useForm } from 'attaform/zod'
  import { z } from 'zod'

  const wait = (ms: number) => new Promise((r) => setTimeout(r, ms))

  // Simulated server check — pretend "ada", "champ", "athlete" are taken.
  const takenUsernames = new Set(['ada', 'champ', 'athlete'])

  async function isAvailable(username: string): Promise<boolean> {
    await wait(700)
    return !takenUsernames.has(username.toLowerCase())
  }

  const schema = z.object({
    username: z
      .string()
      .min(3, 'At least 3 characters')
      .refine(async (v) => isAvailable(v), {
        message: 'That username is taken',
      }),
  })

  const form = useForm({
    schema,
    key: 'docs-demo-async-refinements',
  })

  const onSubmit = form.handleSubmit(async (values) => {
    toast.success(`Created account: ${values.username}`, { description: values })
  })
</script>

<template>
  <form @submit.prevent="onSubmit">
    <label>
      <span>Username (taken: ada, champ, athlete)</span>
      <input v-register="form.register('username')" />
      <small v-if="form.fields.username.validating">Checking availability…</small>
      <em v-if="form.fields.username.showErrors">{{ form.fields.username.firstError?.message }}</em>
    </label>

    <button :disabled="form.meta.submitting" type="submit">
      {{ form.meta.submitting ? 'Creating…' : 'Create account' }}
    </button>
  </form>
</template>

<style scoped>
  form {
    display: flex;
    flex-direction: column;
    gap: 0.875rem;
    max-width: 28rem;
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
  small {
    font-size: 0.75rem;
    color: #2563eb;
    font-weight: 500;
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
