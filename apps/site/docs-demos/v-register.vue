<script setup lang="ts">
  // Phase 1 demo for "The v-register directive". One input bound
  // through v-register; the table underneath surfaces the four
  // FieldState bits the directive tracks (touched / focused /
  // blurred / blank) — readers watch them flip as they interact.
  import { useForm } from 'attaform/zod'
  import { z } from 'zod'

  const { register, fields, values } = useForm({
    schema: z.object({
      email: z.string().email('Enter a valid email'),
    }),
    key: 'v-register',
  })
</script>

<template>
  <form @submit.prevent>
    <label>
      Email
      <input v-register="register('email')" type="email" autocomplete="email" />
      <em v-if="fields.email.showErrors">{{ fields.email.firstError?.message }}</em>
    </label>
    <table class="state">
      <tbody>
        <tr>
          <th>values.email</th>
          <td>{{ JSON.stringify(values.email) }}</td>
        </tr>
        <tr>
          <th>fields.email.touched</th>
          <td>{{ fields.email.touched }}</td>
        </tr>
        <tr>
          <th>fields.email.focused</th>
          <td>{{ fields.email.focused }}</td>
        </tr>
        <tr>
          <th>fields.email.blurred</th>
          <td>{{ fields.email.blurred }}</td>
        </tr>
        <tr>
          <th>fields.email.blank</th>
          <td>{{ fields.email.blank }}</td>
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
