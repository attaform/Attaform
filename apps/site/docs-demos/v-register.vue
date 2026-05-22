<script setup lang="ts">
  import { useForm } from 'attaform/zod'
  import { z } from 'zod'

  const form = useForm({
    schema: z.object({
      email: z.email('Enter a valid email'),
    }),
    key: 'v-register',
  })
</script>

<template>
  <form @submit.prevent>
    <label>
      Email
      <input v-register="form.register('email')" autocomplete="email" />
      <em v-if="form.fields.email.showErrors">{{ form.fields.email.firstError?.message }}</em>
    </label>
    <table class="state">
      <tbody>
        <tr>
          <th>form.values.email</th>
          <td>{{ JSON.stringify(form.values.email) }}</td>
        </tr>
        <tr>
          <th>form.fields.email.touched</th>
          <td>{{ form.fields.email.touched }}</td>
        </tr>
        <tr>
          <th>form.fields.email.focused</th>
          <td>{{ form.fields.email.focused }}</td>
        </tr>
        <tr>
          <th>form.fields.email.blurred</th>
          <td>{{ form.fields.email.blurred }}</td>
        </tr>
        <tr>
          <th>form.fields.email.blank</th>
          <td>{{ form.fields.email.blank }}</td>
        </tr>
      </tbody>
    </table>
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
  table.state {
    border-collapse: collapse;
    font-size: 0.75rem;
    font-family: ui-monospace, monospace;
  }
  table.state th,
  table.state td {
    padding: 0.25rem 0.5rem;
    text-align: left;
    border-bottom: 1px solid #e5e7eb;
  }
  table.state th {
    color: #6b7280;
    font-weight: 500;
    white-space: nowrap;
  }
  table.state td {
    color: #111827;
  }
</style>
