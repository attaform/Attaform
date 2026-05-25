<script setup lang="ts">
  import { useForm } from 'attaform/zod'
  import { z } from 'zod'

  const form = useForm({
    schema: z.object({
      username: z.string().min(3, 'At least 3 characters'),
      password: z.string().min(8, 'At least 8 characters'),
    }),
    key: 'blank-starter',
  })

  const onSubmit = form.handleSubmit(async (values) => {
    toast.success(`Welcome, ${values.username}!`, { description: values })
  })
</script>

<template>
  <form @submit="onSubmit">
    <label>
      Username
      <input v-register="form.register('username')" autocomplete="username" />
      <em v-if="form.fields.username.showErrors">{{ form.fields.username.firstError?.message }}</em>
    </label>
    <label>
      Password
      <input
        v-register="form.register('password')"
        type="password"
        autocomplete="current-password"
      />
      <em v-if="form.fields.password.showErrors">{{ form.fields.password.firstError?.message }}</em>
    </label>
    <button type="submit">Sign in</button>
  </form>
</template>

<style scoped>
  form {
    display: flex;
    flex-direction: column;
    gap: 0.875rem;
    max-width: 24rem;
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
    margin-top: 0.5rem;
    padding: 0.625rem 1rem;
    background: #2563eb;
    color: white;
    border: none;
    border-radius: 0.375rem;
    font-size: 0.875rem;
    font-weight: 600;
    cursor: pointer;
  }
</style>
