<script setup lang="ts">
  import { useForm } from 'attaform/zod'
  import { z } from 'zod'

  const schema = z
    .object({
      username: z
        .string()
        .min(3, 'At least 3 characters')
        .max(20, 'At most 20 characters')
        .regex(/^[a-z0-9_]+$/, 'Lowercase letters, numbers, and underscores only'),
      confirmPassword: z.string(),
      password: z.string().min(8, 'At least 8 characters'),
    })
    .refine((data) => data.password === data.confirmPassword, {
      message: 'Passwords must match',
      path: ['confirmPassword'],
    })

  const form = useForm({
    schema,
    key: 'docs-demo-per-field-validation',
  })
</script>

<template>
  <form @submit.prevent>
    <label>
      <span>Username (per-field schema chain)</span>
      <input v-register="form.register('username')" />
      <em v-if="form.fields.username.showErrors">{{ form.fields.username.firstError?.message }}</em>
    </label>

    <label>
      <span>Password</span>
      <input v-register="form.register('password')" type="password" autocomplete="off" />
      <em v-if="form.fields.password.showErrors">{{ form.fields.password.firstError?.message }}</em>
    </label>

    <label>
      <span>Confirm password (cross-field refinement)</span>
      <input v-register="form.register('confirmPassword')" type="password" autocomplete="off" />
      <em v-if="form.fields.confirmPassword.showErrors">{{
        form.fields.confirmPassword.firstError?.message
      }}</em>
    </label>
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
  em {
    color: #dc2626;
    font-size: 0.8125rem;
    font-style: normal;
    font-weight: 400;
  }
</style>
