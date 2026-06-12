<script setup lang="ts">
  import { useForm } from 'attaform/zod'
  import { z } from 'zod'
  import './styles.css'

  const wait = (ms: number) => new Promise((r) => setTimeout(r, ms))

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
  <form class="demo" @submit.prevent="onSubmit">
    <label>
      <span>Username (taken: ada, champ, athlete)</span>
      <input v-register="form.register('username')" />
      <span v-if="form.fields.username.validating" class="status pending"
        >Checking availability…</span
      >
      <em v-if="form.fields.username.showErrors">{{ form.fields.username.firstError?.message }}</em>
    </label>

    <button :disabled="form.meta.submitting" type="submit">
      {{ form.meta.submitting ? 'Creating…' : 'Create account' }}
    </button>
  </form>
</template>
